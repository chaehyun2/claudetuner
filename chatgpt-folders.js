// Claude Tuner — Folders (ChatGPT port)
// Thin per-provider bootstrap: defines the ChatGPT adapter and mounts the SINGLE
// canonical folders engine (createFoldersEngine) that lives in claude-folders.js.
// There is NO duplicated store/render/dnd/gate logic here — every host-coupled
// detail is expressed as the small adapter below, exactly like CLAUDE_ADAPTER.
//
// Load order (background.js CHATGPT_INJECT): usage-shared.js → chatgpt-sidebar.js
// → chatgpt-input.js → claude-folders.js (registers globalThis.__ctFoldersEngine)
// → chatgpt-folders.js (this file, mounts the ChatGPT adapter).
//
// Design: docs/DESIGN-claude-folders.md (§ ChatGPT port)

(() => {
  'use strict';

  // The engine is registered by claude-folders.js, injected just before this file.
  // If it's missing (load-order regression / stale registration), bail quietly so
  // we never throw in the page — the next injection will retry.
  const engine = globalThis.__ctFoldersEngine;
  if (typeof engine !== 'function') return;
  try { if (!chrome.runtime?.id) return; } catch { return; } // dead context guard

  // ── Provider adapter: everything host-coupled for chatgpt.com ──
  // Implements the pinned adapter interface (mirrors CLAUDE_ADAPTER).
  const CHATGPT_ADAPTER = {
    provider: 'chatgpt',
    // ChatGPT has no org model. Folders live in ONE bucket per user, keyed by the
    // literal string "chatgpt" so they coexist with Claude folders in the same
    // server blob (folders are an array with per-folder orgUuid) — no storage-shape
    // change. foldersForActiveOrg()/createFolder() partition on this value, so a
    // ChatGPT page only ever shows/creates "chatgpt"-bucket folders.
    getActiveOrgId() { return 'chatgpt'; },
    // Current conversation id from the URL, e.g. /c/<uuid>
    getCurrentChatId() {
      const m = location.pathname.match(/\/c\/([\w-]+)/);
      return m ? m[1] : null;
    },
    // Sidebar conversation-link selector; specific when a chatId is given, else the
    // generic form used for pointer-drag hit-testing.
    getChatLinkSelector(chatId) {
      return chatId ? `a[href*="/c/${chatId}"]` : 'a[href*="/c/"]';
    },
    // Extract a conversation id from an <a href> (pointer-drag import).
    chatIdFromHref(href) {
      const m = (href || '').match(/\/c\/([\w-]+)/);
      return m ? m[1] : null;
    },
    // Canonical conversation URL for a rendered folded-chat link.
    chatUrl(id) { return `https://chatgpt.com/c/${encodeURIComponent(id)}`; },
    // Strip ChatGPT's document.title suffix only in its real browser forms:
    // a delimiter + "ChatGPT" (" - ChatGPT" / " | ChatGPT"), or an exact standalone
    // "ChatGPT" (new/untitled chat). Never strip a bare trailing "ChatGPT" that is
    // part of the conversation title itself (e.g. "Compare Claude and ChatGPT").
    stripTitleSuffix(title) {
      const s = String(title || '').trim();
      if (/^ChatGPT$/i.test(s)) return '';
      return s.replace(/\s*[|\-–]\s*ChatGPT\s*$/i, '').trim();
    },
    // No top-bar move button on ChatGPT for v1 (panel + DnD only). Omitting
    // findMoveButtonBox makes injectMoveButton() a no-op there.
    // Sidebar mount anchor — REUSES the single canonical finder exposed by
    // chatgpt-sidebar.js (globalThis.__ctCgFindSidebarAnchor, loaded just before
    // this file), so the anchor DOM logic is NOT duplicated. Folders mount right
    // after the top-level menu group and above the pinned/recent sections — the
    // same anchor the usage panel uses (usage inserts first, folders just below).
    findSidebarAnchor() {
      const find = globalThis.__ctCgFindSidebarAnchor;
      return typeof find === 'function' ? find() : null;
    },
    // ChatGPT's own text tokens (theme-aware). Maps 1:1 to Claude's three shades:
    //   t300 (rows/links)   → primary
    //   t400 (empty/muted)  → tertiary
    //   t500 (title/counts) → secondary
    textClasses: { t300: 'text-token-text-primary', t400: 'text-token-text-tertiary', t500: 'text-token-text-secondary' },
    // Dark-launch wiring (pinned coordination values with Lane B / CDN flags.json).
    prefKey: 'foldersEnabledChatgpt',
    flagField: 'foldersChatgpt',
    // Availability storage key MUST match options.js FOLDER_FLAG_ROWS cacheKey
    // (Lane B) so the options ChatGPT-folders row self-heals from this content
    // script's throttled CDN check via storage.onChanged.
    availableKey: 'foldersChatgptAvailable',
    flagCacheKey: '__ct_folders_flag_chatgpt',
  };

  engine(CHATGPT_ADAPTER);
})();
