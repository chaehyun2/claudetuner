import { ACTIONABLE_ERRORS, NOTIF_ID_ALERT, ALARM_WEEKLY_REPORT } from './constants.js';
import { bt } from './i18n.js';
import { getLastStatus } from './storage.js';

// === Collection failure notification (3-stage escalation) ===
export async function checkCollectFailNotification(errorMsg) {
  const { notifyCollectFail = true } = await chrome.storage.sync.get({ notifyCollectFail: true });
  if (!notifyCollectFail) return;

  // Rate limit is not a notification target (user is actively using)
  if (errorMsg.includes('err_rate_limit')) return;

  const { collectFailState = {} } = await chrome.storage.local.get({ collectFailState: {} });
  const status = await getLastStatus();
  const lastSuccess = collectFailState.firstFailAt
    ? (status?.lastSuccessTimestamp || null)
    : null;

  // Inactive user (no collection for 7+ days) → skip notification
  if (lastSuccess && (Date.now() - lastSuccess) > 7 * 24 * 60 * 60 * 1000) return;

  // Record first failure
  if (!collectFailState.firstFailAt) {
    await chrome.storage.local.set({
      collectFailState: {
        firstFailAt: Date.now(),
        lastErrorCode: errorMsg,
        stage: 'none',
        hasActionableError: ACTIONABLE_ERRORS.some(e => errorMsg.includes(e)),
      },
    });
    return;
  }

  // === First-run: never collected successfully before ===
  if (!lastSuccess && !status?.lastSuccessTimestamp) {
    const failDurationFirstrun = Date.now() - collectFailState.firstFailAt;
    if (failDurationFirstrun >= 10 * 60 * 1000 && collectFailState.stage !== 'first-run') {
      chrome.notifications.create('collect-fail-firstrun', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: await bt('cf_firstrun_title'),
        message: await bt('cf_firstrun_msg'),
        priority: 2,
        buttons: [{ title: await bt('cf_btn_open') }],
      });
      collectFailState.stage = 'first-run';
      collectFailState.lastErrorCode = errorMsg;
      await chrome.storage.local.set({ collectFailState });
    }
    return;
  }

  // Update whether an actionable error occurred during this episode
  const isActionable = collectFailState.hasActionableError || ACTIONABLE_ERRORS.some(e => errorMsg.includes(e));
  if (isActionable !== collectFailState.hasActionableError) {
    collectFailState.hasActionableError = isActionable;
    await chrome.storage.local.set({ collectFailState });
  }

  const failDuration = Date.now() - collectFailState.firstFailAt;
  const currentStage = collectFailState.stage || 'none';

  // Determine stage
  const FIRST_DELAY = isActionable ? 30 * 60 * 1000 : 2 * 60 * 60 * 1000; // 30min / 2h
  const REMINDER_DELAY = 4 * 60 * 60 * 1000;  // 4 hours
  const FINAL_DELAY = 24 * 60 * 60 * 1000;    // 24 hours

  let targetStage = 'none';
  if (failDuration >= FINAL_DELAY) targetStage = 'final';
  else if (failDuration >= REMINDER_DELAY) targetStage = 'reminder';
  else if (failDuration >= FIRST_DELAY) targetStage = 'first';

  const STAGE_ORDER = { none: 0, first: 1, reminder: 2, final: 3 };
  if (STAGE_ORDER[targetStage] <= STAGE_ORDER[currentStage]) return;

  // Send notification
  const hours = Math.round(failDuration / (60 * 60 * 1000));
  let title, message, notifId;

  if (targetStage === 'first') {
    title = isActionable ? await bt('cf_title') : await bt('cf_paused_title');
    message = isActionable ? await bt('cf_session_msg') : await bt('cf_transient_msg');
    notifId = 'collect-fail-first';
  } else if (targetStage === 'reminder') {
    title = await bt('cf_reminder_title', hours);
    message = isActionable ? await bt('cf_session_msg') : await bt('cf_transient_msg');
    notifId = 'collect-fail-reminder';
  } else {
    title = await bt('cf_final_title');
    message = await bt('cf_final_msg');
    notifId = 'collect-fail-final';
  }

  const opts = {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: targetStage === 'first' ? 1 : 2,
  };
  if (isActionable && targetStage !== 'final') {
    // No button needed at final stage (already informed)
    // No button needed for transient errors (auto-retry)
  }
  if (isActionable) {
    opts.buttons = [{ title: await bt('cf_btn_open') }];
  }

  chrome.notifications.create(notifId, opts);

  collectFailState.stage = targetStage;
  collectFailState.lastErrorCode = errorMsg;
  collectFailState.hasActionableError = isActionable;
  await chrome.storage.local.set({ collectFailState });
}

// === Usage threshold alerts ===
export async function checkUsageAlerts(snapshot) {
  const { thresholdWarn = 80, thresholdDanger = 95, notifyUsageAlert = true } = await chrome.storage.sync.get({ thresholdWarn: 80, thresholdDanger: 95, notifyUsageAlert: true });
  if (!notifyUsageAlert) return;
  const alertThresholds = [thresholdDanger, thresholdWarn];

  const { usageAlertState = {} } = await new Promise((resolve) =>
    chrome.storage.local.get({ usageAlertState: {} }, resolve)
  );

  // Check 5h and 7d separately
  const checks = [
    { key: '5h', util: snapshot.five_hour.utilization, i18nKey: 'alert_5h' },
    { key: '7d', util: snapshot.seven_day.utilization, i18nKey: 'alert_7d' },
  ];

  for (const { key, util, i18nKey } of checks) {
    if (util === null) continue;

    for (const threshold of alertThresholds) {
      const stateKey = `${key}_${threshold}`;
      const alreadyNotified = usageAlertState[stateKey];

      if (util >= threshold && !alreadyNotified) {
        chrome.notifications.create(`${NOTIF_ID_ALERT}-${stateKey}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: await bt('alert_title', threshold),
          message: await bt(i18nKey, util.toFixed(1)),
          priority: threshold >= thresholdDanger ? 2 : 1,
        });
        usageAlertState[stateKey] = true;
      } else if (util < threshold - 10 && alreadyNotified) {
        usageAlertState[stateKey] = false;
      }
    }
  }

  await chrome.storage.local.set({ usageAlertState });
}

// === Weekly usage report ===
// Schedule alarm for every Monday at 09:00
export async function scheduleWeeklyReport() {
  const existing = await chrome.alarms.get(ALARM_WEEKLY_REPORT);
  if (existing) return; // Already scheduled

  // Calculate next Monday 09:00
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...
  // If before Monday 09:00, use today; otherwise next Monday
  let daysUntilMonday;
  if (dayOfWeek === 1 && now.getHours() < 9) {
    daysUntilMonday = 0; // Today is Monday, still before 09:00
  } else {
    daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 7 : (8 - dayOfWeek);
  }
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + daysUntilMonday);
  nextMonday.setHours(9, 0, 0, 0);

  const delayMs = nextMonday.getTime() - Date.now();
  chrome.alarms.create(ALARM_WEEKLY_REPORT, {
    delayInMinutes: delayMs / 60000,
    periodInMinutes: 7 * 24 * 60, // Repeat weekly
  });
  console.log(`[Claude Tuner] Weekly report scheduled for ${nextMonday.toISOString()}`);
}

export async function sendWeeklyReport() {
  const { notifyWeeklyReport = true } = await chrome.storage.sync.get({ notifyWeeklyReport: true });
  if (!notifyWeeklyReport) return;

  const { usageHistory = [] } = await new Promise((resolve) =>
    chrome.storage.local.get({ usageHistory: [] }, resolve)
  );

  if (usageHistory.length < 10) return;

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekData = usageHistory.filter((p) => p.t > weekAgo);
  if (weekData.length < 5) return;

  const d7vals = weekData.map((p) => p.d7).filter((v) => v !== null);
  const h5vals = weekData.map((p) => p.h5).filter((v) => v !== null);

  const avg7d = d7vals.length > 0 ? d7vals.reduce((a, b) => a + b, 0) / d7vals.length : 0;
  const peak7d = d7vals.length > 0 ? Math.max(...d7vals) : 0;
  const avg5h = h5vals.length > 0 ? h5vals.reduce((a, b) => a + b, 0) / h5vals.length : 0;
  const peak5h = h5vals.length > 0 ? Math.max(...h5vals) : 0;

  chrome.notifications.create('weekly-report-' + Date.now(), {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: await bt('weekly_title'),
    message: `7d avg ${avg7d.toFixed(1)}% (peak ${peak7d.toFixed(0)}%) · 5h avg ${avg5h.toFixed(1)}% (peak ${peak5h.toFixed(0)}%)`,
    priority: 0,
  });
}
