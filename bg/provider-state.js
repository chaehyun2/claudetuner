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

const KEY = 'providerCollectionState';

// Display suppression: an error nobody has re-attempted in this long is history, not a diagnosis.
// (Clearing on success is the primary rule — this only covers a provider that stopped being
// collected at all, e.g. the setting was switched off while it was failing.)
export const PROVIDER_ERROR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 🔴 Only these codes may be stored. A raw `e.message` can carry an API response fragment
// (bg/api-chatgpt.js includes `text.slice(0, 500)` in one throw), and this state is handed to the
// web through `get_status` — so anything unrecognised becomes the generic code instead of being
// passed through (Codex review). Keep in sync with the throws in bg/api-{chatgpt,gemini}.js and
// with the i18n keys; test/provider-error-guard.mjs asserts all three agree.
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

function patch(provider, fields) {
  const run = async () => {
    const all = await getProviderState();
    const cur = (all[provider] && typeof all[provider] === 'object') ? all[provider] : {};
    all[provider] = Object.assign({}, cur, fields);
    await chrome.storage.local.set({ [KEY]: all });
    return all[provider];
  };
  // Chain off the previous patch, and never let one failure break the chain for the next caller.
  const next = _patchChain.then(run, run);
  _patchChain = next.then(() => {}, () => {});
  return next;
}

/** An attempt started. Recorded even when it then fails — "when did we last try" is half of a diagnosis. */
export async function noteProviderAttempt(provider) {
  return patch(provider, { lastAttemptAt: Date.now() });
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
  const fields = { lastSuccessAt: Date.now(), lastError: null };
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
  return patch(provider, fields);
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

/** Collection failed. `err` may be an Error, a string, or nothing (unknown → the generic code). */
export async function noteProviderError(provider, err) {
  const code = normalizeProviderError(provider, err);
  if (!code) return null;
  return patch(provider, { lastError: { code, at: Date.now() } });
}

/**
 * The error worth SHOWING, or null.
 *
 * Separate from what is stored, so the popup and the web agree on staleness without each
 * re-deriving it. `null` means "nothing to say" — never "everything is fine".
 */
export function displayableProviderError(state, now) {
  const e = state && state.lastError;
  if (!e || !e.code) return null;
  const t = typeof now === 'number' ? now : Date.now();
  if (typeof e.at !== 'number' || (t - e.at) > PROVIDER_ERROR_TTL_MS) return null;
  // A success after the error means the error is over even if nothing cleared it (defensive: the
  // clear above is the primary path, but a write that lost a race must not resurrect a fixed fault).
  if (typeof state.lastSuccessAt === 'number' && state.lastSuccessAt >= e.at) return null;
  return e;
}
