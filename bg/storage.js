import { extTokenScope, extTokenEmail } from './ext-token-claims.js';
import { DEFAULT_INTERVAL_MINUTES, HISTORY_MAX_AGE_MS, DEFAULT_SERVER_URL, DEFAULT_API_KEY, ALARM_NAME, AUTH_BLOCK_BACKOFF_BASE_MS, AUTH_BLOCK_BACKOFF_CAP_MS, TOKEN_RETRY_BASE_MS, TOKEN_RETRY_MAX_ATTEMPTS, TOKEN_RETRY_COOLDOWN_MS } from './constants.js';
import { withStorageLock } from './serialize.js';
import { noteServerFailure, noteServerSuccess } from './send-gate.js';
import { noteUpgradeRequired, isUpgradePostSuppressed, isUpgradeBlocked, clearUpgradeBlocked } from './upgrade-gate.js';
import { applyServerCadence } from './cadence-config.js';

export async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        serverUrl: DEFAULT_SERVER_URL,
        apiKey: DEFAULT_API_KEY,
        intervalMinutes: DEFAULT_INTERVAL_MINUTES,
        intervalExplicitlySet: false,
        optimizationMode: 'notify_only',
        selectedOrgId: null,
      },
      resolve
    );
  });
}

// `lastStatus` is the CLAUDE collector's status object, but it is also the only container the
// per-provider recommendation map (`recommendations_by_provider`, written by postSnapshot below)
// has ever lived in. Several Claude paths in bg/collect.js rewrite lastStatus as a FRESH object
// literal — carrying `recommendation` forward by hand but not the map — so every Claude alarm tick
// silently deleted the ChatGPT/Gemini recs that a provider POST had just stored.
//
// Preserving the map HERE, at the single choke point, rather than at each call site, is the point:
// patching the writers that exist today leaves the NEXT writer to rediscover the bug, which is
// exactly how this defect class kept recurring. A caller that genuinely means to drop the map can
// pass it explicitly (an own `recommendations_by_provider` key wins, including `undefined` via
// hasOwnProperty), and `setStatus(null)` still clears everything — background.js relies on that.
// Pinned by test/rec-delivery-guard.mjs.
export async function setStatus(status) {
  if (status && typeof status === 'object'
      && !Object.prototype.hasOwnProperty.call(status, 'recommendations_by_provider')) {
    const prev = await getLastStatus();
    if (prev && prev.recommendations_by_provider) {
      status = Object.assign({}, status, {
        recommendations_by_provider: prev.recommendations_by_provider,
      });
    }
  }
  return chrome.storage.local.set({ lastStatus: status });
}

export async function getLastStatus() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ lastStatus: null }, (result) => {
      resolve(result.lastStatus);
    });
  });
}

// Org-less bucket key. Must equal REC_ORG_NONE in worker/src/services/snapshot-service.ts and the
// literal in ui/org-selector.js — a runtime boundary, so the guard asserts the three agree.
export const REC_ORG_NONE = '-';

// === EXT REC INVALIDATION: BEGIN (pinned by test/rec-delivery-guard.mjs) ===
// setStatus() preserves `recommendations_by_provider` across every ordinary status write. That
// fixed rec LOSS (a Claude alarm tick used to wipe the ChatGPT rec), but preservation with no
// expiry is the opposite failure: a rec can outlive the signal it was computed from.
//
// Concretely: sign out of ChatGPT and collectChatGPT() returns no orgs, mergeChatGPTOrgs() leaves
// the previously-collected orgs in place, and the popup happily renders yesterday's downgrade —
// a confident recommendation with nothing behind it. That is THE invariant of this feature broken
// in slow motion: the current signal is MISSING, and missing means insufficient_data, never "keep
// showing the old answer" (docs/SPEC-chatgpt-plan-rec.md).
//
// So preservation must survive an ordinary status write but NOT a lost signal. This reconciles the
// stored map against what a provider collection just observed, at the one place that observation
// lands. Deliberately a reconciler rather than invalidation calls sprinkled at each call site: the
// same reasoning that put preservation in setStatus(). A new collector inherits the behaviour.
//
// Three ways a rec becomes stale, all handled here:
//   1. provider signed out / unreadable  → NO orgs observed → drop the provider's whole map
//   2. org no longer collected           → drop that org's entry
//   3. plan changed under the rec        → drop it; it judged a plan the user no longer holds
//
// Claude is exempt: it does not use this map (it writes the legacy single `recommendation` slot),
// and its own staleness is handled by setStatus(null) on the auth-failure paths in background.js.
export async function reconcileProviderRecs(provider, orgs) {
  if (!provider || provider === 'claude') return;
  const cur = await getLastStatus();
  const byProv = cur && cur.recommendations_by_provider;
  if (!byProv || !byProv[provider]) return; // nothing stored for this provider

  const observed = Array.isArray(orgs) ? orgs : [];
  const next = Object.assign({}, byProv);

  if (!observed.length) {
    // (1) The signal is gone, not merely quiet. Note this is the case where collectedOrgs still
    // holds the stale org, so the popup WOULD still render a row for it — dropping the rec is the
    // only thing standing between the user and a stale downgrade.
    delete next[provider];
  } else {
    const livePlanByOrg = new Map(observed.map((o) => [(o && o.uuid) || REC_ORG_NONE, o && o.plan]));
    const kept = {};
    for (const [orgKey, rec] of Object.entries(byProv[provider])) {
      if (!livePlanByOrg.has(orgKey)) continue;                          // (2)
      if (!_recMatchesPlan(rec, livePlanByOrg.get(orgKey))) continue;    // (3)
      kept[orgKey] = rec;
    }
    if (Object.keys(kept).length) next[provider] = kept;
    else delete next[provider];
  }

  // An OWN `recommendations_by_provider` key wins over setStatus()'s preservation — that escape
  // hatch is documented above and is exactly what a deliberate drop needs.
  await setStatus(Object.assign({}, cur, { recommendations_by_provider: next }));
}

// Did this rec judge the plan the org currently holds? The rec carries the plan it was computed
// against (`current_plan`, preserved through the server's formatForExtension shim on both
// branches). An UNKNOWN basis is not evidence of change, so it is kept — invalidating on missing
// information would silently delete good recs, which is the bug this whole area started with.
function _recMatchesPlan(rec, livePlan) {
  const basis = rec && rec.current_plan;
  if (!basis || !livePlan) return true;
  return String(basis).trim().toLowerCase() === String(livePlan).trim().toLowerCase();
}
// === EXT REC INVALIDATION: END ===

// Usage history (kept for 30 days; sparkline only shows 24h)
export async function appendUsageHistory(point) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ usageHistory: [] }, (result) => {
      const history = result.usageHistory;
      history.push(point);
      // Remove data older than retention period
      const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
      const trimmed = history.filter((p) => p.t > cutoff);
      chrome.storage.local.set({ usageHistory: trimmed }, resolve);
    });
  });
}

// Merge server snapshots into local history (r7 data bootstrap)
export async function mergeServerSnapshots(serverSnaps, currentPlan, orgUuid) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ usageHistory: [] }, (result) => {
      const history = result.usageHistory;
      const existingTimes = new Set(history.map(p => Math.round(p.t / 60000))); // Deduplicate at minute granularity
      let added = 0;
      for (const s of serverSnaps) {
        const t = new Date(s.collected_at).getTime();
        const tMin = Math.round(t / 60000);
        if (existingTimes.has(tMin)) continue;
        history.push({
          t,
          h5: s.five_hour_utilization,
          d7: s.seven_day_utilization,
          p: currentPlan,
          r7: s.seven_day_resets_at || null,
          org: orgUuid || null,
          eu: s.extra_usage_used ?? null,
          el: s.extra_usage_limit ?? null,
        });
        existingTimes.add(tMin);
        added++;
      }
      if (added > 0) {
        history.sort((a, b) => a.t - b.t);
        const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
        const trimmed = history.filter((p) => p.t > cutoff);
        chrome.storage.local.set({ usageHistory: trimmed }, () => {
          console.log(`[Claude Tuner] Merged ${added} server snapshots into local history`);
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

export async function getUsageHistory() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ usageHistory: [] }, (result) => {
      resolve(result.usageHistory);
    });
  });
}

// --- Gemini metered-usage stickiness ---
// planId=2 is returned for BOTH genuine Google Workspace seats (usage pinned at 0%,
// truly unlimited) AND consumer paid accounts (e.g. AI Pro, real metered usage). The
// plan label alone can't tell them apart, so a plan-based no-limits check wrongly hides
// real usage for consumer accounts. Records, per provider account, whether we've EVER
// observed real (>0) utilization; once seen, the account is metered forever. Returns
// true if this account has ever been metered (so the caller can clear noLimits).
export async function recordGeminiMetered(accountId, hasUsageNow) {
  if (!accountId) return hasUsageNow;
  return new Promise((resolve) => {
    chrome.storage.local.get({ geminiMeteredSeen: {} }, (result) => {
      const seen = result.geminiMeteredSeen || {};
      if (seen[accountId]) { resolve(true); return; }
      if (!hasUsageNow) { resolve(false); return; }
      seen[accountId] = true;
      chrome.storage.local.set({ geminiMeteredSeen: seen }, () => resolve(true));
    });
  });
}

// --- Gemini Ultra sub-tier stickiness ---
// AI Ultra 5x and 20x share one policy; the sub-tier is derived from the quota (remaining
// window value). That quota signal is OPTIONAL and may go away — if it does, we must still
// serve the right multiplier. So we remember the last resolved sub-tier per account: pass the
// freshly-derived value to persist it, or pass null to look up the remembered one. Returns the
// effective sub-tier ('AI Ultra 5x' | 'AI Ultra 20x' | null when never determined).
export async function rememberGeminiUltraTier(accountId, freshSub) {
  if (!accountId) return freshSub || null;
  return new Promise((resolve) => {
    chrome.storage.local.get({ geminiUltraTier: {} }, (result) => {
      const map = result.geminiUltraTier || {};
      if (!freshSub) { resolve(map[accountId] || null); return; }        // no quota this cycle → remembered
      if (map[accountId] === freshSub) { resolve(freshSub); return; }    // unchanged
      map[accountId] = freshSub;
      chrome.storage.local.set({ geminiUltraTier: map }, () => resolve(freshSub));
    });
  });
}

// --- ext_token management (per-user JWT for server auth) ---

export async function getExtToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ extToken: null }, (r) => resolve(r.extToken));
  });
}

// Stable per-installation id (effectively per browser profile, since
// chrome.storage.local is profile-scoped). Created once, then persisted. Sent
// with each snapshot so the server can attribute snapshots to a specific install
// and measure multi-browser usage (distinct install_id per user_email) — needed
// to decide whether server-side dedup can be removed.
//
// Memoized per service-worker instance: the 4 payloads in one cycle (and any
// overlapping cycle in the same SW) share one in-flight read-or-create, so they
// can't each generate a different UUID before the first persists (which would
// transiently overcount one install as several). Reset on failure so a transient
// storage error doesn't poison the cache forever.
let _installIdPromise = null;
export function getOrCreateInstallId() {
  if (!_installIdPromise) {
    _installIdPromise = (async () => {
      const { install_id } = await chrome.storage.local.get('install_id');
      if (install_id) return install_id;
      // 12 hex chars (48-bit). Only needs to distinguish a handful of installs
      // per user_email (we always group by it), so a full 36-char UUID is wasteful
      // on every snapshot row — this is ~1/3 the column size with collision odds
      // ~0 for a user's few browsers.
      const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
      await chrome.storage.local.set({ install_id: id });
      return id;
    })().catch((e) => { _installIdPromise = null; throw e; });
  }
  return _installIdPromise;
}

export async function setExtToken(token) {
  await chrome.storage.local.set({ extToken: token });
  // A token is now HELD, so any token-withheld retry episode is over. Clearing here — the one
  // place a token is ever persisted — rather than where a token is merely OBSERVED in a response:
  // simpleAuthedPost sees extra-org responses that carry `ext_token` and does NOT store them, so
  // clearing on observation would cancel the retry while the install stayed tokenless (Codex
  // review). This choke point also covers the login paths (verify-code / Google / dashboard
  // recovery), which should end an episode just as much as a TOFU mint does.
  await chrome.storage.local.remove(TOKEN_RETRY_KEY);
}

// Token claim readers live in a leaf module (bg/ext-token-claims.js) so the popup can use
// them without importing this file's dependency chain. Re-exported so existing importers of
// storage.js keep working; imported too because setExtTokenNoDowngrade() calls extTokenScope
// locally (a bare `export ... from` would NOT create that local binding).
export { extTokenScope, extTokenEmail };

/**
 * Persist a server-issued ext_token, but NEVER downgrade a login-proven `full` token
 * to an `ingest` one (Phase 2 단계 4, Fable review defense-in-depth). The server already
 * preserves scope on piggyback refresh (단계 2), but a client guard means a single stray
 * `ingest` refresh can't silently strip a logged-in user's `full` scope — which would
 * defeat the 단계-4 adoption gate. Use this for TOFU/refresh persists; the login flow
 * (verify-code) uses plain setExtToken since it is the authoritative `full` issuer.
 */
export async function setExtTokenNoDowngrade(token) {
  const current = await getExtToken();
  if (current && extTokenScope(current) === 'full' && extTokenScope(token) === 'ingest') {
    console.log('[Claude Tuner] kept full ext_token (refresh returned ingest — no downgrade)');
    return;
  }
  return setExtToken(token);
}

export async function clearExtToken() {
  return chrome.storage.local.remove('extToken');
}

/**
 * The identity an ingest POST is attributed to. ONE implementation for all three collectors —
 * they each carried their own precedence, which is how Claude drifted into a different rule
 * from ChatGPT/Gemini (docs/DESIGN-authenticated-attribution.md).
 *
 * 🔑 THE RULE: identity comes from AUTHENTICATION; a provider's own email is only a label.
 * If this install proved it is A, everything it collects belongs to A — including providers
 * whose accounts are B and C. That inverts the old trust direction, in which the body email of
 * an UNAUTHENTICATED POST was taken as identity: the #179/#180 oracle, the [C1] guard and the
 * disclosure that killed D-2 all trace back to that one assumption.
 *
 * Priority:
 *  1. linkedCanonical — a verified `claudeAliasLink`. See the 🔴 note below: this outranks the
 *     token on purpose.
 *  2. ext_token email — the identity the SERVER minted for this install. `extTokenEmail`
 *     checks issuer + expiry, so a stale token falls through instead of misattributing.
 *  3. accountCache.email — the Claude account. Legacy canonical, kept for installs with no
 *     token yet (their first POST is still api_key TOFU until 단계 6 removes that path).
 *  4. independentAccount.email — email-login identity for users with no Claude account.
 *  5. the provider's own email — TOFU last resort.
 *
 * 🔴 WHY A LINK OUTRANKS THE TOKEN (Codex review of PR #702 caught the inverse, with a runnable
 * repro). Linking does NOT refresh the token: `_finishEmailLink` (ui/render.js) only writes
 * `claudeAliasLink`, and `/api/auth/claude-link/verify` returns no token. So the moment after a
 * user links personal@ → work@, the install still holds a token bound to personal@ — valid, not
 * expired, so rule 2 happily returns it. Ranking the token first therefore UNDOES the link the
 * user just made, and it is stable, not transient: the server sees authedEmail === bodyEmail,
 * skips its alias lookup, and re-mints under personal@ every cycle. The user is told "Linked —
 * Claude usage will start syncing shortly" while nothing of the sort happens.
 * A verified link is itself a server-established fact (verify requires a valid token AND inbox
 * proof), so it is the NEWER authenticated statement — not an exception to "authentication
 * decides identity" but an application of it.
 *
 * 🔴 Rule 2 is what makes `user_aliases` unnecessary GOING FORWARD: an install that reports the
 * address its own token already names cannot hit ingest's 403 email mismatch, so it never falls
 * back to the shared api_key and never needs a link. It applies to installs with no link.
 */

/**
 * Pure precedence, split out so it can be tested by executing it rather than by regex-matching
 * this file. The first cut of the guard only pattern-matched, which is exactly why it could not
 * catch the link regression above.
 */
export function pickIngestIdentity({ linkedCanonical, tokenEmail, accountEmail, independentEmail, providerEmail }) {
  return linkedCanonical || tokenEmail || accountEmail || independentEmail || providerEmail || null;
}

export async function resolveIngestIdentity(providerEmail, linkedCanonical) {
  const { extToken, accountCache, independentAccount } = await chrome.storage.local.get({
    extToken: null, accountCache: null, independentAccount: null,
  });
  return pickIngestIdentity({
    linkedCanonical,
    tokenEmail: extTokenEmail(extToken),
    accountEmail: accountCache?.email,
    independentEmail: independentAccount?.email,
    providerEmail,
  });
}

/**
 * Race-safe token clear. Only clears if a Bearer token was sent AND the stored
 * token still matches that exact token. This prevents a late-arriving auth
 * failure from one request from deleting a freshly rotated token stored by
 * another concurrent request, and skips the clear entirely when the request
 * used API_KEY fallback (no Bearer sent).
 */
export async function clearExtTokenIfMatches(sentToken) {
  if (!sentToken) return false;
  const currentToken = await getExtToken();
  if (currentToken !== sentToken) return false;
  await clearExtToken();
  return true;
}

/**
 * Phase 2 단계 4 login-first gate. True when this is a FRESH install (grandfathered === false,
 * set on 'install') that has NOT logged in (no extToken). Such installs show usage LOCALLY but
 * do NOT POST to the server via the shared api_key — so no ingest-token TOFU is minted for new
 * users (closing the oracle at the source for the growing population). Existing users are
 * grandfathered on 'update' (=== true) and any extToken (login OR a prior token) opens the gate,
 * so real/existing users' server sync is never withheld. `undefined` (never initialized) is
 * treated as NOT gated — favouring existing users during the brief update-time window.
 */
export async function isServerSyncGated() {
  const { serverSyncGrandfathered, extToken } = await chrome.storage.local.get({ serverSyncGrandfathered: undefined, extToken: null });
  return serverSyncGrandfathered === false && !extToken;
}

/**
 * Build auth headers for server requests.
 * Uses ext_token (Bearer) if available, otherwise falls back to shared API key.
 */
export async function getAuthHeaders(config) {
  const extToken = await getExtToken();
  if (extToken) {
    return { 'Authorization': `Bearer ${extToken}` };
  }
  return { 'X-API-Key': config.apiKey };
}

/**
 * fetch wrapper with auto auth header injection. On 401, clears the stored
 * ext_token so the next call falls back to API_KEY and re-issues a fresh token.
 *
 * Guarded against two failure modes:
 *  - Late-arriving 401 for an in-flight request after the token was rotated
 *    (only clears if the stored token still matches the one we actually sent).
 *  - API_KEY fallback paths receiving a 401 (no Bearer was sent → never clear).
 *
 * Generic 403 is intentionally NOT treated as a stale token (the server uses it for
 * email-mismatch and other non-auth reasons; the snapshot POST is the canary that clears
 * on its own 401/403). The ONE 403 handled here is the Phase 2 `scope_insufficient` case:
 * an `ingest`-scoped token hit a full-required endpoint under enforce. That token is VALID,
 * so we must NOT clear it (clearing → API_KEY re-TOFU → another `ingest` token → loop). We
 * only raise `needsFullLogin` so the UI can surface the login CTA; the feature degrades to a
 * login prompt instead of a frozen/looping call.
 */
export async function authedFetch(config, url, options = {}) {
  const auth = await getAuthHeaders(config);
  const sentToken = auth.Authorization?.startsWith('Bearer ')
    ? auth.Authorization.slice(7)
    : null;
  const headers = { ...(options.headers || {}), ...auth };
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    const cleared = await clearExtTokenIfMatches(sentToken);
    if (cleared) {
      try {
        const path = new URL(url).pathname;
        console.log(`[Claude Tuner] ext_token cleared (401) at ${path}`);
      } catch { /* ignore URL parse errors */ }
    }
  } else if (response.status === 403 && sentToken) {
    await noteScopeInsufficient(response, url);
  }
  return response;
}

/**
 * Peek a 403 body (via clone, so the caller can still read it) for the Phase 2
 * `scope_insufficient` code and, if present, raise the needsFullLogin flag. Never clears
 * the token (it is valid — just insufficient scope) and never throws.
 */
export async function noteScopeInsufficient(response, url) {
  try {
    const body = await response.clone().json();
    if (body && body.code === 'scope_insufficient') {
      await chrome.storage.local.set({ needsFullLogin: true });
      try {
        const path = new URL(url).pathname;
        console.log(`[Claude Tuner] scope_insufficient at ${path} — full login needed for this feature`);
      } catch { /* ignore URL parse errors */ }
    }
  } catch { /* not JSON / no code — leave the response untouched */ }
}

/**
 * Server contract: the 401 code returned by the email-provider guard
 * (worker/src/routes/snapshots.ts, resolveEmailProviderGuard). An account whose
 * auth_provider is 'email' may NOT authenticate with the shared api_key (shared-key
 * impersonation guard, 문의 #179/#180 / PR #464) — the snapshot is rejected AND not
 * stored. Those installs hold no ext_token, so the generic 401 path below can only
 * call clearExtTokenIfMatches(null) → nothing cleared, nothing flagged, and the block
 * is completely invisible: usage keeps rendering locally while the server never
 * receives a row. This code is what makes that case machine-detectable client-side.
 */
export const AUTH_BLOCKED_CODE = 'login_required';

/**
 * Peek a 401 body (via clone, so the caller can still read it) for the email-provider
 * guard's `login_required` code and, if present, raise the `authBlocked` flag that the
 * popup CTA consumes (popup.js renderLoginCta). Mirrors noteScopeInsufficient: never
 * throws, never clears the token.
 *
 * Only fires when NO Bearer was sent (sentToken === null): the guard rejects api_key
 * auth specifically, so a 401 that carried a token is an ordinary stale-token 401 and
 * belongs to the clear-and-reauth path instead.
 *
 * Returns true when the flag was raised, so callers can return early without running
 * the stale-token clear.
 */
export async function noteAuthBlocked(response, sentToken, url, email = null, now = Date.now()) {
  if (sentToken) return false;
  try {
    const body = await response.clone().json();
    if (body && body.code === AUTH_BLOCKED_CODE) {
      await chrome.storage.local.set({ authBlocked: true });
      await noteAuthBlockBackoff(email, now);
      try {
        const path = new URL(url).pathname;
        console.log(`[Claude Tuner] login_required at ${path} — email account cannot use the shared key; log in to sync`);
      } catch { /* ignore URL parse errors */ }
      return true;
    }
  } catch { /* not JSON / no code — leave the response untouched */ }
  return false;
}

// ── authBlocked retry backoff ───────────────────────────────────────────────────────────────
// The 401 was already correct; the RETRY was not. A blocked account re-POSTed every cycle until
// the user logged in — the bulk of the measured 3,557 401/day. Like the 426 block
// (bg/upgrade-gate.js) this only resolves when the USER acts, so it gets the same capped ladder.
//
// 🔴 Login recovers INSTANTLY: the predicate below reads `authBlocked` FIRST, so all three login
// paths (background.js VERIFY_MAGIC_CODE / GOOGLE_SIGNIN / dashboard-session recovery) release it
// via the `remove('authBlocked')` they already do. The record is advisory on top of the flag.
//
// 🔴 Scoped to the blocked EMAIL: with no Claude account each provider resolves its own identity
// (resolveIngestIdentity → providerEmail), so a blocked ChatGPT must not silence a healthy Gemini.
// A global suppression would turn a partial block into a total outage — worse than the retry storm
// it fixes. With a Claude/independent account every stream resolves alike, so scoping is a no-op.
const AUTH_BLOCK_BACKOFF_KEY = '_authBlockedBackoff';

async function noteAuthBlockBackoff(email, now = Date.now()) {
  await withStorageLock(async () => {
    const { [AUTH_BLOCK_BACKOFF_KEY]: prev } = await chrome.storage.local.get({ [AUTH_BLOCK_BACKOFF_KEY]: null });
    // A block for a DIFFERENT email is a different block — it must not inherit the fail count.
    const fails = (prev && prev.email === email ? (prev.fails || 0) : 0) + 1;
    const capped = Math.min(AUTH_BLOCK_BACKOFF_BASE_MS * Math.pow(2, fails - 1), AUTH_BLOCK_BACKOFF_CAP_MS);
    const wait = Math.round(capped * (0.85 + Math.random() * 0.3));
    await chrome.storage.local.set({ [AUTH_BLOCK_BACKOFF_KEY]: { email, until: now + wait, fails } });
  });
}

/**
 * True while a POST for `email` must be skipped: that account is auth-blocked AND still inside its
 * backoff window. False the instant `authBlocked` is gone (the user logged in), whatever the
 * record says. A null email on either side means "no finer information" → applies to this install.
 */
export async function isAuthBlockSuppressed(email = null, now = Date.now()) {
  const { authBlocked, [AUTH_BLOCK_BACKOFF_KEY]: b } =
    await chrome.storage.local.get({ authBlocked: false, [AUTH_BLOCK_BACKOFF_KEY]: null });
  if (authBlocked !== true) return false;          // logged in / recovered → never suppress
  if (!b || !b.until || now >= b.until) return false; // window open → let one probe through
  return b.email == null || email == null || b.email === email;
}

/**
 * Drop the authBlocked flag after a POST the server actually accepted. Without this the
 * CTA would survive the login that fixed it (same reason background.js clears
 * showLoginPrompt/needsFullLogin on VERIFY_MAGIC_CODE). Drops the backoff record with it so a
 * later, unrelated block starts its ladder from the base wait rather than inheriting this one's.
 */
export async function clearAuthBlocked() {
  // Two calls, not one remove([...]): test/login-first-guard.mjs pins this exact
  // `remove('authBlocked')` as the recovery contract, and quietly reshaping it into an array
  // would blind that guard to a future edit that drops the flag clear entirely.
  await chrome.storage.local.remove('authBlocked');
  await chrome.storage.local.remove(AUTH_BLOCK_BACKOFF_KEY);
}

// ── Token-withheld fast retry ───────────────────────────────────────────────────────────────
// The server answers an api_key POST 200 with NO `ext_token` when the [C1] guard's D1 read
// degrades (worker resolveEmailProviderGuard). A tokened install just defers; a TOKENLESS one
// loses its only supply and waits a full 10min cycle for a condition usually over in seconds.
// Detectable client-side with no server change: sentToken === null AND 2xx AND no ext_token.
// Background + measured impact: .omc/report-token-loss.md, test/token-retry-guard.mjs.
// ONE helper, three call sites (collect.js primary, simpleAuthedPost, postSnapshot).
const TOKEN_RETRY_KEY = '_tokenRetry';
export const TOKEN_RETRY_ALARM = 'token-retry';

/** Drop the retry record — the token arrived, so the episode is over. */
export async function clearTokenRetry() {
  await chrome.storage.local.remove(TOKEN_RETRY_KEY);
}

/**
 * Detect "200 but still tokenless" and schedule ONE short, jittered, capped retry.
 * Returns true when a retry was scheduled (nothing branches on it).
 *
 * 🔴 BLOCK FLAGS ARE READ FIRST. authBlocked (401) / upgradeBlocked (426) mean the block ends only
 * when the USER acts — the every-cycle retry they replaced was most of a measured 3,557 401/day,
 * and an auth-blocked account cannot obtain a token via api_key at all. Retrying is both harmful
 * and pointless there.
 * 🔴 ONE ESCALATION PER WINDOW. A cycle fans out up to 4 payloads; escalating only when
 * `now >= until` stops one cycle burning the whole ladder. Same shape as the other records.
 * 🔴 JITTER. The degrade is fleet-wide correlated, so an unjittered ladder returns the whole fleet
 * at once to the D1 that is already stalling.
 */
export async function noteTokenWithheld(response, sentToken, { result, email = null, now = Date.now() } = {}) {
  // api_key path only. A request that CARRIED a token and got none back is a refresh that didn't
  // rotate — the client keeps the token it already has, so there is nothing to recover.
  if (sentToken) return false;
  if (!response || !response.ok) return false;

  // Body may already be consumed by the caller, so accept a pre-parsed one; only clone when we
  // must. A body we cannot read is not evidence of withholding — bail rather than guess.
  let body = result;
  if (body === undefined) {
    try { body = await response.clone().json(); } catch { return false; }
  }
  if (!body || typeof body !== 'object') return false;
  // Token present → nothing to schedule. Deliberately does NOT clear the record: this helper runs
  // in wrappers that only OBSERVE the body (simpleAuthedPost never stores it), so ending the
  // episode here would cancel the retry for an install that gained nothing. setExtToken() clears
  // it, because that is where a token is actually held (Codex review).
  if (body.ext_token) return false;

  // 🔴 Blocked installs first (see above).
  const { authBlocked } = await chrome.storage.local.get({ authBlocked: false });
  if (authBlocked === true) return false;
  if (await isUpgradeBlocked()) return false;
  // 단계 4 login-first: a fresh, non-grandfathered, not-logged-in install must not POST via the
  // shared key at all, so it must not be retried into doing so faster.
  if (await isServerSyncGated()) return false;

  let scheduled = false;
  await withStorageLock(async () => {
    const { [TOKEN_RETRY_KEY]: prev } = await chrome.storage.local.get({ [TOKEN_RETRY_KEY]: null });
    // Still inside the current window → this is a sibling payload from the same cycle (or the
    // post-cap cooldown). Do not escalate, do not re-arm.
    if (prev && prev.until && now < prev.until) return;
    const fails = ((prev && prev.fails) || 0) + 1;
    if (fails > TOKEN_RETRY_MAX_ATTEMPTS) {
      // Ladder spent. Sit out the cooldown with the counter reset, so a later, unrelated degrade
      // starts fresh from the base wait instead of inheriting this episode's exhaustion.
      await chrome.storage.local.set({ [TOKEN_RETRY_KEY]: { fails: 0, until: now + TOKEN_RETRY_COOLDOWN_MS, ts: now } });
      return;
    }
    const wait = Math.round(TOKEN_RETRY_BASE_MS * Math.pow(2, fails - 1) * (0.85 + Math.random() * 0.3));
    await chrome.storage.local.set({ [TOKEN_RETRY_KEY]: { fails, until: now + wait, ts: now } });
    // Deterministic alarm name → create() overwrites rather than piling up timers.
    chrome.alarms.create(TOKEN_RETRY_ALARM, { delayInMinutes: wait / 60_000 });
    scheduled = true;
    console.log(`[Claude Tuner] 200 with no ext_token (api_key) — still tokenless; retry ${fails}/${TOKEN_RETRY_MAX_ATTEMPTS} in ${Math.round(wait / 1000)}s`);
  });
  return scheduled;
}

/** Extract the Bearer token from a getAuthHeaders() result, or null if API_KEY. */
export function bearerFromAuthHeaders(auth) {
  return auth?.Authorization?.startsWith('Bearer ') ? auth.Authorization.slice(7) : null;
}

/**
 * POST JSON as a CORS "simple request" — NO custom headers (a string body defaults
 * to Content-Type: text/plain), auth embedded in the body as `_auth` (ext_token if
 * present, shared API key otherwise). Because no preflight-triggering header is
 * set, the browser skips the OPTIONS round-trip entirely (~53k req/day on
 * /api/snapshots — ~11% of all worker traffic). Server counterpart: authMiddleware
 * scheme 3 (worker/src/middleware/auth.ts), which strips `_auth` before processing.
 * Requires the worker deployed with body-auth support BEFORE this ships in a release.
 *
 * Returns { response, sentToken } — sentToken is the ext_token actually sent
 * (null on API_KEY fallback) for race-safe clearExtTokenIfMatches on 401/403.
 */
export async function simplePost(config, url, payload) {
  const extToken = await getExtToken();
  const response = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({ ...payload, _auth: extToken || config.apiKey }),
  });
  return { response, sentToken: extToken || null };
}

/**
 * simplePost with authedFetch's 401 auto-clear semantics, for fire-and-forget
 * callers that only inspect response.ok. Returns the Response.
 */
export async function simpleAuthedPost(config, url, payload) {
  // No block check here, deliberately: this wrapper owes its caller a Response, and any synthetic
  // one lies — a 2xx runs the caller's r.ok branch and clears a 5xx backoff nothing recovered
  // from; a non-2xx logs a failure for a request never sent. Callers gate themselves instead
  // (bg/collect.js extra-org send, where the identity is known).
  const { response, sentToken } = await simplePost(config, url, payload);
  if (response.status === 401) {
    // The extra-org POST rides this wrapper, so without this its `login_required` 401 could never
    // RAISE the block — only observe one raised elsewhere (Codex review). Early return is safe:
    // this fires only when no Bearer was sent, so the clear below would be a no-op.
    if (await noteAuthBlocked(response, sentToken, url, payload && payload.user_email)) return response;
    const cleared = await clearExtTokenIfMatches(sentToken);
    if (cleared) {
      try {
        const path = new URL(url).pathname;
        console.log(`[Claude Tuner] ext_token cleared (401) at ${path}`);
      } catch { /* ignore URL parse errors */ }
    }
  } else if (response.status === 403 && sentToken) {
    await noteScopeInsufficient(response, url);
  } else if (response.status === 426) {
    // MIN_INGEST_VERSION gate, handled in this shared wrapper because the extra-org POST goes out
    // through here and inspects only `r.ok` — otherwise a version-blocked install's extra orgs
    // would keep POSTing at full cadence while its primary org was already backed off.
    await noteUpgradeRequired(response, url);
  } else if (response.ok) {
    // Token-withheld detection for the extra-org POST. It lives HERE, not at the call site, for
    // the same reason the 401/426 handling does: this wrapper is the only place that still knows
    // `sentToken`, and the caller sees a Response it inspects for `.ok` alone. The helper clones
    // the body, so the caller's own r.json() is unaffected.
    await noteTokenWithheld(response, sentToken, { email: payload && payload.user_email });
  }
  return response;
}

/**
 * POST a snapshot to /api/snapshots with auth handling shared across all
 * collection paths (Claude, ChatGPT, Gemini). Mirrors the auth-recovery logic
 * the Claude path uses so that provider-only (independent) accounts — whose
 * provider snapshots are their ONLY snapshot path — also recover from token
 * invalidation and detect account deletion.
 *
 * Handles:
 *  - 401/403: stale/invalid ext_token → race-safe clear so the next cycle
 *    re-issues a fresh token (or falls back to API_KEY for Claude accounts).
 *    Sets needsReauth so independent accounts (which cannot use API_KEY) can
 *    re-show the sign-in UI.
 *  - 410 account_deleted: stop collection, flag deletion, set badge.
 *  - result.ext_token: persist rotated/issued token (TOFU).
 *
 * Returns the parsed result object on success, or null on any error/auth path.
 */
export async function postSnapshot(config, payload) {
  if (!config.serverUrl) return null;
  // Phase 2 단계 4 login-first gate (ChatGPT/Gemini path — Claude is gated in collect.js). A
  // fresh, non-grandfathered, not-logged-in install shows usage locally (the caller already
  // appended history) but does NOT send via the shared api_key. Surface the login CTA once.
  if (await isServerSyncGated()) {
    await chrome.storage.local.set({ showLoginPrompt: true });
    return null;
  }
  // Both persistent-block backoffs. This is the single chokepoint for every ChatGPT/Gemini POST,
  // so one check each covers both providers and any future caller. Like the login-first gate
  // above, the caller has already appended local history — usage still renders, only the send
  // stops. The authBlocked check is scoped to THIS payload's identity, so a second provider under
  // a different email keeps sending.
  if (await isUpgradePostSuppressed()) return null;
  if (await isAuthBlockSuppressed(payload && payload.user_email)) return null;
  // Preflight-free simple request (see simplePost) — auth rides in the body.
  const { response, sentToken } = await simplePost(config, `${config.serverUrl}/api/snapshots`, payload);

  // Phase 2 scope_insufficient: /api/snapshots is NOT scope-gated today (an ingest token is
  // MEANT to write snapshots, §4.1.1), so this cannot fire now — but if a future contract ever
  // scope-gates the ingest POST, a valid ingest token must NOT be cleared here (clearing →
  // api_key re-TOFU → ingest loop). Peek first and raise needsFullLogin instead (Codex review).
  if (response.status === 403 && sentToken) {
    const body = await response.clone().json().catch(() => null);
    if (body && body.code === 'scope_insufficient') {
      await chrome.storage.local.set({ needsFullLogin: true });
      return null;
    }
  }
  // email-provider guard (401 login_required, api_key auth only): the reject is intended and
  // stays, but it must not be silent — raise authBlocked so the popup can ask for a login.
  if (response.status === 401 && await noteAuthBlocked(response, sentToken, `${config.serverUrl}/api/snapshots`, payload && payload.user_email)) {
    return null;
  }
  if (response.status === 401 || response.status === 403) {
    const cleared = await clearExtTokenIfMatches(sentToken);
    if (cleared) {
      console.log(`[Claude Tuner] ext_token cleared (${response.status}). Will re-auth on next cycle.`);
      // Independent accounts cannot fall back to API_KEY — flag for re-sign-in UI.
      await chrome.storage.local.set({ needsReauth: true });
    }
    return null;
  }

  if (response.status === 410) {
    const errData = await response.json().catch(() => ({}));
    if (errData.account_deleted) {
      console.log('[Claude Tuner] Account has been deleted. Stopping collection.');
      await chrome.storage.local.set({ account_deleted: true });
      chrome.alarms.clear(ALARM_NAME);
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    }
    return null;
  }

  // MIN_INGEST_VERSION gate: nothing was stored and nothing will be until this build updates.
  // Return before the generic !ok warn so the block (backoff + badge + banner) is the outcome,
  // not a silent console line. 🔴 No token is cleared here — the ext_token is valid, the
  // extension is old; clearing would force an api_key re-TOFU back into the ingest loop.
  if (response.status === 426 && await noteUpgradeRequired(response, `${config.serverUrl}/api/snapshots`)) {
    return null;
  }

  if (!response.ok) {
    console.warn(`[Claude Tuner] Server POST failed: ${response.status} ${response.statusText}`);
    // 5xx → server/D1 overload: extend the shared backoff. (401/403/410 returned
    // above are persistent per-user issues, not server health — they don't back off.)
    if (response.status >= 500) await noteServerFailure();
    return null;
  }

  const result = await response.json().catch(() => ({}));
  await noteServerSuccess(); // confirmed-healthy POST clears any backoff
  // Drop the CTA flag once auth demonstrably works again — but ONLY on evidence of a
  // TOKEN, not on any 2xx. A plain accepted api_key POST does not prove recovery: when the
  // [C1] guard's D1 read times out it fails open on ingest (extTokenAllowed=false, NO 401,
  // worker snapshots.ts resolveEmailProviderGuard), so a still-blocked account gets a 200
  // during a primary stall and would flicker its CTA off for the whole stall window.
  // A Bearer we sent, or a token the server minted, is the real proof (Codex review).
  if (sentToken || result?.ext_token) await clearAuthBlocked();
  // Version block: cleared on ANY 2xx (no token condition). The version gate does zero I/O — it
  // is a pure function of the env threshold and ext_version (version-gate.ts) — so unlike the
  // authBlocked guard it has no fail-open branch that could fake a recovery.
  await clearUpgradeBlocked();
  // Store any server-tunable cadence override here — the shared chokepoint for ALL
  // POSTs (Claude + ChatGPT + Gemini), so provider-only accounts get cadence too. The
  // payload names the stream this response answers, so a per-stream standby verdict
  // (design 안 B) lands on the right stream and nowhere else.
  await applyServerCadence(result, Date.now(), {
    uuid: payload && payload.claude_org_uuid,
    provider: (payload && payload.provider) || 'claude',
  });
  // Store ext_token from server (TOFU issuance or refresh). No-downgrade: a refresh that
  // returns 'ingest' must not strip a logged-in user's 'full' token (Phase 2 단계 4).
  if (result.ext_token) {
    await setExtTokenNoDowngrade(result.ext_token);
    // A fresh token arrived — clear any stale re-auth flag.
    await chrome.storage.local.remove('needsReauth');
  }
  // …and the inverse: a 200 that carried NO token, on a request we sent WITHOUT one, means this
  // install is still tokenless and the server simply withheld it (degraded [C1] guard read).
  // Body is already parsed here, so hand it over rather than making the helper re-clone.
  await noteTokenWithheld(response, sentToken, { result, email: payload && payload.user_email });
  // === EXT REC PERSIST (per provider AND org): BEGIN (pinned by test/rec-delivery-guard.mjs) ===
  // Per-provider recommendation. lastStatus.recommendation is a SINGLE slot written by the Claude
  // path, so writing a ChatGPT rec there would make the Claude org show ChatGPT's advice (and vice
  // versa) for anyone using both. Keep providers in their own map and leave the legacy slot alone.
  // insufficient_data is stored as-is; the popup treats it as "show nothing", not as a rec.
  //
  // ⚠️ The map is keyed (provider, ORG), not provider alone. The server computes this rec over the
  // 14-day window of THIS POST's org, and a member with two ChatGPT orgs POSTs for both on the same
  // ~10-minute cadence. A provider-only slot means each POST overwrites the other, and the popup
  // then renders whichever landed last against whichever org is SELECTED — org A's row showing
  // org B's downgrade. That is the same defect as the team dashboard's email-only lookup, one
  // runtime over. REC_ORG_NONE is '-' here too (worker/src/services/snapshot-service.ts); an
  // org-less POST gets its own bucket rather than matching a real org.
  const _recProvider = (payload && payload.provider) || 'claude';
  const _recOrg = (payload && payload.claude_org_uuid) || '-';
  if (_recProvider !== 'claude' && result.recommendation) {
    // ⚠️ `|| {}` SEEDS the container — do NOT reintroduce an `if (cur)` gate here.
    // lastStatus is created only by the CLAUDE collector, so a ChatGPT-only user (no Claude org,
    // or signed out of Claude) has none at all: gating the write on it dropped their rec outright,
    // on the delivery path that is supposed to be the ONLY one they have. Hanging a provider's
    // data off another provider's status object is the underlying mistake; seeding is the minimal
    // fix that does not restructure storage. A seeded status carries no `snapshot`, and the popup
    // renderer treats a status without one as no-data (ui/render.js), so it shows nothing new.
    const cur = (await getLastStatus()) || {};
    {
      const _byProv = Object.assign({}, cur.recommendations_by_provider);
      _byProv[_recProvider] = Object.assign({}, _byProv[_recProvider], {
        [_recOrg]: result.recommendation,
      });
      cur.recommendations_by_provider = _byProv;
      await setStatus(cur);
    }
  }
  // === EXT REC PERSIST (per provider AND org): END ===
  return result;
}
