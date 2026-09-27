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

  // 🔴 TWO SIDEBAR DOMS ARE LIVE AT ONCE, per account (#1676). The 2026-09-26 redesign renders a
  // conversation row as a <div data-sidebar-chatgpt-conversation-key> with no href, while a Free
  // account measured 2026-09-27 still gets the <a href="/c/<id>"> list (28 rows, no new attributes).
  // Both are FIRST-CLASS here — neither is a fallback — so a later clean-up must not drop the <a>
  // path as "legacy": that is what Free users see.
  const LEGACY_ROW = 'a[href*="/c/"]';
  const NEW_ROW_ATTR = 'data-sidebar-chatgpt-conversation-key';
  // ChatGPT conversation ids are UUIDs (every /c/<id> observed, incl. 28/28 on a Free account).
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  // The new row's key → a conversation id, ONLY when the WHOLE value is one of the shapes we can
  // vouch for: a bare UUID, `/c/<uuid>`, or `https://chatgpt.com/c/<uuid>` (Codex 1R: a `/c/`
  // found mid-string, or a non-UUID after it, is not one). 🪤 The key's value was never captured
  // live (#1676) — anything else yields null, which makes the row inert for drag-import rather
  // than filing a WRONG conversation into a folder.
  const NEW_ROW_KEY_RE = new RegExp(`^(?:(?:https://chatgpt\\.com)?/c/)?(${UUID})$`, 'i');
  function conversationIdFromKey(key) {
    const m = String(key || '').trim().match(NEW_ROW_KEY_RE);
    return m ? m[1] : null;
  }

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
    // Sidebar conversation-row selector — BOTH DOMs; specific when a chatId is given, else the
    // generic form used for pointer-drag hit-testing. `chatId` comes from getCurrentChatId()
    // (`[\w-]+`), so it is safe inside the quoted attribute value.
    getChatLinkSelector(chatId) {
      if (!chatId) return `${LEGACY_ROW}, [${NEW_ROW_ATTR}]`;
      return `a[href*="/c/${chatId}"], [${NEW_ROW_ATTR}="${chatId}"], [${NEW_ROW_ATTR}$="/c/${chatId}"]`;
    },
    // Conversation id of a row (pointer-drag import): the <a>'s href, else the new row's key.
    chatIdFromLink(el) {
      const m = (el?.getAttribute?.('href') || '').match(/\/c\/([\w-]+)/);
      if (m) return m[1];
      return conversationIdFromKey(el?.getAttribute?.(NEW_ROW_ATTR));
    },
    // Visible title: the new row's title span when there is one (the row also holds its options
    // button), else the row's text.
    chatTitleOf(el) {
      const t = el?.querySelector?.('[data-thread-title]');
      return (t ? t.textContent : el?.textContent) || '';
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
    // this file), so the anchor DOM logic is NOT duplicated. Folders mount above
    // the pinned/projects/recent sections of the sidebar scroll container — the
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
