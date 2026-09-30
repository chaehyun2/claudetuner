// Gemini plan vocabulary — the ONE definition shared by the extension and the Worker.
//
// 🔴 ZERO IMPORTS, NO chrome.*, NO GLOBALS. The Worker imports this file directly
// (worker/src/services/snapshot-service.ts + routes/snapshots.ts, via tsconfig allowJs + wrangler's
// esbuild bundle — the same way services/widget-forecast.ts imports ui/prediction-core.js), so the
// policy→tier table exists exactly once. A copy in the Worker would drift the first time Google
// renames a policy again, which is precisely what happened on 2026-08-09 (see GEMINI_POLICY_ALIAS).
// test/provider-contract-guard.mjs fails if the Worker stops importing from here or grows its own
// copy of a policy string.

// Gemini plan ID mapping (from jSf9Qc response first field).
// FALLBACK ONLY: planId is unreliable (observed 2=Workspace, 4=AI Plus, null=AI Pro —
// see docs/DESIGN-gemini-policy-detection.md). The authoritative tier signal is the
// otAQ7b policy string (geminiPolicyTierWord below). This map is used only when the policy
// names no recognized tier, or when the otAQ7b policy RPC fails.
export const GEMINI_PLAN_MAP = {
  // Numeric planId (jSf9Qc response)
  1: 'Free',
  2: 'Work',       // Google Workspace seat (Google's own UI labels it "Work"; covers Business Standard/Plus/Enterprise — planId can't distinguish them)
  3: 'AI Plus',    // $7.99/mo — entry-level paid tier (post I/O 2026)
  4: 'Advanced',   // Legacy name, but ≡ AI Plus by capacity: every classifiable 'Advanced' row in AE (92 days to 2026-09-30) has the AI Plus quota 24,192 — multiplier/key/price twins treat it as AI Plus
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

// Tier word → plan label. Unknown tier words fall back to a title-cased label (in
// resolveGeminiPlan) so a NEW tier surfaces in the data without a code change. Workspace seats
// return NO policy (empty) and are labeled 'Work'. See docs/DESIGN-gemini-policy-detection.md.
export const GEMINI_POLICY_LABEL = {
  free: 'Free',
  basic: 'Free',   // Free/entry tier — confirmed 2026-07-09 (known free acct: planId=1, v3p2_basic_policy). Maps to Free so planMultiplier() = 0.25x (was 1x via title-case fallback).
  plus: 'AI Plus',
  pro: 'AI Pro',
  ultra: 'AI Ultra',
  business: 'Work',
};

// The original policy shape: "v3p2_<tier>_policy", the tier word read straight off the name.
const GEMINI_V3P2_POLICY_RE = /v3p2_(\w+)_policy/;

// Policy strings Google switched to on 2026-08-09 22:31 UTC, when it dropped the "v3p2_<tier>_"
// shape. Exact string → tier word. Derived from AE claude_gemini_signals (92 days): the 7-day FULL
// quota (remaining / (1 - percent)) is a per-tier constant, and each new name reproduces exactly
// one old tier's constant:
//
//   old name            new name(s)                              full 7d quota   tier
//   v3p2_basic_policy   basic_policy, brownfield_basic_policy    12,096          basic (Free)
//   v3p2_plus_policy    brownfield_paid_policy                   24,192          plus  (AI Plus)
//   v3p2_pro_policy     plus_policy                              48,384          pro   (AI Pro)
//   v3p2_ultra_policy   neon_policy                              241,920 / 967,680  ultra (5x / 20x)
//
// 🔴🔴 THE NAME `plus_policy` IS THE **PRO** TIER, NOT AI PLUS. Its quota is 48,384 — the Pro
// constant, 2x the AI Plus constant (24,192, which is what brownfield_paid_policy carries). Do not
// "fix" this to plus: it would score every AI Pro account at the 0.5x AI Plus multiplier.
// 🪤 Transitional exception, and why it does not change the mapping: from 2026-08-09 to 08-14
// plus_policy ALSO carried some AI Plus accounts (quota 24,192). Since 2026-08-14 every plus_policy
// row is 48,384 (Pro), so 'pro' is correct for current data; only that 5-day window is mixed.
//
// Deliberately NOT mapped (ambiguous or too few samples): lite_two_thinking_levels_policy and
// lite_three_thinking_levels_policy (their quota mixes the Free and Plus constants),
// brownfield_default_policy, default_policy. They keep the planId fallback until the data says
// which tier they are — a wrong entry here is worse than none, because it overrides planId.
export const GEMINI_POLICY_ALIAS = {
  basic_policy: 'basic',
  brownfield_basic_policy: 'basic',
  brownfield_paid_policy: 'plus',
  plus_policy: 'pro',     // 🔴 NOT plus — see above.
  neon_policy: 'ultra',
};

/**
 * The tier word a single policy string names, or null when it names none we recognize.
 * The exact alias table wins over the v3p2 pattern (an alias is a verified fact about one string;
 * the pattern reads the word out of the name, and the rename proved names can lie).
 *
 * @param {unknown} policy
 * @returns {string | null}
 */
export function geminiPolicyTierWord(policy) {
  if (typeof policy !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(GEMINI_POLICY_ALIAS, policy)) return GEMINI_POLICY_ALIAS[policy];
  const m = policy.match(GEMINI_V3P2_POLICY_RE);
  return m ? m[1] : null;
}

// The ONLY relabels the server performs: tier → the planId-fallback labels it replaces. Each pair is
// SAME-CAPACITY — the old and new label share one canonicalPlanKey and one multiplier in every twin
// (worker usage-calculator.ts, site chart-utils.js, ext ui/util.js; pinned by
// test/plan-mult-twins-guard.mjs [9]) — so the relabel changes what is SHOWN and priced, never what
// is counted. That is the whole safety argument, and it is why the table is this short:
//   pro  ← 'Work'     : gemini-pro2 = gemini-pro2, 1x = 1x (planId 2 fallback on plus_policy accounts)
//   plus ← 'Advanced' : gemini-plus = gemini-plus, 0.5x = 0.5x ('Advanced' ≡ AI Plus by quota)
// 🔴 Anything that would change the multiplier is deliberately NOT here — e.g. 'Work' + basic_policy
// → 'Free' (~29 gmail users, 1x vs 0.25x). Flipping a label across capacities at ingest makes the
// daily recalc treat it as a real plan change: earlier same-day snapshots scored at the old
// multiplier get re-expressed in the new one (a 1x→0.25x flip turns an 80% peak into 320%) and the
// transition delta is zeroed (Codex 1R, 2026-09-30). 'Work' also cannot be aliased to Free because
// real Workspace seats use it. Those accounts are relabelled by the extension itself once updated.
// Ultra is never touched: the 5x/20x sub-tier is only resolvable client-side.
export const GEMINI_INGEST_RELABELS = {
  pro: ['Work'],
  plus: ['Advanced'],
};

/**
 * Ingest-time correction for extensions that predate GEMINI_POLICY_ALIAS (≤ 1.48.0).
 *
 * Those clients see a renamed policy, find no v3p2 tier word, and label the account from the
 * unreliable planId — so an AI Pro account (plus_policy) arrives as 'Work' and an AI Plus account
 * (brownfield_paid_policy) as 'Advanced'. The raw policy rides the same payload (`gemini_policy`),
 * so the server can re-derive the tier from the SAME table the current extension uses.
 *
 * Returns the plan label to store: unchanged unless the policy names a tier in
 * GEMINI_INGEST_RELABELS and the incoming (trimmed) label is one that tier replaces. Every such
 * pair is same-capacity (see above), so this never moves a multiplier. For a current extension the
 * label is already the tier label → no-op; idempotent, safe on both producer and consumer side.
 * Pure: no I/O. Hot-path safe.
 *
 * @param {{ provider?: string | null, plan?: string | null, gemini_policy?: string | null }} payload
 * @returns {string | null | undefined}
 */
export function correctGeminiIngestPlan({ provider, plan, gemini_policy }) {
  if (provider !== 'gemini' || typeof plan !== 'string' || !gemini_policy) return plan;
  const tier = geminiPolicyTierWord(gemini_policy);
  const replaces = tier && Object.prototype.hasOwnProperty.call(GEMINI_INGEST_RELABELS, tier)
    ? GEMINI_INGEST_RELABELS[tier] : null;
  if (!replaces || !replaces.includes(plan.trim())) return plan;
  return GEMINI_POLICY_LABEL[tier];
}
