import { DEFAULT_INTERVAL_MINUTES, HISTORY_MAX_AGE_MS, DEFAULT_SERVER_URL, DEFAULT_API_KEY, ALARM_NAME } from './constants.js';
import { noteServerFailure, noteServerSuccess } from './send-gate.js';
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

export async function setStatus(status) {
  return chrome.storage.local.set({ lastStatus: status });
}

export async function getLastStatus() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ lastStatus: null }, (result) => {
      resolve(result.lastStatus);
    });
  });
}

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
  return chrome.storage.local.set({ extToken: token });
}

export async function clearExtToken() {
  return chrome.storage.local.remove('extToken');
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
 * 403 is intentionally NOT handled here: today the server uses 403 for
 * email-mismatch (stale token), but it's a generic "forbidden" status and
 * future endpoints may use it for non-auth reasons. The main snapshot POST
 * acts as the canary and clears explicitly on its own 401/403.
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
  }
  return response;
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
  const { response, sentToken } = await simplePost(config, url, payload);
  if (response.status === 401) {
    const cleared = await clearExtTokenIfMatches(sentToken);
    if (cleared) {
      try {
        const path = new URL(url).pathname;
        console.log(`[Claude Tuner] ext_token cleared (401) at ${path}`);
      } catch { /* ignore URL parse errors */ }
    }
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
  // Preflight-free simple request (see simplePost) — auth rides in the body.
  const { response, sentToken } = await simplePost(config, `${config.serverUrl}/api/snapshots`, payload);

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

  if (!response.ok) {
    console.warn(`[Claude Tuner] Server POST failed: ${response.status} ${response.statusText}`);
    // 5xx → server/D1 overload: extend the shared backoff. (401/403/410 returned
    // above are persistent per-user issues, not server health — they don't back off.)
    if (response.status >= 500) await noteServerFailure();
    return null;
  }

  const result = await response.json().catch(() => ({}));
  await noteServerSuccess(); // confirmed-healthy POST clears any backoff
  // Store any server-tunable cadence override here — the shared chokepoint for ALL
  // POSTs (Claude + ChatGPT + Gemini), so provider-only accounts get cadence too. The
  // payload names the stream this response answers, so a per-stream standby verdict
  // (design 안 B) lands on the right stream and nowhere else.
  await applyServerCadence(result, Date.now(), {
    uuid: payload && payload.claude_org_uuid,
    provider: (payload && payload.provider) || 'claude',
  });
  // Store ext_token from server (TOFU issuance or refresh)
  if (result.ext_token) {
    await setExtToken(result.ext_token);
    // A fresh token arrived — clear any stale re-auth flag.
    await chrome.storage.local.remove('needsReauth');
  }
  return result;
}
