// The "Claude disconnected" soft notice: when Claude collection fails but another provider still
// has data, the side panel demotes the failure to a small dismissible notice (ui/render.js) and the
// toolbar badge has to agree with it (bg/collect.js). Both read the rules from HERE so the two
// surfaces cannot drift apart again.
//
// 🔴 Why this exists (2026-11-20, user report): the panel said "✓ ChatGPT Plus" with no notice
// (dismissed with ×, which used to last until Claude recovered — i.e. forever for a broken
// session) while the badge showed a red `!` on every failed Claude collect. The user had fixed
// "everything" they could see and still had an error badge, and Claude data had silently stopped
// two days earlier.
//
// Rules:
//  - Dismissing the notice SNOOZES it for CLAUDE_NOTICE_SNOOZE_MS, then it comes back. A dismissal
//    that never expires hides a broken Claude session indefinitely.
//  - While snoozed, the badge shows the usage percentage instead of `!` — the user acknowledged
//    the notice, so the badge must not keep alarming about the same thing.
//  - Not snoozed: notice visible in the panel AND `!` on the badge.

export const CLAUDE_NOTICE_DISMISS_KEY = 'claudeNoticeDismissed';
export const CLAUDE_NOTICE_SNOOZE_MS = 24 * 60 * 60 * 1000;

/**
 * PURE. The non-Claude org the panel shows as healthy when Claude collection fails, or null when
 * the failure is not demoted (hard red banner). Prefers a pinned non-Claude primary, else the first
 * provider org that has usage data.
 */
export function claudeFailureDemoteOrg(collectedOrgs) {
  const orgs = Array.isArray(collectedOrgs) ? collectedOrgs : [];
  const isClaude = (o) => (o.provider || 'claude') === 'claude';
  const primary = orgs.find((o) => o.isPrimary);
  if (primary && !isClaude(primary)) return primary;
  return orgs.find((o) => !isClaude(o) && (o.h5 != null || o.d7 != null)) || null;
}

/**
 * PURE. Is the dismissal still in force? The stored value is the dismissal timestamp (ms).
 * Legacy installs stored `true` with no time — treated as expired, so a notice muted before this
 * change resurfaces once instead of staying hidden forever.
 */
export function isClaudeNoticeSnoozed(dismissedAt, now = Date.now()) {
  if (typeof dismissedAt !== 'number' || !Number.isFinite(dismissedAt)) return false;
  const age = now - dismissedAt;
  return age >= 0 && age < CLAUDE_NOTICE_SNOOZE_MS;
}
