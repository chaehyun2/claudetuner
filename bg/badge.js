import { isUpgradeBlocked } from './upgrade-gate.js';

// Get usage data for the PINNED (primary) org. The toolbar badge follows the
// pinned org, NOT the transient popup selection — selecting a chip only changes
// the popup view. If nothing is pinned: for a provider-only user (no Claude org)
// fall back to the first provider org so they still get a badge; for Claude
// users return null so the caller falls back to the Claude snapshot.
export async function getSelectedOrgUsage() {
  const { collectedOrgs = [] } = await chrome.storage.local.get({ collectedOrgs: [] });
  const hasClaudeOrg = collectedOrgs.some(o => (o.provider || 'claude') === 'claude');
  const org = collectedOrgs.find(o => o.isPrimary) || (!hasClaudeOrg ? collectedOrgs[0] : null);
  if (!org) return null;

  return {
    h5: org.h5 ?? null,
    d7: org.d7 ?? null,
    resetsAt5h: org.resetsAt5h ?? null,
    resetsAt7d: org.resetsAt7d ?? null,
    provider: org.provider || 'claude',
  };
}

// Update badge for the selected org (falls back to Claude primary snapshot)
export async function updateBadgeForSelectedOrg(claudeSnapshot) {
  const selected = await getSelectedOrgUsage();
  if (selected) {
    return updateBadge(selected.d7, selected.h5);
  }
  if (claudeSnapshot) {
    return updateBadge(claudeSnapshot.seven_day?.utilization, claudeSnapshot.five_hour?.utilization);
  }
}

/**
 * True while a hard server-side block owns the badge. Several paths write the badge WITHOUT going
 * through updateBadge() — the recommendation badge, the plan-order badge, and plan.js's clears —
 * so each has to ask. Without this a rec badge silently replaces the red `!` and the user is back
 * to having no visible signal, which is the entire failure this feature exists to fix.
 *
 * Two blocks qualify, for the same reason: while either is live NOTHING reaches the server, so any
 * other badge would be advertising a number that stopped updating.
 *   - authBlocked      — email-provider guard 401 (bg/storage.js noteAuthBlocked). Fix: log in.
 *   - upgradeBlocked   — MIN_INGEST_VERSION 426 (bg/upgrade-gate.js). Fix: update the extension.
 *
 * ⚠️ The NAME now under-describes the function: it covers both hard blocks, not just the auth one.
 * It is kept because test/ext-google-login-guard.mjs pins this exact symbol at three call sites on
 * purpose — a rename there is a separate, deliberate change, not a drive-by in this PR. Rename it
 * (to e.g. badgeLockedByBlock) together with that guard when someone owns both.
 */
export async function badgeLockedByAuthBlock() {
  const { authBlocked } = await chrome.storage.local.get('authBlocked');
  return authBlocked === true || await isUpgradeBlocked();
}

// === Badge update (based on usage display mode) ===
export async function updateBadge(util7d, util5h) {
  resetIcon(); // Restore normal icon if it was showing error

  // Server sync is BLOCKED (email-provider guard 401 → bg/storage.js noteAuthBlocked). This wins
  // over every other badge state, including a pending order, for two reasons:
  //  1. A utilization % here would be a LIE — nothing has reached the server since the block, so
  //     the number the user is reading is stale and getting staler.
  //  2. The popup CTA only reaches someone who opens the popup, and this extension is designed to
  //     be ignored. The badge is the only surface that reaches a user who never opens it — which
  //     is exactly the population that stayed silently broken for days (2026-07-27).
  //  3. The same argument covers the MIN_INGEST_VERSION 426 block (bg/upgrade-gate.js): the user's
  //     data stopped reaching the server, only the required action differs (update, not log in).
  //     The popup banner carries that distinction; the badge just has to say "something is wrong".
  const { authBlocked } = await chrome.storage.local.get('authBlocked');
  if (authBlocked === true || await isUpgradeBlocked()) {
    updateBadgeError();
    return;
  }

  // If there's a pending order, show order icon + badge first
  const { pendingPlanOrder } = await chrome.storage.local.get('pendingPlanOrder');
  if (pendingPlanOrder) {
    chrome.action.setIcon({ path: { 16: 'icons/icon16-order.png', 48: 'icons/icon48-order.png', 128: 'icons/icon128-order.png' } });
    chrome.action.setBadgeText({ text: '📋' });
    chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
    return;
  }

  const { usageDisplayMode = '7d', thresholdWarn = 80, thresholdDanger = 95 } = await chrome.storage.sync.get({ usageDisplayMode: '7d', thresholdWarn: 80, thresholdDanger: 95 });
  let util;
  if (usageDisplayMode === '5h') {
    util = util5h;
  } else if (usageDisplayMode === 'both') {
    // When showing both, display the higher value
    if (util5h != null && util7d != null) util = Math.max(util5h, util7d);
    else util = util7d ?? util5h;
  } else {
    util = util7d;
  }

  if (util === null || util === undefined) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  const pct = Math.round(util);
  chrome.action.setBadgeText({ text: pct + '%' });

  if (util >= thresholdDanger) {
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' }); // Red (danger)
  } else if (util >= thresholdWarn) {
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); // Orange (warning)
  } else {
    // Normal range: 5h=cyan, 7d=purple to distinguish
    const showing5h = usageDisplayMode === '5h' || (usageDisplayMode === 'both' && util5h != null && util7d != null && util5h >= util7d);
    chrome.action.setBadgeBackgroundColor({ color: showing5h ? '#06b6d4' : '#7c3aed' });
  }
}

// Error icon + badge on collection failure
export function updateBadgeError() {
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  chrome.action.setIcon({
    path: { 16: 'icons/icon16-error.png', 48: 'icons/icon48-error.png', 128: 'icons/icon128-error.png' },
  });
}

// Restore normal icon
export function resetIcon() {
  chrome.action.setIcon({
    path: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  });
}
