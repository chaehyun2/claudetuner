import { isUpgradeBlocked } from './upgrade-gate.js';
import { REC_SEEN_KEY, REC_NOTICE_KEY, computeRecNotice } from './rec-notice.js';
import { composeToolbarTitle, formatUsage, pickNotice } from './toolbar-title.js';
import { bt } from './i18n.js';

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
  // #966: signal an unacknowledged ★ move through the TOOLTIP, never the badge text.
  // 🔴 The badge ladder below is error → pending order → usage %, and the percentage is the
  // thing people installed this for. Taking that slot for an informational notice would hide
  // the primary signal to announce a non-problem; inserting above the pending-order state
  // would hide an actual action item. The tooltip is free and costs no existing signal.
  // (Identifiers are spelled out in prose here on purpose: ext-google-login-guard.mjs pins the
  // badge ladder with a comment-blind indexOf, so naming a later symbol above reads as code.)
  //
  // 🔴 FIRST, before any branch. Three paths below return early (auth/upgrade block, pending
  // order, no utilization). Setting the tooltip after them means a blocked user never sees it
  // AND — worse — a tooltip written during an earlier percent paint survives forever once the
  // notice clears, because the clearing path never runs. Every paint must settle the tooltip.
  // 🔴 The block is decided BEFORE the tooltip so the two can agree. It was decided after, and a
  // blocked install got a red `!` beside a tooltip about a pending plan order.
  const { authBlocked } = await chrome.storage.local.get('authBlocked');
  const blocked = authBlocked === true || await isUpgradeBlocked();
  await applyPinMoveTitle({ util7d, util5h, blocked });
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
  if (blocked) {
    updateBadgeError();
    return;
  }

  // 🔴 THE ICON IS DECIDED HERE, ONCE (#994 unit 2), and BELOW the block on purpose. It used to be
  // an unconditional `resetIcon()` at the top, with a recommendation icon painted by a separate
  // writer — which cannot work, because that line runs on every paint and erases it. Same "last
  // writer wins" defect this work removed from the badge: two authorities and no ladder.
  //
  // Placing it above the block branch would also "work", since updateBadgeError() repaints the
  // icon afterwards — but only because of statement order, which is exactly the fragility being
  // removed. Below the return, the blocked state simply never reaches here.
  await applyStateIcon();

  // 🔴 A PENDING PLAN ORDER NO LONGER TAKES THE BADGE OR THE ICON (#994). It used to paint an
  // order icon plus a 📋 badge, and both were wrong for what that state IS: the user asked for a
  // plan change and the server is processing it. Nothing is broken and there is nothing to do but
  // wait. Two costs for announcing a non-problem:
  //   1. It hid the percentage — the thing people installed this for — for the whole wait.
  //   2. The order icon was a RED DOT WITH AN EXCLAMATION, identical to the error icon except for
  //      its corner. At 16px those are the same picture, so a benign in-progress state wore the
  //      costume of "your data is not reaching the server". Same defect the badge had with ⚠.
  // The state is still surfaced — by the tooltip and the popup banner, where a sentence fits.
  // Falls through to the usage badge below on purpose.

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

// The recommendation used to live in the badge text — `45⚠`, then `45↑`/`45↓` (#985). Both were
// wrong for the same reason: a glyph glued to a number reads as a MODIFIER of that number, so
// `25↓` says "usage fell", not "move down a plan". Four characters cannot say "you could drop to
// Plus and save $100/mo". It moved to the icon (a marker meaning "there is something to look at")
// plus the popup card, and the badge went back to being the percentage. See bg/rec-notice.js.

/**
 * Recompute the derived notice state and store it. Call after ANY write to
 * `lastStatus.recommendation` — this is the one place that pays for the full read.
 *
 * 🔴 Not called from the paint path. The icon painter used to do this work itself, on every badge
 * paint, reading the whole `lastStatus` container each time (Codex DEPLOY-BLOCKER; #853 forbids
 * adding reads to that path). Recommendations change on the order of hours; badges paint on the
 * order of minutes. Deciding at write time is the same total work done far fewer times, and it is
 * also the only place where the PROVIDER context needed for the decision is available.
 */
export async function refreshRecNotice() {
  try {
    const { lastStatus, collectedOrgs } =
      await chrome.storage.local.get({ lastStatus: null, collectedOrgs: [] });
    const key = computeRecNotice(lastStatus?.recommendation, lastStatus?.snapshot, collectedOrgs);
    // Written even when null: "no recommendation is entitled to a marker" has to be recordable,
    // or a rec that becomes suppressed (the user books the change) leaves its key behind forever.
    await chrome.storage.local.set({ [REC_NOTICE_KEY]: key });
    return key;
  } catch (e) {
    console.warn('[Claude Tuner] rec notice refresh failed:', e?.message);
    return null;
  }
}

/**
 * Paint the icon for the current non-blocked state: a recommendation that is entitled to a marker
 * AND has not been acknowledged gets it; everything else gets the plain mark. Called by
 * updateBadge() below its block branch, so the icon and the badge are never decided by different
 * code paths.
 *
 * 🔴 Reads two SMALL keys, never `lastStatus`. See refreshRecNotice() for why. It also reads
 * storage directly rather than importing bg/storage.js: that import would close a cycle, because
 * storage.js imports THIS module for updateBadgeError() (#994 unit 1) — and an ES module cycle
 * here does not throw, it hands back undefined bindings at call time, which in this extension
 * means the service worker fails to load and the popup renders as static HTML.
 */
async function applyStateIcon() {
  try {
    const { [REC_NOTICE_KEY]: notice, [REC_SEEN_KEY]: seen } =
      await chrome.storage.local.get({ [REC_NOTICE_KEY]: null, [REC_SEEN_KEY]: null });
    if (notice && notice !== seen) {
      chrome.action.setIcon({
        path: { 16: 'icons/icon16-rec.png', 48: 'icons/icon48-rec.png', 128: 'icons/icon128-rec.png' },
      });
      return;
    }
  } catch (e) {
    console.warn('[Claude Tuner] rec icon state read failed:', e?.message);
  }
  resetIcon();
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

// Append the ★-move hint to the action tooltip when one is pending, and remove it when not.
// Reads the same record the popup banner uses, so the two can never disagree.
/**
 * Storage key holding the tooltip's SLOW-CHANGING half, already translated:
 * `{ notice, blocked, h5, d7 }`. Rebuilt when the states behind it change, read once per paint.
 */
export const TOOLBAR_TIP_KEY = '_toolbarTip';

/**
 * Recompute the tooltip's derived half. Expensive on purpose, and rare: it reads the pin-move
 * state, the pending order, `lastStatus`, the recommendation notice key, and calls the background
 * dictionary four times.
 *
 * 🔴 THIS SPLIT IS NOT PREMATURE OPTIMISATION — IT IS UNDOING A REGRESSION I INTRODUCED (Codex).
 * Unit 2 removed a full `lastStatus` read from the icon path because updateBadge() runs on every
 * collection, popup open, worker wake, provider refresh and REFRESH_BADGE, and #853 forbids adding
 * reads there. Unit 3's first draft then put that same read back one function over, in the tooltip
 * builder — plus four `chrome.storage.sync.get` calls, because bgLang() re-reads the language on
 * every bt(). Same rule, same path, broken again a hundred lines away.
 *
 * The sentences change on the order of hours; badges paint on the order of minutes. So the whole
 * translated half is computed here and the paint just reads it.
 */
export async function refreshToolbarTip() {
  try {
    const {
      pinMoveServer = null, pinMoveDismissedAt = null, pendingPlanOrder = null, lastStatus = null,
      [REC_NOTICE_KEY]: recNotice = null,
    } = await chrome.storage.local.get({
      pinMoveServer: null, pinMoveDismissedAt: null, pendingPlanOrder: null, lastStatus: null,
      [REC_NOTICE_KEY]: null,
    });

    const pinActive = !!pinMoveServer && !!pinMoveServer.movedAt
      && pinMoveDismissedAt !== pinMoveServer.movedAt;

    // A pending order is the one state with NO badge and NO icon (#994 unit 1) — this sentence is
    // its only glanceable surface, which is why it tops the ladder below the block.
    const order = pendingPlanOrder
      ? await bt('tip_order', pendingPlanOrder.from_plan, pendingPlanOrder.to_plan)
      : null;

    // Spoken whenever the marker is ENTITLED to show, acknowledged or not. The icon's job is "have
    // you looked at this yet"; the tooltip's is "what is it". Hiding the sentence once the dot is
    // dismissed would leave a user who looked with no way to read the advice again without opening
    // the popup — the surface the tooltip exists to shortcut.
    const rec = recNotice ? lastStatus?.recommendation : null;
    const recLine = rec
      ? await bt('tip_rec', rec.from_plan || rec.fromPlan || '', rec.to_plan || rec.toPlan || '')
      : null;

    await chrome.storage.local.set({
      [TOOLBAR_TIP_KEY]: {
        // 🔴 The KIND travels with the text. Collapsing the slow notices to a bare string made
        // bg/badge.js pass `{ block, notice }` into a parameter that is a KIND map everywhere else
        // — and `notice` is not a rung, so it could never win the ladder. Silent muteness, caught
        // only because the guard derives the passed keys from this file instead of hardcoding them.
        notice: pickNotice({ order, pin: pinActive ? await bt('pin_move_title') : null, rec: recLine }),
        blocked: await bt('tip_blocked'),
        h5: await bt('win_5h'),
        d7: await bt('win_7d'),
      },
    });
  } catch (e) {
    console.warn('[Claude Tuner] toolbar tip refresh failed:', e?.message);
  }
}

/**
 * Write the tooltip. One `setTitle` in the whole extension, and the only reader of the derived
 * record above.
 *
 * 🔴 `blocked` is passed in, not read: updateBadge() has just computed it, and the tooltip must
 * agree with the badge. Without it a blocked install showed a red `!` while its tooltip talked
 * about a pending plan order (Codex DEPLOY-BLOCKER) — two slots on the same button telling
 * different stories, which is the whole failure mode this work exists to end. The usage line is
 * dropped while blocked for the same reason the badge drops it: nothing has reached the server,
 * so the number is a lie that gets staler.
 *
 * Name kept as-is: test/pin-heal-guard.mjs pins this symbol and its placement (#966/#984), and a
 * rename belongs with that guard's owner, not as a drive-by here.
 */
export async function applyPinMoveTitle({ util7d = null, util5h = null, blocked = false } = {}) {
  try {
    const { [TOOLBAR_TIP_KEY]: tip = null } =
      await chrome.storage.local.get({ [TOOLBAR_TIP_KEY]: null });
    chrome.action.setTitle({
      title: composeToolbarTitle({
        usage: blocked ? null : formatUsage(util5h, util7d, { h5: tip?.h5, d7: tip?.d7 }),
        notices: {
          block: blocked ? (tip?.blocked || null) : null,
          ...(tip?.notice ? { [tip.notice.kind]: tip.notice.text } : {}),
        },
      }),
    });
  } catch { /* tooltip is cosmetic — never break badge painting */ }
}
