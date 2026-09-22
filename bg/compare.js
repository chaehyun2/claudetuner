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
//   runtime.sendMessage   COMPARE_FLAG → {on, cta, summary}   COMPARE_STATUS → {ok, flagOn, summaryOn, betaReset, examples, loggedIn, providers{[p]: {permitted,
//                         loggedIn, plan}}, quota, quotaError, models, modelsSource, modelsPending, selectedModels,
//                         saveHistory}   OPEN_COMPARE{src, q, placement} → {ok} (src-less for placement popup|options)   COMPARE_EVENT{name, params} → {ok}
//                         COMPARE_RESET → {ok, quota} | {ok:false, code}
//   Port 'ctcmp-compare'  page→SW  SEND{text, columns[{id, provider, model}] | targets, mayOpenTab, models?, modelsPending?, saveHistory?, resume?, kind?, round?, src?, session?} ·
//                         FOLLOWUP{text, targets, models?, modelsPending?, kind?, round?, src?, session?} · ABORT
//                         SW→page  CONSUME_OK · CONSUME_FAIL · MODEL · CHUNK · DONE{…, continuation?, stalled?} · ERROR · ALL_DONE · DIAG · MODELS · ACTIVITY
//   Columns (cmp-columns contract §2, 2026-09-20): a COLUMN is `provider + model`, id `colId` =
//   `${provider}:${modelId || 'auto'}`, at most MAX_COLUMNS per round. SEND/FOLLOWUP carry
//   `columns: [{id, provider, model}]` (ordered; FOLLOWUP may instead name `targets` = colIds);
//   every per-column event (MODEL/CHUNK/DONE/ERROR/DIAG/ACTIVITY) carries `col` (the colId) beside
//   `provider`. One vendored client INSTANCE per column (same-provider columns share the pinned
//   tab — COMPARE_PROBE_MULTI proved the package multiplexes by requestId); readiness (tab lookup +
//   login verification, `prepare()`) runs ONCE per provider, on that provider's first column, and
//   its verdict applies to all of the provider's columns. Budget / stall / abort / outcome /
//   continuation are per column (keyed by colId); the consume body's `targets` are colIds and its
//   `models` `{colId: modelId|null}`. LEGACY: a SEND without `columns` (an older page) = its
//   provider `targets` as `${provider}:auto` columns on the stored model choice; a FOLLOWUP whose
//   `targets` are provider ids is mapped the same way; `resume` keyed by provider maps to
//   `${provider}:auto`. A duplicate colId or more than MAX_COLUMNS → CONSUME_FAIL{bad_request}
//   before consume (nothing sent, nothing debited).
//   DONE{stalled:true} (#1519, see STREAM_STALL_MS): the column's text arrived but the client never
//   reported `done` — the SW cut the stream after STREAM_STALL_MS of silence and hands the page
//   the text it streamed; the page treats it as done and may show a note. Never an ERROR: the
//   user has the answer.
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
//
// Beta usage stats + beta reset (2026-09-19, .omc/handoffs/cmp-beta-contract.md §2 — the SW half):
//   consume  — `POST /api/compare/consume` now carries a JSON body `{kind, targets, models, round?,
//              src?, session_id?, ext_version?, q_len?, q_script?, q_lines?, q_code?, q_url?}`: `kind` is what the page said (COMPARE_KINDS: the page decides
//              send / followup / summary / retry / resume) or, for an older page / garbage, derived
//              here (SEND with a resume map → 'resume', SEND → 'send', FOLLOWUP → 'followup');
//              `targets`/`models` describe the READY providers only (what the debit buys, the model
//              each runs on — id|null); `round` the page's round id (integer 0..ROUND_MAX, else
//              omitted); `src` the page's provider src when known (omitted otherwise); `session_id`
//              the page's `session` when it has the SESSION_ID_RE shape (omitted otherwise, §5);
//              `ext_version` the manifest version (`runtime.getManifest()`, omitted when unreadable);
//              `q_*` the question's content-free SIGNALS (#1562, questionSignals — a length bucket
//              floor, the dominant script id, a line-count bucket floor, and two 0/1 flags for code
//              and links; omitted for 'summary' and for an empty text).
//              🔴 The AC18 order is untouched: the body is built from `ready` right before the same
//              consume() call, nothing moves. Never an email, never the question — the q_* fields
//              describe the question, and are one-way by construction (bucket / enum / boolean).
//   outcome  — the consume 200 body's `event_id` (an integer, else "no event") names the round; the
//              SW collects per-provider results while the fan-out runs (ok from DONE, code from
//              ERROR, ttft_ms at the first CHUNK, total_ms at DONE/ERROR, model from MODEL / DONE)
//              and, once the round has SETTLED — the ALL_DONE point of runSend, which a Stop and a
//              lost port also reach once the aborted sends have landed — POSTs
//              `/api/compare/outcome {event_id, results}` ONCE, fire-and-forget (errors swallowed,
//              never awaited by the send). A ready provider without a result when the round settles
//              (port lost right after consume) is recorded as `{ok:false, code:'aborted'}`. Never
//              before consume, never without an event_id (a 429, a body without one, or a failed
//              consume = no outcome). Strings bounded: code ≤ OUTCOME_CODE_MAX; a model id goes out
//              ONLY when it has a catalog id's shape (MODEL_ID_RE) — consume `models` and outcome
//              `model` alike — else the key is omitted (never a cut string, never null).
//   reset    — runtime message COMPARE_RESET → `POST /api/compare/reset` (the server clears today's
//              counter only under its COMPARE_BETA_RESET flag; 404 otherwise) → the quota is RE-READ
//              from /status so the page gets the same fresh object COMPARE_STATUS would → `{ok:true,
//              quota}`; a reset that failed → `{ok:false, code}`; a reset that succeeded but a
//              status re-read that did not → `{ok:false, code:'status_unavailable', reset:true}`
//              (the page re-reads status itself — no invented quota). Touches no provider tab, no
//              client, no port.
//   status   — COMPARE_STATUS.betaReset = the /status body's `betaReset === true` (false when absent,
//              dark, or the status call failed) — the page shows the reset button on it.
//   events   — COMPARE_EVENT_NAMES += 'quota_reset' (the page reports a successful reset).

export const COMPARE_PORT_NAME = 'ctcmp-compare';
// Dev-only runtime messages (unpacked builds): the two-conversations-one-session probe, see probeMulti.
export const PROBE_MULTI_MSG = 'COMPARE_PROBE_MULTI';
export const PROBE_MULTI_ABORT_MSG = 'COMPARE_PROBE_ABORT';
export const PROBE_SEQUENCE_MAX = 40;
// Bound on each probe client's dispose() (Codex layout 2R #1): a dispose that never settles (a
// tab gone mid-cleanup, a hung PATCH) must not hold the probe lock forever — every later compare
// round would be `busy`. Past this the lock is released regardless and the timeout is logged.
export const PROBE_DISPOSE_TIMEOUT_MS = 10 * 1000;
export const COMPARE_PAGE = 'compare.html';
// Where the in-page button lands (2026-09-21, user decision): the site shell, which frames
// compare.html, rather than the bare extension page — one URL to remember, and the same surface
// the announcement and /pricing point at. `src` / `q` ride in the FRAGMENT (the shell's contract:
// the question never reaches a server). An unpacked build whose id is not the published one adds
// the shell's documented `?ext=<id>` override so the shell frames THIS build.
export const COMPARE_SITE_URL = 'https://claudetuner.com/multiai/';
// GA attribution for the button (query, not fragment — the shell forwards utm_* alone into GA's
// page_location): source/medium say "the extension's in-page button", campaign names the feature,
// content is the provider page the click came from.
export const COMPARE_SITE_UTM = 'utm_source=extension&utm_medium=cmp_button&utm_campaign=cross_check';
// Which button was clicked (utm_content = `<src>_<placement>`, and the SW's own `cmp_button_click`
// GA event): `composer` = the usage strip next to the input box; `message` = the per-question
// button under a chat message; `popup` / `options` = the extension's own surfaces (the popup's
// feature row under the gauges, the options card link — 2026-09-22). Anything else from a content
// script reads as `composer` — the allow-list keeps GA's content dimension enumerable.
export const COMPARE_PLACEMENTS = Object.freeze(['composer', 'message', 'popup', 'options']);
export const COMPARE_DEFAULT_PLACEMENT = 'composer';
// Placements with no provider page behind them: an OPEN_COMPARE from these may omit `src`, and
// then opens the bare shell — `utm_content=<placement>`, no `#src`, no `q` (there is no question
// to carry). Every other placement still requires a provider `src`. GA's `src` param reads
// COMPARE_SRC_NONE for these so the dimension stays enumerable (three providers + 'none') rather
// than gaining a null/undefined bucket.
export const COMPARE_SRCLESS_PLACEMENTS = Object.freeze(['popup', 'options']);
export const COMPARE_SRC_NONE = 'none';
export const PUBLISHED_EXT_ID = 'ajnnckikagphjbgpicpoffockabnhond';
export const COMPARE_PROVIDERS = Object.freeze(['claude', 'gemini', 'chatgpt']);
// Columns (cmp-columns contract): the most columns one round may have, and the id of the
// provider's default-model column.
export const MAX_COLUMNS = 5;
export const COLUMN_AUTO = 'auto';
/** `${provider}:${modelId || 'auto'}` — a column's id. */
export const columnId = (provider, model) => `${provider}:${model || COLUMN_AUTO}`;

// Per-provider answer budget (AC19). A provider that has not finished by then gets ERROR{timeout};
// the others keep streaming. 🔴 2026-09-18 live: 120 s cut off every column of a three-part travel
// question on thinking models (Opus 5 · Gemini 3.6 Thinking · ChatGPT 5.6 Sol Thinking) — one
// column mid-answer, the others still thinking (thinking deltas are not forwarded as events, so an
// idle timeout would fire in the same silence). The budget is now 10 minutes; Stop remains the way
// to end a round early, and the page tells the user the budget it hit (ERROR.budgetMs).
export const PROVIDER_SEND_TIMEOUT_MS = 10 * 60 * 1000;
// Stream STALL watchdog (#1519, live 2026-09-20): a Gemini column received its whole answer but the
// page script's `reader.read()` never resolved (no `done`), so the client's promise never settled,
// the round never reached ALL_DONE and the follow-up stayed locked until Stop — for up to the
// 10-minute budget above. A plain idle timeout is still forbidden by the thinking case (a model
// can be silent for minutes BEFORE its first token: thinking deltas are not forwarded as events),
// so this watchdog is armed ONLY once answer text has started (the first CHUNK) and re-armed by
// EVERY later message the client surfaces (chunk, activity/thinking, model, diag). Once text is
// flowing, a full minute with nothing at all is a dead stream, not a thinking one — the providers
// stream tokens continuously once they start. On stall the SW aborts THAT provider's send (the
// page script's fetch is cancelled, no dangling request in the tab) and posts DONE{stalled:true}
// with the text it streamed — not ERROR: the user has the answer. Other columns are untouched.
export const STREAM_STALL_MS = 60 * 1000;

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
  'incognito_toggle', 'quota_exhausted', 'jump_to_latest', 'history_open', 'history_load', 'history_delete', 'history_clear', 'consume',
  // SW-side, from openCompare: the in-page button was clicked (`src` + `placement`, nothing else).
  'button_click',
  // 「요약·비교」 (chathub batch 1, C5): the page reports the judge as a provider id (`judge`), never
  // the prompt or the answer — the same caps as every other event apply.
  'summarize',
  // Beta reset (cmp-beta contract): the page reports a successful COMPARE_RESET.
  'quota_reset',
  // Focus mode (2026-09-21): a column widened (`on: 1`) / the grid restored (`on: 0`), with the provider id.
  'col_focus',
  // Service picker (2026-09-21): a pre-session column swapped to another service (`from`, `to` provider ids).
  'provider_change',
  // Gemini <FollowUp> chips (#1572): a chip filled that column's input (`provider` only). The page
  // emitted this under a `cmp_` name the allow-list never held (1.32.2 batch review 후속 1).
  'followup_chip',
  // Column layout (#1525): a column was added / removed / swapped to another (provider, model)
  // before the session (`col`, `n`). Emitted since #1525 but never added here, so the SW dropped
  // all three silently (#1525 후속 3).
  'column_add', 'column_remove', 'column_change',
]);
export const COMPARE_EVENT_PREFIX = 'cmp_';

// Usage stats (cmp-beta contract §1/§2): what a consume says it is. The page decides; anything
// outside this list — or an older page that says nothing — is derived in runSend.
export const COMPARE_KINDS = Object.freeze(['send', 'followup', 'summary', 'retry', 'resume']);
// Bounds on what the consume / outcome bodies carry (the server validates the same caps; a body
// that exceeds them would be refused, and a refused consume is a send that never happens).
export const ROUND_MAX = 9999;
export const EXT_VERSION_MAX = 16;
export const OUTCOME_MODEL_MAX = 64;
export const OUTCOME_CODE_MAX = 32;
// The shape of a model id that may leave the browser (consume `models`, outcome `model`): every
// catalog id is one of these — `claude-opus-4-8`, Gemini's hex hashes (`e051ce1aa80aa576`),
// ChatGPT slugs with dots or hyphens (`gpt-5-5`, `gpt-5.5`) — and nothing a page, a storage row or
// a provider could report as an id is private text unless it is NOT one of these (an email, a URL,
// a sentence). A non-matching id is OMITTED, never truncated (a cut string is still that text)
// and never null (null means Auto) — Codex cmp-beta SW 1R #1.
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// The page's opaque session id (contract §5): the id its history entry uses, forwarded to consume
// as `session_id` so the rows of one conversation can be grouped. Shape-checked, else omitted.
export const SESSION_ID_RE = /^[A-Za-z0-9-]{8,40}$/;
/** A model id that may go on the wire, or null when it must not (see MODEL_ID_RE). */
export function wireModelId(v) {
  return typeof v === 'string' && v.length <= OUTCOME_MODEL_MAX && MODEL_ID_RE.test(v) ? v : null;
}
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
// Third field, same file: the 「요약·비교」 button on compare.html (chathub batch 1, C5). Like `cta`
// it needs `compare` too (the button lives on the page), and missing / non-boolean = false, so
// the feature ships dark and is switched on — or killed — by editing flags.json, no release.
// Answered as COMPARE_FLAG.summary and COMPARE_STATUS.summaryOn.
export const COMPARE_SUMMARY_FLAG_FIELD = 'compare_summary';
export const COMPARE_FLAG_CACHE_KEY = 'ct_compare_flag';
export const COMPARE_FLAG_TTL_MS = 60 * 60 * 1000;
// A cache row stamped in the future is not ours: `at` comes from Date.now() at write time, so
// anything beyond a small clock skew was hand-written (a "force on for a year" row from a
// dark-launch test, 2026-09-21) — such a row would never expire and would freeze every gate it
// lacks. Beyond this skew the row is a miss and the flags are fetched again.
export const COMPARE_FLAG_FUTURE_SKEW_MS = 5 * 60 * 1000;

// Server-provided example prompts for the page's empty state (2026-09-21, #1517): the same CDN,
// the same 1h TTL cache and the same fail-safe as the flags — `{v:1, ko:[{q, tag}], en:[{q, tag}]}`
// (cdn/compare-examples.json, published by scripts/publish-compare-examples.sh). Validated here
// (sanitizeCompareExamples) before anything is cached or answered: a language keeps at most
// COMPARE_EXAMPLES_MAX items, each `q` a trimmed string of 1..COMPARE_EXAMPLES_Q_MAX chars, `tag`
// `[a-z]{1,16}` else 'other'; a language with fewer than COMPARE_EXAMPLES_MIN valid items is
// omitted; any fetch/parse failure or a wrong `v` = null — the page falls back to its built-in
// chips. Answered in COMPARE_STATUS as `examples` ({ko?, en?} | null), fetched IN PARALLEL with
// the other status parts and capped by COMPARE_EXAMPLES_TIMEOUT_MS so a slow CDN never delays
// status (the fetch keeps going and fills the cache for the next one). Never on the send path.
export const COMPARE_EXAMPLES_URL = 'https://cdn.claudetuner.com/compare-examples.json';
export const COMPARE_EXAMPLES_CACHE_KEY = 'ct_compare_examples';
export const COMPARE_EXAMPLES_TTL_MS = 60 * 60 * 1000;
export const COMPARE_EXAMPLES_TIMEOUT_MS = 3000;
// Byte caps on what the two CDN fetches will DECODE (Codex examples 1R #1): the body is read
// through a reader with a running counter and dropped past the cap — never `res.json()` on an
// unbounded body. The live documents are ~5 KB (examples) and well under 1 KB (flags).
export const COMPARE_EXAMPLES_MAX_BYTES = 64 * 1024;
export const COMPARE_FLAG_MAX_BYTES = 4 * 1024;
// Deadline on the flags fetch itself (the examples fetch uses COMPARE_EXAMPLES_TIMEOUT_MS): the
// shared in-flight promise is aborted and cleared past it, so the next caller can retry.
export const COMPARE_FLAG_TIMEOUT_MS = 5000;
export const COMPARE_EXAMPLES_VERSION = 1;
export const COMPARE_EXAMPLES_LANGS = Object.freeze(['ko', 'en']);
export const COMPARE_EXAMPLES_MAX = 30;
export const COMPARE_EXAMPLES_MIN = 3;
export const COMPARE_EXAMPLES_Q_MAX = 300;
const COMPARE_EXAMPLES_TAG_RE = /^[a-z]{1,16}$/;

/**
 * The validated `{ko?: [{q, tag}], en?: [{q, tag}]}` from an untrusted compare-examples body, or
 * null when it is not a v1 document or no language survives. Pure; never throws.
 */
export function sanitizeCompareExamples(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || json.v !== COMPARE_EXAMPLES_VERSION) return null;
  const out = {};
  for (const lang of COMPARE_EXAMPLES_LANGS) {
    const list = json[lang];
    if (!Array.isArray(list)) continue;
    const items = [];
    // Only the first COMPARE_EXAMPLES_MAX entries are even LOOKED at (Codex examples 1R #1): a
    // 100k-item array costs the same as a 30-item one; invalid entries inside the window are
    // dropped (not skipped over), so the answer is never more than the window's valid entries.
    for (const item of list.slice(0, COMPARE_EXAMPLES_MAX)) {
      if (!item || typeof item !== 'object') continue;
      const q = typeof item.q === 'string' ? item.q.trim() : '';
      if (!q || q.length > COMPARE_EXAMPLES_Q_MAX) continue;
      const tag = typeof item.tag === 'string' && COMPARE_EXAMPLES_TAG_RE.test(item.tag) ? item.tag : 'other';
      items.push({ q, tag });
    }
    if (items.length >= COMPARE_EXAMPLES_MIN) out[lang] = items;
  }
  return Object.keys(out).length ? out : null;
}

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
// Prefix of kept Claude conversation titles (package v0.5.2 `titlePrefix`).
export const CLAUDE_TITLE_PREFIX = '[C.T.] ';
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
  STALLED: 'stalled',               // outcome `code` on a DONE{stalled:true} column (ok stays true — the text arrived)
  CUT_ERROR: 'stream_error',        // same, but the PROVIDER said it failed mid-answer (package `partial`) — see cutKindOf
  ABORTED: 'aborted',
  UNKNOWN: 'unknown',
  STATUS_UNAVAILABLE: 'status_unavailable', // COMPARE_RESET: the reset succeeded, the status re-read did not
});

// The TWO kinds of cut the page has to tell apart, and the only values `DONE.cutReason` ever
// carries (#1527). The vendored clients report `partial: true` with a free-text `cutReason` whose
// error form ends in the PROVIDER's own message; this is its bounded projection.
//
// 🔴 The free text never leaves this worker. It is not something to paint (length, language and
// trustworthiness are all unguaranteed) and not something to put in an outcome row (`code` is a
// closed vocabulary the server groups on). It goes to this worker's console and nowhere else.
// How much of the provider's own message the console keeps. Diagnostics only.
const CUT_REASON_LOG_MAX = 200;
export const CUT_STALLED = 'stalled';
export const CUT_STREAM_ERROR = 'stream_error';

/**
 * Which cut, if any, the CLIENT reported on a completed send — `null` when the answer is whole.
 * Distinct from the stall watchdog below, which is this module noticing silence; this is the
 * provider (or the page script's own deadline) saying the stream ended early.
 */
/**
 * The detail a DIAG may carry to the PAGE. Everything passes through unchanged except the one
 * stage whose detail is not ours: `stream_cut.reason` is the package's free-text cut reason, and
 * its error form embeds the provider's own message. The page gets the same bounded kind `DONE`
 * carries; the SW console keeps the raw line (see onDiag).
 */
export function pageSafeDiag(stage, detail) {
  if (stage !== 'stream_cut') return detail;
  const raw = String(detail?.reason || '');
  return { ...detail, reason: raw.startsWith('stream_error') ? CUT_STREAM_ERROR : CUT_STALLED };
}

export function cutKindOf(result) {
  if (!result || result.partial !== true) return null;
  return String(result.cutReason || '').startsWith('stream_error') ? CUT_STREAM_ERROR : CUT_STALLED;
}

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
// Keys (cmp-columns): a colId (`provider:model` / `provider:auto`) or, LEGACY, a bare provider id
// (→ `${provider}:auto`); unknown keys dropped; at most MAX_COLUMNS entries. The result is keyed
// by colId only.
export function sanitizeResumeMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw)) { // own entries only (Codex ux3 SW 1R #3)
    if (Object.keys(out).length >= MAX_COLUMNS) break;
    const col = parseColumnId(key);
    if (!col) continue;
    const c = raw[key];
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const keys = Object.keys(c);
    if (keys.length > RESUME_MAX_KEYS) continue;
    const clean = {};
    for (const k of keys) {
      const v = c[k];
      if (typeof v === 'string' && v.length <= RESUME_MAX_VALUE_CHARS && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k)) clean[k] = v;
    }
    if (Object.keys(clean).length && !Object.hasOwn(out, col.id)) out[col.id] = clean;
  }
  return out;
}

/**
 * A colId — or a LEGACY bare provider id — parsed into `{ id, provider, model }` (model null =
 * the provider's default), or null when it names no known provider / carries an id that is not
 * a model id's shape (MODEL_ID_RE). Pure.
 */
export function parseColumnId(raw) {
  if (typeof raw !== 'string') return null;
  const at = raw.indexOf(':');
  const provider = at < 0 ? raw : raw.slice(0, at);
  if (!COMPARE_PROVIDERS.includes(provider)) return null;
  const rest = at < 0 ? COLUMN_AUTO : raw.slice(at + 1);
  if (rest === COLUMN_AUTO || rest === '') return { id: columnId(provider, null), provider, model: null };
  const model = wireModelId(rest);
  return model === null ? null : { id: columnId(provider, model), provider, model };
}

/**
 * The columns of a round from an untrusted SEND/FOLLOWUP (cmp-columns contract §2), in order:
 * `{ columns: [{id, provider, model}], code: null }` or `{ columns: [], code }` when the message
 * must be refused (`bad_request`: a duplicate colId, more than MAX_COLUMNS, or a column whose
 * `id` does not have a colId's shape for its provider; `no_targets`: nothing usable). Sources, in
 * precedence: `message.columns` (`[{id, provider, model?}]`, the page's layout — the id is the
 * page's and authoritative, derived only when absent; with `targets` beside it, only the named
 * colIds are sent to); else `message.targets` — colIds,
 * or LEGACY bare provider ids as `${provider}:auto` on `selectedModels[provider]` (the stored
 * model choice, so an older page keeps today's behaviour). Unknown entries are dropped. Pure.
 */
export function resolveColumns(message, selectedModels = {}) {
  const raw = Array.isArray(message?.columns) && message.columns.length ? message.columns : null;
  const columns = [];
  const seen = new Set();
  const legacySeen = new Set(); // bare provider ids already mapped (deduped silently, as before)
  const list = raw ?? (Array.isArray(message?.targets) ? message.targets : []);
  for (const entry of list) {
    let col = null;
    if (raw) {
      const provider = entry && typeof entry === 'object' ? entry.provider : null;
      if (!COMPARE_PROVIDERS.includes(provider)) continue;
      const model = typeof entry.model === 'string' && entry.model.trim() ? wireModelId(entry.model.trim()) : null;
      if (typeof entry.model === 'string' && entry.model.trim() && model === null) continue; // an id that is not one
      // 🔴 The page's `id` is AUTHORITATIVE (Codex integration #1): a column keeps its id for the
      // whole session while its MODEL may change (an in-session pick on `claude:auto` → sonnet must
      // reuse `claude:auto`'s client and conversation, and route its events under that id — never
      // spawn a `claude:claude-sonnet-5` sibling or borrow one). `model` is a separate field used
      // only for the send. The id must have a colId's shape and name THIS provider; a mismatch is a
      // bad_request. Only an entry without an id (an older page) gets its id derived.
      let id = null;
      if (entry.id !== undefined) {
        const parsed = parseColumnId(entry.id);
        if (!parsed || parsed.provider !== provider || typeof entry.id !== 'string' || !entry.id.includes(':')) return { columns: [], code: 'bad_request' };
        id = parsed.id;
      } else {
        id = columnId(provider, model);
      }
      col = { id, provider, model };
    } else if (COMPARE_PROVIDERS.includes(entry)) {
      // LEGACY bare provider id: today's column on the stored choice. Repeated bare ids are
      // deduped silently, as uniqueKnownProviders always did (a bare id next to its own colId
      // is not that case — it is a duplicate column, refused below).
      if (legacySeen.has(entry)) continue;
      legacySeen.add(entry);
      const model = typeof selectedModels?.[entry] === 'string' && selectedModels[entry] ? wireModelId(selectedModels[entry]) : null;
      col = { id: columnId(entry, null), provider: entry, model };
    } else {
      col = parseColumnId(entry);
      if (!col) continue;
    }
    if (seen.has(col.id)) return { columns: [], code: 'bad_request' };
    seen.add(col.id);
    columns.push(col);
    if (columns.length > MAX_COLUMNS) return { columns: [], code: 'bad_request' };
  }
  // A FOLLOWUP carries the whole layout in `columns[]` and names the columns to send to in
  // `targets` (colIds); with both present only the named columns are sent to (layout order).
  const only = raw && Array.isArray(message?.targets) && message.targets.length ? new Set(message.targets.filter((t) => typeof t === 'string')) : null;
  const chosen = only ? columns.filter((c) => only.has(c.id)) : columns;
  return chosen.length ? { columns: chosen, code: null } : { columns: [], code: SW_CODES.NO_TARGETS };
}

// A `models` event param (`provider:id,provider:id` — `provider:auto` / `provider:` for Auto, as the
// page writes it) rebuilt from the pairs whose provider is known and whose id passes MODEL_ID_RE;
// null when nothing survives or the input is not a string. Order kept, pairs never rewritten.
export function gateModelsCsv(v) {
  if (typeof v !== 'string') return null;
  const kept = [];
  for (const pair of v.split(',')) {
    const at = pair.indexOf(':');
    if (at < 0) continue;
    const provider = pair.slice(0, at);
    const id = pair.slice(at + 1);
    if (!COMPARE_PROVIDERS.includes(provider)) continue;
    if (id === '' || id === 'auto' || wireModelId(id) !== null) kept.push(pair);
  }
  return kept.length ? kept.join(',') : null;
}

// A COMPARE_EVENT's `{ name, params }` from untrusted input → `{ name, params }` for the GA
// sender, or null when it must be dropped: a name outside COMPARE_EVENT_NAMES, params that are
// not a plain object (absent = `{}`), or more than COMPARE_EVENT_MAX_PARAMS entries. Inside the
// cap, an entry with a bad key or a non-string/number/boolean value is dropped on its own;
// strings are cut at COMPARE_EVENT_MAX_STRING. Never throws.
// GA boundary (contract §5, integration review): two params carry model ids the page got from a
// provider or from storage — `models` (csv of `provider:id` pairs, the send event) and `model`
// (one id, column_done). Each id must pass MODEL_ID_RE here, whatever the page did: a pair with a
// bad id is dropped from the csv (an empty csv drops the key), a bad single id drops the key.
// The SW is the last line before GA — the page validates too, but a page that forgets must not
// ship an email or a URL as a "model".
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
    if (k === 'models' || k === 'model' || k === 'col') {
      // `col` (cmp-columns) is a colId — kept WHOLE (`provider:model`, never reduced to the
      // provider) when it has the shape; anything else is dropped.
      const gated = k === 'models' ? gateModelsCsv(v) : (k === 'col' ? (parseColumnId(v)?.id ?? null) : wireModelId(v));
      if (gated !== null) clean[k] = gated.slice(0, COMPARE_EVENT_MAX_STRING);
      continue;
    }
    if (typeof v === 'string') clean[k] = v.slice(0, COMPARE_EVENT_MAX_STRING);
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') clean[k] = v;
  }
  return { name: COMPARE_EVENT_PREFIX + name, params: clean };
}

// ── Question signals (#1562) ────────────────────────────────────────────────────────────
// What the consume body may say ABOUT a question, never the question. The decision (2026-09-21)
// was NOT to collect question text: the extension's position is "usage metrics only, we never read
// your conversations", and shipping prompt text would make that false for every user at once.
// These five derived facts answer the product questions ("is it used for code? by non-Korean
// speakers? are people pasting documents?") while being one-way: a bucket, a script name and three
// booleans cannot be turned back into a question.
//
// Each value is computed HERE, in the SW, from the text runSend already holds, and is BOUNDED by
// construction — a bucket floor from a fixed list, a script id from a fixed list, 0/1 — so no
// free text can reach the wire through this path even if `text` is hostile. `questionSignals` is
// pure and exported so test/compare-send-order-guard.mjs can pin the mapping directly.
// Buckets are DESCENDING floors: the reported value is the floor of the bucket the number falls in
// (a 300-character question reports 200, i.e. "200-999"), so the wire never carries an exact size.
export const Q_LEN_BUCKETS = Object.freeze([4000, 1000, 200, 50, 0]);
export const Q_LINE_BUCKETS = Object.freeze([20, 5, 2, 1]);
// The scripts the signal can report. `other` covers everything unlisted AND a text with no letters
// at all (digits, punctuation, emoji) — "we could not tell", not a claim about the language.
export const Q_SCRIPTS = Object.freeze(['ko', 'ja', 'zh', 'latin', 'cyrillic', 'arabic', 'deva', 'other']);
// A question longer than this is measured up to the cap only: the buckets top out at 4000 anyway,
// so scanning a megabyte of pasted text per send would buy nothing.
const Q_SCAN_MAX = 20000;
// Looks-like-code: a fenced block, a line that ends the way code lines do, or a line that opens
// with a keyword IN ITS CODE SHAPE (`function f(`, `def f(`, `const x =`, `import … from`,
// `SELECT … FROM`) — a bare keyword list fired on English (`return my money`, Codex 1R #1), and
// the heuristic is meant to read the shape of the text, not its words. Coarse on purpose — a
// false positive costs a slightly wrong ratio, and the alternative (sending the text to find out)
// is the thing we decided against.
// 🔴 COST IS BOUNDED BY STRUCTURE, not by regex care: this runs synchronously in the SW right
// before consume, and two drafts of a single /m regex over the whole text were each super-linear
// on a shape nobody had thought of (a newline run — 608ms; a CR run — `^` matches after `\r` too;
// then `import` + 2,000 spaces — 1.56s from `\s+[^\r\n]+\s+` all eating the same spaces; Codex
// 1R #2 / 2R). So: the text is split into lines on EVERY JS line terminator (what `^`/m means),
// at most Q_CODE_LINES_MAX of them are looked at, the opener regex sees at most Q_CODE_OPEN_MAX
// characters of a line, and the ending check is a trimEnd + last-char test. Whatever the regex
// does, it does it on ≤ 120 characters, ≤ 400 times.
const Q_LINE_BREAK_RE = /\r\n|[\r\n\u2028\u2029]/;
const Q_CODE_LINES_MAX = 400;
const Q_CODE_OPEN_MAX = 120;
const Q_CODE_OPEN_RE = /^[ \t]*(?:function\b[^(]{0,40}\(|def[ \t]+\w+[ \t]*\(|(?:const|let|var)[ \t]+\w+[ \t]*=|import[ \t]+\S.{0,100}?\bfrom[ \t]+['"]|#include[ \t]*[<"]|<\?php|SELECT[ \t]+\S.{0,100}?\bFROM\b)/;
const Q_CODE_END_RE = /[{};]$/;
function looksLikeCode(text) {
  if (text.includes('```')) return true;
  for (const line of text.split(Q_LINE_BREAK_RE, Q_CODE_LINES_MAX)) {
    if (Q_CODE_END_RE.test(line.trimEnd())) return true;
    if (Q_CODE_OPEN_RE.test(line.length > Q_CODE_OPEN_MAX ? line.slice(0, Q_CODE_OPEN_MAX) : line)) return true;
  }
  return false;
}
const Q_URL_RE = /\bhttps?:\/\/\S|\bwww\.\S/i;
// Removed before the script count ONLY (the flags above are read from the original): a URL and a
// fenced block are latin characters that say nothing about the language the user writes in — left
// in, 「이 링크 요약해줘 https://…」 reports `latin` and the "do non-Korean speakers use this"
// question gets the wrong answer.
const Q_SCRIPT_STRIP_RE = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const Q_SCRIPT_RE = Object.freeze({
  hangul: /[가-힣ᄀ-ᇿ㄰-㆏]/g,
  kana: /[぀-ゟ゠-ヿ]/g,
  han: /[一-鿿㐀-䶿]/g,
  latin: /[A-Za-zÀ-ɏ]/g,
  cyrillic: /[Ѐ-ӿ]/g,
  arabic: /[؀-ۿ]/g,
  deva: /[ऀ-ॿ]/g,
});

/**
 * Code points in `text`, counted only up to `cap` (the top bucket floor — past it every count
 * buckets the same, so nothing more is learned). A UTF-16 unit count of 2·cap or more is at least
 * `cap` code points without a scan; below that the walk is bounded by 2·cap units. `[...text]` on
 * the whole input built an array of every code point (≈179 MB for a 5M-emoji paste, Codex 1R #2).
 */
function codePointsUpTo(text, cap) {
  if (text.length >= cap * 2) return cap;
  let n = 0;
  for (const _ of text) if (++n >= cap) return cap;
  return n;
}

/** The bucket floor `n` falls in, from DESCENDING floors; the last floor for anything below. */
function bucketFloor(n, floors) {
  for (const floor of floors) if (n >= floor) return floor;
  return floors[floors.length - 1];
}
const countOf = (text, re) => (text.match(re) || []).length;

/**
 * Content-free signals for one question, or null when there is no text to describe.
 * `{ q_len, q_script, q_lines, q_code, q_url }` — bucket floor, script id, bucket floor, 0|1, 0|1.
 * Length and line count are measured on the TRIMMED text in code points (a pasted document is
 * lines, an emoji is one character), so the numbers mean what their names say. The script is read
 * from the PROSE only (URLs and fenced code removed — see Q_SCRIPT_STRIP_RE).
 */
export function questionSignals(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const scanned = trimmed.length > Q_SCAN_MAX ? trimmed.slice(0, Q_SCAN_MAX) : trimmed;
  const prose = scanned.replace(Q_SCRIPT_STRIP_RE, ' ');
  const counts = {
    hangul: countOf(prose, Q_SCRIPT_RE.hangul),
    kana: countOf(prose, Q_SCRIPT_RE.kana),
    han: countOf(prose, Q_SCRIPT_RE.han),
    latin: countOf(prose, Q_SCRIPT_RE.latin),
    cyrillic: countOf(prose, Q_SCRIPT_RE.cyrillic),
    arabic: countOf(prose, Q_SCRIPT_RE.arabic),
    deva: countOf(prose, Q_SCRIPT_RE.deva),
  };
  // Kana and Han are ONE bucket for the comparison (Japanese prose mixes them), split afterwards:
  // any kana at all means Japanese — Chinese text has none.
  const groups = [
    ['ko', counts.hangul],
    [counts.kana > 0 ? 'ja' : 'zh', counts.kana + counts.han],
    ['latin', counts.latin],
    ['cyrillic', counts.cyrillic],
    ['arabic', counts.arabic],
    ['deva', counts.deva],
  ];
  let script = 'other';
  let best = 0;
  for (const [id, n] of groups) if (n > best) { script = id; best = n; }
  return {
    q_len: bucketFloor(codePointsUpTo(trimmed, Q_LEN_BUCKETS[0]), Q_LEN_BUCKETS),
    q_script: script,
    q_lines: bucketFloor(scanned.split('\n').length, Q_LINE_BUCKETS),
    q_code: looksLikeCode(scanned) ? 1 : 0,
    q_url: Q_URL_RE.test(scanned) ? 1 : 0,
  };
}

// The `POST /api/compare/consume` body (cmp-beta contract §2) from what runSend resolved: `kind`
// as the page said it (COMPARE_KINDS) or derived from the message shape; `targets` = the READY
// providers; `models` = each one's resolved model (id|null — the key OMITTED when the id fails
// MODEL_ID_RE, since null would say Auto); `round` only when a valid
// integer; `src` only when a known provider; `session_id` only when the page's `session` has the
// SESSION_ID_RE shape (contract §5); `ext_version` only when readable; `q_*` the question's
// content-free signals (questionSignals) for a round that carries a user question — omitted for
// 'summary', whose text the page composes, so the statistics describe what USERS type. Plain
// data — never an email, never the question text — and pure, so the guard can pin its shape.
export function buildConsumeBody({ kind, followup, resumeAsked, src, session, ready, models, round, extVersion, text }) {
  const derived = followup ? 'followup' : (resumeAsked ? 'resume' : 'send');
  // `ready` = the round's colIds (cmp-columns: `provider:model` / `provider:auto`), ≤ MAX_COLUMNS.
  const body = { kind: COMPARE_KINDS.includes(kind) ? kind : derived, targets: ready.slice(0, MAX_COLUMNS), models: {} };
  for (const p of body.targets) {
    const m = models?.[p];
    if (m === null || m === undefined) { body.models[p] = null; continue; }
    const id = wireModelId(m);
    if (id !== null) body.models[p] = id;
  }
  if (Number.isInteger(round) && round >= 0 && round <= ROUND_MAX) body.round = round;
  if (COMPARE_PROVIDERS.includes(src)) body.src = src;
  if (typeof session === 'string' && SESSION_ID_RE.test(session)) body.session_id = session;
  if (typeof extVersion === 'string' && extVersion) body.ext_version = extVersion.slice(0, EXT_VERSION_MAX);
  const signals = body.kind === 'summary' ? null : questionSignals(text);
  if (signals) Object.assign(body, signals);
  return body;
}

// The `results` half of the outcome body, bounded: colId keys only (≤ MAX_COLUMNS),
// `ok` a boolean, `code` a cut string, `model` only when it has a model id's shape (MODEL_ID_RE —
// omitted otherwise, never cut), the two durations non-negative integers. Anything
// else is dropped rather than sent — the server refuses an unbounded body and an outcome is
// telemetry, not the send.
export function sanitizeOutcomeResults(results) {
  const out = {};
  if (!results || typeof results !== 'object') return out;
  // Keys are colIds (`provider:model` / `provider:auto`) or LEGACY bare provider ids, at most
  // MAX_COLUMNS of them; anything else is dropped.
  for (const key of Object.keys(results)) {
    if (Object.keys(out).length >= MAX_COLUMNS) break;
    const p = parseColumnId(key) ? key : null;
    if (p === null) continue;
    const r = results[p];
    if (!r || typeof r !== 'object' || typeof r.ok !== 'boolean') continue;
    const clean = { ok: r.ok };
    if (typeof r.code === 'string' && r.code) clean.code = r.code.slice(0, OUTCOME_CODE_MAX);
    const model = wireModelId(r.model);
    if (model !== null) clean.model = model;
    for (const k of ['ttft_ms', 'total_ms']) {
      if (typeof r[k] === 'number' && Number.isFinite(r[k]) && r[k] >= 0) clean[k] = Math.round(r[k]);
    }
    out[p] = clean;
  }
  return out;
}

const JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json' });

// What an ERROR tells the page beyond `code`: the client's machine-readable `reason` (a no_tab's
// cause, package v0.2.3) and its developer-facing message as `detail`. Absent fields are omitted,
// not sent as null, so the page's `msg.reason` reads undefined either way.
// `diag` (package v0.5.4): a client's free-form diagnostic line for a failure its code cannot
// explain — Gemini `empty_response` carries `empty:env=…,bytes=…,cand=…,codes=…,ctx=…` — forwarded
// bounded (ERROR_DIAG_MAX) beside `detail` (which already carries the same line inside the
// message, plus the elided stream head). The page may show it; the SW log line names it.
export const ERROR_DIAG_MAX = 200;
// Privacy (Codex layout 2R #2): the vendored gemini-client's empty-response message ends with
// ` head=<elided raw stream>`, and that head still keeps quoted strings of up to 40 chars — a
// short answer or prompt fragment could ride `detail` into the page's tooltip. Everything from
// the head marker on is stripped here before forwarding; the compact `(empty:…)` line stays. The
// package's own console.warn keeps the head (the user's own SW console). 🔴 A structural
// redaction on the package side (the head as its own field the host never forwards) is the
// proper fix — #1521 follow-up; this strip is the host-side belt until then.
export const ERROR_DETAIL_HEAD_MARKER = ' head=';
function stripStreamHead(detail) {
  const at = detail.indexOf(ERROR_DETAIL_HEAD_MARKER);
  return at < 0 ? detail : detail.slice(0, at);
}
function errorExtras(e) {
  const out = {};
  if (typeof e?.reason === 'string' && e.reason) out.reason = e.reason;
  const raw = typeof e?.message === 'string' ? e.message : (e == null ? '' : String(e));
  const detail = stripStreamHead(raw);
  if (detail) out.detail = detail;
  if (typeof e?.diag === 'string' && e.diag) out.diag = e.diag.slice(0, ERROR_DIAG_MAX);
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

// A JSON response body decoded under a byte cap: `{ json }` or `{ oversized: true }`. The cap is
// applied BEFORE parsing — Content-Length first, then the streamed bytes through a running
// counter (the read is cancelled the moment it passes the cap) — so a hostile or broken CDN
// answer never reaches JSON.parse whole. A response without a streaming body (an older runtime,
// a test fake) is read as text and measured the same way. Throws on malformed JSON (callers
// treat that as a failure like any other).
export async function readJsonBounded(res, maxBytes) {
  const declared = Number(res?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Refused unread — and the body released, so the connection is not left draining (Codex 2R #2).
    try { await res?.body?.cancel?.(); } catch { /* nothing to release */ }
    return { oversized: true };
  }
  const reader = typeof res?.body?.getReader === 'function' ? res.body.getReader() : null;
  if (reader) {
    // ONE streaming decoder for the whole body (Codex 2R #1): a multi-byte UTF-8 sequence split
    // across two chunks must not become U+FFFD — `{stream:true}` carries the partial sequence to
    // the next chunk, and the final flush closes it. The byte counter stays on the RAW bytes.
    const decoder = new TextDecoder('utf-8');
    let text = '';
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const size = value?.byteLength ?? value?.length ?? 0;
      received += size;
      if (received > maxBytes) {
        try { await reader.cancel(); } catch { /* the read is over either way */ }
        return { oversized: true };
      }
      text += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { json: JSON.parse(text) };
  }
  const text = typeof res?.text === 'function' ? await res.text() : JSON.stringify(await res.json());
  if (new TextEncoder().encode(text).length > maxBytes) return { oversized: true };
  return { json: JSON.parse(text) };
}

// A CDN fetch with a deadline: `fetchImpl(url, { signal })` aborted after `ms`. The timer is
// cleared once the response has been handled either way. `cache: 'no-store'` because the CDN JSON
// files carry no Cache-Control: Chrome's heuristic HTTP cache (Last-Modified-based) otherwise kept
// a pre-flip flags.json for hours (2026-09-21, options page stayed hidden after compare_cta flip);
// the storage-side TTLs (COMPARE_FLAG_TTL_MS etc.) are the only caching we mean to have.
function fetchWithDeadline(fetchImpl, url, ms, handle) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return Promise.resolve()
    .then(() => fetchImpl(url, { signal: ac.signal, cache: 'no-store' }))
    .then((res) => handle(res))
    .finally(() => clearTimeout(timer));
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
 * @param {object} [deps.management] — chrome.management (only `getSelf()` is used, which needs no
 *   permission): the dev-only probe runs only when `installType === 'development'`; absent = never
 * @param {object} deps.tabs, deps.scripting, deps.cookies, deps.runtime — chrome namespaces, handed
 *   to the clients as-is; `tabs.create` is used here ONLY to open our own compare page;
 *   `runtime.getManifest()` (optional) supplies the consume body's `ext_version`
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
 * @param {number} [deps.streamStallMs] — defaults to STREAM_STALL_MS (tests shorten it)
 * @param {number} [deps.probeDisposeTimeoutMs] — defaults to PROBE_DISPOSE_TIMEOUT_MS (tests shorten it)
 * @param {number} [deps.listModelsTimeoutMs] — defaults to LIST_MODELS_TIMEOUT_MS (tests shorten it)
 * @param {number} [deps.examplesTimeoutMs] — defaults to COMPARE_EXAMPLES_TIMEOUT_MS (tests shorten it)
 * @param {number} [deps.flagTimeoutMs] — defaults to COMPARE_FLAG_TIMEOUT_MS (tests shorten it)
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
  management = null,
  // `pro: boolean => Promise<void>` — the SW's entitlement-cache write-through, background.js
  // syncEntitlementFromCompare, plan compare-quota-premium §2. Called on a SUCCESSFUL status read
  // only, awaited so the page's status answer lands after the cache moved, never allowed to throw
  // into the status. Optional: the package / a test harness without it reads the quota as before.
  // No parentheses in comments inside this parameter list: ext-import-refs-guard stops at the first closing paren.
  syncEntitlement = null,
  readCollectedOrgs, planLabel, sendGAEvent,
  drainPendingHides = null,
  fetch: fetchImpl = (...a) => globalThis.fetch(...a),
  now = () => Date.now(),
  setTimeout: setTimeoutImpl = (fn, ms) => globalThis.setTimeout(fn, ms),
  drainDelayMs = DRAIN_STARTUP_DELAY_MS,
  sendTimeoutMs = PROVIDER_SEND_TIMEOUT_MS,
  streamStallMs = STREAM_STALL_MS,
  probeDisposeTimeoutMs = PROBE_DISPOSE_TIMEOUT_MS,
  listModelsTimeoutMs = LIST_MODELS_TIMEOUT_MS,
  examplesTimeoutMs = COMPARE_EXAMPLES_TIMEOUT_MS,
  flagTimeoutMs = COMPARE_FLAG_TIMEOUT_MS,
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
    // `titlePrefix` (package v0.5.2): a KEPT Claude conversation is titled by claude.ai's own title
    // endpoint after its first answer and renamed `[C.T.] <title>` — the sidebar no longer reads
    // 「Claude Tuner」 for every compare (user request 2026-09-18). No effect on temporary ones.
    ...(provider === 'claude' ? { webSearch: true, titlePrefix: CLAUDE_TITLE_PREFIX } : {}),
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

  // ── Usage stats (server-side, cmp-beta contract) ─────────────────────────────────────────
  // The manifest version for the consume body — through the injected `runtime`, never `chrome`;
  // null when the namespace cannot say (a test fake, a runtime that throws).
  function manifestVersion() {
    try {
      const v = runtime?.getManifest?.()?.version;
      return typeof v === 'string' && v ? v : null;
    } catch { return null; }
  }
  // `POST /api/compare/outcome {event_id, results}` — fire-and-forget: not awaited by the send,
  // every failure swallowed (the round is over; nothing the page could do with it). Only ever
  // called by a session that holds an integer `event_id` from its own consume 200 (settleOutcome).
  function postOutcome(eventId, results) {
    if (!Number.isInteger(eventId) || eventId <= 0) return false;
    const body = JSON.stringify({ event_id: eventId, results: sanitizeOutcomeResults(results) });
    Promise.resolve()
      .then(async () => {
        const config = await getConfig();
        await authedFetch(config, `${config.serverUrl}/api/compare/outcome`, { method: 'POST', headers: { ...JSON_HEADERS }, body });
      })
      .catch(() => { /* telemetry */ });
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
      // Only a row THIS writer could have produced is a hit: all three booleans present and `at`
      // within (now - TTL, now + skew]. A row missing a field (an older writer, a hand edit) or
      // stamped in the future is a MISS and the flags are fetched again — never "false until the
      // TTL", which for a future-stamped row meant never (2026-09-21: a hand-written
      // {on:true, at:<+1y>} row hid the strip button and 「요약·비교」 for good).
      // `cta` / `summary` are read as conjunctions with `on` (Codex batch-1 #5): a row written as
      // {on:false, summary:true} must not answer a gate the page itself does not have.
      if (cached && typeof cached.on === 'boolean' && typeof cached.cta === 'boolean' && typeof cached.summary === 'boolean' && typeof cached.at === 'number') {
        const age = now() - cached.at;
        if (age < COMPARE_FLAG_TTL_MS && age > -COMPARE_FLAG_FUTURE_SKEW_MS) return { on: cached.on, cta: cached.on && cached.cta === true, summary: cached.on && cached.summary === true };
      }
    } catch { /* unreadable cache = miss */ }
    return null;
  }
  async function writeFlagCache(flags) {
    try { await storage.set({ [COMPARE_FLAG_CACHE_KEY]: { on: flags.on === true, cta: flags.cta === true, summary: flags.summary === true, at: now() } }); } catch { /* best effort */ }
  }
  // FAIL-SAFE like fetchFolderAvailable: any fetch/parse error, non-2xx or a missing/invalid
  // `compare` field reads as dark. A network error does not poison the cache. Neither `cta` nor
  // `summary` can be true while `on` is false (both are buttons that need the page).
  const DARK = Object.freeze({ on: false, cta: false, summary: false });
  async function fetchCompareFlags() {
    const cached = await readFlagCache();
    if (cached !== null) return cached;
    if (!flagInFlight) {
      flagInFlight = (async () => {
        try {
          // Deadline + byte cap (Codex examples 1R): an oversized body is dark like a non-2xx, an
          // aborted fetch throws into the catch below and clears the in-flight slot for a retry.
          const { json, oversized } = await fetchWithDeadline(fetchImpl, FLAGS_URL, flagTimeoutMs, async (res) => (res.ok ? readJsonBounded(res, COMPARE_FLAG_MAX_BYTES) : { json: null, oversized: false }));
          if (oversized || json === null) { await writeFlagCache(DARK); return DARK; }
          const on = !!(json && json[COMPARE_FLAG_FIELD] === true);
          const flags = {
            on,
            cta: on && !!(json && json[COMPARE_CTA_FLAG_FIELD] === true),
            summary: on && !!(json && json[COMPARE_SUMMARY_FLAG_FIELD] === true),
          };
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

  // ── Example prompts (same CDN, same cache discipline as the flags) ──────────────────────
  let examplesInFlight = null;
  async function readExamplesCache() {
    try {
      const cached = (await storage.get(COMPARE_EXAMPLES_CACHE_KEY))?.[COMPARE_EXAMPLES_CACHE_KEY];
      // Re-validated on read: a hand-edited or older row must not answer more than the rules allow.
      if (cached && now() - (cached.at || 0) < COMPARE_EXAMPLES_TTL_MS) return sanitizeCompareExamples({ v: COMPARE_EXAMPLES_VERSION, ...cached.examples });
    } catch { /* unreadable cache = miss */ }
    return null;
  }
  async function writeExamplesCache(examples) {
    try { await storage.set({ [COMPARE_EXAMPLES_CACHE_KEY]: { examples, at: now() } }); } catch { /* best effort */ }
  }
  // FAIL-SAFE: any fetch/parse error, non-2xx, an oversized body (COMPARE_EXAMPLES_MAX_BYTES) or
  // an invalid document answers null and caches nothing (a transient failure must not pin "no
  // examples" for an hour); a valid document is cached for COMPARE_EXAMPLES_TTL_MS. One fetch
  // shared by concurrent callers, aborted at COMPARE_EXAMPLES_TIMEOUT_MS — the shared promise
  // settles (null) and the slot is cleared, so the next status can start a fresh one (Codex
  // examples 1R #3). Never throws.
  function refreshCompareExamples() {
    if (!examplesInFlight) {
      examplesInFlight = fetchWithDeadline(fetchImpl, COMPARE_EXAMPLES_URL, examplesTimeoutMs, async (res) => {
        if (!res.ok) return null;
        const { json, oversized } = await readJsonBounded(res, COMPARE_EXAMPLES_MAX_BYTES);
        if (oversized) return null;
        const examples = sanitizeCompareExamples(json);
        if (examples) await writeExamplesCache(examples);
        return examples;
      })
        .catch(() => null)
        .finally(() => { examplesInFlight = null; });
    }
    return examplesInFlight;
  }
  // What COMPARE_STATUS answers (Codex examples 1R #2): the CACHED document or null, from storage
  // only — the status never waits on the network for examples (a hanging CDN used to hold the
  // status at the 3 s cap while the page kept Send disabled). A miss/stale cache kicks ONE
  // background refresh (shared, deadlined) and the NEXT status gets the result. The storage
  // read itself is bounded like every other one.
  async function cachedCompareExamples() {
    const cached = await withTimeout(readExamplesCache(), selectedModelsReadTimeoutMs, null);
    if (cached === null) refreshCompareExamples();
    return cached;
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
    const flags = await fetchCompareFlags();
    const flagOn = flags.on;
    // Example prompts: the cached document only (cachedCompareExamples) — never the network; a
    // miss starts a background refresh for the NEXT status. Dark = nothing to show, no fetch.
    const examplesPending = flagOn ? cachedCompareExamples() : Promise.resolve(null);
    // The 「요약·비교」 gate (COMPARE_SUMMARY_FLAG_FIELD) rides the status the page already reads,
    // so the button needs no second round trip; false whenever the page itself is dark.
    const summaryOn = flagOn && flags.summary === true;
    let loggedIn = false;
    try { loggedIn = !!(await getExtToken()); } catch { loggedIn = false; }
    const providers = {};
    // 🔴 NOT WHEN DARK (#1463 ①). These are the provider LOGIN PROBES, and with no provider tab
    // open the Gemini one is a credentialed HEAD over the network — so a page that will only ever
    // say 「준비 중」 used to wait for all three before it could say it. Everything else already
    // skipped its work under the same flag (examples, catalogs, quota); this did not.
    //
    // `providers` stays an EMPTY OBJECT rather than a filled-in-with-false one: the page reads
    // nothing out of it while dark (`renderComingSoon()` returns first), and inventing
    // `loggedIn:false` for a provider nobody asked about would be a claim, not a default.
    if (flagOn) {
      const [facts] = await Promise.all([
        planLabels(),
        ...COMPARE_PROVIDERS.map(async (p) => { providers[p] = await providerStatus(p); }),
      ]);
      for (const p of COMPARE_PROVIDERS) { providers[p].plan = facts[p] ? facts[p].plan : null; providers[p].usage = facts[p] ? facts[p].usage : null; }
    }
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

    // Dark = nothing else to show (AC24); do not touch the server for a page that will only say
    // "coming soon". Otherwise the server's answer is the truth, including 401 for a missing
    // ext_token (authedFetch falls back to the shared key, which the route refuses by design).
    const { quota, quotaError, betaReset } = flagOn ? await readQuota() : { quota: null, quotaError: null, betaReset: false };
    let examples = null;
    try { examples = await examplesPending; } catch { examples = null; }
    return { ok: true, flagOn, summaryOn, betaReset, examples, loggedIn, providers, quota, quotaError, models, modelsSource, modelsPending, selectedModels, saveHistory };
  }

  // `GET /api/compare/status` → `{ quota, quotaError, betaReset }` — the quota object the page renders
  // (null with a `quotaError` when the server said no or was unreachable) and the beta-reset gate
  // (`betaReset === true` in the body; false when absent or on any failure). Shared by the status
  // probe and by COMPARE_RESET, whose answer must be the same fresh object.
  async function readQuota() {
    try {
      const config = await getConfig();
      const resp = await authedFetch(config, `${config.serverUrl}/api/compare/status`);
      const body = await readJson(resp);
      if (resp.ok && body && body.ok === true) {
        // Entitlement write-through (1.32.0): the server's `pro` here is the same isPro() the
        // entitlement endpoint reports. Only this ok:true branch may write — a 401/404/network
        // status says nothing about the plan (Codex focus (d): no demotion from a transient error).
        if (typeof syncEntitlement === 'function') {
          try { await syncEntitlement(body.pro === true); } catch { /* the cache is a convenience; the status is not */ }
        }
        return {
          quota: {
            remaining: body.remaining ?? null,
            limit: body.limit ?? null,
            resetsAt: body.resetsAt,
            pro: body.pro === true,
          },
          quotaError: null,
          betaReset: body.betaReset === true,
        };
      }
      return { quota: null, quotaError: { status: resp.status, ...(body?.code ? { code: body.code } : {}) }, betaReset: false };
    } catch {
      return { quota: null, quotaError: { status: 0, code: SW_CODES.NETWORK_ERROR }, betaReset: false };
    }
  }

  // ── Beta reset (cmp-beta contract) ───────────────────────────────────────────────────────
  // `POST /api/compare/reset`, then the quota RE-READ from /status so the page applies exactly
  // what a COMPARE_STATUS would have told it. A re-read that fails AFTER a successful reset is
  // answered `{ok:false, code:'status_unavailable', reset:true}` — the counter IS cleared, but the
  // SW will not invent a quota object (the reset body has no `pro`; Codex cmp-beta SW 1R #2): the
  // page keeps its quota-error path and re-reads status itself. Nothing here touches a provider
  // tab, a client or a port: it is a server call and a status read, no more.
  async function resetQuota() {
    let resp;
    try {
      const config = await getConfig();
      resp = await authedFetch(config, `${config.serverUrl}/api/compare/reset`, { method: 'POST' });
    } catch {
      return { ok: false, code: SW_CODES.NETWORK_ERROR, status: 0 };
    }
    const body = await readJson(resp);
    // Exactly 200 + ok:true, like consume: a 404 is the flag off, anything else a failure.
    if (resp.status !== CONSUME_OK_STATUS || !body || body.ok !== true) {
      return { ok: false, status: resp.status, code: typeof body?.code === 'string' ? body.code.slice(0, OUTCOME_CODE_MAX) : 'http_error' };
    }
    const fresh = await readQuota();
    if (!fresh.quota) return { ok: false, code: SW_CODES.STATUS_UNAVAILABLE, reset: true, quotaError: fresh.quotaError };
    return { ok: true, quota: fresh.quota };
  }

  // ── Open the compare page from a provider tab (content script → SW) ───────────────────────
  // The ONE `tabs.create` outside the vendored clients, and it opens our own site shell only
  // (COMPARE_SITE_URL, which frames compare.html — see the constant).
  async function openCompare(message) {
    const src = COMPARE_PROVIDERS.includes(message.src) ? message.src : null;
    const placement = COMPARE_PLACEMENTS.includes(message.placement) ? message.placement : COMPARE_DEFAULT_PLACEMENT;
    // A provider `src` wins whenever it is given (the src path is byte-identical to before); only
    // the extension's own surfaces (COMPARE_SRCLESS_PLACEMENTS) may open without one. 🔴 The
    // placement is allow-listed BEFORE this check: an unknown placement reads as `composer`, which
    // is not src-less, so a src-less message with a bogus placement is still refused.
    const srcless = !src && COMPARE_SRCLESS_PLACEMENTS.includes(placement);
    if (!src && !srcless) return { ok: false, error: 'unknown src' };
    const q = src && typeof message.q === 'string' ? message.q : '';
    const id = typeof runtime.id === 'string' ? runtime.id : '';
    const dev = id && id !== PUBLISHED_EXT_ID ? `&ext=${id}` : '';
    const url = srcless
      ? `${COMPARE_SITE_URL}?${COMPARE_SITE_UTM}&utm_content=${placement}${dev}`
      : `${COMPARE_SITE_URL}?${COMPARE_SITE_UTM}&utm_content=${src}_${placement}${dev}#src=${src}&q=${encodeURIComponent(q)}`;
    emitEvent('button_click', { src: src || COMPARE_SRC_NONE, placement, has_q: q.length > 0 });
    await tabs.create({ url, active: true });
    return { ok: true };
  }

  /** runtime.onMessage adapter. Returns true when the message was ours (async sendResponse). */
  function handleMessage(message, _sender, sendResponse) {
    if (!message || typeof message.type !== 'string') return false;
    if (message.type === 'COMPARE_FLAG') {
      // `on` = the page/shell gate, `cta` = the in-page button gate, `summary` = the 「요약·비교」
      // button gate (see COMPARE_CTA_FLAG_FIELD / COMPARE_SUMMARY_FLAG_FIELD).
      fetchCompareFlags().then((f) => sendResponse({ on: f.on, cta: f.on && f.cta === true, summary: f.on && f.summary === true }), () => sendResponse({ on: false, cta: false, summary: false }));
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
    // Beta reset: the ONLY path to POST /reset — a runtime message from the page's button, never a
    // port message, never a side effect of a send or a status probe.
    if (message.type === 'COMPARE_RESET') {
      resetQuota().then(sendResponse, (e) => sendResponse({ ok: false, code: SW_CODES.UNKNOWN, message: String(e?.message || e) }));
      return true;
    }
    // Dev-only probe (unpacked builds): see probeMulti.
    if (message.type === PROBE_MULTI_MSG) {
      probeMulti(message).then(sendResponse, (e) => sendResponse({ ok: false, code: SW_CODES.UNKNOWN, message: String(e?.message || e) }));
      return true;
    }
    if (message.type === PROBE_MULTI_ABORT_MSG) {
      const running = probeAbort !== null;
      probeAbort?.abort();
      try { sendResponse({ ok: true, aborted: running }); } catch { /* page gone */ }
      return true;
    }
    return false;
  }

  // ── Dev-only probe: two conversations, two models, ONE provider session (2026-09-20) ────────
  // Question before same-provider multi-model columns are designed: can one claude.ai (gemini /
  // chatgpt) web session, through one pinned tab and our bridge, stream TWO conversations at once
  // on DIFFERENT models? The probe builds two fresh clients the way the controller does (same
  // deps, same options, temporary/incognito so nothing lands in the user's history), prepares
  // both (the tab lookup finds the same tab), then runs BOTH sendMessage calls in parallel and
  // reports per instance: started_at, ttft_ms, total_ms, chars, the served model, ok / error —
  // and the order chunks arrived in (`sequence`, first PROBE_SEQUENCE_MAX instance indexes),
  // from which `interleaved` = both instances produced chunks before either finished.
  // 🔴 Gated to UNPACKED builds only (`management.getSelf().installType === 'development'`): a store build
  // answers `{ok:false, code:'not_available'}`. No quota consume, no server call, no
  // compare_events row, no port — this is not a send. One probe at a time; PROBE_MULTI_ABORT_MSG
  // (or the per-provider budget) aborts both instances; both are disposed afterwards.
  // 🔴 Mutual exclusion with compare rounds (Codex layout-branch 1R #1): a probe and a round share
  // the pinned provider tab and its session, so they never overlap. `probeAbort` is the probe's
  // lock (held until BOTH clients are disposed); `roundsInFlight` counts every session's runSend
  // between its start and its finally. A probe while a round runs → `busy`; a round while a probe
  // holds the lock → CONSUME_FAIL{busy} to the page (the generic error), zero sends, no debit.
  let probeAbort = null;
  let roundsInFlight = 0;
  const DISPOSE_TIMED_OUT = Symbol('dispose timed out');
  // Unpacked = `chrome.management.getSelf().installType === 'development'` (a packed CRX with no
  // update_url is NOT unpacked — Codex 1R #2); no API, a rejection or any other type = fail CLOSED.
  async function isUnpackedBuild() {
    try {
      const self = await Promise.resolve(management?.getSelf?.());
      return self?.installType === 'development';
    } catch { return false; }
  }
  async function probeMulti(message) {
    if (!(await isUnpackedBuild())) return { ok: false, code: 'not_available' };
    const provider = COMPARE_PROVIDERS.includes(message?.provider) ? message.provider : null;
    const models = Array.isArray(message?.models) ? message.models.slice(0, 2).map((m) => (typeof m === 'string' && m.trim() ? m.trim() : null)) : [];
    const text = typeof message?.text === 'string' ? message.text : '';
    if (!provider || models.length !== 2 || !text.trim()) return { ok: false, code: 'bad_request' };
    if (probeAbort || roundsInFlight > 0) return { ok: false, code: SW_CODES.BUSY };
    const probe = new AbortController();
    probeAbort = probe;
    const clients = [];
    const sequence = [];
    const results = models.map((model, i) => ({ instance: i, model_requested: model, started_at: null, ttft_ms: null, total_ms: null, chars: 0, model: null, ok: null, code: null, message: null }));
    const timer = setTimeout(() => probe.abort(), sendTimeoutMs);
    logInfo('probe-multi', 'start', { provider, models, chars: text.length });
    try {
      await leversReady;
      for (let i = 0; i < 2; i++) clients.push(createClient(provider, clientDeps, clientOptions(provider, false)));
      // Readiness for both (the second finds the tab the first opened/found — one session, one tab).
      for (let i = 0; i < 2; i++) {
        await clients[i].prepare({ mayOpenTab: true, signal: probe.signal, onEvent: (ev) => { if (ev?.type === 'diag') logInfo('probe-multi', `${i}:${ev.stage}`, ev.detail ?? {}); }, model: models[i] });
      }
      // Both sends START before either resolves — that is the whole question.
      const settled = await Promise.allSettled(clients.map((client, i) => {
        const r = results[i];
        r.started_at = now();
        return client.sendMessage(
          text,
          (delta) => {
            if (r.ttft_ms === null) r.ttft_ms = Math.max(0, Math.round(now() - r.started_at));
            r.chars += String(delta ?? '').length;
            if (sequence.length < PROBE_SEQUENCE_MAX) sequence.push(i);
          },
          probe.signal,
          { mayOpenTab: true, model: models[i], onEvent: (ev) => { if (ev?.type === 'model') { const m = modelForPage(ev.model); if (m?.id) r.model = m.id; } } },
        ).then((result) => {
          r.ok = true;
          r.total_ms = Math.max(0, Math.round(now() - r.started_at));
          const served = modelForPage(result?.model);
          if (served?.id) r.model = served.id;
          logInfo('probe-multi', `${i}:done`, { ttft_ms: r.ttft_ms, total_ms: r.total_ms, chars: r.chars, model: r.model });
        }, (e) => {
          r.ok = false;
          r.total_ms = Math.max(0, Math.round(now() - r.started_at));
          r.code = probe.signal.aborted ? SW_CODES.ABORTED : (typeof e?.code === 'string' ? e.code : SW_CODES.UNKNOWN);
          r.message = String(e?.message || e).slice(0, 300);
          logInfo('probe-multi', `${i}:error`, { code: r.code, message: r.message });
          throw e;
        });
      }));
      void settled;
    } catch (e) {
      // A prepare failure (no tab, not signed in) — reported per the instance that had not started.
      for (const r of results) if (r.ok === null) { r.ok = false; r.code = typeof e?.code === 'string' ? e.code : SW_CODES.UNKNOWN; r.message = String(e?.message || e).slice(0, 300); }
      logInfo('probe-multi', 'failed', { code: results[0].code, message: results[0].message });
    } finally {
      clearTimeout(timer);
      // The lock outlives the sends: released only once both clients are disposed — or, per
      // client, once PROBE_DISPOSE_TIMEOUT_MS has passed without its dispose settling (logged);
      // a stuck cleanup must not turn every later round into `busy`.
      await Promise.allSettled(clients.map((c, i) => withTimeout(
        Promise.resolve().then(() => c.dispose()),
        probeDisposeTimeoutMs,
        DISPOSE_TIMED_OUT,
      ).then((v) => { if (v === DISPOSE_TIMED_OUT) logInfo('probe-multi', 'dispose timeout', { instance: i, ms: probeDisposeTimeoutMs }); })));
      probeAbort = null;
    }
    // Interleaved = a chunk of one instance arrived after a chunk of the other AND before that
    // other's last chunk — i.e. the sequence is not two solid blocks.
    const firstOf = (i) => sequence.indexOf(i);
    const lastOf = (i) => sequence.lastIndexOf(i);
    const interleaved = firstOf(0) >= 0 && firstOf(1) >= 0 && (firstOf(1) < lastOf(0) && firstOf(0) < lastOf(1));
    logInfo('probe-multi', 'result', { interleaved, sequence: sequence.join(''), ok: results.map((r) => r.ok) });
    return { ok: true, provider, results, interleaved, sequence };
  }

  // ── Streaming session: one Port = one session = one client per provider ──────────────────
  function createSession(port) {
    const clients = new Map();   // colId → vendored client INSTANCE (kept for follow-ups; cmp-columns)
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
    // The round's usage record (cmp-beta contract): created by the consume 200 that carried an
    // integer `event_id`, filled while the fan-out runs, sent ONCE when the round settles
    // (settleOutcome, from runSend's finally — the ALL_DONE point, which a Stop and a lost port
    // reach too once the aborted sends have landed) and null in between rounds. One send at a
    // time per port (`running`), so one record is enough. Null = no outcome for this round:
    // consume refused, no event_id in its body, or nothing consumed at all.
    let outcome = null; // { eventId, results: { [colId]: { ok, code?, ttft_ms?, total_ms?, model? } } }
    const recordOutcome = (colId, patch) => {
      if (!outcome) return;
      outcome.results[colId] = { ...(outcome.results[colId] || {}), ...patch };
    };
    const elapsed = (t0) => Math.max(0, Math.round(now() - t0));
    // The round is over: hand the record to postOutcome exactly once. A READY provider that never
    // got a DONE/ERROR (the port went right after consume, so no column was asked) is recorded
    // as aborted — the debit happened, the column did not answer.
    function settleOutcome(readyIds) {
      const o = outcome;
      outcome = null;
      if (!o) return;
      for (const id of readyIds) {
        if (typeof o.results[id]?.ok !== 'boolean') o.results[id] = { ...(o.results[id] || {}), ok: false, code: SW_CODES.ABORTED };
      }
      postOutcome(o.eventId, o.results);
    }

    const post = (msg) => {
      if (torndown) return;
      try { port.postMessage(msg); } catch { /* page gone — onDisconnect tears down */ }
    };

    // One client INSTANCE per column (`col` = {id, provider, model}); same-provider columns are
    // separate instances riding the same pinned tab.
    const clientFor = (col) => {
      // 🔴 After teardown there is nobody left to dispose a new client (the map was snapshot and
      // cleared), so a readiness step that resumes late must not create one (Codex blocker).
      if (torndown) throw abortedError('session torn down');
      let client = clients.get(col.id);
      if (!client) {
        const continuation = sessionSaveHistory === true && Object.hasOwn(pendingResume, col.id) ? pendingResume[col.id] : null;
        delete pendingResume[col.id];
        if (continuation) logInfo(col.provider, 'resume', { col: col.id, keys: Object.keys(continuation) });
        client = createClient(col.provider, clientDeps, clientOptions(col.provider, sessionSaveHistory === true, continuation));
        clients.set(col.id, client);
      }
      return client;
    };

    // The clients' readiness diagnostics (`{type:'diag', provider, stage, detail}`, package v0.2.3):
    // one line in the SW console and one DIAG port message each. Never throws (a listener that
    // throws would be logged by the client, but the send is not the place to find out).
    const onDiag = (provider, col) => (ev) => {
      if (ev?.type !== 'diag') return;
      const stage = typeof ev.stage === 'string' ? ev.stage : 'unknown';
      const detail = ev.detail && typeof ev.detail === 'object' ? ev.detail : {};
      // 🔴 The console gets the detail RAW; the page gets it projected. `stream_cut` carries the
      // package's free-text reason, whose error form ends in the PROVIDER's own message — the same
      // string `cutKindOf` exists to keep off the wire (#1527). Bounding it on DONE and then
      // forwarding it here would have made that boundary accidental rather than real: the page
      // ignores this stage today, so nothing showed it (batch review, B+C).
      logInfo(provider, stage, detail);
      post({ type: PORT_MSG.DIAG, provider, col, stage, detail: pageSafeDiag(stage, detail) });
    };

    // One ERROR to the page + one line in the SW console. `e` is the client's error (or null for
    // a code this module produced itself): its `reason`/`message` ride along as reason/detail.
    // `more`: fields this module adds beside the client's (a timeout's `budgetMs`) — never written
    // onto the caught error itself (a frozen/sealed error would throw here and swallow ALL_DONE —
    // Codex 1.31.2 #1).
    const postError = (col, code, rawMessage, e, more = null) => {
      const { provider } = col;
      const extras = { ...errorExtras(e), ...(more && typeof more === 'object' ? more : {}) };
      // `message` is the caller's copy of the client message: stripped like `detail` (see
      // stripStreamHead) so no field of an ERROR carries the stream head.
      const message = stripStreamHead(typeof rawMessage === 'string' ? rawMessage : String(rawMessage ?? ''));
      logInfo(provider, 'ERROR', { col: col.id, code, reason: extras.reason ?? null, ...(extras.diag ? { diag: extras.diag } : {}), message: extras.detail ?? message });
      // A no-op before consume (no record yet): readiness failures are not part of the round the
      // debit bought. After it, every ERROR — a client's, a timeout, a Stop — is the column's outcome.
      recordOutcome(col.id, { ok: false, code });
      post({ type: PORT_MSG.ERROR, provider, col: col.id, code, ...extras, message });
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
    // Runs ONCE per provider (cmp-columns), on that provider's FIRST column's client (`col`); the
    // verdict applies to every column of the provider. `model` = that column's model, for Claude's
    // pre-create. The provider's other column clients are built lazily at send time and find the
    // same tab themselves (the package looks tabs up per send).
    async function readiness(col, mayOpenTab, signal) {
      const { provider, model } = col;
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
        await clientFor(col).prepare({ mayOpenTab: mayOpenTab === true, signal, onEvent: onDiag(provider, col.id), model });
      } catch (e) {
        if (torndown || signal.aborted) return { code: SW_CODES.ABORTED, error: null };
        return { code: typeof e?.code === 'string' ? e.code : SW_CODES.UNKNOWN, error: e };
      }
      if (torndown || signal.aborted) return { code: SW_CODES.ABORTED, error: null };
      return null;
    }

    // Step (b). Never throws; a failure is a CONSUME_FAIL payload. `stats` is the usage body
    // (buildConsumeBody) — what the debit is for, never who.
    async function consume(stats) {
      let resp;
      try {
        const config = await getConfig();
        resp = await authedFetch(config, `${config.serverUrl}/api/compare/consume`, { method: 'POST', headers: { ...JSON_HEADERS }, body: JSON.stringify(stats) });
      } catch (e) {
        return { ok: false, fail: { status: 0, code: SW_CODES.NETWORK_ERROR, message: String(e?.message || e) } };
      }
      const body = await readJson(resp);
      // Exactly 200 — the contract names the status, and a 2xx that is not it is not a debit we
      // recognise (a proxy's 202/204 with a stale body must not release a send).
      if (resp.status === CONSUME_OK_STATUS && body && body.ok === true) {
        // `event_id` names the row the outcome will complete; anything but a positive integer =
        // no row to complete = no outcome for this round.
        const eventId = Number.isInteger(body.event_id) && body.event_id > 0 ? body.event_id : null;
        return { ok: true, remaining: body.remaining ?? null, limit: body.limit ?? null, resetsAt: body.resetsAt, eventId };
      }
      return {
        ok: false,
        fail: {
          status: resp.status,
          code: typeof body?.code === 'string' ? body.code : 'http_error',
          ...(body?.remaining !== undefined ? { remaining: body.remaining } : {}),
          // `limit` rides along too (1.32.0 batch review #1): the 429 IS a counted answer and the
          // page rebuilds its quota from this message — without the limit a page that last read
          // an UNCOUNTED status (worker flag flip, or a failed first read) drew 「0/0」.
          ...(body?.limit !== undefined ? { limit: body.limit } : {}),
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
    async function sendOne(col, text, mayOpenTab, sendSignal) {
      const { id: colId, provider, model } = col;
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
        if (ev.stage === 'first_chunk' || ev.stage === 'stream_done') logInfo(provider, 'ttft', { col: colId, ...ttftSegments(stages) });
      };
      // The outcome's clock (cmp-beta contract): this send's start, on the SW's own clock — the
      // package's timed stages are diagnostics an older page script may not report.
      const t0 = now();
      // Stall watchdog (#1519, STREAM_STALL_MS): `lastInbound` is null until the first answer chunk —
      // nothing is armed while the provider may still be thinking in silence. From the first chunk
      // on, every inbound message re-arms it; when it fires, the send is aborted and the text
      // streamed so far (`streamed`) becomes a DONE{stalled:true}. `lastModel` = the served model
      // reported so far, for that DONE (the client's result never arrives on a stall).
      let stalled = false;
      let stallTimer = null;
      let lastInbound = null;
      let streamed = '';
      let lastModel = null;
      const onStall = () => {
        stalled = true;
        logInfo(provider, 'stall', { col: colId, ms: lastInbound === null ? null : now() - lastInbound, chars: streamed.length });
        ac.abort();
      };
      const touch = () => {
        lastInbound = now();
        clearTimeout(stallTimer);
        stallTimer = setTimeout(onStall, streamStallMs);
      };
      // Re-arm only once text has started: an event before the first chunk is the thinking/readiness
      // phase, which has no stall clock.
      const touchIfStreaming = () => { if (lastInbound !== null) touch(); };
      let client = null; // in scope for the stall branch of the catch
      try {
        client = clientFor(col);
        const result = await client.sendMessage(
          text,
          (delta) => {
            if (outcome && outcome.results[colId]?.ttft_ms === undefined) recordOutcome(colId, { ttft_ms: elapsed(t0) });
            const d = String(delta ?? '');
            streamed += d;
            touch();
            post({ type: PORT_MSG.CHUNK, provider, col: colId, delta: d });
          },
          ac.signal,
          {
            mayOpenTab: mayOpenTab === true,
            model,
            // The served model, as soon as the client knows it (before the first chunk where the
            // provider reports it). The page swaps its "waiting" badge for the name.
            onEvent: (ev) => {
              touchIfStreaming(); // anything the client surfaces proves the stream is alive
              if (ev?.type === 'diag') { onDiag(provider, colId)(ev); onStage(ev); return; }
              if (ev?.type === 'activity') { const a = activityForPage(ev); if (a) post({ type: PORT_MSG.ACTIVITY, provider, col: colId, ...a }); return; }
              if (ev?.type !== 'model') return;
              const m = modelForPage(ev.model);
              if (m) {
                lastModel = m;
                if (m.id) recordOutcome(colId, { model: m.id });
                post({ type: PORT_MSG.MODEL, provider, col: colId, model: m });
              }
            },
          },
        );
        // `continuation` (package v0.4.0): what would resume this provider's conversation on a
        // fresh client — ONLY for a kept session, and only when the client hands one out (it
        // answers null for anything it will still clean up). Omitted otherwise, never null: an
        // incognito session's conversations are gone at dispose, so there is nothing to offer.
        const continuation = sessionSaveHistory === true && typeof client.getContinuation === 'function' ? client.getContinuation() : null;
        const served = modelForPage(result?.model);
        // 🔴 A cut the CLIENT reported (package v0.5.5) is still a DONE: what arrived IS the answer,
        // exactly as it is for the stall watchdog below. It rides the SAME `stalled` flag on purpose
        // — the page already has four surfaces for "this answer is not complete" and a second flag
        // would mean a second vocabulary for one idea. `cutReason` only says WHICH, in two words.
        const cut = cutKindOf(result);
        if (cut) logInfo(provider, 'cut', { kind: cut, reason: String(result?.cutReason || '').slice(0, CUT_REASON_LOG_MAX) });
        recordOutcome(colId, {
          ok: true, total_ms: elapsed(t0),
          ...(cut ? { code: cut === CUT_STREAM_ERROR ? SW_CODES.CUT_ERROR : SW_CODES.STALLED } : {}),
          ...(served?.id ? { model: served.id } : {}),
        });
        post({
          type: PORT_MSG.DONE, provider, col: colId, text: String(result?.text ?? ''), model: served,
          ...(cut ? { stalled: true, cutReason: cut } : {}),
          ...(continuation && typeof continuation === 'object' ? { continuation } : {}),
        });
      } catch (e) {
        // A stall is a DONE, not an ERROR (#1519): the text the page already shows IS the answer;
        // the client's rejection here is the abort the watchdog itself requested. `stalled:true`
        // lets the page add its note; the outcome keeps ok:true and names the cut in `code`.
        if (stalled) {
          const continuation = sessionSaveHistory === true && typeof client?.getContinuation === 'function' ? client.getContinuation() : null;
          recordOutcome(colId, { ok: true, code: SW_CODES.STALLED, total_ms: elapsed(t0), ...(lastModel?.id ? { model: lastModel.id } : {}) });
          post({
            type: PORT_MSG.DONE, provider, col: colId, text: streamed, model: lastModel, stalled: true,
            ...(continuation && typeof continuation === 'object' ? { continuation } : {}),
          });
          return;
        }
        const code = timedOut ? SW_CODES.TIMEOUT
          : (typeof e?.code === 'string' ? e.code : (e?.name === 'AbortError' ? SW_CODES.ABORTED : SW_CODES.UNKNOWN));
        recordOutcome(colId, { total_ms: elapsed(t0) });
        // A timeout names the budget it hit (the page's copy shows it, so a changed budget never
        // leaves a stale number in a string).
        postError(col, code, String(e?.message || e), e, timedOut ? { budgetMs: sendTimeoutMs } : null);
      } finally {
        clearTimeout(timer);
        clearTimeout(stallTimer);
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
      // A dev probe holds the provider session (see probeMulti): refused, nothing sent, no debit.
      if (probeAbort) {
        post({ type: PORT_MSG.CONSUME_FAIL, status: 0, code: SW_CODES.BUSY });
        return;
      }
      running = true;
      roundsInFlight++;
      const send = new AbortController();
      currentSend = send;
      // Hoisted for the finally: the COLUMNS the debit bought (empty until consume), so the
      // outcome can mark the ones that never answered.
      let ready = [];
      const readyIds = () => ready.map((c) => c.id);
      try {
        await leversReady; // the pin policy is fixed before the session's first client exists
        const text = typeof message.text === 'string' ? message.text : '';
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
        // Model per provider (LEGACY path — a page without `columns`) = the current choice overlaid
        // with what this message says; the message's part becomes the current choice (and is
        // persisted) so the next send and the next page load agree. The write is not awaited: a
        // slow storage.sync must not hold up the send, and every later read is served from
        // memory, not from the pending write. A `columns` message carries its models itself.
        const override = sanitizeModelMap(message.models);
        let models;
        if (Object.keys(override).length) {
          await loadSelectedModels();
          models = applySelectedModels(override);
        } else {
          models = await readSelectedModels();
        }
        // The round's columns (cmp-columns contract §2; resolveColumns): `columns[]` from the
        // page, else colId / legacy provider `targets`. A duplicate colId or > MAX_COLUMNS is a
        // bad_request BEFORE anything is prepared or debited.
        const resolved = resolveColumns(message, models);
        if (resolved.code === 'bad_request') {
          post({ type: PORT_MSG.CONSUME_FAIL, status: 0, code: 'bad_request' });
          return;
        }
        const columns = resolved.columns;
        if (!text.trim() || !columns.length) {
          post({ type: PORT_MSG.CONSUME_FAIL, status: 0, code: SW_CODES.NO_TARGETS });
          return;
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
        // What this round IS, for the usage row (cmp-beta contract): the page's `kind` when it is
        // one of COMPARE_KINDS, else derived from the message shape. Read here — before readiness
        // consumes the resume seeds — so a SEND{resume} without a kind still says 'resume'.
        const resumeAsked = !followup && Object.keys(pendingResume).length > 0;
        // (a) readiness, ONCE per provider (on its first column), in parallel; a failed provider
        // is reported on each of its columns and skipped, not fatal.
        const firstOf = new Map();
        for (const col of columns) if (!firstOf.has(col.provider)) firstOf.set(col.provider, col);
        const verdicts = new Map(await Promise.all([...firstOf.values()].map(async (col) => [col.provider, await readiness(col, mayOpenTab, send.signal)])));
        // A Stop before the debit is free; the page hears it as a failed consume.
        if (torndown) return;
        if (send.signal.aborted) {
          post({ type: PORT_MSG.CONSUME_FAIL, status: 0, code: SW_CODES.ABORTED });
          return;
        }
        for (const col of columns) {
          const verdict = verdicts.get(col.provider);
          if (verdict) postError(col, verdict.code, `not ready: ${verdict.code}`, verdict.error);
          else ready.push(col);
        }
        if (!ready.length) {
          post({ type: PORT_MSG.CONSUME_FAIL, status: 0, code: SW_CODES.NO_TARGETS });
          return;
        }
        const readyProviders = [...new Set(ready.map((c) => c.provider))];
        // (b) consume — the only server write, and the gate for (c). The body says what the debit
        // is for (kind / the ready columns and their models / round / src / ext version).
        const c = await consume(buildConsumeBody({
          kind: message.kind, followup, resumeAsked, src: message.src, session: message.session,
          ready: readyIds(), models: Object.fromEntries(ready.map((col) => [col.id, col.model])), round: message.round, extVersion: manifestVersion(),
          text,   // for the q_* SIGNALS only (questionSignals) — the text itself never leaves here
        }));
        // The SW's own analytics event (ux3 item 8): the debit's outcome and how many columns it
        // bought. Never the text, never who.
        emitEvent('consume', { ok: c.ok, status: c.ok ? CONSUME_OK_STATUS : c.fail.status, targets_n: ready.length });
        if (!c.ok) {
          post({ type: PORT_MSG.CONSUME_FAIL, ...c.fail });
          return;
        }
        // The round's usage record exists from here — and only with the server's event_id.
        outcome = c.eventId ? { eventId: c.eventId, results: {} } : null;
        post({ type: PORT_MSG.CONSUME_OK, remaining: c.remaining, limit: c.limit, resetsAt: c.resetsAt });
        if (torndown) return;
        // The tabs exist now (readiness opened them): a picker that was static for lack of a tab
        // can be the site's list. Not awaited — the fan-out below is what the user is waiting for.
        refreshCatalogs(readyProviders);
        // (c) fan out, one send per COLUMN. Each settles on its own; ALL_DONE once every one has. A
        // Stop that landed during consume is honoured here too — the unit is spent (no refund), no
        // column is asked.
        if (send.signal.aborted) {
          for (const col of ready) postError(col, SW_CODES.ABORTED, 'stopped before send', null);
        } else {
          await Promise.all(ready.map((col) => sendOne(col, text, mayOpenTab, send.signal)));
        }
        post({ type: PORT_MSG.ALL_DONE });
        // Still pending after the CONSUME_OK refresh (it ran while the tab was still loading, say):
        // one more try now that the round is over.
        refreshCatalogs(readyProviders);
      } finally {
        // The round has settled on every path that got past consume — ALL_DONE above, a Stop (the
        // aborted sends landed as ERRORs before ALL_DONE), a lost port (same, ALL_DONE unposted),
        // a return right after CONSUME_OK. Nothing to send when consume never released the round.
        settleOutcome(readyIds());
        if (currentSend === send) currentSend = null;
        running = false;
        roundsInFlight--;
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
