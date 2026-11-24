// Click-free Google re-login for a tokenless install that needs a login (#2997).
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
// SCOPE (widened 2026-11-24, #2997 follow-up): every tokenless state that needs a login —
//   auth_blocked  grandfathered install refused by the server after the sunset (the first target)
//   token_lost    signed in once, token since expired/cleared (serverSyncWithheldReason)
//   login_first   a new install that has not signed in yet. Works only for someone who granted the
//                 client before (dashboard, a previous install); a first-time user gets
//                 interaction_required and keeps the login card — Google needs that one click.
//
// 🔴 Invariants (each one is a way this could hurt somebody):
//  [1] Only while TOKENLESS in one of those states, never after an account deletion. A working
//      install is never touched, and a deleted account is never brought back (the server refuses
//      on a deleted or missing account as well — worker routes/auth.ts /ext-google-silent).
//  [1b] Never against the person's own choice: not after they signed out (SILENT_OPT_OUT_KEY, set by
//      the popup's account switch and cleared by the next real login), not while they chose
//      local-only (loginCtaCollapsed) or paused server sync (serverSyncPaused).
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
// Set when the person signs out (popup account switch); cleared whenever a token is stored again
// (bg/storage.js writeExtToken). While set, nothing here runs.
export const SILENT_OPT_OUT_KEY = 'authSilentOptOut';
// no_hint is reported at most once per interval on its own clock, WITHOUT spending the attempt:
// a fresh install has no provider profile for its first minutes, and burning the day's attempt on
// that would delay the first real try by ~20h.
const SILENT_NO_HINT_KEY = 'authSilentNoHintAt';
// Set on success, read (and removed) by the popup, which tells the person ONCE which account they
// were signed in as, with a way to switch (popup.js renderSilentLoginNotice). Nobody clicked, so
// they must be able to find out — and to undo it (user decision 2026-11-25).
export const SILENT_NOTICE_KEY = 'authSilentNotice';

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

/**
 * Why the person does not want to be signed in right now, or null. ONE definition, read before the
 * attempt and again at write time (background.js exchangeGoogleIdToken → setExtTokenIf), so a choice
 * made while Google was answering still wins (Codex wide-R1-B2).
 */
export function declinedReason(st) {
  if (st[SILENT_OPT_OUT_KEY] === true) return 'signed_out';   // signed out on purpose (account switch)
  if (st.loginCtaCollapsed === true) return 'local_only';      // chose 「local only」 in the popup
  if (st.serverSyncPaused === true) return 'sync_paused';      // paused server sync
  return null;
}

const sameEmail = (a, b) => typeof a === 'string' && typeof b === 'string'
  && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * @param {object} deps
 * @param {string} deps.clientId
 * @param {() => Promise<'auth_blocked'|'login_first'|'token_lost'|null>} deps.state
 *        which login-needing state this install is in (null = none: nothing to do)
 * @param {(state: string) => Promise<string|null|{skip: string}>} deps.identity  the account this install
 *        collects for; `{skip}` when it cannot be named safely (reported as that kind)
 * @param {(idToken: string) => Promise<{ok: boolean, error?: string}>} deps.exchange
 *        POST /api/auth/ext-google-silent + store the token (shared with GOOGLE_SIGNIN)
 * @param {(token: string) => object|null} deps.decode   unverified JWT payload reader
 * @param {(name: string, params: object) => void} deps.ga
 * @param {() => number} [deps.now]
 * @returns {Promise<string>} outcome (also the GA `kind`), or a skip reason that is not reported
 */
export async function runSilentRelogin(deps) {
  const now = (deps.now || Date.now)();
  const st = await chrome.storage.local.get({
    extToken: null, account_deleted: false, [SILENT_RELOGIN_LAST_KEY]: 0, [SILENT_NO_HINT_KEY]: 0,
    [SILENT_OPT_OUT_KEY]: false, loginCtaCollapsed: false, serverSyncPaused: false,
  });
  // [1] — nothing reported: these are the overwhelming majority of wakes.
  if (st.extToken || st.account_deleted === true) return 'skip';
  const state = await deps.state().catch(() => null);
  if (!state) return 'skip';
  // [1b] The person said no. Not reported either — it is not an attempt.
  const declined = declinedReason(st);
  if (declined) return declined;

  const recent = (key) => { const t = Number(st[key]) || 0; return t <= now && now - t < SILENT_RELOGIN_INTERVAL_MS; };
  // A stamp in the future (clock moved back) must not freeze the attempts forever.
  if (recent(SILENT_RELOGIN_LAST_KEY)) return 'throttled';
  // An old build without the permission, or a browser without the API: nothing to try.
  if (typeof chrome.identity?.launchWebAuthFlow !== 'function') return 'no_api';
  const report = (kind) => { try { deps.ga(SILENT_GA_EVENT, { kind, reason: state }); } catch { /* telemetry */ } return kind; };

  const id = await deps.identity(state).catch(() => null);
  if (id && typeof id === 'object' && typeof id.skip === 'string') {
    await chrome.storage.local.set({ [SILENT_RELOGIN_LAST_KEY]: now });
    return report(id.skip);
  }
  const hint = id;
  if (!hint || typeof hint !== 'string' || !hint.includes('@')) {
    if (recent(SILENT_NO_HINT_KEY)) return 'no_hint';
    await chrome.storage.local.set({ [SILENT_NO_HINT_KEY]: now });
    return report('no_hint');
  }

  // [3] Stamp before asking Google.
  await chrome.storage.local.set({ [SILENT_RELOGIN_LAST_KEY]: now });

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

  // The user may have signed in, signed out, or chosen local-only while Google was answering.
  // Their action wins (the exchange's write re-checks the same thing atomically — background.js).
  const again = await chrome.storage.local.get({
    extToken: null, account_deleted: false, [SILENT_OPT_OUT_KEY]: false, loginCtaCollapsed: false, serverSyncPaused: false,
  });
  if (again.extToken || again.account_deleted === true || declinedReason(again)) return report('raced');

  // Marker BEFORE the exchange: the exchange clears `authBlocked`, and the recovery edge reads the
  // episode keys in that same tick (background.js). Withdrawn if the exchange fails, so a later
  // manual sign-in is not credited to this path.
  await chrome.storage.local.set({ [SILENT_RECOVERED_KEY]: now });
  let res;
  try { res = await deps.exchange(parsed.idToken); } catch { res = { ok: false, error: 'network' }; }
  if (!res?.ok) {
    await chrome.storage.local.remove(SILENT_RECOVERED_KEY);
    return report(EXCHANGE_OUTCOMES[String(res?.error || '')] || 'server_error');
  }
  // The server's answer names the account the token is for (an alias resolves to its primary).
  await chrome.storage.local.set({ [SILENT_NOTICE_KEY]: { email: String(res.email || claims.email), at: now } });
  return report('ok');
}

let inFlight = null;
/** Single-flight: the SW-wake catch-up and the block edge can both fire in one wake. */
export function maybeSilentRelogin(deps) {
  if (!inFlight) inFlight = runSilentRelogin(deps).catch(() => 'error').finally(() => { inFlight = null; });
  return inFlight;
}
