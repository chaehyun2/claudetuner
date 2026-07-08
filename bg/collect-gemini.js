import { fetchGeminiRpc, isGeminiLoggedIn, getGeminiUserInfo } from './api-gemini.js';
import { normalizeResetTime } from './api.js';
import { getConfig, appendUsageHistory, getUsageHistory, postSnapshot, getOrCreateInstallId, recordGeminiMetered, rememberGeminiUltraTier } from './storage.js';
import { gateProviderSnapshot } from './send-gate.js';

// Gemini plan ID mapping (from jSf9Qc response first field).
// FALLBACK ONLY: planId is unreliable (observed 2=Workspace, 4=AI Plus, null=AI Pro —
// see docs/DESIGN-gemini-policy-detection.md). The authoritative tier signal is the
// otAQ7b `v3p2_<tier>_policy` string (GEMINI_POLICY_LABEL below). This map is used only
// when the otAQ7b policy RPC fails.
const GEMINI_PLAN_MAP = {
  // Numeric planId (jSf9Qc response)
  1: 'Free',
  2: 'Work',       // Google Workspace seat (Google's own UI labels it "Work"; covers Business Standard/Plus/Enterprise — planId can't distinguish them)
  3: 'AI Plus',    // $7.99/mo — entry-level paid tier (post I/O 2026)
  4: 'Advanced',   // Google One AI Premium (legacy Gemini Advanced)
  5: 'AI Pro',     // $19.99/mo — full Gemini 3.1 Pro, 1M context
  6: 'AI Ultra',   // $99.99/mo — 5x Pro usage, developer tier
  // String variants (planId may arrive as string from some API paths)
  '1': 'Free',
  '2': 'Work',
  '3': 'AI Plus',
  '4': 'Advanced',
  '5': 'AI Pro',
  '6': 'AI Ultra',
  // Policy/label names (otAQ7b or alternative response formats)
  'Free': 'Free',
  'Plus': 'AI Pro',
  'Advanced': 'Advanced',
  'Business': 'Work',
  'Ultra': 'AI Ultra',
};

// Authoritative tier signal: otAQ7b returns a "v3p2_<tier>_policy" string. Maps the tier
// word → plan label. Unknown tier words fall back to a title-cased label so a NEW tier
// (e.g. an Ultra variant) surfaces in the data without a code change. Workspace seats
// return NO policy (empty) and are labeled 'Work'. See docs/DESIGN-gemini-policy-detection.md.
const GEMINI_POLICY_LABEL = {
  free: 'Free',
  basic: 'Free',   // Free/entry tier — confirmed 2026-07-09 (known free acct: planId=1, v3p2_basic_policy). Maps to Free so planMultiplier() = 0.25x (was 1x via title-case fallback).
  plus: 'AI Plus',
  pro: 'AI Pro',
  ultra: 'AI Ultra',
  business: 'Work',
};

// Recursively collect every "v3p2_<tier>_policy" (or any "*_policy") string in a nested
// otAQ7b response into acc (deduped, order-preserving).
function extractGeminiPolicies(node, acc) {
  if (typeof node === 'string') {
    if (/_policy$/.test(node) && acc.indexOf(node) === -1) acc.push(node);
  } else if (Array.isArray(node)) {
    for (const v of node) extractGeminiPolicies(v, acc);
  }
  return acc;
}

// Observed AI Pro per-window quota (the 1x baseline). full_quota = remaining/(1-percent) is a
// tier constant; its ratio to Pro is the capacity multiplier. See docs/DESIGN §13–14.
const GEMINI_PRO_QUOTA = { d7: 48384, h5: 2400 };

// AI Ultra 5x and 20x share ONE policy (v3p2_ultra_policy) — only the quota tells them apart.
// Returns 'AI Ultra 5x' / 'AI Ultra 20x' from the capacity ratio, or null (unknown → keep base
// 'AI Ultra'). Prefers the 7d window; both windows yield the same ratio.
function geminiUltraSubTier(rem7d, pct7d, rem5h, pct5h) {
  let q = null;
  if (Number.isFinite(rem7d) && Number.isFinite(pct7d) && pct7d < 0.99) q = (rem7d / (1 - pct7d)) / GEMINI_PRO_QUOTA.d7;
  else if (Number.isFinite(rem5h) && Number.isFinite(pct5h) && pct5h < 0.99) q = (rem5h / (1 - pct5h)) / GEMINI_PRO_QUOTA.h5;
  if (q == null) return null;
  if (Math.abs(q - 20) <= 3) return 'AI Ultra 20x';     // 20x ± ~15%
  if (Math.abs(q - 5) <= 0.75) return 'AI Ultra 5x';    // 5x ± ~15%
  return null;
}

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
export async function collectGemini(force = false) {
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

    // Parse windows: each entry is [remaining, percent, windowType, [[resetSec, resetNano]]].
    // NOTE: w[0] is the REMAINING quota (counts DOWN as used), NOT consumption — proven by a
    // before/after capture. full_quota = remaining/(1-percent) is the tier constant.
    let h5 = null, d7 = null, resetsAt5h = null, resetsAt7d = null;
    // Raw per-window signal for AE collection: remaining quota + unrounded percent consumed.
    let remaining5h = null, remaining7d = null, pct5hRaw = null, pct7dRaw = null;
    // Metered detection uses the RAW percent (before display rounding) so a consumer
    // account with usage too small to round above 0% is still recognized as metered.
    let sawRawUsage = false;
    for (const w of windows) {
      if (!Array.isArray(w)) continue;
      const remaining = w[0];
      const percent = w[1];
      const windowType = w[2];
      if (!Number.isFinite(percent)) continue;
      if (percent > 0) sawRawUsage = true;
      const remainingVal = Number.isFinite(remaining) ? remaining : null;
      const resetTs = w[3]?.[0]; // [seconds, nanos]

      if (windowType === 1) {
        // 5-hour window
        h5 = Math.round(percent * 100);
        remaining5h = remainingVal; pct5hRaw = percent;
        resetsAt5h = geminiTimestampToResetTime(resetTs);
      } else if (windowType === 2) {
        // Weekly window
        d7 = Math.round(percent * 100);
        remaining7d = remainingVal; pct7dRaw = percent;
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

    // Authoritative tier detection via the otAQ7b policy string. planId is unreliable
    // (observed 2=Workspace, 4=AI Plus, null=AI Pro) so it is only a fallback when the
    // policy RPC fails. See docs/DESIGN-gemini-policy-detection.md.
    let otResponse = null;
    let otOk = false;   // true only when otAQ7b returned a well-formed (array) response
    try {
      otResponse = await fetchGeminiRpc('otAQ7b', '[]');
      otOk = Array.isArray(otResponse);
    } catch (e) {
      console.warn('[Claude Tuner] Gemini otAQ7b failed:', e.message);
    }
    const policies = otOk ? extractGeminiPolicies(otResponse, []) : [];
    // Prefer the tier-bearing v3p2 policy; fall back to the first policy string for the
    // raw value sent to AE.
    const tierPolicy = policies.find(p => /v3p2_(\w+)_policy/.test(p)) || null;
    const geminiPolicy = tierPolicy || policies[0] || '';   // raw policy string collected into AE
    const tierWord = tierPolicy ? tierPolicy.match(/v3p2_(\w+)_policy/)[1] : null;

    let plan, noLimits;
    if (policies.length > 0) {
      // A policy is present → metered consumer account (NEVER Workspace, even if the tier
      // word is unrecognized). Label from the v3p2 tier word (unknown → title-cased so it
      // surfaces in data); if a policy exists but names no v3p2 tier, use the planId label.
      plan = tierWord
        ? (GEMINI_POLICY_LABEL[tierWord] || (tierWord.charAt(0).toUpperCase() + tierWord.slice(1)))
        : (GEMINI_PLAN_MAP[planId] || 'Gemini');
      // Ultra 5x vs 20x share one policy — refine the label by quota so planMultiplier can
      // apply 5x vs 20x (ChatGPT "Pro 5x"/"Pro 20x" pattern). The quota (remaining) signal is
      // OPTIONAL: if it's unavailable this cycle (or Google drops it entirely) we reuse the
      // last remembered sub-tier; if never determined, keep base 'AI Ultra' (multiplier 5).
      if (tierWord === 'ultra') {
        const freshSub = geminiUltraSubTier(remaining7d, pct7dRaw, remaining5h, pct5hRaw);
        const sub = await rememberGeminiUltraTier(googleId || email || null, freshSub);
        if (sub) plan = sub;
      }
      noLimits = false;
    } else if (otOk) {
      // Well-formed otAQ7b response with NO policy → Google Workspace seat (unmetered).
      plan = 'Work';
      noLimits = true;
    } else {
      // otAQ7b failed → fall back to the (unreliable) planId map + the sticky-metered guard:
      // treat the account as metered the moment we ever see real (>0) usage, and remember it
      // (sticky) so a later 0% window doesn't re-hide a consumer account. Genuine Workspace
      // seats stay pinned at 0%, never get marked, and keep noLimits.
      plan = GEMINI_PLAN_MAP[planId] || `Plan ${planId}`;
      const planBasedNoLimits = /Business|Enterprise|Work/i.test(plan);
      noLimits = planBasedNoLimits;
      if (planBasedNoLimits) {
        const meteredKey = googleId || email || null;
        let usageEver = sawRawUsage;
        if (!usageEver && meteredKey) {
          const hist = await getUsageHistory().catch(() => []);
          usageEver = hist.some(p => p.org === accountId && ((p.h5 > 0) || (p.d7 > 0)));
        }
        const everMetered = await recordGeminiMetered(meteredKey, usageEver);
        noLimits = !everMetered;
      }
    }

    const org = {
      uuid: accountId,
      name: email || 'Gemini',
      email: email || null, // provider account email (shown in the popup footer)
      plan,
      provider: 'gemini',
      isPrimary: false,
      h5,
      d7,
      resetsAt5h,
      resetsAt7d,
      noLimits,
      spendUsed: null,
      spendLimit: null,
      extraUsage: null,
      // Raw signals for server-side AE collection (not shown in the popup)
      geminiPolicy,
      remaining5h,
      remaining7d,
      pct5hRaw,
      pct7dRaw,
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
    // `plan` opts this gate into plan-change detection (send-gate.js): a Gemini tier change
    // (incl. Ultra 5x↔20x, which carries a different multiplier) must POST promptly rather than
    // batch with later usage and be zeroed by the server's plan-change delta guard.
    const gateValues = { h5: org.h5, d7: org.d7, extraUsed: null, resetsAt5h: org.resetsAt5h, resetsAt7d: org.resetsAt7d, plan: org.plan };
    const gate = await gateProviderSnapshot(org.uuid, gateValues, { force });
    if (gate.send) {
      // Commit only on a confirmed-successful POST so a failed send leaves the
      // gate unadvanced and the next cycle retries (no silent drop of a change).
      const res = await sendGeminiSnapshot(org, email, plan).catch(e => {
        console.warn('[Claude Tuner] Gemini snapshot send failed:', e.message);
        return null;
      });
      if (res) await gate.commit();
    } else {
      console.log(`[Claude Tuner] Gemini delta-gate skip (${gate.reason})`);
    }

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

  // Server identity, in priority order:
  //  1. Claude email (accountCache) — Claude user; this provider is an extra org
  //  2. independent account email (magic-link) — chosen unified identity
  //  3. the Gemini account's own email (TOFU) — no Claude/magic-link, so the
  //     Gemini email IS the identity (same trust model Claude already uses)
  const { accountCache, independentAccount } = await chrome.storage.local.get({
    accountCache: null, independentAccount: null,
  });
  const serverEmail = accountCache?.email || independentAccount?.email || geminiEmail;
  if (!serverEmail) {
    console.warn('[Claude Tuner] Gemini snapshot skipped: no email (no Claude/independent account and no Gemini email)');
    return;
  }

  // When there is no Claude account, this provider is the user's primary data,
  // so the snapshot must maintain the users row (current_plan, last_seen_at).
  // For Claude users it's an "extra org" that must not overwrite current_plan.
  const isExtraOrg = !!accountCache?.email;

  const extVersion = chrome.runtime.getManifest().version;

  const payload = {
    user_email: serverEmail,
    plan,
    collected_at: new Date().toISOString(),
    ext_version: extVersion,
    five_hour: {
      utilization: org.h5,
      resets_at: org.resetsAt5h,
      remaining_raw: org.remaining5h ?? null,
      percent_raw: org.pct5hRaw ?? null,
    },
    seven_day: {
      utilization: org.d7,
      resets_at: org.resetsAt7d,
      remaining_raw: org.remaining7d ?? null,
      percent_raw: org.pct7dRaw ?? null,
    },
    // Raw otAQ7b policy string (authoritative tier signal) — collected into AE.
    gemini_policy: org.geminiPolicy || null,
    claude_org_uuid: org.uuid,
    provider: 'gemini',
    provider_email: geminiEmail || null,
    is_extra_org: isExtraOrg,
    install_id: await getOrCreateInstallId(),
  };

  // Shared helper handles auth recovery (401/403), account deletion (410),
  // and ext_token rotation — critical for independent accounts whose provider
  // snapshots are their only server contact. Returns the server result on
  // success, or null on any failure (caller uses this to gate the commit).
  return await postSnapshot(config, payload);
}
