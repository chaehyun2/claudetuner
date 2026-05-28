import { fetchGeminiRpc, isGeminiLoggedIn, getGeminiUserInfo } from './api-gemini.js';
import { normalizeResetTime } from './api.js';
import { getConfig, getAuthHeaders, appendUsageHistory } from './storage.js';

// Gemini plan ID mapping (from jSf9Qc response first field)
// otAQ7b returns policy names like "v3p2_plus_policy"
const GEMINI_PLAN_MAP = {
  1: 'Free',
  2: 'Business',   // Google Workspace (bundled into Business Standard/Plus/Enterprise)
  3: 'AI Plus',    // $7.99/mo — entry-level paid tier (post I/O 2026)
  4: 'Advanced',   // Google One AI Premium (legacy Gemini Advanced)
  5: 'AI Pro',     // $19.99/mo — full Gemini 3.1 Pro, 1M context
  6: 'AI Ultra',   // $99.99/mo — 5x Pro usage, developer tier
};

// Convert [seconds, nanos] timestamp to ISO string, then normalize to minute precision
function geminiTimestampToResetTime(ts) {
  if (!ts || !Array.isArray(ts) || !ts[0]) return null;
  return normalizeResetTime(new Date(ts[0] * 1000).toISOString());
}

/**
 * Collect Gemini usage data via jSf9Qc RPC.
 * Response: [planId, [[used, percent, windowType, [[resetSec, resetNano]]], ...], false]
 *   windowType 1 = 5-hour, windowType 2 = weekly
 * Returns { success, orgs: [{ uuid, name, plan, provider, isPrimary, h5, d7, ... }] }
 */
export async function collectGemini() {
  const loggedIn = await isGeminiLoggedIn();
  if (!loggedIn) {
    return { success: false, orgs: [] };
  }

  try {
    const data = await fetchGeminiRpc('jSf9Qc', '[]');

    if (!Array.isArray(data) || !Array.isArray(data[1])) {
      console.warn('[Claude Tuner] Gemini: unexpected jSf9Qc response');
      return { success: false, orgs: [] };
    }

    const planId = data[0];
    const windows = data[1];
    const plan = GEMINI_PLAN_MAP[planId] || `Plan ${planId}`;
    if (!GEMINI_PLAN_MAP[planId]) {
      console.warn(`[Claude Tuner] Gemini: unknown planId ${planId}, using fallback "${plan}"`);
    }

    // Parse windows: each entry is [used, percent, windowType, [[resetSec, resetNano]]]
    let h5 = null, d7 = null, resetsAt5h = null, resetsAt7d = null;
    for (const w of windows) {
      if (!Array.isArray(w)) continue;
      const percent = w[1];
      const windowType = w[2];
      if (!Number.isFinite(percent)) continue;
      const resetTs = w[3]?.[0]; // [seconds, nanos]

      if (windowType === 1) {
        // 5-hour window
        h5 = Math.round(percent * 100);
        resetsAt5h = geminiTimestampToResetTime(resetTs);
      } else if (windowType === 2) {
        // Weekly window
        d7 = Math.round(percent * 100);
        resetsAt7d = geminiTimestampToResetTime(resetTs);
      }
    }

    // Get user profile from page context (more reliable than o30O0e RPC)
    let email = null;
    let googleId = null;
    try {
      const userInfo = await getGeminiUserInfo();
      email = userInfo.email;
      googleId = userInfo.googleId;
      if (!email && !googleId) console.warn('[Claude Tuner] Gemini: could not extract user info from page');
    } catch (e) {
      console.warn('[Claude Tuner] Gemini user info failed:', e.message);
    }

    const accountId = googleId || 'gemini-unknown';

    const org = {
      uuid: accountId,
      name: email || 'Gemini',
      plan,
      provider: 'gemini',
      isPrimary: false,
      h5,
      d7,
      resetsAt5h,
      resetsAt7d,
      spendUsed: null,
      spendLimit: null,
      extraUsage: null,
    };

    // Append to local usage history (for chart display)
    await appendUsageHistory({
      t: Date.now(),
      h5: org.h5,
      d7: org.d7,
      p: plan,
      r7: org.resetsAt7d,
      org: org.uuid,
      eu: null,
      el: null,
    });

    // Send snapshot to server (fire-and-forget)
    sendGeminiSnapshot(org, email, plan).catch(e =>
      console.warn('[Claude Tuner] Gemini snapshot send failed:', e.message)
    );

    return { success: true, orgs: [org] };
  } catch (e) {
    console.warn('[Claude Tuner] Gemini collection failed:', e.message);
    return { success: false, orgs: [] };
  }
}

// Send Gemini snapshot to server (same /api/snapshots endpoint)
async function sendGeminiSnapshot(org, geminiEmail, plan) {
  const config = await getConfig();
  if (!config.serverUrl) return;

  const authHeaders = await getAuthHeaders(config);

  // Use Claude email (from accountCache) as primary identity for server
  const { accountCache } = await chrome.storage.local.get({ accountCache: null });
  const serverEmail = accountCache?.email;
  if (!serverEmail) {
    console.warn('[Claude Tuner] Gemini snapshot skipped: no Claude account (ext_token email required)');
    return;
  }

  const extVersion = chrome.runtime.getManifest().version;

  const payload = {
    user_email: serverEmail,
    plan,
    collected_at: new Date().toISOString(),
    ext_version: extVersion,
    five_hour: {
      utilization: org.h5,
      resets_at: org.resetsAt5h,
    },
    seven_day: {
      utilization: org.d7,
      resets_at: org.resetsAt7d,
    },
    claude_org_uuid: org.uuid,
    provider: 'gemini',
    provider_email: geminiEmail || null,
    is_extra_org: true,
  };

  await fetch(`${config.serverUrl}/api/snapshots`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify(payload),
  });
}
