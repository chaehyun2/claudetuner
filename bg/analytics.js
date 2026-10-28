// GA4 Measurement Protocol for Chrome Extension MV3
import { serverSyncWithheldReason } from './storage.js';
import { extTokenEmail } from './ext-token-claims.js';
import { SITE_TAB_PATTERNS } from './constants.js';
import { providerWanted, PROVIDER_PREF_DEFAULTS } from './grantable.js';
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
    // 🔴 ASK THE REASON, not the boolean. `isServerSyncGated()` is true only for 'login_first', so
    // a 'token_lost' install fell through to 'legacy' — and 'legacy' is supposed to mean "never
    // authenticated, syncing on the shared key by design". Folding a WITHHELD install into it
    // reports the exact opposite of that install's state, and it pollutes the one bucket used to
    // size the never-authenticated population (#772/#775). Splitting it out is additive: 'gated'
    // and 'legacy' keep their meanings, so series recorded before this build stay comparable.
    const reason = await serverSyncWithheldReason();
    if (reason === 'login_first') return 'gated';
    if (reason === 'token_lost') return 'token_lost';
    return 'legacy';
  } catch {
    return 'unknown';
  }
}

/**
 * Optional host permission state per provider — { perm_chatgpt, perm_gemini }, each
 * 'yes' | 'no' | 'off' | 'unknown'.
 *
 * WHY THIS EXISTS. chatgpt.com / gemini.google.com are OPTIONAL host permissions on purpose: moving
 * them to required `host_permissions` disables the extension for every install that has not
 * granted them (the 1.24.0 incident). Whether we can ever make them effectively mandatory depends
 * on how many installs are still missing them — a number nobody has. This sizes it, like
 * pinnedState/authState: enums only, no identity.
 *
 *   yes     — permission granted (regardless of the collect toggle: the permission is the question)
 *   no      — not granted, collection toggle still on → the population a prompt would reach
 *   off     — not granted AND the user turned that provider off (Settings, or the banner's "I don't
 *             use it", bg/grantable.js providerWanted) → a deliberate opt-out,
 *             not a missed prompt; folding it into 'no' would overstate who is left to ask
 *   unknown — the probe itself failed
 */
export async function providerPermState() {
  const out = {};
  // null = prefs unreadable: a missing grant then cannot be told apart from an opt-out → 'unknown'.
  let prefs = null;
  try { prefs = await chrome.storage.sync.get(PROVIDER_PREF_DEFAULTS); } catch { /* unknown */ }
  for (const provider of ['chatgpt', 'gemini']) {
    let state;
    try {
      const granted = await chrome.permissions.contains({ origins: [SITE_TAB_PATTERNS[provider]] });
      state = granted ? 'yes' : !prefs ? 'unknown' : (providerWanted(prefs, provider, false) ? 'no' : 'off');
    } catch {
      state = 'unknown';
    }
    out[`perm_${provider}`] = state;
  }
  return out;
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

/**
 * In-page sidebar fold toggles. The content scripts write `ct_sidebar_folded_<site>`
 * (usage-shared.js renderSidebarFold) and cannot reach GA themselves, so the service worker turns
 * each storage change into one `sidebar_fold` event per site whose state flipped.
 * @returns {{site: string, action: 'fold'|'unfold'}[]}
 */
export function sidebarFoldTransitions(changes) {
  const out = [];
  for (const [key, c] of Object.entries(changes || {})) {
    const m = /^ct_sidebar_folded_(claude|chatgpt|gemini)$/.exec(key);
    if (!m || !c) continue;
    const was = c.oldValue === true;
    const now = c.newValue === true;
    if (was !== now) out.push({ site: m[1], action: now ? 'fold' : 'unfold' });
  }
  return out;
}
