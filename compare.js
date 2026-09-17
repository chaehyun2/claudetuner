// compare.html — send one question to every AI the user is signed in to and stream the answers
// side by side (issue #1452, plan docs/plans/multi-ai-compare.md).
//
// This file is the PAGE half of the contract in .omc/handoffs/phase3-contract.md. The service
// worker half (bg/compare.js) owns tabs, the vendored web-session clients and the quota calls; this
// page only talks to it:
//   chrome.runtime.sendMessage({type:'COMPARE_STATUS'})            → who is logged in / permitted, quota,
//                                                                     models catalog + selectedModels (v1.31 addendum)
//   chrome.runtime.connect({name:'ctcmp-compare'})                  → SEND / FOLLOWUP (+ `models` map) / ABORT out,
//                                                                     CONSUME_OK|CONSUME_FAIL / CHUNK / MODEL / DONE(.model) / ERROR(.reason/.detail) / DIAG / ALL_DONE / MODELS in
//   chrome.permissions.request({origins:[…]})                        → from a click handler only (AC16)
//
// Framed by the claudetuner.com web shell (site/multiai/, #1453): ui/embed-ready.js runs first and
// resolves the allowed host into `window.__ctEmbedHost`; this page then (a) applies `{__ctTheme}`
// messages from THAT origin and parent only, (b) falls back to a real extension tab when the
// permission prompt cannot be shown from inside the frame. Not framed → `__ctEmbedHost` is null and
// none of it runs.
//
// 🔴 Model text is rendered ONLY through ui/md-lite.js (createElement/textContent). There is no
// innerHTML anywhere in this file — test/compare-xss-guard.mjs greps for it.
//
// 🔴 Zero sendable columns → the send button is disabled AND `connect` is never called (AC17): the
// consume call lives behind the port, so "never open the port" is what makes "no consume" true.
// test/compare-page-flow-guard.mjs asserts both halves.
//
// Structure: `mountComparePage(deps)` takes every platform object it touches (chrome, document,
// location, raf, clock, navigator) so the flow guard can drive it with fakes; the bootstrap at the
// bottom wires the real ones.
//
// Page shape (2026-09-17 UX pass): topbar (중지 · 새 대화) → notices → question card (composer until
// the first CONSUME_OK, then the frozen prompt + copy button + the THREAD follow-up composer) →
// columns (each turn carries a copy button for its raw text) → the BOTTOM follow-up composer,
// docked to the viewport bottom. Both composers are one model (makeFollowupComposer). 새 대화
// closes the port — the SW contract makes that the session's end — and rebuilds the pre-send state.
//
// UX batch 3 (2026-09-17, .omc/handoffs/ux3-contract.md): the column head's provider name links
// to the site (B) and shows the account plan from COMPARE_STATUS.providers[p].plan (A); follow-up
// routing is a checkbox set + 「전체」 (C, `state.followupTargets`); the history toggle is
// 「시크릿 대화」 (D — checked ⇔ SEND saveHistory:false; `html[data-incognito="1"]` tints the page)
// and a kept session survives a lost port: DONE.continuation is remembered per column and the
// next follow-up opens a NEW port whose first message is SEND{resume} (D3, see canResume());
// usage analytics go out as COMPARE_EVENT (E, track()); a composer laid out at zero width never
// commits a height (H); every copy is visible (I).

import { renderMarkdown } from './ui/md-lite.js';
import { COMPARE_I18N, makeT, resolveLang } from './ui/compare-i18n.js';

export const COMPARE_PORT_NAME = 'ctcmp-compare';
export const COMPARE_PROVIDERS = ['claude', 'gemini', 'chatgpt'];
export const PROVIDER_META = {
  claude: { label: 'Claude', site: 'https://claude.ai/', origin: 'https://claude.ai/*' },
  gemini: { label: 'Gemini', site: 'https://gemini.google.com/', origin: 'https://gemini.google.com/*' },
  chatgpt: { label: 'ChatGPT', site: 'https://chatgpt.com/', origin: 'https://chatgpt.com/*' },
};
const SITE_URL = 'https://claudetuner.com';
// The welcome page carries the extension sign-in flow (Google + email code) — the same entry the
// popup's login CTA leads to. ui/login-cta.js itself is not reusable here: it imports the popup's
// block-state / provider-state modules and reads popup-only storage.
export const LOGIN_URL = `${SITE_URL}/welcome/`;
// Same shape as the folders upgrade link (claude-folders.js): dashboard + `upgrade=<feature>`.
export const PRO_URL = `${SITE_URL}/dashboard/?upgrade=compare&utm_source=compare`;
// The 「전체」 chip's value in the follow-up routing set (every participating column checked).
const FOLLOWUP_ALL = 'all';
// Copy kinds reported to analytics (contract E `copy{kind, provider}`): the frozen question, one
// assistant answer, one user follow-up turn (a question inside the thread), one column's whole
// thread, the whole comparison.
const COPY_KIND_QUESTION = 'question';
const COPY_KIND_TURN = 'turn';
const COPY_KIND_THREAD = 'thread';
const COPY_KIND_COLUMN = 'column';
const COPY_KIND_ALL = 'all';
// The message type analytics ride on (contract E): the SW validates and forwards to GA4.
const EVENT_MSG_TYPE = 'COMPARE_EVENT';
// Two follow-up composers share ONE model (see makeFollowupComposer): the bottom one keeps the
// original ids (the flow guard drives them), the one under the frozen question gets this suffix.
const FOLLOWUP_ID_BOTTOM = '';
const FOLLOWUP_ID_TOP = '-top';
// How long a copy button says 「복사됨」 before it turns back into the icon.
const COPY_FEEDBACK_MS = 1500;
const SVG_NS = 'http://www.w3.org/2000/svg';
// A model catalog entry with `id:null` is the provider's own default ("Auto"); it travels as this
// option value and back to null on the wire (contract: `models: { [provider]: id|null }`).
const MODEL_AUTO_VALUE = '';
const MODEL_SOURCE_REQUESTED = 'requested';
// Follow-up textarea grows with its content up to this many pixels, then scrolls (CSS max-height matches).
const COMPOSER_MAX_HEIGHT = 200;
// Streaming scroll, ChatGPT/Claude-style (ported from dowoo sidepanel.js maybeFollowStream, 2026-09-18):
// a column follows the growing answer only while the answer still FITS its body; the first time
// the answer overflows, its START is anchored just under the head ONCE and the rest streams in
// below the fold — the view is never yanked down chunk by chunk. A manual scroll-up stops the
// follow too. Whenever the reader is not at the end of a column that has content, a 「↓ 새 내용」
// pill sits at the bottom of that column and jumps to the end. Distances in px.
const FOLLOW_AT_BOTTOM_PX = 50;   // this close to the end counts as "at the bottom"
const FOLLOW_ANCHOR_TOP_PX = 16;  // where the overflowing answer's start is anchored (below the body top)
// Auto-reconnect (login guidance): a status re-read on focus / visibility / bfcache restore while
// some column is gated, at most one per this many ms and never while a session runs.
const AUTO_REFRESH_MIN_MS = 3000;
// Gate kinds a column body can show before it takes part (renderColumnGate).
const GATE_PERMISSION = 'permission';
const GATE_LOGIN = 'login';
const GATE_UNKNOWN = 'unknown';
const GATE_JOINED = 'joined';
// Who put the current notice up: a status read may replace only its own (the extension-login
// notice, a status-call error, the zero-targets hint) — never a consume error or the quota
// notice, which describe something the user has to act on (Codex b2 2R #2).
const NOTICE_OWNER_PAGE = 'page';
const NOTICE_OWNER_STATUS = 'status';
// A consume-time 401/403 notice: page-owned, but a status read that finds the extension signed in
// again resolves exactly it (Codex b2 3R #2).
const NOTICE_OWNER_LOGIN = 'login';
// The auto-reconnect listeners of the mount that owns a document: a remount (the flow guard, a
// hot reload) removes the previous mount's before adding its own, and coming-soon removes them
// for good (Codex b2 2R #3).
const AUTO_REFRESH_LISTENERS = new WeakMap(); // document → { win, doc, focus, pageshow, visibility }
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY = 429;
const CODE_COMPARE_QUOTA = 'compare_quota';
const CODE_RATE_LIMITED = 'rate_limited';
const CODE_NO_TARGETS = 'no_targets';
// CONSUME_FAIL codes the SW emits besides the HTTP ones (PR #1459): a send already in flight, the
// consume request itself failed, Stop pressed before the debit (free — nothing was counted).
const CODE_BUSY = 'busy';
const CODE_NETWORK_ERROR = 'network_error';
const CODE_ABORTED = 'aborted';
// Page-local pseudo code: the port that carried the session is gone (never sent by the SW).
const CODE_SESSION_ENDED = 'session_ended';
// 🔴 MV3 service-worker lifetime (Chrome 110+): the extension SW is killed after ~30 s with no
// EVENTS; an open runtime.connect port does NOT keep it alive — only a message arriving on it
// (an onMessage event) resets the idle timer. The session's clients live in that SW, so a page
// that goes quiet after ALL_DONE loses the session (port disconnect → 「연결이 끊겨…」) before the
// user types a follow-up. Hence the keepalive: a PING on the port every KEEPALIVE_MS while a
// session is live (the SW ignores unknown message types — no SW change needed), stopped after
// KEEPALIVE_MAX_IDLE_MS without user activity so an abandoned tab does not pin the SW forever.
// Do not remove without another mechanism that resets the SW idle timer.
export const PORT_MSG_PING = 'PING';
export const KEEPALIVE_MS = 20_000;
export const KEEPALIVE_MAX_IDLE_MS = 30 * 60_000;
// Page-local pseudo code: the send could not be handed to the SW (connect/postMessage threw, or the
// port died before consume). Retry is allowed — nothing was consumed.
const CODE_SEND_FAILED = 'send_failed';
// Provider-side rate limit shares the code name with the server's; the copy differs.
const PROVIDER_RATE_LIMIT_KEY = 'err_rate_limited_provider';
// Provider errors that mean "the tab is gone", which the next send repairs by itself (bg/compare.js
// prepares every FOLLOWUP target with mayOpenTab:true). Such a column is retried by 「전체」 —
// whatever the `reason` (a no_tab that timed out loading or was still settling is cured by the
// resend just the same; the copy differs, the routing does not).
const TAB_LOST_CODES = new Set(['bridge_disconnected', 'no_tab']);
// A column that ended in no_tab (whatever the reason) offers to open the provider's site next to
// the retry — the SW re-opens a tab on FOLLOWUP anyway, but a user-opened, signed-in tab is the
// surer fix (batch 2).
const CODE_NO_TAB = 'no_tab';
// Timed send-path stages (bg/compare.js, package v0.3.0) the badge reads: DIAG{stage, detail.at}.
// first_chunk − send_start = time to first token; stream_done − send_start = the whole answer.
const STAGE_SEND_START = 'send_start';
const STAGE_FIRST_CHUNK = 'first_chunk';
const STAGE_STREAM_DONE = 'stream_done';
const TTFT_STAGES = new Set([STAGE_SEND_START, STAGE_FIRST_CHUNK, STAGE_STREAM_DONE]);
// DIAG stage the client reports when it starts a tool (web search) — the badge says 「웹 검색 중…」.
const STAGE_TOOL_USE = 'tool_use';
const BADGE_SEARCHING = 'col_searching';
// A duration above this is not a measurement (a clock jump, an absurd timestamp) — no number.
const TTFT_MAX_MS = 60 * 60 * 1000;
// Waiting-time badge: the badge key of the "after CONSUME_OK, before the first CHUNK" state, how
// often its seconds are repainted, and how long a wait must be before a number is worth showing.
const BADGE_WAITING = 'col_waiting';
const WAIT_TICK_MS = 1000;
const WAIT_ELAPSED_SHOW_MS = 3000;
const MS_PER_SECOND = 1000;
// ERROR also carries the client's machine-readable `reason` (package v0.2.3; today only no_tab has
// one) and `detail` (the raw package message). Copy is looked up as err_<code>_<reason> when such a
// key exists, else err_<code>; the raw cause goes into the error line's `title` so hovering shows
// what the client actually said (the SW console has the same line — bg/compare.js LOG_TAG).
const ERROR_TITLE_MAX = 300;
// Theme values the web shell may post as `{__ctTheme}` (site/multiai/multiai.js) — anything else is ignored.
const EMBED_THEME_LIGHT = 'light';
const EMBED_THEME_DARK = 'dark';

/** sendMessage as a promise, whether the fake/real runtime answers via callback or promise. */
function sendMessage(chrome, msg) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const r = chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; done(res); });
      if (r && typeof r.then === 'function') r.then(done, () => done(undefined));
    } catch { done(undefined); }
  });
}

/** Local HH:MM for an ISO timestamp; '' when unparseable. */
export function localHHMM(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Vertical border of `el` in px (0 where there is no layout engine — mini-dom). */
function borderY(el) {
  const view = el.ownerDocument && el.ownerDocument.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return 0;
  const cs = view.getComputedStyle(el);
  return (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
}

/**
 * Auto-grow a composer textarea to its content, capped by COMPOSER_MAX_HEIGHT (then it scrolls).
 * `scrollHeight` excludes the border while the height we set includes it (the page is
 * border-box, compare.css `*`), so the border is added back — without it the box ends 2px short
 * and multi-line text shows a scrollbar (Codex 2R #3).
 */
function autoGrow(textarea) {
  // 🔴 Item 4 (contract H): a textarea laid out at ZERO WIDTH — the page mounted inside a frame the
  // shell has not sized yet — wraps its placeholder / `?q` one character per line, so scrollHeight
  // is the cap (measured: 198 → the 200px cap committed at load, 46px after the first keystroke).
  // A height measured without a width is not a measurement: leave the box alone (min-height
  // rules) and let watchComposerWidth() re-run this once the textarea has a width.
  if (textarea.clientWidth === 0) return;
  textarea.style.height = 'auto';
  const h = textarea.scrollHeight;
  if (Number.isFinite(h) && h > 0) textarea.style.height = `${Math.min(h + borderY(textarea), COMPOSER_MAX_HEIGHT)}px`;
}

/**
 * Re-run autoGrow whenever the textarea's WIDTH changes (a frame that gets its size after load, a
 * composer that becomes visible, a window resize) — wrapping, and so the right height, depends on
 * the width. ResizeObserver where the platform has one (gated on the width so the height it sets
 * never re-triggers it), else `window.resize`. mini-dom has neither: nothing is installed.
 */
function watchComposerWidth(textarea, win) {
  const RO = win && typeof win.ResizeObserver === 'function' ? win.ResizeObserver : null;
  if (RO) {
    let lastWidth = -1;
    try {
      new RO((entries) => {
        const width = entries && entries[0] && entries[0].contentRect ? entries[0].contentRect.width : textarea.clientWidth;
        if (width === lastWidth) return;
        lastWidth = width;
        autoGrow(textarea);
      }).observe(textarea);
      return;
    } catch { /* observe() refused — fall through to the window event */ }
  }
  if (win && typeof win.addEventListener === 'function') win.addEventListener('resize', () => autoGrow(textarea));
}

/**
 * Composer keys, shared by the question card and the follow-up box: Enter sends, Shift+Enter
 * breaks the line. An Enter that ends IME composition (Korean / Japanese input) must not send —
 * `isComposing` (or legacy keyCode 229) marks it. `onInput` runs after every edit (auto-grow done).
 */
function bindComposer(textarea, onSend, onInput, win) {
  textarea.addEventListener('input', () => { autoGrow(textarea); if (onInput) onInput(); });
  textarea.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    onSend();
  });
  watchComposerWidth(textarea, win);
}

/** Providers the page may send to: permitted + logged in, minus the source when excluded. */
/** The web shell origin ui/embed-ready.js resolved for this frame, or null (not framed / not an allowed host). */
function embedHostOf(win) {
  return win && typeof win.__ctEmbedHost === 'string' ? win.__ctEmbedHost : null;
}

/**
 * Framed by the web shell: apply `{__ctTheme:'light'|'dark'}` posted by the HOST page. Installed at
 * module evaluation — synchronously, before the async storage read that mounts the page — because
 * the shell posts the theme on the iframe's `load` event, which fires after this module ran but
 * possibly before that callback. 🔴 Both the origin AND the source window are pinned: accepted from
 * the framing page only, never from a sibling frame or an opener. Not framed → nothing is installed.
 */
export function listenEmbedTheme(win, doc) {
  const host = embedHostOf(win);
  if (!host || typeof win.addEventListener !== 'function') return false;
  win.addEventListener('message', (e) => {
    if (e.origin !== host || e.source !== win.parent) return;
    const theme = e.data && e.data.__ctTheme;
    if (theme === EMBED_THEME_LIGHT || theme === EMBED_THEME_DARK) doc.documentElement.setAttribute('data-theme', theme);
  });
  return true;
}

export function sendableTargets(status, src, excludeSrc) {
  if (!status || !status.providers) return [];
  return COMPARE_PROVIDERS.filter((p) => {
    const s = status.providers[p];
    if (!s || !s.permitted || !s.loggedIn) return false;
    if (excludeSrc && p === src) return false;
    return true;
  });
}

export function mountComparePage(deps) {
  const { chrome, document: doc, location, lang = 'en', window: win = null } = deps;
  const raf = deps.raf || ((fn) => setTimeout(fn, 0));
  // Wall clock + interval + timeout, injectable so the flow guard can drive the waiting-time badge
  // and the copy-button feedback without real time passing.
  const clock = {
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    ...(deps.clock || {}),
  };
  // The clipboard lives on navigator; injectable (the flow guard has no real one), else the
  // page's, else absent — copy then falls back to execCommand, and past that does nothing.
  const nav = deps.navigator || (win && win.navigator) || null;
  // Diagnostics only (the port-loss line): injectable so the flow guard can read it.
  const con = deps.console || (typeof globalThis !== 'undefined' ? globalThis.console : null) || null;
  const t = makeT(lang);
  const root = doc.getElementById('compare-root');
  if (!root) return null;
  doc.title = t('page_title');
  doc.documentElement.setAttribute('lang', lang);

  // ── embedded in the claudetuner.com web shell ──
  // The host origin comes from ui/embed-ready.js (one allowlist, resolved before any module ran);
  // the theme listener is installed at module evaluation (listenEmbedTheme), not here.
  const embedHost = embedHostOf(win);
  /** Open THIS page (same query) as a top-level extension tab — the fallback when the frame cannot show a prompt. */
  function openInExtensionTab() {
    try { chrome.tabs.create({ url: chrome.runtime.getURL(`compare.html${location.search || ''}`) }); } catch { /* tabs API unavailable */ }
  }

  const params = new URLSearchParams(location.search || '');
  const src = COMPARE_PROVIDERS.includes(params.get('src')) ? params.get('src') : null;
  const q = (params.get('q') || '').trim();

  const state = {
    status: null,
    excludeSrc: false,
    saveHistory: false,   // the wire value (SEND `saveHistory`): from status.saveHistory until the user touches the 「시크릿 대화」 toggle (checked ⇔ false); fixed per session
    saveTouched: false,   // the user toggled it on this page (a status re-read no longer overrides it)
    sessionSaveHistory: null, // what the first SEND of the current session carried (the topbar chip)
    port: null,
    sending: false,       // a SEND/FOLLOWUP is in flight (until ALL_DONE or CONSUME_FAIL)
    sessionStarted: false, // SEND has been accepted at least once (follow-ups allowed)
    sessionEnded: false,  // the port that carried this session is gone — the SW disposed its clients (a kept session may still resume, canResume())
    resuming: false,      // a SEND{resume} is on a fresh port and awaits its CONSUME_OK (D3)
    resumed: false,       // the session rode a SEND{resume} at least once: a column without a continuation is dead for good (batch-3 Codex #1)
    disabled: false,      // coming-soon rendered: every send path is inert (AC24), even via kept refs
    columns: new Map(),   // provider → column record
    followupTargets: new Set(), // providers the next follow-up goes to (C); every participant checked = 「전체」 (AC21 skip rule)
    question: '',         // the first-round text as sent (snapshot at click; the card freezes to it on CONSUME_OK)
    pendingFollowup: '',  // follow-up text in flight, restored to the input on CONSUME_FAIL
    modelChoice: {},      // provider → model id | null (the header <select>), sent as SEND/FOLLOWUP `models`
    roundTargets: [],     // providers the in-flight / last round was sent to (col.round is the rollback snapshot and dies at CONSUME_OK)
    rounds: 0,            // rounds accepted (CONSUME_OK) in this session — analytics `send.round`
    roundStartedAt: null, // clock.now() at the last beginSend — analytics `round_done.ms`
    checking: false,      // a COMPARE_STATUS read is in flight (gates show 「확인 중…」)
    notice: null,         // { kind, owner } of the notice on screen (see NOTICE_OWNER_*), null when none
    idleEnded: false,     // the keepalive stopped for lack of activity (the session then dies by itself: idle copy)
  };

  /**
   * Usage analytics (contract E): one fire-and-forget message per event; the SW validates the
   * name against its allowlist, bounds the params and forwards to GA4. Never throws, never awaited,
   * and 🔴 never carries the question / answer text or an email — only shapes and counts.
   */
  function track(name, params) {
    try {
      const r = chrome.runtime.sendMessage({ type: EVENT_MSG_TYPE, name, params: params && typeof params === 'object' ? params : {} }, () => { void chrome.runtime.lastError; });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* the runtime is gone (update / reload) — analytics are not worth an error */ }
  }

  // ── small DOM helpers (createElement/textContent only) ──
  const el = (tag, className, text) => {
    const e = doc.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const link = (href, text, className) => {
    const a = el('a', className, text);
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    return a;
  };
  /** Provider mark: a brand-coloured dot (CSS keys off data-mark; data-provider stays the column's selector) — no logos. */
  const dot = (provider) => {
    const d = el('span', 'cmp-dot');
    d.setAttribute('data-mark', provider);
    d.setAttribute('aria-hidden', 'true');
    return d;
  };

  // ── skeleton ──
  clear(root);
  const topbar = el('header', 'cmp-topbar');
  topbar.appendChild(el('h1', 'cmp-title', t('heading')));
  if (src) {
    const chip = el('span', 'cmp-src-chip');
    chip.appendChild(dot(src));
    chip.appendChild(el('span', null, t('question_from', PROVIDER_META[src].label)));
    topbar.appendChild(chip);
  }
  // Mid-session the action row is gone, so the session's history mode shows here: 「기록 남김」 /
  // 🕶 「시크릿 대화」, from what the first SEND carried (the toggle cannot change it any more).
  const modeChip = el('span', 'cmp-src-chip cmp-mode-chip');
  modeChip.id = 'cmp-mode';
  modeChip.hidden = true;
  const modeGlyph = el('span', 'cmp-incognito-glyph', '🕶');
  modeGlyph.setAttribute('aria-hidden', 'true');
  const modeText = el('span');
  modeChip.appendChild(modeGlyph);
  modeChip.appendChild(modeText);
  topbar.appendChild(modeChip);
  const topbarSide = el('div', 'cmp-topbar-side');
  const quotaLine = el('div', 'cmp-quota');
  quotaLine.id = 'cmp-quota';
  quotaLine.setAttribute('aria-live', 'polite');
  topbarSide.appendChild(quotaLine);
  // Copy all (batch 2): one markdown document of the whole comparison — see compareMarkdown().
  // Enabled once at least one column holds an answer.
  const copyAllBtn = el('button', 'cmp-btn cmp-btn-sm cmp-btn-copy-all', t('copy_all'));
  copyAllBtn.id = 'cmp-copy-all';
  copyAllBtn.type = 'button';
  copyAllBtn.disabled = true;
  topbarSide.appendChild(copyAllBtn);
  const stopBtn = el('button', 'cmp-btn cmp-btn-sm cmp-btn-stop', t('stop'));
  stopBtn.id = 'cmp-stop';
  stopBtn.type = 'button';
  stopBtn.disabled = true;
  topbarSide.appendChild(stopBtn);
  // New chat: ends this session (port closed → the SW disposes the temporary conversations) and
  // hands the page back to its pre-send shape. Disabled until a session exists to leave.
  const newChatBtn = el('button', 'cmp-btn cmp-btn-sm cmp-btn-new', t('new_chat'));
  newChatBtn.id = 'cmp-new-chat';
  newChatBtn.type = 'button';
  newChatBtn.disabled = true;
  topbarSide.appendChild(newChatBtn);
  topbar.appendChild(topbarSide);
  root.appendChild(topbar);

  // ── copy to clipboard ──
  /**
   * Copy `text`: navigator.clipboard first, the execCommand textarea as the fallback (older
   * contexts, or the async API refusing because the document lost focus). Resolves true only
   * when one of them reported success; never throws (mini-dom has neither).
   */
  async function copyText(text) {
    try {
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') { await nav.clipboard.writeText(text); return true; }
    } catch { /* denied / no focus → try the legacy path */ }
    if (typeof doc.execCommand !== 'function') return false;
    // Selecting the scratch textarea steals focus (and a text control's selection) from wherever
    // the user was — a half-typed follow-up, say. Remember it, put it back afterwards (Codex 1R #3).
    const active = doc.activeElement || null;
    const hadSelection = !!active && typeof active.selectionStart === 'number' && typeof active.setSelectionRange === 'function';
    const selStart = hadSelection ? active.selectionStart : 0;
    const selEnd = hadSelection ? active.selectionEnd : 0;
    const ta = el('textarea', 'cmp-clip');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(ta);
    let copied = false;
    try {
      if (typeof ta.select === 'function') ta.select();
      copied = !!doc.execCommand('copy');
    } catch { copied = false; } finally {
      ta.remove();
      if (active && active !== doc.body && typeof active.focus === 'function') {
        focusQuietly(active);
        if (hadSelection) { try { active.setSelectionRange(selStart, selEnd); } catch { /* not a text control any more */ } }
      }
    }
    return copied;
  }
  /** focus() without scrolling the page to the element; plain focus() where the option is unsupported; never throws. */
  function focusQuietly(node) {
    try { node.focus({ preventScroll: true }); } catch { try { node.focus(); } catch { /* not focusable */ } }
  }
  /** The copy glyph (two offset squares) — built with createElementNS; no markup string anywhere. */
  function copyIcon() {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linejoin', 'round');
    const back = doc.createElementNS(SVG_NS, 'rect');
    back.setAttribute('x', '5.5'); back.setAttribute('y', '5.5'); back.setAttribute('width', '8'); back.setAttribute('height', '8'); back.setAttribute('rx', '1.5');
    const front = doc.createElementNS(SVG_NS, 'path');
    front.setAttribute('d', 'M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2');
    svg.appendChild(back);
    svg.appendChild(front);
    return svg;
  }
  /**
   * A ghost icon button that copies whatever `getText()` returns at click time — the RAW text of a
   * turn (`turn.text`, markdown source), never the rendered DOM. Success shows 「복사됨」 for
   * COPY_FEEDBACK_MS; a failed copy leaves the button as it was (nothing to undo, nothing to say).
   */
  // Every copy button whose 「복사됨」 feedback is showing, with the timer that ends it — so a reset
  // (새 대화 / coming-soon) can end them all at once instead of letting a timer fire into the next
  // session (the question's button survives the reset and would keep saying 복사됨). `copyEpoch`
  // is bumped by those resets: a clipboard promise that resolves afterwards belongs to a session
  // that no longer exists and must show nothing (Codex 1R #5).
  const copyFeedback = new Map(); // btn → { timer, revert }
  let copyEpoch = 0;
  function clearCopyFeedback() {
    copyEpoch++;
    for (const { timer, revert } of copyFeedback.values()) { clock.clearTimeout(timer); revert(); }
    copyFeedback.clear();
  }
  /**
   * Wire `btn` to copy `getText()` on click with the shared feedback rules; `paint(copied)` draws
   * the button's two states (the icon button and the topbar 「전체 복사」 look different, the
   * timing / registry / epoch rules are one).
   */
  function attachCopy(btn, getText, paint, kind, provider) {
    const revert = () => { copyFeedback.delete(btn); btn.classList.remove('is-copied'); paint(false); };
    btn.addEventListener('click', async () => {
      const text = String(getText() || '');
      if (!text) return;
      track('copy', provider ? { kind, provider } : { kind });
      const epoch = copyEpoch;
      const copied = await copyText(text);
      if (!copied || epoch !== copyEpoch) return;
      const prev = copyFeedback.get(btn);
      if (prev) clock.clearTimeout(prev.timer);
      btn.classList.add('is-copied');
      paint(true);
      copyFeedback.set(btn, { timer: clock.setTimeout(revert, COPY_FEEDBACK_MS), revert });
    });
  }
  /**
   * A quiet copy button, ALWAYS visible (item 5: the hover-only ghost was never found). Icon plus
   * a text label when `label` is given (「답변 복사」 under an answer, 「대화 복사」 in a column
   * head); icon-only otherwise (a user turn, the frozen question) — its aria-label / title say
   * what it copies. The label reads 「복사됨」 for COPY_FEEDBACK_MS after a successful copy.
   */
  function copyButton(getText, { kind, provider = null, label = '', aria = '' } = {}) {
    const btn = el('button', 'cmp-copy' + (label ? ' cmp-copy-labelled' : ''));
    btn.type = 'button';
    btn.appendChild(copyIcon());
    const labelNode = el('span', 'cmp-copy-label');
    btn.appendChild(labelNode);
    const idle = aria || label || t('copy');
    const paint = (copied) => {
      labelNode.textContent = copied ? t('copied') : label;
      btn.setAttribute('aria-label', copied ? t('copied') : idle);
      btn.title = copied ? t('copied') : idle;
    };
    paint(false);
    attachCopy(btn, getText, paint, kind, provider);
    return btn;
  }
  attachCopy(copyAllBtn, () => compareMarkdown(), (copied) => { copyAllBtn.textContent = t(copied ? 'copied' : 'copy_all'); }, COPY_KIND_ALL, null);

  /**
   * The whole comparison as ONE markdown document (batch 2, 「전체 복사」):
   *   # <question>   (a multi-line question: its first line as the heading, the whole of it as
   *                    a blockquote under it — a line of it can never read as a heading)
   *   ## <Provider> (<served model, when known>)   — participating columns, catalog order (an
   *   excluded source never participates: the checkbox locks at the first send)
   *   <raw assistant text of every turn>; a follow-up's question as `> **Q:** …` (EVERY line of
   *   it quoted) before its answer; an error as `_<error line>_` after whatever streamed; a
   *   skipped turn as `_건너뜀_`.
   * Blocks are joined by blank lines; nothing is escaped (it is the raw text, like the per-turn copy).
   */
  /** Every line quoted, the first one carrying the `**Q:**` mark — a line break cannot leave the quote. */
  const quoteLines = (text, first = '') => String(text).split('\n').map((line, i) => `> ${i === 0 ? first : ''}${line}`).join('\n');
  /**
   * ONE builder for both copies (item 5): the whole comparison (every participating column,
   * catalog order) and a single column's thread (「대화 복사」) are the same document over a
   * different column list — the question block is shared, so the two can never drift in shape.
   */
  function markdownFor(cols) {
    const qLines = String(state.question).split('\n');
    const blocks = [`# ${qLines[0]}`];
    if (qLines.length > 1) blocks.push(quoteLines(state.question));
    for (const col of cols) {
      const m = col.servedModel;
      const modelText = m ? String(m.label || m.id || '') : '';
      blocks.push(`## ${PROVIDER_META[col.provider].label}${modelText ? ` (${modelText})` : ''}`);
      for (const turn of col.turns) {
        if (turn.role === 'user') blocks.push(quoteLines(turn.text, '**Q:** '));
        else if (turn.role === 'skipped') blocks.push(`_${t('col_skipped')}_`);
        else {
          if (turn.text) blocks.push(turn.text);
          if (turn.errorText) blocks.push(`_${turn.errorText}_`);
        }
      }
    }
    return blocks.join('\n\n');
  }
  /** Participating columns in catalog order (an excluded source never participates: the checkbox locks at the first send). */
  const participatingColumns = () => COMPARE_PROVIDERS.map((p) => state.columns.get(p)).filter((c) => c && c.participated);
  const compareMarkdown = () => markdownFor(participatingColumns());
  const columnMarkdown = (col) => (col.participated ? markdownFor([col]) : '');
  /** A column holds at least one answer with text. */
  const columnHasAnswer = (c) => c.turns.some((turn) => turn.role === 'assistant' && turn.text);
  /** 「전체 복사」 is worth pressing once some column holds an answer; a column's 「대화 복사」 once THAT column does. */
  function syncCopyAll() {
    copyAllBtn.disabled = ![...state.columns.values()].some(columnHasAnswer);
    for (const col of state.columns.values()) col.copyColBtn.hidden = !columnHasAnswer(col);
  }

  const noticeBox = el('div', 'cmp-notices');
  noticeBox.id = 'cmp-notices';
  noticeBox.setAttribute('aria-live', 'polite');
  root.appendChild(noticeBox);

  // Question card. Until the first send is accepted (CONSUME_OK) it IS a composer — `?q` only
  // pre-fills it, the user may rewrite it — and the send button reads the textarea. After
  // CONSUME_OK the card freezes into the static prompt (the follow-up box takes over); a
  // CONSUME_FAIL hands it back editable with the text untouched.
  const qCard = el('section', 'cmp-card cmp-prompt');
  qCard.setAttribute('aria-label', t('question_label'));
  const qHead = el('div', 'cmp-prompt-head');
  qHead.appendChild(el('div', 'cmp-eyebrow', t('question_label')));
  // Copies the question as sent (state.question) — only once the card is frozen, so the button
  // never offers to copy a draft the composer already holds.
  const qCopyBtn = copyButton(() => state.question, { kind: COPY_KIND_QUESTION });
  qCopyBtn.id = 'cmp-question-copy';
  qCopyBtn.hidden = true;
  qHead.appendChild(qCopyBtn);
  qCard.appendChild(qHead);
  const qInput = el('textarea', 'cmp-textarea cmp-prompt-input');
  qInput.id = 'cmp-question';
  qInput.placeholder = t('question_placeholder');
  qInput.setAttribute('aria-label', t('question_placeholder'));
  qInput.setAttribute('rows', '1');
  qInput.value = q;
  // Same flex row as the follow-up composer, so both textareas share one sizing rule.
  const qRow = el('div', 'cmp-composer-row');
  qRow.appendChild(qInput);
  qCard.appendChild(qRow);
  const qText = el('div', 'cmp-prompt-text');
  qText.hidden = true;
  qCard.appendChild(qText);
  const controls = el('div', 'cmp-prompt-actions');
  const excludeLabel = el('label', 'cmp-check');
  const excludeInput = el('input');
  excludeInput.type = 'checkbox';
  excludeInput.id = 'cmp-exclude-src';
  excludeLabel.appendChild(excludeInput);
  excludeLabel.appendChild(el('span', null, t('exclude_src')));
  if (src) excludeLabel.title = t('exclude_src_tip', PROVIDER_META[src].label);
  excludeLabel.hidden = !src;
  controls.appendChild(excludeLabel);
  // 「시크릿 대화」 (UX batch 3, item 6 — the default flipped): checked = the SW creates the provider
  // conversations temporary / hidden (SEND saveHistory:false); unchecked (default) = kept in each
  // site's history, which is also what makes a lost session resumable. The wire keeps
  // `saveHistory`, so `state.saveHistory === !checked`. Fixed for the session at the first SEND.
  const incognitoLabel = el('label', 'cmp-check cmp-check-incognito');
  const incognitoInput = el('input');
  incognitoInput.type = 'checkbox';
  incognitoInput.id = 'cmp-incognito';
  incognitoLabel.appendChild(incognitoInput);
  const incognitoGlyph = el('span', 'cmp-incognito-glyph', '🕶');
  incognitoGlyph.setAttribute('aria-hidden', 'true');
  incognitoLabel.appendChild(incognitoGlyph);
  incognitoLabel.appendChild(el('span', null, t('incognito')));
  incognitoLabel.title = t('incognito_tip');
  controls.appendChild(incognitoLabel);
  controls.appendChild(el('span', 'cmp-spacer'));
  const qHint = el('span', 'cmp-composer-hint', t('composer_hint'));
  controls.appendChild(qHint);
  const sendBtn = el('button', 'cmp-btn cmp-btn-primary', t('send'));
  sendBtn.id = 'cmp-send';
  sendBtn.type = 'button';
  sendBtn.disabled = true;
  controls.appendChild(sendBtn);
  qCard.appendChild(controls);
  root.appendChild(qCard);
  /** The question as it would be sent right now ('' = send disabled). */
  const currentQuestion = () => String(qInput.value || '').trim();
  /** First CONSUME_OK: the composer becomes the static prompt showing exactly what went out. */
  function commitPrompt(text) {
    qText.textContent = text;
    qText.hidden = false;
    qInput.hidden = true;
    qHint.hidden = true;
    qCopyBtn.hidden = false;
    qCard.classList.add('is-committed');
  }
  /** New chat: the static prompt becomes an empty composer again (the inverse of commitPrompt). */
  function releasePrompt() {
    qText.textContent = '';
    qText.hidden = true;
    qInput.value = '';
    qInput.hidden = false;
    qHint.hidden = false;
    qCopyBtn.hidden = true;
    qCard.classList.remove('is-committed');
    autoGrow(qInput);
  }

  /**
   * Follow-up composer: textarea (auto-grow, Enter = send, Shift+Enter = newline) + a segmented
   * routing control built from native CHECKBOXES (item 2: any subset of the columns; focus / a11y
   * come from the browser) plus a 「전체」 select-all chip.
   * A FACTORY because the page mounts it twice over one model — under the frozen question (the
   * thread continuation, where the eye already is) and at the bottom (sticky, always in view):
   *   - the draft is mirrored between the textareas on every input;
   *   - the checkboxes of each instance carry their own `name`, and a change in either updates
   *     `state.followupTargets`, after which updateControls() repaints both;
   *   - sendFollowup() reads the instance that fired; every instance is cleared on send and every
   *     instance gets the draft back on CONSUME_FAIL;
   *   - enabled / disabled / hidden are applied to all instances alike.
   * `idSuffix` keeps the bottom instance's ids stable (the flow guard drives them by id).
   * `compact`: the bottom instance shows only the textarea row — its routing boxes stay in the
   * DOM (the same group logic, the flow guard drives them by id) but their row is hidden, and a
   * caption next to the send button lists the shared targets instead (updateControls).
   */
  const composers = [];
  function makeFollowupComposer(idSuffix, className, compact = false) {
    const section = el('section', className);
    section.id = `cmp-followup${idSuffix}`;
    section.hidden = true;
    const row = el('div', 'cmp-composer-row');
    const input = el('textarea', 'cmp-textarea');
    input.id = `cmp-followup-input${idSuffix}`;
    input.placeholder = t('followup_placeholder');
    input.setAttribute('aria-label', t('followup_placeholder'));
    input.setAttribute('rows', '1');
    row.appendChild(input);
    let caption = null;
    if (compact) {
      caption = el('span', 'cmp-composer-target');
      caption.id = `cmp-followup-caption${idSuffix}`;
      caption.title = t('followup_target_label');
      row.appendChild(caption);
    }
    const btn = el('button', 'cmp-btn cmp-btn-primary', t('followup_send'));
    btn.id = `cmp-followup-send${idSuffix}`;
    btn.type = 'button';
    row.appendChild(btn);
    section.appendChild(row);
    const meta = el('div', 'cmp-composer-meta');
    meta.hidden = compact;
    const targetLabel = el('span', 'cmp-composer-label', t('followup_target_label'));
    targetLabel.id = `cmp-followup-target-label${idSuffix}`;
    meta.appendChild(targetLabel);
    const select = el('div', 'cmp-seg');
    select.id = `cmp-followup-target${idSuffix}`;
    select.setAttribute('role', 'group');
    select.setAttribute('aria-labelledby', targetLabel.id);
    meta.appendChild(select);
    meta.appendChild(el('span', 'cmp-composer-hint', t('composer_hint')));
    section.appendChild(meta);
    const composer = { section, input, btn, select, caption, radioName: select.id };
    composers.push(composer);
    return composer;
  }
  // Thread instance: inside the prompt card, right under the frozen question.
  const followupTop = makeFollowupComposer(FOLLOWUP_ID_TOP, 'cmp-composer cmp-composer-thread');
  qCard.appendChild(followupTop.section);

  const columnsBox = el('div', 'cmp-columns');
  columnsBox.id = 'cmp-columns';
  root.appendChild(columnsBox);

  // Bottom instance: its own card, docked to the viewport bottom (compare.css .cmp-dock) so a long
  // question can never push it below the fold.
  const followup = makeFollowupComposer(FOLLOWUP_ID_BOTTOM, 'cmp-card cmp-composer cmp-composer-compact', true);
  const dock = el('div', 'cmp-dock');
  dock.id = 'cmp-dock';
  dock.hidden = true;
  dock.appendChild(followup.section);
  root.appendChild(dock);

  const footer = el('footer', 'cmp-footer');
  footer.id = 'cmp-footer';
  // One line (two spans, a separator between): the notices are a footnote, not a paragraph —
  // every line here is taken from the columns.
  const footLine = el('p');
  // The residue line follows the toggle (syncSaveHistory): temporary-chat wording, or "kept in history".
  const footResidue = el('span', 'cmp-footer-residue', t('notice_residue'));
  footLine.appendChild(footResidue);
  footLine.appendChild(el('span', 'cmp-footer-sep', '·'));
  footLine.appendChild(el('span', null, t('notice_no_refund')));
  footer.appendChild(footLine);
  root.appendChild(footer);
  /**
   * The toggle, the footer line, the mid-session chip and the page tint, from the current choice /
   * the session's. Incognito ON (contract D2) = `html[data-incognito="1"]` (compare.css gives the
   * prompt card and the composers a distinct surface), the 🕶 chip mid-session, the temporary /
   * hidden wording in the footer; OFF = today's "kept in history" wording, no attribute.
   */
  function syncSaveHistory() {
    incognitoInput.checked = !state.saveHistory;
    // Once a session exists the footer describes THAT session (what its SEND carried), not the
    // toggle — the two can only differ through a programmatic flip, but the promise must be the
    // session's (Codex wire 1R #1).
    const effective = state.sessionStarted && state.sessionSaveHistory != null ? state.sessionSaveHistory : !!state.saveHistory;
    footResidue.textContent = t(effective ? 'notice_residue_saved' : 'notice_residue');
    if (effective) doc.documentElement.removeAttribute('data-incognito');
    else doc.documentElement.setAttribute('data-incognito', '1');
    modeChip.hidden = !state.sessionStarted || state.sessionSaveHistory == null;
    modeChip.classList.toggle('is-incognito', !modeChip.hidden && !state.sessionSaveHistory);
    modeGlyph.hidden = modeChip.hidden || !!state.sessionSaveHistory;
    if (!modeChip.hidden) modeText.textContent = t(state.sessionSaveHistory ? 'mode_saved' : 'mode_incognito');
  }

  // ── notices ──
  /** One notice at a time: first line = title, the rest = description, optional CTA on the right. */
  function showNotice(kind, lines, cta, owner = NOTICE_OWNER_PAGE) {
    clear(noticeBox);
    state.notice = { kind, owner };
    const box = el('div', `cmp-notice is-${kind}`);
    box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const text = el('div', 'cmp-notice-text');
    lines.filter(Boolean).forEach((line, i) => text.appendChild(el('p', i === 0 ? 'cmp-notice-title' : 'cmp-notice-desc', line)));
    box.appendChild(text);
    if (cta) box.appendChild(cta);
    noticeBox.appendChild(box);
  }
  const clearNotice = () => { clear(noticeBox); state.notice = null; };
  /** A status read may touch the notice slot only when it is empty or holds one of its own. */
  const statusOwnsNotice = () => !state.notice || state.notice.owner === NOTICE_OWNER_STATUS;
  const loginCta = () => link(LOGIN_URL, t('login_cta'), 'cmp-btn cmp-btn-primary cmp-btn-link cmp-login-cta');
  const proCta = () => link(PRO_URL, t('pro_cta'), 'cmp-btn cmp-btn-primary cmp-btn-link cmp-pro-cta');
  // The extension being signed out is the one status fact that outranks whatever else is showing
  // (nothing can be sent until it is fixed, and this notice carries the only CTA for it).
  function showLoginRequired() { showNotice('warn', [t('login_required'), t('login_required_desc')], loginCta(), NOTICE_OWNER_STATUS); }

  /** AC24: flag off (or server 404) → the page is ONLY the coming-soon node. */
  function renderComingSoon() {
    state.disabled = true;
    state.sending = false;
    closePort(); // stops the keepalive too
    clearCopyFeedback();
    removeAutoRefreshListeners(true); // terminal: nothing on this page will ever read the status again
    // The columns are about to be detached, not settled: a column still waiting for its first
    // chunk would keep the page's waiting ticker painting a node nobody sees (Codex ext 1R #1).
    // Retire every live column through the same path a settled one takes, so the ticker's own
    // bookkeeping ends it.
    for (const col of state.columns.values()) {
      if (col.status === 'streaming') col.status = 'idle';
      setBadge(col, null, '');
    }
    clear(root);
    const box = el('div', 'cmp-card cmp-coming-soon');
    box.id = 'cmp-coming-soon';
    box.appendChild(el('h1', null, t('coming_soon')));
    box.appendChild(el('p', null, t('coming_soon_desc')));
    root.appendChild(box);
  }

  // ── quota line ──
  function renderQuota(quota, quotaError) {
    quotaLine.classList.remove('is-exhausted');
    if (quota && quota.pro) { quotaLine.textContent = t('quota_unlimited'); return; }
    // limit:null without pro = the server is not counting (billing gate off); say "unlimited",
    // not "Pro" (Codex #23).
    if (quota && quota.limit == null && quota.remaining == null && quota.resetsAt) { quotaLine.textContent = t('quota_no_limit'); return; }
    if (quota && quota.limit != null && quota.remaining != null) {
      const reset = localHHMM(quota.resetsAt);
      quotaLine.textContent = t('quota_line', quota.remaining, quota.limit, reset);
      if (quota.remaining <= 0) quotaLine.classList.add('is-exhausted');
      return;
    }
    quotaLine.textContent = quotaError ? '' : t('quota_unknown');
  }

  // ── columns ──
  function columnFor(provider) {
    let col = state.columns.get(provider);
    if (col) return col;
    const meta = PROVIDER_META[provider];
    const node = el('section', 'cmp-card cmp-col');
    node.setAttribute('data-provider', provider);
    node.setAttribute('aria-label', meta.label);
    // Head = identity group (dot · name → site · model pill · plan) + tools group (badge · 대화 복사),
    // each a flex row of 30px controls so the head stays one line at a 340px column (item 12).
    const head = el('div', 'cmp-col-head');
    const identity = el('div', 'cmp-col-id');
    identity.appendChild(dot(provider));
    // Item 1 (contract B): the provider name opens the site in a new tab; the arrow glyph says so.
    const name = link(meta.site, meta.label, 'cmp-col-name');
    name.setAttribute('aria-label', t('open_provider_site', meta.label));
    name.title = t('open_provider_site', meta.label);
    const arrow = el('span', 'cmp-ext-arrow', '↗');
    arrow.setAttribute('aria-hidden', 'true');
    name.appendChild(arrow);
    name.addEventListener('click', () => track('provider_link_click', { provider }));
    identity.appendChild(name);
    // Model pill (addendum): filled from status.models[provider]; hidden when the catalog is absent.
    const modelWrap = el('span', 'cmp-model');
    modelWrap.hidden = true;
    const modelSelect = el('select', 'cmp-model-select');
    modelSelect.id = `cmp-model-${provider}`;
    modelSelect.setAttribute('aria-label', t('col_model_label', meta.label));
    modelSelect.addEventListener('change', () => {
      state.modelChoice[provider] = modelSelect.value === MODEL_AUTO_VALUE ? null : modelSelect.value;
      track('model_change', { provider, model: state.modelChoice[provider] == null ? '' : String(state.modelChoice[provider]) });
    });
    modelWrap.appendChild(modelSelect);
    identity.appendChild(modelWrap);
    // Item 3 (contract A): the account's plan next to the model, display-ready from the SW
    // (status.providers[p].plan — what Claude Tuner already collected); hidden when null.
    const plan = el('span', 'cmp-col-plan');
    plan.hidden = true;
    identity.appendChild(plan);
    head.appendChild(identity);
    const tools = el('div', 'cmp-col-tools');
    const badge = el('span', 'cmp-col-badge');
    badge.setAttribute('aria-live', 'polite');
    tools.appendChild(badge);
    // Item 5 (contract I): 「대화 복사」 — this column's question + every turn as markdown (the same
    // builder as 「전체 복사」 over one column). Shown once the column holds an answer (syncCopyAll).
    const copyColBtn = copyButton(() => columnMarkdown(state.columns.get(provider)), { kind: COPY_KIND_COLUMN, provider, label: t('copy_column'), aria: t('copy_column_aria', meta.label) });
    copyColBtn.classList.add('cmp-copy-col');
    copyColBtn.hidden = true;
    tools.appendChild(copyColBtn);
    head.appendChild(tools);
    // Catalog hint (#1452 refresh): under the pill while the SW is still to ask the site for this
    // provider's list (status.modelsPending) and a send is in flight — the first send opens the tab
    // the list needs, and MODELS then replaces the static picker. Hidden otherwise.
    const modelHint = el('span', 'cmp-model-hint', t('model_list_loading'));
    modelHint.hidden = true;
    head.appendChild(modelHint);
    node.appendChild(head);
    const body = el('div', 'cmp-col-body');
    node.appendChild(body);
    // 「↓ 새 내용」 (streaming scroll): outside the scroller, pinned to the column's bottom edge.
    const jumpBtn = el('button', 'cmp-btn cmp-btn-sm cmp-jump', t('jump_to_latest'));
    jumpBtn.type = 'button';
    jumpBtn.hidden = true;
    jumpBtn.setAttribute('aria-label', t('jump_to_latest_aria', meta.label));
    node.appendChild(jumpBtn);
    // Per-column action row (batch 2): 「이 열만 다시 보내기」 (+ 「<Provider> 탭 열기」 on no_tab),
    // shown under the last turn while the column sits in an error the user may retry.
    const actions = el('div', 'cmp-col-actions');
    actions.hidden = true;
    const retryBtn = el('button', 'cmp-btn cmp-btn-sm cmp-retry-col', t('retry_column'));
    retryBtn.type = 'button';
    actions.appendChild(retryBtn);
    const openTab = link(meta.site, t('open_provider_tab', meta.label), 'cmp-btn cmp-btn-sm cmp-btn-link cmp-open-tab');
    openTab.hidden = true;
    actions.appendChild(openTab);
    retryBtn.addEventListener('click', () => retryColumn(provider));
    jumpBtn.addEventListener('click', () => {
      col.userScrolledUp = false;
      col.followTail = true;
      scrollColumnToEnd(col);
      track('jump_to_latest', { provider });
    });
    // A manual scroll away from the end stops the follow (and shows the pill); coming back resumes it.
    body.addEventListener('scroll', () => {
      const m = scrollMetrics(body);
      if (!m) return;
      col.userScrolledUp = m.fromEnd > FOLLOW_AT_BOTTOM_PX;
      if (col.userScrolledUp) col.followTail = false;
      syncJumpButton(col);
    });
    // `continuation`: the provider conversation ids DONE carried (package v0.4.0) for a KEPT
    // session — what a SEND{resume} on a fresh port hands back after a lost port (D3). Null for an
    // incognito session (never stored even if sent) and until the first DONE.
    col = { provider, node, badge, body, modelWrap, modelSelect, plan, modelHint, copyColBtn, actions, retryBtn, openTab, turns: [], renderScheduled: false, status: 'idle', errorCode: null, errorTitle: '', participated: false, round: null, badgeKey: null, badgeCls: '', servedModel: null, waitingSince: null, stages: {}, gate: null, continuation: null, jumpBtn, followAnchored: false, followTail: false, userScrolledUp: false };
    state.columns.set(provider, col);
    columnsBox.appendChild(node);
    return col;
  }

  /**
   * Badge = status text, or the served model once the SW reported it (MODEL / DONE.model) while the
   * column is waiting / answering / done — the model label replaces 「응답 대기 중…」 (addendum). Error
   * and stopped states keep their own words; the model, if known, stays in the tooltip.
   */
  const MODEL_BADGE_KEYS = new Set(['col_waiting', 'col_streaming', 'col_done']);
  function setBadge(col, key, cls) {
    const wasWaiting = col.badgeKey === BADGE_WAITING;
    col.badgeKey = key || null;
    col.badgeCls = cls || '';
    // Entering the waiting state starts its clock; leaving it (first CHUNK, DONE, ERROR, ALL_DONE,
    // a CONSUME_FAIL rollback) drops it. Re-entering (a follow-up round) starts a fresh one.
    if (col.badgeKey === BADGE_WAITING) { if (!wasWaiting) col.waitingSince = clock.now(); } else col.waitingSince = null;
    paintBadge(col);
    syncWaitTimer();
  }
  /** Whole seconds the column has been waiting for its first chunk, or null before WAIT_ELAPSED_SHOW_MS (and outside the state). */
  function waitingSeconds(col) {
    if (col.badgeKey !== BADGE_WAITING || col.waitingSince == null) return null;
    const ms = clock.now() - col.waitingSince;
    return ms >= WAIT_ELAPSED_SHOW_MS ? Math.floor(ms / MS_PER_SECOND) : null;
  }
  /**
   * Seconds (one decimal, as strings) from the column's timed stages: `first` = first_chunk −
   * send_start, `total` = stream_done − send_start (null when that stage is missing). Null when
   * the pair for `first` is missing or out of order — a number is never NaN, never negative.
   */
  function ttftSeconds(col) {
    const st = col.stages || {};
    const s = st[STAGE_SEND_START]; const f = st[STAGE_FIRST_CHUNK]; const d = st[STAGE_STREAM_DONE];
    // The DURATIONS are what must be sane, not just the operands: finite, not negative, under
    // the cap (Codex b2 1R #3 — 1e308 − 0 is "finite" operands and Infinity초).
    const sane = (ms) => Number.isFinite(ms) && ms >= 0 && ms <= TTFT_MAX_MS;
    const first = f - s;
    if (!sane(first)) return null;
    const total = d - s;
    const fmt = (ms) => (ms / MS_PER_SECOND).toFixed(1);
    return { first: fmt(first), total: sane(total) ? fmt(total) : null };
  }
  function paintBadge(col) {
    const m = col.servedModel;
    const modelText = m ? String(m.label || m.id || '') : '';
    const showModel = !!modelText && MODEL_BADGE_KEYS.has(col.badgeKey);
    // 「응답 대기 중 · 12초」 once the wait is long enough to be worth a number; when the served model
    // already replaced the words (Claude reports it at send time), the seconds ride after it.
    const secs = waitingSeconds(col);
    let text = showModel ? modelText : (col.badgeKey ? t(col.badgeKey) : '');
    if (secs != null) text = showModel ? `${modelText} · ${t('elapsed_seconds', secs)}` : t('col_waiting_elapsed', secs);
    // Once DONE, the time to first token rides after the model / 완료 (batch 2): 「Opus 5 · 4.2초」;
    // the tooltip carries the breakdown. Only when the stages were reported — never a NaN.
    const ttft = col.status === 'done' && col.badgeKey === 'col_done' ? ttftSeconds(col) : null;
    if (ttft) text = `${text} · ${t('ttft_badge', ttft.first)}`;
    col.badge.textContent = text;
    col.badge.className = 'cmp-col-badge' + (col.badgeCls ? ` ${col.badgeCls}` : '');
    const titleParts = [];
    if (ttft && ttft.total != null) titleParts.push(t('ttft_title', ttft.first, ttft.total));
    if (showModel) {
      col.badge.setAttribute('data-model-source', m.source === MODEL_SOURCE_REQUESTED ? MODEL_SOURCE_REQUESTED : 'reported');
      titleParts.push(m.source === MODEL_SOURCE_REQUESTED ? t('model_requested_hint') : t('model_reported_hint'));
    } else {
      col.badge.removeAttribute('data-model-source');
      // An errored column's badge carries the raw cause too (same text as the error line).
      if (col.status === 'error' && col.errorTitle) titleParts.push(col.errorTitle);
    }
    if (titleParts.length) col.badge.title = titleParts.join(' · ');
    else col.badge.removeAttribute('title');
  }
  function setServedModel(col, model) {
    if (!model || typeof model !== 'object') return;
    const id = model.id == null ? null : String(model.id);
    const label = model.label == null ? '' : String(model.label);
    if (!id && !label) return;
    col.servedModel = { id, label, source: model.source === MODEL_SOURCE_REQUESTED ? MODEL_SOURCE_REQUESTED : 'reported' };
    paintBadge(col);
  }

  // ── waiting-time ticker ──
  // ONE interval for the page, never one per column: each second it repaints the badge of every
  // column still waiting for its first chunk (CONSUME_OK seen, no CHUNK yet). Started when a column
  // enters that state, cleared as soon as none is in it — every exit goes through setBadge, and
  // finishSend() (ALL_DONE / CONSUME_FAIL / port gone) clears it once more so a round that ends
  // cannot leave a timer running. Only the badge text changes, so reduced-motion is unaffected.
  let waitTimer = null;
  function waitingColumns() {
    return [...state.columns.values()].filter((c) => c.badgeKey === BADGE_WAITING && c.status === 'streaming');
  }
  function syncWaitTimer() {
    const any = waitingColumns().length > 0;
    if (any && waitTimer == null) waitTimer = clock.setInterval(tickWaiting, WAIT_TICK_MS);
    else if (!any && waitTimer != null) { clock.clearInterval(waitTimer); waitTimer = null; }
  }
  function tickWaiting() {
    const cols = waitingColumns();
    for (const col of cols) paintBadge(col);
    if (!cols.length) syncWaitTimer();
  }

  /**
   * Model catalog for a column (addendum): options from status.models[provider]; the selected value
   * is the user's choice this page load, else status.selectedModels[provider], else the catalog's
   * default entry, else the first. No / empty catalog → the pill is hidden and no `models` entry is
   * sent for that provider (the SW uses the provider's default).
   */
  function renderModelSelect(col) {
    const st = state.status || {};
    const list = st.models && Array.isArray(st.models[col.provider]) ? st.models[col.provider].filter((m) => m && typeof m === 'object') : [];
    const sel = col.modelSelect;
    if (!list.length) {
      col.modelWrap.hidden = true;
      clear(sel);
      delete state.modelChoice[col.provider];
      return;
    }
    const toValue = (id) => (id == null ? MODEL_AUTO_VALUE : String(id));
    const known = new Set(list.map((m) => toValue(m.id)));
    const stored = st.selectedModels && Object.hasOwn(st.selectedModels, col.provider) ? st.selectedModels[col.provider] : undefined;
    const fallback = list.find((m) => m.default) || list[0];
    let value;
    if (Object.hasOwn(state.modelChoice, col.provider) && known.has(toValue(state.modelChoice[col.provider]))) value = toValue(state.modelChoice[col.provider]);
    else if (stored !== undefined && known.has(toValue(stored))) value = toValue(stored);
    else value = toValue(fallback.id);
    clear(sel);
    for (const m of list) {
      const o = el('option', null, String(m.label || m.id || ''));
      o.value = toValue(m.id);
      o.setAttribute('value', toValue(m.id));
      if (o.value === value) o.setAttribute('selected', 'selected');
      sel.appendChild(o);
    }
    sel.value = value;
    state.modelChoice[col.provider] = value === MODEL_AUTO_VALUE ? null : value;
    col.modelWrap.hidden = false;
  }

  /** The hint under a pill: only while its list is still pending at the SW AND a send is in flight. */
  function syncModelHint(col) {
    const pending = Array.isArray(state.status?.modelsPending) && state.status.modelsPending.includes(col.provider);
    col.modelHint.hidden = !(pending && state.sending && !col.modelWrap.hidden);
  }

  /**
   * MODELS (#1452 refresh): the SW re-listed some providers' pickers now that their tabs exist.
   * Replace those catalogs (and the source/pending bookkeeping) and repopulate each affected
   * select — renderModelSelect keeps the current choice when the new list still has it, else the
   * stored one, else the catalog default. Never while a column's pill would change under a locked
   * send: the select is disabled while sending, and only its options move.
   */
  function applyModels(msg) {
    if (!state.status || !msg.models || typeof msg.models !== 'object') return;
    const st = state.status;
    st.models = { ...(st.models || {}) };
    st.modelsSource = { ...(st.modelsSource || {}) };
    for (const [provider, list] of Object.entries(msg.models)) {
      if (!state.columns.has(provider) || !Array.isArray(list)) continue;
      st.models[provider] = list;
      if (msg.modelsSource && typeof msg.modelsSource[provider] === 'string') st.modelsSource[provider] = msg.modelsSource[provider];
      renderModelSelect(state.columns.get(provider));
    }
    if (Array.isArray(msg.modelsPending)) {
      // The message speaks for the providers it re-listed; others keep their state.
      const listed = new Set(Object.keys(msg.models));
      st.modelsPending = [...(st.modelsPending || []).filter((p) => !listed.has(p)), ...msg.modelsPending.filter((p) => typeof p === 'string')];
    }
    for (const col of state.columns.values()) syncModelHint(col);
  }

  /** `models` map for a send: every target whose pill is shown, with its current choice (null = Auto). */
  function modelsFor(targets) {
    const out = {};
    for (const p of targets) {
      const col = state.columns.get(p);
      if (col && !col.modelWrap.hidden && Object.hasOwn(state.modelChoice, p)) out[p] = state.modelChoice[p];
    }
    return out;
  }

  /** Which gate a provider's status calls for; null = sendable (no gate). */
  function gateKindFor(pstate) {
    if (!pstate || !pstate.permitted) return GATE_PERMISSION;
    if (pstate.loggedIn === true) return null;
    // The SW answers null only when not permitted, but a null under `permitted` must not read as
    // "signed out" — it is "unknown", with a re-check and no login prompt.
    return pstate.loggedIn === false ? GATE_LOGIN : GATE_UNKNOWN;
  }
  /** A quiet 「다시 확인」: a status re-read on demand (the manual path when auto-reconnect missed). */
  function checkAgainButton() {
    const btn = el('button', 'cmp-btn cmp-btn-sm cmp-gate-check', t('gate_check_again'));
    btn.type = 'button';
    btn.addEventListener('click', () => { refreshStatus(); });
    return btn;
  }
  /**
   * Column content for a provider that cannot be sent to — permission / login / unknown state —
   * or, mid-session, one that signed in too late to join (GATE_JOINED). Built ONCE per kind and
   * then updated in place: a status re-read (auto-reconnect fires on every focus) must not tear
   * the login link out from under the user's focus. Only a change of kind rebuilds.
   */
  function renderColumnGate(col, kind) {
    const meta = PROVIDER_META[col.provider];
    // The gate speaks through the body (title + action); the header pill stays empty so the same
    // words are not shown twice.
    setBadge(col, null);
    if (col.gate && col.gate.kind === kind && col.gate.box.parentNode === col.body) { syncGateStatus(col); return; }
    clear(col.body);
    const box = el('div', 'cmp-col-state');
    box.setAttribute('data-gate', kind);
    box.appendChild(dot(col.provider));
    const gate = { kind, box, status: null, hint: null };
    if (kind === GATE_PERMISSION) {
      box.appendChild(el('p', 'cmp-col-state-title', t('provider_permission_required')));
      box.appendChild(el('p', 'cmp-col-state-desc', t('provider_permission_desc', meta.label)));
      const btn = el('button', 'cmp-btn cmp-btn-primary cmp-perm-btn', t('provider_permission_btn'));
      btn.type = 'button';
      btn.setAttribute('data-origin', meta.origin);
      // Where the "the prompt moved to an extension tab" hint goes (appended under the buttons below).
      const hint = el('p', 'cmp-col-state-hint');
      hint.setAttribute('aria-live', 'polite');
      // 🔴 The ONLY chrome.permissions.request in the compare feature, and it is inside a click
      // handler: optional host permissions need a user gesture, which content scripts can never
      // supply (AC16). After the prompt, re-ask the SW so the column flips to sendable/login.
      btn.addEventListener('click', async () => {
        if (state.disabled) return;
        btn.disabled = true;
        let promptUnavailable = false;
        try {
          let granted = false;
          try { granted = (await chrome.permissions.request({ origins: [meta.origin] })) === true; } catch {
            // Refused / unavailable. Inside the web shell's iframe Chrome may decline to SHOW the
            // prompt at all (the call rejects — a user's "no" resolves false and does not land here):
            // the extension's own tab is where the prompt is guaranteed, so open this page there with
            // the same query and say so. The button stays; a plain retry is still possible.
            promptUnavailable = !!embedHost;
          }
          track('permission_result', { provider: col.provider, granted });
          if (promptUnavailable) openInExtensionTab();
          hint.textContent = '';
          await refreshStatus();
          // The hint lives INSIDE the gate (the gate is kept in place while the kind is unchanged),
          // never in the notice box — it must not replace a consume error / the quota notice / the
          // extension-login notice (Codex b2 3R #1). A granted permission rebuilds the gate away.
          if (promptUnavailable) hint.textContent = t('provider_permission_tab_hint');
        } finally {
          // 🔴 The gate is updated in place across refreshes, so this is the SAME button the user
          // will press again after a "no": it must come back (Codex b2 2R #1).
          btn.disabled = false;
        }
      });
      box.appendChild(btn);
      box.appendChild(checkAgainButton());
      box.appendChild(hint);
      gate.hint = hint;
    } else if (kind === GATE_LOGIN) {
      box.appendChild(el('p', 'cmp-col-state-title', t('provider_login_title', meta.label)));
      box.appendChild(el('p', 'cmp-col-state-desc', t('provider_login_desc', meta.label)));
      // Opens the provider site in a new tab; the arrow says so visually, the aria-label in words.
      const login = link(meta.site, t('provider_login_link', meta.label), 'cmp-btn cmp-btn-primary cmp-btn-link cmp-provider-login');
      const arrow = el('span', 'cmp-ext-arrow', '↗');
      arrow.setAttribute('aria-hidden', 'true');
      login.appendChild(arrow);
      login.setAttribute('aria-label', t('provider_login_link_aria', meta.label));
      box.appendChild(login);
      box.appendChild(checkAgainButton());
    } else if (kind === GATE_UNKNOWN) {
      box.appendChild(el('p', 'cmp-col-state-title', t('provider_state_unknown')));
      box.appendChild(checkAgainButton());
    } else {
      box.appendChild(el('p', 'cmp-col-state-desc cmp-col-joined', t('provider_joined_next')));
      box.appendChild(checkAgainButton());
    }
    // 「확인 중…」 while a status re-read is in flight — a line that changes, not a gate that flashes.
    const status = el('p', 'cmp-col-state-status');
    status.setAttribute('aria-live', 'polite');
    box.appendChild(status);
    gate.status = status;
    col.gate = gate;
    col.body.appendChild(box);
    syncGateStatus(col);
    track('gate_shown', { provider: col.provider, kind }); // once per gate build, not per refresh
  }

  /** Item 3: the plan label under the model pill, from the status answer; hidden when the SW has none. */
  function renderPlan(col) {
    const pstate = state.status && state.status.providers ? state.status.providers[col.provider] : null;
    const label = pstate && typeof pstate.plan === 'string' ? pstate.plan.trim() : '';
    col.plan.hidden = !label;
    col.plan.textContent = label;
    if (label) col.plan.title = t('col_plan_title', PROVIDER_META[col.provider].label);
    else col.plan.removeAttribute('title');
  }
  function syncGateStatus(col) {
    if (col.gate && col.gate.status) col.gate.status.textContent = state.checking ? t('gate_checking') : '';
  }

  function renderColumns() {
    const st = state.status;
    if (!st || !st.providers) return;
    for (const p of COMPARE_PROVIDERS) {
      const pstate = st.providers[p] || { permitted: false, loggedIn: null };
      const col = columnFor(p);
      const excluded = state.excludeSrc && p === src;
      col.node.hidden = excluded;
      if (excluded) continue;
      renderModelSelect(col);
      renderPlan(col);
      // Once a session has started the column shows the conversation; the gate only applies before.
      if (col.participated) continue;
      const kind = gateKindFor(pstate);
      if (kind) renderColumnGate(col, kind);
      else if (state.sessionStarted) renderColumnGate(col, GATE_JOINED); // signed in too late to join (SW: FOLLOWUP targets only participants)
      else { clear(col.body); col.gate = null; setBadge(col, null); }
    }
  }
  /** Some column is gated, or the extension itself is signed out — a status re-read could change something. */
  function anyGate() {
    const st = state.status;
    if (!st || !st.providers) return false;
    if (!st.loggedIn) return true;
    return COMPARE_PROVIDERS.some((p) => gateKindFor(st.providers[p]) !== null);
  }
  /**
   * 「아직 로그인된 AI가 없어요」 (login guidance #4): the extension is signed in and the status loaded,
   * but no provider can be sent to. Never over another notice — the extension-login / error
   * notices refreshStatus put up first win; the source exclusion does not count (that is a choice).
   */
  function syncZeroTargetsNotice() {
    const st = state.status;
    if (!st || !st.providers || !st.loggedIn || state.notice) return;
    if (sendableTargets(st, src, false).length === 0) showNotice('info', [t('no_ai_signed_in')], null, NOTICE_OWNER_STATUS);
  }

  /** Re-render the assistant turn from the accumulated text (throttled to one paint per frame). */
  function scheduleRender(col) {
    if (col.renderScheduled) return;
    col.renderScheduled = true;
    raf(() => { col.renderScheduled = false; paintAssistant(col); });
  }
  // The error line is re-appended on every paint: a CHUNK render scheduled before ERROR arrived
  // used to run after it and wipe the reason (Codex #8).
  /** Scroll metrics of a column body, or null where there is no layout engine (mini-dom). */
  function scrollMetrics(node) {
    const { scrollTop, clientHeight, scrollHeight } = node;
    if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) return null;
    return { scrollTop, clientHeight, scrollHeight, overflow: scrollHeight - clientHeight, fromEnd: scrollHeight - (scrollTop + clientHeight) };
  }
  /** Scroll a column to its end (next frame, like a paint) and let the scroll event clear the scrolled-up mark. */
  function scrollColumnToEnd(col) {
    raf(() => { col.body.scrollTop = col.body.scrollHeight; syncJumpButton(col); });
  }
  /** The 「↓ 새 내용」 pill: shown when the reader is away from the end of a column that holds content. */
  function syncJumpButton(col) {
    const m = scrollMetrics(col.body);
    const away = !!m && m.overflow > FOLLOW_AT_BOTTOM_PX && m.fromEnd > FOLLOW_AT_BOTTOM_PX;
    col.jumpBtn.hidden = !(away && col.turns.length > 0);
  }
  /**
   * After a paint of the live answer: follow while it fits, anchor its start once it overflows,
   * never move a view the user scrolled away from (see FOLLOW_AT_BOTTOM_PX).
   */
  function maybeFollowStream(col, turn) {
    if (col.userScrolledUp) { syncJumpButton(col); return; }
    // The pill was pressed during the stream: the reader asked for the tail — follow it to the end
    // until they scroll up again (an anchored column would otherwise stay put after the jump).
    if (col.followTail) { scrollColumnToEnd(col); return; }
    if (col.followAnchored) { syncJumpButton(col); return; }
    const m = scrollMetrics(col.body);
    if (!m) return;
    const rect = typeof turn.root.getBoundingClientRect === 'function' ? turn.root.getBoundingClientRect() : null;
    if (rect && rect.height > m.clientHeight - FOLLOW_ANCHOR_TOP_PX && m.overflow > FOLLOW_AT_BOTTOM_PX) {
      col.followAnchored = true;
      // Capture the node: a rollback / 새 대화 may remove it before the frame.
      const node = turn.root;
      raf(() => {
        if (!node.isConnected) return;
        const delta = node.getBoundingClientRect().top - col.body.getBoundingClientRect().top - FOLLOW_ANCHOR_TOP_PX;
        col.body.scrollTop += delta; // the answer's start just under the head; the rest streams in below
        syncJumpButton(col);
      });
      return;
    }
    scrollColumnToEnd(col); // still fits → keep the latest text visible
  }
  function paintAssistant(col) {
    const turn = col.turns[col.turns.length - 1];
    if (!turn || turn.role !== 'assistant') return;
    clear(turn.node);
    try {
      turn.node.appendChild(renderMarkdown(turn.text, doc));
    } catch {
      // md-lite is bounded, but a renderer failure must never blank the answer: fall back to text.
      turn.node.appendChild(doc.createTextNode(turn.text));
    }
    if (turn.errorText) {
      const line = el('p', 'cmp-col-error', turn.errorText);
      if (turn.errorTitle) line.title = turn.errorTitle;
      turn.node.appendChild(line);
    }
    maybeFollowStream(col, turn);
  }

  // A turn record: `node` is the text node the paints touch (paintAssistant clears and refills it),
  // `root` is what sits in the column body and what a rollback removes — the block wrapping the
  // node together with its copy button, so the button survives every repaint.
  function pushUserTurn(col, text) {
    const node = el('div', 'cmp-turn cmp-turn-user', text);
    const turn = { role: 'user', text, node, root: null };
    const root = el('div', 'cmp-turn-block cmp-turn-block-user');
    root.appendChild(node);
    root.appendChild(copyButton(() => turn.text, { kind: COPY_KIND_THREAD, provider: col.provider }));
    turn.root = root;
    col.turns.push(turn);
    col.body.appendChild(root);
  }
  function pushAssistantTurn(col) {
    const node = el('div', 'cmp-turn cmp-turn-assistant is-streaming');
    const turn = { role: 'assistant', text: '', node, root: null, copyBtn: null };
    const root = el('div', 'cmp-turn-block cmp-turn-block-assistant');
    root.appendChild(node);
    // 「답변 복사」 under the answer (item 5): hidden while it streams, shown once the turn settled
    // (DONE / ERROR / ALL_DONE) and only if there is text to copy — an errored turn that never got
    // a chunk has none.
    const copyBtn = copyButton(() => turn.text, { kind: COPY_KIND_TURN, provider: col.provider, label: t('copy_answer') });
    copyBtn.hidden = true;
    root.appendChild(copyBtn);
    turn.root = root;
    turn.copyBtn = copyBtn;
    col.turns.push(turn);
    col.body.appendChild(root);
    col.status = 'streaming';
    col.errorCode = null;
    col.errorTitle = '';
    col.servedModel = null;
    col.stages = {}; // a fresh round, fresh timers
    // A fresh answer follows again until IT overflows; the send itself brings the column to its
    // new question (a scroll-up before the send is over — the user asked for more).
    col.followAnchored = false;
    col.followTail = false;
    col.userScrolledUp = false;
    scrollColumnToEnd(col);
    renderColumnActions(col);
    // Between SEND and CONSUME_OK the SW is acquiring tabs / running the clients' prepare() step,
    // which can take seconds — say so, rather than "waiting for an answer" that was not asked yet.
    setBadge(col, 'col_preparing', 'is-streaming');
    return turn;
  }
  function pushSkippedTurn(col) {
    const node = el('div', 'cmp-turn cmp-turn-assistant is-skipped', t('col_skipped'));
    col.turns.push({ role: 'skipped', text: '', node, root: node });
    col.body.appendChild(node);
  }
  /** The turn stopped streaming: offer its copy button when there is something to copy. */
  function settleTurn(turn) {
    if (turn && turn.copyBtn) turn.copyBtn.hidden = !turn.text;
    syncCopyAll();
  }

  /**
   * The action row under a column's last turn: shown while the column sits in a retriable error
   * (anything but the user's own Stop), with the open-tab link when the tab is what failed.
   * Moved to the end of the body each time so it always follows the LAST turn.
   */
  function renderColumnActions(col) {
    const show = col.status === 'error' && col.errorCode !== CODE_ABORTED;
    col.actions.hidden = !show;
    col.openTab.hidden = !(show && col.errorCode === CODE_NO_TAB);
    // A retry costs a compare: with none left it is not offered (the open-tab link still is).
    col.retryBtn.hidden = quotaExhausted();
    // A column without a continuation cannot be sent to once the port was lost or the session
    // resumed (its client is gone; a fresh one would answer without the thread) — the button
    // says why instead of clicking into nothing (batch-3 Codex #3).
    const dead = columnDead(col);
    col.retryBtn.disabled = state.sending || !canFollowUp() || dead;
    col.retryBtn.title = dead ? t('retry_needs_new_chat') : '';
    if (show) col.body.appendChild(col.actions);
  }
  /** The server said 0 left (a counted quota, not Pro / uncounted) — a send would only CONSUME_FAIL. */
  function quotaExhausted() {
    const q = state.status && state.status.quota;
    return !!q && !q.pro && Number.isFinite(q.remaining) && q.remaining <= 0;
  }
  /** What this column was last asked: its last user turn, else the first-round question. */
  function lastUserText(col) {
    for (let i = col.turns.length - 1; i >= 0; i--) if (col.turns[i].role === 'user') return col.turns[i].text;
    return state.question;
  }
  /**
   * 「이 열만 다시 보내기」: a FOLLOWUP to that one provider with the text it was last asked — the
   * same path as an individual-target follow-up, minus the composer (the SW prepares FOLLOWUP with
   * mayOpenTab:true, so a lost tab is re-opened; a provider limit may simply fail again). Costs a
   * compare, which the label says.
   */
  function retryColumn(provider) {
    noteActivity();
    const col = state.columns.get(provider);
    if (!col || col.status !== 'error' || col.errorCode === CODE_ABORTED || col.node.hidden) return;
    if (state.sending || !canFollowUp() || quotaExhausted()) return;
    // On a lost port / a resumed session only a column with a continuation can be sent to (D3).
    if (columnDead(col)) return;
    const text = lastUserText(col);
    if (!text) return;
    beginSend(text, [provider], 'FOLLOWUP');
  }

  /** Back to a column that never took part: empty body, no turns, no badge (new chat). */
  function resetColumn(col) {
    clear(col.body);
    col.turns = [];
    col.followAnchored = false;
    col.followTail = false;
    col.userScrolledUp = false;
    col.jumpBtn.hidden = true;
    col.status = 'idle';
    col.errorCode = null;
    col.errorTitle = '';
    col.participated = false;
    col.round = null;
    col.servedModel = null;
    col.stages = {};
    col.gate = null;
    col.continuation = null;
    col.copyColBtn.hidden = true;
    renderColumnActions(col);
    setBadge(col, null, '');
  }

  function errorText(provider, code, reason) {
    const label = PROVIDER_META[provider].label;
    if (code === CODE_RATE_LIMITED) return t(PROVIDER_RATE_LIMIT_KEY, label);
    // Reason-specific copy first (err_no_tab_load_timeout → "click the tab to wake it"), then the
    // code's, then unknown. Only keys that exist are used, so an unlisted reason is not a hole.
    const specific = reason ? `err_${code}_${reason}` : '';
    if (specific && COMPARE_I18N.en[specific]) return t(specific, label);
    const key = `err_${code}`;
    return t(COMPARE_I18N.en[key] ? key : 'err_unknown', label);
  }

  /** The hover text of an errored column: `<reason>: <detail>` from the ERROR message, bounded; '' when it carried neither. */
  function errorTitle(msg) {
    const reason = typeof msg.reason === 'string' ? msg.reason.trim() : '';
    const detail = typeof msg.detail === 'string' ? msg.detail.trim() : '';
    const text = reason && detail ? `${reason}: ${detail}` : (reason || detail);
    return text.length > ERROR_TITLE_MAX ? `${text.slice(0, ERROR_TITLE_MAX)}…` : text;
  }

  // ── port / streaming ──
  function onPortMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'CONSUME_OK': {
        const first = !state.sessionStarted;
        if (first) commitPrompt(state.question);
        state.sessionStarted = true;
        state.rounds++;
        // A SEND{resume} was accepted (D3): the new port carries the session again — the lost
        // one is history, the keepalive below runs for this one.
        if (state.resuming) { state.resuming = false; state.resumed = true; state.sessionEnded = false; state.idleEnded = false; }
        state.pendingFollowup = '';
        for (const col of state.columns.values()) {
          col.round = null;
          if (col.status === 'streaming' && !col.turns[col.turns.length - 1].text) setBadge(col, BADGE_WAITING, 'is-streaming');
        }
        // `pro` is not on CONSUME_OK — keep the status answer's value (limit:null alone is not Pro).
        state.status.quota = { ...(state.status.quota || {}), remaining: msg.remaining, limit: msg.limit, resetsAt: msg.resetsAt, pro: !!(state.status.quota && state.status.quota.pro) };
        statusEpoch++; // this count is newer than any status answer still in flight
        renderQuota(state.status.quota, null);
        stopBtn.disabled = false;
        startKeepalive(); // the session exists in the SW from here on — keep the SW alive for it
        // The round is accepted: the follow-up composers appear NOW (the next question can be
        // drafted while the answers stream; their send buttons stay off until ALL_DONE), and the
        // question card drops its send button. Waiting for ALL_DONE here left the composer hidden
        // behind the slowest column (finding A).
        updateControls();
        // The caret moves to the thread composer — but only when it is still where the send left
        // it (the question textarea / send button / nowhere). If the user went elsewhere during a
        // slow prepare, leave them there; and never scroll to do it (Codex 1R #2).
        if (first) {
          const active = doc.activeElement || null;
          if (!active || active === doc.body || active === qInput || active === sendBtn) focusQuietly(followupTop.input);
        }
        return;
      }
      case 'CONSUME_FAIL': {
        // No provider send happened (AC18) — roll every column back to where this round started.
        // The round never happened, so a late ALL_DONE must not read it as "every target failed"
        // (Codex 2R #1).
        state.roundTargets = [];
        for (const col of state.columns.values()) {
          const r = col.round;
          if (!r) continue;
          while (col.turns.length > r.turns) col.turns.pop().root.remove();
          col.round = null;
          col.status = r.status;
          col.errorCode = r.errorCode;
          // The badge re-reads it in setBadge below; the error LINE kept its own copy on the turn
          // that survived the pop (Codex ext 1R #1: a rolled-back retry lost the badge tooltip).
          col.errorTitle = r.errorTitle;
          col.participated = col.turns.length > 0;
          col.servedModel = r.servedModel;
          col.stages = r.stages;
          setBadge(col, r.badgeKey, r.badgeCls);
          renderColumnActions(col);
        }
        // The draft goes back into EVERY composer (they mirror each other) unless the user
        // already typed something new there.
        if (state.pendingFollowup) {
          for (const c of composers) { if (!c.input.value) { c.input.value = state.pendingFollowup; autoGrow(c.input); } }
        }
        state.pendingFollowup = '';
        // A first-round failure never touched the question card: the textarea still holds the
        // text and finishSend() → updateControls() unlocks it (readOnly follows `sending`).
        renderConsumeFail(msg);
        track('consume_fail', { status: Number(msg.status) || 0, code: typeof msg.code === 'string' ? msg.code : '' });
        // Nothing was sent, so the SW session holds no conversation worth keeping. Drop the port:
        // a retry then opens a fresh one and SEND is again the first message (contract), instead
        // of a second SEND on a port that already saw one (Codex #4). A failed SEND{resume} drops
        // its fresh port for the same reason — the session stays lost-but-resumable (D3), and the
        // next attempt is again a first-message SEND{resume}.
        if (!state.sessionStarted) closePort();
        if (state.resuming) { state.resuming = false; closePort(); }
        finishSend();
        return;
      }
      case 'CHUNK': {
        const col = state.columns.get(msg.provider);
        if (!col || col.status !== 'streaming') return;
        const turn = col.turns[col.turns.length - 1];
        const hadText = !!turn.text;
        turn.text += String(msg.delta || '');
        setBadge(col, 'col_streaming', 'is-streaming');
        scheduleRender(col);
        if (!hadText && turn.text) syncCopyAll(); // the first text on the page enables 「전체 복사」
        return;
      }
      case 'MODEL': {
        // Served model, as soon as the client knows it (addendum). Only for the column's live round.
        const col = state.columns.get(msg.provider);
        if (!col || col.status !== 'streaming') return;
        setServedModel(col, msg.model);
        return;
      }
      case 'MODELS': {
        applyModels(msg);
        return;
      }
      case 'DONE': {
        const col = state.columns.get(msg.provider);
        if (!col || col.status !== 'streaming') return;
        const turn = col.turns[col.turns.length - 1];
        if (typeof msg.text === 'string' && msg.text) turn.text = msg.text;
        col.status = 'done';
        turn.node.classList.remove('is-streaming');
        paintAssistant(col);
        settleTurn(turn);
        renderColumnActions(col);
        if (msg.model) setServedModel(col, msg.model);
        setBadge(col, 'col_done', 'is-done');
        // The continuation (D3) is remembered ONLY for a kept session: an incognito session's
        // conversations are deleted / hidden at dispose, so there is nothing to resume — and the
        // guard pins that such a session never sends `resume`, whatever DONE carried.
        if (state.sessionSaveHistory === true && msg.continuation && typeof msg.continuation === 'object') col.continuation = msg.continuation;
        {
          const ttft = ttftSeconds(col);
          const m = col.servedModel;
          track('column_done', { provider: col.provider, ttft_ms: ttft ? Math.round(Number(ttft.first) * MS_PER_SECOND) : -1, total_ms: ttft && ttft.total != null ? Math.round(Number(ttft.total) * MS_PER_SECOND) : -1, chars: turn.text.length, model: m ? String(m.id || m.label || '') : '' });
        }
        return;
      }
      case 'ERROR': {
        const col = state.columns.get(msg.provider);
        if (!col || col.status !== 'streaming') return;
        const turn = col.turns[col.turns.length - 1];
        col.status = 'error';
        col.errorCode = msg.code || 'unknown';
        col.errorTitle = errorTitle(msg);
        turn.node.classList.remove('is-streaming');
        turn.node.classList.add('is-error');
        // Keep whatever streamed before the failure, then the reason underneath it (and the raw
        // cause in its title).
        turn.errorText = errorText(col.provider, col.errorCode, typeof msg.reason === 'string' ? msg.reason : '');
        turn.errorTitle = col.errorTitle;
        paintAssistant(col);
        settleTurn(turn);
        setBadge(col, col.errorCode === CODE_ABORTED ? 'col_aborted' : 'col_error', col.errorCode === CODE_ABORTED ? 'is-muted' : 'is-error');
        renderColumnActions(col);
        // The action row appended after the paint must end up in view too — for a short answer the
        // reader is still following; an anchored / scrolled-up column keeps its place (the pill shows it).
        if (!col.followAnchored && !col.userScrolledUp) scrollColumnToEnd(col); else syncJumpButton(col);
        // `readiness`: the SW's prepare() step failed (its message reads `not ready: <code>`), as
        // opposed to a failure while the answer was being produced (contract: ERROR.message).
        track('column_error', { provider: col.provider, code: col.errorCode, reason: typeof msg.reason === 'string' ? msg.reason : '', readiness: /^not ready/.test(String(msg.message || '')) });
        return;
      }
      case 'DIAG': {
        const col = state.columns.get(msg.provider);
        if (!col) return;
        // 🔍 The client started a tool (package v0.3.1: Claude's web search) before any text: say
        // so instead of 「응답 대기 중…」. Only a streaming column with no text yet; the first CHUNK's
        // 「답변 중…」 replaces it. Not a waiting state, so the ticker adds no seconds to it (the
        // search has its own pace; a stale count would read as the search's).
        if (msg.stage === STAGE_TOOL_USE) {
          const turn = col.turns[col.turns.length - 1];
          if (col.status === 'streaming' && turn && turn.role === 'assistant' && !turn.text) setBadge(col, BADGE_SEARCHING, 'is-streaming');
          return;
        }
        // Readiness stages from the SW (package v0.2.3) are logged there; the page keeps only the
        // TIMED send-path stages of the column's live round (package v0.3.0) for the badge.
        if (!TTFT_STAGES.has(msg.stage) || (col.status !== 'streaming' && col.status !== 'done')) return;
        const at = msg.detail && msg.detail.at;
        if (typeof at !== 'number' || !Number.isFinite(at)) return;
        // Round isolation on one port (Codex b2 1R #4): a previous round's stage delivered late
        // is OLDER than this round's send_start — anything before the recorded send_start is
        // dropped, and a stage never moves backwards (a client retry re-reports later times; the
        // LAST attempt is the one that answered, like the SW's own ttft line).
        const start = col.stages[STAGE_SEND_START];
        if (Number.isFinite(start) && at < start) return;
        if (Number.isFinite(col.stages[msg.stage]) && at < col.stages[msg.stage]) return;
        col.stages[msg.stage] = at;
        if (col.status === 'done') paintBadge(col); // stream_done landing after DONE completes the tooltip
        return;
      }
      case 'ALL_DONE': {
        for (const col of state.columns.values()) {
          if (col.status === 'streaming') { col.status = 'done'; setBadge(col, 'col_done', 'is-done'); paintAssistant(col); settleTurn(col.turns[col.turns.length - 1]); renderColumnActions(col); }
        }
        // Every column of this round failed (not by the user's Stop) → say so once, above the columns.
        const live = state.roundTargets.map((p) => state.columns.get(p)).filter((c) => c && !c.node.hidden);
        if (live.length && live.every((c) => c.status === 'error') && live.some((c) => c.errorCode !== CODE_ABORTED)) {
          showNotice('error', [t('all_failed'), t('all_failed_desc')]);
        }
        if (live.length) {
          const skipped = [...state.columns.values()].filter((c) => !c.node.hidden && !state.roundTargets.includes(c.provider) && c.turns.length && c.turns[c.turns.length - 1].role === 'skipped').length;
          track('round_done', { ok_n: live.filter((c) => c.status === 'done').length, err_n: live.filter((c) => c.status === 'error').length, skipped_n: skipped, ms: state.roundStartedAt == null ? -1 : Math.max(0, clock.now() - state.roundStartedAt) });
        }
        finishSend();
        return;
      }
      default:
    }
  }

  function renderConsumeFail(msg) {
    const status = Number(msg.status);
    if (status === HTTP_TOO_MANY && msg.code === CODE_COMPARE_QUOTA) {
      if (state.status.quota) { state.status.quota.remaining = 0; if (msg.resetsAt) state.status.quota.resetsAt = msg.resetsAt; }
      statusEpoch++;
      renderQuota(state.status.quota, null);
      const reset = localHHMM(msg.resetsAt || (state.status.quota && state.status.quota.resetsAt));
      showNotice('warn', [t('quota_exhausted', reset)], proCta());
      track('quota_exhausted', {});
      return;
    }
    if (status === HTTP_TOO_MANY) { showNotice('error', [t('err_rate_limited')]); return; }
    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
      state.status.loggedIn = false;
      showNotice('warn', [t(msg.code === 'scope_insufficient' ? 'err_scope_insufficient' : 'login_required'), t('login_required_desc')], loginCta(), NOTICE_OWNER_LOGIN);
      return;
    }
    if (status === HTTP_NOT_FOUND) { renderComingSoon(); return; }
    if (msg.code === CODE_NO_TARGETS) { showNotice('error', [t('err_no_targets')]); return; }
    if (msg.code === CODE_BUSY) { showNotice('warn', [t('err_busy')]); return; }
    if (msg.code === CODE_NETWORK_ERROR) { showNotice('error', [t('err_network_error')]); return; }
    if (msg.code === CODE_ABORTED) { showNotice('warn', [t('consume_aborted')]); return; }
    if (msg.code === CODE_SESSION_ENDED) { showNotice('warn', [t(state.idleEnded ? 'session_idle_ended' : 'session_ended')]); return; }
    if (msg.code === CODE_SEND_FAILED) { showNotice('error', [t('send_failed')]); return; }
    showNotice('error', [msg.message ? `${t('err_generic')} (${msg.message})` : t('err_generic')]);
  }

  function closePort() {
    stopKeepalive();
    const port = state.port;
    const listener = portListener;
    state.port = null;
    portListener = null;
    if (!port) return;
    if (listener && port.onMessage && typeof port.onMessage.removeListener === 'function') { try { port.onMessage.removeListener(listener); } catch { /* already gone */ } }
    try { port.disconnect(); } catch { /* already gone */ }
  }

  /**
   * One port per session. The SW keeps the provider clients for the port's lifetime and disposes
   * them on disconnect, so a session whose port is gone cannot be continued on it — a fresh port
   * with a FOLLOWUP as its first message would be a contract violation (Codex #6). The one way
   * on after a lost port is a KEPT session with continuations (D3, canResume()): then a fresh port
   * is opened and beginSend() makes its first message SEND{resume}. Returns null when the session
   * is over; callers must not send.
   */
  let portListener = null;
  function ensurePort() {
    if (state.port) return state.port;
    if (state.disabled) return null;
    if (state.sessionStarted && !canResume()) return null;
    let port;
    // connect() throws when the extension context is gone (update/reload); there is no disconnect
    // event to clean up after, so the caller treats null as "send failed" (Codex 2R #27).
    try { port = chrome.runtime.connect({ name: COMPARE_PORT_NAME }); } catch { return null; }
    // 🔴 Pinned to THIS port: a message that arrives after closePort() (새 대화, then a new SEND on
    // a new port) must not paint the old answer into the new session's columns or settle its
    // round. The listener is also removed on close, but the identity check is what the guard
    // proves — the removal is belt-and-braces (Codex 1R #1).
    const listener = (msg) => {
      if (state.port !== port) return;
      // For the port-loss diagnostic: when and what the SW last said on this port.
      lastMessageAt = clock.now();
      lastMessageType = msg && typeof msg.type === 'string' ? msg.type : '';
      onPortMessage(msg);
    };
    portListener = listener;
    lastMessageAt = null; lastMessageType = ''; lastPingAt = null; // the diagnostic describes THIS port only
    port.onMessage.addListener(listener);
    port.onDisconnect.addListener(() => settlePortLoss(port));
    state.port = port;
    return port;
  }
  /**
   * The port died under us (the SW's disconnect event, or a PING that threw): settle the page.
   * Idempotent per port — `state.port` is nulled on the first call, so the disconnect event
   * arriving after a thrown PING (or vice versa) settles nothing twice.
   */
  function settlePortLoss(port) {
    {
      if (state.port !== port) return; // closed by us (closePort) or already settled — nothing to do
      state.port = null;
      stopKeepalive();
      // ONE line so a 「연결이 끊겨…」 seen in the wild can be read: a large sinceLastMessageMs with
      // idleEnded = the SW went idle by design; a small one = the SW restarted / the context died.
      const now = clock.now();
      const sinceLastMessageMs = lastMessageAt == null ? null : now - lastMessageAt;
      if (con && typeof con.info === 'function') {
        try {
          con.info('[compare] port lost', {
            at: new Date(now).toISOString(),
            sinceLastMessageMs,
            lastMessageType,
            sinceLastPingMs: lastPingAt == null ? null : now - lastPingAt,
            idleEnded: state.idleEnded,
            sessionStarted: state.sessionStarted,
          });
        } catch { /* a console that throws must not stop the settlement */ }
      }
      // Died before consume — a first SEND, or a SEND{resume} on its fresh port (D3): nothing was
      // sent and the SW keeps no clients for it. Roll the round back completely so a retry starts
      // clean — leaving `participated` turns behind let a later FOLLOWUP name a provider the new
      // session never sent to (Codex 2R #29). A resume that dies this way stays resumable.
      if (!state.sessionStarted || state.resuming) {
        const wasResuming = state.resuming;
        state.resuming = false;
        if (state.sending) {
          onPortMessage({ type: 'CONSUME_FAIL', status: 0, code: CODE_SEND_FAILED });
          // v1 contract gap: the SW may have debited and died before CONSUME_OK reached us. The
          // page cannot know, so it re-reads the server's count — the quota line self-corrects
          // instead of claiming "not counted" against a remaining that already dropped.
          refreshQuota();
        }
        if (wasResuming) track('session_lost', { idle: false, since_ms: sinceLastMessageMs == null ? -1 : sinceLastMessageMs, last_type: lastMessageType, resumable: canResume() });
        return;
      }
      // SW went away mid-session: settle every streaming column as disconnected, end the session.
      for (const col of state.columns.values()) {
        if (col.status === 'streaming') onPortMessage({ type: 'ERROR', provider: col.provider, code: 'bridge_disconnected', message: '' });
      }
      state.sessionEnded = true;
      // A KEPT session with continuations is not over (D3): the notice says a follow-up picks it
      // up, and updateControls() (finishSend) leaves the composers enabled for it. Otherwise it is
      // the dead end 새 대화 leads out of.
      const resumable = canResume();
      if (resumable) showNotice('info', [t('session_lost_resumable')]);
      else showNotice('warn', [t(state.idleEnded ? 'session_idle_ended' : 'session_ended')]);
      track('session_lost', { idle: state.idleEnded, since_ms: sinceLastMessageMs == null ? -1 : sinceLastMessageMs, last_type: lastMessageType, resumable });
      finishSend();
    }
  }

  // ── keepalive (see the MV3 note at PORT_MSG_PING) ──
  let keepaliveTimer = null;
  let lastActivityAt = clock.now();
  // Port-loss diagnostic bookkeeping (see settlePortLoss): the last SW message on the live port,
  // and the last PING the page posted.
  let lastMessageAt = null;
  let lastMessageType = '';
  let lastPingAt = null;
  const keepaliveWanted = () => !!state.port && state.sessionStarted && !state.sessionEnded && !state.disabled;
  function startKeepalive() {
    if (keepaliveTimer != null || !keepaliveWanted()) return;
    keepaliveTimer = clock.setInterval(tickKeepalive, KEEPALIVE_MS);
  }
  function stopKeepalive() {
    if (keepaliveTimer == null) return;
    clock.clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  function tickKeepalive() {
    if (!keepaliveWanted()) { stopKeepalive(); return; }
    // The cap never fires while a round is in flight (a long answer is not idleness — the
    // countdown starts when the round settles, finishSend), and the SW keeps answering us anyway.
    if (!state.sending && clock.now() - lastActivityAt >= KEEPALIVE_MAX_IDLE_MS) {
      // Nobody has touched the page for KEEPALIVE_MAX_IDLE_MS: let the SW go. The session dies
      // by itself a little later, and the notice then says why (idle copy).
      state.idleEnded = true;
      stopKeepalive();
      return;
    }
    ping();
  }
  /** One PING on the live port; a throw means the port is already gone → settled as a disconnect. */
  function ping() {
    const port = state.port;
    lastPingAt = clock.now();
    try { port.postMessage({ type: PORT_MSG_PING }); } catch {
      // The SW's own disconnect event, if it still comes, finds `state.port` cleared and does nothing.
      settlePortLoss(port);
    }
  }
  /**
   * User activity: the idle clock restarts. A keepalive the cap had stopped resumes while the
   * session is still there — with a PING right now, not KEEPALIVE_MS from now: the last PING may
   * be almost 30 s old and the SW about to expire (Codex ka 1R #1).
   */
  function noteActivity() {
    lastActivityAt = clock.now();
    if (state.idleEnded && keepaliveWanted()) {
      state.idleEnded = false;
      startKeepalive();
      ping();
      return;
    }
    startKeepalive();
  }

  /**
   * `skipped`: participating columns that 「전체」 leaves out because they errored (AC21) — they get
   * the user turn plus a 「건너뜀」 marker. An individual follow-up touches only its target.
   */
  function beginSend(text, targets, type, skipped = []) {
    clearNotice();
    state.sending = true;
    state.roundTargets = targets.slice();
    state.roundStartedAt = clock.now();
    // A follow-up on a lost-but-resumable session (D3): the page treats it like a FOLLOWUP (user
    // turns pushed, columns kept) while the wire gets a first-message SEND{resume} on a new port.
    const resume = type === 'FOLLOWUP' && canResume();
    if (resume) state.resuming = true;
    // The first round fixes the routing set at 「전체」 (every participant); C's checkboxes prune it.
    if (type === 'SEND') state.followupTargets = new Set(targets);
    for (const col of state.columns.values()) {
      if (col.node.hidden) continue;
      // Snapshot for the CONSUME_FAIL rollback: nothing was sent, so nothing should remain drawn.
      col.round = { turns: col.turns.length, status: col.status, errorCode: col.errorCode, errorTitle: col.errorTitle, badgeKey: col.badgeKey, badgeCls: col.badgeCls, servedModel: col.servedModel, stages: col.stages };
      if (targets.includes(col.provider)) {
        col.participated = true;
        // The first round's question is the prompt card above — shown once; follow-ups repeat theirs.
        if (type !== 'SEND') pushUserTurn(col, text);
        pushAssistantTurn(col);
      } else if (skipped.includes(col.provider)) {
        pushUserTurn(col, text);
        pushSkippedTurn(col);
      }
    }
    updateControls();
    const port = ensurePort();
    if (!port) { // session over / page disabled / context gone — undo the optimistic turns
      state.resuming = false;
      onPortMessage({ type: 'CONSUME_FAIL', status: 0, code: state.sessionStarted ? CODE_SESSION_ENDED : CODE_SEND_FAILED });
      return;
    }
    let msg;
    if (type === 'SEND') msg = { type: 'SEND', text, targets, mayOpenTab: true, saveHistory: !!state.saveHistory };
    else if (resume) {
      // EVERY continuation the page holds, not just the targets': the SW keeps the unused seeds
      // until each provider's client is constructed, so a column first asked in a LATER
      // follow-up still continues its own conversation (batch-3 Codex #1). saveHistory is
      // true by construction — only a kept session is resumable.
      const cont = {};
      for (const c of liveColumns()) if (c.continuation) cont[c.provider] = c.continuation;
      msg = { type: 'SEND', text, targets, mayOpenTab: true, saveHistory: true, resume: cont };
    } else msg = { type: 'FOLLOWUP', text, targets };
    track('send', { round: state.rounds + 1, targets_n: targets.length, targets: targets.join(','), save_history: type === 'SEND' ? !!state.saveHistory : state.sessionSaveHistory === true, followup: type !== 'SEND', resume });
    // Per-provider model choice (addendum): only when at least one target has a catalog; the SW
    // persists it to `compareModels` and uses it for this send.
    const models = modelsFor(targets);
    if (Object.keys(models).length) msg.models = models;
    // The pickers this page still shows as static/none (#1452 refresh): the SW re-lists exactly these
    // once the tabs exist and answers with MODELS, which updates this list.
    const pending = Array.isArray(state.status?.modelsPending) ? state.status.modelsPending.filter((p) => typeof p === 'string' && targets.includes(p)) : [];
    if (pending.length) msg.modelsPending = pending;
    try {
      port.postMessage(msg);
    } catch {
      closePort();
      onPortMessage({ type: 'CONSUME_FAIL', status: 0, code: CODE_SEND_FAILED });
    }
  }

  function finishSend() {
    state.sending = false;
    lastActivityAt = clock.now(); // the idle countdown starts when the round settles, not when it began
    stopBtn.disabled = true;
    syncWaitTimer();
    updateControls();
  }

  function currentTargets() {
    if (state.disabled || !state.status || !state.status.loggedIn) return [];
    return sendableTargets(state.status, src, state.excludeSrc);
  }

  /** Participating, visible columns — the follow-up routing's universe. */
  const liveColumns = () => [...state.columns.values()].filter((c) => c.participated && !c.node.hidden);
  /**
   * A lost port is survivable (D3) only for a session whose SEND carried saveHistory:true — the
   * provider conversations still exist — and only through a column that reported a continuation
   * (DONE.continuation). An incognito session, or one lost before any DONE, has nothing to resume.
   */
  const canResume = () => state.sessionStarted && state.sessionEnded && state.sessionSaveHistory === true && liveColumns().some((c) => !!c.continuation);
  /** A participating column the session can no longer reach: its port is gone (or was replaced by a resume) and it never reported a continuation. */
  const columnDead = (col) => (state.sessionEnded || state.resumed) && !col.continuation;
  // Follow-ups need the same login the first send needed: a 401/403 on a follow-up consume flips
  // `loggedIn` to false and must stop the next click too (Codex #5). And no port ⇒ no session —
  // unless the session can be resumed on a new one (canResume).
  const canFollowUp = () => state.sessionStarted && !state.disabled && !!(state.status && state.status.loggedIn) && ((!state.sessionEnded && !!state.port) || canResume());

  /**
   * { targets, skipped } for the current follow-up routing set (AC21 + item 2). Every participant
   * checked (「전체」) keeps today's rule: columns whose error a resend cannot cure (sign-in,
   * provider limits, timeouts) are skipped — but a lost TAB is cured by the resend itself (the SW
   * prepares FOLLOWUP with mayOpenTab:true and re-opens it), so those stay in; their error copy
   * tells the user exactly that. A partial set sends to exactly the checked columns (an errored
   * one is retried). On a lost-but-resumable session (D3) only columns holding a continuation can
   * be sent to; the other checked ones are skipped with 「건너뜀」. Zero checked → no targets.
   */
  function followupPlan() {
    if (!canFollowUp()) return { targets: [], skipped: [] };
    const live = liveColumns();
    const checked = live.filter((c) => state.followupTargets.has(c.provider));
    let targets;
    let skipped;
    if (checked.length === live.length) {
      const retriable = (c) => c.status !== 'error' || TAB_LOST_CODES.has(c.errorCode);
      targets = live.filter(retriable);
      skipped = live.filter((c) => !retriable(c));
    } else {
      targets = checked;
      skipped = [];
    }
    // Lost-but-resumable, or already resumed: a column without a continuation has no client
    // behind it any more (batch-3 Codex #1) — skipped, never sent to as a fresh conversation.
    if (canResume() || state.resumed) {
      skipped = [...skipped, ...targets.filter((c) => columnDead(c))];
      targets = targets.filter((c) => !columnDead(c));
    }
    return { targets: targets.map((c) => c.provider), skipped: skipped.map((c) => c.provider) };
  }

  /**
   * Routing boxes: 「전체」 + every participating column, one checkbox each; the set is pruned to
   * the columns that still exist. The input NODES are reused whenever the choice set is
   * unchanged — rebuilding them on every `change` replaced the focused input and broke keyboard
   * navigation (Codex 1R #1); only `checked` / `disabled` are updated in place. 「전체」 is checked
   * exactly when every column is.
   */
  function renderFollowupTargets() {
    const live = liveColumns();
    const choices = [[FOLLOWUP_ALL, t('followup_target_all'), null]];
    for (const col of live) choices.push([col.provider, PROVIDER_META[col.provider].label, col.provider]);
    state.followupTargets = new Set(live.map((c) => c.provider).filter((p) => state.followupTargets.has(p)));
    const all = live.length > 0 && state.followupTargets.size === live.length;
    // Same choices, same nodes, in every instance; each instance's boxes carry their own name.
    for (const { select, radioName } of composers) {
      const existing = Array.from(select.querySelectorAll('input'));
      const same = existing.length === choices.length && existing.every((input, i) => input.value === choices[i][0]);
      if (!same) {
        clear(select);
        for (const [v, label, provider] of choices) {
          const item = el('label', 'cmp-seg-item' + (provider ? '' : ' cmp-seg-item-all'));
          const input = el('input');
          input.type = 'checkbox';
          input.name = radioName;
          input.value = v;
          input.setAttribute('value', v);
          item.appendChild(input);
          const text = el('span', 'cmp-seg-label');
          if (provider) text.appendChild(dot(provider));
          text.appendChild(el('span', null, label));
          item.appendChild(text);
          select.appendChild(item);
        }
      }
      for (const input of select.querySelectorAll('input')) {
        input.checked = input.value === FOLLOWUP_ALL ? all : state.followupTargets.has(input.value);
        input.disabled = state.sending;
      }
    }
  }
  /** The bottom caption: 「전체」, the checked labels (`Claude + Gemini`), or the pick-one hint. */
  function followupTargetText() {
    const live = liveColumns();
    const checked = live.filter((c) => state.followupTargets.has(c.provider));
    if (live.length && checked.length === live.length) return t('followup_target_all');
    if (!checked.length) return t('followup_target_none');
    return checked.map((c) => PROVIDER_META[c.provider].label).join(' + ');
  }

  function updateControls() {
    const canSend = !state.sending && !state.sessionStarted && currentQuestion().length > 0 && currentTargets().length > 0;
    sendBtn.disabled = !canSend;
    sendBtn.textContent = state.sending ? t('sending') : t('send');
    // Once the session started the question card is a record, not a composer: the whole action
    // row (exclude checkbox, hint, send button) leaves — the follow-up composers are the way
    // forward (finding B), the topbar chip still says where the question came from, and the
    // columns show who got it. Every pixel here is a pixel the columns do not get.
    sendBtn.hidden = state.sessionStarted;
    controls.hidden = state.sessionStarted;
    // The question is on the wire from the first click: locked (readOnly keeps focus and the
    // caret, unlike disabled) until the round settles — CONSUME_FAIL unlocks, CONSUME_OK freezes.
    qInput.readOnly = state.sending || state.sessionStarted;
    // Locked from the first click: flipping it while consume is pending would hide a column that
    // is already being sent to (Codex #10).
    excludeInput.disabled = state.sessionStarted || state.sending;
    incognitoInput.disabled = state.sessionStarted || state.sending;
    syncSaveHistory();
    // Model pills lock while a send is in flight (addendum) — the choice was already put on the wire.
    for (const col of state.columns.values()) { col.modelSelect.disabled = state.sending; syncModelHint(col); }
    // A session to leave is what makes 새 대화 meaningful (also the way out of a dead session).
    newChatBtn.disabled = !state.sessionStarted;
    for (const col of state.columns.values()) renderColumnActions(col);
    syncCopyAll();
    for (const c of composers) c.section.hidden = !state.sessionStarted;
    dock.hidden = !state.sessionStarted;
    if (state.sessionStarted) {
      renderFollowupTargets();
      // Drafting is allowed while a round streams (the textarea stays enabled); only the send
      // waits for the round to settle.
      const noTargets = followupPlan().targets.length === 0;
      const canType = canFollowUp();
      const targetText = followupTargetText();
      for (const c of composers) {
        c.btn.disabled = state.sending || noTargets;
        c.input.disabled = !canType;
        if (c.caption) c.caption.textContent = targetText;
      }
    }
  }

  /**
   * New chat: abort what is in flight, drop the port (the SW disposes the session's temporary
   * conversations on disconnect), and return every piece of page state to what a fresh load has —
   * except the status answer, which is re-read (gates, quota) rather than assumed.
   */
  function resetSession() {
    // No session → nothing to leave; the guard is repeated here so a stale-enabled button cannot
    // tear down a first SEND that is still waiting for its CONSUME_OK.
    if (state.disabled || !state.sessionStarted) return;
    track('new_chat', { rounds: state.rounds, resumable: canResume() });
    if (state.sending && state.port) { try { state.port.postMessage({ type: 'ABORT' }); } catch { /* port already gone */ } }
    closePort();
    state.sending = false;
    state.sessionStarted = false;
    state.sessionEnded = false;
    state.resumed = false;
    state.resuming = false;
    state.idleEnded = false;
    state.sessionSaveHistory = null; // the toggle keeps the user's last choice; the next SEND fixes it again
    state.question = '';
    state.pendingFollowup = '';
    state.roundTargets = [];
    state.rounds = 0;
    state.roundStartedAt = null;
    state.followupTargets = new Set();
    statusEpoch++; // a status answer asked before the reset describes the old session
    for (const col of state.columns.values()) resetColumn(col);
    releasePrompt();
    clearCopyFeedback();
    for (const c of composers) { c.input.value = ''; autoGrow(c.input); }
    clearNotice();
    stopBtn.disabled = true;
    syncWaitTimer();
    updateControls();
    qInput.focus();
    refreshStatus();
  }

  // ── status ──
  // A COMPARE_STATUS answer is a snapshot of the moment it was ASKED. Anything that made the page's
  // own count newer since — a CONSUME_OK / quota CONSUME_FAIL, or 새 대화 — bumps this epoch, and
  // an answer that comes back under an older epoch is dropped whole (the next call redoes it).
  // Without it the refresh 새 대화 launches, or a pre-consume disconnect's refreshQuota, lands after
  // the replacement round's CONSUME_OK and paints the old count over the new one (Codex 2R #1).
  let statusEpoch = 0;
  /** Quota line only — re-read after a send whose outcome the page could not observe. */
  async function refreshQuota() {
    if (state.disabled) return;
    const epoch = statusEpoch;
    const res = await sendMessage(chrome, { type: 'COMPARE_STATUS' });
    if (epoch !== statusEpoch) return; // stale: a newer count was written while this was in flight
    if (!res || !res.ok || !state.status) return;
    state.status.quota = res.quota;
    renderQuota(res.quota, res.quotaError);
  }

  // One status read at a time: a second call while one is in flight under the SAME epoch joins
  // it (a reset bumps the epoch, so its own read still goes out). `state.checking` is what the
  // gates show as 「확인 중…」.
  let statusInflight = null; // { epoch, promise }
  function refreshStatus() {
    if (state.disabled) return Promise.resolve(); // coming-soon is final for this page load
    if (statusInflight && statusInflight.epoch === statusEpoch) return statusInflight.promise;
    const epoch = statusEpoch;
    const promise = readStatus(epoch).finally(() => {
      if (statusInflight && statusInflight.epoch === epoch) statusInflight = null;
      setChecking(!!statusInflight);
    });
    statusInflight = { epoch, promise };
    setChecking(true);
    return promise;
  }
  function setChecking(on) {
    state.checking = on;
    for (const col of state.columns.values()) syncGateStatus(col);
  }
  async function readStatus(epoch) {
    const res = await sendMessage(chrome, { type: 'COMPARE_STATUS' });
    if (epoch !== statusEpoch) return; // stale (see statusEpoch) — nothing of it is applied
    state.status = res && res.ok ? res : { ok: false, flagOn: false };
    const qe = state.status.quotaError;
    if (!state.status.flagOn || (qe && Number(qe.status) === HTTP_NOT_FOUND)) { renderComingSoon(); return; }
    // The notice slot: a status read clears / replaces only what a status read put there. A
    // consume error or the quota notice (page-owned) stays through an auto-reconnect read — the
    // one exception is the extension-login notice, which replaces anything (see showLoginRequired).
    const signedOut = !state.status.loggedIn || (qe && (Number(qe.status) === HTTP_UNAUTHORIZED || Number(qe.status) === HTTP_FORBIDDEN));
    // …and a consume-time login notice is resolved by a read that finds the extension signed in.
    if (statusOwnsNotice() || (state.notice.owner === NOTICE_OWNER_LOGIN && !signedOut)) clearNotice();
    renderQuota(state.status.quota, qe);
    if (signedOut) {
      state.status.loggedIn = false;
      showLoginRequired();
    } else if (qe && statusOwnsNotice()) {
      // bg/compare.js reports a failed status call as {status:0, code:'network_error'}.
      showNotice('error', [t(qe.code === CODE_NETWORK_ERROR ? 'err_network_error' : 'err_generic')], null, NOTICE_OWNER_STATUS);
    }
    // The stored preference seeds the toggle until the user touches it on this page.
    // Never while a SEND is in flight or a session exists: the value on the wire is fixed, and a
    // late answer must not flip the toggle out from under it (Codex wire 1R #1).
    if (!state.saveTouched && !state.sessionStarted && !state.sending) state.saveHistory = state.status.saveHistory === true;
    renderColumns();
    syncZeroTargetsNotice();
    updateControls();
  }

  // ── auto-reconnect (login guidance) ──
  // The user signs in to a provider in another tab and comes back: the tab regaining focus /
  // visibility (or being restored from bfcache) re-reads the status, so the gate opens by itself
  // instead of asking for a reload. Only before a session (a gated column cannot join a running
  // one — the manual 「다시 확인」 still works there and shows GATE_JOINED), never while a send is
  // pending, only when something is gated, at most once per AUTO_REFRESH_MIN_MS.
  let lastAutoRefreshAt = -Infinity;
  function autoRefresh() {
    if (state.disabled || state.sessionStarted || state.sending || !anyGate()) return;
    const now = clock.now();
    if (now - lastAutoRefreshAt < AUTO_REFRESH_MIN_MS) return;
    lastAutoRefreshAt = now;
    refreshStatus();
  }
  // This mount's identity in the registry: a teardown removes only its OWN entry — a late
  // coming-soon of a replaced mount must not strip the replacement's listeners (Codex b2 3R #3).
  const mountToken = {};
  /** Drop the auto-reconnect listeners registered on this document — any mount's at mount time, only this mount's at teardown. */
  function removeAutoRefreshListeners(onlyMine) {
    const prev = AUTO_REFRESH_LISTENERS.get(doc);
    if (!prev || (onlyMine && prev.token !== mountToken)) return;
    AUTO_REFRESH_LISTENERS.delete(doc);
    try { if (typeof prev.doc.removeEventListener === 'function') prev.doc.removeEventListener('visibilitychange', prev.visibility); } catch { /* gone */ }
    try {
      if (prev.win && typeof prev.win.removeEventListener === 'function') { prev.win.removeEventListener('focus', prev.focus); prev.win.removeEventListener('pageshow', prev.pageshow); }
    } catch { /* gone */ }
  }
  removeAutoRefreshListeners(false); // a previous mount on this document must not keep reading too
  {
    // Focus / visibility are user activity for the keepalive's idle clock as well. Becoming visible
    // also re-measures the composers (H): a page mounted while hidden may never have had a width.
    const regrow = () => { autoGrow(qInput); for (const c of composers) autoGrow(c.input); };
    const handlers = { token: mountToken, win, doc, focus: () => { noteActivity(); autoRefresh(); }, pageshow: (e) => { if (e && e.persisted) autoRefresh(); }, visibility: () => { if (doc.visibilityState === 'visible') { noteActivity(); autoRefresh(); regrow(); } } };
    if (typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', handlers.visibility);
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('focus', handlers.focus);
      win.addEventListener('pageshow', handlers.pageshow);
    }
    AUTO_REFRESH_LISTENERS.set(doc, handlers);
  }

  // ── events ──
  excludeInput.addEventListener('change', () => {
    state.excludeSrc = !!excludeInput.checked;
    renderColumns();
    updateControls();
  });
  incognitoInput.addEventListener('change', () => {
    state.saveHistory = !incognitoInput.checked;
    state.saveTouched = true;
    syncSaveHistory();
    track('incognito_toggle', { on: !!incognitoInput.checked });
  });
  /** First send, from the button or Enter in the question card. */
  function sendInitial() {
    noteActivity();
    const text = currentQuestion();
    const targets = currentTargets();
    // 🔴 AC17: no targets → no port, no consume. `disabled` alone is not a guarantee (a stale
    // status could re-enable the button between renders), so the guard is repeated here. The
    // `sending` check also makes Enter + click in the same tick a single send: beginSend flips
    // it synchronously before anything is awaited.
    if (state.disabled || !targets.length || state.sending || state.sessionStarted || !text) return;
    state.question = text;
    state.sessionSaveHistory = !!state.saveHistory; // fixed for the session (FOLLOWUP carries no field)
    beginSend(text, targets, 'SEND');
  }
  sendBtn.addEventListener('click', sendInitial);
  bindComposer(qInput, sendInitial, updateControls, win);
  qInput.addEventListener('keydown', noteActivity);
  stopBtn.addEventListener('click', () => {
    if (!state.port || !state.sending) return;
    state.port.postMessage({ type: 'ABORT' });
    stopBtn.disabled = true;
    track('stop', { round: state.rounds + 1 });
  });
  newChatBtn.addEventListener('click', resetSession);
  /** A follow-up from `from`: its text goes out, every instance is emptied (they held the same draft). */
  function sendFollowup(from) {
    noteActivity();
    const text = String(from.input.value || '').trim();
    const { targets, skipped } = followupPlan();
    if (!text || !targets.length || state.sending || !canFollowUp()) return;
    state.pendingFollowup = text;
    for (const c of composers) { c.input.value = ''; autoGrow(c.input); }
    beginSend(text, targets, 'FOLLOWUP', skipped);
  }
  /** Typing in one instance shows up in the other(s) — one draft, two places to write it. */
  function mirrorDraft(from) {
    for (const c of composers) {
      if (c === from || c.input.value === from.input.value) continue;
      c.input.value = from.input.value;
      autoGrow(c.input);
    }
  }
  for (const c of composers) {
    // The boxes bubble `change` up to the group. 「전체」 checks / unchecks every column at once;
    // a column box toggles itself. The set is rebuilt from the group's boxes, so a programmatic
    // change (tests, restored state) resolves the same way; the other instance's group follows
    // through updateControls → renderFollowupTargets.
    c.select.addEventListener('change', (e) => {
      const inputs = Array.from(c.select.querySelectorAll('input'));
      const target = e && e.target && typeof e.target.value === 'string' ? e.target : null;
      if (target && target.value === FOLLOWUP_ALL) {
        for (const i of inputs) { if (i.value !== FOLLOWUP_ALL) i.checked = !!target.checked; }
      }
      state.followupTargets = new Set(inputs.filter((i) => i.value !== FOLLOWUP_ALL && i.checked).map((i) => i.value));
      updateControls();
      track('target_change', { targets: [...state.followupTargets].join(',') });
    });
    bindComposer(c.input, () => sendFollowup(c), () => mirrorDraft(c), win);
    c.input.addEventListener('keydown', noteActivity);
    c.btn.addEventListener('click', () => sendFollowup(c));
  }

  // The question card takes focus on load: empty → start typing; pre-filled from `?q` → the
  // caret sits at the end, so Enter sends as-is and typing appends.
  autoGrow(qInput);
  qInput.focus();
  if (q && typeof qInput.setSelectionRange === 'function') qInput.setSelectionRange(q.length, q.length);

  track('open', { src: src || '', framed: !!embedHost, lang, has_q: !!q });
  refreshStatus();

  // Exposed for the flow guard only.
  return { state, refreshStatus, sendableTargets: currentTargets };
}

// ── bootstrap (real page only) ──
if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById('compare-root')) {
  listenEmbedTheme(window, document);
  // Framed by the web shell: the SHELL's language (`?lang=ko|en`, the site header's toggle) wins,
  // so the page matches the site around it; the extension's own tab keeps the extension setting.
  const shellLang = embedHostOf(window) ? new URLSearchParams(window.location.search || '').get('lang') : null;
  chrome.storage.sync.get({ lang: 'auto' }, (cfg) => {
    mountComparePage({
      chrome,
      document,
      location: window.location,
      window,
      lang: shellLang === 'ko' || shellLang === 'en' ? shellLang : resolveLang(cfg && cfg.lang, navigator.language),
      raf: (fn) => window.requestAnimationFrame(fn),
    });
  });
}
