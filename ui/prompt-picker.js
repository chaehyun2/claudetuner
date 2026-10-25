// ui/prompt-picker.js — the in-page prompt picker (#2038, docs/plans/prompt-inpage.md S1).
// Classic content script (no imports), loaded before the strip that uses it — like ui/cmp-msg-rows.js.
// The strip (input-usage.js on claude.ai; chatgpt-input.js / gemini-input.js in S2) supplies the
// site-specific parts through create(opts); everything else — the popover, the server calls via the
// background proxy (bg/prompts.js), inserting into the composer — lives here once.
//
// create(opts) → { button(cls), starButton(cls, getEl), open(src), close(), destroy(), enabled(), saveText(text, src) → Promise<boolean> }
//   opts.document, opts.chrome — the page's globals (passed in, like cmp-msg-rows.js)
//   opts.site                  — 'claude' | 'chatgpt' | 'gemini' (create's `source`, GA `site`)
//   opts.getEditor()           — the composer's contenteditable, or null
//   opts.anchor()              — the element the popover sits above (the strip host), or null
//   opts.lang()                — 'ko' | 'en'
//   opts.isDark()              — the site's theme
//   opts.onEnabledChange()     — optional: the options page switched the picker on/off (promptButtonEnabled) —
//                                the strip re-renders (mountPromptButton asks enabled()) and re-syncs its rows
//
// 🔴 Data is only ever written with textContent (titles and bodies are user / admin text).
// 🔴 Insertion is `execCommand('insertText')` — the one method S0 measured working on all three
// composers (ProseMirror ×2, Quill); a synthetic paste does nothing on Gemini. When the text did not
// land, the body goes to the clipboard and the user is told to paste.
(() => {
  'use strict';
  const HOST_ID = 'ct-prompt-picker-host';
  const MSG = 'ct_prompts';
  const OPEN_MSG = 'ct_prompts_open';      // background → tab, from the keyboard shortcut
  const INSERT_MSG = 'ct_prompts_insert';  // background → the tab it opened for our prompt pages (bg/prompts.js PROMPT_INSERT_MSG)
  const WEB_INSERT_TRIES = 3;              // the composer can exist a moment before it takes input
  const WEB_RECHECK_MS = 1500;             // the site swapping in a new composer after load drops what we typed — put it back once
  const SHORTCUT_LABEL = { mac: '⌥⇧P', other: 'Alt+Shift+P' };   // manifest `commands` suggested_key
  const TITLE_MAX = 60;                    // auto title from the first line (server cap is 120)
  const STALE_MS = 60 * 1000;              // reopening within this reuses the lists (and refreshes after)
  const TOAST_MS = 3500;
  const INSERT_PROBE_CHARS = 24;           // how much of the body must show up to count as inserted
  const POPOVER_GAP = 8;
  const POPOVER_MIN_W = 320;
  const POPOVER_MAX_W = 560;
  const POPOVER_MIN_ABOVE = 260;           // less room than this above the anchor → open below
  const POPOVER_MAX_H = 480;               // also capped by the room actually left on screen (position())
  const VIEWPORT_MARGIN = 8;
  // 내 프롬프트 with fewer than FILL_UNDER saved: popular 추천 rows are laid under them (up to FILL_COUNT),
  // so a new user's picker is not an empty box (2026-10-25 user decision — over 「open on 추천」).
  const FILL_UNDER = 5;
  const FILL_COUNT = 5;
  const INTRO_DELAY_MS = 1500;             // after the chip appears (and between visibility checks)
  const INTRO_WAIT_TRIES = 20;
  const INTRO_SHOW_MS = 12000;
  const INTRO_TRACK_MS = 250;              // the ring follows the chip (layout shifts, resizes)
  const INTRO_RING_PAD = 3;
  const INTRO_GAP = 10;
  const INTRO_BY = 'by Claude Tuner';      // product name — not translated
  const UNDO_MS = 6000;                    // a deleted row offers 「되돌리기」 this long
  const TRASH_PATHS = ['M3 6h18', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'];
  const LOGIN_CODES = ['ext_token_required', 'login_proof_required', 'scope_insufficient', 'Unauthorized'];

  const I18N = {
    ko: {
      title: '프롬프트', tab_mine: '내 프롬프트', tab_store: '추천', search: '검색',
      loading: '불러오는 중…', load_failed: '불러오지 못했어요. 잠시 후 다시 열어 주세요.',
      mine_empty: '아직 저장한 프롬프트가 없어요. 보낸 메시지 아래 책갈피나 아래 「지금 입력 저장」으로 모아 보세요.',
      store_empty: '아직 추천 프롬프트가 없어요.', no_match: '검색 결과가 없어요.',
      mine_empty_short: '아직 저장한 프롬프트가 없어요 · 보낸 메시지 아래 책갈피로 저장', fill_head: '인기 프롬프트',
      intro_title: '새 기능 · 프롬프트', intro_body: '자주 쓰는 프롬프트를 저장해 두면 Claude·ChatGPT·Gemini 어디서든 바로 꺼내 쓸 수 있어요.',
      hint_keys: '↑↓ 이동 · Enter 넣기', del: '삭제', deleted: '삭제했어요', undo: '되돌리기', delete_failed: '삭제하지 못했어요', users_short: '{n}명',
      login_text: 'Claude Tuner에 로그인하면 프롬프트를 저장하고 Claude·ChatGPT·Gemini 어디서든 꺼내 쓸 수 있어요.',
      login_btn: '로그인하기', inactive: '이 계정은 삭제 처리됐어요. 대시보드에 다시 로그인하면 복구돼요.',
      save_current: '+ 지금 입력 저장', open_page: '전체 보기 ↗', close: '닫기',
      users: '{n}명 사용', like: '좋아요',
      saved: '저장했어요 · {key}로 어디서든 꺼내 쓰기', dup: '이미 저장돼 있어요', empty_input: '입력창이 비어 있어요',
      limit: '저장 가능한 개수({n}개)를 다 썼어요', save_failed: '저장하지 못했어요', save_login: '저장하려면 Claude Tuner 로그인이 필요해요',
      inserted_fallback: '입력창에 넣지 못해 복사했어요. 붙여넣기(⌘V) 해 주세요.', copy_failed: '넣지 못했어요. 「전체 보기」에서 복사해 주세요.',
      star_tip: '이 메시지를 프롬프트로 저장', star_done: '저장됨',
      saved_inline: '✓ 저장했어요', dup_inline: '✓ 이미 저장돼 있어요',
      btn_tip: '프롬프트 꺼내 쓰기 ({key})', btn_label: '프롬프트',
    },
    en: {
      title: 'Prompts', tab_mine: 'My prompts', tab_store: 'Recommended', search: 'Search',
      loading: 'Loading…', load_failed: 'Could not load. Please reopen in a moment.',
      mine_empty: 'No prompts yet. Save one with the bookmark under a sent message, or “Save current input” below.',
      store_empty: 'No recommended prompts yet.', no_match: 'No matches.',
      mine_empty_short: 'No saved prompts yet · save one with the bookmark under a sent message', fill_head: 'Popular prompts',
      intro_title: 'New · Prompts', intro_body: 'Save the prompts you use often and drop them into Claude, ChatGPT or Gemini.',
      hint_keys: '↑↓ move · Enter insert', del: 'Delete', deleted: 'Deleted', undo: 'Undo', delete_failed: 'Could not delete', users_short: '{n} used',
      login_text: 'Sign in to Claude Tuner to save prompts and use them in Claude, ChatGPT and Gemini.',
      login_btn: 'Sign in', inactive: 'This account was deleted. Sign in to the dashboard again to restore it.',
      save_current: '+ Save current input', open_page: 'See all ↗', close: 'Close',
      users: '{n} used', like: 'Like',
      saved: 'Saved · open it anywhere with {key}', dup: 'Already saved', empty_input: 'The input box is empty',
      limit: 'You have reached the limit ({n})', save_failed: 'Could not save', save_login: 'Sign in to Claude Tuner to save prompts',
      inserted_fallback: 'Could not type it in, so it was copied. Paste it (Ctrl/⌘+V).', copy_failed: 'Could not insert. Copy it from “See all”.',
      star_tip: 'Save this message as a prompt', star_done: 'Saved',
      saved_inline: '✓ Saved', dup_inline: '✓ Already saved',
      btn_tip: 'Use a prompt ({key})', btn_label: 'Prompts',
    },
  };

  const CSS = `
:host { all: initial; }
.pp { position: fixed; z-index: 2147483000; box-sizing: border-box; display: flex; flex-direction: column;
  max-height: 480px; border: 1px solid #e5e7eb; border-radius: 12px; background: #fff; color: #111827;
  box-shadow: 0 10px 30px rgba(0,0,0,.18); font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow: hidden; }
.pp.dark { background: #1f1f1e; border-color: #3a3a38; color: #ececec; }
.pp-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px 4px; }
.pp-search { flex: 1; min-width: 0; border: 1px solid rgba(127,127,127,.3); border-radius: 8px; padding: 5px 8px; background: transparent; color: inherit; font: inherit; outline: none; }
.pp-x { border: 0; background: none; color: inherit; opacity: .5; font-size: 16px; cursor: pointer; padding: 0 4px; }
.pp-list { overflow-y: auto; padding: 4px; flex: 1; }
.pp { container-type: inline-size; }
.pp-item { display: flex; gap: 8px; align-items: flex-start; padding: 7px 8px; border-radius: 8px; cursor: pointer; }
.pp-item.on { background: rgba(127,127,127,.12); }
.pp-main { flex: 1; min-width: 0; }
.pp-th { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pp-t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.pp-tag { flex-shrink: 0; font-size: 10px; font-weight: 600; line-height: 1; padding: 2px 6px; border-radius: 999px; background: rgba(127,127,127,.14); opacity: .8; white-space: nowrap; }
.pp-b { opacity: .65; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* The chosen row's prompt as it will be typed (line breaks kept) in a FIXED-height pane under the list: rows stay one
   line, so moving the pointer never reflows the list under it (an expanding hovered row did — the next row slid under
   the pointer and took the selection). */
.pp-prev { flex-shrink: 0; box-sizing: border-box; height: 92px; margin: 0 6px 4px; padding: 7px 10px; border-radius: 8px; background: rgba(127,127,127,.08);
  font-size: 12px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; overflow: hidden; opacity: .85;
  -webkit-mask-image: linear-gradient(to bottom, #000 72%, transparent); mask-image: linear-gradient(to bottom, #000 72%, transparent); }
.pp-prev:empty { display: none; }
.pp-side { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.pp-meta { font-size: 11px; opacity: .55; white-space: nowrap; }
.pp-like { border: 0; background: none; color: inherit; opacity: .6; border-radius: 999px; font: inherit; font-size: 12px; padding: 1px 4px; cursor: pointer; white-space: nowrap; }
.pp-like:hover { opacity: 1; }
.pp-like.on { color: #ec4899; opacity: 1; }
.pp-del { visibility: hidden; flex-shrink: 0; border: 0; background: none; color: inherit; opacity: .5; padding: 2px; border-radius: 6px; cursor: pointer; display: inline-flex; }
.pp-del svg { width: 14px; height: 14px; }
.pp-del:hover { opacity: 1; color: #dc2626; background: rgba(220,38,38,.1); }
.pp-item.on .pp-del { visibility: visible; }
.pp-item.pp-undo { cursor: default; align-items: center; opacity: .75; font-size: 12px; }
.pp-undo-btn { border: 0; background: none; color: #7c3aed; font: inherit; font-weight: 600; cursor: pointer; padding: 0 4px; }
.pp.dark .pp-undo-btn { color: #c4b5fd; }
.pp-cats { display: flex; align-items: center; gap: 6px; padding: 4px 10px 8px; overflow-x: auto; scrollbar-width: none; flex-shrink: 0; border-bottom: 1px solid rgba(127,127,127,.2); }
.pp-cats-sep { flex-shrink: 0; width: 1px; height: 14px; background: rgba(127,127,127,.3); }
.pp-cats::-webkit-scrollbar { display: none; }
.pp-cat { flex-shrink: 0; border: 1px solid rgba(127,127,127,.3); background: none; color: inherit; border-radius: 999px; font: inherit; font-size: 11px; font-weight: 600; padding: 2px 9px; cursor: pointer; opacity: .75; white-space: nowrap; }
.pp-cat:hover { opacity: 1; }
.pp-cat.on { opacity: 1; background: rgba(124,58,237,.12); border-color: transparent; color: #7c3aed; }
.pp.dark .pp-cat.on { color: #c4b5fd; }
.pp-n { margin-left: 4px; font-weight: 500; opacity: .6; }
.pp-hint { font-size: 11px; opacity: .45; white-space: nowrap; }
@container (max-width: 440px) { .pp-hint { display: none; } }
.pp-msg { padding: 18px 14px; text-align: center; opacity: .75; }
.pp-note { padding: 8px 10px 4px; font-size: 12px; opacity: .65; }
.pp-sep { padding: 8px 8px 2px; font-size: 11px; font-weight: 600; opacity: .55; text-transform: uppercase; letter-spacing: .02em; }
.pp-cta { margin-top: 10px; border: 0; border-radius: 8px; padding: 6px 14px; background: #7c3aed; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
.pp-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 10px; border-top: 1px solid rgba(127,127,127,.2); }
.pp-link { border: 0; background: none; color: #7c3aed; font: inherit; font-size: 12px; cursor: pointer; padding: 2px 4px; }
.pp.dark .pp-link { color: #c4b5fd; }
.pp-link:disabled { opacity: .4; cursor: default; }
.pp-link.done, .pp-link.done:disabled { opacity: 1; color: #059669; font-weight: 600; }
.pp.dark .pp-link.done { color: #34d399; }
.pp-link.err { color: #dc2626; font-weight: 600; }
.pp.dark .pp-link.err { color: #f87171; }
.pp-item.new { background: rgba(124,58,237,.12); box-shadow: inset 3px 0 0 #7c3aed; }
.pp-ring { position: fixed; z-index: 2147482999; box-sizing: border-box; pointer-events: none; border: 2px solid #7c3aed; border-radius: 999px;
  animation: pp-pulse 1.6s ease-out infinite; }
@keyframes pp-pulse { 0% { box-shadow: 0 0 0 0 rgba(124,58,237,.55); } 100% { box-shadow: 0 0 0 12px rgba(124,58,237,0); } }
@media (prefers-reduced-motion: reduce) { .pp-ring { animation: none; box-shadow: 0 0 0 4px rgba(124,58,237,.3); } }
.pp-intro { position: fixed; z-index: 2147483001; box-sizing: border-box; max-width: 260px; padding: 10px 28px 10px 12px; border-radius: 10px;
  background: #7c3aed; color: #fff; font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.25); cursor: pointer; }
.pp-intro b { display: block; font-weight: 700; margin-bottom: 2px; }
.pp-intro-by { display: block; margin-top: 4px; text-align: right; font-size: 11px; opacity: .75; }
.pp-intro::after { content: ''; position: absolute; left: var(--ax, 50%); bottom: -5px; width: 10px; height: 10px; background: #7c3aed; transform: translateX(-50%) rotate(45deg); }
.pp-intro.below::after { bottom: auto; top: -5px; }
.pp-intro-x { position: absolute; top: 4px; right: 6px; border: 0; background: none; color: #fff; opacity: .8; font-size: 15px; line-height: 1; cursor: pointer; padding: 2px; }
.pp-intro-x:hover { opacity: 1; }
.pp-toast { position: fixed; z-index: 2147483001; transform: translateX(-50%); background: #7c3aed; color: #fff; padding: 8px 16px; border-radius: 10px;
  font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; box-shadow: 0 6px 18px rgba(0,0,0,.25); max-width: 80vw; text-align: center; }
`;

  function create(opts) {
    const { document, chrome, site } = opts;
    const t = (key, vars) => {
      const d = I18N[opts.lang && opts.lang() === 'ko' ? 'ko' : 'en'];
      const s = d[key] != null ? d[key] : I18N.en[key] != null ? I18N.en[key] : key;
      return s.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
    };
    const shortcut = () => (/Mac|iPhone|iPad/.test(navigator.platform || '') ? SHORTCUT_LABEL.mac : SHORTCUT_LABEL.other);

    // newId: the row to highlight (just saved / found as a duplicate) · saveNote: the last 「지금 입력 저장」 outcome for its text.
    // status / loadedAt are 내 프롬프트's; the 추천 list has its own (storeStatus: 'idle' | 'loading' | 'error' | 'ready')
    // so its failure shows as a failure on its tab and is retried on the next open (#2547).
    const state = { tab: 'mine', mine: null, store: null, status: 'idle', storeStatus: 'idle', code: null, query: '', active: 0, loadedAt: 0, storeLoadedAt: 0, storeLang: '', category: '', range: null, newId: null, saveNote: null, limit: '' };
    let host = null, shadow = null, toastTimer = null;
    // By id, never on the row objects: a list answer replaces those with fresh copies, which silently dropped
    // per-object marks (Codex UI R2 — R1-B1/B3/B4 still open).
    const deletedIds = new Set();    // deleted from this picker (removeMine)
    const removingIds = new Set();   // a delete request in flight
    const undoingIds = new Set();    // an undo (re-create) in flight
    let destroyed = false;
    // The options page's 「입력창 프롬프트 버튼」 (chrome.storage.sync promptButtonEnabled, default on). Off: no chip,
    // no message bookmark, no spotlight, the shortcut does nothing. Assumed on until read (the default).
    let enabledOpt = true;
    // Until the stored value is known, nothing that leaves a trace waits on 「on」: the spotlight (it marks the site as
    // shown) holds until then (Codex R1-B3). A change event seen first is newer than the initial read (R1-B2).
    let enabledKnown = false, enabledChangeSeen = false;   // destroy(): nothing of this instance may draw again (Codex S2 R1-B1 / R2-B1)
    // Every prompt this instance created, oldest first: a list answer that was asked for before a create
    // landed must not drop it (#2544 — the next bookmark on the same text would then create it twice).
    const created = [];
    // An extension update re-injects this file into open tabs: the previous instance's popover (its runtime
    // is dead) must not stay on screen next to ours.
    document.querySelectorAll('#' + HOST_ID).forEach((h) => h.remove());

    const send = (msg) => new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: MSG, ...msg }, (resp) => {
          void chrome.runtime.lastError;   // a dead context answers nothing
          resolve(resp || { ok: false, status: -1 });
        });
      } catch { resolve({ ok: false, status: -1 }); }
    });
    const track = (event, params) => { try { chrome.runtime.sendMessage({ type: MSG, op: 'track', event, params: { site, ...params } }); } catch { /* context dead */ } };

    function el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    function ensureHost() {
      if (host && document.documentElement.contains(host)) return;
      host = el('div');
      host.id = HOST_ID;
      shadow = host.attachShadow({ mode: 'open' });
      const style = el('style'); style.textContent = CSS;
      shadow.appendChild(style);
      document.documentElement.appendChild(host);
    }

    // ── data ──────────────────────────────────────────────────────────────────────────────────
    function isLoginFailure(r) { return r.status === 401 || (r.status === 403 && LOGIN_CODES.includes(r.code)); }

    /** Adopts a list answer requested when `created` had `mark` entries, keeping what was created since. */
    function adoptMine(prompts, mark) {
      // Deleted here: never back from a list asked before the delete answered (Codex UI R1-B1); a row still
      // offering 「되돌리기」 keeps its place at the top.
      const fetched = (prompts || []).filter((p) => !deletedIds.has(p.id));
      const ids = new Set(fetched.map((p) => p.id));
      const pending = (state.mine || []).filter((p) => p.deleted);
      state.mine = pending.concat(created.slice(mark).filter((p) => !ids.has(p.id) && !deletedIds.has(p.id)).reverse(), fetched);
      state.loadedAt = Date.now();
    }

    // Each list is applied as soon as it answers — one waiting for the other is what let a late 추천 answer
    // overwrite a save made in between (#2544). One request per list at a time.
    let loadingMine = false, loadingStore = false;
    /** The 추천 language — the extension's UI language (2026-10-25 user report: Korean and English rows mixed). */
    const storeLang = () => (opts.lang && opts.lang() === 'ko' ? 'ko' : 'en');
    /**
     * The 추천 list to SHOW: only one fetched in the current language, else none (= 「불러오는 중…」 / no fill rows).
     * Every display and insert path reads this, never state.store — a list of the previous language can still be
     * in state while its replacement is in flight, and must not be seen or inserted (Codex R1-B2).
     */
    const currentStore = () => (state.store && state.storeLang === storeLang() ? state.store : null);
    function load() {
      if (!loadingMine && !(state.mine && Date.now() - state.loadedAt < STALE_MS)) loadMine();
      // A list in another language (the user switched the extension's language) is not shown at all.
      if (state.store && state.storeLang !== storeLang()) { state.store = null; state.storeStatus = 'idle'; }
      if (!loadingStore && !(state.storeStatus === 'ready' && Date.now() - state.storeLoadedAt < STALE_MS)) loadStore();
    }

    async function loadMine() {
      loadingMine = true;
      if (!state.mine) { state.status = 'loading'; render(); }
      const mark = created.length;
      const mine = await send({ op: 'list' });
      loadingMine = false;
      if (destroyed) return;   // answered after the strip's teardown: nothing more from this instance
      if (mine.ok) {
        adoptMine(mine.data?.prompts, mark);
        state.status = 'ready';
      } else if (isLoginFailure(mine)) {
        state.status = 'login';
      } else if (mine.status === 403 && mine.code === 'account_inactive') {
        state.status = 'inactive';
      } else if (!state.mine) {
        state.status = 'error';
      }
      render();
    }

    async function loadStore() {
      loadingStore = true;
      if (!state.store) { state.storeStatus = 'loading'; render(); }
      const lang = storeLang();
      const store = await send({ op: 'store', lang });
      loadingStore = false;
      if (destroyed) return;   // no re-ask in a new language either (Codex S2 merge review, 후속)
      if (lang !== storeLang()) { load(); return; }   // switched while asking — ask again in the new language
      if (store.ok) {
        // `?lang=` filters on the server (that language + language-neutral rows, before its LIMIT); the same
        // rule here too, so a worker without the filter (older deploy, rollback) never mixes them back in.
        state.store = (store.data?.prompts || []).filter((p) => !p.lang || p.lang === lang);
        state.storeLang = lang;
        state.storeStatus = 'ready';
        state.storeLoadedAt = Date.now();
      } else if (!state.store) {
        state.storeStatus = 'error';   // shown on the 추천 tab; the next open asks again
      }
      // A failed refresh of a list already shown keeps it (storeLoadedAt stays old → retried next open).
      render();
    }

    // ── composer ──────────────────────────────────────────────────────────────────────────────
    function rememberSelection() {
      const ed = opts.getEditor();
      const sel = document.getSelection && document.getSelection();
      state.range = ed && sel && sel.rangeCount && ed.contains(sel.getRangeAt(0).commonAncestorContainer)
        ? sel.getRangeAt(0).cloneRange() : null;
    }

    const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    // Gemini's last-resort composer is a <textarea> (gemini-input.js COMPOSER_SELECTORS): its text is `value`, and
    // innerText stays empty — reading that called every insert a failure and retried it (deploy-1.56.0 R1-B1).
    const isField = (el) => !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
    const composerText = (el) => (isField(el) ? el.value : el.innerText);

    /**
     * The text of a composer or a sent-message bubble, one line per paragraph. `innerText` is not it:
     * Chrome puts a blank line around every <p>, so a 2-paragraph input saved as innerText came back
     * with 10 newlines (measured on claude.ai, 2026-10-25). Lists become "- item" lines.
     */
    function blockText(root) {
      if (!root) return '';
      const kids = [...root.children];
      if (!kids.length) return String(root.innerText || root.textContent || '').trim();
      const line = (el) => String(el.innerText != null ? el.innerText : el.textContent || '').replace(/\n+$/, '');
      const start = (ol) => { const n = parseInt(ol.getAttribute('start'), 10); return Number.isFinite(n) ? n : 1; };
      return kids.map((ch) => (ch.matches('ul, ol')
        ? [...ch.children].map((li, i) => (ch.matches('ol') ? (start(ch) + i) + '. ' : '- ') + line(li).trim()).join('\n')
        : line(ch))).join('\n').trim();
    }

    /** Type `text` into the composer at the remembered caret (else at the end). True when it landed. */
    function insertText(text) {
      const ed = opts.getEditor();
      if (!ed) return false;
      const hadFocus = document.activeElement === ed;
      ed.focus();
      const probe = squash(text).slice(0, INSERT_PROBE_CHARS);
      const count = () => squash(composerText(ed)).split(probe).length - 1;
      let replaced = '';
      if (isField(ed)) {
        // A field keeps its own caret: insert at it when it is inside, else at the end.
        if (!hadFocus || ed.selectionStart == null) ed.setSelectionRange(ed.value.length, ed.value.length);
        replaced = ed.value.slice(ed.selectionStart, ed.selectionEnd);
      } else {
        const sel = document.getSelection();
        let range = state.range && ed.contains(state.range.commonAncestorContainer) ? state.range : null;
        if (!range) { range = document.createRange(); range.selectNodeContents(ed); range.collapse(false); }
        sel.removeAllRanges(); sel.addRange(range);
        replaced = range.toString();
      }
      // Counted, not measured: replacing a long selection with a short prompt shrinks the text yet succeeds.
      // When the replaced selection itself held the body, the count may not rise — present afterwards is enough.
      const before = count();
      const replacedHadIt = !!probe && squash(replaced).includes(probe);
      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
      const after = count();
      return ok && !!probe && (after > before || (replacedHadIt && after >= 1));
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false);
      return Promise.resolve(false);
    }

    async function use(item, kind) {
      close();
      const body = item.body || '';
      if (insertText(body)) {
        track('prompt_insert', { kind, result: 'ok' });
      } else {
        const copied = await copyText(body);
        toast(t(copied ? 'inserted_fallback' : 'copy_failed'));
        track('prompt_insert', { kind, result: copied ? 'fallback_clipboard' : 'failed' });
      }
      if (kind === 'store') send({ op: 'use', id: item.id });
    }

    // ── save ──────────────────────────────────────────────────────────────────────────────────
    function autoTitle(text) {
      const first = String(text).split('\n').map((l) => l.trim()).find(Boolean) || '';
      return first.length > TITLE_MAX ? first.slice(0, TITLE_MAX - 1) + '…' : first;
    }

    /**
     * Saves `text` as a personal prompt; toasts the outcome. Resolves true when it is (now) saved.
     * Serialized: two bookmark-save clicks in a row must not both pass the duplicate check before either is stored.
     */
    let saveChain = Promise.resolve();
    function saveText(text, src, quiet) {
      const run = saveChain.then(() => saveOne(text, src, quiet));
      saveChain = run.catch(() => 'error');
      return run;
    }

    /**
     * One save. Answers the outcome — 'saved' | 'dup' | 'empty' | 'login' | 'limit' | 'error' — and toasts it
     * unless `quiet` (the picker's own 「지금 입력 저장」 shows it on the button it was clicked from instead:
     * a toast at the popover's edge read as part of the popover and went unnoticed, 2026-10-25 user report).
     */
    async function saveOne(text, src, quiet) {
      const body = String(text || '').trim();
      // Decided when the answer arrives, not when the click happened: the outcome is silent only if the button
      // that will show it is on screen — picker open AND the composer still holding this text. Closed, or
      // reopened over other text (the button then speaks for that text), the toast is the only place left.
      const onButton = () => quiet && isOpen() && blockText(opts.getEditor()) === body;
      const say = (msg, onClick) => { if (!onButton()) toast(msg, onClick); };
      if (!body) { say(t('empty_input')); return 'empty'; }
      if (!state.mine) {
        // Never opened on this page load (e.g. a bookmark-save right after a reload): fetch the list so the
        // duplicate check below sees what is already saved.
        const mark = created.length;
        const r0 = await send({ op: 'list' });
        if (r0.ok) adoptMine(r0.data?.prompts, mark);
      }
      // No list yet (every list request so far failed): what this page saved is all we know (Codex R1-B2).
      const existing = (state.mine ? liveMine() : created).find((p) => String(p.body || '').trim() === body);
      if (existing) { state.newId = existing.id; say(t('dup')); return 'dup'; }
      const r = await send({ op: 'create', body: { title: autoTitle(body), body, source: site } });
      if (r.ok && r.data?.prompt) {
        created.push(r.data.prompt);
        if (state.mine) state.mine.unshift(r.data.prompt);
        state.newId = r.data.prompt.id;
        say(t('saved', { key: shortcut() }));
        track('prompt_save', { src, result: 'ok' });
        return 'saved';
      }
      const login = isLoginFailure(r);
      const limit = r.status === 409 && r.code === 'limit_reached';
      if (login) say(t('save_login'), () => send({ op: 'open_login' }));
      else if (limit) { state.limit = r.data?.limit ?? ''; say(t('limit', { n: state.limit })); }
      else say(t('save_failed'));
      track('prompt_save', { src, result: login ? 'login' : 'error' });
      return login ? 'login' : limit ? 'limit' : 'error';
    }

    // ── UI ────────────────────────────────────────────────────────────────────────────────────
    function toast(text, onClick) {
      if (destroyed) return;   // a save answered after the strip's teardown must not re-create the host
      ensureHost();
      const old = shadow.querySelector('.pp-toast');
      if (old) old.remove();
      const box = el('div', 'pp-toast', text);
      const a = opts.anchor && opts.anchor();
      const r = a ? a.getBoundingClientRect() : { left: innerWidth / 2 - 100, width: 200, top: innerHeight - 80 };
      box.style.left = (r.left + r.width / 2) + 'px';
      box.style.top = Math.max(8, r.top - 44) + 'px';
      if (onClick) { box.style.cursor = 'pointer'; box.addEventListener('click', () => { onClick(); box.remove(); }); }
      shadow.appendChild(box);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => box.remove(), TOAST_MS);
    }

    const matches = (p, q) => !q || [p.title, p.body, p.category].some((v) => v && String(v).toLowerCase().includes(q));

    /** Popular 추천 rows to lay under a short 내 프롬프트 — none already saved (by store id or same body). */
    function fillItems() {
      const mine = liveMine();
      const store = currentStore();
      if (mine.length >= FILL_UNDER || !store || !store.length) return [];
      const ids = new Set(mine.map((p) => p.store_id).filter(Boolean));
      const bodies = new Set(mine.map((p) => String(p.body || '').trim()));
      return store.filter((p) => !ids.has(p.id) && !bodies.has(String(p.body || '').trim())).slice(0, FILL_COUNT);
    }

    /** False while renderList shows a message (loading / error / login / deleted account) instead of rows — its checks, in its order. */
    function rowsShown() {
      if (state.status === 'loading' && !state.mine) return false;   // 「불러오는 중…」 on either tab (Codex R2-B1)
      if (state.status === 'error' || state.status === 'inactive' || state.status === 'login') return false;
      return state.tab === 'store' ? !!currentStore() : !!state.mine;
    }

    /**
     * The rows of the open tab, as { p, kind: 'mine' | 'store' } — 내 프롬프트 may end with popular fill rows.
     * Empty while a message is shown: Enter must never insert a row the user cannot see (Codex R1-B1).
     */
    function visibleItems() {
      if (!rowsShown()) return [];
      const q = state.query.toLowerCase();
      if (state.tab === 'store') return (currentStore() || []).filter((p) => matches(p, q) && (!state.category || p.category === state.category)).map((p) => ({ p, kind: 'store' }));
      return (state.mine || []).filter((p) => matches(p, q)).map((p) => ({ p, kind: p.deleted ? 'undo' : 'mine' }))
        .concat(fillItems().filter((p) => matches(p, q)).map((p) => ({ p, kind: 'store' })));
    }

    function position(pp) {
      const a = (opts.anchor && opts.anchor()) || opts.getEditor();
      const r = a ? a.getBoundingClientRect() : { left: 16, top: innerHeight - 16, width: POPOVER_MAX_W, bottom: innerHeight - 16 };
      const w = Math.min(POPOVER_MAX_W, Math.max(POPOVER_MIN_W, r.width), innerWidth - 16);
      pp.style.width = w + 'px';
      pp.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
      const above = r.top >= POPOVER_MIN_ABOVE;
      if (above) { pp.style.bottom = (innerHeight - r.top + POPOVER_GAP) + 'px'; pp.style.top = ''; }
      else { pp.style.top = (r.bottom + POPOVER_GAP) + 'px'; pp.style.bottom = ''; }
      // Never past the screen edge: only as tall as the room on its side of the anchor.
      const room = (above ? r.top : innerHeight - r.bottom) - POPOVER_GAP - VIEWPORT_MARGIN;
      pp.style.maxHeight = Math.max(POPOVER_MIN_ABOVE - POPOVER_GAP - VIEWPORT_MARGIN, Math.min(POPOVER_MAX_H, room)) + 'px';
    }

    function renderList(list) {
      if (state.status === 'loading' && !state.mine) { list.appendChild(el('div', 'pp-msg', t('loading'))); return; }
      if (state.status === 'error') { list.appendChild(el('div', 'pp-msg', t('load_failed'))); return; }
      if (state.status === 'inactive') { list.appendChild(el('div', 'pp-msg', t('inactive'))); return; }
      if (state.status === 'login') {
        const m = el('div', 'pp-msg', t('login_text'));
        const b = el('button', 'pp-cta', t('login_btn'));
        b.type = 'button';
        b.addEventListener('click', () => { send({ op: 'open_login' }); close(); });
        m.appendChild(el('br')); m.appendChild(b);
        list.appendChild(m);
        return;
      }
      if (state.tab === 'store' && !currentStore()) {
        list.appendChild(el('div', 'pp-msg', t(state.storeStatus === 'error' ? 'load_failed' : 'loading')));
        return;
      }
      const items = visibleItems();
      if (!items.length) {
        const all = state.tab === 'mine' ? state.mine : currentStore();
        list.appendChild(el('div', 'pp-msg', (all && all.length) ? t('no_match') : t(state.tab === 'mine' ? 'mine_empty' : 'store_empty')));
        return;
      }
      if (state.tab === 'mine' && !liveMine().length && !state.query) list.appendChild(el('div', 'pp-note', t('mine_empty_short')));
      state.active = Math.max(0, Math.min(state.active, items.length - 1));
      const painters = [];
      items.forEach(({ p, kind }, i) => {
        if (state.tab === 'mine' && kind === 'store' && (i === 0 || items[i - 1].kind !== 'store')) list.appendChild(el('div', 'pp-sep', t('fill_head')));
        if (kind === 'undo') {
          // Selectable like any row (↑↓ shows where the keyboard is), with nothing to preview or insert (R1-B5).
          const u = undoRow(p);
          const paintUndo = (on) => { u.classList.toggle('on', on); if (on) showPreview(null); };
          paintUndo(i === state.active);
          painters.push(paintUndo);
          list.appendChild(u);
          return;
        }
        const row = el('div', 'pp-item' + (kind === 'mine' && p.id === state.newId ? ' new' : ''));
        row.setAttribute('role', 'option');
        const main = el('div', 'pp-main');
        const th = el('div', 'pp-th');
        th.appendChild(el('div', 'pp-t', p.title || ''));
        // Where it was saved (내 프롬프트) / its category (추천) — small, after the title.
        // `sourceLabel` comes from the background proxy (bg/constants.js PROVIDER_LABELS — the one copy of those names).
        const tag = kind === 'mine' ? p.sourceLabel : p.category;
        if (tag) th.appendChild(el('span', 'pp-tag', String(tag)));
        main.appendChild(th);
        const body = el('div', 'pp-b');
        main.appendChild(body);
        row.appendChild(main);
        if (kind === 'store') row.appendChild(storeSide(p));
        else {
          const del = el('button', 'pp-del');
          del.type = 'button'; del.title = t('del'); del.setAttribute('aria-label', t('del'));
          del.appendChild(icon(TRASH_PATHS));
          del.addEventListener('mousedown', (e) => e.preventDefault());
          del.addEventListener('click', (e) => { e.stopPropagation(); removeMine(p); });
          row.appendChild(del);
        }
        body.textContent = String(p.body || '').replace(/\s+/g, ' ').trim();
        const paint = (on) => {
          row.classList.toggle('on', on);
          row.setAttribute('aria-selected', on ? 'true' : 'false');
          if (on) showPreview(p);
        };
        paint(i === state.active);
        painters.push(paint);
        row.addEventListener('mouseenter', () => setActive(i));
        row.addEventListener('mousedown', (e) => e.preventDefault());   // keep the search box focused
        row.addEventListener('click', () => use(p, kind));
        list.appendChild(row);
      });
      // Hover moves the selection without rebuilding the list (a rebuild under the pointer would re-fire it).
      function setActive(i) {
        if (i === state.active) return;
        if (painters[state.active]) painters[state.active](false);
        state.active = i;
        if (painters[i]) painters[i](true);
      }
    }

    /** 추천 categories of the current-language list, most used first (ties keep list order). */
    function categories() {
      const n = new Map();
      for (const p of currentStore() || []) if (p.category) n.set(p.category, (n.get(p.category) || 0) + 1);
      return [...n.keys()].sort((a, b) => n.get(b) - n.get(a));
    }

    /** The preview pane under the list: the chosen prompt in full, as it will be typed (null = empty, pane hidden). */
    function showPreview(p) {
      const pane = shadow && shadow.querySelector('.pp-prev');
      if (pane) pane.textContent = p ? String(p.body || '').trim() : '';
    }

    /** 추천 row's right side: 「N명」 only when someone used it, then ♡/♥ with the count only when there is one. */
    function storeSide(p) {
      const side = el('div', 'pp-side');
      const users = Number(p.users) || 0;
      if (users) side.appendChild(el('span', 'pp-meta', t('users_short', { n: users })));
      const likes = Number(p.likes) || 0;
      const like = el('button', 'pp-like' + (p.liked ? ' on' : ''), (p.liked ? '♥' : '♡') + (likes ? ' ' + likes : ''));
      like.type = 'button'; like.title = t('like'); like.setAttribute('aria-label', t('like'));
      like.addEventListener('mousedown', (e) => e.preventDefault());
      like.addEventListener('click', async (e) => {
        e.stopPropagation();
        const r = await send({ op: p.liked ? 'unlike' : 'like', id: p.id });
        if (r.ok && r.data) { p.liked = !!r.data.liked; p.likes = r.data.likes; render(); }
      });
      side.appendChild(like);
      return side;
    }

    function icon(paths) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      for (const d of paths) { const path = document.createElementNS(SVG_NS, 'path'); path.setAttribute('d', d); svg.appendChild(path); }
      return svg;
    }

    // ── delete / undo ─────────────────────────────────────────────────────────────────────────
    /** The saved prompts that are not waiting in a 「삭제했어요 · 되돌리기」 row. */
    function liveMine() { return (state.mine || []).filter((p) => !p.deleted); }

    let undoTimer = null;
    function dropDeleted() {
      clearTimeout(undoTimer); undoTimer = null;
      if (state.mine && state.mine.some((p) => p.deleted)) { state.mine = liveMine(); if (isOpen()) renderListOnly(); }
    }

    /** Deletes on the server, then keeps the row as 「삭제했어요 · 되돌리기」 for UNDO_MS (or until the picker closes). */
    async function removeMine(p) {
      const id = p.id;
      if (removingIds.has(id) || deletedIds.has(id)) return;   // one request per prompt (R1-B3)
      removingIds.add(id);
      const r = await send({ op: 'remove', id });
      removingIds.delete(id);
      if (destroyed) return;
      // 404 = already gone (deleted in another tab / the dashboard): the same outcome as ours.
      if (!r.ok && r.status !== 404) { toast(t('delete_failed')); return; }
      deletedIds.add(id);
      // Out of `created` too: adoptMine would otherwise add it back from there on the next list answer.
      for (let k = created.length - 1; k >= 0; k--) if (created[k].id === id) created.splice(k, 1);
      if (state.newId === id) state.newId = null;
      if (!isOpen()) {   // closed before the answer: no 「되돌리기」 left to offer (R1-B4) — just gone
        if (state.mine) state.mine = state.mine.filter((x) => x.id !== id);
        return;
      }
      const row = state.mine && state.mine.find((x) => x.id === id);   // the current copy, whatever list it came from
      if (row) row.deleted = true;
      clearTimeout(undoTimer);
      undoTimer = setTimeout(dropDeleted, UNDO_MS);
      render();   // the tab count changes too
      track('prompt_delete', {});
    }

    function undoRow(p) {
      const row = el('div', 'pp-item pp-undo');
      row.appendChild(el('span', 'pp-main', t('deleted') + ' · ' + (p.title || '')));
      const b = el('button', 'pp-undo-btn', t('undo'));
      b.type = 'button';
      b.disabled = undoingIds.has(p.id);   // a re-render mid-request must not offer a second create (R1-B2)
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (undoingIds.has(p.id)) return;
        undoingIds.add(p.id);
        b.disabled = true;
        // A new row with the same title / body / source (the old id is gone on the server).
        const r = await send({ op: 'create', body: { title: p.title, body: p.body, source: p.source } });
        undoingIds.delete(p.id);
        if (destroyed) return;
        if (r.ok && r.data?.prompt) {
          created.push(r.data.prompt);
          if (state.mine) { const at = state.mine.findIndex((x) => x.id === p.id); if (at >= 0) state.mine[at] = r.data.prompt; else state.mine.unshift(r.data.prompt); }
          render();
        } else { if (b.isConnected) b.disabled = false; else renderListOnly(); toast(t('save_failed')); }
      });
      row.appendChild(b);
      return row;
    }

    function render() {
      if (!isOpen()) return;
      if (state.store && state.storeLang !== storeLang()) load();   // the language changed: fetch it (shown as loading meanwhile)
      const old = shadow.querySelector('.pp');
      const pp = el('div', 'pp' + (opts.isDark && opts.isDark() ? ' dark' : ''));
      pp.setAttribute('role', 'dialog');
      pp.setAttribute('aria-label', t('title'));
      const head = el('div', 'pp-head');
      const search = el('input', 'pp-search');
      search.type = 'search'; search.placeholder = t('search'); search.value = state.query;
      search.addEventListener('input', () => { state.query = search.value; state.active = 0; renderListOnly(); });
      search.addEventListener('keydown', onKey);
      head.appendChild(search);
      const x = el('button', 'pp-x', '×');
      x.type = 'button'; x.title = t('close');
      x.addEventListener('click', close);
      head.appendChild(x);
      pp.appendChild(head);
      // One chip row instead of tabs (2026-10-25 user decision): 내 프롬프트 · 추천 · each 추천 category, visible the
      // moment the picker opens. A category chip = 추천 narrowed to it. Categories come with the 추천 list.
      const cats = categories();
      // Gone from the list, or chips not drawn (one category or none) — then nothing could undo the filter (R2-B1).
      if (state.category && (cats.length < 2 || !cats.includes(state.category))) state.category = '';
      const chips = el('div', 'pp-cats');
      const chip = (cls, label, on, pick) => {
        const b = el('button', cls + (on ? ' on' : ''), label);
        b.type = 'button';
        b.addEventListener('mousedown', (e) => e.preventDefault());   // keep the search box focused
        b.addEventListener('click', () => { pick(); state.active = 0; render(); });
        chips.appendChild(b);
        return b;
      };
      const mineChip = chip('pp-cat pp-tab', t('tab_mine'), state.tab === 'mine', () => { state.tab = 'mine'; state.category = ''; });
      if (state.mine && liveMine().length) mineChip.appendChild(el('span', 'pp-n', String(liveMine().length)));
      chip('pp-cat pp-tab', t('tab_store'), state.tab === 'store' && !state.category, () => { state.tab = 'store'; state.category = ''; });
      if (cats.length > 1) {
        chips.appendChild(el('span', 'pp-cats-sep'));
        for (const c of cats) chip('pp-cat', c, state.tab === 'store' && state.category === c, () => { state.tab = 'store'; state.category = c; });
      }
      pp.appendChild(chips);
      const list = el('div', 'pp-list');
      list.setAttribute('role', 'listbox');
      pp.appendChild(list);
      pp.appendChild(el('div', 'pp-prev'));
      const foot = el('div', 'pp-foot');
      const save = el('button', 'pp-link', t('save_current'));
      save.type = 'button';
      const ed = opts.getEditor();
      paintSave(save);
      save.addEventListener('pointerenter', () => paintSave(save));
      save.addEventListener('click', async () => {
        paintSave(save);   // judge the text as it is now
        if (save.dataset.note === 'saved' || save.dataset.note === 'dup') return;   // this exact text is saved
        if (save.dataset.note === 'login') { send({ op: 'open_login' }); close(); return; }
        save.disabled = true;
        const body = blockText(opts.getEditor());
        const outcome = await saveText(body, 'composer', true);
        state.saveNote = { body, outcome };
        if (outcome === 'saved' || outcome === 'dup') { state.tab = 'mine'; state.query = ''; state.active = 0; }
        render();
      });
      const page = el('button', 'pp-link', t('open_page'));
      page.type = 'button';
      page.addEventListener('click', () => { send({ op: 'open_page' }); close(); });
      foot.appendChild(save); foot.appendChild(el('span', 'pp-hint', t('hint_keys'))); foot.appendChild(page);
      pp.appendChild(foot);
      if (old) old.replaceWith(pp); else shadow.appendChild(pp);
      renderList(list);   // attached first: the rows fill the preview pane through the shadow root
      position(pp);
      // The chosen chip in view — after position(): the popover's width (and so the row's scroll range) is set there (Codex R1).
      const onChip = chips.querySelector('.on');
      if (onChip) chips.scrollLeft = Math.max(0, onChip.offsetLeft - chips.clientWidth / 2 + onChip.offsetWidth / 2);
      const focused = shadow.activeElement;
      if (!focused || focused === document.body || !pp.contains(focused)) search.focus();
      const at = search.value.length; search.setSelectionRange(at, at);
    }

    let listenedEditor = null;   // the composer node our input listener is on (listenComposer)
    /**
     * The 「지금 입력 저장」 button for the CURRENT composer text: the outcome of the last save stays on it
     * while that text is unchanged. Repainted on every composer input while the picker is open (the user
     * can tab back to the composer and edit) — repaint only, never a full render (that would take focus).
     */
    function paintSave(save) {
      if (!save) return;
      const ed = opts.getEditor();
      const current = blockText(ed);
      const note = state.saveNote && state.saveNote.body === current ? state.saveNote.outcome : null;
      const done = note === 'saved' || note === 'dup';
      save.textContent = !note ? t('save_current') : done ? t(note === 'saved' ? 'saved_inline' : 'dup_inline')
        : note === 'login' ? t('save_login') : note === 'limit' ? t('limit', { n: state.limit })
        : note === 'empty' ? t('empty_input') : t('save_failed');
      save.classList.toggle('done', done);
      save.classList.toggle('err', !!note && !done);
      save.dataset.note = note || '';
      // Never locked by a past outcome: the composer may have been swapped by the site (our input listener
      // then sits on the old node), so a click/hover re-judges against the current text instead.
      // Not disabled for an empty input either: a swapped composer may hold text our listener never saw,
      // and a disabled button cannot be re-judged by keyboard. An empty click answers 「입력창이 비어 있어요」.
      save.disabled = state.status === 'login';
      if (isOpen() && ed !== listenedEditor) listenComposer(true);   // follow a swapped composer
    }

    // On the composer element only, and only while the picker is open — never a document/window input
    // listener (test/compare-privacy-guard.mjs [8]: content scripts leave the provider page alone).
    function onComposerInput() { if (shadow) paintSave(shadow.querySelector('.pp-link')); }
    function listenComposer(on) {
      if (listenedEditor) { listenedEditor.removeEventListener('input', onComposerInput); listenedEditor = null; }
      const ed = on && opts.getEditor();
      if (ed) { ed.addEventListener('input', onComposerInput); listenedEditor = ed; }
    }

    function renderListOnly() {
      const list = shadow.querySelector('.pp-list');
      if (!list) return render();
      list.textContent = '';
      showPreview(null);
      renderList(list);
    }

    function onKey(e) {
      const items = visibleItems();
      if (e.key === 'Escape') { e.preventDefault(); close(); const ed = opts.getEditor(); if (ed) ed.focus(); return; }
      // Clamped at 0 on an empty list too: -1 would leave rows that arrive later unselectable (Codex R1-B2).
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        state.active = Math.max(0, Math.min(items.length - 1, state.active + (e.key === 'ArrowDown' ? 1 : -1)));
        renderListOnly();
        const on = shadow.querySelector('.pp-item.on');
        if (on) on.scrollIntoView({ block: 'nearest' });   // the list follows the keyboard
        return;
      }
      const cur = items[state.active];
      if (e.key === 'Enter' && !e.isComposing && cur && cur.kind !== 'undo') { e.preventDefault(); use(cur.p, cur.kind); }
    }

    function onOutside(e) {
      if (host && !e.composedPath().includes(host)) close();
    }

    function isOpen() { return !!(shadow && shadow.querySelector('.pp')); }

    function open(src) {
      if (destroyed || !enabledOpt || !opts.getEditor()) return;
      endIntro('opened');   // opened another way (shortcut) while the spotlight is up
      rememberSelection();
      ensureHost();
      if (!isOpen()) { shadow.appendChild(el('div', 'pp')); }
      state.query = ''; state.active = 0;
      render();
      document.addEventListener('mousedown', onOutside, true);
      listenComposer(true);
      track('prompt_picker_open', { src });
      load();
    }

    function close() {
      state.newId = null; state.saveNote = null;
      dropDeleted();
      const pp = shadow && shadow.querySelector('.pp');
      if (pp) pp.remove();
      document.removeEventListener('mousedown', onOutside, true);
      listenComposer(false);
    }

    /** The strip's bookmark chip (light DOM of the strip's shadow root — styled by the strip's CSS class). */
    // Bookmark glyphs (Feather/Lucide paths): the strip's picker = a bookmark, a message's save = bookmark-plus
    // → filled bookmark once saved — one picture links 「saved here」 to 「taken out there」. SVG, not emoji
    // (user feedback 2026-10-05: in-page UI wears the site's quiet line icons; #2551).
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const BOOKMARK_PATH = 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z';
    function bookmarkIcon(plus, filled) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', filled ? 'currentColor' : 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      const paths = [BOOKMARK_PATH].concat(plus && !filled ? ['M12 7v6', 'M9 10h6'] : []);
      for (const d of paths) { const path = document.createElementNS(SVG_NS, 'path'); path.setAttribute('d', d); svg.appendChild(path); }
      return svg;
    }

    // ── first-visit spotlight ─────────────────────────────────────────────────────────────────
    // The first time the strip's chip is on screen on each site, a pulsing ring around it and a bubble above it
    // say what it is — once per site (2026-10-25 user request: 「처음 방문 때 눈에 띄게 한 번」). Drawn in our own
    // shadow host (never the site's DOM) and following the chip; gone on its click, the bubble's ×, or INTRO_SHOW_MS.
    let lastChip = null;            // the strip's newest chip (a re-render makes a new one)
    let introPhase = 'idle';        // idle → waiting → showing → done
    let introTries = 0, introTimer = null, introTrack = null, introRing = null, introBubble = null, introEditor = null;
    // The bubble sits over the composer's lower edge: typing ends it. On the composer element only — never a
    // document/window input listener (test/compare-privacy-guard.mjs [8]).
    const onIntroTyping = () => endIntro('typed');
    // On the composer's WRAPPER (opts.anchor — the box around the editor): an input from an editor the site swapped in
    // still bubbles up to it (R1-B3). Re-bound by the follow loop if the wrapper itself is replaced.

    /** Shown only when the chip is really visible: in the page, laid out, inside the viewport, tab in front. */
    function chipOnScreen() {
      const c = lastChip;
      if (!c || !c.isConnected || document.visibilityState !== 'visible') return false;
      const r = c.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
    }

    function maybeIntro() {
      if (introPhase !== 'idle' || destroyed || !enabledOpt) return;
      introPhase = 'waiting';
      introTimer = setTimeout(introWait, INTRO_DELAY_MS);
    }

    function introWait() {
      introTimer = null;
      if (destroyed) { introPhase = 'done'; return; }
      if (!enabledOpt) { introPhase = 'idle'; introTries = 0; return; }   // switched off: the next chip (if on again) retries
      if (!enabledKnown) {   // the stored switch not read yet: look again (counts as a try)
        if (++introTries < INTRO_WAIT_TRIES) introTimer = setTimeout(introWait, INTRO_DELAY_MS);
        else { introPhase = 'idle'; introTries = 0; }
        return;
      }
      if (!chipOnScreen() || isOpen()) {
        // Not yet (hidden tab, chip off screen, picker already open): look again a few times, then let the next chip retry.
        if (++introTries < INTRO_WAIT_TRIES) introTimer = setTimeout(introWait, INTRO_DELAY_MS);
        else { introPhase = 'idle'; introTries = 0; }
        return;
      }
      claimIntro();
    }

    // 「Once per site」 across tabs and windows is decided in ONE place: the background (bg/prompts.js intro_claim)
    // checks-and-marks per site in a serialized queue, so of two tabs asking at once exactly one gets yes — per-tab
    // storage reads and writes kept leaving gaps (Codex R1-B1, R2-B1/B2). Asked only while the chip is on screen.
    function claimIntro() {
      send({ op: 'intro_claim', site }).then((r) => {
        if (!r || !r.ok) { introPhase = 'done'; return; }   // already shown somewhere (or no background)
        if (destroyed) { send({ op: 'intro_release', site }); return; }   // re-injected meanwhile: let the next instance show it (R2-B3)
        // Hidden / opened during the round trip: give it back and wait again (R3 후속) — never shown unseen.
        if (!enabledOpt || !chipOnScreen() || isOpen()) { send({ op: 'intro_release', site }); introPhase = 'waiting'; introTimer = setTimeout(introWait, INTRO_DELAY_MS); return; }
        showIntro();
      });
    }

    function showIntro() {
      introPhase = 'showing';
      ensureHost();
      introRing = el('div', 'pp-ring');
      introBubble = el('div', 'pp-intro');
      introBubble.setAttribute('role', 'status');
      introBubble.appendChild(el('b', null, t('intro_title')));
      introBubble.appendChild(el('span', null, t('intro_body')));
      introBubble.appendChild(el('span', 'pp-intro-by', INTRO_BY));   // who made it (2026-10-25 user request)
      const x = el('button', 'pp-intro-x', '×');
      x.type = 'button'; x.title = t('close'); x.setAttribute('aria-label', t('close'));
      x.addEventListener('click', (e) => { e.stopPropagation(); endIntro('closed'); });
      introBubble.appendChild(x);
      introBubble.addEventListener('mousedown', (e) => e.preventDefault());   // keep the composer's caret
      introBubble.addEventListener('click', () => { endIntro('clicked'); rememberSelection(); open('intro'); });
      shadow.appendChild(introRing);
      shadow.appendChild(introBubble);
      placeIntro();
      introTrack = setInterval(placeIntro, INTRO_TRACK_MS);
      bindIntroEditor();
      introTimer = setTimeout(() => endIntro('timeout'), INTRO_SHOW_MS);
      track('prompt_intro', { action: 'shown' });
    }

    /** Ring on the chip, bubble above it (below when there is no room), its arrow pointing at the chip. */
    function placeIntro() {
      if (!introRing || !introBubble) return;
      bindIntroEditor();   // the site may have swapped the composer since (R1-B3)
      const c = lastChip;
      const r = c && c.isConnected ? c.getBoundingClientRect() : null;
      const shown = !!(r && r.width > 0);
      introRing.style.display = introBubble.style.display = shown ? '' : 'none';
      if (!shown) return;
      Object.assign(introRing.style, { left: (r.left - INTRO_RING_PAD) + 'px', top: (r.top - INTRO_RING_PAD) + 'px',
        width: (r.width + 2 * INTRO_RING_PAD) + 'px', height: (r.height + 2 * INTRO_RING_PAD) + 'px' });
      const bw = introBubble.offsetWidth, bh = introBubble.offsetHeight;
      const left = Math.max(VIEWPORT_MARGIN, Math.min(r.left + r.width / 2 - bw / 2, innerWidth - bw - VIEWPORT_MARGIN));
      const above = r.top - bh - INTRO_GAP >= VIEWPORT_MARGIN;
      introBubble.style.left = left + 'px';
      introBubble.style.top = (above ? r.top - bh - INTRO_GAP : r.bottom + INTRO_GAP) + 'px';
      introBubble.classList.toggle('below', !above);
      introBubble.style.setProperty('--ax', (r.left + r.width / 2 - left) + 'px');
    }

    function bindIntroEditor() {
      const ed = (opts.anchor && opts.anchor()) || opts.getEditor();
      if (ed === introEditor) return;
      if (introEditor) introEditor.removeEventListener('input', onIntroTyping);
      introEditor = ed;
      if (ed) ed.addEventListener('input', onIntroTyping);
    }

    function endIntro(action) {
      if (introPhase !== 'showing') return;
      introPhase = 'done';
      clearTimeout(introTimer); clearInterval(introTrack); introTimer = introTrack = null;
      if (introEditor) { introEditor.removeEventListener('input', onIntroTyping); introEditor = null; }
      if (introRing) introRing.remove();
      if (introBubble) introBubble.remove();
      introRing = introBubble = null;
      if (!destroyed) track('prompt_intro', { action });
    }

    function button(className) {
      const b = el('button', className);
      b.appendChild(bookmarkIcon(false, false));
      b.appendChild(el('span', 'ct-prompt-btn-label', t('btn_label')));
      b.type = 'button';
      b.title = t('btn_tip', { key: shortcut() });
      b.setAttribute('aria-label', t('btn_tip', { key: shortcut() }));
      b.addEventListener('mousedown', (e) => { e.preventDefault(); rememberSelection(); });   // keep the caret
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); endIntro('clicked'); if (isOpen()) close(); else open('button'); });
      lastChip = b;
      maybeIntro();
      return b;
    }

    /** A bookmark-plus that saves a sent message — `getEl()` answers its bubble at click time (the per-message rows). */
    function starButton(className, getEl) {
      const b = el('button', className);
      b.appendChild(bookmarkIcon(true, false));
      b.type = 'button';
      b.title = t('star_tip');
      b.setAttribute('aria-label', t('star_tip'));
      b.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        if (b.disabled) return;
        b.disabled = true;
        const outcome = await saveText(blockText(getEl()), 'msg_row');
        b.disabled = false;
        if (outcome === 'saved' || outcome === 'dup') {
          b.replaceChildren(bookmarkIcon(true, true));
          b.title = t('star_done'); b.setAttribute('aria-label', t('star_done')); b.dataset.saved = '1';
        }
      });
      return b;
    }

    // The keyboard shortcut. Removed by destroy(): a strip superseded by a re-injection in the SAME live
    // extension context (ChatGPT / Gemini re-register) would otherwise open a second picker (Codex S2 R1-B1).
    // 「Claude / ChatGPT / Gemini」 on our prompt pages (#2584): the background opened this tab and offers the text
    // until we take it. Not gated on enabledOpt — that option hides the chip; the user asked for this either way
    // (2026-10-26). Never sent: the user reads it in the composer and presses send. The page already copied it,
    // so the fallback toast can say 「paste」.
    let webDone = false, webTries = 0;
    const onPage = (url) => { try { const u = new URL(url); return u.origin === location.origin && u.pathname === location.pathname; } catch { return false; } };
    function insertFromWeb(text, url, reply) {
      if (webDone) { reply({ ok: true }); return; }   // a retried offer after our answer was lost
      if (!onPage(url)) { reply({ ok: false, retry: true }); return; }   // another page: not ours to type into — the background waits (R1-B3)
      const ed = opts.getEditor();
      if (!ed) { reply({ ok: false, retry: true }); return; }
      state.range = null;                              // a fresh composer: at the end
      if (insertText(text)) {
        webDone = true;
        reply({ ok: true });
        track('prompt_insert', { kind: 'web', result: 'ok' });
        // Only a composer the SITE replaced (a new element, still empty, same page) gets it again — the user
        // clearing it or sending it (→ another URL) leaves it alone (Codex R1-B4).
        setTimeout(() => {
          const now = opts.getEditor();
          if (!destroyed && now && now !== ed && onPage(url) && !squash(composerText(now))) insertText(text);
        }, WEB_RECHECK_MS);
        return;
      }
      webTries += 1;
      const last = webTries >= WEB_INSERT_TRIES;
      reply({ ok: false, retry: !last });
      if (last) {
        webDone = true;
        toast(t('inserted_fallback'));
        track('prompt_insert', { kind: 'web', result: 'fallback_clipboard' });
      }
    }

    function onRuntimeMessage(m, _sender, sendResponse) {
      if (!destroyed && m && m.type === INSERT_MSG && typeof m.text === 'string') { insertFromWeb(m.text, m.url, sendResponse); return false; }
      if (!destroyed && enabledOpt && m && m.type === OPEN_MSG && document.visibilityState === 'visible') {
        if (isOpen()) close(); else open('shortcut');
      }
      return false;
    }
    try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch { /* context dead */ }
    // The extension's language changed while the picker is open (Codex R1-B1): load() drops a list of the old
    // language and asks again — also after a failed 추천 load, which left no list to compare (R2-B1) — then redraw.
    // On the next task, so the strip's own onChanged has already updated opts.lang(). Removed by destroy() too.
    function onStorageChanged(changes, area) {
      if (!destroyed && area === 'sync' && changes.promptButtonEnabled) { enabledChangeSeen = true; enabledKnown = true; setEnabled(changes.promptButtonEnabled.newValue !== false); }
      if (!destroyed && area === 'sync' && changes.lang && isOpen()) setTimeout(() => { if (!destroyed && isOpen()) { load(); render(); } }, 0);
    }
    try { chrome.storage.onChanged.addListener(onStorageChanged); } catch { /* context dead */ }

    /** For the strip's teardown: closes, stops listening, and leaves its chips inert. */
    function setEnabled(on) {
      if (on === enabledOpt) return;
      enabledOpt = on;
      if (!on) { endIntro('disabled'); close(); }
      if (opts.onEnabledChange) { try { opts.onEnabledChange(); } catch { /* the strip's own problem */ } }
    }
    try {
      chrome.storage.sync.get({ promptButtonEnabled: true }, (cfg) => {
        void chrome.runtime.lastError;
        if (destroyed || enabledChangeSeen) return;   // a change already told us the newer value
        enabledKnown = true;
        setEnabled(!cfg || cfg.promptButtonEnabled !== false);
        // The spotlight may have given up waiting for this answer (slow read): start it again for the chip on screen (R2-B1).
        if (enabledOpt && lastChip && introPhase === 'idle') maybeIntro();
      });
    } catch { /* context dead */ }
    function enabled() { return enabledOpt; }

    function destroy() {
      destroyed = true;
      endIntro('destroyed');
      clearTimeout(introTimer);
      close();
      try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* context dead */ }
      try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { /* context dead */ }
    }

    return { button, starButton, open, close, destroy, enabled, saveText, isOpen };
  }

  globalThis.__ctPromptPicker = { create, OPEN_MSG, HOST_ID };
})();
