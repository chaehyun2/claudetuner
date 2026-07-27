import { ACTIONABLE_ERRORS, NOTIF_ID_ALERT, ALARM_WEEKLY_REPORT } from './constants.js';
import { bt, bgLang } from './i18n.js';
import { getLastStatus } from './storage.js';

const NOTIF_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Log a notification event for analytics (used to understand blocking reasons).
 * Stores {category, ts} entries in chrome.storage.local, pruned to 30 days.
 */
export async function logNotification(category) {
  const { _notifLog = [] } = await chrome.storage.local.get({ _notifLog: [] });
  const now = Date.now();
  const cutoff = now - NOTIF_LOG_MAX_AGE_MS;
  const pruned = _notifLog.filter(e => e.ts > cutoff);
  pruned.push({ c: category, ts: now });
  await chrome.storage.local.set({ _notifLog: pruned });
}

/**
 * Server sync blocked (email-provider guard 401) — fire ONCE per block episode.
 *
 * Why a notification at all: the popup CTA (and the Google one-click beside it) only reach a user
 * who opens the popup, and this extension is built to run unattended. Real accounts stayed broken
 * for days without noticing (2026-07-27); email reached them only because we had their address.
 * The badge is the persistent signal, this is the one-time interrupt that makes them look at it.
 *
 * Deliberately NOT escalating like checkCollectFailNotification: repeating this would be nagging
 * about something only the user can fix, and the badge already persists until they do.
 *
 * Callers: the false→true edge in background.js AND a service-worker-wake catch-up there, because
 * an edge alone misses installs that were already blocked before this shipped. Both are safe to
 * call repeatedly — the marker below is what enforces "once".
 */
export async function notifyAuthBlockedOnce() {
  // Episode marker, not an edge. onChanged fires only on a CHANGE, so an install that was ALREADY
  // blocked before this build shipped would never be told — and that is exactly the population
  // this exists for (PR #682 set the flag; the notification only shipped after). The marker makes
  // the call idempotent across service-worker wakes and is cleared on recovery, so a later block
  // notifies again. (Codex HIGH.)
  // 🔴 Re-read `authBlocked`, do not trust the caller's. Two independent event sources race here:
  // the service-worker-wake catch-up (which read the flag before awaiting) and the dashboard's
  // RECOVER_EXT_TOKEN, which clears the flag, the notification and the marker. Without this the
  // catch-up can announce a problem that was fixed a moment ago — and worse, re-set the marker
  // afterwards, swallowing the notification for the NEXT real block. (Codex integration review.)
  const { authBlockedNotifiedAt, authBlocked } = await chrome.storage.local.get([
    'authBlockedNotifiedAt', 'authBlocked',
  ]);
  if (authBlockedNotifiedAt) return;
  if (authBlocked !== true) return; // recovered between the caller's read and now
  // 🔴 Mark ONLY after creation is CONFIRMED. Reordering the calls was not enough (first attempt):
  // create() is callback-based, so setting the marker on the next line still records "notified"
  // for a call that may have failed — a revoked notifications permission, an OS-level block. The
  // marker is what suppresses retries, so a stranded one means the user is never told at all.
  // Awaiting the callback and bailing on lastError leaves the marker unset, and the
  // service-worker-wake catch-up in background.js simply tries again. (Codex review ×2.)
  const opts = {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: await bt('authblocked_title'),
    message: await bt('authblocked_msg'),
    priority: 2,
    buttons: [{ title: await bt('authblocked_btn') }],
  };
  const created = await new Promise((resolve) => {
    chrome.notifications.create('auth-blocked', opts, (id) => resolve(chrome.runtime.lastError ? null : id));
  });
  if (!created) return; // no marker → the next wake retries
  // Check again: awaiting bt() and create() leaves a window for recovery to land. Marking now
  // would strand a marker for an episode that is over, and the notification we just created is
  // already wrong — clear it rather than leave a fixed problem on screen.
  const { authBlocked: stillBlocked } = await chrome.storage.local.get('authBlocked');
  if (stillBlocked !== true) {
    chrome.notifications.clear('auth-blocked');
    return;
  }
  await chrome.storage.local.set({ authBlockedNotifiedAt: Date.now() });
  logNotification('auth-blocked');
}

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
      logNotification('collect-fail');
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
  const FIRST_DELAY = isActionable ? 10 * 60 * 1000 : 15 * 60 * 1000; // 10min / 15min
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
  logNotification('collect-fail');

  collectFailState.stage = targetStage;
  collectFailState.lastErrorCode = errorMsg;
  collectFailState.hasActionableError = isActionable;
  await chrome.storage.local.set({ collectFailState });
}

// === Usage threshold alerts ===
export async function checkUsageAlerts(snapshot) {
  const { thresholdWarn = 80, thresholdDanger = 95, notifyUsageWarn = false, notifyUsageDanger = true } = await chrome.storage.sync.get({ thresholdWarn: 80, thresholdDanger: 95, notifyUsageWarn: true, notifyUsageDanger: true });
  if (!notifyUsageWarn && !notifyUsageDanger) return;

  const alertThresholds = [];
  if (notifyUsageDanger) alertThresholds.push(thresholdDanger);
  if (notifyUsageWarn) alertThresholds.push(thresholdWarn);

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
          message: await bt(i18nKey, util.toFixed(1)) + '\n' + await bt('notif_settings_hint'),
          buttons: [{ title: await bt('notif_settings_btn') }],
          priority: threshold >= thresholdDanger ? 2 : 1,
        });
        logNotification(threshold >= thresholdDanger ? 'usage-danger' : 'usage-warn');
        usageAlertState[stateKey] = true;
      } else if (util < threshold - 10 && alreadyNotified) {
        usageAlertState[stateKey] = false;
      }
    }
  }

  await chrome.storage.local.set({ usageAlertState });
}

// === Server-signaled push (e.g. Product Hunt launch) ===
// Fires a ONE-TIME OS notification driven by a static CDN signal file. Reuses the
// already-granted `notifications` permission + the same dedup pattern as usage alerts —
// no new permission, no extra infra. IMPORTANT: the signal is a plain R2/CDN object
// (cdn.claudetuner.com, ACAO:*), NOT a Worker route — polling it never wakes the Worker
// (mirrors the announcements.json CDN migration). Each signal carries its own [start,end)
// window, so the push fires client-side at launch time without any cron/DB flip. Throttled
// to ~1 fetch / 10 min and best-effort (a failure never disrupts the collection cycle).
const PROMO_PUSH_URL = 'https://cdn.claudetuner.com/push.json';
const PROMO_PUSH_THROTTLE_MS = 10 * 60 * 1000;

export async function checkPromoPush() {
  try {
    const now = Date.now();
    const { promoPushState = {}, _promoPushCheckedAt = 0 } = await chrome.storage.local.get({
      promoPushState: {}, _promoPushCheckedAt: 0,
    });
    if (now - _promoPushCheckedAt < PROMO_PUSH_THROTTLE_MS) return;
    await chrome.storage.local.set({ _promoPushCheckedAt: now });

    const res = await fetch(PROMO_PUSH_URL); // pure CDN object — does NOT invoke the Worker
    if (!res.ok) return;
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data ? [data] : []);

    const lang = await bgLang();
    for (const p of list) {
      if (!p || !p.id || promoPushState[p.id]) continue; // fire once per id (survives SW restart)
      const start = p.start ? Date.parse(p.start) : 0;
      const end = p.end ? Date.parse(p.end) : Infinity;
      if (!(now >= start && now < end)) continue; // only within the signal's window
      const loc = p[lang] || p.en || p; // localized block, fallback to en / flat shape
      const url = /^https?:\/\//i.test(loc.url || '') ? loc.url : '';
      const notifId = 'promo-push-' + p.id;
      // Display lifetime (admin-controlled). `ttlSec` > 0: keep it visible for ~N seconds then
      // auto-dismiss via a chrome.alarm (survives SW suspension; ~60s practical minimum in MV3,
      // sub-30s is unreliable). Without ttlSec, `sticky` decides: true (default) stays until the
      // user acts, false lets the OS auto-hide it after a few seconds.
      const ttlSec = Number(p.ttlSec) > 0 ? Number(p.ttlSec) : 0;
      // Persist url + dedup BEFORE showing so a click always resolves the url even if the SW is
      // interrupted right after create(). Await create() and roll the dedup back if it actually
      // throws, so a failed notification isn't permanently deduped (retries next cycle).
      promoPushState[p.id] = { url };
      await chrome.storage.local.set({ promoPushState });
      try {
        await chrome.notifications.create(notifId, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: loc.title || 'Claude Tuner',
          message: loc.body || loc.title || '',
          buttons: url ? [{ title: await bt('promo_push_btn') }] : [],
          priority: 2,
          // Hold it on screen for the ttl window (or until the user acts when sticky) rather than
          // letting the OS auto-hide it after a few seconds.
          requireInteraction: ttlSec > 0 ? true : (p.sticky !== false),
        });
      } catch (e) {
        delete promoPushState[p.id]; // create failed → allow a retry on a later cycle
        await chrome.storage.local.set({ promoPushState });
        continue;
      }
      if (ttlSec > 0) {
        // chrome.alarms clamps to ~1-min minimum granularity; it fires even if the SW slept.
        chrome.alarms.create('promopushclear:' + notifId, { delayInMinutes: Math.max(ttlSec, 60) / 60 });
      }
      logNotification('promo-push');
    }
  } catch (e) {
    // best-effort: a push failure must never disrupt the collection cycle
  }
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
    message: `7d avg ${avg7d.toFixed(1)}% (peak ${peak7d.toFixed(0)}%) · 5h avg ${avg5h.toFixed(1)}% (peak ${peak5h.toFixed(0)}%)\n${await bt('notif_settings_hint')}`,
    buttons: [{ title: await bt('notif_settings_btn') }],
    priority: 0,
  });
  logNotification('weekly-report');
}
