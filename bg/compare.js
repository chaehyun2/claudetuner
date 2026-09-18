// Multi-AI compare (#1452, parent #1449) — service-worker side.
//
// The compare page (compare.html) asks one question of several providers using the user's OWN
// web sessions, via the vendored clients in ../vendor-ai/ (chaehyun2/ai-web-clients). This module
// owns everything the page cannot do itself: the dark-launch flag, the status probe, opening the
// page from a provider tab, and the streaming session over a runtime Port.
//
// 🔴 ORDERING (AC18). One send = one server-side quota unit, debited BEFORE the providers are
// asked and never refunded. So the order inside runSend() is the contract, not an implementation
// detail: (a) every target proves it is ready (signed in; a tab exists unless we may open one),
// (b) ONLY THEN `POST /api/compare/consume`, (c) ONLY on 200 does any `sendMessage` go out. If no
// target is ready nothing is consumed; if consume is not 200 nothing is sent.
// test/compare-send-order-guard.mjs runs this file under Node with stubs and pins exactly that.
//
// 🔴 NO `chrome.*` IN THIS FILE. Every browser API arrives through createCompareController(deps)
// so the guard can drive it with fakes; background.js passes the real namespaces. Same rule the
// vendored package follows (README "deps contract") — and the reason this module has no static
// import of bg/storage.js & co., which read `chrome` at call time but would drag the SW module
// graph into a Node process.
//
// Wire contract (see .omc/handoffs/phase3-contract.md — the SoT shared with the page; ux3 addendum
// at its end):
//   runtime.sendMessage   COMPARE_FLAG → {on, cta}   COMPARE_STATUS → {ok, flagOn, loggedIn, providers{[p]: {permitted,
//                         loggedIn, plan}}, quota, quotaError, models, modelsSource, modelsPending, selectedModels,
//                         saveHistory}   OPEN_COMPARE{src, q} → {ok}   COMPARE_EVENT{name, params} → {ok}
//   Port 'ctcmp-compare'  page→SW  SEND{text, targets, mayOpenTab, models?, modelsPending?, saveHistory?, resume?} ·
//                         FOLLOWUP{text, targets, models?, modelsPending?} · ABORT
//                         SW→page  CONSUME_OK · CONSUME_FAIL · MODEL · CHUNK · DONE{…, continuation?} · ERROR · ALL_DONE · DIAG · MODELS · ACTIVITY
//   Tabs: SEND and FOLLOWUP both prepare every target with `mayOpenTab: true` — a provider tab the
//   session opened and the user closed is re-opened on the next send. Tabs we open are pinned and
//   KEPT across sessions (CLIENT_OPTIONS): the next session finds them with tabs.query.
//
// Models (addendum 2026-09-14, package v0.2.0): `models[p]` in COMPARE_STATUS is the picker list for
// every provider that is permitted AND signed in (`client.listModels()`, LIST_MODELS_TIMEOUT_MS cap,
// static list on timeout/failure); `selectedModels[p]` is the persisted choice (chrome.storage.sync
// `compareModels`, id|null, null = the provider's Auto/default). SEND/FOLLOWUP `models` overrides
// storage for that send and is persisted. The model a send runs on is ALWAYS storage overlaid with the
// message — never the client's own memory — so what the page shows selected is what goes out.
//
// Diagnostics (2026-09-14, package v0.2.3, live no_tab on a first send): every ERROR carries the
// client's `reason` (no_tab: load_timeout · changed_during_verify · closed_while_loading ·
// not_found · open_not_allowed) and `detail` (the package's own message), the clients' readiness
// `diag` events are forwarded as DIAG{provider, stage, detail} (the page may ignore them), and
// every readiness stage and every ERROR is `console.info('[compare]', …)`-ed so the SW console
// tells the story of a failed send without a debugger attached. The picker path is logged the same
// way (package v0.2.4, `models_listed {source, count}`): ChatGPT's list is built from the site's
// `categories[]` when present (one entry per user-facing model), else `models[]` deduplicated.
//
// Catalog refresh (2026-09-17, #1452, user-visible): the ChatGPT picker is the site's list only when
// a chatgpt.com tab is OPEN — `listModels()` never opens or reloads one (package v0.2.7) — so a
// compare.html opened with no such tab shows the static "GPT-5.5" and, before this, never asked
// again after the first send had created the pinned tab. Now COMPARE_STATUS says where each list
// came from (`modelsSource[p]` = the package's `models_listed` diag: `categories` | `models` |
// `static`, or `none` when even the static list was empty) and which providers the SW will retry
// (`modelsPending` = providers with a live catalog — PROVIDER_SITES `liveCatalog` — whose list was
// static/none). The PAGE says what it still holds as pending on every SEND/FOLLOWUP
// (`modelsPending`, what its status/last MODELS told it — Codex ext 1R #1: the SW's own memory
// would be worker-wide, not this page's, and would go stale when a later status turned static).
// After that send's CONSUME_OK (the tabs exist now) and again on ALL_DONE while any is still
// pending, the SW re-runs `providerModels` for those providers only, OFF the send path (not
// awaited; LIST_MODELS_TIMEOUT_MS cap; one refresh at a time, a retry asked for meanwhile runs
// after it) and posts MODELS{models, modelsSource, modelsPending} with the refreshed providers —
// the page then updates what it holds. Nothing is posted when nothing was pending. Claude/Gemini
// are static by design (`liveCatalog: false`): never pending, whatever the page says.
//
// History + web search (2026-09-17, package v0.3.1, multiai-ux items 2/3): the vendored clients
// gained two options. `saveHistory` (all three providers, package default false) keeps the
// session's conversations in the user's OWN provider history instead of temporary/hidden ones
// (AC23 stays the default) — Claude: a normal conversation titled from the first prompt (or
// `Claude Tuner` for one pre-created in prepare()), the user's from its first answer on (an
// unanswered one is still deleted at cleanup); Gemini: `temporary: false`; ChatGPT: no hide, no
// backlog. `webSearch` (Claude only, package default true) sends claude.ai's own web-search tool
// so Claude is not the one column answering from memory while Gemini grounds and ChatGPT searches;
// the SW passes it explicitly for Claude and never to the other two (they ignore the key, but the
// wire must not depend on that). The user's preference lives in chrome.storage.sync — since ux3
// as `compareIncognito` (COMPARE_INCOGNITO_KEY, true = temporary; default = kept, see the ux3
// note above; before ux3 it was `compareSaveHistory`, default false) — read ONCE per worker life
// with the same bounded read as `compareModels` (a hung/failed read = the default, nothing
// written) and answered in COMPARE_STATUS as `saveHistory`. A SEND may carry `saveHistory` (boolean): it is
// persisted and used for THIS session. 🔴 The session's flag is FIXED at its first SEND — the
// clients are created then (readiness) and the option is a constructor option — so a later SEND
// on the same port persists the new value but does not change the running session's clients
// (a SEND that constructed no client — no targets, readiness failed before any client, consume
// refused — fixed nothing, and the next SEND's field wins), and a FOLLOWUP's `saveHistory` field
// is ignored altogether. The throwaway `providerModels` client
// (status pickers) is always saveHistory:false — it sends nothing. The package's `tool_use` diag
// (`{type:'diag', stage:'tool_use', detail:{type, name}}`, Claude calling web_search) reaches the
// page as DIAG through the existing forwarder and is logged like every other stage.
//
// UX batch 3 (2026-09-17, package v0.4.0, .omc/handoffs/ux3-contract.md A/D/E — the SW half):
//   A. `providers[p].plan` in COMPARE_STATUS: a display-ready plan label reusing what the
//      collectors wrote to chrome.storage.local `collectedOrgs` (`planLabels`); null when nothing
//      was collected or the read failed. background.js injects `readCollectedOrgs` + `planLabel`.
//   D. The history default flipped to KEPT: storage key COMPARE_INCOGNITO_KEY (true = temporary),
//      the wire unchanged (`saveHistory` = !incognito), the old `compareSaveHistory` ignored.
//      Resume after a lost port: a SEND may carry `resume: { [p]: continuation }` (what an
//      earlier DONE's `continuation` said, package `getContinuation()`); the clients THIS send
//      constructs get it as the package's `continuation` option, for a kept session only, and
//      everything else — readiness → consume → fan-out — is the plain SEND path (the guard pins
//      that resume bypasses nothing). DONE carries `continuation` when the session is kept and
//      the client hands one out; omitted otherwise.
//   E. Usage analytics: COMPARE_EVENT{name, params} from the page → sanitizeCompareEvent
//      (COMPARE_EVENT_NAMES allowlist, flat ≤ 20 string/number/boolean params, keys [a-z_]{1,40},
//      strings cut at 100) → the injected `sendGAEvent('cmp_' + name, params)`; the SW adds its
//      own `consume{ok, status, targets_n}` from runSend. Never a question, never an email.
//
// Time-to-first-token (2026-09-17, package v0.3.0, #1452): Claude's first token trailed the others
// visibly. The clients now report the send path as TIMED diag events (`detail.at`): send_start →
// org_resolved (Claude) → tab_ready → conversation_created (Claude) → bridge_connected →
// request_sent → first_chunk → stream_done. They are forwarded as DIAG like every other stage, and
// on `first_chunk` and `stream_done` one line `[compare] <provider> ttft {ms, segments}` is logged
// (`ttftSegments`): `ms` = first_chunk − send_start, each segment = that stage minus the stage
// BEFORE it that was reported (null when the stage is absent — Gemini/ChatGPT have no org/create;
// an older resident page script posts no `request_sent`). Claude's create round trip is taken
// off the send path by the package: `prepare()` pre-creates the conversation right after
// verification, in the background, on the model the send will use — which is why `readiness`
// passes `model` to `prepare()` — and the send's `create` segment then reads ~0
// (`conversation_created {source:'precreated'}`).

export const COMPARE_PORT_NAME = 'ctcmp-compare';
export const COMPARE_PAGE = 'compare.html';
export const COMPARE_PROVIDERS = Object.freeze(['claude', 'gemini', 'chatgpt']);

// Per-provider answer budget (AC19). A provider that has not finished by then gets ERROR{timeout};
// the others keep streaming. 🔴 2026-09-18 live: 120 s cut off every column of a three-part travel
// question on thinking models (Opus 5 · Gemini 3.6 Thinking · ChatGPT 5.6 Sol Thinking) — one
// column mid-answer, the others still thinking (thinking deltas are not forwarded as events, so an
// idle timeout would fire in the same silence). The budget is now 10 minutes; Stop remains the way
// to end a round early, and the page tells the user the budget it hit (ERROR.budgetMs).
export const PROVIDER_SEND_TIMEOUT_MS = 10 * 60 * 1000;

// Bound on each provider's `listModels()` inside COMPARE_STATUS. The package caps its own ChatGPT
// round trip at the same value; this one is the SW's, so the status probe never waits on a client's
// promise it does not own. On expiry the provider's STATIC list is answered.
export const LIST_MODELS_TIMEOUT_MS = 5000;

// chrome.storage.sync key: { [provider]: string|null } — the model the user picked per provider.
// Missing provider = null = the provider's Auto/default (see the package README "Models").
export const COMPARE_MODELS_KEY = 'compareModels';
// chrome.storage.sync key: boolean — the user's 「시크릿 대화」 opt-in (ux3, item 6): `true` = compare
// conversations are temporary/hidden (the pre-ux3 AC23 behaviour), anything else = KEPT in the
// user's own provider history (package `saveHistory: true`), which is now the default. The wire
// still speaks `saveHistory` (= !incognito) — the page and the package never see this key. The
// pre-ux3 key `compareSaveHistory` is ignored: dark launch, no migration (its default was the
// opposite, so carrying it over would keep old installs on the old default silently).
export const COMPARE_INCOGNITO_KEY = 'compareIncognito';
// Size caps on a SEND's `resume` map (ux3 item 6): a continuation is what the package handed out
// (a handful of id strings), so anything larger is not one. Per provider: at most this many
// keys, each a string of at most this many characters.
export const RESUME_MAX_KEYS = 8;
export const RESUME_MAX_VALUE_CHARS = 200;
// Usage analytics (ux3 item 8): what the page may report through COMPARE_EVENT, forwarded to the
// extension's GA4 property as `cmp_<name>`. An allowlist, not a pattern — a name is a product
// decision, and the page/mock share this list. `consume` is the SW's own (runSend), listed so
// one validator serves both.
export const COMPARE_EVENT_NAMES = Object.freeze([
  'open', 'send', 'column_done', 'column_error', 'round_done', 'consume_fail', 'copy', 'stop', 'new_chat',
  'model_change', 'target_change', 'provider_link_click', 'gate_shown', 'permission_result', 'session_lost',
  'incognito_toggle', 'quota_exhausted', 'jump_to_latest', 'consume',
]);
export const COMPARE_EVENT_PREFIX = 'cmp_';
// Params: a FLAT object of at most this many string/number/boolean values, keys `[a-z_]{1,40}`,
// strings cut at this many characters. Never a question, never an email — the page does not send
// them and the SW would not know one from a label, so the caps are the whole defence here.
export const COMPARE_EVENT_MAX_PARAMS = 20;
export const COMPARE_EVENT_MAX_STRING = 100;
const COMPARE_EVENT_KEY_RE = /^[a-z_]{1,40}$/;
// Bound on the one storage.sync read of that key. A read that hangs must not hang a send (Stop
// could never end it and every later send would answer `busy`); past this it counts as "no
// baseline" — the send proceeds on what it was told, nothing is written (see loadSelectedModels).
export const SELECTED_MODELS_READ_TIMEOUT_MS = 2000;

// Dark-launch flag — same static CDN file and 1h TTL cache as the folders feature
// (claude-folders.js FLAGS_URL / FOLDERS_FLAG_TTL_MS), read here once for every surface that asks.
export const FLAGS_URL = 'https://cdn.claudetuner.com/flags.json';
export const COMPARE_FLAG_FIELD = 'compare';
// Second field, same file: the in-page CTA (the composer-strip button on claude.ai / gemini /
// chatgpt.com) shows only when BOTH `compare` and `compare_cta` are true — so the page itself
// (compare.html, the claudetuner.com/multiai shell) can be live while the button stays hidden
// (2026-09-18: launch the site entry first, the in-page button later). Missing = false.
export const COMPARE_CTA_FLAG_FIELD = 'compare_cta';
export const COMPARE_FLAG_CACHE_KEY = 'ct_compare_flag';
export const COMPARE_FLAG_TTL_MS = 60 * 60 * 1000;

// Options every vendored client gets (package v0.2.1). `tabCreateProps` is merged into the ONE
// `tabs.create` the client may perform (only under `mayOpenTab: true`): our background tab is
// PINNED, so it is a small icon rather than a full tab in the strip. Tabs the user already had
// open are found first (`tabs.query`) and never touched. `closeOwnedTabsOnDispose` is left at
// its default (false): the tab we open stays open across sessions and the next one rides it —
// dowoo's lifecycle, no re-open/re-verify churn per compare.
export const CLIENT_OPTIONS = Object.freeze({ tabCreateProps: Object.freeze({ pinned: true }) });

// ── Chrome crash mitigation levers (2026-09-16, cause UNCONFIRMED) ─────────────────────────────
// The user's Chrome (browser process, CrBrowserMain) crashed three times on an identical CHECK
// frame, the latest 31 s after wake-from-sleep with no user action. Top suspect: service-worker
// restart → the startup hide drain (`drainPendingHides`) → relay injection / `tabs.connect` into a
// pinned chatgpt.com tab Chrome DISCARDED during sleep. Package v0.2.5 skips discarded tabs
// outright; on top of that the SW (a) delays the drain past the wake-up churn and (b) offers two
// chrome.storage.local kill switches so the two suspects can be attributed one at a time on the
// affected machine (set with `chrome.storage.local.set({ctcmp_drain_disabled: true})` from the SW
// console — see docs/EXTENSION.md). Both are read once, at controller construction (= SW start).
// The startup drain runs this long after the worker starts — past the burst of tab restores /
// discards that follows wake-from-sleep, so a still-discarded tab is skipped rather than raced.
export const DRAIN_STARTUP_DELAY_MS = 30 * 1000;
// `true` → the startup drain never runs in this worker life (ids stay in the durable backlog).
export const DRAIN_DISABLED_KEY = 'ctcmp_drain_disabled';
// `true` → the provider tabs we open are NOT pinned (a pinned tab is discarded/restored
// differently by Chrome, and is the second suspect).
export const PIN_DISABLED_KEY = 'ctcmp_pin_disabled';
// Both are sampled once at construction, bounded by SELECTED_MODELS_READ_TIMEOUT_MS (a hung
// storage commits the defaults: pinned, drain on); a late answer never changes the sample.
// A third provider is a row here, not a code path (contract: "write the SW so a third provider
// is a config entry"). `optionalHost` rows need chrome.permissions granted from a user gesture in
// the compare page before anything here can see their tabs or cookies.
// `liveCatalog`: the package asks the SITE for this provider's picker (through an open tab), so a
// static answer is a fallback worth retrying once a tab exists; false = the static catalog IS the
// catalog (never refreshed, never "pending").
export const PROVIDER_SITES = Object.freeze({
  claude: { origin: 'https://claude.ai', relayFile: 'vendor-ai/bridge/claude-relay.js', optionalHost: false, liveCatalog: false },
  gemini: { origin: 'https://gemini.google.com', relayFile: 'vendor-ai/bridge/gemini-relay.js', optionalHost: true, liveCatalog: false },
  chatgpt: { origin: 'https://chatgpt.com', relayFile: 'vendor-ai/bridge/chatgpt-relay.js', optionalHost: true, liveCatalog: true },
});

// Where a provider's picker list came from (COMPARE_STATUS `modelsSource[p]`, MODELS): the package's
// `models_listed` diag sources, plus `none` for an empty list.
export const MODELS_SOURCE = Object.freeze({ CATEGORIES: 'categories', MODELS: 'models', STATIC: 'static', NONE: 'none' });
const LIVE_SOURCES = new Set([MODELS_SOURCE.CATEGORIES, MODELS_SOURCE.MODELS]);
/** A provider whose list should be asked for again once a tab exists. */
function catalogPending(provider, source) {
  return PROVIDER_SITES[provider].liveCatalog === true && !LIVE_SOURCES.has(source);
}

// Port message types, both directions.
export const PORT_MSG = Object.freeze({
  SEND: 'SEND', FOLLOWUP: 'FOLLOWUP', ABORT: 'ABORT',
  CONSUME_OK: 'CONSUME_OK', CONSUME_FAIL: 'CONSUME_FAIL',
  MODEL: 'MODEL', CHUNK: 'CHUNK', DONE: 'DONE', ERROR: 'ERROR', ALL_DONE: 'ALL_DONE', DIAG: 'DIAG', MODELS: 'MODELS', ACTIVITY: 'ACTIVITY',
});
// Activity (package v0.5.0, 2026-09-18): the provider's PROCESS while it works — thinking text,
// tool calls (web search + query), tool results, status sentences — forwarded to the page as
// ACTIVITY{provider, kind, id, text, name?, count?, final} so the column can show what claude.ai
// itself shows (「웹 검색됨」, the thinking summary) instead of a bare 「응답 대기 중」 for minutes.
// Bounded here: kinds allowlisted, ids/names/text length-capped, count a finite integer.
export const ACTIVITY_KINDS = Object.freeze(['thinking', 'tool_use', 'tool_result', 'status']);
// = the package sink's per-block thinking cap (activity.js): a single delta can be that long.
export const ACTIVITY_TEXT_MAX = 8000;
export const ACTIVITY_FIELD_MAX = 120;

// Prefix of every SW-console line this module writes (readiness stages, errors).
export const LOG_TAG = '[compare]';
// Best-effort: a console that is missing or throws must never cost a send its ERROR/ALL_DONE
// (Codex ext 1R #2 — `postError` runs outside the client's listener protection).
function logInfo(...args) {
  try { console.info(LOG_TAG, ...args); } catch { /* logging is not the send */ }
}

// Codes this module produces itself (the vendored ClientError codes pass through unchanged).
export const SW_CODES = Object.freeze({
  AUTH_REQUIRED: 'auth_required',   // readiness: no provider session (or no host permission to see one)
  NO_TAB: 'no_tab',                 // readiness: prepare() found no provider tab (and could not open one)
  NO_TARGETS: 'no_targets',         // CONSUME_FAIL status 0: nothing was ready, nothing consumed
  BUSY: 'busy',                     // CONSUME_FAIL status 0: a send is still in flight on this port
  NETWORK_ERROR: 'network_error',   // CONSUME_FAIL status 0: consume never reached the server
  TIMEOUT: 'timeout',               // per-provider budget exhausted
  ABORTED: 'aborted',
  UNKNOWN: 'unknown',
});

// The one status that releases a send (contract: "after POST /api/compare/consume returned 200").
const CONSUME_OK_STATUS = 200;

const abortedError = (message) => Object.assign(new Error(message), { name: 'AbortError', code: SW_CODES.ABORTED });

const uniqueKnownProviders = (list) =>
  [...new Set(Array.isArray(list) ? list : [])].filter((p) => Object.hasOwn(PROVIDER_SITES, p));

// A `{ [provider]: id|null }` map from untrusted input (a page message or storage): known providers
// only, a non-empty string or null per entry, anything else dropped. Never throws.
function sanitizeModelMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const p of COMPARE_PROVIDERS) {
    if (!Object.hasOwn(raw, p)) continue;
    const v = raw[p];
    if (v === null) out[p] = null;
    else if (typeof v === 'string' && v.trim()) out[p] = v.trim();
  }
  return out;
}

// A SEND's `resume` map (`{ [provider]: continuation }`) from untrusted input: known providers
// only (own properties), each a plain object (no arrays) of at most RESUME_MAX_KEYS string values
// (≤ RESUME_MAX_VALUE_CHARS each; null/other values and unknown keys dropped), one that keeps no
// key dropped altogether. The package validates the SHAPE it needs (README "Resume") — this only
// bounds what reaches it. Input is what a port delivered (structured-clone data: no getters, no
// prototypes of note); never throws on such input.
export function sanitizeResumeMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const p of COMPARE_PROVIDERS) {
    if (!Object.hasOwn(raw, p)) continue; // own entries only (Codex ux3 SW 1R #3)
    const c = raw[p];
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const keys = Object.keys(c);
    if (keys.length > RESUME_MAX_KEYS) continue;
    const clean = {};
    for (const k of keys) {
      const v = c[k];
      if (typeof v === 'string' && v.length <= RESUME_MAX_VALUE_CHARS && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k)) clean[k] = v;
    }
    if (Object.keys(clean).length) out[p] = clean;
  }
  return out;
}

// A COMPARE_EVENT's `{ name, params }` from untrusted input → `{ name, params }` for the GA
// sender, or null when it must be dropped: a name outside COMPARE_EVENT_NAMES, params that are
// not a plain object (absent = `{}`), or more than COMPARE_EVENT_MAX_PARAMS entries. Inside the
// cap, an entry with a bad key or a non-string/number/boolean value is dropped on its own;
// strings are cut at COMPARE_EVENT_MAX_STRING. Never throws.
export function sanitizeCompareEvent(name, params) {
  if (typeof name !== 'string' || !COMPARE_EVENT_NAMES.includes(name)) return null;
  if (params === undefined || params === null) params = {};
  if (typeof params !== 'object' || Array.isArray(params)) return null;
  const keys = Object.keys(params);
  if (keys.length > COMPARE_EVENT_MAX_PARAMS) return null;
  const clean = {};
  for (const k of keys) {
    if (!COMPARE_EVENT_KEY_RE.test(k)) continue;
    const v = params[k];
    if (typeof v === 'string') clean[k] = v.slice(0, COMPARE_EVENT_MAX_STRING);
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') clean[k] = v;
  }
  return { name: COMPARE_EVENT_PREFIX + name, params: clean };
}

// What an ERROR tells the page beyond `code`: the client's machine-readable `reason` (a no_tab's
// cause, package v0.2.3) and its developer-facing message as `detail`. Absent fields are omitted,
// not sent as null, so the page's `msg.reason` reads undefined either way.
function errorExtras(e) {
  const out = {};
  if (typeof e?.reason === 'string' && e.reason) out.reason = e.reason;
  const detail = typeof e?.message === 'string' ? e.message : (e == null ? '' : String(e));
  if (detail) out.detail = detail;
  return out;
}

// An `activity` event (package v0.5.0) in the shape the page renders, or null when its kind is
// unknown / its fields are garbage. Text is cut, never parsed — the page renders it as text.
function activityForPage(ev) {
  if (!ev || typeof ev !== 'object' || !ACTIVITY_KINDS.includes(ev.kind)) return null;
  const cut = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const id = typeof ev.id === 'number' && Number.isFinite(ev.id) ? String(ev.id) : cut(ev.id, ACTIVITY_FIELD_MAX);
  const out = { kind: ev.kind, id: id || '0', text: cut(ev.text, ACTIVITY_TEXT_MAX), final: ev.final === true };
  const name = cut(ev.name, ACTIVITY_FIELD_MAX);
  if (name) out.name = name;
  if (typeof ev.count === 'number' && Number.isFinite(ev.count) && ev.count >= 0) out.count = Math.floor(ev.count);
  return out;
}

// The `model` object a client reports, in the shape the page renders: `{ id, label, source }`.
function modelForPage(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    id: typeof m.id === 'string' ? m.id : null,
    label: typeof m.label === 'string' ? m.label : null,
    source: m.source === 'reported' ? 'reported' : 'requested',
  };
}

// The timed send-path stages (package v0.3.0), in order, and the segment name each one closes.
export const TTFT_STAGES = Object.freeze([
  ['send_start', null], ['org_resolved', 'org'], ['tab_ready', 'tab'], ['conversation_created', 'create'],
  ['bridge_connected', 'bridge'], ['request_sent', 'request'], ['first_chunk', 'first'],
]);
// `stages` = { stageName: at }. Each segment is its stage's `at` minus the `at` of the PREVIOUS
// stage that was reported — so a missing stage (Gemini/ChatGPT have no org/create; an older page
// script posts no request_sent) is null and the next segment spans the gap instead. `ms` is
// first_chunk − send_start; `total` (when `stream_done` is present) is stream_done − send_start.
export function ttftSegments(stages) {
  const at = (name) => (typeof stages?.[name] === 'number' ? stages[name] : null);
  const segments = {};
  let prev = at('send_start');
  for (const [stage, segment] of TTFT_STAGES) {
    const t = at(stage);
    if (segment) segments[segment] = t != null && prev != null ? t - prev : null;
    if (t != null) prev = t;
  }
  const start = at('send_start');
  const first = at('first_chunk');
  const done = at('stream_done');
  return {
    ms: start != null && first != null ? first - start : null,
    total: start != null && done != null ? done - start : null,
    segments,
  };
}

// `promise`, or `fallback` once `ms` have passed — whichever first. The timer is cleared either way
// so a fast answer leaves nothing armed.
function withTimeout(promise, ms, fallback) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Build the controller. Every dependency is injected (see the header).
 *
 * @param {object} deps
 * @param {Function} deps.createClient — vendor-ai `createClient(provider, deps, options)`
 * @param {Function} deps.listModels — vendor-ai `listModels(provider)` → the STATIC catalog (the fallback
 *   when a client's `listModels()` fails or exceeds LIST_MODELS_TIMEOUT_MS)
 * @param {Function} deps.authedFetch — bg/storage.js `authedFetch(config, url, options)` (ext_token; its
 *   401 `ext_token_invalid` handling is untouched — this module only reads the response)
 * @param {Function} deps.getConfig — bg/storage.js `getConfig()` → `{ serverUrl }`
 * @param {Function} deps.getExtToken — bg/storage.js `getExtToken()` → string|null
 * @param {Function} deps.hasProviderPermission — bg/providers.js
 * @param {{claude: Function, gemini: Function, chatgpt: Function}} deps.loginChecks — read-only,
 *   tab-free login probes (bg/providers.js hasClaudeSession, bg/api-gemini.js isGeminiLoggedIn,
 *   bg/api-chatgpt.js isChatGPTLoggedIn)
 * @param {object} deps.tabs, deps.scripting, deps.cookies, deps.runtime — chrome namespaces, handed
 *   to the clients as-is; `tabs.create` is used here ONLY to open our own compare page
 * @param {object} deps.storage — chrome.storage.local (promise API) for the flag TTL cache
 * @param {object} deps.storageSync — chrome.storage.sync (promise API) for the per-provider model choice
 *   (COMPARE_MODELS_KEY); a read that fails reads as "nothing chosen", a write that fails is logged
 * @param {Function} deps.readCollectedOrgs — `() => Promise<Array>` of chrome.storage.local `collectedOrgs`
 *   (what Claude Tuner's collectors wrote: `{provider, plan, isPrimary, …}`), for the per-provider plan
 *   label in COMPARE_STATUS (ux3 item 3); bounded here like the other reads, a failed read = no labels
 * @param {Function} deps.planLabel — ui/util.js `planDisplayName(plan, provider)` → the display-ready label
 * @param {Function} deps.sendGAEvent — bg/analytics.js `sendGAEvent(name, params)` (ux3 item 8); every
 *   COMPARE_EVENT the page sends, and the SW's own `consume`, go through it after sanitizeCompareEvent
 * @param {Function} [deps.fetch] — defaults to globalThis.fetch
 * @param {Function} [deps.now] — defaults to Date.now
 * @param {number} [deps.sendTimeoutMs] — defaults to PROVIDER_SEND_TIMEOUT_MS (tests shorten it)
 * @param {number} [deps.listModelsTimeoutMs] — defaults to LIST_MODELS_TIMEOUT_MS (tests shorten it)
 * @param {number} [deps.selectedModelsReadTimeoutMs] — defaults to SELECTED_MODELS_READ_TIMEOUT_MS (tests shorten it)
 * @param {Function} [deps.drainPendingHides] — vendor-ai `drainPendingHides(deps)`, called once per
 *   worker life, DRAIN_STARTUP_DELAY_MS after construction (= service-worker start), unless
 *   `storage` holds DRAIN_DISABLED_KEY true
 * @param {Function} [deps.setTimeout] — defaults to globalThis.setTimeout (tests inject a fake)
 * @param {number} [deps.drainDelayMs] — defaults to DRAIN_STARTUP_DELAY_MS
 *
 * Parameter order matters to test/ext-import-refs-guard.mjs, which reads a parameter list only up
 * to the first closing paren: keep the arrow-function defaults last.
 */
export function createCompareController({
  createClient, listModels, authedFetch, getConfig, getExtToken, hasProviderPermission, loginChecks,
  tabs, scripting, cookies, runtime, storage, storageSync,
  readCollectedOrgs, planLabel, sendGAEvent,
  drainPendingHides = null,
  fetch: fetchImpl = (...a) => globalThis.fetch(...a),
  now = () => Date.now(),
  setTimeout: setTimeoutImpl = (fn, ms) => globalThis.setTimeout(fn, ms),
  drainDelayMs = DRAIN_STARTUP_DELAY_MS,
  sendTimeoutMs = PROVIDER_SEND_TIMEOUT_MS,
  listModelsTimeoutMs = LIST_MODELS_TIMEOUT_MS,
  selectedModelsReadTimeoutMs = SELECTED_MODELS_READ_TIMEOUT_MS,
}) {
  // `storage` is optional in the package and only the ChatGPT client uses it: the durable backlog
  // of conversations still to hide (see drainPendingHides below).
  const clientDeps = { tabs, scripting, cookies, runtime, storage };
  const sessions = new Set();

  // The two crash-attribution levers, read once here (see the constants above). A storage that
  // fails reads as "not set": the default behaviour must not depend on storage health.
  const readLever = async (key) => {
    try { return (await storage.get(key))?.[key] === true; } catch { return false; }
  };
  // Both levers are SAMPLED ONCE, here, and every client creation awaits the sample (Codex
  // v0.2.5 1R #3: a lazily created second client must not see a different answer than the
  // first — one session, one pin policy). `leversReady` resolves microseconds after start; a
  // storage change later in this worker life applies from the next start (1R #6).
  // Bounded like the other storage read (Codex v0.2.6 2R #3: a storage that hangs must not wedge
  // every send and status probe behind `running`): past the cap the defaults are COMMITTED and a
  // late answer changes nothing — the values are assigned once, from the raced result only.
  let pinDisabled = false;
  let drainDisabled = false;
  const leversReady = withTimeout(
    Promise.all([readLever(PIN_DISABLED_KEY), readLever(DRAIN_DISABLED_KEY)]),
    selectedModelsReadTimeoutMs,
    null,
  ).then((sample) => { const [pin, drain] = sample || [false, false]; pinDisabled = pin; drainDisabled = drain; });
  // `saveHistory`: the session's flag (package v0.3.1) — false for the throwaway status client.
  // `webSearch: true` for Claude ONLY: Gemini/ChatGPT ignore the key today, but the wire must not
  // rely on a stranger's tolerance (test/compare-send-order-guard.mjs pins both).
  // `continuation` (package v0.4.0, ux3 item 6): the page's `resume[provider]` for a client this
  // SEND constructs, so its first send continues that conversation; omitted (not null) otherwise —
  // the key exists only when the page asked to resume.
  const clientOptions = (provider, saveHistory = false, continuation = null) => ({
    ...CLIENT_OPTIONS,
    ...(pinDisabled ? { tabCreateProps: Object.freeze({ pinned: false }) } : {}),
    relayFile: PROVIDER_SITES[provider].relayFile,
    saveHistory: saveHistory === true,
    ...(provider === 'claude' ? { webSearch: true } : {}),
    ...(continuation ? { continuation } : {}),
  });

  // ── Usage analytics (GA4 through the extension's own sender) ─────────────────────────────
  // One validator for the page's events and the SW's own; a rejected event is dropped silently
  // (it is telemetry, not the send), a sender that throws or is missing costs nothing either.
  function emitEvent(name, params) {
    const ev = sanitizeCompareEvent(name, params);
    if (!ev || typeof sendGAEvent !== 'function') return false;
    try { Promise.resolve(sendGAEvent(ev.name, ev.params)).catch(() => {}); } catch { /* telemetry */ }
    return true;
  }

  // ChatGPT has no temporary mode: the client hides each conversation it created at cleanup, and
  // keeps the ids it could not hide (or a terminated worker never got to) in `storage`. The
  // package sweeps that backlog only when the host asks, once per worker life; it never opens or
  // reloads a tab (v0.2.5: a discarded tab is skipped). Delayed by DRAIN_STARTUP_DELAY_MS (see
  // above) and skipped under DRAIN_DISABLED_KEY. Fire-and-forget — a failed sweep waits for the
  // next start.
  if (typeof drainPendingHides === 'function') {
    setTimeoutImpl(() => {
      leversReady
        .then(() => (drainDisabled ? null : drainPendingHides(clientDeps)))
        .catch(() => { /* next start retries */ });
    }, drainDelayMs);
  }

  // ── Dark-launch flag ──────────────────────────────────────────────────────────────────────
  let flagInFlight = null; // every claude.ai tab asks at load; share one CDN fetch across them

  async function readFlagCache() {
    try {
      const cached = (await storage.get(COMPARE_FLAG_CACHE_KEY))?.[COMPARE_FLAG_CACHE_KEY];
      // An older cache row has no `cta` (written before the field existed): it reads as false — the
      // fail-safe direction — until the TTL brings the next fetch.
      if (cached && typeof cached.on === 'boolean' && now() - (cached.at || 0) < COMPARE_FLAG_TTL_MS) return { on: cached.on, cta: cached.cta === true };
    } catch { /* unreadable cache = miss */ }
    return null;
  }
  async function writeFlagCache(flags) {
    try { await storage.set({ [COMPARE_FLAG_CACHE_KEY]: { on: flags.on === true, cta: flags.cta === true, at: now() } }); } catch { /* best effort */ }
  }
  // FAIL-SAFE like fetchFolderAvailable: any fetch/parse error, non-2xx or a missing/invalid
  // `compare` field reads as dark. A network error does not poison the cache. `cta` can never be
  // true while `on` is false (the button opens the page).
  const DARK = Object.freeze({ on: false, cta: false });
  async function fetchCompareFlags() {
    const cached = await readFlagCache();
    if (cached !== null) return cached;
    if (!flagInFlight) {
      flagInFlight = (async () => {
        try {
          const res = await fetchImpl(FLAGS_URL);
          if (!res.ok) { await writeFlagCache(DARK); return DARK; }
          const json = await res.json();
          const on = !!(json && json[COMPARE_FLAG_FIELD] === true);
          const flags = { on, cta: on && !!(json && json[COMPARE_CTA_FLAG_FIELD] === true) };
          await writeFlagCache(flags);
          return flags;
        } catch {
          return DARK;
        } finally {
          flagInFlight = null;
        }
      })();
    }
    return flagInFlight;
  }
  /** The page/shell gate alone (`compare`). */
  async function fetchCompareFlag() {
    return (await fetchCompareFlags()).on;
  }

  // ── Status probe (page load) ─────────────────────────────────────────────────────────────
  async function providerStatus(provider) {
    const site = PROVIDER_SITES[provider];
    let permitted = true;
    if (site.optionalHost) {
      try { permitted = (await hasProviderPermission(provider)) === true; } catch { permitted = false; }
    }
    // `null` when we cannot even look: without the host permission the cookie and tab probes
    // answer "nothing" for a signed-in user too, and the page must render that as "grant",
    // not "sign in".
    let loggedIn = null;
    if (permitted) {
      try { loggedIn = (await loginChecks[provider]()) === true; } catch { loggedIn = false; }
    }
    return { permitted, loggedIn };
  }

  async function readJson(resp) {
    try { return await resp.json(); } catch { return null; }
  }

  // ── Model choice (chrome.storage.sync) ───────────────────────────────────────────────────
  // 🔴 ONE in-memory map for the whole controller, not a read-modify-write of storage per send
  // (Codex ext 1R #1–#3). Two ports that each read storage, merge their own provider and write back
  // erase each other's choice; a follow-up that re-reads storage while the previous send's write is
  // still pending goes out on the OLD model; and a read that failed looks like an empty map, so the
  // next merged write wipes every other provider. So: storage is read ONCE per worker life (joined
  // by concurrent readers), overrides land in memory synchronously and in arrival order, writes go
  // out through a serialised chain carrying the whole current map, and a failed read never becomes
  // a baseline — overrides made meanwhile wait in `pending` and are written once a read succeeds.
  // The worker is short-lived (MV3), so a choice made elsewhere (another device) is picked up on
  // the next worker start; nothing else in the extension writes this key.
  const fullMap = (partial) => {
    const out = {};
    for (const p of COMPARE_PROVIDERS) out[p] = Object.hasOwn(partial, p) ? partial[p] : null;
    return out;
  };
  let selected = null;        // the baseline + every override so far, once a read has succeeded
  let selectedLoad = null;    // the one read in flight, joined by concurrent callers
  let pending = {};           // overrides applied while no baseline exists yet
  let persistChain = Promise.resolve();

  // Resolves to the shared map once a read has succeeded, else null. Each caller's wait is bounded
  // (SELECTED_MODELS_READ_TIMEOUT_MS); the read itself keeps going and, if it lands later, still
  // becomes the baseline WITH every override made meanwhile merged over it — a late read can never
  // replace newer state.
  function loadSelectedModels() {
    if (selected) return Promise.resolve(selected);
    if (!selectedLoad) {
      selectedLoad = (async () => {
        try {
          const stored = sanitizeModelMap((await storageSync.get(COMPARE_MODELS_KEY))?.[COMPARE_MODELS_KEY]);
          selected = { ...fullMap(stored), ...pending };
          if (Object.keys(pending).length) { pending = {}; queuePersist(); }
        } catch (e) {
          console.warn('[compare] could not read model choice:', e?.message || e);
        }
        return selected;
      })().finally(() => { selectedLoad = null; });
    }
    return withTimeout(selectedLoad, selectedModelsReadTimeoutMs, null);
  }
  // The current choice per provider (all three keys, null = provider default). Without a baseline
  // (storage unreadable) it is what this worker was told so far, and nothing is written.
  async function readSelectedModels() {
    const base = await loadSelectedModels();
    return base ? { ...base } : fullMap(pending);
  }
  // Apply a sanitised `{ [provider]: id|null }` in memory — synchronously, so two ports' overrides
  // compose in arrival order — and schedule the write. Returns the resulting full map.
  function applySelectedModels(override) {
    if (selected) {
      Object.assign(selected, override);
      queuePersist();
      return { ...selected };
    }
    Object.assign(pending, override);
    return fullMap(pending);
  }
  function queuePersist() {
    const snapshot = { ...selected };
    persistChain = persistChain
      .then(() => storageSync.set({ [COMPARE_MODELS_KEY]: snapshot }))
      .catch((e) => { console.warn('[compare] could not persist model choice:', e?.message || e); });
  }

  // ── History preference (chrome.storage.sync, package v0.3.1 / ux3 item 6) ───────────────
  // Same discipline as the model choice, for a single boolean: read ONCE per worker life (joined
  // by concurrent readers, each wait bounded by SELECTED_MODELS_READ_TIMEOUT_MS — a hung read
  // answers the DEFAULT and writes nothing), a SEND's boolean lands in memory synchronously and
  // is written through the same serialised chain, and a read that lands late never overwrites a
  // value a SEND set meanwhile. In memory and on the wire the value is `saveHistory`; in storage
  // it is its opposite, COMPARE_INCOGNITO_KEY (`true` = incognito), so an empty storage — and a
  // failed or hung read — is "kept in history" (the ux3 default), and only an explicit
  // incognito opt-in is temporary.
  const SAVE_HISTORY_DEFAULT = true;
  let saveHistoryPref = null;   // boolean once known (read, or set by a SEND)
  let saveHistoryLoad = null;
  function loadSaveHistory() {
    if (saveHistoryPref !== null) return Promise.resolve(saveHistoryPref);
    if (!saveHistoryLoad) {
      saveHistoryLoad = (async () => {
        let stored = SAVE_HISTORY_DEFAULT;
        try {
          stored = (await storageSync.get(COMPARE_INCOGNITO_KEY))?.[COMPARE_INCOGNITO_KEY] !== true;
        } catch (e) {
          // A failed read is MEMOISED as the default (Codex wiring 1R #2): retrying it on every
          // send would cost a read per send for nothing. Nothing is written, and a preference a
          // SEND set meanwhile is never overwritten.
          console.warn('[compare] could not read history preference:', e?.message || e);
        }
        if (saveHistoryPref === null) saveHistoryPref = stored;
        return saveHistoryPref;
      })().finally(() => { saveHistoryLoad = null; });
    }
    return withTimeout(saveHistoryLoad, selectedModelsReadTimeoutMs, null).then((v) => (v === null ? SAVE_HISTORY_DEFAULT : v === true));
  }
  function applySaveHistory(value) {
    saveHistoryPref = value === true;
    const incognito = !saveHistoryPref;
    persistChain = persistChain
      .then(() => storageSync.set({ [COMPARE_INCOGNITO_KEY]: incognito }))
      .catch((e) => { console.warn('[compare] could not persist history preference:', e?.message || e); });
    return saveHistoryPref;
  }

  // ── Plan labels (chrome.storage.local `collectedOrgs`, ux3 item 3) ──────────────────────
  // What Claude Tuner already collected, reused as a display label per provider: for claude the
  // `isPrimary` entry (an entry without `provider` is a claude one, like bg/badge.js reads it),
  // else the first claude entry; for the others the first entry of that provider. `null` when
  // nothing was collected for that provider, or when the read failed/hung (bounded like the
  // other storage reads — a status probe must not wait on storage.local).
  async function planLabels() {
    const out = {};
    for (const p of COMPARE_PROVIDERS) out[p] = null; // { plan, usage } per provider, or null when nothing was collected
    let orgs = null;
    try {
      orgs = await withTimeout(Promise.resolve().then(() => readCollectedOrgs()), selectedModelsReadTimeoutMs, null);
    } catch { orgs = null; }
    if (!Array.isArray(orgs)) return out;
    const providerOf = (o) => (typeof o?.provider === 'string' && o.provider ? o.provider : 'claude');
    for (const p of COMPARE_PROVIDERS) {
      const mine = orgs.filter((o) => o && typeof o === 'object' && providerOf(o) === p);
      const entry = (p === 'claude' ? mine.find((o) => o.isPrimary === true) : null) || mine[0] || null;
      if (!entry) continue;
      let label = null;
      if (typeof entry.plan === 'string' && entry.plan.trim()) {
        try { label = planLabel(entry.plan, p); } catch { label = null; }
      }
      out[p] = {
        plan: typeof label === 'string' && label.trim() ? label.trim() : null,
        usage: usageFacts(entry),
      };
    }
    return out;
  }
  // The same entry's usage windows, display-ready for the column head's mini gauges (2026-09-18,
  // user request): utilisation 0–100 per window (null = not collected / not a number), the reset
  // instants as ISO strings, the reported window lengths (`w5s`/`w7s`, seconds) and the collector's
  // "this plan has no limits" mark (Gemini Workspace/Business). Numbers are clamped, strings bounded.
  function usageFacts(entry) {
    const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null);
    const iso = (v) => (typeof v === 'string' && v.length <= 40 ? v : null);
    // Window lengths in seconds (ChatGPT Free/Go report a 30-day `w7s` = 2592000): the page labels
    // the gauge from them like the popup's windowLabel(); a missing/garbage span keeps the nominal label.
    const span = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 366 * 86400 ? Math.round(v) : null);
    const u = { h5: pct(entry.h5), d7: pct(entry.d7), resetsAt5h: iso(entry.resetsAt5h), resetsAt7d: iso(entry.resetsAt7d), w5s: span(entry.w5s), w7s: span(entry.w7s), noLimits: entry.noLimits === true };
    return u.h5 == null && u.d7 == null && !u.noLimits ? null : u;
  }

  // The static catalog: what the page gets when a provider's own answer is late or failed. Never
  // throws — the package's `listModels(provider)` only throws for an unknown provider, and only
  // known ones reach here — but a package that surprised us must not take the status down.
  function staticModels(provider) {
    try { return listModels(provider); } catch { return Promise.resolve([]); }
  }

  // One provider's picker list for COMPARE_STATUS. A throwaway client — the ChatGPT list needs a
  // client because it asks chatgpt.com through an OPEN tab's bridge (never opens one); Claude and
  // Gemini answer their static catalogs. Capped here (listModelsTimeoutMs) regardless of the package's own cap; the
  // client is disposed afterwards (it opened nothing, so that closes nothing) so its timers and
  // listeners cannot outlive the probe.
  // Returns `{ list, source }` — `source` per MODELS_SOURCE: the package's `models_listed` diag when
  // the list came from the client, `static` for the fallback below, `none` for an empty list.
  async function providerModels(provider) {
    let client = null;
    let source = null;
    try {
      await leversReady;
      client = createClient(provider, clientDeps, clientOptions(provider));
      // `onEvent` (package v0.2.4): one `models_listed` diag naming the path — `categories` (the
      // site's own picker), `models` (its internal slug list, deduplicated) or `static` — plus the
      // tab lookup's `tab_found`. Logged only: COMPARE_STATUS has no port to forward to.
      const list = await withTimeout(
        Promise.resolve().then(() => client.listModels({ onEvent: (ev) => {
          if (ev?.type !== 'diag') return;
          logInfo(provider, ev.stage, ev.detail);
          if (ev.stage === 'models_listed' && typeof ev.detail?.source === 'string') source = ev.detail.source;
        } })).catch(() => null),
        listModelsTimeoutMs,
        null,
      );
      if (Array.isArray(list) && list.length) return { list, source: source || MODELS_SOURCE.STATIC };
    } catch { /* fall through to the static list */ } finally {
      if (client) Promise.resolve().then(() => client.dispose()).catch(() => {});
    }
    let list = [];
    try { list = await staticModels(provider); } catch { list = []; }
    return { list, source: Array.isArray(list) && list.length ? MODELS_SOURCE.STATIC : MODELS_SOURCE.NONE };
  }

  /** `{ models, modelsSource, modelsPending }` for `providers`, in parallel (one cap, not N). */
  async function catalogsFor(providers) {
    const models = {};
    const modelsSource = {};
    await Promise.all(providers.map(async (p) => {
      const { list, source } = await providerModels(p);
      models[p] = list;
      modelsSource[p] = source;
    }));
    const modelsPending = providers.filter((p) => catalogPending(p, modelsSource[p]));
    return { models, modelsSource, modelsPending };
  }

  async function buildStatus() {
    const flagOn = await fetchCompareFlag();
    let loggedIn = false;
    try { loggedIn = !!(await getExtToken()); } catch { loggedIn = false; }
    const providers = {};
    const [facts] = await Promise.all([
      planLabels(),
      ...COMPARE_PROVIDERS.map(async (p) => { providers[p] = await providerStatus(p); }),
    ]);
    for (const p of COMPARE_PROVIDERS) { providers[p].plan = facts[p] ? facts[p].plan : null; providers[p].usage = facts[p] ? facts[p].usage : null; }
    // Pickers only for providers the page can actually send to (permitted AND signed in) — and only
    // when the page will show anything at all (dark = nothing else, AC24). In parallel: three caps
    // of LIST_MODELS_TIMEOUT_MS must cost one, not three.
    let catalogs = { models: {}, modelsSource: {}, modelsPending: [] };
    if (flagOn) {
      const sendable = COMPARE_PROVIDERS.filter((p) => providers[p].permitted && providers[p].loggedIn === true);
      catalogs = await catalogsFor(sendable);
    }
    const { models, modelsSource, modelsPending } = catalogs;
    const selectedModels = await readSelectedModels();
    const saveHistory = await loadSaveHistory();

    let quota = null;
    let quotaError = null;
    // Dark = nothing else to show (AC24); do not touch the server for a page that will only say
    // "coming soon". Otherwise the server's answer is the truth, including 401 for a missing
    // ext_token (authedFetch falls back to the shared key, which the route refuses by design).
    if (flagOn) {
      try {
        const config = await getConfig();
        const resp = await authedFetch(config, `${config.serverUrl}/api/compare/status`);
        const body = await readJson(resp);
        if (resp.ok && body && body.ok === true) {
          quota = {
            remaining: body.remaining ?? null,
            limit: body.limit ?? null,
            resetsAt: body.resetsAt,
            pro: body.pro === true,
          };
        } else {
          quotaError = { status: resp.status, ...(body?.code ? { code: body.code } : {}) };
        }
      } catch {
        quotaError = { status: 0, code: SW_CODES.NETWORK_ERROR };
      }
    }
    return { ok: true, flagOn, loggedIn, providers, quota, quotaError, models, modelsSource, modelsPending, selectedModels, saveHistory };
  }

  // ── Open the compare page from a provider tab (content script → SW) ───────────────────────
  // The ONE `tabs.create` outside the vendored clients, and it opens our own page only.
  async function openCompare(message) {
    const src = COMPARE_PROVIDERS.includes(message.src) ? message.src : null;
    if (!src) return { ok: false, error: 'unknown src' };
    const q = typeof message.q === 'string' ? message.q : '';
    const url = `${runtime.getURL(COMPARE_PAGE)}?src=${src}&q=${encodeURIComponent(q)}`;
    await tabs.create({ url, active: true });
    return { ok: true };
  }

  /** runtime.onMessage adapter. Returns true when the message was ours (async sendResponse). */
  function handleMessage(message, _sender, sendResponse) {
    if (!message || typeof message.type !== 'string') return false;
    if (message.type === 'COMPARE_FLAG') {
      // `on` = the page/shell gate, `cta` = the in-page button gate (both fields, see COMPARE_CTA_FLAG_FIELD).
      fetchCompareFlags().then((f) => sendResponse({ on: f.on, cta: f.cta }), () => sendResponse({ on: false, cta: false }));
      return true;
    }
    if (message.type === 'COMPARE_STATUS') {
      buildStatus().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    if (message.type === 'OPEN_COMPARE') {
      openCompare(message).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    // Usage analytics from the page (ux3 item 8): validated, then off to GA. Answered at once —
    // the page fires and forgets; `ok:false` only says the event was dropped.
    if (message.type === 'COMPARE_EVENT') {
      let ok = false;
      try { ok = emitEvent(message.name, message.params); } catch { ok = false; }
      try { sendResponse({ ok }); } catch { /* page gone */ }
      return true;
    }
    return false;
  }

  // ── Streaming session: one Port = one session = one client per provider ──────────────────
  function createSession(port) {
    const clients = new Map();   // provider → vendored client (kept for follow-ups)
    const inflight = new Set();  // AbortController per in-flight provider send
    let running = false;         // one send at a time per port
    let torndown = false;
    // The send in progress, from SEND entry to ALL_DONE. ABORT fires it, so a Stop that lands
    // during readiness or consume still ends the send — the per-provider controllers in
    // `inflight` only exist once the fan-out has begun (Codex 2026-09-14, follow-up).
    let currentSend = null;
    // Providers whose picker list is still static/none for THIS send (see the catalog-refresh note
    // at the top): what the page said in its SEND/FOLLOWUP (`modelsPending`, sanitised to known
    // live-catalog providers), narrowed by each refresh of this round. Re-read from the message on
    // every send, so a page that got MODELS asks for nothing next time and a page whose later
    // status went static asks again.
    let catalogPendingSet = new Set();
    let refreshingCatalogs = false;
    // The session's `saveHistory` (package v0.3.1): null until a SEND sets it — the clients are
    // created right after, with it. See the header: once a client EXISTS the flag is the
    // session's, and a later SEND on this port persists a new preference but cannot move it; a
    // FOLLOWUP never carries it. Resolved afresh by every send that arrives while NO client
    // exists, so a SEND that ended clientless (no targets, every target failed readiness before a
    // client was constructed, a failed consume) fixed nothing and the next send's field — or the
    // stored preference — wins (Codex wiring 1R #1 — a permission failure on SEND{true} used to
    // make a retried SEND{false} construct a client with true).
    let sessionSaveHistory = null;
    // The SEND's `resume` map (package v0.4.0, ux3 item 6): `{ [provider]: continuation }` for the
    // clients THIS send constructs — a client that already exists rides its own conversation, so
    // its entry is ignored. Re-read from every SEND (empty for a FOLLOWUP, which never carries
    // one), consumed by clientFor as each client is built, and honoured ONLY for a kept session
    // (`sessionSaveHistory === true`): a continuation names a conversation in the user's history,
    // and appending an "incognito" turn to it would be the opposite of what the toggle says. Every
    // step after construction (readiness → consume → fan-out) is exactly the SEND path.
    let pendingResume = {};
    // A refresh asked for while one is in flight runs after it (for what is still pending then)
    // instead of being dropped: the ALL_DONE retry must not be lost to a slow CONSUME_OK refresh.
    let refreshQueued = null;

    const post = (msg) => {
      if (torndown) return;
      try { port.postMessage(msg); } catch { /* page gone — onDisconnect tears down */ }
    };

    const clientFor = (provider) => {
      // 🔴 After teardown there is nobody left to dispose a new client (the map was snapshot and
      // cleared), so a readiness step that resumes late must not create one (Codex blocker).
      if (torndown) throw abortedError('session torn down');
      let client = clients.get(provider);
      if (!client) {
        const continuation = sessionSaveHistory === true && Object.hasOwn(pendingResume, provider) ? pendingResume[provider] : null;
        delete pendingResume[provider];
        if (continuation) logInfo(provider, 'resume', { keys: Object.keys(continuation) });
        client = createClient(provider, clientDeps, clientOptions(provider, sessionSaveHistory === true, continuation));
        clients.set(provider, client);
      }
      return client;
    };

    // The clients' readiness diagnostics (`{type:'diag', provider, stage, detail}`, package v0.2.3):
    // one line in the SW console and one DIAG port message each. Never throws (a listener that
    // throws would be logged by the client, but the send is not the place to find out).
    const onDiag = (provider) => (ev) => {
      if (ev?.type !== 'diag') return;
      const stage = typeof ev.stage === 'string' ? ev.stage : 'unknown';
      const detail = ev.detail && typeof ev.detail === 'object' ? ev.detail : {};
      logInfo(provider, stage, detail);
      post({ type: PORT_MSG.DIAG, provider, stage, detail });
    };

    // One ERROR to the page + one line in the SW console. `e` is the client's error (or null for
    // a code this module produced itself): its `reason`/`message` ride along as reason/detail.
    // `more`: fields this module adds beside the client's (a timeout's `budgetMs`) — never written
    // onto the caught error itself (a frozen/sealed error would throw here and swallow ALL_DONE —
    // Codex 1.31.2 #1).
    const postError = (provider, code, message, e, more = null) => {
      const extras = { ...errorExtras(e), ...(more && typeof more === 'object' ? more : {}) };
      logInfo(provider, 'ERROR', { code, reason: extras.reason ?? null, message: extras.detail ?? message });
      post({ type: PORT_MSG.ERROR, provider, code, ...extras, message });
    };

    // Step (a). Returns `{ code, error }` naming why this target cannot be sent to, or null.
    //
    // `prepare()` is the package's "everything a send needs, without sending": it acquires the
    // provider tab (opening one only under `mayOpenTab === true`; a prepared tab that has since
    // been closed is re-acquired the same way), waits for it to load, injects the relay and
    // verifies the session on that tab. Its rejection code is the per-provider ERROR the page
    // renders, and — the point of doing it here — every one of those failures now lands BEFORE
    // the quota is debited (Codex 1R blocker #1; package v0.1.0). Both SEND and FOLLOWUP pass
    // `mayOpenTab: true` (see runSend), so a closed tab costs nothing: a reopen that fails is a
    // readiness failure, not a debited-then-dead column.
    async function readiness(provider, mayOpenTab, signal, model) {
      const site = PROVIDER_SITES[provider];
      if (site.optionalHost) {
        let permitted = false;
        try { permitted = (await hasProviderPermission(provider)) === true; } catch { permitted = false; }
        if (!permitted) return { code: SW_CODES.AUTH_REQUIRED, error: null };
      }
      // Every await above and below is a point where the port may have gone or Stop been pressed.
      if (torndown || signal.aborted) return { code: SW_CODES.ABORTED, error: null };
      try {
        // `model` (package v0.3.0): what THIS send will pass to sendMessage, so Claude's pre-created
        // conversation is on the right model (a mismatch would cost a fresh create).
        await clientFor(provider).prepare({ mayOpenTab: mayOpenTab === true, signal, onEvent: onDiag(provider), model });
      } catch (e) {
        if (torndown || signal.aborted) return { code: SW_CODES.ABORTED, error: null };
        return { code: typeof e?.code === 'string' ? e.code : SW_CODES.UNKNOWN, error: e };
      }
      if (torndown || signal.aborted) return { code: SW_CODES.ABORTED, error: null };
      return null;
    }

    // Step (b). Never throws; a failure is a CONSUME_FAIL payload.
    async function consume() {
      let resp;
      try {
        const config = await getConfig();
        resp = await authedFetch(config, `${config.serverUrl}/api/compare/consume`, { method: 'POST' });
      } catch (e) {
        return { ok: false, fail: { status: 0, code: SW_CODES.NETWORK_ERROR, message: String(e?.message || e) } };
      }
      const body = await readJson(resp);
      // Exactly 200 — the contract names the status, and a 2xx that is not it is not a debit we
      // recognise (a proxy's 202/204 with a stale body must not release a send).
      if (resp.status === CONSUME_OK_STATUS && body && body.ok === true) {
        return { ok: true, remaining: body.remaining ?? null, limit: body.limit ?? null, resetsAt: body.resetsAt };
      }
      return {
        ok: false,
        fail: {
          status: resp.status,
          code: typeof body?.code === 'string' ? body.code : 'http_error',
          ...(body?.remaining !== undefined ? { remaining: body.remaining } : {}),
          ...(body?.resetsAt !== undefined ? { resetsAt: body.resetsAt } : {}),
          ...(body?.error ? { message: String(body.error) } : {}),
        },
      };
    }

    // Step (c), one provider. Its own AbortController so ABORT and the per-provider timeout share
    // one cancellation path, and so one provider's failure never touches another's.
    //
    // `model` is the resolved choice for this provider (id or null = the provider's default) and is
    // passed on EVERY send, so the client's conversation always runs on what the page shows.
    async function sendOne(provider, text, mayOpenTab, model, sendSignal) {
      const ac = new AbortController();
      inflight.add(ac);
      const onSendAbort = () => ac.abort();
      sendSignal.addEventListener('abort', onSendAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ac.abort(); }, sendTimeoutMs);
      // The timed stages of THIS send (package v0.3.0), keyed by stage → `detail.at`; the ttft line
      // is computed from them on first_chunk and stream_done (see ttftSegments). A retry inside the
      // client (conversation gone, overload backoff, relay repair) re-reports its stages, and the
      // LAST `at` wins here: the segments then describe the attempt that answered, `ms` the whole
      // send (send_start and first_chunk are reported once per send).
      const stages = {};
      const onStage = (ev) => {
        const at = ev?.detail?.at;
        if (typeof at !== 'number' || typeof ev.stage !== 'string') return;
        stages[ev.stage] = at;
        if (ev.stage === 'first_chunk' || ev.stage === 'stream_done') logInfo(provider, 'ttft', ttftSegments(stages));
      };
      try {
        const client = clientFor(provider);
        const result = await client.sendMessage(
          text,
          (delta) => post({ type: PORT_MSG.CHUNK, provider, delta: String(delta ?? '') }),
          ac.signal,
          {
            mayOpenTab: mayOpenTab === true,
            model,
            // The served model, as soon as the client knows it (before the first chunk where the
            // provider reports it). The page swaps its "waiting" badge for the name.
            onEvent: (ev) => {
              if (ev?.type === 'diag') { onDiag(provider)(ev); onStage(ev); return; }
              if (ev?.type === 'activity') { const a = activityForPage(ev); if (a) post({ type: PORT_MSG.ACTIVITY, provider, ...a }); return; }
              if (ev?.type !== 'model') return;
              const m = modelForPage(ev.model);
              if (m) post({ type: PORT_MSG.MODEL, provider, model: m });
            },
          },
        );
        // `continuation` (package v0.4.0): what would resume this provider's conversation on a
        // fresh client — ONLY for a kept session, and only when the client hands one out (it
        // answers null for anything it will still clean up). Omitted otherwise, never null: an
        // incognito session's conversations are gone at dispose, so there is nothing to offer.
        const continuation = sessionSaveHistory === true && typeof client.getContinuation === 'function' ? client.getContinuation() : null;
        post({
          type: PORT_MSG.DONE, provider, text: String(result?.text ?? ''), model: modelForPage(result?.model),
          ...(continuation && typeof continuation === 'object' ? { continuation } : {}),
        });
      } catch (e) {
        const code = timedOut ? SW_CODES.TIMEOUT
          : (typeof e?.code === 'string' ? e.code : (e?.name === 'AbortError' ? SW_CODES.ABORTED : SW_CODES.UNKNOWN));
        // A timeout names the budget it hit (the page's copy shows it, so a changed budget never
        // leaves a stale number in a string).
        postError(provider, code, String(e?.message || e), e, timedOut ? { budgetMs: sendTimeoutMs } : null);
      } finally {
        clearTimeout(timer);
        sendSignal.removeEventListener('abort', onSendAbort);
        inflight.delete(ac);
      }
    }

    // Ask the site again for the pickers still pending among `providers` — after the first
    // CONSUME_OK (the tabs exist now) and on ALL_DONE. Off the send path: never awaited, capped
    // per provider by providerModels, one refresh at a time, and nothing is posted when nothing was
    // pending or the port is gone. Never throws (a refresh must not fail a send).
    function refreshCatalogs(providers) {
      const pending = providers.filter((p) => catalogPendingSet.has(p));
      if (!pending.length || torndown) return;
      if (refreshingCatalogs) { refreshQueued = providers; return; }
      refreshingCatalogs = true;
      Promise.resolve().then(() => catalogsFor(pending)).then(({ models, modelsSource, modelsPending }) => {
        for (const p of pending) if (!modelsPending.includes(p)) catalogPendingSet.delete(p);
        logInfo('models', 'refreshed', { providers: pending, modelsSource, stillPending: modelsPending });
        post({ type: PORT_MSG.MODELS, models, modelsSource, modelsPending });
      }).catch((e) => { logInfo('models', 'refresh_failed', { message: String(e?.message || e) }); })
        .finally(() => {
          refreshingCatalogs = false;
          const queued = refreshQueued;
          refreshQueued = null;
          if (queued) refreshCatalogs(queued);
        });
    }

    async function runSend(message, followup) {
      if (running) {
        post({ type: PORT_MSG.CONSUME_FAIL, status: 0, code: SW_CODES.BUSY });
        return;
      }
      running = true;
      const send = new AbortController();
      currentSend = send;
      try {
        await leversReady; // the pin policy is fixed before the session's first client exists
        const text = typeof message.text === 'string' ? message.text : '';
        const targets = uniqueKnownProviders(message.targets);
        // 🔴 A follow-up may open a tab too (supersedes the contract's earlier "FOLLOWUP → false").
        // The tabs a session rides are OURS: the client opened them in the background (pinned)
        // and tracks them. A user who closes one mid-session must not end the
        // session — prepare() re-acquires (and re-opens) it, and the client's conversation ids
        // continue the same thread on the new tab. Live 2026-09-14: closing the ChatGPT/Gemini
        // tab turned every later follow-up into a dead 「연결이 끊어졌어요」 column.
        const mayOpenTab = followup || message.mayOpenTab === true;
        // What the page still shows as a static/none picker (see refreshCatalogs). Only providers
        // with a live catalog count, whatever the page says.
        catalogPendingSet = new Set(uniqueKnownProviders(message.modelsPending).filter((p) => PROVIDER_SITES[p].liveCatalog === true));
        if (!text.trim() || !targets.length) {
          post({ type: PORT_MSG.CONSUME_FAIL, status: 0, code: SW_CODES.NO_TARGETS });
          return;
        }
        // Model per provider = the current choice overlaid with what this message says; the
        // message's part becomes the current choice (and is persisted) so the next send and the
        // next page load agree. The write is not awaited: a slow storage.sync must not hold up the
        // send, and every later read is served from memory, not from the pending write.
        const override = sanitizeModelMap(message.models);
        let models;
        if (Object.keys(override).length) {
          await loadSelectedModels();
          models = applySelectedModels(override);
        } else {
          models = await readSelectedModels();
        }
        // History (package v0.3.1): a SEND's boolean is persisted — ONE write per SEND that carries
        // one — and becomes the current preference; the session's flag is fixed by the FIRST SEND
        // (the clients are created in readiness, just below). A FOLLOWUP's field is ignored.
        // 🔴 Resolved while the session has NO client yet — by every send that arrives in that
        // state, so a SEND that failed clientless fixed nothing (Codex wiring 1R #1): a SEND's
        // boolean (persisted), else the stored preference (a FOLLOWUP never carries the field).
        // Once a client exists the flag is the session's; a later SEND's boolean is only persisted.
        const carried = !followup && typeof message.saveHistory === 'boolean' ? message.saveHistory : null;
        if (!clients.size) {
          sessionSaveHistory = carried !== null ? applySaveHistory(carried) : await loadSaveHistory();
        } else if (carried !== null) {
          applySaveHistory(carried);
        }
        // Resume (ux3 item 6): what this SEND asks the clients it constructs to continue. See
        // `pendingResume` — read here, after the session's flag is known, so clientFor can refuse
        // it for an incognito session in one place.
        // A FOLLOWUP keeps the seeds a SEND{resume} left for providers whose client does not
        // exist yet (a column first asked in a later follow-up continues its own conversation —
        // batch-3 Codex #1); only a SEND replaces the map (an empty one for a plain SEND).
        if (!followup) pendingResume = sanitizeResumeMap(message.resume);
        // (a) readiness, in parallel; a failed target is reported and skipped, not fatal.
        const verdicts = await Promise.all(targets.map(async (p) => [p, await readiness(p, mayOpenTab, send.signal, models[p])]));
        // A Stop before the debit is free; the page hears it as a failed consume.
        if (torndown) return;
        if (send.signal.aborted) {
          post({ type: PORT_MSG.CONSUME_FAIL, status: 0, code: SW_CODES.ABORTED });
          return;
        }
        const ready = [];
        for (const [provider, verdict] of verdicts) {
          if (verdict) postError(provider, verdict.code, `not ready: ${verdict.code}`, verdict.error);
          else ready.push(provider);
        }
        if (!ready.length) {
          post({ type: PORT_MSG.CONSUME_FAIL, status: 0, code: SW_CODES.NO_TARGETS });
          return;
        }
        // (b) consume — the only server write, and the gate for (c).
        const c = await consume();
        // The SW's own analytics event (ux3 item 8): the debit's outcome and how many columns it
        // bought. Never the text, never who.
        emitEvent('consume', { ok: c.ok, status: c.ok ? CONSUME_OK_STATUS : c.fail.status, targets_n: ready.length });
        if (!c.ok) {
          post({ type: PORT_MSG.CONSUME_FAIL, ...c.fail });
          return;
        }
        post({ type: PORT_MSG.CONSUME_OK, remaining: c.remaining, limit: c.limit, resetsAt: c.resetsAt });
        if (torndown) return;
        // The tabs exist now (readiness opened them): a picker that was static for lack of a tab
        // can be the site's list. Not awaited — the fan-out below is what the user is waiting for.
        refreshCatalogs(ready);
        // (c) fan out. Each settles on its own; ALL_DONE once every one has. A Stop that landed
        // during consume is honoured here too — the unit is spent (no refund), no provider is asked.
        if (send.signal.aborted) {
          for (const p of ready) postError(p, SW_CODES.ABORTED, 'stopped before send', null);
        } else {
          await Promise.all(ready.map((p) => sendOne(p, text, mayOpenTab, models[p], send.signal)));
        }
        post({ type: PORT_MSG.ALL_DONE });
        // Still pending after the CONSUME_OK refresh (it ran while the tab was still loading, say):
        // one more try now that the round is over.
        refreshCatalogs(ready);
      } finally {
        if (currentSend === send) currentSend = null;
        running = false;
      }
    }

    function abortAll() {
      currentSend?.abort();
      for (const ac of inflight) ac.abort();
    }

    async function teardown() {
      if (torndown) return;
      torndown = true;
      abortAll();
      const all = [...clients.values()];
      clients.clear();
      // dispose() aborts, cleans up conversations and never throws (README) — the tabs we opened
      // stay open for the next session (CLIENT_OPTIONS); settle them all
      // regardless so one provider's cleanup cannot skip another's.
      await Promise.allSettled(all.map((c) => Promise.resolve().then(() => c.dispose())));
      sessions.delete(session);
    }

    function onPortMessage(message) {
      if (!message || typeof message.type !== 'string') return;
      if (message.type === PORT_MSG.SEND) { runSend(message, false); return; }
      if (message.type === PORT_MSG.FOLLOWUP) { runSend(message, true); return; }
      if (message.type === PORT_MSG.ABORT) { abortAll(); }
    }

    const session = { port, teardown, get clientCount() { return clients.size; } };
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(teardown);
    sessions.add(session);
    return session;
  }

  /** runtime.onConnect adapter. Returns true when the port was ours. */
  function onConnect(port) {
    if (!port || port.name !== COMPARE_PORT_NAME) return false;
    // Only our own pages may drive a session. A content script's port carries the site URL.
    const senderUrl = port.sender?.url || '';
    if (!senderUrl.startsWith(runtime.getURL(''))) {
      try { port.disconnect(); } catch { /* ignore */ }
      return false;
    }
    createSession(port);
    return true;
  }

  return {
    handleMessage,
    onConnect,
    fetchCompareFlag,
    /** Number of live streaming sessions (diagnostics / tests). */
    sessionCount: () => sessions.size,
  };
}
