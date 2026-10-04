// The collector's Claude plan LABEL for a claude.ai org ('Pro', 'Max 5x', 'Max (<tier>)', …), before
// the seat refinement in bg/plan.js. Its own file because bg/compare.js labels the cross-check
// column with it too (#2054) and must not pull in bg/plan.js's notification/badge graph.
import { claudeMaxTierSuffix, claudeOrgPlan } from '../vendor-ai/models.js';

// The rule lives in vendor-ai (`claudeOrgPlan`) — the ONE answer to "what plan is this claude.ai
// org" for the collector AND the cross-check. Until vendor-ai v0.35.0 each side had its own copy;
// they drifted, and the cross-check read every Pro account as Free (Opus locked, 2026-10-03). This
// function only turns that answer into the collector's display label; the plan itself must not be
// decided here again.
const CLAUDE_PLAN_LABELS = Object.freeze({
  max_20x: 'Max 20x', max_5x: 'Max 5x', max: 'Max', pro: 'Pro', enterprise: 'Enterprise',
  team: 'Team', free: 'Free', api: 'API', unknown: 'unknown',
});
export function detectPlan(org) {
  const plan = CLAUDE_PLAN_LABELS[claudeOrgPlan(org)] || 'unknown';
  // A plain Max whose tier names no 5x/20x keeps the raw tier visible, except the package's plain
  // tiers (vendor-ai v0.40.0 CLAUDE_PLAIN_MAX_TIERS — the same list its org score reads, #2067).
  const tier = claudeMaxTierSuffix(org);
  if (plan === 'Max' && tier) return `Max (${tier})`;
  return plan;
}
