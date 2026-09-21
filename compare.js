// compare.html — send one question to every AI the user is signed in to and stream the answers
// side by side (issue #1452, plan docs/plans/multi-ai-compare.md).
//
// This file is the PAGE half of the contract in .omc/handoffs/phase3-contract.md. The service
// worker half (bg/compare.js) owns tabs, the vendored web-session clients and the quota calls; this
// page only talks to it:
//   chrome.runtime.sendMessage({type:'COMPARE_STATUS'})            → who is logged in / permitted, quota,
//                                                                     models catalog + selectedModels (v1.31 addendum)
//   chrome.runtime.connect({name:'ctcmp-compare'})                  → SEND / FOLLOWUP (+ `models` map, `kind`, `round`) / ABORT out,
//                                                                     CONSUME_OK|CONSUME_FAIL / CHUNK / MODEL / DONE(.model) / ERROR(.reason/.detail) / DIAG / ALL_DONE / MODELS in
//   chrome.runtime.sendMessage({type:'COMPARE_RESET'})             → beta only (status.betaReset): clear today's count → {ok, quota}
//   chrome.permissions.request({origins:[…]})                        → from a click handler only (AC16)
//
// Framed by the claudetuner.com web shell (site/multiai/, #1453): ui/embed-ready.js runs first and
// resolves the allowed host into `window.__ctEmbedHost`; this page then (a) applies `{__ctTheme}`
// messages from THAT origin and parent only, (b) falls back to a real extension tab when the
// permission prompt cannot be shown from inside the frame. Not framed → `__ctEmbedHost` is null and
// none of it runs.
//
// 🔴 Model text is rendered ONLY through ui/md-render.js (markdown-it tokens → createElement/textContent). There is no
// innerHTML anywhere in this file — test/compare-xss-guard.mjs greps for it.
//
// 🔴 Zero sendable columns → the send button is disabled AND `connect` is never called (AC17): the
// consume call lives behind the port, so "never open the port" is what makes "no consume" true.
// test/compare-page-flow-guard.mjs asserts both halves.
//
// Structure: `mountComparePage(deps)` takes every platform object it touches (chrome, document,
// location, raf, clock, navigator) so the flow guard can drive it with fakes; the bootstrap at the
// bottom wires the real ones. The mount is split into SLICES under ui/compare/ (constants.js,
// helpers.js, history.js, …) that share one `ctx` object — see the ctx block below and the header
// of ui/compare/history.js for the contract; the public names stay exported from this file.
//
// Page shape (2026-09-20 chat layout, user decision — chathub-style): topbar (중지 · 새 대화) →
// notices → columns → ONE composer, the dock (empty state = intro + example chips, then the
// composer card) at the viewport bottom. Before the first CONSUME_OK the dock holds the QUESTION
// composer (#cmp-question, 원본 제외 · 시크릿 대화 toggles); from the first CONSUME_OK it holds the
// FOLLOW-UP composer (#cmp-followup-input, the routing checkboxes) — two sections in one dock,
// one shown at a time (updateControls).
// Hero layout (2026-09-21, user decision A — over "collapse the columns only"): BEFORE the first
// accepted send the dock sits at the TOP, right under the notices, and the columns are a thin
// strip of heads under it (`#compare-root.is-hero`, compare.css ── hero ──) — three tall empty
// columns over a composer at the bottom hid where to type. commitPrompt (the first CONSUME_OK,
// a loaded session) moves the dock below the columns and drops the class; releasePrompt (새 대화)
// puts it back. `?q=` entry is still pre-session → hero with the prefilled composer.
// The question itself is drawn INSIDE every column that received it, as a right-aligned bubble
// at the top of the thread (renderQuestionBubbles) — display only: it is never a stored turn
// (provenance / history / retry read state.question and the first-round rule exactly as before).
// 새 대화 closes the port — the SW contract makes that the session's end — and rebuilds the
// pre-send state.
//
// UX batch 3 (2026-09-17, .omc/handoffs/ux3-contract.md): the column head's provider name links
// to the site (B) and shows the account plan from COMPARE_STATUS.providers[p].plan (A); follow-up
// routing is a checkbox set + 「전체」 (C, `state.followupTargets`); the history toggle is
// 「시크릿 대화」 (D — checked ⇔ SEND saveHistory:false; `html[data-incognito="1"]` tints the page)
// and a kept session survives a lost port: DONE.continuation is remembered per column and the
// next follow-up opens a NEW port whose first message is SEND{resume} (D3, see canResume());
// usage analytics go out as COMPARE_EVENT (E, track()); a composer laid out at zero width never
// commits a height (H); every copy is visible (I).

import { makeT, resolveLang } from './ui/compare-i18n.js';
import { COMPARE_PROVIDERS, MAX_COLUMNS, colIdOf, parseColId, normalizeColId, ColumnMap, PROVIDER_META, LOGIN_URL, PRO_URL, QUOTA_LOW_REMAINING, FOLLOWUP_ALL, COPY_KIND_QUESTION, COPY_KIND_COLUMN, COPY_KIND_ALL, EVENT_MSG_TYPE, SEND_KIND_SEND, SEND_KIND_FOLLOWUP, SEND_KIND_SUMMARY, SEND_KIND_RETRY, SEND_KIND_RESUME, RESET_MSG_TYPE, RESET_CODE_STATUS_UNAVAILABLE, FOLLOWUP_ID_BOTTOM, SVG_NS, MODEL_SOURCE_REQUESTED, FOLLOW_AT_BOTTOM_PX, AUTO_REFRESH_MIN_MS, GATE_JOINED, NOTICE_OWNER_PAGE, NOTICE_OWNER_STATUS, NOTICE_OWNER_LOGIN, NOTICE_OWNER_QUOTA, AUTO_REFRESH_LISTENERS, HTTP_UNAUTHORIZED, HTTP_FORBIDDEN, HTTP_NOT_FOUND, CODE_NETWORK_ERROR, BADGE_STALLED_CLS, TAB_LOST_CODES, CODE_AUTH_REQUIRED, GATE_CODES, STAGE_SEND_START, STAGE_FIRST_CHUNK, STAGE_STREAM_DONE, HISTORY_TEXT_MAX, HISTORY_SEARCH_DEBOUNCE_MS, EXAMPLE_CHIP_COUNT, EXAMPLE_Q_MAX, TURN_KIND_SUMMARY, TTFT_MAX_MS, BADGE_WAITING, WAIT_TICK_MS, WAIT_ELAPSED_SHOW_MS, MS_PER_SECOND } from './ui/compare/constants.js';
import { sendMessage, localHHMM, autoGrow, bindComposer, embedHostOf, listenEmbedTheme, sendableTargets } from './ui/compare/helpers.js';
import { installHistory } from './ui/compare/history.js';
import { installSummary } from './ui/compare/summary.js';
import { installColumnGate } from './ui/compare/column-gate.js';
import { installModelPicker } from './ui/compare/model-picker.js';
import { installExport } from './ui/compare/export.js';
import { installColumnThread } from './ui/compare/column-thread.js';
import { installActivity } from './ui/compare/activity.js';
import { installPort } from './ui/compare/port.js';
// The public surface stays on compare.js (test/compare-page-flow-guard.mjs imports it from here).
export { COMPARE_PORT_NAME, COMPARE_PROVIDERS, MAX_COLUMNS, MODEL_AUTO_ID, colIdOf, parseColId, normalizeColId, PROVIDER_META, LOGIN_URL, PRO_URL, PORT_MSG_PING, KEEPALIVE_MS, KEEPALIVE_MAX_IDLE_MS } from './ui/compare/constants.js';
export { listenEmbedTheme, sendableTargets, localHHMM } from './ui/compare/helpers.js';

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
  // The page layout (`compareColumns`, an array of colIds) lives in chrome.storage.sync like the
  // model choices; injectable for the flow guard. Read once at mount, applied at the first status
  // (ensureDefaultColumns), written on every layout change (saveLayout).
  const syncStorage = deps.syncStorage || (chrome && chrome.storage && chrome.storage.sync) || null;
  // Randomness (the example pick) — injectable so the flow guard can pin a shuffle.
  const random = typeof deps.random === 'function' ? deps.random : Math.random;
  const t = makeT(lang);
  const root = doc.getElementById('compare-root');
  if (!root) return null;
  const HERO_CLASS = 'is-hero'; // on the root before the first accepted send (hero layout, see the header)
  const FOCUS_CLASS = 'is-focus'; // on the root while one column is shown wide (focus mode, see setColumnFocus)
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
    columns: new ColumnMap(), // colId → column record (see ColumnMap: a legacy provider key reads as the provider's first column)
    columnIds: [],        // the page's columns in DOM order (colIds)
    storedColumns: null,  // `compareColumns` from storage.sync (validated colIds), null = none / not read yet
    modelSelectSeq: 0,    // per-page monotonic suffix for a later column's model select id (never reused)
    pickerFor: null,      // colId whose picker popover is open (null = closed)
    pickerKind: null,     // which list the open popover holds: 'model' (the [Auto ▾] face) | 'service' (the ▾ after the name); null = closed
    focusedCol: null,     // colId shown at full width (focus mode, setColumnFocus); null = the grid. Page-local, never stored
    followupTargets: new Set(), // colIds the next follow-up goes to (C); every participant checked = 「전체」 (AC21 skip rule)
    pendingFollowupCol: null, // colId whose column composer sent the follow-up in flight (null = the dock) — a CONSUME_FAIL hands the draft back to that column's input
    question: '',         // the first-round text as sent (snapshot at click; the card freezes to it on CONSUME_OK)
    pendingFollowup: '',  // follow-up text in flight, restored to the input on CONSUME_FAIL
    roundTargets: [],     // colIds the in-flight / last round was sent to (col.round is the rollback snapshot and dies at CONSUME_OK)
    rounds: 0,            // rounds accepted (CONSUME_OK) in this session — analytics `send.round`
    sessionId: null,      // local history entry of this session (assigned at the first CONSUME_OK or when a stored session is loaded)
    historyCache: [],     // the last history list read for the panel — the search filters this, never storage (C2)
    roundStartedAt: null, // clock.now() at the last beginSend — analytics `round_done.ms`
    checking: false,      // a COMPARE_STATUS read is in flight (gates show 「확인 중…」)
    notice: null,         // { kind, owner } of the notice on screen (see NOTICE_OWNER_*), null when none
    idleEnded: false,     // the keepalive stopped for lack of activity (the session then dies by itself: idle copy)
    summaryPending: null, // colId of the judge whose 「요약·비교」 FOLLOWUP awaits its CONSUME_OK / CONSUME_FAIL (C5)
    judgeChoice: null,    // colId the user picked as judge in the popover this session (null = judgeDefault())
    roundSeq: 0,          // monotonic id of the last round beginSend put on the wire — every turn it draws carries it (C5 provenance)
    roundInFlight: null,  // the round of the send awaiting its CONSUME_OK (a retry names the round it repeats)
    quotaGen: 0,          // bumped at a beta reset's request AND its completion (cmp-beta-contract §5, Codex 2R): a round that began under an older gen carries a pre-reset quota snapshot in its CONSUME_OK/FAIL — settled, but its count is not applied (refreshQuota instead)
    roundGen: 0,          // quotaGen as it was when the in-flight round went out
    activeRound: null,    // the round of the last ACCEPTED non-summary send — the comparison the user is working on (a retry of round 1 makes round 1 active again; a summary never moves it)
    firstRound: null,     // the round of the accepted first SEND — its request is the question card, not a user turn (persisted; a later round without a user turn has NO request)
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

  // ── ctx: the shared closure of the mountComparePage() slices (ui/compare/*.js) ──
  // One object every slice module installs onto: the stable platform refs below, the DOM refs
  // attached as they are created (`ctx.qInput = qInput` — a slice reads them lazily, at call
  // time), and every nested function of this file a slice may call (`ctx.updateControls()`).
  // Function declarations hoist, so they can be registered here; a `const x = () =>` arrow is in
  // its TDZ until defined and is registered right after its definition (`ctx.x = x;`). A `let`
  // shared with a slice goes through a ctx field (ctx.pendingLoad) or a setter (bumpStatusEpoch).
  // The contract is written up in ui/compare/history.js (the template slice).
  const ctx = { chrome, doc, win, location, lang, t, state, clock, nav, con, syncStorage, random, raf, root, params, src, q, embedHost, track, el, clear, link, dot, deps };
  Object.assign(ctx, {
    // stays in compare.js
    openInExtensionTab, examplePool, pickExamples, renderExampleChips, renderExamplesIntro, commitPrompt, releasePrompt,
    renderQuestionBubbles, makeFollowupComposer, syncSaveHistory, showNotice, showLoginRequired, renderComingSoon, renderQuota, renderQuotaLine,
    syncQuotaNotice, quotaExhaustedTitle, betaReset, renderResetOffer, requestReset, columnFor, setBadge, waitingSeconds,
    ttftSeconds, paintBadge, lastAssistantTurn, setServedModel, waitingColumns, countdownColumns, syncWaitTimer, tickWaiting,
    errorLineText, retireCountdown, sendKindFor, ensureDefaultColumns, ensureLayout, columnChoices, addColumnByUser, removeColumnByUser,
    chooseColumn, saveLayout, readLayout, removeColumn, renderColumns, setColumnFocus, toggleColumnFocus, syncFocusButton, anyGate, syncZeroTargetsNotice, followupPlan,
    renderFollowupTargets, followupTargetText, updateControls, resetSession, refreshQuota, refreshStatus, setChecking, readStatus,
    autoRefresh, removeAutoRefreshListeners, sendInitial, sendFollowup, mirrorDraft, bumpStatusEpoch,
    currentStatusReadSeq,
  });
  // Install the slices (they only register functions on ctx; nothing runs here), then take the
  // names this file calls bare. Every slice function is also reachable as ctx.name(...).
  installHistory(ctx);
  installSummary(ctx);
  installColumnGate(ctx);
  installModelPicker(ctx);
  installExport(ctx);
  installColumnThread(ctx);
  installActivity(ctx);
  installPort(ctx);
  const { historyStorage, historyUpdate, newSessionId, snapshotSession, fitEntry, persistSession, syncHistoryButton, paintHistoryList, openHistoryPanel, closeHistoryPanel, clearHistory, loadSession } = ctx;
  const { focusQuietly, clearCopyFeedback, attachCopy, copyButton, allColumns, firstColumnOf, colLabel, modelLabelOf, compareMarkdown, columnMarkdown, syncCopyAll } = ctx;
  const { closePicker, togglePicker, toggleServicePicker, syncServiceButton, applyModelPick, renderPickerLabel, setColumnModel, renderModelSelect, syncModelHint, applyModels, hasAutoOption, modelsFor, columnsFor, modelsCsv, gaCol, servedModelId } = ctx;
  const { gateKindFor, checkAgainButton, providerLoginLink, requestProviderPermission, renderColumnGate, renderPlan, countdown, usageResetAt, syncGateStatus } = ctx;
  const { renderSummaryPrompt, syncSummaryButton, paintSummaryPop, openSummaryPop, closeSummaryPop, startSummary } = ctx;
  const { scrollMetrics, scrollColumnToEnd, syncJumpButton, renderColumnActions, retryColumnOnAuto, columnAskable, setColumnAsk, toggleColumnAsk, sendColumnFollowup, countedQuota, quotaExhausted, cutNote, retryColumn, resetColumn, closePort, noteActivity, beginSend, currentTargets } = ctx;

  // ── skeleton ──
  clear(root);
  const topbar = el('header', 'cmp-topbar');
  topbar.appendChild(el('h1', 'cmp-title', t('heading')));
  // Beta pill (cmp-beta-contract §3): a small label next to the heading, for as long as the feature is in beta.
  const betaPill = el('span', 'cmp-beta-pill', t('beta_badge'));
  betaPill.id = 'cmp-beta';
  topbar.appendChild(betaPill);
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
  // Quota widget (plan compare-quota-premium §3 U3, 2026-09-20): count + progress bar + reset time,
  // rebuilt by renderQuotaLine() on every quota change. Faces: normal / low (`is-low`, ≤
  // QUOTA_LOW_REMAINING left) / exhausted (`is-exhausted`, 0 left) / Premium (`is-pro`, a badge, no
  // bar) / uncounted (plain 「무제한」 while the gates are dark) / unknown.
  const quotaLine = el('div', 'cmp-quota');
  quotaLine.id = 'cmp-quota';
  quotaLine.setAttribute('aria-live', 'polite');
  topbarSide.appendChild(quotaLine);
  // Copy all (batch 2): one markdown document of the whole comparison — see compareMarkdown().
  // Enabled once at least one column holds an answer.
  // Recent sessions (local history): a button with the count, opening the panel built below.
  const historyBtn = el('button', 'cmp-btn cmp-btn-sm cmp-btn-history');
  historyBtn.id = 'cmp-history';
  historyBtn.type = 'button';
  historyBtn.hidden = true; // shown once storage answered at all (empty list included — the user must be able to find the panel; 2026-09-18 live feedback)
  historyBtn.setAttribute('aria-haspopup', 'dialog');
  historyBtn.setAttribute('aria-expanded', 'false');
  topbarSide.appendChild(historyBtn);
  // 「요약·비교」 (C5): hidden unless the SW's status says `summaryOn` (flags.json `compare_summary`,
  // absent = dark); enabled by summaryAllowed() — the popover below asks before the compare is spent.
  const summaryBtn = el('button', 'cmp-btn cmp-btn-sm cmp-btn-summary', t('summary_btn'));
  summaryBtn.id = 'cmp-summary';
  summaryBtn.type = 'button';
  summaryBtn.hidden = true;
  summaryBtn.disabled = true;
  summaryBtn.title = t('summary_btn_title');
  summaryBtn.setAttribute('aria-haspopup', 'dialog');
  summaryBtn.setAttribute('aria-expanded', 'false');
  topbarSide.appendChild(summaryBtn);
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
  Object.assign(ctx, { topbar, betaPill, modeChip, modeGlyph, modeText, topbarSide, quotaLine, historyBtn, summaryBtn, copyAllBtn, stopBtn, newChatBtn });

  // ── copy to clipboard: ui/compare/export.js (installExport, installed above) ──
  attachCopy(copyAllBtn, () => compareMarkdown(), (copied) => { copyAllBtn.textContent = t(copied ? 'copied' : 'copy_all'); }, COPY_KIND_ALL, null);

  const noticeBox = el('div', 'cmp-notices');
  noticeBox.id = 'cmp-notices';
  noticeBox.setAttribute('aria-live', 'polite');
  root.appendChild(noticeBox);
  // Beta reset offer (cmp-beta-contract §3): its own slot under the notices, so it is never
  // subject to the notice ownership rules — shown by renderResetOffer() exactly while the status
  // says betaReset AND the counted quota is at 0 (renderQuota repaints it on every quota change).
  const resetOffer = el('div', 'cmp-reset-offer');
  resetOffer.id = 'cmp-reset-offer';
  resetOffer.hidden = true;
  const resetBtn = el('button', 'cmp-btn cmp-btn-primary cmp-reset-btn');
  resetBtn.id = 'cmp-quota-reset';
  resetBtn.type = 'button';
  resetBtn.addEventListener('click', () => { requestReset(); });
  resetOffer.appendChild(resetBtn);
  const resetErr = el('p', 'cmp-reset-err');
  resetErr.setAttribute('role', 'alert');
  resetErr.hidden = true;
  resetOffer.appendChild(resetErr);
  // The Pro CTA joins the offer once a reset has failed (Codex page 1R #3) — the same link the
  // 429 notice carries outside the beta, built by proCta() below.
  const resetProCta = link(PRO_URL, t('premium_cta'), 'cmp-btn cmp-btn-link cmp-pro-cta cmp-reset-pro');
  resetProCta.hidden = true;
  resetOffer.appendChild(resetProCta);
  root.appendChild(resetOffer);
  Object.assign(ctx, { noticeBox, resetOffer, resetBtn, resetErr, resetProCta });

  // Question composer (chat layout): the dock's FIRST face. Until the first send is accepted
  // (CONSUME_OK) the dock IS this section — `?q` only pre-fills it, the user may rewrite it — and
  // the send button reads the textarea. From CONSUME_OK the section leaves the dock (the
  // follow-up composer takes its place) and the question is drawn as a bubble in every column
  // that got it; a CONSUME_FAIL hands the composer back with the text untouched.
  const qCard = el('section', 'cmp-card cmp-composer cmp-prompt');
  qCard.id = 'cmp-prompt';
  qCard.setAttribute('aria-label', t('question_label'));
  // Copies the question as sent (state.question): lives in the SOURCE column's bubble once the
  // session committed (renderQuestionBubbles) — never offered for a draft the composer still
  // holds. Between sessions it is parked here, hidden (one element, one id, always in the DOM).
  const qCopyBtn = copyButton(() => state.question, { kind: COPY_KIND_QUESTION });
  qCopyBtn.id = 'cmp-question-copy';
  qCopyBtn.hidden = true;
  qCard.appendChild(qCopyBtn);
  const qInput = el('textarea', 'cmp-textarea cmp-prompt-input');
  qInput.id = 'cmp-question';
  qInput.placeholder = t('question_placeholder');
  qInput.setAttribute('aria-label', t('question_placeholder'));
  qInput.setAttribute('rows', '1');
  qInput.value = q;
  // Same flex row as the follow-up composer, so both textareas share one sizing rule; the send
  // button sits at the row's end like the follow-up's.
  const qRow = el('div', 'cmp-composer-row');
  qRow.appendChild(qInput);
  qCard.appendChild(qRow);
  const controls = el('div', 'cmp-composer-meta cmp-prompt-actions');
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
  qRow.appendChild(sendBtn);
  qCard.appendChild(controls);
  // Empty state (chathub batch 1, C1): a page opened without `?q` — the web shell's plain entry —
  // showed one placeholder line and nothing else. Directly above the composer, inside the dock
  // (2026-09-21 user decision — it used to sit centred above the columns), centred: one line saying
  // what the page does (with the free limit once the status knows it — never a hardcoded number)
  // and EXAMPLE_CHIP_COUNT example prompts that fill the composer. Gone from the first accepted
  // send (commitPrompt; a loaded session commits the same way) and back with an empty composer
  // after 「새 대화」 (releasePrompt — Codex 8R #2). Appended to the dock below (its first child).
  const examples = el('div', 'cmp-examples');
  examples.id = 'cmp-examples';
  examples.hidden = q.length > 0;
  const examplesIntro = el('p', 'cmp-examples-intro', t('examples_intro'));
  examples.appendChild(examplesIntro);
  const exampleChips = el('div', 'cmp-examples-chips');
  examples.appendChild(exampleChips);
  Object.assign(ctx, { qCard, qCopyBtn, qInput, qRow, controls, excludeLabel, excludeInput, incognitoLabel, incognitoInput, incognitoGlyph, qHint, sendBtn, examples, examplesIntro, exampleChips });
  /**
   * The language's server pool as usable items, or null when there is none / too few: each item
   * a plain object with a non-empty string `q` (cut to EXAMPLE_Q_MAX) and a string `tag` ('' when
   * absent). Never text from anywhere but `q` — rendered through textContent only.
   */
  function examplePool() {
    const ex = state.status && state.status.examples;
    const list = ex && typeof ex === 'object' && Array.isArray(ex[lang]) ? ex[lang] : null;
    if (!list) return null;
    const items = [];
    for (const it of list) {
      if (!it || typeof it !== 'object' || typeof it.q !== 'string') continue;
      const q = it.q.trim().slice(0, EXAMPLE_Q_MAX);
      if (!q) continue;
      items.push({ q, tag: typeof it.tag === 'string' ? it.tag : '' });
    }
    return items.length >= EXAMPLE_CHIP_COUNT ? items : null;
  }
  /**
   * EXAMPLE_CHIP_COUNT items from the pool: a Fisher–Yates shuffle (the injected `random`), then
   * a greedy pass that takes the first item of each still-unseen tag, filled from the rest in
   * shuffled order — as many distinct tags as the pool allows, a different trio each time.
   */
  function pickExamples(pool) {
    const arr = pool.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    const picked = [];
    const seen = new Set();
    for (const it of arr) { if (picked.length >= EXAMPLE_CHIP_COUNT) break; if (!seen.has(it.tag)) { seen.add(it.tag); picked.push(it); } }
    for (const it of arr) { if (picked.length >= EXAMPLE_CHIP_COUNT) break; if (!picked.includes(it)) picked.push(it); }
    return picked;
  }
  /** (Re)draws the chips: the server pick when the status carries a usable pool for this language, else the built-in three. */
  function renderExampleChips() {
    clear(exampleChips);
    const pool = examplePool();
    const items = pool ? pickExamples(pool) : Array.from({ length: EXAMPLE_CHIP_COUNT }, (_, i) => ({ q: t(`example_chip_${i + 1}`), tag: '' }));
    for (const it of items) {
      const chip = el('button', 'cmp-chip cmp-example-chip');
      chip.type = 'button';
      chip.title = it.q; // the whole question (the label may clamp to two lines)
      if (it.tag) chip.setAttribute('data-tag', it.tag);
      chip.appendChild(el('span', 'cmp-example-chip-text', it.q));
      chip.addEventListener('click', () => {
        qInput.value = it.q;
        autoGrow(qInput);
        updateControls();
        focusQuietly(qInput);
      });
      exampleChips.appendChild(chip);
    }
  }
  renderExampleChips(); // built-in until the status answers (readStatus re-draws from the pool)
  /**
   * The intro line names the free daily limit when the status carries one; Pro / uncounted → no
   * number. During the beta (status.betaReset — the count can be cleared at will) it must not
   * promise 「무료 하루 N회」: the beta line instead.
   */
  function renderExamplesIntro() {
    if (betaReset()) { examplesIntro.textContent = t('examples_intro_beta'); return; }
    const quota = state.status && state.status.quota;
    const limit = quota && !quota.pro && quota.limit != null ? Number(quota.limit) : null;
    examplesIntro.textContent = limit != null && Number.isFinite(limit) ? t('examples_intro_limit', limit) : t('examples_intro');
  }
  /** The question as it would be sent right now ('' = send disabled). */
  const currentQuestion = () => String(qInput.value || '').trim();
  ctx.currentQuestion = currentQuestion;
  /**
   * First CONSUME_OK (and a history load): the session is committed — the question composer
   * leaves the dock (the follow-up composer shows through updateControls), the empty state goes,
   * and the question is what the columns show (renderQuestionBubbles, once the columns hold their
   * turns). `is-committed` on the dock is the CSS hook for the follow-up face. The layout switch
   * (hero → chat, see the header): the dock leaves the top for its place between the columns and
   * the footer, and the root drops `is-hero` (the columns grow back to the shell).
   */
  function commitPrompt(text) {
    state.question = text;
    qInput.hidden = true;
    qHint.hidden = true;
    dock.classList.add('is-committed');
    examples.hidden = true;
    root.classList.remove(HERO_CLASS);
    root.insertBefore(dock, footer); // after the columns; the footer stays last
  }
  /** New chat: an empty question composer again (the inverse of commitPrompt); the bubbles went with the columns (resetColumn). */
  function releasePrompt() {
    qInput.value = '';
    qInput.hidden = false;
    qHint.hidden = false;
    qCopyBtn.hidden = true;
    qCard.appendChild(qCopyBtn); // back to its parking place (the bubble that held it went with the column)
    dock.classList.remove('is-committed');
    root.classList.add(HERO_CLASS);
    root.insertBefore(dock, columnsBox); // hero again: the composer above the collapsed columns
    autoGrow(qInput);
    examples.hidden = false; // an empty composer again: the intro + chips come back (8R #2)
    renderExampleChips(); // …re-picked: a new trio for the new conversation
  }
  /**
   * The question as a right-aligned bubble at the top of every column that received it — the
   * columns whose thread STARTS with an answer (the first-round request is the question, never a
   * user turn: the same rule roundQuestion / retryPair apply). 🔴 Display only: no turn is pushed,
   * nothing is stored — the history entry keeps `question` + the columns' turns exactly as before,
   * and a reload draws the bubble from `entry.question` through the same function. The 「질문 복사」
   * button rides in the SOURCE column's bubble (one button, one id) — no source, no button.
   */
  function renderQuestionBubbles() {
    for (const col of state.columns.values()) {
      if (col.qBubble) { col.qBubble.remove(); col.qBubble = null; }
      if (!col.participated || !col.turns.length || col.turns[0].role !== 'assistant') continue;
      // Its own classes (not cmp-turn / cmp-turn-user): everything that counts turns in the DOM
      // — the guards, the markdown export's readers — must keep seeing exactly the stored turns.
      const block = el('div', 'cmp-q-block');
      block.appendChild(el('div', 'cmp-turn-q', state.question));
      if (col.provider === src) { qCopyBtn.hidden = false; block.appendChild(qCopyBtn); }
      col.qBubble = block;
      col.body.insertBefore(block, col.body.firstChild);
    }
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
   * `idSuffix` keeps the ids stable (the flow guard drives them by id).
   * `compact`: the textarea row only — the routing boxes stay in the DOM (the same group logic)
   * but their row is hidden. The caption next to the send button lists the shared targets either
   * way (updateControls; the C4 preset highlights it).
   * Since the chat layout there is ONE instance (the dock); the factory and the mirror logic are
   * kept as they were — `composers` simply has one member.
   */
  const composers = [];
  ctx.composers = composers;
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
    const caption = el('span', 'cmp-composer-target');
    caption.id = `cmp-followup-caption${idSuffix}`;
    caption.title = t('followup_target_label');
    row.appendChild(caption);
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
  const columnsBox = el('div', 'cmp-columns');
  columnsBox.id = 'cmp-columns';
  root.appendChild(columnsBox);
  // 「＋ 열 추가」 (cmp-columns §1): the last cell of the grid before the session; gone at MAX_COLUMNS.
  const addColBtn = el('button', 'cmp-card cmp-add-col', t('col_add'));
  addColBtn.id = 'cmp-add-col';
  addColBtn.type = 'button';
  addColBtn.hidden = true;
  addColBtn.addEventListener('click', addColumnByUser);
  columnsBox.appendChild(addColBtn);
  // The column picker popover (one for the page, positioned under the column whose button opened
  // it): an ARIA listbox holding either the SERVICE list (the ▾ after the name: Claude / Gemini /
  // ChatGPT, pre-session) or the MODEL list (the [Auto ▾] face: Auto + the column's own provider's
  // catalog) — `state.pickerKind` says which; an option the page already shows is disabled.
  // Enter / Space / click choose, Esc closes, arrows move.
  const picker = el('div', 'cmp-col-picker-pop');
  const PICKING_CLASS = 'cmp-col-picking'; // on the column while its picker is open (the card's overflow is released)
  picker.id = 'cmp-col-picker';
  picker.hidden = true;
  picker.setAttribute('role', 'listbox');
  picker.setAttribute('aria-label', t('col_picker_title'));
  picker.tabIndex = -1;
  columnsBox.appendChild(picker); // parked in the grid (hidden); moved under the opening column while open
  Object.assign(ctx, { columnsBox, addColBtn, picker, PICKING_CLASS });
  // A click anywhere outside the open list (and its column's button) closes it — as the history panel.
  if (typeof doc.addEventListener === 'function') {
    doc.addEventListener('click', (e) => {
      if (!ctx.pickerCol || !e || !e.target) return;
      const btn = ctx.pickerOpener; // the button that opened the list (service ▾ or the model face)
      const inside = (node) => { for (let n = node; n; n = n.parentNode) if (n === picker || n === btn) return true; return false; };
      if (!inside(e.target)) closePicker();
    });
  }
  picker.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); const opener = ctx.pickerOpener; closePicker(); if (opener) focusQuietly(opener); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const opts = [...picker.querySelectorAll('.cmp-col-picker-opt')].filter((o) => !o.disabled);
    if (!opts.length) return;
    const at = opts.indexOf(doc.activeElement);
    const next = e.key === 'ArrowDown' ? opts[(at + 1) % opts.length] : opts[(at - 1 + opts.length) % opts.length];
    focusQuietly(next);
  });

  // The dock (compare.css .cmp-dock): from the first accepted send, docked to the viewport bottom
  // so nothing can push the composer below the fold; BEFORE it (hero layout, see the header) it
  // sits above the columns — built there (`root.insertBefore(dock, columnsBox)` + `is-hero` on
  // the root) and moved by commitPrompt / releasePrompt, the only two layout switches. Two faces,
  // one shown at a time (updateControls): the question composer (qCard, before the session) and
  // the follow-up composer (its routing boxes visible — the meta row — plus the caption).
  const followup = makeFollowupComposer(FOLLOWUP_ID_BOTTOM, 'cmp-card cmp-composer cmp-composer-compact');
  const dock = el('div', 'cmp-dock');
  dock.id = 'cmp-dock';
  dock.appendChild(examples); // the empty-state intro + chips ride the dock, right above the composer
  dock.appendChild(qCard);
  dock.appendChild(followup.section);
  root.insertBefore(dock, columnsBox);
  root.classList.add(HERO_CLASS);
  Object.assign(ctx, { followup, dock });

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
  Object.assign(ctx, { footer, footLine, footResidue });
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
  ctx.clearNotice = clearNotice;
  /** A status read may touch the notice slot only when it is empty or holds one of its own. */
  const statusOwnsNotice = () => !state.notice || state.notice.owner === NOTICE_OWNER_STATUS;
  ctx.statusOwnsNotice = statusOwnsNotice;
  const loginCta = () => link(LOGIN_URL, t('login_cta'), 'cmp-btn cmp-btn-primary cmp-btn-link cmp-login-cta');
  ctx.loginCta = loginCta;
  const proCta = () => link(PRO_URL, t('premium_cta'), 'cmp-btn cmp-btn-primary cmp-btn-link cmp-pro-cta');
  ctx.proCta = proCta;
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

  // ── quota widget ──
  function renderQuota(quota, quotaError) {
    renderQuotaLine(quota, quotaError);
    renderResetOffer();
    syncQuotaNotice();
  }
  /**
   * The topbar widget, rebuilt from the quota object (plan §3 U3). `quota.pro` wins over any
   * numbers it carries (a Premium answer is uncounted even when the server echoed stale digits —
   * the wire says remaining:null there, but the page must not depend on it); limit:null without
   * pro = the server is not counting (billing gate off): plain 「무제한」, not Premium (Codex #23).
   * A counted quota draws the count (remaining/limit), the bar (width = used/limit — fills as
   * compares are spent, like the usage gauges) and the local reset time; ≤ QUOTA_LOW_REMAINING
   * left adds the amber state and the inline Premium link, 0 the red state (the composer is
   * gated through quotaExhausted(), the notice through syncQuotaNotice()).
   */
  function renderQuotaLine(quota, quotaError) {
    clear(quotaLine);
    quotaLine.classList.remove('is-exhausted', 'is-low', 'is-pro');
    if (quota && quota.pro) {
      quotaLine.classList.add('is-pro');
      quotaLine.appendChild(el('span', 'cmp-quota-badge', t('premium_badge')));
      return;
    }
    if (quota && quota.limit == null && quota.remaining == null && quota.resetsAt) { quotaLine.textContent = t('quota_no_limit'); return; }
    // Both numbers finite (the same test quotaExhausted() applies): a malformed pair must not draw a
    // red 0/N that the composer gate would not agree with — it is the unknown line instead.
    const counted = countedQuota(quota);
    if (counted) {
      const { limit, remaining } = counted;
      const used = limit - remaining;
      const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
      const reset = localHHMM(quota.resetsAt);
      quotaLine.appendChild(el('span', 'cmp-quota-count', t('quota_count', remaining, limit)));
      const bar = el('span', 'cmp-quota-bar');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', t('quota_bar_label'));
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(limit));
      bar.setAttribute('aria-valuenow', String(used));
      const fill = el('span', 'cmp-quota-fill');
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      quotaLine.appendChild(bar);
      if (reset) quotaLine.appendChild(el('span', 'cmp-quota-reset', t('quota_reset_at', reset)));
      if (remaining <= 0) {
        quotaLine.classList.add('is-exhausted');
      } else if (remaining <= QUOTA_LOW_REMAINING) {
        quotaLine.classList.add('is-low');
        quotaLine.appendChild(link(PRO_URL, t('quota_low_hint'), 'cmp-quota-hint'));
      }
      return;
    }
    quotaLine.textContent = quotaError ? '' : t('quota_unknown');
  }
  /**
   * The exhausted notice (「하루 N회를 다 썼어요 · 리셋 hh:mm」 + the Premium CTA) follows the quota, not
   * the event that revealed it: a status read that says 0 shows it exactly like a 429 does, and a
   * read that says compares are left takes it away (the 429 path's own showNotice still replaces
   * whatever is in the slot — this only fills an empty / status-owned slot and never clobbers a
   * login or consume-error notice). During the beta the reset offer is the action instead: a
   * status read at 0 adds no notice (the 429 path's CTA-less one, when there is one, stays).
   */
  function syncQuotaNotice() {
    const mine = !!state.notice && state.notice.owner === NOTICE_OWNER_QUOTA;
    if (!(state.status && state.status.quota)) return; // a failed read proves nothing about the count: leave the slot as it is
    if (!quotaExhausted()) { if (mine) clearNotice(); return; }
    if (mine || betaReset() || !statusOwnsNotice()) return;
    showNotice('warn', [quotaExhaustedTitle()], proCta(), NOTICE_OWNER_QUOTA);
  }
  /** 「하루 {limit}회를 다 썼어요 · 리셋 {hh:mm}」 from the current quota (the 429 path passes its own resetsAt first). */
  function quotaExhaustedTitle(resetsAt = null) {
    const q = state.status && state.status.quota;
    const limit = q && Number.isFinite(Number(q.limit)) ? Number(q.limit) : '';
    return t('quota_exhausted', limit, localHHMM(resetsAt || (q && q.resetsAt)));
  }

  // ── beta reset (cmp-beta-contract §3) ──
  /** The server said the beta reset is on (GET /api/compare/status `betaReset`); absent = off. */
  function betaReset() { return !!(state.status && state.status.betaReset === true); }
  let resetInflight = false; // one COMPARE_RESET at a time (the button is disabled meanwhile)
  let resetFailed = false;   // a reset failed at least once this page: the offer also carries the Pro CTA (Codex page 1R #3)
  /**
   * The offer shows exactly while betaReset AND a counted quota is at 0; the label names the
   * limit. After a failed reset the Pro CTA sits beside it, so there is always another way out.
   */
  function renderResetOffer() {
    const on = betaReset() && quotaExhausted();
    resetOffer.hidden = !on;
    if (!on) { resetErr.hidden = true; return; }
    const limit = Number(state.status.quota.limit);
    resetBtn.textContent = t('quota_reset_cta', Number.isFinite(limit) ? limit : '');
    resetBtn.disabled = resetInflight;
    resetProCta.hidden = !resetFailed;
  }
  /**
   * Click → COMPARE_RESET → the SW clears today's count on the server. 🔴 The reply's own quota
   * is NEVER applied (Codex page 1R #1: a reply held while a send consumed to 19 would paint 20
   * and wipe a newer 429 notice) — whatever the reply says, the page bumps the epoch (any
   * status answer from before the reset would say 0) and re-reads /status through refreshStatus,
   * the only truth; the 429 notice is cleared only when that fresh read shows compares left. A
   * reply of `{ok:false, reset:true}` (counter cleared, the SW's own re-read failed) takes the
   * same path. Any other failure: the error line + the Pro CTA join the offer, and the status is
   * re-read all the same (the server may have reset before the reply was lost). The button is
   * usable while a round streams — the reset is server-side and independent of the port.
   */
  async function requestReset() {
    if (resetInflight || state.disabled || !betaReset() || !quotaExhausted()) return;
    noteActivity();
    // Bump ONE (at the request, before anything is awaited — Codex 2R): a round already awaiting
    // its consume must read as stale from this instant, or its 429, landing while the fresh status
    // read below is still in flight, would paint 0 and advance the epoch under that read (the
    // fresh 20 then discarded as stale — display 0, server 20).
    state.quotaGen++;
    resetInflight = true;
    resetErr.hidden = true;
    renderResetOffer();
    const res = await sendMessage(chrome, { type: RESET_MSG_TYPE });
    resetInflight = false;
    if (state.disabled || !state.status) return;
    const done = !!res && (res.ok === true || res.reset === true);
    if (done) {
      resetFailed = false;
      track('quota_reset', res.ok === true ? {} : { code: typeof res.code === 'string' ? res.code : RESET_CODE_STATUS_UNAVAILABLE });
    } else {
      resetFailed = true;
      resetErr.textContent = t('quota_reset_failed');
      resetErr.hidden = false;
    }
    renderResetOffer();
    statusEpoch++; // whatever was read before this reply is older than the server's count now
    await refreshStatus();
    // Bump TWO, once the fresh count landed (§5 + Codex layout 1R #2): a round that went out WHILE
    // the reset was pending carries the gen of bump one and would apply its snapshot after this
    // point — stale too, from here. Both bumps are needed (2R): one covers rounds started before
    // the click, the other rounds started during the pending window; a stale-gen 429/CONSUME_OK
    // never touches statusEpoch, so a fresh read still in flight lands.
    state.quotaGen++;
    // The fresh read painted the count (renderQuota → the offer, renderExamplesIntro, the
    // controls). The 429 notice described a count that is gone only if the read SAYS so —
    // compares left; a failed read proves nothing and leaves it.
    const q = state.status && state.status.quota;
    if (done && state.notice && state.notice.owner === NOTICE_OWNER_QUOTA && q && Number(q.remaining) > 0) clearNotice();
  }

  // ── columns ──
  function columnFor(colIdRaw) {
    const colId = normalizeColId(colIdRaw);
    if (!colId) return null;
    let col = state.columns.get(colId);
    if (col && col.id === colId) return col;
    const { provider, model } = parseColId(colId);
    if (state.columnIds.length >= MAX_COLUMNS) return null;
    const meta = PROVIDER_META[provider];
    const node = el('section', 'cmp-card cmp-col');
    node.setAttribute('data-provider', provider);
    node.setAttribute('data-col', colId);
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
    // Service picker (2026-09-21 user decision — split by place: the service is changed at the
    // service's name, the model at the model's face): a small 「▾」 right after the name opens the
    // list of the three services; choosing another REPLACES this column in place by `p:auto` — or,
    // when that is taken, by `p:<first free model>` (only the pair is unique; the service itself
    // is always selectable, chooseColumn). Pre-session only — hidden once the session started,
    // like ✕ (a thread belongs to its conversation).
    const serviceBtn = el('button', 'cmp-btn cmp-btn-sm cmp-col-service');
    serviceBtn.type = 'button';
    serviceBtn.hidden = true;
    serviceBtn.setAttribute('aria-haspopup', 'listbox');
    serviceBtn.setAttribute('aria-expanded', 'false');
    serviceBtn.title = t('col_service_title');
    serviceBtn.setAttribute('aria-label', t('col_service_title'));
    serviceBtn.appendChild(el('span', 'cmp-col-picker-caret', '▾'));
    serviceBtn.addEventListener('click', () => toggleServicePicker(col.id));
    identity.appendChild(serviceBtn);
    // Model picker (cmp-columns §1): the head's model face 「Auto ▾」 opens THIS provider's list
    // (Auto first, then the catalog models) — before the session a pick re-keys the column
    // (provider:model), in session the id stays and only the model the next send carries moves
    // (the hidden model select behind it keeps the state). Never another vendor: that is the
    // service picker's job (above).
    const pickerBtn = el('button', 'cmp-btn cmp-btn-sm cmp-col-picker');
    pickerBtn.type = 'button';
    pickerBtn.hidden = true;
    pickerBtn.setAttribute('aria-haspopup', 'listbox');
    pickerBtn.setAttribute('aria-expanded', 'false');
    pickerBtn.title = t('col_picker_title');
    pickerBtn.setAttribute('aria-label', t('col_picker_title'));
    pickerBtn.appendChild(el('span', 'cmp-col-picker-caret', '▾'));
    pickerBtn.addEventListener('click', () => togglePicker(col.id));
    identity.appendChild(pickerBtn);
    // Model pill (addendum): filled from status.models[provider]; hidden when the catalog is absent.
    const modelWrap = el('span', 'cmp-model');
    modelWrap.hidden = true;
    const modelSelect = el('select', 'cmp-model-select');
    // The first column of a provider keeps the historical id; later ones get a per-page monotonic
    // suffix (a count would repeat after a remove + add — duplicate DOM ids, Codex integration #4).
    modelSelect.id = firstColumnOf(provider) ? `cmp-model-${provider}-${++state.modelSelectSeq}` : `cmp-model-${provider}`;
    modelSelect.setAttribute('aria-label', t('col_model_label', meta.label));
    modelSelect.addEventListener('change', () => { if (col) applyModelPick(col); });
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
    // ✕ (cmp-columns §1): drops the column — before the session only, never the last one.
    const removeBtn = el('button', 'cmp-btn cmp-btn-sm cmp-col-remove', '✕');
    removeBtn.type = 'button';
    removeBtn.hidden = true;
    removeBtn.title = t('col_remove');
    removeBtn.setAttribute('aria-label', t('col_remove'));
    removeBtn.addEventListener('click', () => { if (!removeBtn.hidden) removeColumnByUser(col.id); });
    tools.appendChild(removeBtn);
    // ⤢ (focus mode, 2026-09-21 user decision A): widens THIS column in place — every other column
    // collapses to a 48px rail (compare.css ── focus ──). Hidden before the session (the hero has
    // nothing to widen) and on narrow screens (CSS); reads ⤡ 「원래 크기로」 while this column is the
    // focused one (syncFocusButton).
    const focusBtn = el('button', 'cmp-btn cmp-btn-sm cmp-col-focus');
    focusBtn.type = 'button';
    focusBtn.hidden = true;
    // No stopPropagation: the column-node listener is a no-op after the toggle (focus is this column
    // or none), and the document-level outside-click closers (history panel, summary popover, picker)
    // must see this click like any other (substitute review 후속 1).
    focusBtn.addEventListener('click', () => { if (!focusBtn.hidden) toggleColumnFocus(col.id); });
    tools.appendChild(focusBtn);
    // Item 5 (contract I): 「대화 복사」 — this column's question + every turn as markdown (the same
    // builder as 「전체 복사」 over one column). Shown once the column holds an answer (syncCopyAll).
    const copyColBtn = copyButton(() => columnMarkdown(col), { kind: COPY_KIND_COLUMN, provider, label: t('copy_column'), aria: t('copy_column_aria', meta.label) });
    copyColBtn.classList.add('cmp-copy-col');
    copyColBtn.hidden = true;
    tools.appendChild(copyColBtn);
    // 「이 열에만 묻기」 in the head (user request, 2026-09-20): the second entry point to the column's
    // own composer — the same mechanism the hover tab opens (toggleColumnAsk), never a dock preset.
    // Shown by the same rule as the tab (columnAskable), inert while a round is in flight.
    const askColBtn = el('button', 'cmp-btn cmp-btn-sm cmp-ask-col', t('ask_column'));
    askColBtn.type = 'button';
    askColBtn.hidden = true;
    askColBtn.title = t('ask_column_tip', meta.label);
    askColBtn.setAttribute('aria-label', t('ask_column_aria', meta.label));
    askColBtn.addEventListener('click', () => { if (!askColBtn.hidden && !askColBtn.disabled) toggleColumnAsk(col.id, true); });
    tools.appendChild(askColBtn);
    head.appendChild(tools);
    // Catalog hint (#1452 refresh): under the pill while the SW is still to ask the site for this
    // provider's list (status.modelsPending) and a send is in flight — the first send opens the tab
    // the list needs, and MODELS then replaces the static picker. Hidden otherwise.
    const modelHint = el('span', 'cmp-model-hint', t('model_list_loading'));
    modelHint.hidden = true;
    head.appendChild(modelHint);
    node.appendChild(head);
    // A rail (focus mode: some OTHER column is focused) takes the focus on click — anywhere on it,
    // the rail shows nothing but the dot, the name and the badge. Inert outside focus mode.
    node.addEventListener('click', () => { if (state.focusedCol && state.focusedCol !== col.id) setColumnFocus(col.id); });
    // Usage mini gauges (2026-09-18, user request): the account's 5h / 7d utilisation for this
    // provider, from status.providers[p].usage — the same numbers the popup's overview cards
    // draw, in a one-line strip under the head. Hidden when nothing was collected; a no-limits
    // plan (Gemini Workspace/Business) says so instead of drawing bars.
    const usageRow = el('div', 'cmp-col-usage');
    usageRow.hidden = true;
    node.appendChild(usageRow);
    // Shared-account chip (cmp-columns §0): a column that is NOT the first of its provider shows
    // 「↖ Claude 열과 같은 계정」 in the gate / plan / gauge slot (those render on the first column
    // only — one account, one login, one quota); the click scrolls that first column into view.
    const shared = el('button', 'cmp-col-shared');
    shared.type = 'button';
    shared.hidden = true;
    shared.addEventListener('click', () => { const first = firstColumnOf(col.provider); if (first && first !== col && typeof first.node.scrollIntoView === 'function') { try { first.node.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* no layout engine */ } } });
    node.appendChild(shared);
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
    // C3: the code-specific actions (see CODE_AUTH_REQUIRED above). Built once, shown by
    // renderColumnActions per error code; every one hidden while the column is not in that error.
    // Sign-in: the same site link the column gate offers.
    const loginLink = providerLoginLink(provider, 'cmp-btn cmp-btn-sm cmp-btn-link cmp-action-login');
    loginLink.hidden = true;
    actions.appendChild(loginLink);
    // Permission: the gate's handler — ONE chrome.permissions.request in this feature (AC16).
    const permBtn = el('button', 'cmp-btn cmp-btn-sm cmp-btn-primary cmp-action-perm', t('action_allow_access'));
    permBtn.type = 'button';
    permBtn.setAttribute('data-origin', meta.origin);
    permBtn.hidden = true;
    actions.appendChild(permBtn);
    // 「다시 확인」: a status re-read (for a gate code, that is what clears the retry).
    const checkBtn = checkAgainButton();
    checkBtn.classList.add('cmp-action-check');
    checkBtn.hidden = true;
    actions.appendChild(checkBtn);
    // Auto retry: the pill back to the provider's default, then the same FOLLOWUP as the retry.
    const autoBtn = el('button', 'cmp-btn cmp-btn-sm cmp-action-auto', t('action_retry_auto'));
    autoBtn.type = 'button';
    autoBtn.hidden = true;
    actions.appendChild(autoBtn);
    // #1463 ②: the readiness reason, ABOVE the buttons that fix it. It lives on the action row and
    // not on a turn, because the turn is exactly what the CONSUME_FAIL rollback pops — see
    // `col.readiness`.
    // 🪤 NOT `cmp-col-error`: that class belongs to the line inside a TURN, and three existing
    // checks locate that line with `querySelector('.cmp-col-error')`. Sharing it made this
    // node — hidden, in the action row — answer those queries instead.
    const readinessLine = el('p', 'cmp-col-readiness');
    readinessLine.hidden = true;
    actions.appendChild(readinessLine);
    // Where the "prompt moved to an extension tab" hint goes for the action-row permission button.
    const actionHint = el('p', 'cmp-col-state-hint cmp-action-hint');
    actionHint.setAttribute('aria-live', 'polite');
    actions.appendChild(actionHint);
    retryBtn.addEventListener('click', () => retryColumn(col.id));
    permBtn.addEventListener('click', () => requestProviderPermission(provider, permBtn, actionHint));
    autoBtn.addEventListener('click', () => retryColumnOnAuto(col.id));
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
    // `gateCleared` (C3): a status read AFTER a gate-code error found the provider sendable again —
    // the retry comes back. `autoRetried`: 「Auto로 바꿔 다시 보내기」 was used for the current model
    // choice (a second model_unavailable does not offer it again; a new choice resets it).
    // Per-column input (chat layout; replaces C4's head button): a chevron tab centred on the
    // column's bottom edge (CSS shows it on hover / while open / on touch + narrow screens) opens a
    // one-line composer under the body — a follow-up to THIS column only, without touching the
    // dock's routing set. Shown while the column can take a follow-up (columnAskable).
    const ask = el('div', 'cmp-col-ask');
    ask.hidden = true;
    const askTab = el('button', 'cmp-col-ask-tab');
    askTab.type = 'button';
    askTab.title = t('ask_column_tip', meta.label);
    askTab.setAttribute('aria-label', t('ask_column_aria', meta.label));
    askTab.setAttribute('aria-expanded', 'false');
    const chevron = doc.createElementNS(SVG_NS, 'svg');
    chevron.setAttribute('viewBox', '0 0 12 12');
    chevron.setAttribute('aria-hidden', 'true');
    const chevronPath = doc.createElementNS(SVG_NS, 'path');
    chevronPath.setAttribute('d', 'M2 8l4-4 4 4');
    chevron.appendChild(chevronPath);
    askTab.appendChild(chevron);
    askTab.addEventListener('click', () => toggleColumnAsk(col.id));
    ask.appendChild(askTab);
    const askBox = el('div', 'cmp-col-ask-box');
    askBox.hidden = true;
    const askInput = el('textarea', 'cmp-textarea cmp-col-ask-input');
    askInput.setAttribute('rows', '1');
    askInput.placeholder = t('ask_column_placeholder');
    askInput.setAttribute('aria-label', t('ask_column_aria', meta.label));
    askInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); toggleColumnAsk(col.id, false); } });
    askInput.addEventListener('keydown', noteActivity);
    bindComposer(askInput, () => sendColumnFollowup(col.id), null, win); // Enter sends, Shift+Enter breaks the line, IME-safe
    askBox.appendChild(askInput);
    ask.appendChild(askBox);
    node.appendChild(ask);
    col = { id: colId, provider, model, modelKnown: false, modelTouched: false, node, badge, body, serviceBtn, pickerBtn, removeBtn, focusBtn, shared, modelWrap, modelSelect, plan, modelHint, copyColBtn, askColBtn, ask, askTab, askInput, askBox, askOpen: false, actions, retryBtn, openTab, loginLink, permBtn, checkBtn, autoBtn, actionHint, readinessLine, readiness: null, turns: [], renderScheduled: false, status: 'idle', errorCode: null, errorTitle: '', participated: false, round: null, badgeKey: null, badgeCls: '', servedModel: null, waitingSince: null, stages: {}, gate: null, continuation: null, usageRow, jumpBtn, followAnchored: false, followTail: false, userScrolledUp: false, gateCleared: false, gateErrorSeq: 0, autoRetried: false };
    state.columns.set(colId, col);
    state.columnIds.push(colId);
    columnsBox.insertBefore(node, addColBtn); // the ＋ card stays last
    renderPickerLabel(col);
    return col;
  }

  /**
   * Badge = status text, or the served model once the SW reported it (MODEL / DONE.model) while the
   * column is waiting / answering / done — the model label replaces 「응답 대기 중…」 (addendum). Error
   * and stopped states keep their own words; the model, if known, stays in the tooltip.
   */
  const MODEL_BADGE_KEYS = new Set(['col_waiting', 'col_streaming', 'col_done']);
  ctx.MODEL_BADGE_KEYS = MODEL_BADGE_KEYS;
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
    // A stalled answer (#1519): the same badge, plus a muted marker — read from the turn itself,
    // so a rollback / reload / next round paints it right without a separate column flag.
    const lastAnswer = lastAssistantTurn(col);
    const stalled = col.status === 'done' && col.badgeKey === 'col_done' && lastAnswer?.stalled === true;
    col.badge.textContent = text;
    if (stalled) col.badge.appendChild(el('span', 'cmp-badge-stalled', ` · ${t('col_stalled_mark')}`)); // its own span: muted by CSS, the rest of the badge unchanged
    col.badge.className = 'cmp-col-badge' + (col.badgeCls ? ` ${col.badgeCls}` : '') + (stalled ? ` ${BADGE_STALLED_CLS}` : '');
    const titleParts = [];
    if (ttft && ttft.total != null) titleParts.push(t('ttft_title', ttft.first, ttft.total));
    if (stalled) titleParts.push(cutNote(lastAnswer));
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
  /** The column's last assistant turn (the one the badge describes), or null. */
  function lastAssistantTurn(col) {
    for (let i = col.turns.length - 1; i >= 0; i--) if (col.turns[i].role === 'assistant') return col.turns[i];
    return null;
  }
  function setServedModel(col, model) {
    if (!model || typeof model !== 'object') return;
    const id = model.id == null ? null : String(model.id);
    const label = model.label == null ? '' : String(model.label);
    if (!id && !label) return;
    col.servedModel = { id, label, source: model.source === MODEL_SOURCE_REQUESTED ? MODEL_SOURCE_REQUESTED : 'reported' };
    // The answer being produced keeps ITS model (C5 provenance): a later round on another model
    // must not relabel it when it is attached to a comparison (Codex 3R #1).
    const live = col.turns[col.turns.length - 1];
    if (live && live.role === 'assistant') live.model = { id, label };
    paintBadge(col);
  }

  // ── waiting-time ticker ──
  // ONE interval for the page, never one per column: each second it repaints the badge of every
  // column still waiting for its first chunk (CONSUME_OK seen, no CHUNK yet). Started when a column
  // enters that state, cleared as soon as none is in it — every exit goes through setBadge, and
  // finishSend() (ALL_DONE / CONSUME_FAIL / port gone) clears it once more so a round that ends
  // cannot leave a timer running. Only the badge text changes, so reduced-motion is unaffected.
  // The same interval keeps the 5h reset countdown on an error line current (C3, Codex batch-1
  // #4): the line is re-derived from the stored reset INSTANT (turn.resetAt) on every tick and
  // only rewritten when the text changed; once the instant is past the countdown is dropped.
  let waitTimer = null;
  function waitingColumns() {
    return [...state.columns.values()].filter((c) => c.badgeKey === BADGE_WAITING && c.status === 'streaming');
  }
  /** Columns whose last turn shows a live reset countdown (error state, a future reset instant, still on the page). */
  function countdownColumns() {
    return [...state.columns.values()].filter((c) => c.status === 'error' && c.node.isConnected !== false && resetTurn(c) !== null);
  }
  const resetTurn = (col) => { const turn = col.turns[col.turns.length - 1]; return turn && turn.role === 'assistant' && turn.resetAt && turn.errorLine ? turn : null; };
  ctx.resetTurn = resetTurn;
  function syncWaitTimer() {
    const any = waitingColumns().length > 0 || countdownColumns().length > 0;
    if (any && waitTimer == null) waitTimer = clock.setInterval(tickWaiting, WAIT_TICK_MS);
    else if (!any && waitTimer != null) { clock.clearInterval(waitTimer); waitTimer = null; }
  }
  function tickWaiting() {
    const cols = waitingColumns();
    for (const col of cols) paintBadge(col);
    const counting = countdownColumns();
    for (const col of counting) {
      const turn = resetTurn(col);
      if (!countdown(turn.resetAt)) turn.resetAt = null; // past: the countdown leaves the line for good
      const text = errorLineText(turn);
      if (turn.errorLine.textContent !== text) turn.errorLine.textContent = text;
    }
    if (!cols.length && !counting.length) syncWaitTimer();
  }
  /** The error line as shown: the stored copy plus, while a reset instant lies ahead, 「· 5시간 사용량이 가득 찼어요 — 2h 29m 뒤 리셋」. */
  function errorLineText(turn) {
    const left = turn.resetAt ? countdown(turn.resetAt) : '';
    return left ? `${turn.errorText} · ${t('err_usage_resets_in', left)}` : turn.errorText;
  }
  /**
   * A turn that has stopped being the column's last one FOR GOOD — the round that pushed the turns
   * after it was accepted (CONSUME_OK) — retires the countdown it carried: the line goes back to
   * the plain error copy. Only the last turn is ticked (countdownColumns), so a historical line
   * must not keep a frozen "2h 0m" (Codex batch-1 2R #4). Not at push time: a round rolled back
   * by CONSUME_FAIL makes the turn the last one again, and its countdown must still be ticking
   * (3R #7) — the ticker simply skips it while the column is not in `error`.
   */
  function retireCountdown(turn) {
    if (!turn || !turn.resetAt) return;
    turn.resetAt = null;
    if (turn.errorLine) turn.errorLine.textContent = errorLineText(turn);
  }

  /** The wire `kind` of a send (see beginSend): retry > summary > resume > send / followup. */
  function sendKindFor(type, turnKind, retry, resume) {
    if (retry) return SEND_KIND_RETRY;
    if (turnKind === TURN_KIND_SUMMARY) return SEND_KIND_SUMMARY;
    if (resume) return SEND_KIND_RESUME;
    return type === 'SEND' ? SEND_KIND_SEND : SEND_KIND_FOLLOWUP;
  }

  /** The page's columns exist once the first status arrived: one `auto` column per provider, catalog order (the default layout). */
  function ensureDefaultColumns() {
    if (state.columns.size) return;
    // A stored layout (compareColumns) wins over the default; providers the store does not name
    // are simply absent (the user removed them).
    const ids = state.storedColumns && state.storedColumns.length ? state.storedColumns : COMPARE_PROVIDERS.map((p) => colIdOf(p, null));
    for (const id of ids) columnFor(id);
  }
  /**
   * The page shows at least these columns (a loaded history entry's), in their order, ahead of
   * whatever else it has — created when missing, existing ones moved to the front; never more
   * than MAX_COLUMNS in total (the page's own extra columns go first when there is no room).
   */
  function ensureLayout(ids) {
    const wanted = ids.map(normalizeColId).filter(Boolean).filter((id, i, arr) => arr.indexOf(id) === i);
    const missing = wanted.filter((id) => !state.columns.has(id) || state.columns.get(id).id !== id);
    // Room for the missing ones: drop the page's non-participating columns from the end.
    while (missing.length && state.columnIds.length + missing.length > MAX_COLUMNS) {
      const victim = [...state.columnIds].reverse().find((id) => !wanted.includes(id) && !state.columns.get(id).participated);
      if (!victim) break;
      removeColumn(victim);
    }
    for (const id of missing) columnFor(id);
    // Stored order first, then the rest as they were.
    const rest = state.columnIds.filter((id) => !wanted.includes(id));
    state.columnIds = [...wanted.filter((id) => state.columns.has(id) && state.columns.get(id).id === id), ...rest];
    for (const id of state.columnIds) columnsBox.appendChild(state.columns.get(id).node); // appendChild moves — DOM order = state order
    renderColumns();
  }
  /**
   * Every (provider, model) the page could show, vendor-grouped: Auto first, then the provider's
   * catalog (status.models[p]); `present` = a colId the page already has (the picker disables it).
   */
  /**
   * Every (provider, model) the picker offers, with `present` = the page already has that request.
   * A catalog without an Auto entry (ChatGPT) resolves `auto` to its DEFAULT model, so `p:auto` and
   * `p:<default>` are the SAME request: each counts as present when the other's column exists.
   */
  function columnChoices() {
    const st = state.status || {};
    const out = [];
    const has = (id) => state.columns.has(id) && state.columns.get(id).id === id;
    for (const p of COMPARE_PROVIDERS) {
      const list = st.models && Array.isArray(st.models[p]) ? st.models[p].filter((m) => m && typeof m === 'object') : [];
      const fallback = list.find((m) => m.default) || list[0];
      const autoAlias = fallback && fallback.id != null ? String(fallback.id) : null; // the model `auto` sends when the catalog has no Auto
      const models = [null, ...list.map((m) => (m.id == null ? null : String(m.id))).filter((id) => id !== null)];
      for (const model of models) {
        const id = colIdOf(p, model);
        const twin = autoAlias == null ? null : model == null ? colIdOf(p, autoAlias) : model === autoAlias ? colIdOf(p, null) : null;
        out.push({ id, provider: p, model, label: model == null ? t('col_picker_auto') : modelLabelOf(p, model), present: has(id) || (twin != null && has(twin)) });
      }
    }
    return out;
  }
  /** 「＋ 열 추가」: the first (provider, model) not on the page yet, at the end (columnFor holds the MAX_COLUMNS cap). */
  function addColumnByUser() {
    if (state.sessionStarted) return;
    const choice = columnChoices().find((c) => !c.present);
    if (!choice) return;
    const col = columnFor(choice.id);
    if (!col) return; // past the cap
    renderColumns();
    updateControls();
    saveLayout();
    track('column_add', { col: gaCol(col), n: state.columnIds.length });
  }
  /** ✕: before the session, never the last column. */
  function removeColumnByUser(colId) {
    if (state.sessionStarted || state.columnIds.length <= 1) return;
    const col = state.columns.get(colId);
    if (!col || col.id !== colId) return;
    removeColumn(colId);
    if (state.pickerFor === colId) closePicker();
    renderColumns();
    updateControls();
    saveLayout();
    track('column_remove', { col: gaCol(col), n: state.columnIds.length });
  }
  /**
   * A picker's choice for a column (before the session): the same provider (the model picker) → a
   * model change (setColumnModel re-keys); another provider (the service picker: `p:auto`, or the
   * first free model of `p` when auto is taken) → the column is REPLACED at its place by a fresh
   * one (nothing of it is worth keeping before a send). A choice the page already has is refused.
   */
  function chooseColumn(colId, choice) {
    const col = state.columns.get(colId);
    if (!col || col.id !== colId || state.sessionStarted) return false;
    const next = colIdOf(choice.provider, choice.model);
    if (next !== col.id && state.columns.has(next) && state.columns.get(next).id === next) return false;
    if (choice.provider === col.provider) {
      col.modelTouched = true;
      setColumnModel(col, choice.model);
      renderModelSelect(col);
    } else {
      const at = state.columnIds.indexOf(colId);
      closePicker(); // the popover sits inside the column about to go
      removeColumn(colId);
      const fresh = columnFor(next);
      if (!fresh) return false;
      state.columnIds = state.columnIds.filter((id) => id !== next);
      state.columnIds.splice(at, 0, next);
      const after = state.columnIds[at + 1] ? state.columns.get(state.columnIds[at + 1]).node : addColBtn;
      columnsBox.insertBefore(fresh.node, after);
      fresh.modelTouched = choice.model != null;
    }
    renderColumns();
    updateControls();
    saveLayout();
    track('column_change', { col: gaCol(state.columns.get(next)), n: state.columnIds.length });
    return true;
  }
  /** Persists the layout (colIds in order) to storage.sync — best effort, never awaited. */
  function saveLayout() {
    if (!syncStorage || typeof syncStorage.set !== 'function') return;
    try { const r = syncStorage.set({ compareColumns: state.columnIds.slice() }, () => { void (chrome && chrome.runtime && chrome.runtime.lastError); }); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch { /* storage gone */ }
  }
  /** Reads the stored layout once (before the first status); malformed → ignored. */
  function readLayout() {
    if (!syncStorage || typeof syncStorage.get !== 'function') return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; void (chrome && chrome.runtime && chrome.runtime.lastError); const ids = v && Array.isArray(v.compareColumns) ? v.compareColumns.map(normalizeColId).filter(Boolean).filter((id, i, a) => a.indexOf(id) === i).slice(0, MAX_COLUMNS) : []; state.storedColumns = ids.length ? ids : null; resolve(); };
      try { const r = syncStorage.get('compareColumns', done); if (r && typeof r.then === 'function') r.then(done, () => done(null)); } catch { done(null); }
    });
  }
  /** Drops a column from the page (its node, its record, its routing box). */
  function removeColumn(colId) {
    const col = state.columns.get(colId);
    if (!col || col.id !== colId) return;
    if (state.focusedCol === colId) setColumnFocus(null); // a wide column that goes takes the focus mode with it
    state.columns.delete(colId);
    state.columnIds = state.columnIds.filter((id) => id !== colId);
    state.followupTargets.delete(colId);
    if (col.node.parentNode) col.node.parentNode.removeChild(col.node);
  }
  function renderColumns() {
    const st = state.status;
    if (!st || !st.providers) return;
    ensureDefaultColumns();
    for (const col of allColumns()) {
      const p = col.provider;
      const pstate = st.providers[p] || { permitted: false, loggedIn: null };
      const excluded = state.excludeSrc && p === src;
      col.node.hidden = excluded;
      if (excluded) continue;
      renderModelSelect(col);
      renderPickerLabel(col);
      col.pickerBtn.hidden = state.sessionStarted && !col.modelKnown;
      col.removeBtn.hidden = state.sessionStarted || state.columnIds.length <= 1;
      syncServiceButton(col);
      syncFocusButton(col);
      // Provider-level state on the FIRST column of the provider only (cmp-columns §0): plan pill,
      // gauges, gate box. A sibling shows the shared-account chip in that slot instead.
      const first = firstColumnOf(p);
      const sibling = first && first !== col;
      if (sibling) { col.plan.hidden = true; col.usageRow.hidden = true; clear(col.usageRow); }
      else renderPlan(col);
      col.shared.hidden = !sibling; // for the whole session — the plan / gauges stay first-column-only (Codex integration #5)
      if (sibling) col.shared.textContent = t('col_shared', PROVIDER_META[p].label);
      // Once a session has started the column shows the conversation; the gate only applies before.
      if (col.participated) continue;
      const kind = gateKindFor(pstate);
      if (kind && sibling) { clear(col.body); col.gate = null; setBadge(col, null); } // the gate itself sits on the first column; the chip says where
      else if (kind) renderColumnGate(col, kind);
      else if (state.sessionStarted) renderColumnGate(col, GATE_JOINED); // signed in too late to join (SW: FOLLOWUP targets only participants)
      else { clear(col.body); col.gate = null; setBadge(col, null); }
    }
    addColBtn.hidden = state.sessionStarted || state.columnIds.length >= MAX_COLUMNS;
  }
  /**
   * Focus mode (열 포커스, 2026-09-21 user decision A — in place, no DOM moves): `state.focusedCol`
   * names the column shown at full width; every other column is a 48px rail (compare.css ── focus ──:
   * `is-focus` on the root, `is-focused` on the column). Page-local, never stored; entered only once
   * the session started (the hero has nothing to widen — `is-hero` and `is-focus` never meet) and
   * left by ⤡ / Escape / a rail click (moves it) / 새 대화 / the focused column's removal.
   * `colId` null (or unknown) = back to the grid.
   */
  function setColumnFocus(colId) {
    const target = colId ? state.columns.get(colId) : null;
    const next = state.sessionStarted && target && target.id === colId ? colId : null;
    if (next === state.focusedCol) return;
    const prev = state.focusedCol;
    state.focusedCol = next;
    root.classList.toggle(FOCUS_CLASS, !!next);
    for (const col of state.columns.values()) { col.node.classList.toggle('is-focused', col.id === next); syncFocusButton(col); }
    // Columns that were rails (display:none bodies) lost their scroll offsets while hidden; once the
    // layout is back, put each one where the reader left it — following columns to their end, a
    // scrolled-up / anchored one keeps its place and its pill (the DONE rule, port.js) (후속 3).
    raf(() => {
      for (const col of state.columns.values()) {
        if (col.id === next || !col.body) continue;
        if (!col.followAnchored && !col.userScrolledUp) scrollColumnToEnd(col); else syncJumpButton(col);
      }
    });
    if (next) track('col_focus', { provider: target.provider, on: 1 });
    else track('col_focus', { provider: parseColId(prev).provider, on: 0 });
  }
  /** ⤢ / ⤡: focus this column, or back to the grid when it is the focused one. */
  function toggleColumnFocus(colId) { setColumnFocus(state.focusedCol === colId ? null : colId); }
  /** The head's ⤢ button: hidden before the session; ⤡ + 「원래 크기로」 on the focused column. */
  function syncFocusButton(col) {
    const focused = state.focusedCol === col.id;
    col.focusBtn.hidden = !state.sessionStarted;
    col.focusBtn.textContent = focused ? '⤡' : '⤢';
    const label = t(focused ? 'col_unfocus' : 'col_focus');
    col.focusBtn.title = label;
    col.focusBtn.setAttribute('aria-label', label);
    col.focusBtn.setAttribute('aria-pressed', focused ? 'true' : 'false');
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

  // ── column thread · activity panel · port / streaming ──
  // These slices live in ui/compare/column-thread.js (the turns of a column body, paint / follow,
  // the action row, the per-column composer, retry, error copy), ui/compare/activity.js (the
  // process panel above an answer) and ui/compare/port.js (the session port, every SW message,
  // the keepalive, beginSend / finishSend) — installed above (installColumnThread / installActivity /
  // installPort). Their column DOM and mount-time listeners stay in this file.

  /** Participating, visible columns — the follow-up routing's universe. */
  const liveColumns = () => allColumns().filter((c) => c.participated && !c.node.hidden); // page order (a re-keyed column keeps its place)
  ctx.liveColumns = liveColumns;
  /**
   * A lost port is survivable (D3) only for a session whose SEND carried saveHistory:true — the
   * provider conversations still exist — and only through a column that reported a continuation
   * (DONE.continuation). An incognito session, or one lost before any DONE, has nothing to resume.
   */
  const canResume = () => state.sessionStarted && state.sessionEnded && state.sessionSaveHistory === true && liveColumns().some((c) => !!c.continuation);
  ctx.canResume = canResume;
  /** A participating column the session can no longer reach: its port is gone (or was replaced by a resume) and it never reported a continuation. */
  const columnDead = (col) => (state.sessionEnded || state.resumed) && !col.continuation;
  ctx.columnDead = columnDead;
  /**
   * A participating column stuck behind a sign-in / permission gate (3R #6): it errored with a
   * gate code and no status read since has found it sendable (col.gateCleared). ONE predicate for
   * every surface that would otherwise contradict the hidden retry — the C4 button, the routing
   * boxes / followupPlan, and the C5 judge candidates (worker-3's answeredColumns). Its earlier
   * answer stays what it is (copyable, attachable as evidence); only new sends are off.
   */
  // A gate is a PROVIDER fact: one column of the provider stuck behind it gates every column of that provider (cmp-columns §0).
  const providerUnresolvedGate = (p) => allColumns().some((col) => col.provider === p && col.status === 'error' && GATE_CODES.has(col.errorCode) && !col.gateCleared);
  ctx.providerUnresolvedGate = providerUnresolvedGate;
  /** Live columns a follow-up may be routed to: participating, visible, not behind an unresolved gate. */
  const routableColumns = () => liveColumns().filter((c) => !providerUnresolvedGate(c.provider));
  ctx.routableColumns = routableColumns;
  // Follow-ups need the same login the first send needed: a 401/403 on a follow-up consume flips
  // `loggedIn` to false and must stop the next click too (Codex #5). And no port ⇒ no session —
  // unless the session can be resumed on a new one (canResume).
  const canFollowUp = () => state.sessionStarted && !state.disabled && !!(state.status && state.status.loggedIn) && ((!state.sessionEnded && !!state.port) || canResume());
  ctx.canFollowUp = canFollowUp;

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
    const routable = routableColumns();
    const checked = routable.filter((c) => state.followupTargets.has(c.id));
    let targets;
    let skipped;
    // 「전체」 = every routable column checked; the AC21 sweep still runs over every live column, so
    // a gated one is skipped with 「건너뜀」 like any other non-retriable error (3R #6).
    if (checked.length === routable.length) {
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
    return { targets: targets.map((c) => c.id), skipped: skipped.map((c) => c.id) };
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
    const routable = routableColumns();
    const choices = [[FOLLOWUP_ALL, t('followup_target_all'), null]];
    for (const col of live) choices.push([col.id, colLabel(col), col.provider]);
    // The set is pruned to what can be routed to: a column behind an unresolved gate leaves it
    // (its box is disabled and says why — 3R #6), a vanished column too.
    state.followupTargets = new Set(routable.map((c) => c.id).filter((id) => state.followupTargets.has(id)));
    const all = routable.length > 0 && state.followupTargets.size === routable.length;
    // Same choices, same nodes, in every instance; each instance's boxes carry their own name.
    for (const { select, radioName } of composers) {
      const existing = Array.from(select.querySelectorAll('input'));
      // A column's label follows its model (an in-session pick) — a changed label rebuilds too.
      const same = existing.length === choices.length && existing.every((input, i) => input.value === choices[i][0] && input.getAttribute('data-label') === choices[i][1]);
      if (!same) {
        clear(select);
        for (const [v, label, provider] of choices) {
          const item = el('label', 'cmp-seg-item' + (provider ? '' : ' cmp-seg-item-all'));
          const input = el('input');
          input.type = 'checkbox';
          input.name = radioName;
          input.value = v;
          input.setAttribute('value', v);
          input.setAttribute('data-label', label);
          item.appendChild(input);
          const text = el('span', 'cmp-seg-label');
          if (provider) text.appendChild(dot(provider));
          text.appendChild(el('span', null, label));
          item.appendChild(text);
          select.appendChild(item);
        }
      }
      for (const input of select.querySelectorAll('input')) {
        const boxCol = input.value !== FOLLOWUP_ALL ? state.columns.get(input.value) : null;
        const gated = !!boxCol && providerUnresolvedGate(boxCol.provider);
        input.checked = input.value === FOLLOWUP_ALL ? all : state.followupTargets.has(input.value);
        input.disabled = state.sending || gated;
        // The gate reason on the segment (the label wraps the input): sign in / allow access on the column first.
        if (input.parentNode) { if (gated) input.parentNode.title = t('followup_target_gated', PROVIDER_META[boxCol.provider].label); else input.parentNode.removeAttribute('title'); }
      }
    }
  }
  /** The bottom caption: 「전체」, the checked labels (`Claude + Gemini`), or the pick-one hint. */
  function followupTargetText() {
    const routable = routableColumns();
    const checked = routable.filter((c) => state.followupTargets.has(c.id));
    if (routable.length && checked.length === routable.length) return t('followup_target_all');
    if (!checked.length) return t('followup_target_none');
    return checked.map((c) => colLabel(c)).join(' + ');
  }

  function updateControls() {
    // A counted quota at 0 disables every send (the dock, the follow-up composers, the per-column
    // inputs) through the ONE predicate the retry / Auto rows and the 「요약·비교」 button already read
    // — quotaExhausted() (plan compare-quota-premium §3 U3). Drafting stays possible; only the
    // send waits, like it does while a round streams. The server's 429 remains the backstop.
    const exhausted = quotaExhausted();
    const canSend = !state.sending && !state.sessionStarted && !exhausted && currentQuestion().length > 0 && currentTargets().length > 0;
    sendBtn.disabled = !canSend;
    sendBtn.textContent = state.sending ? t('sending') : t('send');
    qCard.classList.toggle('is-quota-exhausted', exhausted);
    for (const c of composers) c.section.classList.toggle('is-quota-exhausted', exhausted);
    // Once the session started the question composer leaves the dock (its whole section: the
    // textarea, the action row with the toggles, the send button) — the follow-up composer is the
    // dock's face from here (finding B), the topbar chip still says where the question came from,
    // and the columns show who got it (the bubble at the top of each thread).
    sendBtn.hidden = state.sessionStarted;
    controls.hidden = state.sessionStarted;
    qCard.hidden = state.sessionStarted;
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
    for (const col of state.columns.values()) {
      renderColumnActions(col);
      col.pickerBtn.hidden = state.sessionStarted && !col.modelKnown;
      col.pickerBtn.disabled = state.sending;
      col.removeBtn.hidden = state.sessionStarted || state.columnIds.length <= 1;
      syncServiceButton(col);
      syncFocusButton(col);
    }
    addColBtn.hidden = state.sessionStarted || state.columnIds.length >= MAX_COLUMNS;
    if (state.pickerFor && (state.sending || (state.sessionStarted && (state.pickerKind === 'service' || !state.columns.get(state.pickerFor).modelKnown)))) closePicker();
    syncCopyAll();
    syncSummaryButton();
    for (const c of composers) c.section.hidden = !state.sessionStarted;
    // The per-column input on every column that can take a follow-up of its own; a column that
    // stopped qualifying hides the whole thing — its open state and draft are kept, so a column
    // that comes back (a resume, a cleared gate) shows the composer as the user left it. Its
    // textarea is inert while a round is in flight, like the dock's send.
    // A draft must never vanish (Codex layout 1R #1): when the column is gone for good (dead —
    // port lost without a continuation —, behind a gate, hidden) while its composer holds text,
    // the text moves into the dock's textarea if that is empty (the routing set is left alone:
    // the user sees the words and re-targets); otherwise the column box stays on screen, read-only
    // (copyable) until 새 대화 or the column comes back. The transient "no port yet" moment of a
    // port loss is not a reason (columnDead needs sessionEnded, set right after).
    for (const col of state.columns.values()) {
      const askable = columnAskable(col);
      const draft = String(col.askInput.value || '').trim();
      const gone = !askable && !!draft && (columnDead(col) || providerUnresolvedGate(col.provider) || col.node.hidden);
      if (gone && !String(followup.input.value || '').trim()) {
        followup.input.value = col.askInput.value;
        autoGrow(followup.input);
        col.askInput.value = '';
        setColumnAsk(col, false);
      }
      const stranded = gone && !!String(col.askInput.value || '').trim();
      if (stranded) setColumnAsk(col, true);
      col.ask.hidden = !askable && !stranded;
      col.ask.classList.toggle('is-stranded', stranded);
      col.askTab.hidden = stranded;
      col.askInput.readOnly = stranded;
      col.askColBtn.hidden = !askable;
      col.askColBtn.disabled = state.sending || exhausted;
      col.askInput.disabled = state.sending && !stranded;
    }
    if (state.sessionStarted) {
      renderFollowupTargets();
      // Drafting is allowed while a round streams (the textarea stays enabled); only the send
      // waits for the round to settle.
      const noTargets = followupPlan().targets.length === 0;
      const canType = canFollowUp();
      const targetText = followupTargetText();
      for (const c of composers) {
        c.btn.disabled = state.sending || noTargets || exhausted;
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
    state.roundSeq = 0;
    state.roundInFlight = null;
    state.activeRound = null;
    state.firstRound = null;
    state.roundStartedAt = null;
    state.sessionId = null;
    state.followupTargets = new Set();
    state.pendingFollowupCol = null;
    state.summaryPending = null;
    state.judgeChoice = null;
    setColumnFocus(null); // before sessionStarted is read again: the grid comes back with the hero
    closeSummaryPop();
    closeHistoryPanel();
    syncHistoryButton(null); // count re-read from the last good list (Codex hist 1R #9)
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

  // ── local history (recent sessions) ──
  // The slice lives in ui/compare/history.js (installHistory, installed above): storage, the
  // cross-tab lock, snapshot / fit / persist, the validated read, the list and loadSession. The
  // panel DOM below and its wiring stay here (DOM order and mount-time listeners are this file's).
  // The panel: a small dialog under the topbar listing the entries newest first — question preview,
  // when, which providers — each with its own 「삭제」, and 「모두 삭제」 at the bottom.
  const historyPanel = el('div', 'cmp-history');
  historyPanel.id = 'cmp-history-panel';
  historyPanel.hidden = true;
  historyPanel.setAttribute('role', 'dialog');
  historyPanel.setAttribute('aria-label', t('history_title'));
  const historyHead = el('div', 'cmp-history-head');
  historyHead.appendChild(el('span', 'cmp-history-title', t('history_title')));
  // Search (chathub batch 1, C2): filters the cached list over the question AND every stored turn
  // — a keyword that only appears in an answer still finds the conversation. Debounced; never a
  // storage read per keystroke. Esc keeps closing the panel (the document handler sees it bubble).
  const historySearch = el('input', 'cmp-history-search');
  historySearch.type = 'search';
  historySearch.id = 'cmp-history-search';
  historySearch.placeholder = t('history_search_placeholder');
  historySearch.setAttribute('aria-label', t('history_search_placeholder'));
  historySearch.setAttribute('autocomplete', 'off');
  historyHead.appendChild(historySearch);
  const historyClearBtn = el('button', 'cmp-btn cmp-btn-sm cmp-history-clear', t('history_clear'));
  historyClearBtn.type = 'button';
  historyHead.appendChild(historyClearBtn);
  historyPanel.appendChild(historyHead);
  const historyList = el('div', 'cmp-history-list');
  historyPanel.appendChild(historyList);
  // The note: incognito is never stored, and an answer is stored (so searchable) only up to its clip.
  const historyNote = el('p', 'cmp-history-note', `${t('history_incognito_note')} ${t('history_search_note', HISTORY_TEXT_MAX.toLocaleString())}`);
  historyPanel.appendChild(historyNote);
  root.appendChild(historyPanel);
  Object.assign(ctx, { historyPanel, historyHead, historySearch, historyClearBtn, historyList, historyNote });
  let historySearchTimer = null;
  historySearch.addEventListener('input', () => {
    if (historySearchTimer != null) clock.clearTimeout(historySearchTimer);
    historySearchTimer = clock.setTimeout(() => { historySearchTimer = null; paintHistoryList(); }, HISTORY_SEARCH_DEBOUNCE_MS);
  });
  historyBtn.addEventListener('click', () => { if (historyPanel.hidden) openHistoryPanel(); else closeHistoryPanel(); });
  historyClearBtn.addEventListener('click', clearHistory);
  if (typeof doc.addEventListener === 'function') {
    // Escape leaves focus mode — only when nothing else owns the key: a picker / column composer
    // Escape arrives defaultPrevented, the history panel and the summary popover are checked here
    // (this listener runs before theirs — registration order).
    doc.addEventListener('keydown', (e) => {
      if (!e || e.key !== 'Escape' || !state.focusedCol || e.defaultPrevented) return;
      if (state.pickerFor || !historyPanel.hidden || !summaryPop.hidden) return;
      setColumnFocus(null);
    });
    doc.addEventListener('keydown', (e) => { if (e && e.key === 'Escape' && !historyPanel.hidden) closeHistoryPanel(); });
    // Focus mode is a ≥721px layout (compare.css ── focus ──): when the viewport drops into the
    // single-column range the mode ends rather than lingering as a stale class whose only effect
    // would be a `col_focus` event on every click in another column (substitute review 후속 2).
    try {
      const narrow = win && typeof win.matchMedia === 'function' ? win.matchMedia('(max-width: 720px)') : null;
      if (narrow && typeof narrow.addEventListener === 'function') narrow.addEventListener('change', (e) => { if (e.matches) setColumnFocus(null); });
    } catch { /* no matchMedia (tests) */ }
    doc.addEventListener('click', (e) => {
      if (historyPanel.hidden || !e || !e.target) return;
      const inside = (node) => { for (let n = node; n; n = n.parentNode) if (n === historyPanel || n === historyBtn) return true; return false; };
      if (!inside(e.target)) closeHistoryPanel();
    });
  }
  if (historyStorage) historyUpdate(null).then((r) => syncHistoryButton(r.ok ? r.list : null));

  // The confirm popover: what goes where, what it costs, the judge select, send / cancel. Built
  // once; its lines are refilled on open. Same dialog conventions as the history panel (Esc,
  // outside click, aria-expanded on its button).
  const summaryPop = el('div', 'cmp-summary-pop');
  summaryPop.id = 'cmp-summary-pop';
  summaryPop.hidden = true;
  summaryPop.setAttribute('role', 'dialog');
  summaryPop.setAttribute('aria-label', t('summary_pop_title'));
  summaryPop.appendChild(el('p', 'cmp-summary-pop-title', t('summary_pop_title')));
  const summaryDesc = el('p', 'cmp-summary-pop-desc');
  summaryPop.appendChild(summaryDesc);
  const summaryJudgeLabel = el('label', 'cmp-summary-judge');
  summaryJudgeLabel.appendChild(el('span', 'cmp-summary-judge-label', t('summary_judge_label')));
  const summaryJudge = el('select', 'cmp-model-select cmp-summary-judge-select');
  summaryJudge.id = 'cmp-summary-judge';
  summaryJudgeLabel.appendChild(summaryJudge);
  summaryPop.appendChild(summaryJudgeLabel);
  const summaryCost = el('p', 'cmp-summary-pop-note', t('summary_pop_cost'));
  summaryCost.id = 'cmp-summary-cost';
  summaryPop.appendChild(summaryCost);
  const summaryHistoryNote = el('p', 'cmp-summary-pop-note');
  summaryPop.appendChild(summaryHistoryNote);
  const summaryActions = el('div', 'cmp-summary-pop-actions');
  const summarySendBtn = el('button', 'cmp-btn cmp-btn-sm cmp-btn-primary', t('summary_pop_send'));
  summarySendBtn.id = 'cmp-summary-send';
  summarySendBtn.type = 'button';
  const summaryCancelBtn = el('button', 'cmp-btn cmp-btn-sm', t('summary_pop_cancel'));
  summaryCancelBtn.id = 'cmp-summary-cancel';
  summaryCancelBtn.type = 'button';
  summaryActions.appendChild(summarySendBtn);
  summaryActions.appendChild(summaryCancelBtn);
  summaryPop.appendChild(summaryActions);
  root.appendChild(summaryPop);
  Object.assign(ctx, { summaryPop, summaryDesc, summaryJudgeLabel, summaryJudge, summaryCost, summaryHistoryNote, summaryActions, summarySendBtn, summaryCancelBtn });
  summaryBtn.addEventListener('click', () => { if (summaryPop.hidden) openSummaryPop(); else closeSummaryPop(); });
  summaryJudge.addEventListener('change', () => { state.judgeChoice = summaryJudge.value || null; paintSummaryPop(); });
  summarySendBtn.addEventListener('click', startSummary);
  summaryCancelBtn.addEventListener('click', closeSummaryPop);
  if (typeof doc.addEventListener === 'function') {
    doc.addEventListener('keydown', (e) => { if (e && e.key === 'Escape' && !summaryPop.hidden) closeSummaryPop(); });
    doc.addEventListener('click', (e) => {
      if (summaryPop.hidden || !e || !e.target) return;
      const inside = (node) => { for (let n = node; n; n = n.parentNode) if (n === summaryPop || n === summaryBtn) return true; return false; };
      if (!inside(e.target)) closeSummaryPop();
    });
  }

  // ── status ──
  // A COMPARE_STATUS answer is a snapshot of the moment it was ASKED. Anything that made the page's
  // own count newer since — a CONSUME_OK / quota CONSUME_FAIL, or 새 대화 — bumps this epoch, and
  // an answer that comes back under an older epoch is dropped whole (the next call redoes it).
  // Without it the refresh 새 대화 launches, or a pre-consume disconnect's refreshQuota, lands after
  // the replacement round's CONSUME_OK and paints the old count over the new one (Codex 2R #1).
  let statusEpoch = 0;
  /** The epoch bump for a slice module (ui/compare/*.js): a `let` cannot be shared across files, a call can. */
  function bumpStatusEpoch() { statusEpoch++; }
  /**
   * The quota facts only — re-read after a send whose outcome the page could not observe, or a
   * round that went out before a beta reset. Everything the quota line and the beta offer read
   * comes from the SAME status answer: `quota`, `quotaError` and `betaReset` (Codex 2R #1: applying
   * the quota alone left a `betaReset:false` / a stale network notice from a failed post-reset read
   * in place, and the offer stayed hidden at the next exhaustion). Never the gates / columns —
   * that is readStatus, which repaints the session's columns and is not for mid-session use.
   */
  async function refreshQuota() {
    if (state.disabled) return;
    const epoch = statusEpoch;
    const res = await sendMessage(chrome, { type: 'COMPARE_STATUS' });
    if (epoch !== statusEpoch) return; // stale: a newer count was written while this was in flight
    if (!res || !res.ok || !state.status) return;
    const qe = res.quotaError || null;
    state.status.quota = res.quota;
    state.status.quotaError = qe;
    state.status.betaReset = res.betaReset === true;
    // The previous read's quota-error notice (the only status-owned `error` notice, see readStatus)
    // is superseded by this read: gone when the read succeeded, replaced when it failed again.
    if (state.notice && state.notice.owner === NOTICE_OWNER_STATUS && state.notice.kind === 'error') clearNotice();
    if (qe && statusOwnsNotice()) showNotice('error', [t(qe.code === CODE_NETWORK_ERROR ? 'err_network_error' : 'err_generic')], null, NOTICE_OWNER_STATUS);
    renderQuota(res.quota, qe); // + the beta offer (renderResetOffer)
    renderExamplesIntro();
    // The count gates more than its line: the retry / Auto rows and the 「요약·비교」 button read it
    // through quotaExhausted() — repaint them as a status read would (Codex C5 3R #4: a re-read
    // that came back 0 left the button enabled and the rows stale).
    updateControls();
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
  // Every status read gets a sequence number at its START (before the await): a column records the
  // count at its gate-code error, and only reads numbered above it may clear or revoke the gate.
  let statusReadSeq = 0;
  /** The read sequence for a slice module (port.js stamps it on a gate-code error): a `let` cannot be shared across files, a getter can. */
  function currentStatusReadSeq() { return statusReadSeq; }
  async function readStatus(epoch) {
    const seq = ++statusReadSeq;
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
    renderExamplesIntro();
    // The chips follow the status too (the server pool arrives with it); only while the block is
    // still the empty state — a session in progress has nothing to re-pick.
    if (!state.sessionStarted) renderExampleChips();
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
    // C3: only a read STARTED after the column's gate-code error speaks for it (Codex batch-1 #2):
    // sendable again → the retry comes back; still gated → cleared is revoked (a later negative
    // read takes the retry away again). A read from before the error changes nothing.
    const providers = state.status.providers || {};
    for (const col of state.columns.values()) {
      if (col.status === 'error' && GATE_CODES.has(col.errorCode) && seq > col.gateErrorSeq) col.gateCleared = gateKindFor(providers[col.provider]) === null;
    }
    syncZeroTargetsNotice();
    updateControls();
    if (ctx.pendingLoad && state.columns.size) { const entry = ctx.pendingLoad; ctx.pendingLoad = null; loadSession(entry); }
  }

  // ── auto-reconnect (login guidance) ──
  // The user signs in to a provider in another tab and comes back: the tab regaining focus /
  // visibility (or being restored from bfcache) re-reads the status, so the gate opens by itself
  // instead of asking for a reload. Only before a session (a gated column cannot join a running
  // one — the manual 「다시 확인」 still works there and shows GATE_JOINED), never while a send is
  // pending, only when something is gated, at most once per AUTO_REFRESH_MIN_MS.
  let lastAutoRefreshAt = -Infinity;
  function autoRefresh() {
    if (state.disabled || state.sending) return;
    // An exhausted page (the composer is gated on the count, plan §3 U3) re-reads the quota on
    // focus as well — the day rolls over at UTC midnight while the tab sits in the background,
    // and the gate must open without a reload. Mid-session that is the quota-only read.
    const exhausted = quotaExhausted();
    if (!exhausted && (state.sessionStarted || !anyGate())) return;
    const now = clock.now();
    if (now - lastAutoRefreshAt < AUTO_REFRESH_MIN_MS) return;
    lastAutoRefreshAt = now;
    if (state.sessionStarted) refreshQuota(); else refreshStatus();
  }
  // This mount's identity in the registry: a teardown removes only its OWN entry — a late
  // coming-soon of a replaced mount must not strip the replacement's listeners (Codex b2 3R #3).
  const mountToken = {};
  ctx.mountToken = mountToken;
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
    if (state.disabled || !targets.length || state.sending || state.sessionStarted || !text || quotaExhausted()) return;
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
    if (!text || !targets.length || state.sending || !canFollowUp() || quotaExhausted()) return;
    state.pendingFollowup = text;
    state.pendingFollowupCol = null; // typed in the dock: a rollback restores it there
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
  // The stored layout must be known before the first status builds the columns.
  readLayout().then(() => refreshStatus());

  // Exposed for the flow guard only.
  return { state, refreshStatus, sendableTargets: currentTargets, loadSession, snapshotSession, fitEntry, setColumnFocus };
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
