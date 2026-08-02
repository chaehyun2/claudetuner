// GA4 Measurement Protocol for Chrome Extension MV3
import { isServerSyncGated } from './storage.js';
import { extTokenEmail } from './ext-token-claims.js';
const GA_MEASUREMENT_ID = 'G-ZMWJBD64FQ';
const GA_API_SECRET = 'emqPWfUzSqOvqvLtbh8BuQ';
const GA_ENDPOINT = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;

async function getOrCreateClientId() {
  const { ga_client_id } = await chrome.storage.local.get('ga_client_id');
  if (ga_client_id) return ga_client_id;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ ga_client_id: id });
  return id;
}

/**
 * Whether the toolbar icon is pinned — 'yes' | 'no' | 'unknown'.
 *
 * WHY THIS IS WORTH KNOWING. The badge is the only ALWAYS-ON signal we have for a broken sync (a
 * red "!" on the icon), and the auth-blocked ladder is deliberately bounded *because* of it — the
 * design note says in so many words that the badge "already persists until they fix it", which is
 * what makes a 4-rung ladder enough. An UNPINNED icon lives in the overflow menu, where no badge
 * is visible. For those users that premise is simply false, and nobody has ever checked how many
 * of them there are.
 *
 * 🔴 'unknown' is a third value on purpose: getUserSettings() is Chrome 91+, and folding a missing
 * API into 'no' would invent unpinned users and overstate exactly the problem we are trying to
 * size.
 */
export async function pinnedState() {
  try {
    const s = await chrome.action.getUserSettings();
    return s?.isOnToolbar === true ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}

/**
 * How this install stands with the server — 'authed' | 'gated' | 'legacy'.
 *
 * WHY THIS EXISTS. A login-first install that has not authenticated never POSTs, so it creates no
 * `users` row and no snapshot: the server does not merely lack its address, it does not know the
 * install EXISTS (#775). That makes the population the whole re-engagement campaign targets
 * unmeasurable — and with no denominator, "did the nudge work" has no answer either.
 *
 * Riding a GA event answers the SIZING question with no server change at all. What it deliberately
 * does NOT do is identify anyone: there is no email and no install id here, so this can size the
 * group and never target it. That distinction is the reason #775 was scoped the way it was.
 *
 * Three values, not two, because "no token" covers two different populations:
 *   authed — holds a USABLE ext_token; syncing normally
 *   stale  — holds a token the client itself rejects (expired / malformed). The gate is open but
 *            the server will not accept it: neither gated nor legacy, and folding it into either
 *            would misreport the very population #745 was about
 *   gated  — login-first install, never authenticated  ← the A0 population
 *   legacy — grandfathered existing user with no token; still syncing via the shared api_key
 * Collapsing these would hide which of them is actually growing.
 */
export async function authState() {
  try {
    const { extToken } = await chrome.storage.local.get(['extToken']);
    // 🔴 A STORED token is not a USABLE one. extTokenEmail rejects the wrong issuer, an expired
    // exp, and anything unparseable — and tokens expire after 90 days, so an install idle that
    // long still holds a string that is worthless. Counting those as 'authed' would undercount
    // exactly the population this measurement exists to size. (Codex.)
    if (extToken) return extTokenEmail(extToken) ? 'authed' : 'stale';
    // 🔴 ASK the gate, never re-derive it. A first draft of this function tested
    // `serverSyncGrandfathered === true` itself — a second copy of the rule, which is precisely
    // what drifted in #786 the moment the real predicate became `!== true`. Tokenless AND gated is
    // the A0 population; tokenless and NOT gated is a grandfathered user still on the shared key.
    return (await isServerSyncGated()) ? 'gated' : 'legacy';
  } catch {
    return 'unknown';
  }
}

export async function sendGAEvent(name, params = {}) {
  try {
    const clientId = await getOrCreateClientId();
    await fetch(GA_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        client_id: clientId,
        events: [{ name, params }],
      }),
    });
  } catch (_) {
    // Silently ignore GA failures
  }
}
