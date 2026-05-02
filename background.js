// === ES Module Imports ===
import { sendGAEvent } from './bg/analytics.js';
import {
  ALARM_NAME, ALARM_EXPIRE_PREFIX, ALARM_BOOST, ALARM_WEEKLY_REPORT,
  DEFAULT_INTERVAL_MINUTES, NOTIF_ID_OPTIMIZE,
  DEFAULT_SERVER_URL, SITE_URL,
} from './bg/constants.js';
import { bt } from './bg/i18n.js';
import { getConfig, getLastStatus, getUsageHistory } from './bg/storage.js';
import { fetchClaudeApi } from './bg/api.js';
import { updateBadge } from './bg/badge.js';
import { scheduleWeeklyReport, sendWeeklyReport } from './bg/notifications.js';
import {
  detectPlan, executePlanChange, cancelDowngrade, downgradeTo,
  acceptPlanOrder, reportPlanOrderResult, dismissRecommendationServer, muteRecommendationServer,
  setCollectAndSendRef,
} from './bg/plan.js';
import { collectAndSend, getLastActiveOrgId } from './bg/collect.js';

// 도메인 이관: 기존 사용자 serverUrl 자동 마이그레이션
chrome.storage.sync.get({ serverUrl: '' }, ({ serverUrl }) => {
  if (serverUrl === 'https://api.claudetuner.letrun.ai') {
    chrome.storage.sync.set({ serverUrl: DEFAULT_SERVER_URL });
  }
});

// 사이드패널 preference 복원 (sidePanel API 없으면 자동 팝업 모드)
async function restoreSidePanelPreference() {
  try {
    const hasSidePanel = !!(chrome.sidePanel && chrome.sidePanel.setPanelBehavior);
    if (!hasSidePanel) {
      await chrome.storage.local.set({ preferSidePanel: false });
    } else {
      const { preferSidePanel } = await chrome.storage.local.get({ preferSidePanel: true });
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: !!preferSidePanel });
    }
  } catch (e) {}
}

// === 개발용: 버전 변경 감지 시 자동 새로고침 (unpacked 확장만) ===
if (chrome.runtime.getManifest().update_url === undefined) {
  setInterval(async () => {
    try {
      const resp = await fetch(chrome.runtime.getURL('manifest.json'));
      const disk = await resp.json();
      if (disk.version !== chrome.runtime.getManifest().version) {
        console.log('[Claude Tuner] Version changed, reloading...');
        chrome.runtime.reload();
      }
    } catch (_) { /* ignore */ }
  }, 2000);
}

// === Install / Startup ===
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Claude Tuner] Extension installed');
  // v1.9.x → v1.10+ 마이그레이션 (완료된 사용자는 스킵)
  if (details.reason === 'update') {
    const { intervalExplicitlySet } = await chrome.storage.sync.get({ intervalExplicitlySet: undefined });
    if (intervalExplicitlySet === undefined) {
      await chrome.storage.sync.set({ intervalExplicitlySet: false });
      console.log('[Claude Tuner] Migration: intervalExplicitlySet initialized to false');
    }
  }
  // 신규 설치 시 welcome 페이지 오픈 (ref_source 캡처)
  if (details.reason === 'install') {
    chrome.tabs.create({ url: `${SITE_URL}/welcome/` });
  }
  await setupAlarm();
  sendGAEvent('extension_installed', { reason: details.reason });
  await restoreSidePanelPreference();
});

// 외부 connect 리스너 (service worker wake-up용)
chrome.runtime.onConnectExternal.addListener((port) => {
  // connect → disconnect로 service worker를 깨우는 용도, 별도 처리 불필요
});

// welcome 페이지 + 대시보드 로그인 메시지 수신
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'set_ref_source' && message.ref_source) {
    chrome.storage.local.set({ ref_source: message.ref_source });
    console.log('[Claude Tuner] ref_source set:', message.ref_source);
    sendResponse({ ok: true });
    return;
  }

  // 확장 프로그램 정보 조회
  if (message && message.type === 'GET_INFO') {
    sendResponse({ version: chrome.runtime.getManifest().version });
    return;
  }

  // 수집 상태 조회 (welcome 페이지 온보딩 체크리스트용)
  if (message && message.type === 'get_status') {
    (async () => {
      const status = await getLastStatus();
      sendResponse({ success: status?.success || false, lastStatus: status });
    })();
    return true; // async sendResponse
  }

  // 즉시 수집 트리거 (Welcome 페이지 온보딩용)
  if (message && message.type === 'force_collect') {
    (async () => {
      try {
        const result = await collectAndSend({ force: true });
        sendResponse({ ok: true, success: result?.success || false });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // welcome 페이지에서 사이드패널 열기 요청
  if (message && message.type === 'OPEN_SIDE_PANEL') {
    (async () => {
      try {
        if (chrome.sidePanel && chrome.sidePanel.open) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab) await chrome.sidePanel.open({ tabId: tab.id });
          await chrome.storage.local.set({ sidePanelAutoOpened: true });
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'sidePanel not supported' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async sendResponse
  }

  // Claude 계정으로 대시보드 로그인
  if (message && message.type === 'GET_CLAUDE_LOGIN') {
    (async () => {
      try {
        // 1. 이메일 가져오기: 캐시 우선, 없으면 Claude.ai API 호출
        let email = null;
        let userName = '';
        const cached = await chrome.storage.local.get(['accountCache']);
        const cache = cached.accountCache;
        if (cache && cache.email) {
          email = cache.email;
          userName = cache.name || '';
        } else {
          try {
            const acct = await fetchClaudeApi('/api/account', { quiet: true });
            email = acct?.email || acct?.email_address || null;
            userName = acct?.full_name || acct?.display_name || '';
          } catch (e) {
            console.warn('[Claude Tuner] Login: account API failed:', e.message);
          }
        }

        if (!email) {
          sendResponse({ success: false, error: 'not_logged_in' });
          return;
        }

        // 2. 서버에 로그인 토큰 요청
        const config = await getConfig();
        const resp = await fetch(`${config.serverUrl}/api/auth/ext-login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': config.apiKey,
          },
          body: JSON.stringify({ email }),
        });

        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          sendResponse({ success: false, error: data.error || 'server_error' });
          return;
        }

        const data = await resp.json();
        sendResponse({ success: true, login_token: data.login_token, email, name: userName });
      } catch (e) {
        console.error('[Claude Tuner] Login error:', e);
        sendResponse({ success: false, error: 'extension_error' });
      }
    })();
    return true; // async response
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await setupAlarm();
  sendGAEvent('extension_loaded');
  await restoreSidePanelPreference();
});

async function setupAlarm() {
  const config = await getConfig();
  const intervalMinutes = config.intervalMinutes || DEFAULT_INTERVAL_MINUTES;

  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: intervalMinutes,
  });
  console.log(`[Claude Tuner] Alarm set: every ${intervalMinutes} minutes`);

  // 주간 리포트 예약
  await scheduleWeeklyReport();
}

// === 신규 설치 후 Claude.ai 첫 방문 시 사이드패널 자동 오픈 ===
async function tryAutoOpenSidePanel(tabId) {
  try {
    const { sidePanelAutoOpened } = await chrome.storage.local.get({ sidePanelAutoOpened: false });
    if (sidePanelAutoOpened) return;
    if (chrome.sidePanel && chrome.sidePanel.open) {
      await chrome.sidePanel.open({ tabId });
      await chrome.storage.local.set({ sidePanelAutoOpened: true });
      console.log('[Claude Tuner] Side panel auto-opened on first Claude.ai visit');
    }
  } catch (e) {
    console.log('[Claude Tuner] Side panel auto-open failed:', e.message);
  }
}

// === 탭 이벤트: claude.ai 접속/복귀 시 자동 수집 ===
let _lastTabCollect = 0;
const TAB_COLLECT_THROTTLE_MS = 60 * 1000; // 1분 쓰로틀

// SW 재시작 시 storage에서 복원 (메모리 변수는 리셋되므로)
chrome.storage.local.get({ _lastTabCollect: 0 }, (r) => { _lastTabCollect = r._lastTabCollect; });

async function tryTabCollect(reason) {
  const now = Date.now();
  // 이전 수집이 에러 상태면 쓰로틀 무시 (로그인/탭 복귀 시 즉시 재시도)
  const prevStatus = await getLastStatus();
  const wasError = prevStatus && !prevStatus.success && prevStatus.error;
  // cookie-org-changed는 org 전환이므로 throttle 면제
  if (reason !== 'cookie-org-changed' && !wasError && now - _lastTabCollect < TAB_COLLECT_THROTTLE_MS) return;
  _lastTabCollect = now;
  chrome.storage.local.set({ _lastTabCollect: now });

  // Adaptive polling: 탭 전환 시 모든 secondary org를 ACTIVE로 리셋
  // (사용자가 다른 org으로 전환했을 수 있으므로 즉시 전체 수집)
  try {
    const { orgPollState } = await chrome.storage.local.get({ orgPollState: {} });
    if (orgPollState && Object.keys(orgPollState).length > 0) {
      let resetCount = 0;
      for (const uuid of Object.keys(orgPollState)) {
        if (orgPollState[uuid].tier !== 'active') {
          orgPollState[uuid].tier = 'active';
          orgPollState[uuid].unchangedCount = 0;
          resetCount++;
        }
      }
      if (resetCount > 0) {
        await chrome.storage.local.set({ orgPollState });
        console.log(`[Claude Tuner] Adaptive poll: ${resetCount} org(s) reset to active (${reason})`);
      }
    }
  } catch (_) { /* poll state reset 실패 무시 */ }

  console.log(`[Claude Tuner] Tab collect triggered: ${reason}${wasError ? ' (retry after error)' : ''}`);
  const result = await collectAndSend();
  if (result.success) {
    await scheduleExpireAlarms(result.snapshot);
  }
}

// URL 변경 감지 (로그인 완료, 페이지 이동 등)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.startsWith('https://claude.ai')) {
    tryTabCollect('tab-updated');
    tryAutoOpenSidePanel(tabId);
  }
});

// 탭 활성화 감지 (claude.ai 탭으로 돌아올 때)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url?.startsWith('https://claude.ai')) {
      tryTabCollect('tab-activated');
    }
  } catch (_) { /* 탭 조회 실패 무시 */ }
});

// lastActiveOrg 쿠키 변경 감지 → org 전환 시 즉시 수집 + adaptive poll 리셋
chrome.cookies.onChanged.addListener((info) => {
  if (info.cookie.name === 'lastActiveOrg' && info.cookie.domain?.includes('claude.ai') && !info.removed) {
    console.log(`[Claude Tuner] lastActiveOrg cookie changed → ${info.cookie.value}`);
    // popup/side panel에 즉시 알림 (수집 완료 전 칩 전환용)
    chrome.runtime.sendMessage({ type: 'ORG_COOKIE_CHANGED', orgId: info.cookie.value }).catch(() => {});
    tryTabCollect('cookie-org-changed');
  }
});

// === webRequest: Claude.ai completion 429 감지 → 즉시 수집 ===
// 메시지 전송/재시도 시 rate limit(429)이 발생하면 즉시 usage 데이터 갱신
let _last429Collect = 0;
const RATELIMIT_COLLECT_THROTTLE_MS = 30 * 1000; // 30초 쓰로틀 (연속 429 방지)

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.statusCode === 429) {
      const now = Date.now();
      if (now - _last429Collect < RATELIMIT_COLLECT_THROTTLE_MS) return;
      _last429Collect = now;
      console.log(`[Claude Tuner] 429 detected: ${details.url.split('?')[0]}`);
      collectAndSend().then((result) => {
        if (result.success) scheduleExpireAlarms(result.snapshot);
      });
    }
  },
  {
    urls: [
      'https://claude.ai/api/organizations/*/completion',
      'https://claude.ai/api/organizations/*/retry_completion',
    ],
  }
);

// === Adaptive Boost: 사용량 급증 시 로컬 수집 빈도 2배 ===
async function evaluateBoost(snapshot) {
  if (snapshot?.five_hour?.utilization == null) return;
  const util5h = snapshot.five_hour.utilization;
  const { usageHistory = [] } = await chrome.storage.local.get({ usageHistory: [] });

  // 최근 2개 포인트로 상승 여부 판단
  const recent = usageHistory.filter(p => p.h5 != null).slice(-2);
  const isRising = recent.length >= 2 && recent[1].h5 > recent[0].h5;

  const shouldBoost = util5h >= 50 && isRising;
  const existing = await chrome.alarms.get(ALARM_BOOST);

  if (shouldBoost && !existing) {
    const { intervalMinutes = 5 } = await chrome.storage.sync.get({ intervalMinutes: 5 });
    const boostInterval = Math.max(intervalMinutes / 2, 1);
    chrome.alarms.create(ALARM_BOOST, { delayInMinutes: boostInterval, periodInMinutes: boostInterval });
    await chrome.storage.local.set({ boostActive: true });
    console.log(`[Claude Tuner] Boost ON: 5h=${util5h}%, interval=${boostInterval}m`);
  } else if (!shouldBoost && existing) {
    chrome.alarms.clear(ALARM_BOOST);
    await chrome.storage.local.set({ boostActive: false });
    console.log(`[Claude Tuner] Boost OFF: 5h=${util5h}%, rising=${isRising}`);
  }
}

// === Alarm Handler ===
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_BOOST) {
    // 부스트 수집: 로컬 저장만, 서버 전송 안 함
    const result = await collectAndSend({ skipServer: true });
    if (result.success) await evaluateBoost(result.snapshot);
    return;
  }
  if (alarm.name === ALARM_NAME) {
    const result = await collectAndSend();
    // 수집 성공 시 expire 시간 기반 추가 알람 예약
    if (result.success) {
      await scheduleExpireAlarms(result.snapshot);
      await evaluateBoost(result.snapshot);
    }
  }
  // 주간 리포트
  if (alarm.name === ALARM_WEEKLY_REPORT) {
    await sendWeeklyReport();
    return;
  }
  // expire 알람 처리 (5분전 알림, 2분전/1분전/정각 수집, 리셋 직후 알림)
  if (alarm.name.startsWith(ALARM_EXPIRE_PREFIX)) {
    console.log(`[Claude Tuner] Expire alarm fired: ${alarm.name}`);

    // 리셋 5분 전 알림
    if (alarm.name.includes('-notify5')) {
      const { notifyResetSoon = true } = await chrome.storage.sync.get({ notifyResetSoon: true });
      if (notifyResetSoon) {
        const win = await bt(alarm.name.includes('-5h-') ? 'win_5h' : 'win_7d');
        chrome.notifications.create(`reset-soon-${Date.now()}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: await bt('reset_soon_title', win),
          message: await bt('reset_soon_msg', win),
          priority: 1,
        });
      }
      return;
    }

    // 리셋 직후 알림
    if (alarm.name.includes('-after')) {
      const { notifyResetDone = true } = await chrome.storage.sync.get({ notifyResetDone: true });
      if (notifyResetDone) {
        const win = await bt(alarm.name.includes('-5h-') ? 'win_5h' : 'win_7d');
        chrome.notifications.create(`reset-done-${Date.now()}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: await bt('reset_done_title', win),
          message: await bt('reset_done_msg', win),
          priority: 1,
        });
      }
    }

    await collectAndSend();
  }
});

// expire 시간 기준 추가 수집 알람 예약
// resets_at 2분전, 1분전, 정각에 수집
async function scheduleExpireAlarms(snapshot) {
  if (!snapshot) return;

  // 기존 expire 알람 모두 정리
  const allAlarms = await chrome.alarms.getAll();
  for (const a of allAlarms) {
    if (a.name.startsWith(ALARM_EXPIRE_PREFIX)) {
      await chrome.alarms.clear(a.name);
    }
  }

  const resetTimes = [];
  if (snapshot.five_hour?.resets_at) resetTimes.push({ key: '5h', time: snapshot.five_hour.resets_at });
  if (snapshot.seven_day?.resets_at) resetTimes.push({ key: '7d', time: snapshot.seven_day.resets_at });
  if (snapshot.seven_day_opus?.resets_at) resetTimes.push({ key: 'opus', time: snapshot.seven_day_opus.resets_at });
  if (snapshot.seven_day_sonnet?.resets_at) resetTimes.push({ key: 'sonnet', time: snapshot.seven_day_sonnet.resets_at });

  const now = Date.now();
  const offsets = [
    { suffix: 'notify5', minutes: -5 }, // 5분 전 알림
    { suffix: 'pre2', minutes: -2 },    // 2분 전 수집
    { suffix: 'pre1', minutes: -1 },    // 1분 전 수집
    { suffix: 'at', minutes: 0 },       // 정각 수집
    { suffix: 'after', minutes: 2 },    // 리셋 2분 후 수집 + 알림
  ];

  let scheduled = 0;
  for (const { key, time } of resetTimes) {
    const expireMs = new Date(time).getTime();
    if (isNaN(expireMs)) continue;

    for (const { suffix, minutes } of offsets) {
      const triggerMs = expireMs + minutes * 60 * 1000;
      const delayMs = triggerMs - now;

      // 미래 시점이고 30초 이상 남은 경우만 예약
      if (delayMs > 30000) {
        const delayMinutes = delayMs / 60000;
        const alarmName = `${ALARM_EXPIRE_PREFIX}${key}-${suffix}`;
        chrome.alarms.create(alarmName, { delayInMinutes: delayMinutes });
        scheduled++;
      }
    }
  }

  if (scheduled > 0) {
    console.log(`[Claude Tuner] ${scheduled} expire alarms scheduled`);
  }
}

// === Message Handler (popup에서 수동 수집 요청) ===
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'MANUAL_COLLECT') {
    collectAndSend({ force: true }).then((result) => sendResponse(result));
    return true;
  }
  if (message.type === 'SET_SIDE_PANEL_MODE') {
    (async () => {
      try {
        if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
          await chrome.sidePanel.setPanelBehavior({
            openPanelOnActionClick: !!message.enabled
          });
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.type === 'GET_STATUS') {
    getLastStatus().then((status) => sendResponse(status));
    return true;
  }
  if (message.type === 'REFRESH_BADGE') {
    getLastStatus().then((status) => {
      if (status?.snapshot) {
        updateBadge(status.snapshot.seven_day?.utilization, status.snapshot.five_hour?.utilization);
      }
      sendResponse({ success: true });
    });
    return true;
  }
  if (message.type === 'GET_USAGE_HISTORY') {
    getUsageHistory().then((history) => sendResponse(history));
    return true;
  }
  if (message.type === 'EXECUTE_PLAN_CHANGE') {
    executePlanChange(message.recommendation).then((result) => sendResponse(result));
    return true;
  }
  if (message.type === 'DISMISS_RECOMMENDATION') {
    dismissRecommendationServer().then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.type === 'MUTE_RECOMMENDATION') {
    muteRecommendationServer().then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.type === 'RESPOND_PLAN_ORDER') {
    (async () => {
      const { pendingPlanOrder: po } = await chrome.storage.local.get('pendingPlanOrder');
      if (!po) { sendResponse({ success: false, error: 'No pending order' }); return; }
      const config = await getConfig();
      const status = await getLastStatus();
      const userEmail = status?.snapshot?.user_email;
      if (message.action === 'accept') {
        try {
          const changeResult = await acceptPlanOrder(config, po, userEmail);
          sendResponse({ success: changeResult?.success });
          if (changeResult?.success) {
            setTimeout(() => collectAndSend(), 3000);
          }
        } catch (e) {
          await reportPlanOrderResult(config, po.order_id, userEmail, 'accepted', 'failed', e.message);
          sendResponse({ success: false, error: e.message });
        }
      } else {
        await reportPlanOrderResult(config, po.order_id, userEmail, 'rejected');
        await chrome.storage.local.set({ pendingPlanOrder: null });
        // 배지를 사용률 표시로 복원
        const lastStatus = await getLastStatus();
        if (lastStatus?.snapshot) {
          await updateBadge(lastStatus.snapshot.seven_day?.utilization, lastStatus.snapshot.five_hour?.utilization);
        }
        sendResponse({ success: true });
      }
    })();
    return true;
  }
  if (message.type === 'CANCEL_DOWNGRADE') {
    cancelDowngrade().then(async (result) => {
      if (result?.success) {
        // completedPlanOrder가 있으면 revert 보고
        const { completedPlanOrder: cpo } = await chrome.storage.local.get('completedPlanOrder');
        if (cpo?.order_id) {
          const config = await getConfig();
          const status = await getLastStatus();
          const email = status?.snapshot?.user_email;
          if (email) {
            try {
              await fetch(`${config.serverUrl}/api/snapshots/plan-order-revert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
                body: JSON.stringify({ order_id: cpo.order_id, user_email: email }),
              });
            } catch (e) { console.error('[Claude Tuner] Failed to report revert:', e.message); }
          }
        }
        await chrome.storage.local.set({ completedPlanOrder: null });
      }
      sendResponse(result);
      if (result?.success) setTimeout(() => collectAndSend(), 3000);
    });
    return true;
  }
  if (message.type === 'DOWNGRADE_TO') {
    downgradeTo(message.targetPlan).then((result) => sendResponse(result));
    return true;
  }
  if (message.type === 'GET_COOKIE_ORG') {
    getLastActiveOrgId().then(orgId => sendResponse({ orgId })).catch(() => sendResponse({ orgId: null }));
    return true;
  }
  if (message.type === 'GET_ORGANIZATIONS') {
    fetchClaudeApi('/api/organizations').then(orgList => {
      if (!Array.isArray(orgList)) { sendResponse({ success: false, error: 'Invalid response' }); return; }
      // API만 제외 (Enterprise 포함)
      const orgs = orgList
        .map(o => ({ uuid: o.uuid, name: o.name || o.display_name || 'Unknown', plan: detectPlan(o) }))
        .filter(o => o.plan !== 'API');
      sendResponse({ success: true, orgs });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

// === Notification 클릭 핸들러 ===
chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  // 수집 실패 알림 → Claude.ai 열기
  if (notifId.startsWith('collect-fail-') && btnIdx === 0) {
    chrome.tabs.create({ url: 'https://claude.ai' });
    chrome.notifications.clear(notifId);
    return;
  }
  // 플랜 변경 오더 알림
  if (notifId.startsWith('plan-order-')) {
    const orderId = parseInt(notifId.replace('plan-order-', ''));
    const { pendingPlanOrder: po } = await chrome.storage.local.get('pendingPlanOrder');
    if (!po || po.order_id !== orderId) return;
    const config = await getConfig();
    const status = await getLastStatus();
    const userEmail = status?.snapshot?.user_email;
    if (btnIdx === 0) {
      // 수락 → 플랜 변경 실행
      try {
        await acceptPlanOrder(config, po, userEmail);
      } catch (e) {
        await reportPlanOrderResult(config, po.order_id, userEmail, 'accepted', 'failed', e.message);
      }
    } else {
      // 거절
      await reportPlanOrderResult(config, po.order_id, userEmail, 'rejected');
      await chrome.storage.local.set({ pendingPlanOrder: null });
    }
    chrome.notifications.clear(notifId);
    return;
  }
  // 기존 추천 알림
  if (notifId === NOTIF_ID_OPTIMIZE && btnIdx === 0) {
    const status = await getLastStatus();
    const rec = status?.recommendation;
    if (rec?.type) {
      await executePlanChange(rec);
    }
  } else if (notifId === NOTIF_ID_OPTIMIZE && btnIdx === 1) {
    await dismissRecommendationServer();
  }
});

// bg/collect.js ↔ bg/plan.js 순환 의존 해결: setter 주입
setCollectAndSendRef(collectAndSend);
