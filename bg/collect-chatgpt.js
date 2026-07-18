import { fetchChatGPTApi, isChatGPTLoggedIn } from './api-chatgpt.js';
import { normalizeResetTime } from './api.js';
import { getConfig, appendUsageHistory, postSnapshot, getOrCreateInstallId } from './storage.js';
import { gateProviderSnapshot } from './send-gate.js';

// Capitalize first letter: "plus" → "Plus"
function capitalizeFirst(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Map raw ChatGPT plan_type codes to intuitive display names.
// 'prolite' = the $100 Pro tier (5x Plus quota, launched 2026-04); 'pro' = $200 Pro (20x Plus).
const CHATGPT_PLAN_NAMES = {
  free: 'Free', go: 'Go', plus: 'Plus', prolite: 'Pro 5x', pro: 'Pro 20x',
  team: 'Team', business: 'Business', enterprise: 'Enterprise',
  education: 'Education', k12: 'Education (K-12)',
};
function chatgptPlanName(code) {
  return CHATGPT_PLAN_NAMES[(code || 'free').toLowerCase()] || capitalizeFirst(code || 'free');
}

// Convert Unix timestamp (seconds) to ISO string, then normalize to minute precision
function unixToResetTime(ts) {
  if (!ts) return null;
  return normalizeResetTime(new Date(ts * 1000).toISOString());
}

// Next-billing ("renewal") date is exposed only on ChatGPT's accounts/check
// endpoint — /wham/usage does not carry it — and changes at most monthly. So
// fetch it at most once per day per account and cache it, instead of on every
// ~10min collection cycle.
const RENEWAL_TTL_MS = 24 * 60 * 60 * 1000;
const RENEWAL_CACHE_KEY = 'chatgptRenewalCache';
const RENEWAL_CACHE_MAX = 20; // bound growth for profiles that sign into many accounts

// Keep only the most-recently-fetched accounts so the cache can't grow unbounded.
function pruneRenewalCache(store) {
  const keys = Object.keys(store);
  if (keys.length <= RENEWAL_CACHE_MAX) return store;
  const keep = keys
    .sort((a, b) => (store[b]?.fetchedAt || 0) - (store[a]?.fetchedAt || 0))
    .slice(0, RENEWAL_CACHE_MAX);
  const pruned = {};
  for (const k of keep) pruned[k] = store[k];
  return pruned;
}

async function getChatGPTRenewalDate(accountId) {
  if (!accountId || accountId === 'unknown') return null;
  const store = (await chrome.storage.local.get({ [RENEWAL_CACHE_KEY]: {} }))[RENEWAL_CACHE_KEY] || {};
  const cached = store[accountId];
  if (cached && (Date.now() - cached.fetchedAt) < RENEWAL_TTL_MS) {
    return cached.renewal_date;
  }
  try {
    const data = await fetchChatGPTApi('/backend-api/accounts/check/v4-2023-04-27');
    // `accounts.default` is ChatGPT's canonical currently-active account — the same
    // one /wham/usage is scoped to, since both follow the session's active-account
    // selection. (accounts/check keys are account UUIDs, so we can't match by the
    // user-id-shaped usage.account_id directly; `default` is the reliable anchor.)
    // `renews_at` is the next charge date; null when it won't renew (cancelled/expired).
    const ent = data?.accounts?.default?.entitlement || null;
    const renewal = ent?.renews_at || null;
    store[accountId] = { renewal_date: renewal, fetchedAt: Date.now() };
    await chrome.storage.local.set({ [RENEWAL_CACHE_KEY]: pruneRenewalCache(store) });
    return renewal;
  } catch (e) {
    console.warn('[Claude Tuner] ChatGPT renewal fetch failed:', e.message);
    return cached?.renewal_date ?? null; // fall back to a stale value if present
  }
}

// Window lengths (seconds) used to classify a rate-limit window by its span
// rather than by its position in the response. ChatGPT no longer guarantees
// primary_window == 5h / secondary_window == 7d: some plans (e.g. Pro 5x
// 'prolite') expose only the 7d window as `primary_window` with a null
// secondary. Classifying by `limit_window_seconds` keeps 5h/7d correct
// regardless of which slot each window arrives in.
const WINDOW_5H_SECONDS = 5 * 60 * 60;   // 18000
const WINDOW_7D_SECONDS = 7 * 24 * 60 * 60; // 604800
// Halfway (in log space) between 5h and 7d — a window shorter than this is
// treated as the 5h window, longer as the 7d window.
const WINDOW_SPLIT_SECONDS = Math.round(Math.sqrt(WINDOW_5H_SECONDS * WINDOW_7D_SECONDS));

// Pick the 5h and 7d windows out of the rate_limit object by their span.
function classifyWindows(rateLimit) {
  const primary = rateLimit?.primary_window || null;
  const secondary = rateLimit?.secondary_window || null;
  let w5h = null;
  let w7d = null;
  const spanless = [];
  // First pass: classify every window that carries a usable span.
  for (const w of [primary, secondary]) {
    if (!w) continue;
    const span = w.limit_window_seconds;
    if (typeof span !== 'number') { spanless.push(w); continue; }
    if (span < WINDOW_SPLIT_SECONDS) w5h = w;
    else w7d = w;
  }
  // Second pass: fill still-empty slots from spanless windows using the legacy
  // positional assumption (primary=5h, secondary=7d), without ever overwriting
  // a span-classified result. Handles fully-legacy and mixed old/new shapes.
  if (spanless.length) {
    if (!w5h && primary && spanless.includes(primary)) w5h = primary;
    if (!w7d && secondary && spanless.includes(secondary)) w7d = secondary;
  }
  return { w5h, w7d };
}

/**
 * Collect ChatGPT usage data.
 * Returns { success, orgs: [{ uuid, name, plan, provider, isPrimary, h5, d7, ... }] }
 * Fails silently (returns empty orgs) if user is not logged into ChatGPT.
 */
export async function collectChatGPT(force = false) {
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

    const { w5h, w7d } = classifyWindows(usage.rate_limit);
    const plan = chatgptPlanName(usage.plan_type);
    const accountId = usage.account_id || usage.user_id || 'unknown';
    const email = usage.email || null;
    const renewalDate = await getChatGPTRenewalDate(accountId);

    const org = {
      uuid: accountId,
      name: email || 'ChatGPT',
      email: email || null, // provider account email (shown in the popup footer)
      plan: plan,
      provider: 'chatgpt',
      isPrimary: false,
      h5: w5h?.used_percent ?? null,
      d7: w7d?.used_percent ?? null,
      resetsAt5h: unixToResetTime(w5h?.reset_at),
      resetsAt7d: unixToResetTime(w7d?.reset_at),
      renewalDate, // next-billing date (accounts/check entitlement.renews_at); may be null
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

    // Send snapshot to server — delta-gated (shared with Claude collectors).
    // Skip unchanged heartbeats the server would only dedup; local history above
    // is always kept so the popup chart stays continuous. Returned org is
    // unaffected, so popup/merge display is independent of the gate.
    const gateValues = { h5: org.h5, d7: org.d7, extraUsed: null, resetsAt5h: org.resetsAt5h, resetsAt7d: org.resetsAt7d };
    const gate = await gateProviderSnapshot(org.uuid, gateValues, { force, provider: 'chatgpt' });
    if (gate.send) {
      // Commit only on a confirmed-successful POST so a failed send leaves the
      // gate unadvanced and the next cycle retries (no silent drop of a change).
      const res = await sendChatGPTSnapshot(org, email, plan).catch(e => {
        console.warn('[Claude Tuner] ChatGPT snapshot send failed:', e.message);
        return null;
      });
      if (res) await gate.commit();
    } else {
      console.log(`[Claude Tuner] ChatGPT delta-gate skip (${gate.reason})`);
    }

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

  // Server identity, in priority order:
  //  1. Claude email (accountCache) — Claude user; this provider is an extra org
  //  2. independent account email (magic-link) — chosen unified identity
  //  3. the ChatGPT account's own email (TOFU) — no Claude/magic-link, so the
  //     ChatGPT email IS the identity (same trust model Claude already uses)
  const { accountCache, independentAccount } = await chrome.storage.local.get({
    accountCache: null, independentAccount: null,
  });
  const serverEmail = accountCache?.email || independentAccount?.email || chatgptEmail;
  if (!serverEmail) {
    console.warn('[Claude Tuner] ChatGPT snapshot skipped: no email (no Claude/independent account and no ChatGPT email)');
    return;
  }

  // When there is no Claude account, this provider is the user's primary data,
  // so the snapshot must maintain the users row (current_plan, last_seen_at).
  // For Claude users it's an "extra org" that must not overwrite current_plan.
  const isExtraOrg = !!accountCache?.email;

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
    is_extra_org: isExtraOrg,
    install_id: await getOrCreateInstallId(),
  };

  // Attach the next-billing date so the server persists it on this org's snapshot
  // row (same `subscription` shape the Claude collector uses). The server keeps
  // `users.renewal_date` Claude-only, so this never overwrites a Claude renewal.
  if (org.renewalDate) {
    payload.subscription = { renewal_date: org.renewalDate };
  }

  // Shared helper handles auth recovery (401/403), account deletion (410),
  // and ext_token rotation — critical for independent accounts whose provider
  // snapshots are their only server contact. Returns the server result on
  // success, or null on any failure (caller uses this to gate the commit).
  return await postSnapshot(config, payload);
}
