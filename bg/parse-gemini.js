// Pure parsing for Gemini's RPC responses — no chrome.*, no fetch, no Date.now(), no storage.
//
// WHY THIS SPLIT, AND NOT A BIGGER INPUT (#1315). collectGemini() is genuinely NOT a
// response -> output function: the Ultra 5x/20x label depends on a REMEMBERED sub-tier, and the
// no-policy fallback reads usage history and sticky-metered state. Two shapes were available:
//   (a) define the input as {responses + prior state + injected env}, or
//   (b) split pure parsing from the state-dependent decision.
// This is (b). Under (a) a parsing regression and a state-decision regression land in the same
// case and the fixture can no longer say which one it pinned — and it is the PARSING that breaks
// when Google changes a response shape, which is what a provider fixture exists to catch.
//
// So resolveGeminiPlan() below decides the plan from parsed values alone and reports WHICH state
// lookups the caller must then perform (`needsUltraSubTier`, `needsStickyMetered`); it never
// performs them. The storage reads stay in collectGemini(), where they are visible next to the
// awaits they cost.
//
// 🔴 KEEP THIS FILE IMPORTABLE UNDER PLAIN NODE. It may depend on bg/api.js's pure
// normalizeResetTime and nothing else — an import that touches chrome.* at module scope puts these
// functions back out of the contract runner's reach.
//
// Extracted from bg/collect-gemini.js with no behaviour change.
import { normalizeResetTime } from './api.js';

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
export function extractGeminiPolicies(node, acc) {
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
export function geminiUltraSubTier(rem7d, pct7d, rem5h, pct5h) {
  let q = null;
  if (Number.isFinite(rem7d) && Number.isFinite(pct7d) && pct7d < 0.99) q = (rem7d / (1 - pct7d)) / GEMINI_PRO_QUOTA.d7;
  else if (Number.isFinite(rem5h) && Number.isFinite(pct5h) && pct5h < 0.99) q = (rem5h / (1 - pct5h)) / GEMINI_PRO_QUOTA.h5;
  if (q == null) return null;
  if (Math.abs(q - 20) <= 3) return 'AI Ultra 20x';     // 20x ± ~15%
  if (Math.abs(q - 5) <= 0.75) return 'AI Ultra 5x';    // 5x ± ~15%
  return null;
}

// Convert [seconds, nanos] timestamp to ISO string, then normalize to minute precision
export function geminiTimestampToResetTime(ts) {
  if (!ts || !Array.isArray(ts) || !ts[0]) return null;
  return normalizeResetTime(new Date(ts[0] * 1000).toISOString());
}

/**
 * Parse a jSf9Qc response into the usage windows.
 * Response: [planId, [[remaining, percent, windowType, [[resetSec, resetNano]]], ...], false]
 *   windowType 1 = 5-hour, windowType 2 = weekly
 * Returns null for an unreadable response — the caller decides what to report, because "we could
 * not read it" is an error the user has to see (#852) and not something a parser should swallow.
 */
export function parseGeminiWindows(data) {
  if (!Array.isArray(data) || !Array.isArray(data[1])) return null;
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

  return {
    planId, h5, d7, resetsAt5h, resetsAt7d,
    remaining5h, remaining7d, pct5hRaw, pct7dRaw, sawRawUsage,
  };
}

/**
 * Parse an otAQ7b response into the policy signals.
 *
 * `otOk` is the caller's answer to "did the RPC return a well-formed (array) response", which is
 * NOT the same question as "were there any policies" — a well-formed response with NO policy means
 * Google Workspace seat, while a failed RPC means we know nothing and must fall back to planId.
 * Collapsing the two would relabel every failed fetch as a Workspace account.
 */
export function parseGeminiPolicy(otResponse, otOk) {
  const policies = otOk ? extractGeminiPolicies(otResponse, []) : [];
  // Prefer the tier-bearing v3p2 policy; fall back to the first policy string for the
  // raw value sent to AE.
  const tierPolicy = policies.find(p => /v3p2_(\w+)_policy/.test(p)) || null;
  const geminiPolicy = tierPolicy || policies[0] || '';   // raw policy string collected into AE
  const tierWord = tierPolicy ? tierPolicy.match(/v3p2_(\w+)_policy/)[1] : null;
  return { policies, tierPolicy, geminiPolicy, tierWord };
}

/**
 * Decide the plan label and metering from parsed signals alone.
 *
 * Returns { plan, noLimits, needsUltraSubTier, needsStickyMetered }. The two `needs*` flags are
 * requests, not results: they tell the caller which stored state to consult and then apply, which
 * is what keeps this function pure (see the module header on the (a)/(b) choice).
 *   needsUltraSubTier   — Ultra 5x and 20x share one policy, so only the quota ratio separates
 *                         them; the caller resolves it via geminiUltraSubTier + the remembered
 *                         sub-tier and overrides `plan` when it gets an answer.
 *   needsStickyMetered  — the planId-based Workspace guess needs the sticky-metered check before
 *                         `noLimits` can be trusted; the caller overrides `noLimits` with it.
 */
export function resolveGeminiPlan({ policies, tierWord, planId, otOk }) {
  if (policies.length > 0) {
    // A policy is present → metered consumer account (NEVER Workspace, even if the tier
    // word is unrecognized). Label from the v3p2 tier word (unknown → title-cased so it
    // surfaces in data); if a policy exists but names no v3p2 tier, use the planId label.
    const plan = tierWord
      ? (GEMINI_POLICY_LABEL[tierWord] || (tierWord.charAt(0).toUpperCase() + tierWord.slice(1)))
      : (GEMINI_PLAN_MAP[planId] || 'Gemini');
    return { plan, noLimits: false, needsUltraSubTier: tierWord === 'ultra', needsStickyMetered: false };
  }
  if (otOk) {
    // Well-formed otAQ7b response with NO policy → Google Workspace seat (unmetered).
    return { plan: 'Work', noLimits: true, needsUltraSubTier: false, needsStickyMetered: false };
  }
  // otAQ7b failed → fall back to the (unreliable) planId map. `noLimits` here is PROVISIONAL:
  // the sticky-metered guard the caller runs next is what settles it, by treating the account as
  // metered the moment we ever see real (>0) usage and remembering that, so a later 0% window
  // doesn't re-hide a consumer account. Genuine Workspace seats stay pinned at 0%, never get
  // marked, and keep noLimits.
  const plan = GEMINI_PLAN_MAP[planId] || `Plan ${planId}`;
  const planBasedNoLimits = /Business|Enterprise|Work/i.test(plan);
  return { plan, noLimits: planBasedNoLimits, needsUltraSubTier: false, needsStickyMetered: planBasedNoLimits };
}
