// Per-provider collection state — the ONE place that answers "is this provider collecting, WHICH
// account it is collecting, and if it is not, why". Written by the collectors, read by the popup
// and (via `get_status`) by the web.
//
// Claude joined this store in #1038 for the ACCOUNT LABEL ONLY (success + `account`, never an
// error — see the error note below, which still holds and is the reason that asymmetry exists).
// The popup's login disclosure has to name every provider a login absorbs, and this is the only
// place that knows all of them at collection time.
//
// WHY THIS EXISTS (#852)
// ---------------------
// `bg/api-chatgpt.js` and `bg/api-gemini.js` throw 14 distinct `err_*` codes and **not one of them
// was referenced anywhere else** — the collectors caught them, console.warn'd, and returned
// `{success:false, orgs:[]}`; `background.js` caught that again with `.catch(() => {})`. So a
// failing provider looked exactly like a provider the user does not have. That is how 문의 #190
// reached us: the user saw an empty ChatGPT and concluded collection was broken, and we could not
// tell them why because we did not know either.
//
// 🔴 It deliberately does NOT live on `lastStatus`. That object is the CLAUDE collector's status,
// and `ui/render.js` depends on that: an error there means "Claude failed", which it demotes to a
// soft notice when a non-Claude provider is healthy. Putting a ChatGPT error in the same slot
// would make that branch demote a failure using the very provider that failed as evidence of
// health.
//
// 🔴 It records the LOGGED-OUT precheck too. `collectChatGPT()`/`collectGemini()` return early
// when `isXLoggedIn()` is false, before any API call — so the most common failure of all never
// produced an `err_*` code at all. Surfacing the 14 codes without this would still leave the
// ordinary "signed out of ChatGPT" case invisible (Codex review of the plan, #852).

import { sendGAEvent } from './analytics.js';
import { PROVIDER_LABELS, PROVIDER_SITE_URLS } from './constants.js';

const KEY = 'providerCollectionState';

// Display suppression: an error nobody has re-attempted in this long is history, not a diagnosis.
// (Clearing on success is the primary rule — this only covers a provider that stopped being
// collected at all, e.g. the setting was switched off while it was failing.)
export const PROVIDER_ERROR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// How long a DISMISSED reason stays quiet.
//
// WHY A DISMISSAL EXISTS AT ALL (#1130)
// -------------------------------------
// #1112 removed the banner for a provider this install NEVER collected. What it could not remove
// is the other half: somebody who collected ChatGPT once, signed out, and does not intend to sign
// back in. That is a true statement ("you are not signed in") repeated on every popup open, with
// no way to make it stop — 608 installs sat on `err_chatgpt_not_logged_in` in the 14 days to
// 2026-09-03, and one dashboard account was shown the same line 15 times in a single day.
//
// 🔴 Deliberately the SAME 30 days as the web's CT_PROVIDER_CONNECT_SNOOZE_MS, and for the same
// reason stated there: long enough that somebody who does not use the provider is not nagged,
// short enough that somebody who starts using it again is told why it is not collecting. Two
// surfaces inventing two silences is how they end up disagreeing about what the user was told.
export const PROVIDER_ERROR_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

// 🔴 Only these codes may be stored. A raw `e.message` can carry an API response fragment
// (bg/api-chatgpt.js includes `text.slice(0, 500)` in one throw), and this state is handed to the
// web through `get_status` — so anything unrecognised becomes the generic code instead of being
// passed through (Codex review). Keep in sync with the throws in bg/api-{chatgpt,gemini}.js and
// with the i18n keys; test/provider-error-guard.mjs asserts all three agree.
// Sending is a SEPARATE axis from collecting (#1020). The provider API can answer perfectly and
// the snapshot still never reaches claudetuner.com — the popup shows local data while the dashboard
// stays empty, which is the same "two surfaces disagree" shape this module exists to prevent.
//
// 🔴 Only failures NOBODY ELSE reports live here. Withheld-by-login-first, authBlocked,
// needsFullLogin, needsReauth, account_deleted and the 426 upgrade block all raise their own popup
// state already (verified: each is read by popup.js). Recording those again would say the same
// thing twice, in two voices, with two different fixes — the double-messaging trap.
export const PROVIDER_SEND_ERROR_CODES = [
  'err_send_server',     // 5xx — our server or D1 is unhealthy. The user waits.
  'err_send_rejected',   // some other non-ok status; nothing actionable is known
  'err_send_failed',     // the POST threw (offline, DNS, TLS)
];

export const PROVIDER_ERROR_CODES = {
  chatgpt: [
    'err_chatgpt_not_logged_in',   // precheck — no session cookie and no open tab
    'err_chatgpt_auth_failed',
    'err_chatgpt_cloudflare',
    'err_chatgpt_no_cookies',
    'err_chatgpt_rate_limit',
    'err_chatgpt_session_expired',
    'err_chatgpt_collect_failed',  // the catch-all; unknown errors normalise to this
  ],
  gemini: [
    'err_gemini_not_logged_in',
    'err_gemini_auth_failed',
    'err_gemini_cloudflare',
    'err_gemini_no_at_token',
    'err_gemini_page_fetch',
    'err_gemini_rate_limit',
    'err_gemini_session_expired',
    'err_gemini_collect_failed',
  ],
};

// Which reasons are fixed BY GOING TO THE PROVIDER, and therefore deserve a link there.
//
// The copy for every one of these already names the site ("chatgpt.com에 로그인해 주세요") and gave
// no way to get there — the same gap the dashboard closed for its own surfaces in #1020. This is
// the popup half of that fix, so the two must agree: test/provider-error-guard.mjs asserts this
// list is set-equal to CT_PROVIDER_CONNECT_ACTIONABLE in site/shared/provider-connect.js. The web
// module cannot be imported here (classic global script vs extension ESM), so the guard is what
// keeps the single policy single.
//
// 🔴 `rate_limit` is deliberately absent: the fix is to wait, and a button labelled "Open ChatGPT"
// would send someone to do the one thing that cannot help — the misdirection #967 is about.
// 🔴 `err_send_*` is absent for a different reason: those failures are OURS (our server rejected
// the snapshot, or the network to us is down). They carry no provider segment at all, so the
// parse below rejects them before this list is consulted.
export const PROVIDER_ERROR_ACTIONABLE = [
  'not_logged_in', 'session_expired', 'auth_failed',   // sign in again
  'cloudflare', 'no_cookies', 'no_at_token', 'page_fetch', 'collect_failed',   // open a tab there
];

/**
 * The destination a stored error code should offer, or null when going there cannot help.
 *
 * 🔴 The URL comes from the constants table, never from the code string: the code is the only part
 * of this state that originated outside our own throw sites, and nothing derived from it may reach
 * an href.
 *
 * @param {string} code e.g. `err_gemini_not_logged_in` or `err_chatgpt_auth_failed:401`
 * @returns {{provider: string, label: string, url: string}|null}
 */
export function providerErrorAction(code) {
  if (!code || typeof code !== 'string') return null;
  const key = code.split(':')[0];                     // drop the HTTP status; the link never uses it
  const m = /^err_(chatgpt|gemini)_(.+)$/.exec(key);
  if (!m) return null;
  const [, provider, reason] = m;
  // Only codes this module actually stores. An unrecognised one is not a destination we can vouch
  // for, and silence is the safe answer.
  if ((PROVIDER_ERROR_CODES[provider] || []).indexOf(key) < 0) return null;
  if (PROVIDER_ERROR_ACTIONABLE.indexOf(reason) < 0) return null;
  const url = PROVIDER_SITE_URLS[provider];
  if (!url) return null;
  return { provider, label: PROVIDER_LABELS[provider] || provider, url };
}

/**
 * Reduce a thrown error to a storable code.
 *
 * The API layer throws `err_chatgpt_auth_failed:401` — key plus an HTTP status. The status is
 * genuinely useful ("401 vs 403" is the difference between two different fixes), so it is kept,
 * but ONLY when it is digits: that is the whole grammar the throw sites use, and it is the only
 * shape that cannot smuggle response text into a value the web can read.
 */
export function normalizeProviderError(provider, err) {
  const allowed = PROVIDER_ERROR_CODES[provider];
  if (!allowed) return null;
  const fallback = `err_${provider}_collect_failed`;
  const raw = (err && err.message) || (typeof err === 'string' ? err : '');
  if (!raw) return fallback;
  const colon = raw.indexOf(':');
  const key = colon > 0 ? raw.slice(0, colon) : raw;
  if (allowed.indexOf(key) < 0) return fallback;
  if (colon <= 0) return key;
  const detail = raw.slice(colon + 1).trim();
  return /^\d{1,3}$/.test(detail) ? `${key}:${detail}` : key;
}

export async function getProviderState() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [KEY]: null }, (r) => {
      const v = r[KEY];
      resolve(v && typeof v === 'object' ? v : {});
    });
  });
}

// Serialize every read-modify-write on this key.
//
// 🔴 Not belt-and-braces. `collectAndSend()` is not serialized across its provider section
// (bg/collect.js only guards the Claude collector), so a popup open, a manual collect, an idle
// wake and an alarm tick can overlap. Two unserialized patches on ONE storage key lose whichever
// field the loser read stale — and the field most likely to be lost is `lastSuccessAt`, which is
// exactly what displayableProviderError() relies on to stop showing a fixed error. A late error
// writer would resurrect a fault the user already fixed (Codex DEPLOY-BLOCKER).
//
// A promise chain is enough: there is one service worker, so this is the only writer.
let _patchChain = Promise.resolve();

// `fields` may be an object, or a function of the previous state. The function form exists so a
// DECISION and the stamp recording it land in the SAME serialized transition: computing the
// decision outside and stamping it in a second patch lets a concurrent writer read the pre-stamp
// value and decide the same thing again (Codex reproduced a double GA send that way).
function patch(provider, fields) {
  const run = async () => {
    const all = await getProviderState();
    const cur = (all[provider] && typeof all[provider] === 'object') ? all[provider] : {};
    const resolved = typeof fields === 'function' ? fields(cur) : fields;
    all[provider] = Object.assign({}, cur, resolved);
    await chrome.storage.local.set({ [KEY]: all });
    return { prev: cur, next: all[provider] };
  };
  // Chain off the previous patch, and never let one failure break the chain for the next caller.
  const next = _patchChain.then(run, run);
  _patchChain = next.then(() => {}, () => {});
  return next;
}

/** An attempt started. Recorded even when it then fails — "when did we last try" is half of a diagnosis. */
export async function noteProviderAttempt(provider) {
  return (await patch(provider, { lastAttemptAt: Date.now() })).next;
}

/**
 * Collection succeeded → the provider is healthy and any stored error is history.
 *
 * 🔴 Clearing on SUCCESS, not at the start of an attempt: clearing on attempt would erase the
 * error the user is looking at every time the alarm fires, so a permanently failing provider would
 * flash its reason and hide it again (Codex review).
 */
export async function noteProviderSuccess(provider, account) {
  // `account` = the provider's own address AS IT WAS AT COLLECTION TIME (#1038). Recording it here
  // rather than reading a cache later is the whole point: the popup used to disclose
  // `accountCache?.email`, an 8-hour Claude profile cache, so it could name the account the user
  // had BEFORE they switched — and it could only ever name Claude. This value is written by the
  // code that just sent a snapshot for it, so it cannot disagree with what was actually collected.
  // Undefined leaves the stored label untouched (a caller that does not know must not erase one).
  // 🔴 `gaReason: null` KEEPS CLAUDE COMPARABLE TO THE OTHER TWO. ChatGPT and Gemini throttle
  // against `lastError`, which this line clears, so a provider that recovers and then breaks again
  // reports the SAME reason immediately — the recovery ended the episode. Claude throttles against
  // `gaReason` (it writes no `lastError`; see CLAUDE_GA_REASON_CODES), so without clearing it here
  // a fail→succeed→fail-the-same-way sequence would stay silent for the rest of the 24h window and
  // Claude's reason counts would mean something different from the other two (Codex DEPLOY-BLOCKER).
  // Harmless for the providers that do not use the field: nothing writes it for them.
  const fields = { lastSuccessAt: Date.now(), lastError: null, gaReason: null, gaSkipReason: null };
  // 🔴 `accountAt` STAMPS WHEN THE LABEL WAS OBSERVED, and only an actual observation may move it.
  // A caller that passes nothing leaves BOTH fields alone: "we collected, but we did not re-check
  // which account" is a real state, and treating it as a fresh observation is what laundered a
  // stale value into a permanently current one (Codex). Collection recency and label recency are
  // different facts with different lifetimes, so they get different clocks.
  //
  // 🔴 THREE STATES, AND CALLERS PICK DELIBERATELY (Codex round 5 asked for this in writing):
  //   undefined — "we did not look this cycle". Keeps the stored label AND its age. Claude's cache
  //               hit is this: routine, expected, and the label is still the best thing we know.
  //   an address — "we looked and it is X". Refreshes both.
  //   null      — "we looked and it did not say". ERASES, so the disclosure omits the provider.
  //               ChatGPT/Gemini pass their live `email` straight through, so a response that
  //               carries no address lands here — and that is the intended reading: we got an
  //               answer and the answer contained no account, which is not the same as not asking.
  if (account !== undefined) {
    fields.account = account || null;
    fields.accountAt = account ? Date.now() : null;
  }
  // 🔴 The dismissal dies with the episode it silenced (#1130) — but only the READ episode.
  // A dismissal that outlived recovery would carry over to the NEXT time this provider breaks: a
  // × clicked in September would silently withhold an October regression, and nothing on screen
  // could tell the user a message was suppressed. The × means "not this, not now", never "never
  // again".
  //
  // 🔴 And ONLY the read axis, because that is all this success is evidence of. Reading the
  // provider says nothing about whether our own server accepted the snapshot — the collectors
  // call this BEFORE they apply the send outcome (bg/collect-chatgpt.js, bg/collect-gemini.js),
  // so clearing everything here turned a 30-day dismissal of `err_send_server` into one that
  // expired on the very next successful read, seconds later (Codex DEPLOY-BLOCKER). The send axis
  // is cleared by noteProviderSendOk(), which is the success that actually means it.
  return (await patch(provider, (prev) => Object.assign(
    {}, fields, { errorSnooze: keepSnoozes(prev.errorSnooze, (r) => isSendReason(r)) },
  ))).next;
}

// TWO clocks, because the disclosure makes two claims and they can go stale independently:
// "this provider is collecting" and "the account it collects is X".

// (1) Is it still collecting? The alarm runs every 10 minutes by default (60 on the free plan), so
// a success older than this means collection stopped — and a provider that stopped collecting is
// not something a login is about to absorb. Generous against the cadence so a paused laptop does
// not blank a correct disclosure.
export const COLLECTING_TTL_MS = 3 * 60 * 60 * 1000;

// (2) How old may the LABEL be? Bounded by how often the extension can actually re-check: the
// Claude account is read from /api/account behind an 8-hour cache (bg/collect.js), so 8 hours is
// the freshest this can honestly be without paying an extra API call on every cycle.
//
// 🔴 It is measured from the OBSERVATION, never from the collection. Those came out the same in an
// earlier cut — a cache hit re-stamped the label — and that made the 3-hour bound unreachable: a
// label could be indefinitely old while reading as current, because collection kept succeeding.
// Codex's repro: two accounts in ONE team org, so the org-derived address never changes, the cache
// never refreshes, and the popup names the account that is NOT signed in.
export const ACCOUNT_LABEL_TTL_MS = 8 * 60 * 60 * 1000;

// Display order. Fixed rather than object-key order so the disclosure does not reshuffle itself
// between two openings of the same popup (storage key order follows write order).
const ACCOUNT_DISPLAY = [
  { provider: 'claude', label: 'Claude' },
  { provider: 'chatgpt', label: 'ChatGPT' },
  { provider: 'gemini', label: 'Gemini' },
];

/**
 * Every provider this install is CURRENTLY collecting, with the account it is collecting.
 *
 * The single place that decides "fresh enough to disclose", for the same reason
 * displayableProviderError() owns its own staleness rule: two consumers deriving it separately is
 * how they end up disagreeing about what the user is being told.
 *
 * 🔴 A provider with no fresh success is OMITTED, not shown with a blank or a guess. The purpose of
 * the disclosure is to tell the user which accounts get absorbed by a login; naming one that is no
 * longer being collected is a false statement, and naming none is an honest silence.
 */
export function collectingAccounts(state, now) {
  const t = typeof now === 'number' ? now : Date.now();
  const all = state && typeof state === 'object' ? state : {};
  const out = [];
  for (const row of ACCOUNT_DISPLAY) {
    const s = all[row.provider];
    if (!s || typeof s !== 'object') continue;
    if (typeof s.lastSuccessAt !== 'number' || (t - s.lastSuccessAt) > COLLECTING_TTL_MS) continue;
    // 🔴 THE LAST THING THAT HAPPENED WINS. Signing out of a provider records an error and leaves
    // the previous success standing, so a purely time-based rule keeps announcing "this browser
    // collects ChatGPT b@x" for up to COLLECTING_TTL_MS after the user signed out of it — a
    // present-tense sentence about something that stopped (Codex round 5). Stated as "the newest
    // signal is a failure" rather than a list of fatal error codes: any failure means we are not
    // collecting right now, and a provider that recovers says so within one alarm tick.
    if (s.lastError && typeof s.lastError.at === 'number' && s.lastError.at > s.lastSuccessAt) continue;
    if (!s.account) continue;
    // A label with no observation time predates this field; treat it as unknown rather than
    // grandfathering an age nobody recorded.
    if (typeof s.accountAt !== 'number' || (t - s.accountAt) > ACCOUNT_LABEL_TTL_MS) continue;
    out.push({ provider: row.provider, label: row.label, account: s.account });
  }
  return out;
}

// How often the same standing failure may be reported. A failing provider retries on every alarm
// tick, so reporting each one would measure our polling interval, not users. Once a day per
// (provider, reason) makes a day's event count read as "how many installs are stuck on this".
export const PROVIDER_GA_THROTTLE_MS = 24 * 60 * 60 * 1000;

/**
 * Tell GA why a provider is failing — the ONLY place that does.
 *
 * 🔴 Why the extension and not the server (#1021): the web already reports this via `pc_reason`,
 * but the web only sees people who OPEN the dashboard (~46% in 30 days, #804) — and somebody whose
 * collection is broken has less reason to visit, so the missing half is biased toward exactly the
 * population being measured. The extension sees every install. It also costs no worker, no D1 and
 * no AE, which is what ruled the server options out.
 *
 * 🔴 Only whitelisted codes reach this — `normalizeProviderError` ran first — so a raw API body
 * cannot become a GA dimension value. (`bg/collect.js` still sends Claude's raw `errorMsg` as
 * `collect_fail.error`; that is unregistered and separate, see #1021.)
 */
// The HTTP status is dropped everywhere below: `auth_failed:401` and `auth_failed:403` are ONE
// reason to GA and to the user-facing copy alike.
//
// 🔴 The throttle must compare the SAME value it reports. Comparing the full code let 401→403 read
// as "a changed reason", firing immediately while GA saw two identical `auth_failed` events — the
// 24h rule silently broken for the one code that carries a status (Codex DEPLOY-BLOCKER).
function baseReason(code) {
  return String(code || '').split(':')[0];
}

// 🔴 THE PREVIOUS REASON IS PASSED IN, not read off `prev.lastError`. Claude reports on the GA
// axis WITHOUT writing `lastError` (see CLAUDE_GA_REASON_CODES), so a hard-coded field read would
// have compared every Claude failure against `undefined` — "always a changed reason" — and fired
// on every alarm tick, measuring our polling interval instead of installs. One throttle, two
// callers, each naming the field it actually keeps.
function shouldReportFailure(prevReason, gaSentAt, code, now) {
  const sameAsBefore = !!prevReason && baseReason(prevReason) === baseReason(code);
  // A CHANGED reason is news and goes out immediately; an unchanged one waits out the throttle.
  return !(sameAsBefore && (now - (gaSentAt || 0)) < PROVIDER_GA_THROTTLE_MS);
}

/** Collection failed. `err` may be an Error, a string, or nothing (unknown → the generic code). */
export async function noteProviderError(provider, err) {
  const code = normalizeProviderError(provider, err);
  if (!code) return null;
  const now = Date.now();
  let report = false;
  // Decide AND stamp in one transition — see patch(). Two concurrent failures otherwise both read
  // the pre-stamp `gaSentAt` and both send.
  const { next } = await patch(provider, (prev) => {
    report = shouldReportFailure(prev && prev.lastError && prev.lastError.code, prev && prev.gaSentAt, code, now);
    const fields = { lastError: { code, at: now } };
    if (report) fields.gaSentAt = now;
    return fields;
  });
  // Fired OUTSIDE the serialized chain: GA must never delay or block a collection cycle.
  // ⚠️ `gaSentAt` therefore records the ATTEMPT, not a confirmed delivery — sendGAEvent swallows
  // its own failures. A blocked GA request costs one day of that reason, which is the right trade
  // against holding the write chain open on a network call (Codex FOLLOW-UP, accepted).
  if (report) sendGAEvent('provider_collect_fail', { provider, reason: baseReason(code) });
  return next;
}

// ── Claude: the reason axis only (#1143) ────────────────────────────────────────────────────
//
// 🔴 DELIBERATELY NOT AN ENTRY IN `PROVIDER_ERROR_CODES`, and the separation is the whole design.
// That table is a DISPLAY contract: test/provider-error-guard.mjs binds every code in it to an
// i18n string and to the web's actionable list, and `noteProviderError` writes `lastError` — which
// `listCollectingAccounts` reads as "stop naming this provider" and `liveProviderErrors` reads as
// "show a banner". Claude already has all of that on `lastStatus` (bg/storage.js), which
// ui/render.js owns and demotes against; a second copy is the double-messaging trap this file's
// header warns about, and it would change what the popup's login disclosure says as a SIDE EFFECT
// of adding telemetry. Claude joined this store for the account label alone, and still has.
//
// So Claude gets the reason on the GA axis and nothing else: same event, same already-registered
// dimensions (`provider`, `reason`), no new display state, no new i18n.
//
// The names mirror the throws in bg/api.js, which already carry `err_*` codes — they simply lack
// the provider segment every GA reason has. test/claude-ga-reason-guard.mjs asserts the two sets
// stay equal, so a new throw there cannot quietly normalise to the catch-all.
export const CLAUDE_GA_REASON_CODES = [
  'err_claude_auth_failed',
  'err_claude_cloudflare',
  'err_claude_no_cookies',
  'err_claude_rate_limit',
  'err_claude_session_expired',
  // #1162: promoted out of the catch-all. On the first readable day (2026-09-04) `collect_failed`
  // held 54% of Claude failures — the axis existed but could not say what was wrong, because
  // bg/api.js still threw prose for every non-2xx and every network fault. These three name the
  // three things the prose was hiding, and the status number is dropped as everywhere else.
  'err_claude_server',           // 5xx from claude.ai — we retry, the user does nothing
  'err_claude_http',             // any other non-2xx; nothing more specific is known
  'err_claude_network',          // the fetch itself rejected: offline, DNS, TLS
  'err_claude_collect_failed',   // the catch-all; unknown errors normalise to this
];

/**
 * A Claude collection error → exactly one whitelisted GA reason.
 *
 * 🔴 THE SAME SECURITY BOUNDARY AS `normalizeProviderError`, and it is not theoretical here:
 * bg/api.js interpolates `text.slice(0, 500)` of a Claude API response into one of its messages,
 * and bg/collect.js used to send that straight to GA as `collect_fail.error`. Anything
 * unrecognised collapses to the generic code rather than travelling.
 *
 * The HTTP status is dropped for the reason it is dropped everywhere else in this file:
 * `auth_failed:401` and `auth_failed:403` are ONE reason to GA and to the user alike.
 */
export function normalizeClaudeGaReason(err) {
  const raw = (err && err.message) || (typeof err === 'string' ? err : '');
  const key = baseReason(raw);
  // bg/api.js throws provider-less codes (`err_rate_limit`); a GA reason carries the segment.
  const code = key.indexOf('err_') === 0 ? `err_claude_${key.slice(4)}` : '';
  return CLAUDE_GA_REASON_CODES.indexOf(code) >= 0 ? code : 'err_claude_collect_failed';
}

/**
 * Claude collection failed → tell GA why, and touch nothing else.
 *
 * Shares the 24h-per-reason throttle with the other providers so a day's `provider_collect_fail`
 * count means the same thing for all three ("installs stuck on this reason"). It throttles against
 * the last REPORTED reason, kept in `gaReason`, because Claude writes no `lastError` to compare to.
 *
 * ⚠️ Same trade as `noteProviderError`: `gaSentAt` records the ATTEMPT (sendGAEvent swallows its
 * own failures), so a blocked GA request costs one day of that reason.
 */
export async function reportClaudeCollectFail(err) {
  // 🔴 THIS ONE SWALLOWS, unlike noteProviderError, and the difference is the CALLER. The other
  // collectors call that at the very end of their own catch; this runs inside bg/collect.js's
  // catch, UPSTREAM of the failure heartbeat — the signal the server turns into a disconnection
  // email. A rejecting storage write would skip it, so a telemetry fault would silently convert a
  // collection failure into a SILENT one, which is the whole class of defect #1143 is about.
  try {
    const code = normalizeClaudeGaReason(err);
    const now = Date.now();
    let report = false;
    // Decide AND stamp inside one serialized transition, for the reason patch() documents.
    const { next } = await patch('claude', (prev) => {
      report = shouldReportFailure(prev && prev.gaReason, prev && prev.gaSentAt, code, now);
      return report ? { gaSentAt: now, gaReason: code } : {};
    });
    if (report) sendGAEvent('provider_collect_fail', { provider: 'claude', reason: code });
    return next;
  } catch (e) {
    console.log(`[Claude Tuner] claude fail-reason report skipped: ${e && e.message}`);
    return null;
  }
}

/**
 * Why Claude is NOT BEING COLLECTED AT ALL — the half no failure axis can see (#1162).
 *
 * 🔴 A SKIP IS NOT A FAILURE, so it gets its own event rather than another `provider_collect_fail`
 * reason. `background.js` decides not to attempt Claude when the install looks like a non-Claude
 * user (no claude.ai session, no cached profile, no Claude org, but provider orgs present). No
 * attempt means no exception, and no exception means the failure axis — and the failure heartbeat,
 * and `users.last_error_code` — stay empty. From outside, an install in that state is
 * indistinguishable from one that is collecting fine. Folding it into `provider_collect_fail`
 * would fix the blindness by corrupting the counts it borrowed.
 *
 * The two reasons answer different questions on purpose:
 *   no_session   a STANDING state → throttled daily, so a day's count reads as "installs silent"
 *   org_pruned   a TRANSITION → not throttled, so a day's count reads as "installs that went
 *                silent today". It only fires when a row was actually removed, and after it the
 *                gate is self-sustaining (no Claude org ⇒ skip ⇒ no attempt ⇒ nothing to re-add)
 *                until the user signs back in to claude.ai.
 *
 * 🔴 ITS OWN THROTTLE FIELDS. Sharing `gaSentAt` with the failure axis would let a daily skip
 * consume the slot a real failure needed, and the two would silence each other in alternation.
 */
export const CLAUDE_SKIP_REASONS = ['no_session', 'org_pruned'];

export async function reportClaudeCollectSkipped(reason) {
  if (CLAUDE_SKIP_REASONS.indexOf(reason) < 0) return null;
  // Same swallow, same reason as reportClaudeCollectFail: this runs inside the collection
  // orchestration, upstream of the ChatGPT/Gemini merges, and telemetry must never hold them.
  try {
    if (reason === 'org_pruned') {
      sendGAEvent('provider_collect_skipped', { provider: 'claude', reason });
      return null;
    }
    const now = Date.now();
    let report = false;
    const { next } = await patch('claude', (prev) => {
      report = shouldReportFailure(prev && prev.gaSkipReason, prev && prev.gaSkipAt, reason, now);
      return report ? { gaSkipAt: now, gaSkipReason: reason } : {};
    });
    if (report) sendGAEvent('provider_collect_skipped', { provider: 'claude', reason });
    return next;
  } catch (e) {
    console.log(`[Claude Tuner] claude skip report skipped: ${e && e.message}`);
    return null;
  }
}

/** A snapshot POST failed for a reason no other surface reports. Ignores anything unlisted. */
export async function noteProviderSendError(provider, code) {
  if (!PROVIDER_ERROR_CODES[provider]) return null;
  if (PROVIDER_SEND_ERROR_CODES.indexOf(code) < 0) return null;
  return (await patch(provider, { lastSendError: { code, at: Date.now() } })).next;
}

/** A snapshot POST was accepted → the send channel is healthy again. */
export async function noteProviderSendOk(provider) {
  if (!PROVIDER_ERROR_CODES[provider]) return null;
  // Clears the SEND dismissals only, for the mirror of the reason noteProviderSuccess() clears
  // only the read ones: an accepted POST is evidence about our server, not about whether the user
  // is signed in to the provider.
  return (await patch(provider, (prev) => ({
    lastSendOkAt: Date.now(),
    lastSendError: null,
    errorSnooze: keepSnoozes(prev.errorSnooze, (r) => !isSendReason(r)),
  }))).next;
}

/**
 * The error worth SHOWING, or null.
 *
 * Separate from what is stored, so the popup and the web agree on staleness without each
 * re-deriving it. `null` means "nothing to say" — never "everything is fine".
 */
function liveError(e, okAt, now) {
  if (!e || !e.code) return null;
  if (typeof e.at !== 'number' || (now - e.at) > PROVIDER_ERROR_TTL_MS) return null;
  // A success after the error means the error is over even if nothing cleared it (defensive: the
  // clear is the primary path, but a write that lost a race must not resurrect a fixed fault).
  if (typeof okAt === 'number' && okAt >= e.at) return null;
  return e;
}

/**
 * 🔴 READ failure wins over SEND failure. If the provider API itself is not answering there is
 * nothing to send, so reporting "we could not reach our server" would name a downstream symptom
 * and send the user to fix the wrong thing. Consumers get ONE answer — they render a message, not
 * a diagnosis — while the two axes stay separate in storage so we can still tell them apart.
 */
export function displayableProviderError(state, now, syncPaused) {
  return liveProviderErrors(state, now, syncPaused)[0] || null;
}

/**
 * Every live failure, in the precedence order above — read first, then send.
 *
 * Exists for the one consumer that can DECLINE the first answer: the popup, where a reason may be
 * dismissed (#1130). Collapsing to a single value there meant a dismissed read failure took the
 * provider's whole row with it, muting a live `err_send_*` the user had never dismissed — a
 * different problem, with a different fix, silenced by a click that was not about it (Codex
 * DEPLOY-BLOCKER). Precedence and staleness stay HERE rather than being re-derived at the call
 * site; the caller only chooses how far down the list to look.
 */
export function liveProviderErrors(state, now, syncPaused) {
  const t = typeof now === 'number' ? now : Date.now();
  if (!state) return [];
  const out = [];
  const read = liveError(state.lastError, state.lastSuccessAt, t);
  if (read) out.push(read);
  // 🔴 A PAUSED INSTALL HAS NO SEND FAILURES TO REPORT (#1136). `serverSyncPaused` means the user
  // deliberately stopped sending; postSnapshot() then returns before the POST, so no cycle can
  // clear a `lastSendError` written before the pause — neither `noteProviderSendOk` (needs a 2xx)
  // nor `noteProviderSuccess` (which preserves the send axis on purpose) touches it. The stale
  // error therefore stands for its full 7-day TTL, and the popup showed "collected, but couldn't
  // be saved to Claude Tuner" NEXT TO the panel saying the user paused saving: a fault report for
  // something they asked for, which is the #967 shape (Codex SHIP-BLOCKER, cross-unit review of
  // #1119 × #1020).
  //
  // 🔴 Suppressed at READ, not cleared at the pause transition. Three reasons: storage.js cannot
  // import this module (`provider-state → analytics → storage` is a cycle the file already
  // documents at its onSendFailure callback), a read-time rule also covers an in-flight POST whose
  // failure lands just after the flip, and the stored fact stays whole — so resuming restores the
  // last thing we actually observed rather than a value we deleted. The READ axis is untouched:
  // "you are signed out of ChatGPT" is true whether or not we are sending.
  if (syncPaused !== true) {
    const send = liveError(state.lastSendError, state.lastSendOkAt, t);
    if (send) out.push(send);
  }
  return out;
}

// ── Dismissal (#1130) ───────────────────────────────────────────────────────────────────────
//
// 🔴 Kept OUT of displayableProviderError() on purpose, even though every popup caller pairs the
// two. That function is also what `get_status` hands to claudetuner.com, and the web runs its OWN
// snooze — keyed per ACCOUNT, because a dismissal on a shared machine must not silence the next
// person who signs in there. This one is keyed per INSTALL. Folding it in would export an
// install-wide silence into an account-scoped surface: one browser's × would hide a real fault
// from a different account's dashboard, and nothing on that screen could explain the silence.
// Consumers that want the dismissal ask for it; the stored fact stays whole for everyone else.

const isSendReason = (reason) => PROVIDER_SEND_ERROR_CODES.indexOf(reason) >= 0;

/** A live snooze is one that has not run out AND could have been written by this code. */
function snoozeLive(until, now) {
  // Both ends matter, and both err toward SHOWING. Not in the future → it ran out. Further out
  // than the window → nothing this code writes could land there, so it is a corrupt or tampered
  // value (or the clock moved backwards) and honouring it would mute a fault for years. Same rule,
  // and the same reasoning, as _ctProviderConnectLive() on the web.
  return typeof until === 'number' && until > now && until <= now + PROVIDER_ERROR_SNOOZE_MS;
}

/** The still-live entries `keep` selects, as a fresh object. Expired ones are dropped either way. */
function keepSnoozes(snooze, keep, now) {
  const t = typeof now === 'number' ? now : Date.now();
  const out = {};
  if (!snooze || typeof snooze !== 'object') return out;
  for (const reason of Object.keys(snooze)) {
    if (snoozeLive(snooze[reason], t) && keep(reason)) out[reason] = snooze[reason];
  }
  return out;
}

/**
 * Is this reason currently dismissed?
 *
 * 🔴 A MAP of reason → expiry, not one dismissal per provider. The two axes fail independently
 * (bg/storage.js can report a send failure for a provider that read perfectly), so they must be
 * dismissible independently: with a single slot, dismissing the send failure overwrote the read
 * dismissal and the message the user had already waved away came back.
 *
 * 🔴 Matched on the REASON, not the whole code, and not the provider alone:
 *   - the HTTP status is dropped, so dismissing `auth_failed:401` also covers `:403` — one reason
 *     to the user, exactly as baseReason() already defines it for GA;
 *   - a DIFFERENT failure is news and speaks. Silencing the provider outright would mean
 *     dismissing "you are not signed in" also hides "we could not reach our server", which is a
 *     different problem with a different fix and nothing to do with what the user waved away.
 */
export function providerErrorSnoozed(state, code, now) {
  const t = typeof now === 'number' ? now : Date.now();
  const s = state && state.errorSnooze;
  if (!s || typeof s !== 'object' || !code) return false;
  return snoozeLive(s[baseReason(code)], t);
}

/**
 * Dismiss the reason currently shown for `provider` (the popup's ×).
 *
 * Keyed by the reason it silenced rather than a bare timestamp, so the predicate above can tell a
 * dismissed failure from a new one. Ignores anything that is not a code we store — the × can only
 * ever be attached to a rendered error, so an unrecognised value is a bug, not a user action, and
 * a bug must not be able to mute something no reader recognises.
 *
 * The map is bounded by construction: a key can only be one of this provider's whitelisted codes
 * or a send code, and expired entries are dropped on every write.
 */
export async function snoozeProviderError(provider, code) {
  if (!PROVIDER_ERROR_CODES[provider]) return null;
  const reason = baseReason(code);
  if (!reason) return null;
  const known = (PROVIDER_ERROR_CODES[provider] || []).indexOf(reason) >= 0 || isSendReason(reason);
  if (!known) return null;
  return (await patch(provider, (prev) => {
    const now = Date.now();
    const next = keepSnoozes(prev.errorSnooze, () => true, now);
    next[reason] = now + PROVIDER_ERROR_SNOOZE_MS;
    return { errorSnooze: next };
  })).next;
}
