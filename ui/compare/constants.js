// ui/compare/constants.js — every module-level constant of the compare page (compare.js), in one
// place so the mountComparePage() slices under ui/compare/ import what they use instead of closing
// over compare.js. Values, comments and order are exactly as they were in compare.js; compare.js
// re-exports the public ones (COMPARE_PORT_NAME, PRO_URL, KEEPALIVE_MS, …) so its consumers are
// unchanged. No imports: this file is dependency-free.

export const COMPARE_PORT_NAME = 'ctcmp-compare';
export const COMPARE_PROVIDERS = ['claude', 'gemini', 'chatgpt'];
// Column model (2026-09-20, .omc/handoffs/cmp-columns-contract.md): a column is a PROVIDER + a
// MODEL — `colId` = `${provider}:${modelId || 'auto'}` (`claude:auto`, `claude:claude-opus-5`),
// unique per session, at most MAX_COLUMNS on the page. Everything that used to be keyed by
// provider (state.columns, routing, provenance, history, the wire) is keyed by colId; what is a
// PROVIDER fact (login gate, permission, plan, gauges, status.providers) stays per provider and is
// joined through `col.provider`. A bare provider id is the LEGACY key — an old history entry, an
// event from an SW that only names the provider — and reads as that provider's `auto` column
// (the first column of the provider on the page).
export const MAX_COLUMNS = 5;
export const MODEL_AUTO_ID = 'auto';
export const colIdOf = (provider, model) => `${provider}:${model == null || model === '' ? MODEL_AUTO_ID : String(model)}`;
/** `{provider, model}` of a colId (model null = auto), or null when the provider is not one of ours. A bare provider id = its auto column. */
export function parseColId(id) {
  if (typeof id !== 'string' || !id) return null;
  const at = id.indexOf(':');
  const provider = at < 0 ? id : id.slice(0, at);
  if (!COMPARE_PROVIDERS.includes(provider)) return null;
  const model = at < 0 ? '' : id.slice(at + 1);
  return { provider, model: !model || model === MODEL_AUTO_ID ? null : model };
}
/** The canonical colId of an id or a legacy provider key; null when it is neither. */
export function normalizeColId(id) {
  const parsed = parseColId(id);
  return parsed ? colIdOf(parsed.provider, parsed.model) : null;
}
/**
 * state.columns: colId → column. `get`/`has` also answer a LEGACY provider key with that provider's
 * first column — for old history entries, for an SW event that names only the provider, and for
 * the flow guard's provider-keyed reads. Production code passes colIds.
 */
export class ColumnMap extends Map {
  resolve(key) {
    if (super.has(key)) return key;
    if (typeof key !== 'string' || key.includes(':')) return null;
    for (const [id, col] of this) if (col.provider === key) return id;
    return null;
  }
  get(key) { const id = this.resolve(key); return id === null ? undefined : super.get(id); }
  has(key) { return this.resolve(key) !== null; }
}
export const PROVIDER_META = {
  claude: { label: 'Claude', site: 'https://claude.ai/', origin: 'https://claude.ai/*' },
  gemini: { label: 'Gemini', site: 'https://gemini.google.com/', origin: 'https://gemini.google.com/*' },
  chatgpt: { label: 'ChatGPT', site: 'https://chatgpt.com/', origin: 'https://chatgpt.com/*' },
};
export const SITE_URL = 'https://claudetuner.com';
// The welcome page carries the extension sign-in flow (Google + email code) — the same entry the
// popup's login CTA leads to. ui/login-cta.js itself is not reusable here: it imports the popup's
// block-state / provider-state modules and reads popup-only storage.
export const LOGIN_URL = `${SITE_URL}/welcome/`;
// Premium upsell (plan compare-quota-premium §2, 2026-09-20): ONE constant for every Premium link on
// this page — the 429 notice CTA, the low-quota hint, the exhausted CTA, the failed-reset CTA.
// `/pricing/` is the public plans page (ko/en; `/premium/` 301s there — plan §2, 2026-09-20); its own
// CTA leads to the dashboard billing card.
export const PRO_URL = `${SITE_URL}/pricing/?utm_source=ext&utm_medium=compare&utm_campaign=quota`;
// Quota widget (plan §3 U3): a counted quota with this many compares left (or fewer) is the 「low」
// state — amber + the inline 「Premium이면 무제한」 link. 0 is 「exhausted」 (quotaExhausted()).
export const QUOTA_LOW_REMAINING = 5;
// The 「전체」 chip's value in the follow-up routing set (every participating column checked).
export const FOLLOWUP_ALL = 'all';
// Copy kinds reported to analytics (contract E `copy{kind, provider}`): the frozen question, one
// assistant answer, one user follow-up turn (a question inside the thread), one column's whole
// thread, the whole comparison.
export const COPY_KIND_QUESTION = 'question';
export const COPY_KIND_TURN = 'turn';
export const COPY_KIND_THREAD = 'thread';
export const COPY_KIND_COLUMN = 'column';
export const COPY_KIND_ALL = 'all';
// The message type analytics ride on (contract E): the SW validates and forwards to GA4.
export const EVENT_MSG_TYPE = 'COMPARE_EVENT';
// Beta usage stats (.omc/handoffs/cmp-beta-contract.md §3): every SEND / FOLLOWUP names what the
// page is doing (`kind`) and the round it belongs to (`round`); the SW forwards both to
// POST /api/compare/consume, where they become the compare_events row. The page decides the kind:
// the composer's first send, a follow-up, a 「요약·비교」, a retry (repeats a round — the round it
// was given, never a new one), a SEND{resume} on a fresh port.
export const SEND_KIND_SEND = 'send';
export const SEND_KIND_FOLLOWUP = 'followup';
export const SEND_KIND_SUMMARY = 'summary';
export const SEND_KIND_RETRY = 'retry';
export const SEND_KIND_RESUME = 'resume';
// Beta reset (same contract): while status.betaReset is true a counted quota at 0 offers
// 「오늘 횟수 초기화」 instead of the Pro CTA — this message asks the SW (→ POST /api/compare/reset)
// and its answer `{ok, quota}` is applied as a fresh status quota.
export const RESET_MSG_TYPE = 'COMPARE_RESET';
// Analytics `send.models`: a target with no model choice (no catalog / the provider default) reads as this.
export const MODELS_CSV_AUTO = 'auto';
// …and each id is cut to its last path segment and this many chars, so three `provider:id` pairs
// stay under the SW's 100-char param cap (bg/compare.js bounds every string param).
export const MODELS_CSV_ID_MAX = 24;
// 🔴 The model-id rule, twin of the SW's (bg/compare.js MODEL_ID_RE — the SW is the last line, it
// re-checks `models` / `model` params; this page cannot import it). Checked on the RAW id before
// any shortening: an id that fails is not a model id (a label, a path, junk) and the pair is
// dropped from analytics — `column_done.model` likewise carries the id only, never the label.
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// The page's session id on the wire (cmp-beta-contract §5): the history entry id — opaque, and
// bounded exactly as the SW validates it (bg/compare.js `^[A-Za-z0-9-]{8,40}$`); anything else is
// omitted here already, so the two validators never disagree about what went out.
export const SESSION_ID_RE = /^[A-Za-z0-9-]{8,40}$/;
// COMPARE_RESET answered `{ok:false, reset:true, code:'status_unavailable'}`: the counter WAS reset
// but the SW could not re-read the status — the page's own status read replaces the missing quota.
export const RESET_CODE_STATUS_UNAVAILABLE = 'status_unavailable';
// The follow-up composer's id suffix (one instance since the chat layout; makeFollowupComposer
// stays a factory so the ids the flow guard drives are built in one place).
export const FOLLOWUP_ID_BOTTOM = '';
// How long a copy button says 「복사됨」 before it turns back into the icon.
export const COPY_FEEDBACK_MS = 1500;
export const SVG_NS = 'http://www.w3.org/2000/svg';
// A model catalog entry with `id:null` is the provider's own default ("Auto"); it travels as this
// option value and back to null on the wire (contract: `models: { [provider]: id|null }`).
export const MODEL_AUTO_VALUE = '';
export const MODEL_SOURCE_REQUESTED = 'requested';
// Follow-up textarea grows with its content up to this many pixels, then scrolls (CSS max-height matches).
export const COMPOSER_MAX_HEIGHT = 200;
// Streaming scroll, ChatGPT/Claude-style (ported from dowoo sidepanel.js maybeFollowStream, 2026-09-18):
// a column follows the growing answer only while the answer still FITS its body; the first time
// the answer overflows, its START is anchored just under the head ONCE and the rest streams in
// below the fold — the view is never yanked down chunk by chunk. A manual scroll-up stops the
// follow too. Whenever the reader is not at the end of a column that has content, a 「↓ 새 내용」
// pill sits at the bottom of that column and jumps to the end. Distances in px.
export const FOLLOW_AT_BOTTOM_PX = 50;   // this close to the end counts as "at the bottom"
export const FOLLOW_ANCHOR_TOP_PX = 16;  // where the overflowing answer's start is anchored (below the body top)
// Usage gauge window labels (windowText): a span under a day reads in hours, else in days.
export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86400;
// Auto-reconnect (login guidance): a status re-read on focus / visibility / bfcache restore while
// some column is gated, at most one per this many ms and never while a session runs.
export const AUTO_REFRESH_MIN_MS = 3000;
// Gate kinds a column body can show before it takes part (renderColumnGate).
export const GATE_PERMISSION = 'permission';
export const GATE_LOGIN = 'login';
export const GATE_UNKNOWN = 'unknown';
export const GATE_JOINED = 'joined';
// Who put the current notice up: a status read may replace only its own (the extension-login
// notice, a status-call error, the zero-targets hint) — never a consume error or the quota
// notice, which describe something the user has to act on (Codex b2 2R #2).
export const NOTICE_OWNER_PAGE = 'page';
export const NOTICE_OWNER_STATUS = 'status';
// A consume-time 401/403 notice: page-owned, but a status read that finds the extension signed in
// again resolves exactly it (Codex b2 3R #2).
export const NOTICE_OWNER_LOGIN = 'login';
// The 429 quota notice: page-owned like the rest, but a successful beta reset resolves exactly it
// (the count it describes is gone) and nothing else that may be showing.
export const NOTICE_OWNER_QUOTA = 'quota';
// The auto-reconnect listeners of the mount that owns a document: a remount (the flow guard, a
// hot reload) removes the previous mount's before adding its own, and coming-soon removes them
// for good (Codex b2 2R #3).
export const AUTO_REFRESH_LISTENERS = new WeakMap(); // document → { win, doc, focus, pageshow, visibility }
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;
export const HTTP_TOO_MANY = 429;
export const CODE_COMPARE_QUOTA = 'compare_quota';
export const CODE_RATE_LIMITED = 'rate_limited';
export const CODE_NO_TARGETS = 'no_targets';
// CONSUME_FAIL codes the SW emits besides the HTTP ones (PR #1459): a send already in flight, the
// consume request itself failed, Stop pressed before the debit (free — nothing was counted).
export const CODE_BUSY = 'busy';
export const CODE_NETWORK_ERROR = 'network_error';
export const CODE_ABORTED = 'aborted';
// Per-provider answer budget exhausted (bg/compare.js PROVIDER_SEND_TIMEOUT_MS); ERROR carries `budgetMs`.
export const CODE_TIMEOUT = 'timeout';
export const DEFAULT_SEND_BUDGET_MS = 10 * 60 * 1000;
export const MS_PER_MINUTE = 60 * 1000;
// Page-local pseudo code: the port that carried the session is gone (never sent by the SW).
export const CODE_SESSION_ENDED = 'session_ended';
// Continuing a conversation the user pasted a link to (#1651). LINK_FAIL carries the package's own
// code; these are the ones with a sentence of their own, and anything else falls back to the
// generic line — a code the page does not know must not become a blank notice.
export const CODE_NOT_FOUND = 'not_found';
export const CODE_UNSUPPORTED = 'unsupported';
export const CODE_BAD_REQUEST = 'bad_request';
export const CODE_LINK_CONTEXT_MISSING = 'link_context_missing';
export const CODE_LINK_NEEDS_HISTORY = 'link_needs_history';
// 🔴 The ORIGIN decides which provider a pasted link belongs to — never a substring, or
// `chatgpt.com.evil.test` is ChatGPT. The SW checks again (providerForLink); this copy exists so
// the chip can appear before the message is sent, and the drift guard pins the two together.
export const LINK_ORIGINS = Object.freeze({
  'https://claude.ai': 'claude',
  'https://chatgpt.com': 'chatgpt',
  'https://chat.openai.com': 'chatgpt',
  'https://gemini.google.com': 'gemini',
});
// DONE{stalled:true} has TWO sources and one meaning — "this answer did not finish" (#1527):
// the stall watchdog below, and a cut the CLIENT reported (`DONE.cutReason`, two values: 'stalled'
// or 'stream_error', the latter = the provider failed mid-answer). Same badge, same retry, same
// history; only the sentence differs, and `cutNote()` is the one place that picks it.
// DONE{stalled:true} (#1519, bg/compare.js stall watchdog): the provider went silent after the
// answer text started, so the SW settled the column with what arrived. The page treats it as a
// normal DONE (answered, round settles, follow-up / summary allowed) and marks the turn: a muted
// marker on the badge, one line under the answer, `stalled` in the history snapshot, and the
// summary attachment is flagged partial like an ERROR-cut answer.
export const BADGE_STALLED_CLS = 'is-stalled';
// The SW's bounded cut vocabulary (bg/compare.js CUT_STREAM_ERROR). Repeated, not imported:
// this file is a classic script in the page world and the SW is an ES module — the two cannot
// share a symbol. test/compare-send-order-guard.mjs pins that the two spellings agree.
export const CUT_STREAM_ERROR = 'stream_error';
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
export const CODE_SEND_FAILED = 'send_failed';
// Provider-side rate limit shares the code name with the server's; the copy differs.
export const PROVIDER_RATE_LIMIT_KEY = 'err_rate_limited_provider';
// Provider errors that mean "the tab is gone", which the next send repairs by itself (bg/compare.js
// prepares every FOLLOWUP target with mayOpenTab:true). Such a column is retried by 「전체」 —
// whatever the `reason` (a no_tab that timed out loading or was still settling is cured by the
// resend just the same; the copy differs, the routing does not).
export const TAB_LOST_CODES = new Set(['bridge_disconnected', 'no_tab']);
// A column that ended in no_tab (whatever the reason) offers to open the provider's site next to
// the retry — the SW re-opens a tab on FOLLOWUP anyway, but a user-opened, signed-in tab is the
// surer fix (batch 2).
export const CODE_NO_TAB = 'no_tab';
// C3 (chathub batch 1): error codes whose action row is more than 「다시 보내기」 — each one names
// the next thing to do (chathub's ErrorAction pattern: one action per error).
//   auth_required / permission_refused → the remedy is a sign-in or a grant, NOT a resend: the
//   retry is hidden (a resend fails readiness again — free, but a dead end) until a status read
//   made AFTER the error says the provider is sendable again (col.gateCleared); the row offers
//   the site link (login) / the permission prompt (the SAME handler as the column gate) and
//   「다시 확인」 instead.
//   model_unavailable → 「Auto로 바꿔 다시 보내기」: the pill goes back to Auto and the column is
//   retried (costs a compare, the label says so); offered once per model choice (col.autoRetried).
//   rate_limited / overloaded → the retry stays, plus 「<Provider> 탭에서 확인」 (the openTab link,
//   relabelled) and, when the 5h gauge is full, the reset countdown on the error line.
export const CODE_AUTH_REQUIRED = 'auth_required';
export const CODE_PERMISSION_REFUSED = 'permission_refused';
export const CODE_MODEL_UNAVAILABLE = 'model_unavailable';
export const CODE_OVERLOADED = 'overloaded';
export const GATE_CODES = new Set([CODE_AUTH_REQUIRED, CODE_PERMISSION_REFUSED]);
export const PROVIDER_BUSY_CODES = new Set([CODE_RATE_LIMITED, CODE_OVERLOADED]);
// A 5h gauge at this utilisation explains a provider-side limit: the error line then carries the reset countdown.
export const USAGE_FULL_PCT = 100;
// Per-column input (chat layout, 2026-09-20 — replaces C4's 「이 열에만 묻기」 head button): a
// follow-up sent from a column's own composer reports `send.via = 'column'` (the same event name,
// one more param — the SW allowlist is untouched); the Auto retry's model_change keeps the value.
export const SEND_VIA_COLUMN = 'column';
// Timed send-path stages (bg/compare.js, package v0.3.0) the badge reads: DIAG{stage, detail.at}.
// first_chunk − send_start = time to first token; stream_done − send_start = the whole answer.
export const STAGE_SEND_START = 'send_start';
export const STAGE_FIRST_CHUNK = 'first_chunk';
export const STAGE_STREAM_DONE = 'stream_done';
export const TTFT_STAGES = new Set([STAGE_SEND_START, STAGE_FIRST_CHUNK, STAGE_STREAM_DONE]);
// DIAG stage the client reports when it starts a tool (web search) — the badge says 「웹 검색 중…」.
export const STAGE_TOOL_USE = 'tool_use';
// Activity panel (package v0.5.0, 2026-09-18): the provider's process — thinking text, tool calls,
// results, status lines — shown INSIDE the assistant turn above the answer, as a <details> that is
// open while the answer has not started and folds to a one-line summary once text streams (the
// user can reopen it). Kinds the page draws; anything else is ignored.
export const ACTIVITY_THINKING = 'thinking';
export const ACTIVITY_TOOL_USE = 'tool_use';
export const ACTIVITY_TOOL_RESULT = 'tool_result';
export const ACTIVITY_TOOL_WEB_SEARCH = 'web_search';
// Local history (2026-09-18, user request): the last HISTORY_MAX kept sessions — question, every
// column's turns and its continuation — in chrome.storage.local under HISTORY_KEY, so a session can
// be reopened later and, when its continuations survive, continued (the resume path). Incognito
// sessions are never stored (that is what incognito means here). Answers are clipped at
// HISTORY_TEXT_MAX chars per turn so one long session cannot crowd the quota.
// One storage key PER ENTRY (`compareHistory:<id>`), never one list: two compare pages writing at
// once would otherwise lose each other's entries through read-modify-write of a shared array
// (Codex hist 1R #4). Eviction and listing read every key with the prefix.
export const HISTORY_KEY_PREFIX = 'compareHistory:';
// Web Locks name every compare tab takes for a history op (see historyUpdate).
export const HISTORY_LOCK_NAME = 'ctcmp-history';
// Longest a history op waits for that lock. A holder whose storage callback never settles (a
// wedged tab) must not block every other tab forever — past this the op runs under the in-page
// chain only (degraded, logged once). Unloading a page releases its locks, so a live holder is the
// only way to wait this long.
export const HISTORY_LOCK_WAIT_MS = 8000;
export const HISTORY_MAX = 20;
export const HISTORY_TEXT_MAX = 60000;
// An entry's JSON is kept under this many UTF-8 BYTES (the quota counts bytes — a Korean answer is
// ~3 bytes per char) by clipping its answers further (Codex hist 1R #6: 20 × 3 × 60k Korean chars
// serialised past the 10 MiB storage.local quota).
export const HISTORY_ENTRY_MAX_BYTES = 200000;
// Column metadata bounds (Codex 6R #4): a continuation is a handful of short ids (the SW's own
// RESUME_* caps); anything larger is not one and is dropped (the column loads read-only).
export const CONTINUATION_MAX_KEYS = 8;
export const CONTINUATION_MAX_VALUE_CHARS = 200;
export const HISTORY_QUESTION_PREVIEW = 80;
// History search (chathub batch 1, C2): the filter runs over the cached list this long after the
// last keystroke — every stored turn text is scanned (≤ HISTORY_MAX × HISTORY_ENTRY_MAX_BYTES).
export const HISTORY_SEARCH_DEBOUNCE_MS = 150;
// Empty state (chathub batch 1, C1): example prompts shown under the question card when the page
// opened without `?q` — one i18n key per chip, `example_chip_<n>` — the BUILT-IN fallback. Since
// 2026-09-20 the SW may carry a server pool (`COMPARE_STATUS.examples = {ko:[{q, tag}], en:[…]} |
// null`, from cdn.claudetuner.com/compare-examples.json): the page then shows EXAMPLE_CHIP_COUNT
// picked at random, preferring distinct tags, re-picked on every open and after 새 대화
// (pickExamples). A pool with fewer than EXAMPLE_CHIP_COUNT usable items for the language = the
// built-in chips. A question longer than EXAMPLE_Q_MAX is cut (the SW bounds it already).
export const EXAMPLE_CHIP_COUNT = 3;
export const EXAMPLE_Q_MAX = 300;
// 「요약·비교」 (chathub batch 1, C5): every column's answer IN THE COMPARISON ROUND (the round the
// user is working on — see comparisonRound) is attached to one instruction and sent as a plain
// FOLLOWUP to ONE column — the judge — so the ordering contract
// (readiness → consume → send, AC18) and the quota (1 compare) are untouched: the page just
// composes the text. The WHOLE prompt is capped at SUMMARY_PROMPT_MAX characters — under
// HISTORY_TEXT_MAX, so the stored request keeps its instruction tail — and the attachments share
// what the fixed parts leave, evenly, at most SUMMARY_PER_COLUMN_MAX each and never under
// SUMMARY_MIN_SHARE (a longer answer is cut and marked). At least SUMMARY_MIN_COLUMNS answered,
// sendable columns before the button is worth pressing; the question's first line is quoted at
// most SUMMARY_QUESTION_MAX long. Each attachment sits between SUMMARY_FENCE_OPEN/CLOSE lines
// (evidence, not instructions — see neutraliseAttachment). Turns that belong to a summary carry
// `kind` = TURN_KIND_SUMMARY (the request renders folded, the answer wears a badge, the markdown
// export abbreviates the request, the history entry stores the kind).
export const SUMMARY_PROMPT_MAX = 48000;
export const SUMMARY_PER_COLUMN_MAX = 20000;
export const SUMMARY_MIN_SHARE = 200;
export const SUMMARY_MIN_COLUMNS = 2;
export const SUMMARY_QUESTION_MAX = 500;
export const SUMMARY_FENCE_OPEN = (n, label) => `<<<answer ${n}: ${label}>>>`;
export const SUMMARY_FENCE_CLOSE = (n) => `<<<end answer ${n}>>>`;
// Metadata bounds (Codex 4R #3): a model label longer than this is cut before it reaches a fence
// line — the budget below counts labels as fixed text, and an unbounded one could eat it whole.
export const SUMMARY_MODEL_LABEL_MAX = 64;
export const TURN_KIND_SUMMARY = 'summary';
export const BADGE_SEARCHING = 'col_searching';
// A duration above this is not a measurement (a clock jump, an absurd timestamp) — no number.
export const TTFT_MAX_MS = 60 * 60 * 1000;
// Waiting-time badge: the badge key of the "after CONSUME_OK, before the first CHUNK" state, how
// often its seconds are repainted, and how long a wait must be before a number is worth showing.
export const BADGE_WAITING = 'col_waiting';
// The column's files are going up (#1616 ④ / #1617 진행 표시). Its own state rather than a
// variant of BADGE_WAITING because the two differ in what the user can conclude: waiting is the
// model thinking, uploading is bytes moving — and with files attached the columns genuinely
// diverge (measured 2026-09-24: Claude 2.6 s, ChatGPT 3.4 s, Gemini 8.9 s to first token, one
// image each). Nine silent seconds read as a hang; naming the phase does not. Shares the waiting
// clock, so it also gets the elapsed seconds once the wait is worth a number.
export const BADGE_UPLOADING = 'col_uploading';
// The package's per-file diag (`{index, name, type, bytes, ms}`) — one per attachment, when its
// bytes have landed. Already forwarded as DIAG by the SW; the page counts them to know when a
// column's LAST file is up (#1634: a round carries up to five).
export const STAGE_ATTACHMENT_UPLOADED = 'attachment_uploaded';
export const WAIT_TICK_MS = 1000;
export const WAIT_ELAPSED_SHOW_MS = 3000;
export const MS_PER_SECOND = 1000;
// ERROR also carries the client's machine-readable `reason` (package v0.2.3; today only no_tab has
// one) and `detail` (the raw package message). Copy is looked up as err_<code>_<reason> when such a
// key exists, else err_<code>; the raw cause goes into the error line's `title` so hovering shows
// what the client actually said (the SW console has the same line — bg/compare.js LOG_TAG).
export const ERROR_TITLE_MAX = 300;
// Theme values the web shell may post as `{__ctTheme}` (site/multiai/multiai.js) — anything else is ignored.
export const EMBED_THEME_LIGHT = 'light';
export const EMBED_THEME_DARK = 'dark';
// ── Attachments the composer may carry (#1617, page side of the #1616 wire) ────────────────────
// 🔴 A MIRROR of bg/compare.js's SEND_MAX_ATTACHMENTS / SEND_MAX_ATTACHMENT_BYTES /
// SEND_ATTACHMENT_TYPES, and of which PROVIDER_SITES entries have `uploads`. Not an import: the SW
// module is 2,500 lines with no bundler between us, so importing it for four values would ship the
// whole worker to the page. The copy is pinned to the original by the drift check in
// test/compare-page-flow-guard.mjs — change one side and that guard fails.
//
// The page repeats the bounds so a file that cannot work is refused where refusing is FREE: in the
// composer, with a line saying why, before a port message exists. The SW's own copy stays the
// authority (a page can be stale, or wrong); this one only spares the user a round trip to learn
// what the chip could have told them.
// 🔴 Mirrors the SW's SEND_MAX_ATTACHMENTS / _TOTAL_BYTES (#1634). The COUNT is a UI comfort; the
// TOTAL is the bound that actually protects the worker, and it is unchanged from when the count
// was one — five 2 MB screenshots cost exactly what one 10 MB image did.
export const ATTACH_MAX_FILES = 5;
export const ATTACH_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
// RAW bytes, not the base64 length — what `File.size` reports.
// 🪤 LINE comments here and below, never a JSDoc block: the provider origins above end in a slash
// plus a star, which test/lib/forbidden-scan.mjs reads as the start of a block comment. It then
// runs to the next block-comment CLOSE in the file, so adding one further down moves that close
// past the CODE_* constants and eats them (caught by test:compare-i18n's wire-code lift,
// 2026-09-24). Writing the two characters anywhere below — even inside a line comment describing
// this trap — is enough to trip it.
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACH_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// Providers with an upload path. The others cannot be asked with a file and are said so BEFORE the send.
export const ATTACH_PROVIDERS = Object.freeze(['claude', 'chatgpt', 'gemini']);
// Why a file was refused — the suffix of the `attach_err_<reason>` copy.
export const ATTACH_ERR_TYPE = 'type';
export const ATTACH_ERR_SIZE = 'size';
export const ATTACH_ERR_READ = 'read';
export const ATTACH_ERR_COUNT = 'count';
export const ATTACH_ERR_TOTAL = 'total';

// Seeing the images again (2026-09-26, user request: 「히스토리를 봐도 어떤 이미지를 올렸는지 알 수가
// 없다」). A turn that carried images keeps their IDs; the pictures themselves live in IndexedDB
// (ui/compare/image-store.js) — never in the history entry, which is byte-capped at
// HISTORY_ENTRY_MAX_BYTES and would lose its text to them, and never in storage.local, whose
// 10 MB quota (no unlimitedStorage) twenty sessions of photos would fill.
// What is kept is a PREVIEW, not the original: long edge ≤ IMAGE_PREVIEW_MAX_EDGE, re-encoded —
// enough to recognise and read the image, a fraction of a 10 MB upload.
export const IMAGE_DB_NAME = 'ctcmp-images';
export const IMAGE_DB_VERSION = 1;
export const IMAGE_STORE = 'previews';
export const IMAGE_SESSION_INDEX = 'session';
export const IMAGE_PREVIEW_MAX_EDGE = 1600;
export const IMAGE_PREVIEW_TYPE = 'image/webp';
export const IMAGE_PREVIEW_QUALITY = 0.85;
// An image id: what the page mints (crypto.randomUUID-shaped) — anything else read back from a
// history entry is dropped, never looked up.
export const IMAGE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
// Stored previews whose session is in no history entry are removed — but only once they are this
// old: a session that has not reached its first history write yet (this tab's, or another compare
// tab's) owns previews no entry names so far.
export const IMAGE_ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;
// Images IN THE ANSWER (#1684 — ChatGPT's image_gen, Gemini's Imagen): kept exactly like the
// question's images above (ids on the turn, previews in the same store, persisted only with the
// history write). Two things are theirs alone:
// – the ORIGINAL bytes are held for this page's lifetime so 「저장」 hands over the picture the
//   provider made, not the re-encoded preview — bounded by OUT_IMAGE_ORIGINALS_MAX_BYTES, oldest
//   dropped first (its download falls back to the preview, and says so);
// – a preview still decoding at the round's history write (an image lands right before its DONE;
//   persist() only writes previews that exist and never waits inside the lock) is written on its
//   own once it exists — for as long as OUT_IMAGE_PERSIST_WAIT_MS; the write itself never waits.
export const OUT_IMAGE_ORIGINALS_MAX_BYTES = 64 * 1024 * 1024;
export const OUT_IMAGE_PERSIST_WAIT_MS = 30 * 1000;
// The download's file name: `<provider>-image-<n>.<ext>`.
export const OUT_IMAGE_EXT = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' });
// The file name a TURN keeps (#1616 ④ history marker), clipped. 🔴 A MARKER, NEVER THE IMAGE:
// a history entry is capped at HISTORY_ENTRY_MAX_BYTES and shrunk by evicting whole rounds, and
// `fitEntry` has no idea how to shrink a picture — a few data-URL thumbnails would push real
// answers out of the entry to make room for decoration. What a returning user needs is «this
// question had an image called X», which is two short fields.
export const HISTORY_ATTACH_NAME_MAX = 64;

// ── feedback / report (Tally) ──
// ONE inquiry form is shared by every Claude Tuner surface (popup header, the composer strips, the
// site footer, the ad label) — reusing it keeps the replies in one inbox instead of splitting them
// per feature. `source` names the surface that opened it.
export const FEEDBACK_URL = 'https://tally.so/r/q4dyQk';
export const FEEDBACK_SOURCE = 'compare';
// 🔴 `error_report` IS THE FORM'S EXISTING HIDDEN CONTEXT FIELD, and a Tally prefill param that
// names no field of the form is silently dropped. The dashboard's error reporter already fills it
// (site/dashboard/error-report.js), and POST /api/webhooks/tally appends it to the inquiry body —
// so this is the one channel where prefilled context actually reaches D1 / Telegram. Renaming it
// means adding the new field in Tally FIRST.
export const FEEDBACK_CONTEXT_FIELD = 'error_report';
// The context block is bounded: Tally takes the prefill through the query string, and the webhook
// slices each field at 5000 chars anyway. 1200 fits every line below with room to spare.
export const FEEDBACK_CONTEXT_MAX = 1200;
// 🔴 VALUES THAT ARE NOT OURS ARE VALIDATED AND OMITTED, NEVER TRUNCATED (Codex 1R 배포차단 1,
// 2R). Two of the block's values come from outside: a column's model id is the PROVIDER's string
// (test/compare-send-order-guard.mjs treats it as the one untrusted string on this page) and the
// UA is the browser's. Measured: prose and an attachment's contents smuggled into a model id
// reached D1 and a Telegram alert verbatim.
//
// 🔑 THIS REPO ALREADY DECIDED HOW TO DO THIS, one sink earlier — bg/compare.js MODEL_ID_RE, for
// the same ids going to GA4: «A non-matching id is OMITTED, never truncated (A CUT STRING IS
// STILL THAT TEXT)». The first fix here cut instead, which is the thing that comment forbids. So
// the rule is the same one, applied to the same kind of value: match the shape or say `other`.
export const FEEDBACK_MODEL_UNKNOWN = 'other';
// What a built column entry must look like by the time it becomes a line. 🔴 feedbackColumn()
// produces this, but feedbackContext() re-checks it rather than trusting its caller: when the
// first fix moved validation OUT to the caller, the block itself went defenceless and a raw
// `'x\ny'` forged a context line — caught by the guard, not by review.
export const FEEDBACK_COLUMN_RE = /^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A UA that is not shaped like one is not a UA — same rule, no cutting. A real Chrome UA is ~130
// characters; the cap is what a HEADER is worth, not a budget to fill with something else.
export const FEEDBACK_UA_RE = /^[A-Za-z0-9 ._:;,()/-]{1,180}$/;
export const FEEDBACK_VERSION_RE = /^[0-9]+(\.[0-9]+){0,3}$/;
