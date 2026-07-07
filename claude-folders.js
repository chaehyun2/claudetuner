// Claude Tuner — Folders (M1: local MVP)
// Injects a folder tree into the provider's left sidebar to organize conversations.
// Folders live entirely in chrome.storage.local; conversations are referenced by
// id (never mutated). Freemium: free = 2 folders total per account, Pro = unlimited.
//
// SINGLE CANONICAL ENGINE (DRY): the store/render/dnd/gate logic below is
// provider-agnostic and lives ONLY here. Every host-coupled detail (org id, chat
// id/URL, sidebar anchor, text token classes, title suffix, dark-launch pref/flag
// keys) is supplied by a small provider ADAPTER. claude.ai auto-mounts the
// CLAUDE_ADAPTER at the bottom of this file; chatgpt.com injects this file too
// (via background.js CHATGPT_INJECT) purely to register the engine, then
// chatgpt-folders.js mounts a thin CHATGPT_ADAPTER against the SAME engine — no
// forked/duplicated logic.
//
// Design: docs/DESIGN-claude-folders.md

(() => {
  'use strict';

  // ── Provider adapter: everything host-coupled for claude.ai ──
  // Implements the pinned adapter interface (see docs/DESIGN-claude-folders.md).
  const CLAUDE_ADAPTER = {
    provider: 'claude',
    // Claude scopes folders per Anthropic org (lastActiveOrg cookie).
    getActiveOrgId() {
      return document.cookie.split('; ')
        .find(r => r.startsWith('lastActiveOrg='))?.split('=')[1] || null;
    },
    // Current conversation id from the URL, e.g. /chat/<uuid>
    getCurrentChatId() {
      const m = location.pathname.match(/\/chat\/([\w-]+)/);
      return m ? m[1] : null;
    },
    // Sidebar conversation-link selector; specific when a chatId is given, else the
    // generic form used for pointer-drag hit-testing.
    getChatLinkSelector(chatId) {
      return chatId ? `a[href*="/chat/${chatId}"]` : 'a[href*="/chat/"]';
    },
    // Extract a conversation id from an <a href> (pointer-drag import).
    chatIdFromHref(href) {
      const m = (href || '').match(/\/chat\/([\w-]+)/);
      return m ? m[1] : null;
    },
    // Canonical conversation URL for a rendered folded-chat link.
    chatUrl(id) { return `https://claude.ai/chat/${encodeURIComponent(id)}`; },
    // Strip Claude's document.title suffix (" - Claude") to recover the bare title.
    stripTitleSuffix(title) {
      return String(title || '').replace(/\s*[-–|]\s*Claude.*$/i, '').trim();
    },
    // Claude's conversation top-bar actions container — host for the move button.
    findMoveButtonBox() {
      return document.querySelector('div[data-testid="wiggle-controls-actions"]');
    },
    // Sidebar mount anchor (mirrors sidebar-usage.js).
    findSidebarAnchor() {
      const dframeSidebar = document.querySelector('.dframe-sidebar-body');
      if (dframeSidebar) {
        const navScroll = dframeSidebar.querySelector('.dframe-nav-scroll');
        if (navScroll) return { parent: navScroll.parentElement, ref: navScroll, type: 'desktop' };
      }
      const sidebarNav = document.querySelector('nav.flex');
      if (!sidebarNav) return null;
      const containerWrapper = sidebarNav.querySelector('.flex.flex-grow.flex-col.overflow-y-auto');
      const containers = containerWrapper?.querySelectorAll('.flex-1.relative');
      if (!containers || containers.length === 0) return null;
      const lastContainer = containers[containers.length - 1];
      const mainContainer = lastContainer.querySelector('.px-2.mt-4')
        || lastContainer.querySelector('.px-2.pt-2');
      if (!mainContainer) return null;
      // Mount just after the usage panel if present, else at the top.
      const usagePanel = mainContainer.querySelector('#ct-sidebar-usage');
      const ref = usagePanel ? usagePanel.nextSibling : (mainContainer.firstChild || null);
      return { parent: mainContainer, ref, type: 'web' };
    },
    // Claude's own Tailwind text tokens (theme-aware).
    textClasses: { t300: 'text-text-300', t400: 'text-text-400', t500: 'text-text-500' },
    // Dark-launch wiring (pref = chrome.storage.sync, flag = CDN flags.json field).
    prefKey: 'foldersEnabled',
    flagField: 'folders',
    availableKey: 'foldersAvailable',
    flagCacheKey: '__ct_folders_flag',
  };

  // ── The single canonical folders engine ──
  // Provider-agnostic; ADAPTER supplies all host-coupled behaviour. Called once
  // per page with the matching adapter (claude.ai below, chatgpt.com from
  // chatgpt-folders.js). Each call is an isolated instance with its own closure
  // state, so the two providers never share DOM/timers.
  function createFoldersEngine(ADAPTER) {
    // ── Idempotent (re)mount guard ──
    // Claude's engine is a static content script (injected once). ChatGPT's is
    // injected dynamically (background.js executeScript) and re-runs whenever the
    // optional host permission is (re)granted or the extension updates while a
    // chatgpt.com tab is open. Without a guard each re-run would stack a second
    // engine — duplicate MutationObserver, RAF loop, storage listener and
    // entitlement interval — in the same page. Tear down any prior instance for this
    // provider before building a fresh one, then register this instance's teardown.
    const _instanceReg = (globalThis.__ctFoldersInstances ||= {});
    try { _instanceReg[ADAPTER.provider]?.(); } catch { /* prior teardown best-effort */ }
    _instanceReg[ADAPTER.provider] = () => teardown();
    const CT_PANEL_ID = 'ct-folders-panel';
  const SITE_URL = 'https://claudetuner.com';
  const MOUNT_INTERVAL_MS = 1000;
  // Provider text-token classes (theme-aware). Claude: text-text-{300,400,500};
  // ChatGPT: text-token-text-{primary,tertiary,secondary}. Used in render templates
  // so panel text picks up the host's own theme colors.
  const TC = ADAPTER.textClasses;

  // Storage keys
  const FOLDERS_KEY = 'ct_claude_folders';   // Folder[]
  const CHAT_META_KEY = 'ct_claude_chat_meta'; // { [chatId]: { title, at } }
  const EXPANDED_KEY = 'ct_claude_folders_expanded'; // string[] of expanded folder ids
  const SORT_KEY = 'ct_claude_folders_sort';         // 'manual' | 'recent' | 'name'
  const SORT_MODES = ['manual', 'recent', 'name'];
  const SYNC_VERSION_KEY = 'ct_claude_folders_sync_v'; // number: monotonic store version (M3 sync)

  // Freemium limits.
  // Free: max 2 folders per parent (2 roots account-wide + 2 subfolders each) and
  // only 1 level of nesting (root -> sub). Pro: unlimited children, deeper nesting.
  const FREE_CHILD_LIMIT = 2;   // per-parent sibling cap (incl. root level)
  const FREE_MAX_DEPTH = 1;     // free can nest one level (root=0, sub=1)
  const MAX_NAME_LENGTH = 40;
  const MAX_NEST_DEPTH = 3;     // global hard cap (Pro): root=0 … deepest=3
  // Folder color labels (Pro). Tailwind-500 hues + the Claude accent; kept small so the
  // swatch grid stays scannable. `null` = default (no color). Stored regardless of plan so
  // colors survive a downgrade (render-only); only SETTING a color is Pro-gated.
  const FOLDER_COLORS = ['#ef4444', '#f59e0b', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#78716c', '#c96442'];
  // Folder emoji icons (Pro). A curated grid (never free-text) so a stored/injected value
  // can't reach the DOM — validated against this list on write and render. `null` = default.
  const EMOJI_CHOICES = ['📁', '📂', '⭐', '📌', '💡', '🔬', '🧪', '📊', '💼', '🎯', '📝', '🔖', '🚀', '🐛', '✅', '🎨'];
  // Import bounds/validation (untrusted backup files). Ids are query-safe (used in
  // querySelector); genId already produces this shape.
  const FOLDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const MAX_IMPORT_FOLDERS = 2000;    // guard against a huge file freezing the tab / quota
  const MAX_IMPORT_CHATMETA = 50000;
  // Thin outline glyphs (match Claude's light UI): a chat bubble (leading each conversation
  // + the chat-count badge) and a folder (the subfolder-count badge). Static literals.
  const SVG_ATTRS = 'aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';
  const CHAT_PATH = '<path d="M2.5 4.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H6l-3 2.5V4.5z"/>';
  const FOLDER_PATH = '<path d="M1.75 4.25a1 1 0 0 1 1-1h3L7 4.5h6.25a1 1 0 0 1 1 1v5.25a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"/>';
  const svgIcon = (path, cls, size) => `<svg ${SVG_ATTRS}${cls ? ` class="${cls}"` : ''} viewBox="0 0 16 16" width="${size}" height="${size}">${path}</svg>`;
  // M3 server sync (Pro-gated, whole-store LWW). All network goes through the
  // background service worker — the content script has no host_permissions.
  const SYNC_DEBOUNCE_MS = 3000;

  // ── Feature availability flag (dark-launch gate) ──
  // The WHOLE folders feature is gated behind a static CDN flag so the extension
  // can ship to CWS with folders DARK, then be turned on later by flipping one
  // static file — no Worker, no CWS resubmit. Served straight from the Cloudflare
  // CDN (cdn.claudetuner.com, R2 custom domain) with permissive CORS, so a
  // content-script fetch() works WITHOUT any host_permissions (like announcements).
  // Independent of the M3 FOLDER_SYNC_ENABLED worker flag (that only gates sync).
  const FLAGS_URL = 'https://cdn.claudetuner.com/flags.json';
  const FOLDERS_FLAG_CACHE_KEY = ADAPTER.flagCacheKey; // storage.local TTL cache (per-provider)
  const FOLDERS_FLAG_TTL_MS = 60 * 60 * 1000;         // 1h — matches announcements
  // Written to storage.local on every availability check so the OPTIONS page can
  // read the current state without doing its own CDN fetch (per-provider key).
  const FOLDERS_AVAILABLE_KEY = ADAPTER.availableKey;

  // ── State ──
  let _enabled = null;      // effective gate = _available && _userPref
  let _available = false;   // CDN dark-launch flag (folders.json); starts DARK
  let _userPref = true;     // user preference (chrome.storage.sync foldersEnabled)
  let _flagChecking = false;// in-flight guard for fetchFolderAvailable()
  let _lastFlagCheck = 0;   // throttle: at most one availability check per TTL
  let _lang = 'en';
  let _mounted = false;
  let _plan = 'free';       // our billing entitlement: 'free' | 'pro'
  let _folders = [];        // cached Folder[]
  let _chatMeta = {};       // id -> { title, at }
  let _expanded = new Set();// folder ids currently expanded in the tree
  let _sortMode = 'manual'; // sibling sort within pins: manual(order) | recent(updatedAt) | name
  let _query = '';          // active search query (lowercased)
  // M3 server sync state.
  let _syncDisabled = false; // set for the session on 403 (not Pro) / 404 (flag off)
  let _pulling = false;      // in-flight guard for pullStore() — coalesces overlapping calls
  let _storeUpdatedAt = 0;   // monotonic store version counter (persisted); bumped strictly
                             // upward on every local mutation, and raised (never lowered) to
                             // match an adopted server version — never derived from raw
                             // Date.now() clock skew alone, so it can't oscillate/loop 409s
  let _syncTimer = null;     // debounce handle for the push
  let _observer = null;
  let _intervals = [];
  // Drag-and-drop.
  // - Folder → folder (reparent) uses NATIVE HTML5 drag (folder rows are our own
  //   elements with draggable=true; native drag is reliable for them).
  // - Chat → folder uses a CUSTOM POINTER drag: Claude's sidebar conversation links
  //   are button-styled and navigate on press, which aborts native drag before it can
  //   reach a folder. So we track pointer events ourselves and suppress that click.
  // _drag holds the native (folder) payload; _ptr holds the pointer (chat) drag.
  // _dragging (set by either) suppresses re-render/remount so the drop target can't
  // vanish mid-drag.
  let _drag = null;         // { type:'folder', id } | null  (native folder drag)
  let _dragging = false;
  let _ptr = null;          // pointer drag state (chat → folder), see onDocPointerDown
  const PTR_DRAG_THRESHOLD = 5; // px of movement before a press becomes a drag

  // ── i18n (minimal, folders only) ──
  const I18N = {
    ko: {
      folders: '폴더',
      add_folder: '새 폴더',
      sort: '정렬',
      search: '검색',
      sort_manual: '수동',
      sort_recent: '최근',
      sort_name: '이름',
      backup: '백업',
      export: '내보내기 (JSON)',
      import: '가져오기 (복원)',
      import_confirm: '가져오면 현재 폴더가 모두 이 백업으로 교체됩니다. 계속할까요?',
      import_ok: '폴더를 복원했어요.',
      import_bad: '올바른 백업 파일이 아니에요.',
      import_too_big: '백업 파일이 너무 커요.',
      folder_name_ph: '폴더 이름',
      rename: '이름 변경',
      delete: '삭제',
      favorite: '즐겨찾기 (상단 고정)',
      unfavorite: '즐겨찾기 해제',
      subfolder_count: '하위 폴더',
      chat_count: '대화',
      add_current: '현재 대화 담기',
      empty_folder: '비어 있음',
      no_folders: '폴더가 없습니다. 새 폴더를 만들어 대화를 정리하세요.',
      delete_confirm: '이 폴더를 삭제할까요? (대화는 삭제되지 않습니다)',
      limit_reached: '무료 플랜은 폴더 2개까지예요',
      upgrade_cta: 'Pro로 무제한 폴더 →',
      added: '담았어요',
      already_in: '이미 담긴 대화예요',
      open_chat: '대화 열기',
      remove_from_folder: '폴더에서 빼기',
      pick_folder: '담을 폴더 선택',
      not_in_chat: '대화 화면에서 사용하세요',
      add_subfolder: '하위 폴더 추가',
      move_to: '이동',
      move_to_root: '최상위로',
      depth_limit: '더 깊이 만들 수 없어요',
      sub_limit_reached: '하위 폴더는 2개까지예요',
      free_root_blocked: '무료 플랜은 폴더 2개까지예요.',
      free_sub_blocked: '무료 플랜은 하위 폴더 2개까지예요.',
      free_nest_blocked: '무료 플랜은 폴더 1단계까지만 중첩할 수 있어요.',
      free_color_blocked: '폴더 색상은 Pro 기능이에요.',
      free_icon_blocked: '폴더 아이콘은 Pro 기능이에요.',
      color: '색상',
      icon: '아이콘',
      color_none: '기본',
      upgrade_q: 'Pro로 업그레이드하면 폴더를 무제한으로 만들 수 있어요. 지금 업그레이드할까요?',
      search_ph: '폴더·대화 검색',
      no_results: '검색 결과 없음',
      in_folder: '위치',
      move_to_folder: '폴더에 담기',
      mtf_title: '폴더에 담기',
      mtf_search: '폴더 검색…',
      mtf_added: '폴더에 담았어요.',
      mtf_dup: '이미 이 폴더에 있어요.',
      mtf_empty: '폴더가 없어요. 사이드바에서 먼저 만들어 주세요.',
    },
    en: {
      folders: 'Folders',
      add_folder: 'New folder',
      sort: 'Sort',
      search: 'Search',
      sort_manual: 'Manual',
      sort_recent: 'Recent',
      sort_name: 'Name',
      backup: 'Backup',
      export: 'Export (JSON)',
      import: 'Import (restore)',
      import_confirm: 'Importing replaces all your current folders with this backup. Continue?',
      import_ok: 'Folders restored.',
      import_bad: 'Not a valid backup file.',
      import_too_big: 'Backup file is too large.',
      folder_name_ph: 'Folder name',
      rename: 'Rename',
      delete: 'Delete',
      favorite: 'Pin to top',
      unfavorite: 'Unpin',
      subfolder_count: 'Subfolders',
      chat_count: 'Chats',
      add_current: 'Add current chat',
      empty_folder: 'Empty',
      no_folders: 'No folders yet. Create one to organize your chats.',
      delete_confirm: 'Delete this folder? (Your chats are not deleted)',
      limit_reached: 'Free plan supports up to 2 folders',
      upgrade_cta: 'Unlimited folders with Pro →',
      added: 'Added',
      already_in: 'Already in this folder',
      open_chat: 'Open chat',
      remove_from_folder: 'Remove from folder',
      pick_folder: 'Pick a folder',
      not_in_chat: 'Open a chat to use this',
      add_subfolder: 'Add subfolder',
      move_to: 'Move to',
      move_to_root: 'Top level',
      depth_limit: "Can't nest any deeper",
      sub_limit_reached: 'Up to 2 subfolders',
      free_root_blocked: 'The free plan allows up to 2 folders.',
      free_sub_blocked: 'The free plan allows up to 2 subfolders.',
      free_nest_blocked: 'The free plan allows only one level of nesting.',
      free_color_blocked: 'Folder colors are a Pro feature.',
      free_icon_blocked: 'Folder icons are a Pro feature.',
      color: 'Color',
      icon: 'Icon',
      color_none: 'Default',
      upgrade_q: 'Upgrade to Pro for unlimited folders. Upgrade now?',
      search_ph: 'Search folders & chats',
      no_results: 'No results',
      in_folder: 'in',
      move_to_folder: 'Add to folder',
      mtf_title: 'Add to folder',
      mtf_search: 'Search folders…',
      mtf_added: 'Added to folder.',
      mtf_dup: 'Already in this folder.',
      mtf_empty: 'No folders yet — create one in the sidebar first.',
    },
  };
  function t(key) {
    return (I18N[_lang] || I18N.en)[key] || I18N.en[key] || key;
  }

  // ── Utility ──
  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }
  // Match Claude's active theme (mirrors input-usage.js isDarkTheme) so floating
  // menus rendered on <body> don't mismatch when OS scheme != Claude's theme.
  function isDark() {
    const html = document.documentElement;
    if (html.classList.contains('dark')) return true;
    if (html.getAttribute('data-theme') === 'dark') return true;
    if (html.getAttribute('data-mode') === 'dark') return true;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  // Host-coupled reads route through the provider adapter (see CLAUDE_ADAPTER /
  // chatgpt-folders.js CHATGPT_ADAPTER).
  function getActiveOrgId() { return ADAPTER.getActiveOrgId(); }
  function getCurrentChatId() { return ADAPTER.getCurrentChatId(); }
  // Best-effort title for a chat: active sidebar link text, else document.title.
  function getCurrentChatTitle(chatId) {
    const link = document.querySelector(ADAPTER.getChatLinkSelector(chatId));
    const fromLink = link?.textContent?.trim();
    if (fromLink) return fromLink.slice(0, 120);
    const dt = ADAPTER.stripTitleSuffix(document.title || '');
    return dt || 'Untitled';
  }
  function genId() {
    return 'f_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }
  function childLimit() {
    return _plan === 'pro' ? Infinity : FREE_CHILD_LIMIT; // Pro = unlimited children
  }
  function maxDepth() {
    return _plan === 'pro' ? MAX_NEST_DEPTH : FREE_MAX_DEPTH;
  }

  // ── Store ──
  function loadStore() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ [FOLDERS_KEY]: [], [CHAT_META_KEY]: {} }, (r) => {
          if (chrome.runtime.lastError) { resolve(); return; }
          _folders = Array.isArray(r[FOLDERS_KEY]) ? r[FOLDERS_KEY] : [];
          _chatMeta = r[CHAT_META_KEY] && typeof r[CHAT_META_KEY] === 'object' ? r[CHAT_META_KEY] : {};
          resolve();
        });
      } catch { resolve(); }
    });
  }
  // One-time restore of the expanded set (survives full page reloads / chat clicks).
  // Kept separate from loadStore so the folder-change reload never clobbers live UI state.
  function loadExpanded() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ [EXPANDED_KEY]: [], [SORT_KEY]: 'manual', [SYNC_VERSION_KEY]: 0 }, (r) => {
          if (!chrome.runtime.lastError) {
            _expanded = new Set(Array.isArray(r[EXPANDED_KEY]) ? r[EXPANDED_KEY] : []);
            _sortMode = SORT_MODES.includes(r[SORT_KEY]) ? r[SORT_KEY] : 'manual';
            _storeUpdatedAt = Number.isFinite(r[SYNC_VERSION_KEY]) ? r[SYNC_VERSION_KEY] : 0;
          }
          resolve();
        });
      } catch { resolve(); }
    });
  }
  // Persist the monotonic sync version so it survives a reload (never regresses).
  function persistSyncVersion() {
    try { chrome.storage.local.set({ [SYNC_VERSION_KEY]: _storeUpdatedAt }); } catch { /* context dead */ }
  }
  function persistSort() {
    try { chrome.storage.local.set({ [SORT_KEY]: _sortMode }); } catch { /* context dead */ }
  }
  function setSortMode(mode) {
    if (!SORT_MODES.includes(mode) || mode === _sortMode) return;
    _sortMode = mode;
    persistSort();
    renderList();
  }
  function persistFolders() {
    try { chrome.storage.local.set({ [FOLDERS_KEY]: _folders }); } catch { /* context dead */ }
    scheduleSync();
  }
  function persistChatMeta() {
    try { chrome.storage.local.set({ [CHAT_META_KEY]: _chatMeta }); } catch { /* context dead */ }
    scheduleSync();
  }
  // Persist the expanded-folder set so tree state is restored after navigation/reload.
  function persistExpanded() {
    try { chrome.storage.local.set({ [EXPANDED_KEY]: Array.from(_expanded) }); } catch { /* context dead */ }
  }

  // ── Provider ownership (free-cap + visibility scoping) ──
  // A folder's provider is derived from its orgUuid: the ChatGPT bucket uses the
  // sentinel CHATGPT_ORG; every other value — a real Claude org uuid or the legacy
  // null from before orgs were tracked — belongs to Claude. Centralizing the
  // sentinel here keeps the adapters declaring only `provider` (no leaked literals).
  const CHATGPT_ORG = 'chatgpt';
  function providerOfOrg(orgUuid) { return orgUuid === CHATGPT_ORG ? 'chatgpt' : 'claude'; }
  function ownsFolder(f) { return providerOfOrg(f.orgUuid) === ADAPTER.provider; }

  // Count of folders sharing a parent, scoped to the FREE-CAP bucket.
  // - Non-root (real parent): that folder's direct children — one subtree, already
  //   org-homogeneous (createFolder/moveFolder keep a subtree in one bucket).
  // - Root (parent null): roots THIS provider owns. Claude counts every Claude-owned
  //   root account-wide (across all Claude orgs + legacy null) to preserve the
  //   original anti-multi-org-bypass cap; ChatGPT counts only its own "chatgpt"
  //   bucket. Both reduce to "roots this provider owns", so a full Claude bucket
  //   never blocks creating a ChatGPT root, and vice versa.
  function siblingCount(parent) {
    if (parent) return _folders.filter(f => (f.parent || null) === parent).length;
    return _folders.filter(f => !f.parent && ownsFolder(f)).length;
  }
  // Folders visible in the active panel: only those THIS provider owns (never leak
  // Claude's legacy null-org folders into the ChatGPT panel, or vice versa), then —
  // for Claude — scoped to the active org (legacy null shown; everything shown while
  // the org id isn't known yet). On ChatGPT the active org is always CHATGPT_ORG.
  function foldersForActiveOrg() {
    const org = getActiveOrgId();
    return _folders.filter(f => ownsFolder(f) && (!f.orgUuid || !org || f.orgUuid === org));
  }

  // ── Tree helpers (nesting) ──
  function folderById(id) { return _folders.find(x => x.id === id) || null; }
  // Sibling display order: pinned (favorite) folders float to the top of their group,
  // then by manual `order`. Shared by childrenOf and the root-level sort so pinning is
  // consistent everywhere.
  function siblingSort(a, b) {
    // Pins always float to the top; within each partition the sort mode decides.
    const fav = (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
    if (fav) return fav;
    if (_sortMode === 'name') return a.name.localeCompare(b.name) || (a.order || 0) - (b.order || 0);
    if (_sortMode === 'recent') return (b.updatedAt || 0) - (a.updatedAt || 0) || (a.order || 0) - (b.order || 0);
    return (a.order || 0) - (b.order || 0); // manual
  }
  function childrenOf(parentId) {
    return foldersForActiveOrg()
      .filter(f => (f.parent || null) === (parentId || null))
      .sort(siblingSort);
  }
  // Depth of a folder from its root (root = 0). Guards against broken cycles.
  function folderDepth(id) {
    let depth = 0, cur = folderById(id), seen = new Set();
    while (cur && cur.parent && !seen.has(cur.id)) {
      seen.add(cur.id); depth++; cur = folderById(cur.parent);
    }
    return depth;
  }
  // All descendant ids of a folder (excludes itself). Walks the raw _folders graph
  // so a subtree is treated as one unit regardless of org (subtrees are kept
  // org-homogeneous by createFolder/moveFolder, so this never spans orgs).
  function descendantIds(id) {
    const out = new Set();
    const walk = (pid) => {
      for (const c of _folders.filter(f => (f.parent || null) === pid)) {
        if (!out.has(c.id)) { out.add(c.id); walk(c.id); }
      }
    };
    walk(id);
    return out;
  }
  // Height of the subtree rooted at id (0 = leaf).
  function subtreeHeight(id) {
    let max = 0;
    const walk = (pid, d) => {
      max = Math.max(max, d);
      for (const c of _folders.filter(x => (x.parent || null) === pid)) walk(c.id, d + 1);
    };
    walk(id, 0);
    return max;
  }
  // Force a folder and all its descendants into one org (keeps a subtree homogeneous
  // so org-scoped display and org-agnostic tree ops can never disagree).
  function setSubtreeOrg(id, orgUuid) {
    const ids = descendantIds(id); ids.add(id);
    for (const f of _folders) {
      if (ids.has(f.id)) { f.orgUuid = orgUuid || null; f.updatedAt = Date.now(); }
    }
  }

  function createFolder(name, parent = null) {
    const clean = String(name || '').trim().slice(0, MAX_NAME_LENGTH);
    if (!clean) return { ok: false, reason: 'empty' };
    const newDepth = parent ? folderDepth(parent) + 1 : 0;
    // Depth cap: 'plan_depth' when the free depth cap is what's blocking (→ upsell),
    // 'depth' when the global hard cap is hit (Pro too).
    if (newDepth > MAX_NEST_DEPTH) return { ok: false, reason: 'depth' };
    if (newDepth > maxDepth()) return { ok: false, reason: 'plan_depth' };
    // Per-parent sibling cap ('limit' for root, 'plan_children' when free-gated).
    if (siblingCount(parent) >= childLimit()) {
      return { ok: false, reason: parent ? 'plan_children' : 'limit' };
    }
    const now = Date.now();
    // A subfolder inherits its parent's org so a subtree is always org-homogeneous.
    const orgUuid = parent ? (folderById(parent)?.orgUuid ?? null) : (getActiveOrgId() || null);
    _folders.push({
      id: genId(),
      orgUuid,
      name: clean,
      parent: parent || null,
      chatIds: [],
      favorite: false,
      color: null,
      icon: null,
      order: _folders.length,
      createdAt: now,
      updatedAt: now,
      syncedAt: null,
    });
    persistFolders();
    return { ok: true };
  }
  function renameFolder(id, name) {
    const clean = String(name || '').trim().slice(0, MAX_NAME_LENGTH);
    if (!clean) return;
    const f = folderById(id);
    if (!f) return;
    f.name = clean; f.updatedAt = Date.now();
    persistFolders();
  }
  // Pin/unpin a folder. Pinned folders float to the top of their sibling group (siblingSort).
  function toggleFavorite(id) {
    const f = folderById(id);
    if (!f) return;
    f.favorite = !f.favorite; f.updatedAt = Date.now();
    persistFolders();
  }
  // Set (or clear, color=null) a folder's color label. Only a known palette color or null is
  // accepted so a stale/injected value can't reach render. Pro-gated at the call site.
  function setFolderColor(id, color) {
    const f = folderById(id);
    if (!f) return;
    f.color = (color && FOLDER_COLORS.includes(color)) ? color : null;
    f.updatedAt = Date.now();
    persistFolders();
  }
  // Set (or clear, icon=null) a folder's emoji icon. Only a known palette emoji or null is
  // accepted. Pro-gated at the call site.
  function setFolderIcon(id, icon) {
    const f = folderById(id);
    if (!f) return;
    f.icon = (icon && EMOJI_CHOICES.includes(icon)) ? icon : null;
    f.updatedAt = Date.now();
    persistFolders();
  }
  // The folder's leading glyph, precedence emoji > color-dot > default 📁. Palette-validated
  // so a stored/injected value can never reach the DOM. Shared by the tree and search rows.
  function folderIconHtml(f) {
    const ic = EMOJI_CHOICES.includes(f.icon) ? f.icon : null;
    if (ic) return `<span class="ct-fold-icon">${ic}</span>`;
    const c = FOLDER_COLORS.includes(f.color) ? f.color : null;
    return `<span class="ct-fold-icon"${c ? ` style="color:${c}"` : ''}>${c ? '●' : '📁'}</span>`;
  }

  // ── Backup: local JSON export / import (free; also the on-ramp to future server sync) ──
  function exportFolders() {
    const payload = { v: 1, exportedAt: Date.now(), folders: _folders, chatMeta: _chatMeta };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    a.href = url;
    a.download = `claude-folders-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // Coerce an imported record to the exact folder shape — never trust the file. Palette-gated
  // color/icon, clamped name, typed fields; returns null for anything without a usable id+name.
  function sanitizeImportedFolder(f) {
    if (!f || typeof f !== 'object') return null;
    // Ids must be query-safe (they're interpolated into querySelector); reject otherwise.
    const id = (typeof f.id === 'string' && FOLDER_ID_RE.test(f.id)) ? f.id : null;
    const name = typeof f.name === 'string' ? f.name.trim().slice(0, MAX_NAME_LENGTH) : '';
    if (!id || !name) return null;
    return {
      id,
      orgUuid: typeof f.orgUuid === 'string' ? f.orgUuid : null,
      name,
      parent: (typeof f.parent === 'string' && FOLDER_ID_RE.test(f.parent)) ? f.parent : null,
      chatIds: Array.isArray(f.chatIds) ? f.chatIds.filter(c => typeof c === 'string') : [],
      favorite: !!f.favorite,
      color: (typeof f.color === 'string' && FOLDER_COLORS.includes(f.color)) ? f.color : null,
      icon: (typeof f.icon === 'string' && EMOJI_CHOICES.includes(f.icon)) ? f.icon : null,
      order: Number.isFinite(f.order) ? f.order : 0,
      createdAt: Number.isFinite(f.createdAt) ? f.createdAt : Date.now(),
      updatedAt: Number.isFinite(f.updatedAt) ? f.updatedAt : Date.now(),
      syncedAt: Number.isFinite(f.syncedAt) ? f.syncedAt : null,
    };
  }
  // Coerce imported chatMeta to { [id]: {title:string, at:number} } — a hostile non-string
  // title would otherwise crash search (.toLowerCase()); also caps the entry count.
  function sanitizeImportedChatMeta(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    let n = 0;
    for (const k of Object.keys(raw)) {
      if (n >= MAX_IMPORT_CHATMETA) break;
      const m = raw[k];
      if (!m || typeof m !== 'object') continue;
      const title = typeof m.title === 'string' ? m.title.slice(0, 200) : '';
      if (!title) continue;
      out[k] = { title, at: Number.isFinite(m.at) ? m.at : Date.now() };
      n++;
    }
    return out;
  }
  // Restore from a backup file: parse → sanitize → confirm → REPLACE the whole store in ONE
  // atomic storage write (so a quota/runtime failure never reports success on a partial
  // restore). Folder names are escaped at render and ids are query-safe, so a hostile file
  // can't inject; dangling/cyclic parents are tolerated by renderList.
  function importFolders(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(String(reader.result)); } catch { window.alert(t('import_bad')); return; }
      if (!data || !Array.isArray(data.folders)) { window.alert(t('import_bad')); return; }
      if (data.folders.length > MAX_IMPORT_FOLDERS) { window.alert(t('import_too_big')); return; }
      const folders = data.folders.map(sanitizeImportedFolder).filter(Boolean);
      const chatMeta = sanitizeImportedChatMeta(data.chatMeta);
      if (!window.confirm(t('import_confirm'))) return;
      try {
        chrome.storage.local.set({ [FOLDERS_KEY]: folders, [CHAT_META_KEY]: chatMeta, [EXPANDED_KEY]: [] }, () => {
          if (chrome.runtime.lastError) { window.alert(t('import_bad')); return; }
          // Only adopt into memory after the persist actually succeeded.
          _folders = folders; _chatMeta = chatMeta; _expanded = new Set();
          renderList();
          // Push the restored backup to the server instead of waiting for the next
          // mutation/6h entitlement refresh.
          if (_plan === 'pro') scheduleSync();
          window.alert(t('import_ok'));
        });
      } catch { window.alert(t('import_bad')); }
    };
    reader.readAsText(file);
  }
  // Cascade delete: remove the folder AND all its descendants (chats are never deleted).
  function deleteFolder(id) {
    const doomed = descendantIds(id);
    doomed.add(id);
    _folders = _folders.filter(x => !doomed.has(x.id));
    doomed.forEach(d => _expanded.delete(d));
    persistFolders();
    persistExpanded();
  }
  // Reparent a folder. Rejects self, descendants (cycle), and depth-limit violations.
  function moveFolder(id, newParent) {
    const f = folderById(id);
    if (!f) return { ok: false };
    const target = newParent || null;
    // Target may have been deleted by another tab mid-drag (store refreshed but the
    // DOM row not yet re-rendered) — never persist a dangling parent / null org.
    if (target && !folderById(target)) return { ok: false, reason: 'gone' };
    // Provider isolation: refuse to move a folder the active provider doesn't own, or
    // to reparent under a target it doesn't own. Normal UI only surfaces owned folders,
    // so this only rejects malformed/imported/server-adopted data whose parent/orgUuid
    // links cross the Claude↔ChatGPT boundary — which would otherwise let a sibling
    // reorder rewrite the dragged subtree into a hidden bucket's org (setSubtreeOrg).
    if (!ownsFolder(f)) return { ok: false, reason: 'cross_provider' };
    if (target && !ownsFolder(folderById(target))) return { ok: false, reason: 'cross_provider' };
    if (target === (f.parent || null)) return { ok: false, reason: 'noop' };
    if (target === id) return { ok: false, reason: 'self' };
    if (target && descendantIds(id).has(target)) return { ok: false, reason: 'descendant' };
    // New depth = target depth + 1 + this subtree's own height must stay within limit.
    const newBaseDepth = target ? folderDepth(target) + 1 : 0;
    const newBottom = newBaseDepth + subtreeHeight(id);
    if (newBottom > MAX_NEST_DEPTH) return { ok: false, reason: 'depth' };
    if (newBottom > maxDepth()) return { ok: false, reason: 'plan_depth' };
    // Per-parent sibling cap at the destination (moving to a new parent).
    if (siblingCount(target) >= childLimit()) {
      return { ok: false, reason: target ? 'plan_children' : 'limit' };
    }
    f.parent = target; f.updatedAt = Date.now();
    // Keep the subtree org-homogeneous: adopt the new parent's org (or the current
    // active org when promoted to root). Prevents orphaned/hidden descendants.
    const newOrg = target ? (folderById(target)?.orgUuid ?? null) : (getActiveOrgId() || null);
    setSubtreeOrg(id, newOrg);
    persistFolders();
    return { ok: true };
  }
  // Whether a folder-reparent drop of `dragId` into `targetId` is worth offering as a
  // drop target (drag affordance only — moveFolder is authoritative). Excludes ONLY
  // structurally impossible or no-op destinations (self, current parent, descendant/
  // cycle, or a subtree that can't fit even for Pro). Free-plan caps are NOT excluded:
  // those stay droppable and surface a clear block + upgrade offer on drop.
  function canDropFolderInto(dragId, targetId) {
    if (!dragId || !targetId || dragId === targetId) return false;
    const dragged = folderById(dragId);
    if (!dragged) return false;
    if (!folderById(targetId)) return false; // target deleted by another tab mid-drag
    if ((dragged.parent || null) === targetId) return false; // already a child (no-op)
    if (descendantIds(dragId).has(targetId)) return false;    // would create a cycle
    const base = folderDepth(targetId) + 1;
    return base + subtreeHeight(dragId) <= MAX_NEST_DEPTH;     // fits the hard cap
  }
  // Whether `dragId` can drop as a sibling adjacent to `targetId` (reorder / reparent-to-
  // sibling). Same parent → always (pure reorder). Different parent → structural feasibility
  // only (not self/descendant/cycle, subtree fits the hard depth cap); free caps stay
  // droppable so the drop surfaces the upgrade prompt, mirroring canDropFolderInto.
  function canDropAsSibling(dragId, targetId) {
    if (!dragId || !targetId || dragId === targetId) return false;
    const dragged = folderById(dragId), target = folderById(targetId);
    if (!dragged || !target) return false;
    // Sibling reorder rewrites `order`, which only drives display in manual sort mode; under
    // recent/name sorting a before/after drop would silently do nothing, so don't offer it.
    if (_sortMode !== 'manual') return false;
    // Reorder is only meaningful within the same pin partition: siblingSort floats favorites
    // above non-favorites, so `order` (what reorder rewrites) has no visual effect across the
    // favorite/non-favorite boundary — a cross-partition drop would silently do nothing.
    if (!!dragged.favorite !== !!target.favorite) return false;
    const destParent = target.parent || null;
    if ((dragged.parent || null) === destParent) return true;       // same parent = reorder
    if (destParent === dragId) return false;                        // can't nest under self
    if (destParent && descendantIds(dragId).has(destParent)) return false; // cycle
    const base = destParent ? folderDepth(destParent) + 1 : 0;
    return base + subtreeHeight(dragId) <= MAX_NEST_DEPTH;          // subtree fits hard cap
  }
  // Reorder `dragId` to sit immediately before/after `targetId` among the target's siblings.
  // Cross-parent drops are reparented first via moveFolder (reuses every cycle/depth/cap/org
  // guard), then positioned; same-parent drops only renumber `order`. Returns moveFolder's
  // failure reason on a blocked cross-parent reparent so the caller can surface the upsell.
  function reorderFolder(dragId, targetId, position) {
    const dragged = folderById(dragId), target = folderById(targetId);
    if (!dragged || !target || dragId === targetId) return { ok: false };
    const destParent = target.parent || null;
    if ((dragged.parent || null) !== destParent) {
      const res = moveFolder(dragId, destParent);   // guards: self/descendant/depth/cap + org
      if (!res.ok) return res;
    }
    // Now a sibling of target: splice into the requested slot and renumber this parent's
    // children `order` to a dense 0..n-1 (order is only ever compared within a parent).
    const sibs = childrenOf(destParent).filter(s => s.id !== dragId);
    let idx = sibs.findIndex(s => s.id === targetId);
    if (idx < 0) return { ok: false };
    if (position === 'after') idx += 1;
    sibs.splice(idx, 0, dragged);
    let changed = false;
    sibs.forEach((s, i) => { if ((s.order || 0) !== i) { s.order = i; s.updatedAt = Date.now(); changed = true; } });
    if (changed) persistFolders();
    return { ok: true };
  }
  function addChatToFolder(id, chatId, title) {
    const f = _folders.find(x => x.id === id);
    if (!f || !chatId) return { ok: false };
    if (f.chatIds.includes(chatId)) return { ok: false, reason: 'dup' };
    f.chatIds = Array.from(new Set([...f.chatIds, chatId]));
    f.updatedAt = Date.now();
    _chatMeta[chatId] = { title: title || _chatMeta[chatId]?.title || 'Untitled', at: Date.now() };
    persistFolders(); persistChatMeta();
    return { ok: true };
  }
  function removeChatFromFolder(id, chatId) {
    const f = _folders.find(x => x.id === id);
    if (!f) return;
    f.chatIds = f.chatIds.filter(c => c !== chatId);
    f.updatedAt = Date.now();
    persistFolders();
  }

  // ── Sidebar anchor detection (provider-specific DOM, via adapter) ──
  function findSidebarAnchor() { return ADAPTER.findSidebarAnchor(); }

  // ── Render ──
  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = CT_PANEL_ID;
    panel.className = 'ct-folders';
    panel.innerHTML = `
      <div class="ct-fold-header">
        <span class="ct-fold-title ${TC.t500}">${escapeHtml(t('folders'))}</span>
        <button class="ct-fold-search-btn" title="${escapeHtml(t('search'))}" aria-label="${escapeHtml(t('search'))}"><svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg></button>
        <button class="ct-fold-more-btn" title="${escapeHtml(t('backup'))}" aria-label="${escapeHtml(t('backup'))}">⋯</button>
        <button class="ct-fold-sort-btn" title="${escapeHtml(t('sort'))}" aria-label="${escapeHtml(t('sort'))}">⇅</button>
        <button class="ct-fold-add-btn" title="${escapeHtml(t('add_folder'))}" aria-label="${escapeHtml(t('add_folder'))}">+</button>
        <input type="file" class="ct-fold-import-input" accept="application/json,.json" style="display:none" />
      </div>
      <div class="ct-fold-add-form" style="display:none">
        <input type="text" class="ct-fold-name-input" maxlength="${MAX_NAME_LENGTH}" placeholder="${escapeHtml(t('folder_name_ph'))}" />
      </div>
      <div class="ct-fold-search-wrap" style="display:none">
        <input type="search" class="ct-fold-search" placeholder="${escapeHtml(t('search_ph'))}" />
      </div>
      <div class="ct-fold-list"></div>
      <div class="ct-fold-gate" style="display:none"></div>
    `;
    return panel;
  }

  function renderList() {
    const panel = document.getElementById(CT_PANEL_ID);
    if (!panel) return;
    const list = panel.querySelector('.ct-fold-list');
    const gate = panel.querySelector('.ct-fold-gate');
    const addBtn = panel.querySelector('.ct-fold-add-btn');
    if (!list) return;

    const folders = foldersForActiveOrg();
    list.innerHTML = '';
    if (_query) {
      renderSearchResults(list);
    } else if (!folders.length) {
      list.innerHTML = `<div class="ct-fold-empty ${TC.t400}">${escapeHtml(t('no_folders'))}</div>`;
    } else {
      // Tree: roots = visible folders with no visible parent (parent null, or parent
      // hidden/missing → promote as root so nothing silently disappears), recurse.
      const visible = foldersForActiveOrg();
      const visibleIds = new Set(visible.map(f => f.id));
      const roots = visible
        .filter(f => !f.parent || !visibleIds.has(f.parent))
        .sort(siblingSort);
      for (const f of roots) {
        list.appendChild(renderFolderRow(f, 0));
      }
    }

    // Freemium gate UI — the top-level "+" adds a root folder, so gate on the root cap.
    const atLimit = siblingCount(null) >= childLimit();
    if (atLimit && _plan !== 'pro') {
      gate.style.display = '';
      gate.innerHTML = `
        <div class="ct-fold-limit ${TC.t400}">${escapeHtml(t('limit_reached'))}</div>
        <a class="ct-fold-upgrade" href="${SITE_URL}/dashboard/?upgrade=folders&utm_source=folders" target="_blank" rel="noopener">${escapeHtml(t('upgrade_cta'))}</a>
      `;
      if (addBtn) { addBtn.disabled = true; addBtn.classList.add('ct-disabled'); }
    } else {
      gate.style.display = 'none';
      gate.innerHTML = '';
      if (addBtn) { addBtn.disabled = false; addBtn.classList.remove('ct-disabled'); }
    }
  }

  function renderFolderRow(f, depth) {
    const row = document.createElement('div');
    row.className = 'ct-fold-item';
    row.dataset.folderId = f.id;
    const isOpen = _expanded.has(f.id);
    const kids = childrenOf(f.id);
    const count = f.chatIds.length;

    const head = document.createElement('div');
    head.className = 'ct-fold-row ' + TC.t300;
    head.style.paddingLeft = `${6 + depth * 8}px`;
    // Folder rows are draggable (reparent via drop onto another folder row).
    head.draggable = true;
    head.dataset.folderId = f.id;
    head.innerHTML = `
      <span class="ct-fold-caret ${isOpen ? 'open' : ''}"><svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg></span>
      ${folderIconHtml(f)}
      <span class="ct-fold-label" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <span class="ct-fold-counts ${TC.t500}">${kids.length ? `<span class="ct-fold-cnt" title="${escapeHtml(t('subfolder_count'))}">${svgIcon(FOLDER_PATH, '', 11)}${kids.length}</span>` : ''}${count ? `<span class="ct-fold-cnt" title="${escapeHtml(t('chat_count'))}">${svgIcon(CHAT_PATH, '', 11)}${count}</span>` : ''}</span>
      <button class="ct-fold-star ${f.favorite ? 'on' : ''}" title="${escapeHtml(t(f.favorite ? 'unfavorite' : 'favorite'))}" aria-label="${escapeHtml(t(f.favorite ? 'unfavorite' : 'favorite'))}">${f.favorite ? '★' : '☆'}</button>
      <button class="ct-fold-menu-btn" title="${escapeHtml(t('rename'))}/${escapeHtml(t('delete'))}" aria-label="menu">⋯</button>
    `;
    row.appendChild(head);

    // Toggle expand on the label/caret
    head.querySelector('.ct-fold-caret').addEventListener('click', () => toggleExpand(f.id));
    head.querySelector('.ct-fold-label').addEventListener('click', () => toggleExpand(f.id));

    // Pin toggle: favorite folders float to the top of their sibling group.
    head.querySelector('.ct-fold-star').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(f.id);
      renderList();
    });

    // Pressing a row control (star / ⋯) must not begin the row's native drag. The native
    // dragstart fires on the draggable row, not the inner button, so we can't filter it in
    // onDocDragStart; instead disable the row's draggability while a control is pressed and
    // restore it on mouseup, so a press-and-jiggle stays a click.
    head.querySelectorAll('.ct-fold-star, .ct-fold-menu-btn').forEach((btn) => {
      btn.addEventListener('mousedown', () => {
        head.draggable = false;
        const restore = () => { head.draggable = true; document.removeEventListener('mouseup', restore, true); };
        document.addEventListener('mouseup', restore, true);
      });
    });

    // Row menu: add subfolder / move / rename / delete / add current chat
    head.querySelector('.ct-fold-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openRowMenu(f, head.querySelector('.ct-fold-menu-btn'));
    });

    // Native drop target for folder → folder reparent only (chat → folder is handled
    // by the pointer-drag path, which hit-tests rows via elementFromPoint). moveFolder
    // is authoritative; canDropFolderInto gates the dragover affordance.
    // Middle of the row = reparent (moveFolder into f); top/bottom edge = sibling reorder
    // (reorderFolder before/after f). moveFolder/reorderFolder are authoritative; canDrop*
    // gate the dragover affordance. Free-cap blocks surface the upgrade prompt on drop.
    const surfaceDropBlock = (reason) => {
      if (reason === 'plan_children') promptUpgrade('free_sub_blocked', 'move');
      else if (reason === 'plan_depth') promptUpgrade('free_nest_blocked', 'move');
      else if (reason === 'limit') promptUpgrade('free_root_blocked', 'move');
      else if (reason === 'depth') window.alert(t('depth_limit'));
      else renderList(); // noop / self / descendant / gone: settle to current state
    };
    head.addEventListener('dragover', (e) => {
      if (!_drag || _drag.type !== 'folder') return;
      const zone = folderDropZone(e, head);
      const ok = zone === 'into' ? canDropFolderInto(_drag.id, f.id)
                                 : canDropAsSibling(_drag.id, f.id);
      // Clear any prior highlight first so an invalid zone shows nothing (no stale
      // affordance when moving from a valid edge into an invalid middle on the same row).
      head.classList.remove('ct-drop-hover', 'ct-drop-before', 'ct-drop-after');
      if (!ok) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch { /* noop */ }
      head.classList.add(zone === 'into' ? 'ct-drop-hover' : zone === 'before' ? 'ct-drop-before' : 'ct-drop-after');
    });
    head.addEventListener('dragleave', () => head.classList.remove('ct-drop-hover', 'ct-drop-before', 'ct-drop-after'));
    head.addEventListener('drop', (e) => {
      const zone = folderDropZone(e, head);
      head.classList.remove('ct-drop-hover', 'ct-drop-before', 'ct-drop-after');
      if (!_drag || _drag.type !== 'folder') return;
      if (zone === 'into') {
        if (!canDropFolderInto(_drag.id, f.id)) return;
        e.preventDefault();
        const res = moveFolder(_drag.id, f.id);
        if (res.ok) { _expanded.add(f.id); persistExpanded(); renderList(); }
        else surfaceDropBlock(res.reason);
      } else {
        if (!canDropAsSibling(_drag.id, f.id)) return;
        e.preventDefault();
        const res = reorderFolder(_drag.id, f.id, zone);
        if (res.ok) renderList();
        else surfaceDropBlock(res.reason);
      }
    });

    if (isOpen) {
      const body = document.createElement('div');
      body.className = 'ct-fold-body';

      // Child folders first (recurse), then chats.
      for (const child of kids) body.appendChild(renderFolderRow(child, depth + 1));

      if (!count && !kids.length) {
        body.innerHTML += `<div class="ct-fold-empty-body ${TC.t400}" style="padding-left:${6 + (depth + 1) * 8}px">${escapeHtml(t('empty_folder'))}</div>`;
      }
      for (const cid of f.chatIds) {
        body.appendChild(renderChatItem(f.id, cid, depth + 1));
      }
      row.appendChild(body);
    }
    return row;
  }

  function renderChatItem(folderId, cid, depth) {
    const meta = _chatMeta[cid] || {};
    const item = document.createElement('div');
    item.className = 'ct-fold-chat';
    item.dataset.folderId = folderId; // source folder for chat→folder move DnD
    if (depth != null) item.style.paddingLeft = `${6 + depth * 8}px`;
    item.innerHTML = `
      ${svgIcon(CHAT_PATH, 'ct-fold-chat-icon', 12)}
      <a class="ct-fold-chat-link ${TC.t300}" href="${ADAPTER.chatUrl(cid)}" title="${escapeHtml(t('open_chat'))}">${escapeHtml(meta.title || cid)}</a>
      <button class="ct-fold-chat-remove" title="${escapeHtml(t('remove_from_folder'))}" aria-label="remove">×</button>
    `;
    item.querySelector('.ct-fold-chat-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeChatFromFolder(folderId, cid);
      renderList();
    });
    return item;
  }

  // ── Search (flat results across folders + chats) ──
  function renderSearchResults(list) {
    const q = _query;
    const folders = foldersForActiveOrg();
    const matchFolders = folders.filter(f => f.name.toLowerCase().includes(q));
    const matchChats = [];
    for (const f of folders) {
      for (const cid of f.chatIds) {
        const title = (_chatMeta[cid]?.title || '').toLowerCase();
        if (title.includes(q)) matchChats.push({ folder: f, cid });
      }
    }
    if (!matchFolders.length && !matchChats.length) {
      list.innerHTML = `<div class="ct-fold-empty ${TC.t400}">${escapeHtml(t('no_results'))}</div>`;
      return;
    }
    for (const f of matchFolders) {
      const row = document.createElement('div');
      row.className = 'ct-fold-row ct-fold-search-folder ' + TC.t300;
      row.innerHTML = `${folderIconHtml(f)}<span class="ct-fold-label">${escapeHtml(f.name)}</span>`;
      // Clicking a matched folder clears search and reveals it expanded in the tree.
      row.addEventListener('click', () => { revealFolder(f.id); clearSearch(); });
      list.appendChild(row);
    }
    for (const { folder, cid } of matchChats) {
      const item = renderChatItem(folder.id, cid, null);
      const badge = document.createElement('span');
      badge.className = 'ct-fold-chat-badge ' + TC.t500;
      badge.textContent = ` ${t('in_folder')} ${folder.name}`;
      item.querySelector('.ct-fold-chat-link')?.appendChild(badge);
      list.appendChild(item);
    }
  }

  // Expand a folder and all its ancestors so it becomes visible in the tree.
  function revealFolder(id) {
    let cur = folderById(id), seen = new Set();
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); _expanded.add(cur.id); cur = cur.parent ? folderById(cur.parent) : null; }
    persistExpanded();
  }
  function clearSearch() {
    _query = '';
    const panel = document.getElementById(CT_PANEL_ID);
    const input = panel?.querySelector('.ct-fold-search');
    if (input) input.value = '';
    // Collapse the (now toggled) search box on clear so it doesn't linger empty.
    const wrap = panel?.querySelector('.ct-fold-search-wrap');
    if (wrap) wrap.style.display = 'none';
    panel?.querySelector('.ct-fold-search-btn')?.classList.remove('ct-active');
    renderList();
  }

  function toggleExpand(id) {
    if (_expanded.has(id)) _expanded.delete(id); else _expanded.add(id);
    persistExpanded();
    renderList();
  }

  // Lightweight inline menu (rename / delete / add current chat)
  function openRowMenu(f, anchorEl) {
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'ct-fold-menu';
    const inChat = !!getCurrentChatId();
    // Hard cap only disables the item; free plan gates surface an upsell on click.
    const canNestHard = folderDepth(f.id) + 1 <= MAX_NEST_DEPTH;
    menu.innerHTML = `
      <button data-act="add" ${inChat ? '' : 'disabled'}>${escapeHtml(t('add_current'))}</button>
      <button data-act="subfolder" ${canNestHard ? '' : 'disabled'}>${escapeHtml(t('add_subfolder'))}</button>
      <button data-act="move">${escapeHtml(t('move_to'))}…</button>
      <button data-act="color">${escapeHtml(t('color'))}…</button>
      <button data-act="icon">${escapeHtml(t('icon'))}…</button>
      <button data-act="rename">${escapeHtml(t('rename'))}</button>
      <button data-act="delete">${escapeHtml(t('delete'))}</button>
    `;
    menu.querySelector('[data-act="add"]').addEventListener('click', () => {
      const cid = getCurrentChatId();
      if (cid) {
        const res = addChatToFolder(f.id, cid, getCurrentChatTitle(cid));
        if (res.ok && !_expanded.has(f.id)) { _expanded.add(f.id); persistExpanded(); }
      }
      closeMenus(); renderList();
    });
    menu.querySelector('[data-act="subfolder"]').addEventListener('click', () => {
      closeMenus();
      // Check limits BEFORE prompting so we never ask for a name and then silently
      // do nothing. Free caps → clear block + upgrade offer; Pro hard cap → info.
      const roomOk = siblingCount(f.id) < childLimit();
      const depthOk = folderDepth(f.id) + 1 <= maxDepth();
      // Check depth before room to mirror createFolder()'s ordering, so when both
      // fail the surfaced message matches what the actual create would report.
      if (!depthOk) {
        // Free depth cap → upsell; Pro hitting the global hard cap → info.
        if (_plan !== 'pro') promptUpgrade('free_nest_blocked', 'subfolder');
        else window.alert(t('depth_limit'));
        return;
      }
      if (!roomOk) {
        if (_plan !== 'pro') promptUpgrade('free_sub_blocked', 'subfolder');
        else window.alert(t('sub_limit_reached'));
        return;
      }
      const name = (window.prompt(t('folder_name_ph')) || '').trim();
      if (!name) return;
      const res = createFolder(name, f.id);
      if (res.ok) { _expanded.add(f.id); persistExpanded(); renderList(); }
      else if (res.reason === 'plan_children') promptUpgrade('free_sub_blocked', 'subfolder');
      else if (res.reason === 'plan_depth') promptUpgrade('free_nest_blocked', 'subfolder');
      else if (res.reason === 'depth') window.alert(t('depth_limit'));
      else if (res.reason === 'limit') window.alert(t('sub_limit_reached'));
    });
    menu.querySelector('[data-act="move"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openMoveMenu(f, anchorEl);
    });
    menu.querySelector('[data-act="color"]').addEventListener('click', (e) => {
      e.stopPropagation();
      // Color is Pro. Free users get the upsell instead of the picker (colors already set
      // still render — only changing them is gated).
      if (_plan !== 'pro') { closeMenus(); promptUpgrade('free_color_blocked', 'color'); return; }
      openColorMenu(f, anchorEl);
    });
    menu.querySelector('[data-act="icon"]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (_plan !== 'pro') { closeMenus(); promptUpgrade('free_icon_blocked', 'icon'); return; }
      openIconMenu(f, anchorEl);
    });
    menu.querySelector('[data-act="rename"]').addEventListener('click', () => {
      closeMenus();
      startRename(f);
    });
    menu.querySelector('[data-act="delete"]').addEventListener('click', () => {
      closeMenus();
      if (confirm(t('delete_confirm'))) { deleteFolder(f.id); renderList(); }
    });
    positionMenu(menu, anchorEl);
  }

  // Submenu: pick a new parent (root or any non-descendant folder within depth).
  function openMoveMenu(f, anchorEl) {
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'ct-fold-menu';
    const banned = descendantIds(f.id); banned.add(f.id);
    const height = subtreeHeight(f.id);
    const curParent = f.parent || null;
    // Only exclude STRUCTURALLY impossible destinations (self/descendant/current
    // parent, or a subtree that can't fit even for Pro). Free-plan caps are NOT
    // filtered here — those targets stay visible and, on click, show a clear block +
    // upgrade offer instead of silently disappearing.
    const fitsHard = (parentId) => {
      const base = parentId ? folderDepth(parentId) + 1 : 0;
      return base + height <= MAX_NEST_DEPTH;
    };
    const opts = [];
    if (curParent !== null && fitsHard(null)) opts.push({ id: null, name: t('move_to_root') });
    for (const x of foldersForActiveOrg()) {
      if (banned.has(x.id) || x.id === curParent) continue;
      if (fitsHard(x.id)) opts.push({ id: x.id, name: x.name });
    }
    menu.innerHTML = opts.map(o => `<button data-target="${o.id == null ? '' : escapeHtml(o.id)}">${escapeHtml(o.name)}</button>`).join('') || `<button disabled>${escapeHtml(t('no_results'))}</button>`;
    menu.querySelectorAll('button[data-target]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-target') || null;
        const res = moveFolder(f.id, target);
        closeMenus();
        if (res.ok) { if (target) _expanded.add(target); persistExpanded(); renderList(); }
        else if (res.reason === 'plan_children') promptUpgrade('free_sub_blocked', 'move');
        else if (res.reason === 'plan_depth') promptUpgrade('free_nest_blocked', 'move');
        else if (res.reason === 'limit') promptUpgrade('free_root_blocked', 'move');
        else if (res.reason === 'depth') window.alert(t('depth_limit'));
        // noop/self/descendant or a stale menu (folder changed/deleted since it
        // opened): re-render the tree so the action never silently does nothing.
        else renderList();
      });
    });
    positionMenu(menu, anchorEl);
  }

  // Submenu: pick a folder color from the palette (or clear it). Pro-gated at the caller.
  function openColorMenu(f, anchorEl) {
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'ct-fold-menu ct-fold-color-menu';
    const swatches = FOLDER_COLORS.map(c =>
      `<button class="ct-fold-swatch${f.color === c ? ' sel' : ''}" data-color="${c}" style="background:${c}" title="${c}" aria-label="${c}"></button>`).join('');
    menu.innerHTML = `<div class="ct-fold-swatch-grid">${swatches}</div>` +
      `<button class="ct-fold-color-none" data-color="">${escapeHtml(t('color_none'))}</button>`;
    menu.querySelectorAll('[data-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        const c = btn.getAttribute('data-color') || null;
        // Re-check Pro at click time — entitlement can change while the picker is open.
        // Clearing (null) is always allowed; setting a color requires Pro.
        if (c && _plan !== 'pro') { closeMenus(); promptUpgrade('free_color_blocked', 'color'); return; }
        setFolderColor(f.id, c);
        closeMenus();
        renderList();
      });
    });
    positionMenu(menu, anchorEl);
  }

  // Submenu: pick a folder emoji icon from the curated grid (or clear it). Pro-gated at caller.
  function openIconMenu(f, anchorEl) {
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'ct-fold-menu ct-fold-icon-menu';
    const glyphs = EMOJI_CHOICES.map(g =>
      `<button class="ct-fold-emoji${f.icon === g ? ' sel' : ''}" data-icon="${g}" title="${g}" aria-label="${g}">${g}</button>`).join('');
    menu.innerHTML = `<div class="ct-fold-emoji-grid">${glyphs}</div>` +
      `<button class="ct-fold-color-none" data-icon="">${escapeHtml(t('color_none'))}</button>`;
    menu.querySelectorAll('[data-icon]').forEach(btn => {
      btn.addEventListener('click', () => {
        const g = btn.getAttribute('data-icon') || null;
        // Re-check Pro at click time (entitlement may change while the picker is open).
        // Clearing (null) is always allowed; setting an icon requires Pro.
        if (g && _plan !== 'pro') { closeMenus(); promptUpgrade('free_icon_blocked', 'icon'); return; }
        setFolderIcon(f.id, g);
        closeMenus();
        renderList();
      });
    });
    positionMenu(menu, anchorEl);
  }

  // Header menu: choose the sibling sort mode (manual / recent / name). Pins always stay on top.
  function openSortMenu(anchorEl) {
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'ct-fold-menu';
    menu.innerHTML = SORT_MODES.map(m =>
      `<button data-sort="${m}">${_sortMode === m ? '✓ ' : ''}${escapeHtml(t('sort_' + m))}</button>`).join('');
    menu.querySelectorAll('[data-sort]').forEach(btn => {
      btn.addEventListener('click', () => { setSortMode(btn.getAttribute('data-sort')); closeMenus(); });
    });
    positionMenu(menu, anchorEl);
  }

  // Header menu: backup actions (export to JSON / import-restore from a file).
  function openPanelMenu(anchorEl, importInput) {
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'ct-fold-menu';
    menu.innerHTML =
      `<button data-act="export">${escapeHtml(t('export'))}</button>` +
      `<button data-act="import">${escapeHtml(t('import'))}</button>`;
    menu.querySelector('[data-act="export"]').addEventListener('click', () => { closeMenus(); exportFolders(); });
    menu.querySelector('[data-act="import"]').addEventListener('click', () => { closeMenus(); if (importInput) importInput.click(); });
    positionMenu(menu, anchorEl);
  }

  function positionMenu(menu, anchorEl) {
    if (isDark()) menu.classList.add('ct-dark');
    document.body.appendChild(menu);
    const r = anchorEl.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.left = `${Math.round(Math.min(r.left, window.innerWidth - 200))}px`;
    setTimeout(() => document.addEventListener('click', closeMenusOnce, { once: true }), 0);
  }
  function closeMenusOnce() { closeMenus(); }
  function closeMenus() {
    document.querySelectorAll('.ct-fold-menu').forEach(m => m.remove());
  }
  function openUpgrade(src) {
    window.open(`${SITE_URL}/dashboard/?upgrade=folders&utm_source=${encodeURIComponent(src)}`, '_blank', 'noopener');
  }
  // Free-plan block: explain clearly why the action is blocked, then offer upgrade.
  // The action is always prevented (nothing is created/moved) — this only asks
  // whether to open the upgrade page.
  function promptUpgrade(reasonKey, src) {
    if (window.confirm(`${t(reasonKey)}\n\n${t('upgrade_q')}`)) openUpgrade(src);
  }

  function startRename(f) {
    const row = document.querySelector(`.ct-fold-item[data-folder-id="${f.id}"] .ct-fold-row`);
    if (!row) return;
    const label = row.querySelector('.ct-fold-label');
    if (!label) return;
    // Disable row drag while editing so text selection in the input isn't hijacked
    // as a folder drag (renderList restores draggable=true on commit/escape).
    row.draggable = false;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ct-fold-rename-input';
    input.maxLength = MAX_NAME_LENGTH;
    input.value = f.name;
    label.replaceWith(input);
    input.focus(); input.select();
    const commit = () => { renameFolder(f.id, input.value); renderList(); };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      else if (e.key === 'Escape') renderList();
    });
    input.addEventListener('blur', commit);
  }

  function wireAddForm() {
    const panel = document.getElementById(CT_PANEL_ID);
    if (!panel) return;
    const addBtn = panel.querySelector('.ct-fold-add-btn');
    const form = panel.querySelector('.ct-fold-add-form');
    const input = panel.querySelector('.ct-fold-name-input');
    if (!addBtn || !form || !input) return;

    addBtn.addEventListener('click', () => {
      if (addBtn.disabled) return;
      const showing = form.style.display !== 'none';
      form.style.display = showing ? 'none' : '';
      if (!showing) { input.value = ''; input.focus(); }
    });
    const sortBtn = panel.querySelector('.ct-fold-sort-btn');
    if (sortBtn) sortBtn.addEventListener('click', (e) => { e.stopPropagation(); openSortMenu(sortBtn); });
    const moreBtn = panel.querySelector('.ct-fold-more-btn');
    const importInput = panel.querySelector('.ct-fold-import-input');
    if (moreBtn) moreBtn.addEventListener('click', (e) => { e.stopPropagation(); openPanelMenu(moreBtn, importInput); });
    if (importInput) importInput.addEventListener('change', () => {
      const file = importInput.files && importInput.files[0];
      if (file) importFolders(file);
      importInput.value = ''; // allow re-importing the same file
    });
    const submit = () => {
      const res = createFolder(input.value);
      if (res.ok) { input.value = ''; form.style.display = 'none'; renderList(); }
      else if (res.reason === 'limit') { renderList(); form.style.display = 'none'; }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      else if (e.key === 'Escape') { form.style.display = 'none'; }
    });

    // Search: collapsed by default, toggled by the header 🔍 button (saves a full row of
    // space). Hiding clears the active query so a hidden search never silently filters.
    const search = panel.querySelector('.ct-fold-search');
    const searchWrap = panel.querySelector('.ct-fold-search-wrap');
    const searchBtn = panel.querySelector('.ct-fold-search-btn');
    let searchDebounce = null; // hoisted so showSearch(false) can cancel a pending filter
    const showSearch = (show) => {
      if (!searchWrap) return;
      searchWrap.style.display = show ? '' : 'none';
      if (searchBtn) searchBtn.classList.toggle('ct-active', show);
      if (show) { if (search) { search.value = _query; search.focus(); } return; }
      // Closing: cancel any pending debounce and fully reset, so a box hidden mid-type never
      // ends up silently filtering (typed then closed within the 150ms debounce window).
      if (searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null; }
      if (search) search.value = '';
      if (_query) { _query = ''; renderList(); }
    };
    if (searchBtn) searchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showSearch(!searchWrap || searchWrap.style.display === 'none');
    });
    if (search) {
      search.value = _query;
      // Keep the box open (and focused) if a query survived a re-mount.
      if (_query && searchWrap) { searchWrap.style.display = ''; if (searchBtn) searchBtn.classList.add('ct-active'); search.focus(); }
      search.addEventListener('input', () => {
        if (searchDebounce) clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
          _query = search.value.trim().toLowerCase();
          if (_dragging) return; // don't rebuild rows mid-drag; onDocDragEnd renders
          renderList();
        }, 150);
      });
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { showSearch(false); }
      });
    }
  }

  // ── Move-to-folder top-bar button + modal (competitor-style quick add) ──
  // A free feature: injects a button into Claude's conversation top bar (left of
  // Share) that opens a folder picker to add the CURRENT chat to a folder.
  const MTF_BTN_ID = 'ct-mtf-btn';
  const MTF_OVERLAY_ID = 'ct-mtf-overlay';
  let _mtfKeydown = null;

  // Inject the top-bar button. Runs on the mount cadence (ensureMounted) so it
  // re-injects after Claude re-renders the top bar / on chat navigation.
  function injectMoveButton() {
    if (!_enabled) { removeMoveButton(); return; } // feature off: never (re)inject
    // Provider top-bar container (Claude only for v1; adapters without it — e.g.
    // ChatGPT — simply never inject the top-bar button, panel DnD still works).
    const box = ADAPTER.findMoveButtonBox ? ADAPTER.findMoveButtonBox() : null;
    if (!box) return;
    // Not on a chat page (e.g. /new): drop any stale button so it doesn't linger.
    if (!getCurrentChatId()) { removeMoveButton(); return; }
    const existing = document.getElementById(MTF_BTN_ID);
    if (existing) {
      // Claude's SPA rerender can leave our button inside an orphaned OLD
      // actions container while a NEW one becomes the visible top bar. Only
      // skip if it's already parented to the CURRENT box; otherwise the old
      // container's copy is stale — drop it and re-inject into the live one.
      if (existing.parentElement === box) return;
      existing.remove();
    }
    const btn = document.createElement('button');
    btn.id = MTF_BTN_ID;
    btn.type = 'button';
    btn.className = 'ct-mtf-btn';
    btn.title = t('move_to_folder');
    btn.innerHTML = `<span class="ct-mtf-btn-icon">📁</span><span class="ct-mtf-btn-label">${escapeHtml(t('move_to_folder'))}</span>`;
    btn.addEventListener('click', (e) => {
      // Keep Claude's toolbar handlers from firing when our button is clicked.
      e.stopPropagation();
      e.preventDefault();
      openMoveToFolderModal();
    });
    box.insertBefore(btn, box.firstChild); // FIRST child = left of Share
  }

  // Remove the top-bar button and any open picker modal. Shared by unmount()
  // (feature disabled) and teardown() (context dead) so neither leaves the
  // button/modal alive to mutate folders after the feature is off.
  function removeMoveButton() {
    const btn = document.getElementById(MTF_BTN_ID);
    if (btn) btn.remove();
    closeMoveModal();
  }

  // Tear down the modal + its Escape listener (no leak). Idempotent.
  function closeMoveModal() {
    const ov = document.getElementById(MTF_OVERLAY_ID);
    if (ov) ov.remove();
    if (_mtfKeydown) { document.removeEventListener('keydown', _mtfKeydown); _mtfKeydown = null; }
  }

  // Brief, self-dismissing confirmation after a one-shot add.
  function showMtfToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'ct-mtf-toast';
    if (isDark()) toast.classList.add('ct-dark');
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => { try { toast.remove(); } catch { /* noop */ } }, 2200);
  }

  function openMoveToFolderModal() {
    closeMoveModal(); // only one modal at a time
    const chatId = getCurrentChatId();
    if (!chatId) return;
    const overlay = document.createElement('div');
    overlay.id = MTF_OVERLAY_ID;
    overlay.className = 'ct-mtf-overlay';
    const modal = document.createElement('div');
    modal.className = 'ct-mtf-modal';
    if (isDark()) modal.classList.add('ct-dark');
    modal.innerHTML = `
      <div class="ct-mtf-head">
        <span class="ct-mtf-title">${escapeHtml(t('mtf_title'))}</span>
        <button class="ct-mtf-close" type="button" aria-label="close">×</button>
      </div>
      <input type="search" class="ct-mtf-search" placeholder="${escapeHtml(t('mtf_search'))}" />
      <div class="ct-mtf-list"></div>
    `;
    const listEl = modal.querySelector('.ct-mtf-list');
    const searchEl = modal.querySelector('.ct-mtf-search');

    // Render folders as a nested, indented, clickable list (roots → children).
    function renderRows(query) {
      const q = (query || '').trim().toLowerCase();
      listEl.innerHTML = '';
      if (foldersForActiveOrg().length === 0) {
        listEl.innerHTML = `<div class="ct-mtf-empty">${escapeHtml(t('mtf_empty'))}</div>`;
        return;
      }
      let shown = 0;
      const walk = (parentId, depth) => {
        for (const f of childrenOf(parentId)) {
          if (!q || f.name.toLowerCase().includes(q)) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'ct-mtf-row';
            row.style.paddingLeft = `${10 + depth * 10}px`;
            row.innerHTML = `${folderIconHtml(f)}<span class="ct-mtf-row-name">${escapeHtml(f.name)}</span>`;
            row.addEventListener('click', () => {
              const cid = getCurrentChatId();
              const res = addChatToFolder(f.id, cid, getCurrentChatTitle(cid));
              closeMoveModal();
              if (res && res.ok) {
                showMtfToast(t('mtf_added'));
                if (_mounted) renderList(); // reflect the new chat in the sidebar panel
              } else if (res && res.reason === 'dup') {
                showMtfToast(t('mtf_dup'));
              }
            });
            listEl.appendChild(row);
            shown++;
          }
          walk(f.id, depth + 1);
        }
      };
      walk(null, 0);
      if (q && shown === 0) {
        listEl.innerHTML = `<div class="ct-mtf-empty">${escapeHtml(t('no_results'))}</div>`;
      }
    }
    renderRows('');
    searchEl.addEventListener('input', () => renderRows(searchEl.value));

    modal.querySelector('.ct-mtf-close').addEventListener('click', closeMoveModal);
    modal.addEventListener('click', (e) => e.stopPropagation());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeMoveModal(); });
    _mtfKeydown = (e) => { if (e.key === 'Escape') closeMoveModal(); };
    document.addEventListener('keydown', _mtfKeydown);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    searchEl.focus();
  }

  // ── Mount / unmount ──
  function mount() {
    if (document.getElementById(CT_PANEL_ID)) { _mounted = true; return; }
    const anchor = findSidebarAnchor();
    if (!anchor) { _mounted = false; return; }
    const panel = buildPanel();
    if (anchor.ref) anchor.parent.insertBefore(panel, anchor.ref);
    else anchor.parent.prepend(panel);
    wireAddForm();
    renderList();
    _mounted = true;
  }
  function unmount() {
    const el = document.getElementById(CT_PANEL_ID);
    if (el) el.remove();
    closeMenus();
    removeMoveButton(); // feature disabled: drop the top-bar button + any open modal too
    _mounted = false;
  }
  function ensureMounted() {
    if (!isContextValid()) return; // stale instance after extension reload
    maybeRefreshFlag(); // cheap: at most one CDN flag check per TTL; flips _available
    if (!_enabled) { unmount(); return; }
    if (!document.getElementById(CT_PANEL_ID)) _mounted = false;
    if (!_mounted) mount();
    injectMoveButton(); // re-inject the top-bar button after Claude re-renders
  }

  // ── Teardown (extension reload / context invalidation) ──
  // Once the runtime context is dead, stop all recurring work and drop transient
  // UI so a zombie instance doesn't keep observing/looping. A fresh content-script
  // instance (from the reloaded extension) will take over the DOM.
  let _dead = false;
  function teardown() {
    if (_dead) return;
    _dead = true;
    if (_observer) { try { _observer.disconnect(); } catch { /* noop */ } _observer = null; }
    for (const id of _intervals) { try { clearInterval(id); } catch { /* noop */ } }
    _intervals = [];
    unwireDragAndDrop();
    closeMenus();
    removeMoveButton(); // also covered by unmount() below, but explicit here for clarity
    unmount();
  }

  // ── Main loop + observer (mirror sidebar-usage.js resilience) ──
  let _lastMountCheck = 0;
  function tick() {
    if (_dead) return;
    try {
      if (!isContextValid()) { teardown(); return; } // stop rescheduling RAF
      const now = Date.now();
      if (now - _lastMountCheck >= MOUNT_INTERVAL_MS) {
        _lastMountCheck = now;
        ensureMounted();
      }
    } catch { /* never kill the loop */ }
    requestAnimationFrame(tick);
  }
  function startObserver() {
    if (_observer) return;
    _observer = new MutationObserver(() => {
      if (_dead) return;
      if (!isContextValid()) { teardown(); return; }
      if (!_enabled) return;
      if (_dragging) return; // never remount mid-drag — the drop target must persist
      if (!document.getElementById(CT_PANEL_ID)) { _mounted = false; mount(); }
    });
    _observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Drag-and-drop ──
  // Folder → folder uses native HTML5 drag (below). Chat → folder uses the pointer
  // drag further down (Claude conversation links navigate on press, killing native
  // drag before it reaches a folder).
  function clearDropHover() {
    document.querySelectorAll('.ct-drop-hover, .ct-drop-before, .ct-drop-after')
      .forEach(el => el.classList.remove('ct-drop-hover', 'ct-drop-before', 'ct-drop-after'));
    document.querySelectorAll('.ct-dragging').forEach(el => el.classList.remove('ct-dragging'));
  }
  // Which part of a folder row a folder-drag is over: top 30% = insert before (reorder),
  // bottom 30% = after, middle = into (reparent). Reorder zones let a folder be positioned
  // among siblings instead of only nested inside another folder.
  function folderDropZone(e, el) {
    const r = el.getBoundingClientRect();
    if (r.height <= 0) return 'into';
    const y = e.clientY - r.top;
    if (y < r.height * 0.3) return 'before';
    if (y > r.height * 0.7) return 'after';
    return 'into';
  }
  function onDocDragStart(e) {
    if (_dead) return;
    // (Row-control presses are guarded at mousedown by toggling head.draggable — the
    // dragstart target is the draggable row itself, not the inner button, so a closest()
    // check here would miss it.)
    // Folder-row drag (reparent) — originates on a draggable folder row in our panel.
    const foldRow = e.target?.closest?.(`#${CT_PANEL_ID} .ct-fold-row[data-folder-id]`);
    if (!foldRow) return;
    const id = foldRow.getAttribute('data-folder-id');
    if (!id) return;
    _drag = { type: 'folder', id };
    _dragging = true;
    foldRow.classList.add('ct-dragging');
    try { e.dataTransfer.effectAllowed = 'move'; } catch { /* noop */ }
  }
  function onDocDragEnd() {
    const wasDragging = _dragging;
    _drag = null;
    _dragging = false;
    clearDropHover();
    // Settle the tree once after the drag ends (the drop handler already rendered on
    // a successful drop; this covers a cancelled drag and keeps state consistent).
    if (wasDragging && !_dead) renderList();
  }

  // ── Pointer drag: Claude conversation link → folder ──
  // Native drag can't be used for Claude's sidebar conversation links: they're
  // button-styled and Claude navigates to the conversation on press, aborting the
  // native drag before it can reach a folder. So we run our own pointer-based drag.
  function createDragGhost(title) {
    const g = document.createElement('div');
    g.className = 'ct-drag-ghost';
    if (isDark()) g.classList.add('ct-dark');
    g.textContent = title || t('open_chat');
    return g;
  }
  // Prevent the click/navigation that Claude fires after a drag gesture. Scoped to the
  // dragged link so an unrelated click elsewhere in the 400ms window still goes through.
  function suppressNextClick(link) {
    const handler = (ev) => {
      if (link && ev.target !== link && !link.contains(ev.target)) return; // not our link
      ev.preventDefault();
      ev.stopPropagation();
      document.removeEventListener('click', handler, true);
    };
    document.addEventListener('click', handler, true);
    // Fallback: drop the guard shortly after in case no click ever fires.
    setTimeout(() => document.removeEventListener('click', handler, true), 400);
  }
  function ptrHoverRow(x, y) {
    const el = document.elementFromPoint(x, y);
    const row = el?.closest?.(`#${CT_PANEL_ID} .ct-fold-row[data-folder-id]`) || null;
    if (row === _ptr.targetRow) return;
    if (_ptr.targetRow) _ptr.targetRow.classList.remove('ct-drop-hover');
    _ptr.targetRow = row;
    if (row) row.classList.add('ct-drop-hover');
  }
  function onDocPointerDown(e) {
    if (_dead || _ptr || e.button !== 0 || !e.isPrimary) return; // primary pointer only
    const link = e.target?.closest?.(ADAPTER.getChatLinkSelector());
    if (!link) return;
    // Two sources: a Claude sidebar link (import into a folder) OR one of our own folded
    // chat links (move it to another folder). srcFolderId != null => move, else import.
    let srcFolderId = null;
    if (link.closest(`#${CT_PANEL_ID}`)) {
      const chatEl = link.closest('.ct-fold-chat[data-folder-id]');
      if (!chatEl) return; // some other panel link (not a folded chat) — ignore
      srcFolderId = chatEl.getAttribute('data-folder-id');
    }
    const chatId = ADAPTER.chatIdFromHref(link.getAttribute('href') || '');
    if (!chatId) return;
    // Disable the link's native drag for this gesture so it can't compete with ours.
    _ptr = {
      chatId,
      title: (link.textContent || '').trim().slice(0, 120),
      srcFolderId,
      startX: e.clientX, startY: e.clientY,
      dragging: false, ghost: null, targetRow: null,
      link, prevDraggable: link.getAttribute('draggable'),
      pointerId: e.pointerId,
    };
    link.setAttribute('draggable', 'false');
    document.addEventListener('pointermove', onDocPointerMove, true);
    document.addEventListener('pointerup', onDocPointerUp, true);
    document.addEventListener('pointercancel', onDocPointerCancel, true);
    document.addEventListener('keydown', onDocPointerKey, true);
  }
  function onDocPointerMove(e) {
    if (!_ptr || e.pointerId !== _ptr.pointerId) return;
    if (!_ptr.dragging) {
      if (Math.hypot(e.clientX - _ptr.startX, e.clientY - _ptr.startY) < PTR_DRAG_THRESHOLD) return;
      _ptr.dragging = true;
      _dragging = true; // suppress re-render/remount so drop targets persist
      _ptr.ghost = createDragGhost(_ptr.title);
      document.body.appendChild(_ptr.ghost);
      document.body.classList.add('ct-ptr-dragging');
    }
    e.preventDefault(); // suppress text selection / scroll while dragging
    _ptr.ghost.style.left = `${e.clientX + 12}px`;
    _ptr.ghost.style.top = `${e.clientY + 12}px`;
    ptrHoverRow(e.clientX, e.clientY);
  }
  function endPtrDrag(commit) {
    const ptr = _ptr;
    if (!ptr) return;
    // Restore the link's native draggable state (best-effort; Claude may re-render it).
    try {
      if (ptr.prevDraggable == null) ptr.link.removeAttribute('draggable');
      else ptr.link.setAttribute('draggable', ptr.prevDraggable);
    } catch { /* link gone */ }
    document.removeEventListener('pointermove', onDocPointerMove, true);
    document.removeEventListener('pointerup', onDocPointerUp, true);
    document.removeEventListener('pointercancel', onDocPointerCancel, true);
    document.removeEventListener('keydown', onDocPointerKey, true);
    if (ptr.ghost) ptr.ghost.remove();
    if (ptr.targetRow) ptr.targetRow.classList.remove('ct-drop-hover');
    document.body.classList.remove('ct-ptr-dragging');
    const wasDragging = ptr.dragging;
    const targetRow = ptr.targetRow;
    _ptr = null;
    _dragging = false;
    if (!wasDragging) return; // was a plain click → let Claude navigate normally
    suppressNextClick(ptr.link); // we dragged → cancel the click/navigation that follows
    if (commit && targetRow) {
      const folderId = targetRow.getAttribute('data-folder-id');
      if (folderId && ptr.srcFolderId) {
        // Move a folded chat between folders (no-op when dropped on its own folder).
        // Add to the target FIRST; only remove from the source once the chat is safely in
        // the target (or already there) — so a failed add never loses the chat.
        if (folderId !== ptr.srcFolderId) {
          const res = addChatToFolder(folderId, ptr.chatId, ptr.title || getCurrentChatTitle(ptr.chatId));
          if (res.ok || res.reason === 'dup') {
            removeChatFromFolder(ptr.srcFolderId, ptr.chatId);
            if (!_expanded.has(folderId)) { _expanded.add(folderId); persistExpanded(); }
          }
        }
      } else if (folderId) {
        // Import a chat from Claude's sidebar into a folder (original behavior).
        const res = addChatToFolder(folderId, ptr.chatId, ptr.title || getCurrentChatTitle(ptr.chatId));
        if (res.ok && !_expanded.has(folderId)) { _expanded.add(folderId); persistExpanded(); }
      }
    }
    renderList();
  }
  function onDocPointerUp(e) {
    if (_ptr && e.pointerId !== _ptr.pointerId) return;
    // If we actually dragged, swallow this pointerup so Claude's own handler can't
    // navigate to the conversation (belt-and-suspenders with suppressNextClick).
    if (_ptr?.dragging) { e.preventDefault(); e.stopPropagation(); }
    endPtrDrag(true);
  }
  function onDocPointerCancel(e) {
    if (_ptr && e.pointerId !== _ptr.pointerId) return;
    endPtrDrag(false);
  }
  function onDocPointerKey(e) { if (e.key === 'Escape') endPtrDrag(false); }

  function wireDragAndDrop() {
    // Capture phase so we see the drag before it bubbles through Claude's handlers.
    document.addEventListener('dragstart', onDocDragStart, true);
    document.addEventListener('dragend', onDocDragEnd, true);
    document.addEventListener('pointerdown', onDocPointerDown, true);
  }
  function unwireDragAndDrop() {
    document.removeEventListener('dragstart', onDocDragStart, true);
    document.removeEventListener('dragend', onDocDragEnd, true);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    endPtrDrag(false); // tear down any in-flight pointer drag + its listeners
  }

  // ── Server sync (M3, Pro-gated, whole-store LWW via background) ──
  // The content script has NO host_permissions, so it never fetches the API
  // directly — every pull/push is a chrome.runtime message to the background
  // service worker, which holds the ext_token + API host permission. Best-effort:
  // local operation never blocks on sync.
  //
  // Store "version" = the monotonic _storeUpdatedAt counter (persisted). NOT
  // raw Date.now() — a device with a fast/skewed clock could otherwise push a
  // future timestamp that the server (and every other device) can never beat,
  // producing a perpetual 409 conflict loop. The counter only ever moves
  // forward: +1 (at least) past its own previous value on every local mutation,
  // and up to (never down to) an adopted server version.
  function storeVersion() {
    return _storeUpdatedAt;
  }
  // Bootstrap guard: an existing user with pre-sync local folders has no
  // persisted SYNC_VERSION_KEY, so _storeUpdatedAt loads as 0. Without this seed,
  // their first push would go out as updatedAt:0; a second (empty) device also
  // at 0 would then neither adopt it (0 is not > 0) nor get its own push blocked
  // (0 is not < 0) — silently overwriting the populated store with an empty one.
  // Seeding the version to at least the newest folder's updatedAt makes a
  // populated store push with a real, non-zero version, so an empty device at 0
  // always adopts it instead of racing to overwrite it. Runs ONCE at init, after
  // both the folder store and the persisted version are loaded, and strictly
  // before the first pullStore()/scheduleSync().
  function seedSyncVersion() {
    const maxFolderUpdatedAt = _folders.reduce((mx, f) => {
      const v = Number(f.updatedAt) || 0;
      return v > mx ? v : mx;
    }, 0);
    const seeded = Math.max(_storeUpdatedAt, maxFolderUpdatedAt);
    if (seeded > _storeUpdatedAt) {
      _storeUpdatedAt = seeded;
      persistSyncVersion();
    }
  }
  // Replace the whole local store with a server blob (LWW: server won). The blob
  // is validated through the SAME sanitize path as an imported file — a server
  // blob is never trusted more than an untrusted backup file. Also caps the
  // adopted folder count at MAX_IMPORT_FOLDERS (same guard as a local restore) so
  // a huge/corrupt server blob can't force thousands of folders through
  // sanitize/render/storage.
  function adoptServerStore(store) {
    if (!store || typeof store !== 'object') return;
    let rawFolders = Array.isArray(store.folders) ? store.folders : [];
    if (rawFolders.length > MAX_IMPORT_FOLDERS) rawFolders = rawFolders.slice(0, MAX_IMPORT_FOLDERS);
    const folders = rawFolders.map(sanitizeImportedFolder).filter(Boolean);
    const chatMeta = sanitizeImportedChatMeta(store.chatMeta);
    const incoming = Number(store.updatedAt) || 0;
    // Never move the counter backward, even for a future/skewed incoming version.
    const version = Math.max(_storeUpdatedAt, incoming);
    try {
      // Direct storage write (NOT persistFolders) so adoption never re-schedules a
      // push and ping-pongs with the server.
      chrome.storage.local.set({ [FOLDERS_KEY]: folders, [CHAT_META_KEY]: chatMeta, [SYNC_VERSION_KEY]: version }, () => {
        if (chrome.runtime.lastError) return;
        _folders = folders; _chatMeta = chatMeta; _storeUpdatedAt = version;
        if (!_dragging) renderList();
      });
    } catch { /* context dead */ }
  }
  // Push the whole local store. On 409 the server copy was newer → adopt it.
  // On 403 (not Pro) / 404 (flag off) disable sync for the session.
  function pushStore() {
    if (!_enabled || _syncDisabled || _plan !== 'pro' || !isContextValid()) return;
    const store = { updatedAt: storeVersion(), folders: _folders, chatMeta: _chatMeta };
    try {
      chrome.runtime.sendMessage({ type: 'ct_folders_push', store }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        if (res.ok) return;
        if (res.conflict && res.store) { adoptServerStore(res.store); return; }
        if (res.status === 403 || res.status === 404) _syncDisabled = true;
      });
    } catch { /* context dead */ }
  }
  // Debounced push after any mutation. Strictly increments the monotonic version
  // (never just Date.now() — see storeVersion) so deletions (which bump no
  // folder.updatedAt) still move the store version forward, and persists it so a
  // reload doesn't lose the counter.
  function scheduleSync() {
    if (!_enabled || _syncDisabled || _plan !== 'pro') return;
    _storeUpdatedAt = Math.max(_storeUpdatedAt + 1, Date.now());
    persistSyncVersion();
    if (_syncTimer) clearTimeout(_syncTimer);
    _syncTimer = setTimeout(() => { _syncTimer = null; pushStore(); }, SYNC_DEBOUNCE_MS);
  }
  // Initial/periodic reconcile: pull the server store; adopt if strictly newer,
  // otherwise push local (seeds an empty server or refreshes a stale one).
  function pullStore() {
    if (!_enabled || _syncDisabled || _plan !== 'pro' || !isContextValid()) return;
    // Coalesce overlapping calls into one: init's refreshEntitlement() (gated false
    // at that point) and applyAvailability()'s transition-to-enabled refreshEntitlement()
    // can both resolve close together — without this guard both could reach here once
    // _enabled flips true, firing two pulls.
    if (_pulling) return;
    _pulling = true;
    try {
      chrome.runtime.sendMessage({ type: 'ct_folders_pull' }, (res) => {
        _pulling = false;
        if (chrome.runtime.lastError || !res) return;
        if (!res.ok) { if (res.status === 403 || res.status === 404) _syncDisabled = true; return; }
        const server = res.store;
        if (server && Number.isFinite(server.updatedAt) && server.updatedAt > storeVersion()) {
          adoptServerStore(server);
        } else {
          pushStore();
        }
      });
    } catch {
      _pulling = false; // context dead — reset so a future pull isn't permanently blocked
    }
  }

  // ── Entitlement ──
  function refreshEntitlement() {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage({ type: 'GET_ENTITLEMENT' }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        const next = res.plan === 'pro' ? 'pro' : 'free';
        if (next !== _plan) { _plan = next; if (!_dragging) renderList(); }
        // Reconcile with the server once entitlement resolves to Pro (fires on init
        // and each 6h re-check → multi-device convergence). Gated on _enabled so a
        // dark/user-disabled feature never touches /api/folders (pullStore()
        // re-checks _enabled too; the guard is duplicated here for clarity).
        if (_enabled && _plan === 'pro') pullStore();
      });
    } catch { /* context dead */ }
  }

  // ── Feature availability (CDN dark-launch flag) ──
  // Promisified storage.local access for the cached flag; resolve null on any
  // error so a storage hiccup just falls through to a fetch (mirrors the
  // announcements cache in usage-shared.js).
  function _getFoldersFlagCache() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(FOLDERS_FLAG_CACHE_KEY, (o) => {
          if (chrome.runtime?.lastError) return resolve(null);
          resolve((o && o[FOLDERS_FLAG_CACHE_KEY]) || null);
        });
      } catch { resolve(null); }
    });
  }
  function _setFoldersFlagCache(folders) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [FOLDERS_FLAG_CACHE_KEY]: { at: Date.now(), folders: folders === true } }, () => resolve());
      } catch { resolve(); }
    });
  }
  // Fetch the folders availability flag. Serves from the TTL cache while fresh;
  // on a miss, fetches the static CDN flags.json (CORS, never the Worker) and
  // parses `{ folders: boolean }`. FAIL-SAFE: any fetch/parse error, non-200,
  // 404, or missing/invalid `folders` field → false (dark). NEVER throws.
  async function fetchFolderAvailable() {
    try {
      const cached = await _getFoldersFlagCache();
      if (cached && typeof cached.folders === 'boolean' &&
          (Date.now() - (cached.at || 0)) < FOLDERS_FLAG_TTL_MS) {
        return cached.folders === true;
      }
      const res = await fetch(FLAGS_URL);
      if (!res.ok) { await _setFoldersFlagCache(false); return false; }
      const json = await res.json();
      const folders = !!(json && json[ADAPTER.flagField] === true);
      await _setFoldersFlagCache(folders);
      return folders;
    } catch {
      return false; // network/parse error → dark, don't poison the cache
    }
  }
  // Persist the current availability to storage.local so options.js can read it
  // without its own CDN fetch. Best-effort; never throws.
  function persistFoldersAvailable(val) {
    try { chrome.storage.local.set({ [FOLDERS_AVAILABLE_KEY]: val === true }); } catch { /* noop */ }
  }
  // Effective gate = CDN says available AND the user hasn't turned it off.
  function recomputeEnabled() {
    _enabled = _available === true && _userPref === true;
    if (_enabled) {
      ensureMounted();          // available + on → mount (RAF tick also covers this)
    } else {
      unmount();                // dark or user-off → tear the UI down …
      removeMoveButton();       // … and drop the top-bar button explicitly
    }
  }
  // Apply a freshly-resolved availability value: persist it, and mount/unmount on
  // a transition. Persist every time so options.js always has the latest state.
  function applyAvailability(avail) {
    const next = avail === true;
    const changed = next !== _available;
    _available = next;
    persistFoldersAvailable(next);
    if (changed) {
      recomputeEnabled();
      // Only trigger the entitlement/pull path on the transition INTO enabled —
      // on a dark start (_available stays false) nothing here ever runs, so a
      // Pro user with folders dark does zero /api/folders network. refreshEntitlement()
      // re-gates its own pullStore() call on _enabled, so this is safe even if
      // _userPref flips false again before the response lands.
      if (_enabled) refreshEntitlement();
    }
  }
  // Cheap cadence hook: called from ensureMounted(); triggers at most one CDN
  // check per TTL (respecting the cache) so the RAF loop never spams the CDN.
  function maybeRefreshFlag() {
    if (_flagChecking) return;
    const now = Date.now();
    if (now - _lastFlagCheck < FOLDERS_FLAG_TTL_MS) return;
    _lastFlagCheck = now;
    _flagChecking = true;
    fetchFolderAvailable().then((avail) => {
      _flagChecking = false;
      if (_dead) return;
      applyAvailability(avail);
    }).catch(() => { _flagChecking = false; });
  }

  // ── Init ──
  function detectLang() {
    const browserLang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return browserLang === 'ko' ? 'ko' : 'en';
  }
  async function init() {
    await loadStore();
    await loadExpanded();
    // Must run after both loads (folder.updatedAt + persisted version available)
    // and before refreshEntitlement() below.
    seedSyncVersion();
    chrome.storage.sync.get({ lang: 'auto', [ADAPTER.prefKey]: true }, (cfg) => {
      _lang = cfg.lang === 'auto' ? detectLang() : cfg.lang;
      _userPref = cfg[ADAPTER.prefKey] !== false;
      // _available is still its initial `false` here (DARK) — this refreshEntitlement()
      // call resolves _plan only; its internal pullStore() is gated on _enabled, which is
      // false until the CDN flag check below resolves true, so a dark start does ZERO
      // /api/folders network even for a Pro user.
      _enabled = _available && _userPref;
      refreshEntitlement();
      // Kick off the initial availability check now (thereafter throttled to once per
      // TTL from ensureMounted()); persists foldersAvailable for options. If this
      // resolves the feature enabled, applyAvailability() triggers the first pull.
      _lastFlagCheck = Date.now();
      fetchFolderAvailable().then((avail) => { if (!_dead) applyAvailability(avail); });
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (_dead) return; // superseded/torn-down instance stays inert (can't removeListener an anon)
      if (area === 'sync') {
        if (changes[ADAPTER.prefKey]) {
          _userPref = changes[ADAPTER.prefKey].newValue !== false;
          recomputeEnabled(); // effective gate still requires _available
        }
        if (changes.lang) {
          const v = changes.lang.newValue;
          _lang = v === 'auto' ? detectLang() : v;
          const el = document.getElementById(CT_PANEL_ID);
          // Skip the remount mid-drag (it would destroy the drop target); the new
          // language applies on the next render — onDocDragEnd re-renders on drop end.
          if (el && !_dragging) { unmount(); mount(); }
        }
      }
      if (area === 'local' && (changes[FOLDERS_KEY] || changes[CHAT_META_KEY])) {
        // Another tab/session mutated folders. During a drag, still refresh the
        // in-memory snapshot (so a drop doesn't persist stale _folders and clobber
        // the other tab) but defer the re-render — onDocDragEnd renders once the
        // drop settles, keeping the drop target from vanishing mid-drag.
        if (_dragging) { loadStore(); return; }
        loadStore().then(renderList);
      }
    });

    requestAnimationFrame(tick);
    startObserver();
    wireDragAndDrop();
    // Re-check entitlement every 6h (cheap; cached server-side with 24h TTL).
    _intervals.push(setInterval(refreshEntitlement, 6 * 60 * 60 * 1000));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  } // end createFoldersEngine

  // Register the single canonical engine so a thin per-provider bootstrap (e.g.
  // chatgpt-folders.js) can mount it with its own adapter — zero duplicated logic.
  globalThis.__ctFoldersEngine = createFoldersEngine;

  // claude.ai auto-mounts the Claude adapter here. On chatgpt.com this file is
  // injected only to register the engine above (this bootstrap is host-gated off);
  // chatgpt-folders.js then performs the ChatGPT mount against the same engine.
  if (location.hostname === 'claude.ai') createFoldersEngine(CLAUDE_ADAPTER);
})();
