import { fetchChatGPTApi, isChatGPTLoggedIn } from './api-chatgpt.js';
import { normalizeResetTime } from './api.js';
import { getConfig, getAuthHeaders, appendUsageHistory } from './storage.js';

// Capitalize first letter: "plus" → "Plus"
function capitalizeFirst(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Convert Unix timestamp (seconds) to ISO string, then normalize to minute precision
function unixToResetTime(ts) {
  if (!ts) return null;
  return normalizeResetTime(new Date(ts * 1000).toISOString());
}

/**
 * Collect ChatGPT usage data.
 * Returns { success, orgs: [{ uuid, name, plan, provider, isPrimary, h5, d7, ... }] }
 * Fails silently (returns empty orgs) if user is not logged into ChatGPT.
 */
export async function collectChatGPT() {
  const loggedIn = await isChatGPTLoggedIn();
  if (!loggedIn) {
    return { success: false, orgs: [] };
  }

  try {
    const usage = await fetchChatGPTApi('/backend-api/wham/usage');

    if (!usage?.rate_limit) {
      console.warn('[Claude Tuner] ChatGPT: unexpected /wham/usage response');
      return { success: false, orgs: [] };
    }

    const primary = usage.rate_limit.primary_window;
    const secondary = usage.rate_limit.secondary_window;
    const plan = capitalizeFirst(usage.plan_type || 'free');
    const accountId = usage.account_id || usage.user_id || 'unknown';
    const email = usage.email || null;

    const org = {
      uuid: accountId,
      name: email || 'ChatGPT',
      plan: plan,
      provider: 'chatgpt',
      isPrimary: false,
      h5: primary?.used_percent ?? null,
      d7: secondary?.used_percent ?? null,
      resetsAt5h: unixToResetTime(primary?.reset_at),
      resetsAt7d: unixToResetTime(secondary?.reset_at),
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
    sendChatGPTSnapshot(org, email, plan).catch(e =>
      console.warn('[Claude Tuner] ChatGPT snapshot send failed:', e.message)
    );

    return { success: true, orgs: [org] };
  } catch (e) {
    console.warn('[Claude Tuner] ChatGPT collection failed:', e.message);
    return { success: false, orgs: [] };
  }
}

// Send ChatGPT snapshot to server (same /api/snapshots endpoint)
// Uses ext_token email (Claude email) as user_email for server identity,
// preserves ChatGPT email in provider_email for reference.
async function sendChatGPTSnapshot(org, chatgptEmail, plan) {
  const config = await getConfig();
  if (!config.serverUrl) return;

  const authHeaders = await getAuthHeaders(config);

  // Use Claude email (from accountCache) as primary identity for server
  const { accountCache } = await chrome.storage.local.get({ accountCache: null });
  const serverEmail = accountCache?.email;
  if (!serverEmail) {
    console.warn('[Claude Tuner] ChatGPT snapshot skipped: no Claude account (ext_token email required)');
    return;
  }

  const extVersion = chrome.runtime.getManifest().version;

  const payload = {
    user_email: serverEmail,
    plan: plan,
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
    provider: 'chatgpt',
    provider_email: chatgptEmail || null,
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
