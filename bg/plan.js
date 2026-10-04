import { PLAN_HIERARCHY, PLAN_API_MAP, SEAT_TIER_MAP, NOTIF_ID_OPTIMIZE, ANTHROPIC_HEADERS, ERR_PLAN_CHANGED_EXTERNALLY } from './constants.js';
import { bt } from './i18n.js';
import { fetchClaudeApi } from './api.js';
import { getConfig, getLastStatus, authedFetch } from './storage.js';
import { logNotification, createCountedNotification } from './notifications.js';
import { resetIcon , badgeLockedByAuthBlock, updateBadgeForSelectedOrg } from './badge.js';
import { recordRecDismiss, clearDismissedClaudeRec } from './rec-dismiss.js';
import { detectPlan } from './plan-label.js';

// === Circular dependency resolution: inject collectAndSend reference ===
let _collectAndSendFn = null;
export function setCollectAndSendRef(fn) { _collectAndSendFn = fn; }
function forceCollect(context) {
  if (_collectAndSendFn) {
    _collectAndSendFn({ force: true }).catch(e =>
      console.warn(`[Claude Tuner] Force collect after ${context} failed:`, e.message));
  }
}

/** Show a plan-change notification if the user hasn't disabled them */
async function notifyPlanChange(title, message, priority = 1) {
  const { notifyPlanChange: enabled = true } = await chrome.storage.sync.get({ notifyPlanChange: true });
  if (enabled) {
    createCountedNotification(NOTIF_ID_OPTIMIZE, {
      type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority,
    }, 'plan-change');
    logNotification('plan-change');
  }
}

/** Fetch org list and resolve the user's selected (or first) org */
async function getSelectedOrg(config) {
  const orgList = await fetchClaudeApi('/api/organizations');
  if (!Array.isArray(orgList) || orgList.length === 0) {
    throw new Error('Failed to verify organization info');
  }
  return config.selectedOrgId
    ? (orgList.find(o => o.uuid === config.selectedOrgId) || orgList[0])
    : orgList[0];
}

// === Fetch subscription info (personal org only) ===
export async function fetchSubscriptionInfo(orgUuid) {
  const info = {};
  // Call both APIs in parallel (each can fail independently)
  const [subResult, pausedResult] = await Promise.allSettled([
    fetchClaudeApi(`/api/organizations/${orgUuid}/subscription_details`, { quiet: true }),
    fetchClaudeApi(`/api/organizations/${orgUuid}/paused_subscription_details`, { quiet: true }),
  ]);
  if (subResult.status === 'fulfilled') {
    const subDetails = subResult.value;
    info.renewal_date = subDetails?.next_charge_date || null;
    info.status = subDetails?.status || null;
    info.billing_interval = subDetails?.billing_interval || null;
    if (subDetails?.scheduled_downgrade) {
      const sd = subDetails.scheduled_downgrade;
      info.pending_plan = sd.plan_type || null;
      info.pending_change_date = sd.date || subDetails.next_charge_date || null;
    }
    if (subDetails?.plan_ending_before) {
      info.pending_plan = 'cancel';
      info.pending_change_date = subDetails.plan_ending_before;
    }
    if (subDetails?.payment_paused_until) {
      info.paused_until = subDetails.payment_paused_until;
    }
  } else {
    console.warn(`[Claude Tuner] Subscription details fetch failed for ${orgUuid} (non-critical):`, subResult.reason?.message);
  }
  if (pausedResult.status === 'fulfilled') {
    const pausedDetails = pausedResult.value;
    if (pausedDetails && Object.keys(pausedDetails).length > 0) {
      info.paused_info = pausedDetails;
    }
  }
  return info;
}

// === Plan detection === (bg/plan-label.js — import-light, shared with bg/compare.js)
export { detectPlan };

// Plans a `team_*` seat must not override: Enterprise seats are reported as-is, and an API-only
// org has no claude.ai seat to speak of.
const SEAT_TIER_OVERRIDE_EXEMPT = ['Enterprise', 'API'];

// Seat tier → plan label. A `team_*` seat outranks capabilities (#1891): variant Team orgs
// (nonprofit, labs) carry capabilities containing "pro"/"max", so detectPlan() calls them Pro or
// Max 5x, and the refinement that only ran for plan === 'Team' never got to see the seat.
// 🔴 The caller must pass the seat tier of THIS org's membership. A tier borrowed from another org
// (the memberships[0] fallback) would turn a personal Pro into Team.
// No seat tier → plan unchanged, so a bare 'Team' stays bare: the caller has NOT observed Standard,
// it has observed nothing, and keeping the two distinguishable is what lets #969 be fixed at the
// source rather than guessed at downstream.
export function planFromSeatTier(plan, seatTier) {
  if (!seatTier) return plan;
  const teamSeat = seatTier.startsWith('team_');
  if (plan !== 'Team' && !(teamSeat && !SEAT_TIER_OVERRIDE_EXEMPT.includes(plan))) return plan;
  if (SEAT_TIER_MAP[seatTier]) return SEAT_TIER_MAP[seatTier];
  if (teamSeat && seatTier.endsWith('_premium')) return 'Team Premium';
  if (teamSeat && seatTier.endsWith('_standard')) return 'Team Standard';
  // An unmapped tier (a new 'team_tier_N' Anthropic adds) would otherwise become Team Standard
  // with no trace — the same silent downgrade as a missing tier, just from a different cause.
  console.warn(`[Claude Tuner] unmapped seat_tier "${seatTier}" — falling back to Team Standard (#969)`);
  return 'Team Standard';
}

// Does this account hold a CONSUMER workspace (Free/Pro/Max)? The Grove "help improve Claude"
// setting is account-level but only applies to consumer workspaces — Team/Enterprise run under
// commercial terms. A team-only account (no personal workspace) was warned about, and mailed as a
// violator for, a setting with nothing to apply to (#1892).
//
// `seatTiers` = allSeatTiers keyed by org uuid, and ONLY when it is known to belong to the current
// account. null → we cannot tell a variant Team org (capabilities read as Pro, #1891) from a real
// Pro one, so answer null ("not observed") rather than a guess.
// 🔴 Conservative in one direction: any org we cannot positively call Team/Enterprise/API
// ('unknown', 'Max (tier)', a Pro with no seat) counts as consumer, so a real personal workspace
// is never hidden.
const NON_CONSUMER_PLAN = /^(Team|Enterprise|API)\b/;
export function hasConsumerOrg(orgList, seatTiers) {
  if (!Array.isArray(orgList) || orgList.length === 0 || !seatTiers || typeof seatTiers !== 'object') return null;
  return orgList.some((o) => !NON_CONSUMER_PLAN.test(planFromSeatTier(detectPlan(o), seatTiers[o?.uuid])));
}

// Per-org plan refinement: look up this org's seat_tier from the allSeatTiers cache
export async function refineTeamPlan(plan, orgUuid) {
  if (!orgUuid) return plan;
  const { accountCache } = await chrome.storage.local.get({ accountCache: null });
  return planFromSeatTier(plan, accountCache?.allSeatTiers?.[orgUuid]);
}

// === Report plan change order result ===
export async function reportPlanOrderResult(config, orderId, userEmail, action, result, failureReason) {
  try {
    await authedFetch(config, `${config.serverUrl}/api/snapshots/plan-order-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId, user_email: userEmail, action, result, failure_reason: failureReason }),
    });
  } catch (e) {
    console.error('[Claude Tuner] Failed to report plan order result:', e.message);
  }
}

/** Accept a plan order: execute change + report result + update storage */
export async function acceptPlanOrder(config, po, userEmail, { auto = false } = {}) {
  const changeResult = await executePlanChange({
    type: PLAN_HIERARCHY.indexOf(po.to_plan) > PLAN_HIERARCHY.indexOf(po.from_plan) ? 'upgrade' : 'downgrade',
    to_plan: po.to_plan, from_plan: po.from_plan,
  });
  await reportPlanOrderResult(config, po.order_id, userEmail, 'accepted',
    changeResult?.success ? 'completed' : 'failed',
    changeResult?.success ? undefined : (changeResult?.error || 'Plan change failed'));
  // 🔴 COMPARE-AND-CLEAR: only retire the order this call was about (#994, Codex 3rd pass).
  // `pendingPlanOrder` is a ONE-SLOT key and this used to null it unconditionally. Server POST
  // results are handled in an unawaited `.then` (bg/collect.js), so a second order can land in
  // that slot while this accept is still awaiting network calls — and the unconditional clear
  // would retire an order nobody resolved. That was survivable when the slot only drove a banner;
  // it is not now that the same key decides whether the user is notified at all.
  const clearIfStillOurs = async (extra = {}) => {
    const { pendingPlanOrder: cur } = await chrome.storage.local.get('pendingPlanOrder');
    if (cur && cur.order_id !== po.order_id) {
      console.log(`[Claude Tuner] plan order slot moved on (${po.order_id} → ${cur.order_id}); leaving it`);
      if (Object.keys(extra).length) await chrome.storage.local.set(extra);
      return;
    }
    await chrome.storage.local.set({ pendingPlanOrder: null, ...extra });
  };
  if (changeResult?.success) {
    await clearIfStillOurs({
      completedPlanOrder: { ...po, ...(auto ? { auto: true } : {}), completedAt: Date.now() },
    });
    // 🔴 NOTHING TO UNDO HERE ANY MORE, AND UNDOING IT WOULD DESTROY THE NUMBER (#994). These
    // lines used to clear the 📋 badge and the order icon that a pending order had painted. A
    // pending order no longer paints either (bg/badge.js), so the badge now holds the usage
    // percentage — and `setBadgeText({ text: '' })` would blank it until the next collection,
    // i.e. up to an hour of an empty toolbar because a plan order happened to succeed.
  } else if (changeResult?.error === ERR_PLAN_CHANGED_EXTERNALLY) {
    // Plan was changed outside of the order — clear stale order so banner disappears.
    // Same compare-and-clear: a newer order in the slot is not resolved by this one.
    await clearIfStillOurs();
  }
  return changeResult;
}

// === Dismiss recommendation → send to server ===
//
// 🔴 THE SERVER CALL IS NOT THE WHOLE DISMISSAL. It used to be all this did, fire-and-forget — and
// the card came back within the hour, because every popup surface re-renders from
// `lastStatus.recommendation` and nothing here ever cleared it (#1004). Three things have to
// happen, and the local two are what the user actually sees:
//   1. tell the server (it owns the escalating 3/7/14-day cooldown),
//   2. store the window it reports, so a stale server answer can't resurrect the card, and
//   3. drop the rec from storage, so the popup has nothing to redraw.
// Awaited rather than fired and forgotten: the response IS the window, and a caller told
// "dismissed" while nothing was recorded is the bug this replaced.
export async function dismissRecommendationServer({ permanent = false } = {}) {
  const config = await getConfig();
  const status = await getLastStatus();
  const email = status?.snapshot?.user_email;
  let result = null;
  if (email && config.serverUrl) {
    const payload = { user_email: email };
    if (permanent) payload.permanent = true;
    try {
      const res = await authedFetch(config, `${config.serverUrl}/api/snapshots/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) result = await res.json().catch(() => null);
    } catch { /* offline/blocked — recordRecDismiss falls back to its local floor */ }
  }
  // Order matters: record the window BEFORE dropping the rec, so a crash between the two leaves a
  // suppressed-but-present rec (harmless) rather than a deleted-and-unsuppressed one (the rec
  // silently returns on the next fetch with nothing to stop it).
  const record = await recordRecDismiss(result, permanent);
  await clearDismissedClaudeRec();
  // Repaint rather than blank — same reason as executePlanChange above (#994). Dismissing a
  // recommendation must remove the recommendation, not the percentage.
  if (!(await badgeLockedByAuthBlock())) {
    await updateBadgeForSelectedOrg((await getLastStatus())?.snapshot || null);
  }
  chrome.notifications.clear(NOTIF_ID_OPTIMIZE);
  return record;
}

export const muteRecommendationServer = () => dismissRecommendationServer({ permanent: true });

// === Execute plan change (based on server recommendation) ===
export async function executePlanChange(recommendation) {
  const fromPlan = recommendation.from_plan || recommendation.fromPlan;
  const toPlan = recommendation.to_plan || recommendation.toPlan;

  try {
    // Re-verify current plan before executing
    const config = await getConfig();
    const verifyOrg = await getSelectedOrg(config);
    const orgId = verifyOrg.uuid;
    const currentPlan = detectPlan(verifyOrg);
    if (currentPlan !== fromPlan) {
      console.log(`[Claude Tuner] Plan changed externally: expected ${fromPlan}, got ${currentPlan}`);
      await notifyPlanChange(await bt('opt_already_title'), await bt('opt_already_msg', currentPlan));
      await dismissRecommendationServer();
      return { success: false, error: ERR_PLAN_CHANGED_EXTERNALLY };
    }

    const isUpgrade = recommendation.type === 'upgrade';
    console.log(`[Claude Tuner] Executing ${isUpgrade ? 'upgrade' : 'downgrade'}: ${fromPlan} → ${toPlan}`);

    if (isUpgrade) {
      const tierMap = { 'Max 5x': '5x', 'Max 20x': '20x' };
      const maxTier = tierMap[toPlan];
      if (!maxTier) throw new Error(`Unknown upgrade target: ${toPlan}`);

      await fetchClaudeApi(`/api/organizations/${orgId}/upgrade_to_max`, {
        method: 'PUT',
        body: JSON.stringify({ max_tier: maxTier }),
        headers: { 'Content-Type': 'application/json', ...ANTHROPIC_HEADERS },
      });
    } else {
      const targetApiType = PLAN_API_MAP[toPlan];
      if (!targetApiType) throw new Error(`Unknown downgrade target: ${toPlan}`);

      await fetchClaudeApi(`/api/organizations/${orgId}/downgrade_individual_claude_subscription`, {
        method: 'PUT',
        body: JSON.stringify({ target_plan_type: targetApiType }),
        headers: { 'Content-Type': 'application/json', ...ANTHROPIC_HEADERS },
      });
    }

    // Success — clear the RECOMMENDATION badge that prompted this change. Not when the auth-block
    // alarm owns the badge: sync is still dead, so clearing would hide that.
    // (The "order icon may be active" this used to also cover is gone — a pending order no longer
    // paints an icon or a badge, #994. The recommendation still does, until #994 unit 2.)
    // 🔴 REPAINT, DO NOT BLANK (#994, Codex DEPLOY-BLOCKER). This used to `setBadgeText('')`,
    // which was survivable when the slot held a 📋 or a recommendation glyph — the next collect
    // would put the number back. It is not survivable now that the slot holds the PERCENTAGE:
    // blanking leaves an empty toolbar until the next collection, and the 3s forced collect that
    // was supposed to cover it (background.js) is a timer in an MV3 worker that can be killed.
    // Repainting from the last snapshot restores the number synchronously and still removes the
    // recommendation badge that prompted this change.
    // 🔴 NEVER LET COSMETICS FAIL THE TRANSACTION (Codex). This sits inside the try that decides
    // whether the plan change succeeded. The Anthropic call has already returned OK by now, so a
    // throw from a badge repaint would report failure for a change that DID happen — leaving
    // pendingPlanOrder around and inviting a retry of a partially applied change.
    try {
      if (!(await badgeLockedByAuthBlock())) {
        resetIcon();
        await updateBadgeForSelectedOrg((await getLastStatus())?.snapshot || null);
      }
    } catch (e) {
      console.warn('[Claude Tuner] badge repaint after plan change failed:', e?.message);
    }
    await notifyPlanChange(await bt('opt_done_title'), await bt('opt_done_msg', fromPlan, toPlan), 2);

    console.log(`[Claude Tuner] Plan change successful: ${fromPlan} → ${toPlan}`);

    // Record state change immediately (skip dedup; server auto-updates last_plan_change_at)
    forceCollect('plan change');

    return { success: true };

  } catch (error) {
    console.error(`[Claude Tuner] Plan change failed:`, error.message);
    await notifyPlanChange(await bt('opt_fail_title'), error.message, 2);
    return { success: false, error: error.message };
  }
}

// === Cancel downgrade (keep current plan) ===
export async function cancelDowngrade() {
  try {
    const config = await getConfig();
    const orgId = (await getSelectedOrg(config)).uuid;

    // Check current scheduled status
    const subDetails = await fetchClaudeApi(`/api/organizations/${orgId}/subscription_details`);
    if (!subDetails?.scheduled_downgrade) {
      return { success: false, error: 'No scheduled downgrade found' };
    }

    const fromPlan = subDetails.scheduled_downgrade.plan_type;

    await fetchClaudeApi(`/api/organizations/${orgId}/cancel_subscription_downgrade`, {
      method: 'PUT',
      headers: ANTHROPIC_HEADERS,
    });

    console.log(`[Claude Tuner] Downgrade cancelled (was → ${fromPlan})`);
    await notifyPlanChange(await bt('opt_cancel_title'), await bt('opt_cancel_msg', fromPlan), 2);

    // Record state change immediately (skip dedup)
    forceCollect('cancel');

    return { success: true, cancelledPlan: fromPlan };

  } catch (error) {
    console.error('[Claude Tuner] Cancel downgrade failed:', error.message);
    return { success: false, error: error.message };
  }
}

// === Execute direct downgrade ===
export async function downgradeTo(targetPlanApi) {
  try {
    if (!PLAN_API_MAP || !Object.values(PLAN_API_MAP).includes(targetPlanApi)) {
      return { success: false, error: `Unknown plan: ${targetPlanApi}` };
    }

    const config = await getConfig();
    const targetOrg = await getSelectedOrg(config);
    const orgId = targetOrg.uuid;
    const currentPlan = detectPlan(targetOrg);

    // Only downgrade to a plan lower than current
    const targetLabel = Object.entries(PLAN_API_MAP).find(([, v]) => v === targetPlanApi)?.[0] || targetPlanApi;

    console.log(`[Claude Tuner] Direct downgrade: ${currentPlan} → ${targetLabel} (${targetPlanApi})`);

    await fetchClaudeApi(`/api/organizations/${orgId}/downgrade_individual_claude_subscription`, {
      method: 'PUT',
      body: JSON.stringify({ target_plan_type: targetPlanApi }),
      headers: { 'Content-Type': 'application/json', ...ANTHROPIC_HEADERS },
    });

    // Record state change immediately
    forceCollect('downgrade');

    return { success: true, from: currentPlan, to: targetLabel };

  } catch (error) {
    console.error('[Claude Tuner] Direct downgrade failed:', error.message);
    return { success: false, error: error.message };
  }
}
