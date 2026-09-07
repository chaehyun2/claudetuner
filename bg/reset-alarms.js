// Reset-window resolution and the expiry alarms the reset notifications ride on.
// Moved verbatim out of background.js (#1126); only the `export` keywords and these imports are new.
import { getSelectedOrgUsage } from './badge.js';
import { ALARM_EXPIRE_PREFIX, PROVIDER_LABELS } from './constants.js';
import { bt } from './i18n.js';

// Build a short label like "Claude" or "Claude · Dable Labs" for reset notifications.
// Single-Claude-org users see just the provider name; multi-org / non-Claude users
// get the org name appended so they can tell which account the alarm is for.
async function buildResetContextLabel() {
  const { collectedOrgs = [] } = await chrome.storage.local.get({ collectedOrgs: [] });
  if (!collectedOrgs.length) return null;
  const primary = collectedOrgs.find(o => o.isPrimary) || collectedOrgs[0];
  const provider = primary.provider || 'claude';
  const providerName = PROVIDER_LABELS[provider] || provider;
  if (collectedOrgs.length === 1 && provider === 'claude') return providerName;
  const orgName = (primary.name || '').trim();
  return orgName ? `${providerName} · ${orgName}` : providerName;
}

export async function getResetNotifContext() {
  const { _resetNotifContext = null } = await chrome.storage.local.get('_resetNotifContext');
  return _resetNotifContext;
}

/**
 * What a reset alarm key is ABOUT, as a label and a percentage (#1134).
 *
 * `5h`/`7d` are fixed windows and their wording is static. `design`/`sonnet` are slots holding
 * whichever model-scoped weekly limits the account has, so their label lives in the snapshot and
 * is stashed by scheduleExpireAlarms(). A scoped key with nothing stashed returns null — the
 * caller must then say NOTHING rather than fall back to the 7-day wording, which is the
 * indistinguishable message this exists to remove.
 *
 * @returns {{label: string, util: number|null}|null}
 */
export async function resolveResetWindow(key) {
  if (key === '5h' || key === '7d') {
    return {
      label: await bt(key === '5h' ? 'win_5h' : 'win_7d'),
      util: await getCurrentUsageForWindow(key),
    };
  }
  const { _resetNotifScoped = {} } = await chrome.storage.local.get({ _resetNotifScoped: {} });
  const slot = _resetNotifScoped && typeof _resetNotifScoped === 'object' ? _resetNotifScoped[key] : null;
  // 🔴 STORAGE IS NOT A TYPE SYSTEM (the rule the auth ladder already states). The writer stores a
  // trimmed string, but this value crosses a persistence boundary that outlives the build that
  // wrote it: a shape change in either direction — an older worker reading a newer stash mid-
  // update, or the reverse — lands here. A truthiness check would then put whatever it found into
  // the title, so `{ model: 123 }` renders "123 weekly" and an object renders "[object Object]
  // weekly" (Codex FOLLOW-UP). Anything that is not a usable name means the same thing an absent
  // slot means: we cannot say which limit this is, so we say nothing.
  const model = slot && typeof slot === 'object' && typeof slot.model === 'string' ? slot.model.trim() : '';
  if (!model) return null;
  // "Opus 주간" / "Opus weekly" — the model name alone would read as a model, not a limit window.
  return {
    label: await bt('win_scoped', model),
    util: (typeof slot.util === 'number' && isFinite(slot.util)) ? Math.round(slot.util) : null,
  };
}

// Read current utilization (%) for the primary org and given window ('5h' | '7d').
// Returns null if no primary org or value isn't a number.
async function getCurrentUsageForWindow(windowKey) {
  const { collectedOrgs = [] } = await chrome.storage.local.get({ collectedOrgs: [] });
  if (!collectedOrgs.length) return null;
  const primary = collectedOrgs.find(o => o.isPrimary) || collectedOrgs[0];
  const val = windowKey === '5h' ? primary.h5 : primary.d7;
  return (typeof val === 'number' && isFinite(val)) ? Math.round(val) : null;
}

// Schedule additional collection alarms based on expire times
// Collect at 2min before, 1min before, and at resets_at
export async function scheduleExpireAlarms(snapshot) {
  if (!snapshot) return;

  // NOTE: we intentionally do NOT clear existing expire alarms first. Alarm names
  // are deterministic per (key, suffix), so chrome.alarms.create() overwrites the
  // same alarm when the reset time shifts. Clearing first + the >30s guard below
  // would DELETE an already-scheduled due-soon alarm and then refuse to recreate
  // it (a collection cycle inside the ramp window could thus starve pre1/after).
  // Not clearing lets a due-soon alarm survive and fire. Stale alarms for a reset
  // key that disappeared simply fire once (a harmless collect) and aren't
  // recreated. Combined with the stable per-device jitter below, every reschedule
  // lands each ramp alarm at the same time → idempotent.

  let resetTimes = [];
  if (snapshot.five_hour?.resets_at) resetTimes.push({ key: '5h', time: snapshot.five_hour.resets_at });
  if (snapshot.seven_day?.resets_at) resetTimes.push({ key: '7d', time: snapshot.seven_day.resets_at });
  if (snapshot.seven_day_omelette?.resets_at) resetTimes.push({ key: 'design', time: snapshot.seven_day_omelette.resets_at });
  if (snapshot.seven_day_sonnet?.resets_at) resetTimes.push({ key: 'sonnet', time: snapshot.seven_day_sonnet.resets_at });

  // If a non-Claude org is selected, use its reset times for notifications
  const selectedUsage = await getSelectedOrgUsage();
  if (selectedUsage && selectedUsage.provider !== 'claude') {
    if (selectedUsage.resetsAt5h) {
      resetTimes = resetTimes.filter(r => r.key !== '5h');
      resetTimes.push({ key: '5h', time: selectedUsage.resetsAt5h });
    }
    if (selectedUsage.resetsAt7d) {
      resetTimes = resetTimes.filter(r => r.key !== '7d');
      resetTimes.push({ key: '7d', time: selectedUsage.resetsAt7d });
    }
  }

  const now = Date.now();
  // Ramp trimmed to peak + drop. The server's 60min unchanged-usage dedup
  // already collapses the redundant steps: for a plateaued user, pre2/pre1/at
  // land identical pre-reset values and only the post-reset drop survives
  // (2026-06-17 data: e.g. 100→100→100→0). pre2 and 'at' were therefore dropped —
  // pre1 captures the pre-reset peak, 'after' the post-reset drop — which also
  // halves the synchronized top-of-hour POST volume the deduped steps still cost.
  const offsets = [
    { suffix: 'notify5', minutes: -5 }, // Notification 5min before
    { suffix: 'pre1', minutes: -1 },    // Collect 1min before (peak)
    { suffix: 'after', minutes: 2 },    // Collect + notify 2min after reset (drop)
  ];

  // De-sync the fleet: reset times are clock-aligned (7d all at :00, 5h at :X0),
  // so without jitter every device's collect alarms fire at the same wall-clock
  // minute → a ~40% top-of-hour write spike on the single-writer D1 (2026-06-17).
  // Use a STABLE per-device jitter fraction (generated once, persisted): the same
  // device always shifts by the same amount → reschedules land each alarm at the
  // SAME time (idempotent, no starvation), while different devices get different
  // offsets → the cohort spreads across ~90s. Apply it DIRECTIONALLY — pre-reset
  // alarms shift EARLIER and post-reset alarms shift LATER — so a jittered 'pre1'
  // never crosses the reset (still captures the peak) and 'after' never fires
  // before the reset (still captures the drop).
  let { ct_jitter_offset: jf } = await chrome.storage.local.get('ct_jitter_offset');
  if (typeof jf !== 'number' || jf < 0 || jf > 1) {
    jf = Math.random();
    await chrome.storage.local.set({ ct_jitter_offset: jf });
  }
  const jitterMag = jf * 90 * 1000; // stable 0..90s for this device

  let scheduled = 0;
  for (const { key, time } of resetTimes) {
    const expireMs = new Date(time).getTime();
    if (isNaN(expireMs)) continue;

    for (const { suffix, minutes } of offsets) {
      // pre-reset (minutes <= 0) shifts earlier, post-reset shifts later
      const dirJitter = minutes <= 0 ? -jitterMag : jitterMag;
      const triggerMs = expireMs + minutes * 60 * 1000 + dirJitter;
      const delayMs = triggerMs - now;

      // Only schedule if in the future and more than 30 seconds away
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

  // Stash provider/org context so the alarm-fire notification can show it.
  const ctxLabel = await buildResetContextLabel();
  // ...and WHICH LIMIT each scoped key is, which only the snapshot knows (#1134).
  //
  // 🔴 `design` and `sonnet` are not windows, they are SLOTS. resolveScopedWeeklySlots() assigns
  // whichever model-scoped weekly limits the account has (`limits[].scope.model.display_name`) to
  // two fixed slots, so the same key means "Opus" on one account and "Fable" on another — and can
  // change under one account. The alarm handler sees only the alarm NAME, so without this it fell
  // back to the generic 7-day wording and printed the SAME sentence for `7d`, `design` and
  // `sonnet`: three different limits, one indistinguishable message.
  //
  // The utilisation rides along for the same reason. `getCurrentUsageForWindow()` reads the
  // primary org's `d7`, which is the OVERALL weekly figure — so a notification about the Opus
  // limit opened with the account's total weekly percentage. Wrong number, stated confidently.
  //
  // Written from the same snapshot that scheduled the alarms, so the label and the reset time it
  // describes always come from one observation.
  const scoped = {};
  for (const [key, slot] of [['design', snapshot.seven_day_omelette], ['sonnet', snapshot.seven_day_sonnet]]) {
    // No model name → we cannot say which limit this is. Recorded as absent, and the notification
    // is skipped rather than worded generically: an unnameable limit's card is indistinguishable
    // from the real 7-day one, which is the defect, not a lesser version of it. Collection alarms
    // are unaffected — only the two notification alarms go quiet.
    if (!slot || typeof slot.model !== 'string' || !slot.model.trim()) continue;
    scoped[key] = {
      model: slot.model.trim().slice(0, 40),
      util: (typeof slot.utilization === 'number' && isFinite(slot.utilization)) ? slot.utilization : null,
    };
  }
  await chrome.storage.local.set({ _resetNotifContext: ctxLabel || null, _resetNotifScoped: scoped });
}
