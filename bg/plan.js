import { PLAN_HIERARCHY, PLAN_API_MAP, SEAT_TIER_MAP, NOTIF_ID_OPTIMIZE, ANTHROPIC_HEADERS } from './constants.js';
import { bt } from './i18n.js';
import { fetchClaudeApi } from './api.js';
import { getConfig, getLastStatus } from './storage.js';

// === 순환 의존 해결: collectAndSend 참조 주입 ===
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
    chrome.notifications.create(NOTIF_ID_OPTIMIZE, {
      type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority,
    });
  }
}

/** Fetch org list and resolve the user's selected (or first) org */
async function getSelectedOrg(config) {
  const orgList = await fetchClaudeApi('/api/organizations');
  if (!Array.isArray(orgList) || orgList.length === 0) {
    throw new Error('조직 정보 확인 실패');
  }
  return config.selectedOrgId
    ? (orgList.find(o => o.uuid === config.selectedOrgId) || orgList[0])
    : orgList[0];
}

// === 구독 정보 가져오기 (개인 org 전용) ===
export async function fetchSubscriptionInfo(orgUuid) {
  const info = {};
  // 두 API를 병렬 호출 (각각 실패해도 독립적)
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

// === 플랜 감지 ===
export function detectPlan(org) {
  const capabilities = org.capabilities || [];
  const tier = org.rate_limit_tier;
  const capsStr = capabilities.join(',').toLowerCase();

  let plan = 'unknown';
  if (capabilities.includes('claude_max') || capsStr.includes('max')) {
    const tierStr = (tier || '').toLowerCase();
    // tier에서 max_20x / max_5x 정확 매칭
    if (tierStr.includes('max_20x')) plan = 'Max 20x';
    else if (tierStr.includes('max_5x')) plan = 'Max 5x';
    else plan = 'Max';
  } else if (capabilities.includes('pro') || capsStr.includes('pro')) {
    plan = 'Pro';
  } else if (org.raven_type === 'enterprise' || capsStr.includes('raven_enterprise')) {
    plan = 'Enterprise';
  } else if (org.raven_type === 'team' || capsStr.includes('raven') || capsStr.includes('team')) {
    plan = 'Team';
  } else if (capabilities.includes('free') || capsStr.includes('free')) {
    plan = 'Free';
  } else if (capabilities.includes('api') && capabilities.length === 1) {
    plan = 'API';
  }

  // tier 기반 fallback
  if (plan === 'unknown' && tier) {
    const t = tier.toLowerCase();
    if (t.includes('max')) plan = 'Max';
    else if (t.includes('pro') || t === 'stripe_subscription') plan = 'Pro';
    else if (t.includes('enterprise')) plan = 'Enterprise';
    else if (t.includes('team') || t.includes('raven')) plan = 'Team';
    else if (t.includes('prepaid') || t.includes('api')) plan = 'API';
    else if (t === 'default_claude_ai') plan = 'Pro';
  }

  // 최종 fallback: capabilities에 유료 플랜 키워드가 전혀 없으면 Free
  if (plan === 'unknown' && capabilities.includes('chat') &&
      !capsStr.includes('pro') && !capsStr.includes('max') &&
      !capsStr.includes('raven') && !capsStr.includes('enterprise')) {
    plan = 'Free';
  }

  if (plan === 'Max' && tier && !['stripe_subscription', 'default'].includes(tier)) {
    plan = `Max (${tier})`;
  }

  return plan;
}

// Team plan 세분화: allSeatTiers 캐시에서 seat_tier 조회
export async function refineTeamPlan(plan, orgUuid) {
  if (plan !== 'Team' || !orgUuid) return plan;
  const { accountCache } = await chrome.storage.local.get({ accountCache: null });
  const st = accountCache?.allSeatTiers?.[orgUuid];
  return st ? (SEAT_TIER_MAP[st] || 'Team Standard') : plan;
}

// === 플랜 변경 오더 결과 보고 ===
export async function reportPlanOrderResult(config, orderId, userEmail, action, result, failureReason) {
  try {
    await fetch(`${config.serverUrl}/api/snapshots/plan-order-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
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
  if (changeResult?.success) {
    await chrome.storage.local.set({
      pendingPlanOrder: null,
      completedPlanOrder: { ...po, ...(auto ? { auto: true } : {}), completedAt: Date.now() },
    });
  }
  return changeResult;
}

// === 서버 추천 무시 → 서버에 전송 ===
export async function dismissRecommendationServer({ permanent = false } = {}) {
  const config = await getConfig();
  const status = await getLastStatus();
  const email = status?.snapshot?.user_email;
  if (email && config.serverUrl && config.apiKey) {
    const payload = { user_email: email };
    if (permanent) payload.permanent = true;
    fetch(`${config.serverUrl}/api/snapshots/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }
  chrome.action.setBadgeText({ text: '' });
  chrome.notifications.clear(NOTIF_ID_OPTIMIZE);
}

export const muteRecommendationServer = () => dismissRecommendationServer({ permanent: true });

// === 플랜 변경 실행 (서버 추천 기반) ===
export async function executePlanChange(recommendation) {
  const fromPlan = recommendation.from_plan || recommendation.fromPlan;
  const toPlan = recommendation.to_plan || recommendation.toPlan;

  try {
    // 실행 전 현재 플랜 재확인
    const config = await getConfig();
    const verifyOrg = await getSelectedOrg(config);
    const orgId = verifyOrg.uuid;
    const currentPlan = detectPlan(verifyOrg);
    if (currentPlan !== fromPlan) {
      console.log(`[Claude Tuner] Plan changed externally: expected ${fromPlan}, got ${currentPlan}`);
      await notifyPlanChange(await bt('opt_already_title'), await bt('opt_already_msg', currentPlan));
      await dismissRecommendationServer();
      return { success: false, error: 'Plan already changed externally' };
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

    // 성공
    chrome.action.setBadgeText({ text: '' });
    await notifyPlanChange(await bt('opt_done_title'), await bt('opt_done_msg', fromPlan, toPlan), 2);

    console.log(`[Claude Tuner] Plan change successful: ${fromPlan} → ${toPlan}`);

    // 상태 변경 즉시 기록 (중복 체크 건너뜀, 서버에서 last_plan_change_at 자동 업데이트)
    forceCollect('plan change');

    return { success: true };

  } catch (error) {
    console.error(`[Claude Tuner] Plan change failed:`, error.message);
    await notifyPlanChange(await bt('opt_fail_title'), error.message, 2);
    return { success: false, error: error.message };
  }
}

// === 다운그레이드 취소 (원래 플랜 유지) ===
export async function cancelDowngrade() {
  try {
    const config = await getConfig();
    const orgId = (await getSelectedOrg(config)).uuid;

    // 현재 예약 상태 확인
    const subDetails = await fetchClaudeApi(`/api/organizations/${orgId}/subscription_details`);
    if (!subDetails?.scheduled_downgrade) {
      return { success: false, error: '예약된 다운그레이드가 없습니다' };
    }

    const fromPlan = subDetails.scheduled_downgrade.plan_type;

    await fetchClaudeApi(`/api/organizations/${orgId}/cancel_subscription_downgrade`, {
      method: 'PUT',
      headers: ANTHROPIC_HEADERS,
    });

    console.log(`[Claude Tuner] Downgrade cancelled (was → ${fromPlan})`);
    await notifyPlanChange(await bt('opt_cancel_title'), await bt('opt_cancel_msg', fromPlan), 2);

    // 상태 변경 즉시 기록 (중복 체크 건너뜀)
    forceCollect('cancel');

    return { success: true, cancelledPlan: fromPlan };

  } catch (error) {
    console.error('[Claude Tuner] Cancel downgrade failed:', error.message);
    return { success: false, error: error.message };
  }
}

// === 직접 다운그레이드 실행 ===
export async function downgradeTo(targetPlanApi) {
  try {
    if (!PLAN_API_MAP || !Object.values(PLAN_API_MAP).includes(targetPlanApi)) {
      return { success: false, error: `알 수 없는 플랜: ${targetPlanApi}` };
    }

    const config = await getConfig();
    const targetOrg = await getSelectedOrg(config);
    const orgId = targetOrg.uuid;
    const currentPlan = detectPlan(targetOrg);

    // 현재 플랜보다 낮은 플랜으로만 다운그레이드
    const targetLabel = Object.entries(PLAN_API_MAP).find(([, v]) => v === targetPlanApi)?.[0] || targetPlanApi;

    console.log(`[Claude Tuner] Direct downgrade: ${currentPlan} → ${targetLabel} (${targetPlanApi})`);

    await fetchClaudeApi(`/api/organizations/${orgId}/downgrade_individual_claude_subscription`, {
      method: 'PUT',
      body: JSON.stringify({ target_plan_type: targetPlanApi }),
      headers: { 'Content-Type': 'application/json', ...ANTHROPIC_HEADERS },
    });

    // 상태 변경 즉시 기록
    forceCollect('downgrade');

    return { success: true, from: currentPlan, to: targetLabel };

  } catch (error) {
    console.error('[Claude Tuner] Direct downgrade failed:', error.message);
    return { success: false, error: error.message };
  }
}
