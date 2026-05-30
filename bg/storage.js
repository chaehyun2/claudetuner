import { DEFAULT_INTERVAL_MINUTES, HISTORY_MAX_AGE_MS, DEFAULT_SERVER_URL, DEFAULT_API_KEY, ALARM_NAME } from './constants.js';

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

// --- ext_token management (per-user JWT for server auth) ---

export async function getExtToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ extToken: null }, (r) => resolve(r.extToken));
  });
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
  const authHeaders = await getAuthHeaders(config);
  const sentToken = bearerFromAuthHeaders(authHeaders);

  const response = await fetch(`${config.serverUrl}/api/snapshots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(payload),
  });

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
    return null;
  }

  const result = await response.json().catch(() => ({}));
  // Store ext_token from server (TOFU issuance or refresh)
  if (result.ext_token) {
    await setExtToken(result.ext_token);
    // A fresh token arrived — clear any stale re-auth flag.
    await chrome.storage.local.remove('needsReauth');
  }
  return result;
}
