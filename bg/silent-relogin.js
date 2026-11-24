// Click-free Google re-login for a login-blocked install (#2997).
//
// WHY. Since the 2026-11-17 sunset of unproven shared-key tokens (#2469), ~2,000 installs collect
// locally but get 401 login_required on every POST. One week of popup cards, a sign-in tab and two
// mails brought back ~3% of them: these are people who never open the extension. But 61% of them
// once signed in to the dashboard with Google — i.e. they already granted THIS OAuth client
// (the web client shared with the dashboard). For them Google answers `prompt=none` with an
// id_token and no UI at all, measured 2026-11-24 on the shared test browser (#2997).
//
// HOW. launchWebAuthFlow({ interactive: false }) + prompt=none + login_hint=<the blocked account>.
// The id_token is verified by the server exactly as the one-click button's is (/api/auth/ext-google,
// signature + aud + email_verified), so this lowers no bar: it is the same proof, minus the click.
//
// 🔴 Invariants (each one is a way this could hurt somebody):
//  [1] Only while BLOCKED and TOKENLESS, never after an account deletion. A working install is never
//      touched, and a deleted account is never brought back (the server refuses `silent` on a
//      deleted or missing account as well — worker routes/auth.ts /ext-google).
//  [2] Same account or nothing. The id_token email must equal the identity this install collects
//      for. Google may answer for another signed-in account; installing that token would re-point
//      the install (and 403 every snapshot on the email mismatch) — RECOVER_EXT_TOKEN guard [3].
//  [3] At most one attempt per SILENT_RELOGIN_INTERVAL_MS, stamped BEFORE trying, so a crash or a
//      hang can never become a retry loop against accounts.google.com.
//  [4] Never interactive. No window, no tab, no permission prompt: if Google wants interaction we
//      stop and the existing nudges (badge, cards, sign-in tab) stay in charge.

export const SILENT_RELOGIN_LAST_KEY = 'authSilentAttemptAt';
// Read by authBlockRecoveryParams (bg/notifications.js) so `authblock_recovered` can say kind=silent.
export const SILENT_RECOVERED_KEY = 'authSilentRecoveredAt';
// A bit under a day so a once-a-day browser start is not skipped by a few minutes of clock drift.
export const SILENT_RELOGIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
export const SILENT_GA_EVENT = 'authblock_silent';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
// OAuth errors Google returns for prompt=none (OpenID Connect Core §3.1.2.6). Anything else is
// folded into 'oauth_error' so GA never receives free text.
const KNOWN_OAUTH_ERRORS = new Set([
  'interaction_required', 'login_required', 'consent_required', 'account_selection_required', 'access_denied',
]);

export function buildSilentAuthUrl({ clientId, redirectUri, nonce, hint }) {
  return GOOGLE_AUTH_URL
    + `?client_id=${encodeURIComponent(clientId)}`
    + '&response_type=id_token'
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&scope=${encodeURIComponent('openid email profile')}`
    + `&nonce=${encodeURIComponent(nonce)}`
    + '&prompt=none'
    + `&login_hint=${encodeURIComponent(hint)}`;
}

/** The id_token or the OAuth error from the redirect URL's fragment (implicit flow). */
export function parseSilentRedirect(redirect) {
  let frag;
  try { frag = new URLSearchParams(new URL(redirect).hash.slice(1)); } catch { return { error: 'bad_redirect' }; }
  const idToken = frag.get('id_token');
  if (idToken) return { idToken };
  const err = frag.get('error');
  return { error: err && KNOWN_OAUTH_ERRORS.has(err) ? err : 'oauth_error' };
}

// exchange() error code → GA kind. `raced`: the single-writer re-check refused (a manual sign-in won).
// `not_found`: a worker without /ext-google-silent (it wrote nothing).
const EXCHANGE_OUTCOMES = {
  silent_account_deleted: 'server_account_deleted', silent_no_account: 'server_no_account',
  raced: 'raced', not_found: 'server_unsupported',
};

const sameEmail = (a, b) => typeof a === 'string' && typeof b === 'string'
  && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * @param {object} deps
 * @param {string} deps.clientId
 * @param {() => Promise<string|null|{skip: string}>} deps.identity  the account this install
 *        collects for; `{skip}` when it cannot be named safely (reported as that kind)
 * @param {(idToken: string) => Promise<{ok: boolean, error?: string}>} deps.exchange
 *        POST /api/auth/ext-google {silent:true} + store the token (shared with GOOGLE_SIGNIN)
 * @param {(token: string) => object|null} deps.decode   unverified JWT payload reader
 * @param {(name: string, params: object) => void} deps.ga
 * @param {string} [deps.trigger]                        GA `reason`: wake | edge | startup
 * @param {() => number} [deps.now]
 * @returns {Promise<string>} outcome (also the GA `kind`), or a skip reason that is not reported
 */
export async function runSilentRelogin(deps) {
  const now = (deps.now || Date.now)();
  const st = await chrome.storage.local.get({
    authBlocked: false, extToken: null, account_deleted: false, [SILENT_RELOGIN_LAST_KEY]: 0,
  });
  // [1] — and nothing reported: these are the overwhelming majority of wakes.
  if (st.authBlocked !== true || st.extToken || st.account_deleted === true) return 'skip';
  const last = Number(st[SILENT_RELOGIN_LAST_KEY]) || 0;
  // A stamp in the future (clock moved back) must not freeze the attempts forever.
  if (last <= now && now - last < SILENT_RELOGIN_INTERVAL_MS) return 'throttled';
  // An old build without the permission, or a browser without the API: nothing to try.
  if (typeof chrome.identity?.launchWebAuthFlow !== 'function') return 'no_api';

  // [3] Stamp first.
  await chrome.storage.local.set({ [SILENT_RELOGIN_LAST_KEY]: now });
  const report = (kind) => { try { deps.ga(SILENT_GA_EVENT, { kind, reason: deps.trigger || 'wake' }); } catch { /* telemetry */ } return kind; };

  const id = await deps.identity().catch(() => null);
  if (id && typeof id === 'object' && typeof id.skip === 'string') return report(id.skip);
  const hint = id;
  if (!hint || typeof hint !== 'string' || !hint.includes('@')) return report('no_hint');

  const nonce = crypto.randomUUID();
  const url = buildSilentAuthUrl({ clientId: deps.clientId, redirectUri: chrome.identity.getRedirectURL(), nonce, hint });
  let redirect;
  try {
    // [4] interactive:false — Chrome loads the page in a hidden frame and rejects instead of showing it.
    redirect = await chrome.identity.launchWebAuthFlow({ url, interactive: false });
  } catch (e) {
    return report(/interaction/i.test(String(e?.message || e)) ? 'interaction_required' : 'flow_failed');
  }
  if (!redirect) return report('flow_failed');
  const parsed = parseSilentRedirect(redirect);
  if (!parsed.idToken) return report(parsed.error);

  const claims = deps.decode(parsed.idToken);
  if (!claims || claims.nonce !== nonce) return report('nonce_mismatch');
  // [2] Client-side read of an UNVERIFIED payload — enough to decide not to send it; authenticity
  // stays the server's job.
  if (!sameEmail(claims.email, hint)) return report('mismatch');

  // The user may have signed in by hand while Google was answering. Their login wins.
  const again = await chrome.storage.local.get({ authBlocked: false, extToken: null, account_deleted: false });
  if (again.authBlocked !== true || again.extToken || again.account_deleted === true) return report('raced');

  // Marker BEFORE the exchange: the exchange clears `authBlocked`, and the recovery edge reads the
  // episode keys in that same tick (background.js). Withdrawn if the exchange fails, so a later
  // manual sign-in is not credited to this path.
  await chrome.storage.local.set({ [SILENT_RECOVERED_KEY]: now });
  let res;
  try { res = await deps.exchange(parsed.idToken); } catch { res = { ok: false, error: 'network' }; }
  if (!res?.ok) {
    await chrome.storage.local.remove(SILENT_RECOVERED_KEY);
    const code = String(res?.error || '');
    return report(EXCHANGE_OUTCOMES[code] || 'server_error');
  }
  return report('ok');
}

let inFlight = null;
/** Single-flight: the SW-wake catch-up and the block edge can both fire in one wake. */
export function maybeSilentRelogin(deps) {
  if (!inFlight) inFlight = runSilentRelogin(deps).catch(() => 'error').finally(() => { inFlight = null; });
  return inFlight;
}
