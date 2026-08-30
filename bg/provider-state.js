// Per-provider collection state — the ONE place that answers "is ChatGPT/Gemini collecting, and
// if not, why". Written by the collectors, read by the popup and (via `get_status`) by the web.
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
export async function noteProviderSuccess(provider) {
  return patch(provider, { lastSuccessAt: Date.now(), lastError: null });
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
