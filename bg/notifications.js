import { ACTIONABLE_ERRORS, NOTIF_ID_ALERT, NOTIF_ID_OPTIMIZE, ALARM_WEEKLY_REPORT, PROVIDER_LABELS, PROVIDER_ORDER, DEFAULT_SERVER_URL } from './constants.js';
import { bt, bgLang } from './i18n.js';
import { getLastStatus } from './storage.js';

/**
 * The services this install actually collects, as "Claude/ChatGPT/Gemini", for the auth-blocked
 * copy's "this is not your X login" clause.
 *
 * Naming only what the user has is the point: telling a ChatGPT-only user that this is "separate
 * from your Claude login" is noise about a product they do not use, and it makes the sentence look
 * like it was written for somebody else.
 *
 * 🔴 Falls back to ALL THREE when nothing is detected, never to a guess. The clause exists to
 * dissolve a specific confusion ("I just signed in, what is this?"), so naming the wrong service
 * is strictly worse than naming a superset — the superset is still true.
 *
 * `collectedOrgs` is written by LOCAL collection, which keeps running while authBlocked is set
 * (only the server POST is withheld) — but it is NOT guaranteed to be filled when stage 1 fires.
 * `authBlocked` is raised from the POST response (bg/storage.js) while the provider collectors
 * merge into `collectedOrgs` only after they return, so a first-ever block can land on an empty
 * array. That is not a bug to fix here; it is why the fallback exists. (Codex: an earlier version
 * of this comment claimed the ordering as a guarantee, which was false.)
 */
async function collectedProviderLabels() {
  const { collectedOrgs = [] } = await chrome.storage.local.get({ collectedOrgs: [] });
  // Claude orgs may omit `provider` — same default the popup's chips use.
  const seen = [...new Set((collectedOrgs || []).map((o) => o?.provider || 'claude'))];
  // Known services first, in canonical order; anything unrecognised follows under its raw value.
  // Dropping a provider we have no label for would make the sentence quietly WRONG for whoever
  // uses it — a bare slug is a smaller error than an omission. (Same choice popup.js's cap-drop
  // banner already made with `labels[o.provider] || o.provider`.)
  const known = PROVIDER_ORDER.filter((p) => seen.includes(p));
  const rest = seen.filter((p) => !PROVIDER_ORDER.includes(p));
  const present = [...known, ...rest];
  return (present.length ? present : PROVIDER_ORDER).map((p) => PROVIDER_LABELS[p] || p).join('/');
}

const NOTIF_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// === Notification budget ===
//
// WHY THIS EXISTS
// ---------------
// Every producer in this file rate-limits itself and none of them can see the others. A user can
// be interrupted by a usage threshold, a collection failure, a weekly report and a promo on the
// same day while each producer considers itself well-behaved. Re-engagement nudges are about to
// be added on top of that, and nudges are the class users forgive least.
//
// The rule is deliberately ONE-DIRECTIONAL: a nudge fires only when nothing else has fired in the
// last 24h. Urgent notifications (usage thresholds, collection failures, the first auth-blocked
// interrupt) are never gated — they push nudges out of the day, never the reverse. That ordering
// is what makes this safe to ship without first measuring the existing notification volume, which
// is not measurable from the server anyway: `_notifLog` never leaves the device. There is no path
// in which a threshold alert loses to a nudge.
//
// Deliberately NOT budgeted: `weekly-report`. Budgeting it would silently delete the weekly report
// for exactly the users who get frequent usage alerts — the heaviest, most engaged ones — which is
// a regression dressed up as politeness. Existing notifications are each already rate-limited and
// each already has a user toggle; making them compete with each other is a different decision than
// keeping nudges cheap.
//
// Storage cost is zero: `_notifLog` already records every notification with 30-day retention. This
// only adds a reader, plus a lock so concurrent producers stop losing each other's writes.
const NOTIF_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
const NUDGE_QUIET_START_HOUR = 22; // local time; nudges only
const NUDGE_QUIET_END_HOUR = 8;

// The nudge class — everything here is deferrable by definition. A category that represents
// something BROKEN does not belong in this set, because being suppressed would hide a real fault.
export const NUDGE_CATEGORIES = new Set(['promo-push', 'auth-blocked-followup', 'dash-nudge']);

// Serialises read-modify-write on `_notifLog`. Without this the log loses entries: every producer
// calls logNotification() without awaiting it, so two notifications a tick apart both read the old
// array and the second write erases the first. That was survivable while the log was write-only
// analytics; the moment a budget READS it, a lost entry becomes a nudge that fires when it should
// not have. One MV3 service worker instance exists at a time, so module-level serialisation covers
// every real interleaving, and the storage read happens inside the lock so a worker restart mid-
// chain is harmless.
let _notifLogChain = Promise.resolve();
function withNotifLogLock(fn) {
  // .then(fn, fn) so one rejected turn cannot wedge the chain for the rest of the worker's life.
  const result = _notifLogChain.then(fn, fn);
  _notifLogChain = result.then(() => {}, () => {});
  return result;
}

async function readNotifLog(now) {
  const { _notifLog = [] } = await chrome.storage.local.get({ _notifLog: [] });
  const cutoff = now - NOTIF_LOG_MAX_AGE_MS;
  return _notifLog.filter((e) => e && typeof e.ts === 'number' && e.ts > cutoff);
}

function inNudgeQuietHours(now) {
  const h = new Date(now).getHours(); // device-local, same basis the notices feed already uses
  return h >= NUDGE_QUIET_START_HOUR || h < NUDGE_QUIET_END_HOUR;
}

/**
 * Log a notification event for analytics (used to understand blocking reasons).
 * Stores {category, ts} entries in chrome.storage.local, pruned to 30 days.
 */
export async function logNotification(category) {
  return withNotifLogLock(async () => {
    const now = Date.now();
    const pruned = await readNotifLog(now);
    pruned.push({ c: category, ts: now });
    await chrome.storage.local.set({ _notifLog: pruned });
  });
}

// === Notification volume telemetry (AE) ===
//
// The local `_notifLog` above is the nudge BUDGET's ledger — it never leaves the browser, so
// "how many notifications does the fleet actually send, of which kind" had no answer short of
// reading the code. That is not a hypothetical gap: an uninstall reading "알림이 너무 많이 와요",
// from an account with all eight toggles already off, took a manual code audit to explain.
//
// Counters, not events: reset alerts alone are ~4-5/day/user, so per-notification POSTs would be
// pure waste. These accumulate locally and ride the ad-counter flush alarm (background.js), which
// means zero additional requests. Same subtract-on-success discipline as the ad path — see
// flushNotifCounters.
const NOTIF_COUNTERS_KEY = '__ct_notif_counters'; // { category: { sent, clk } }
const NOTIF_CATEGORY_MAX_LEN = 32;  // matches the worker's blob12 slice

// Serialize read-modify-write. Two notifications a tick apart otherwise both read the old object
// and the second write loses the first — the same race withNotifLogLock exists for.
let _notifOpChain = Promise.resolve();
function _notifEnqueue(fn) { _notifOpChain = _notifOpChain.then(fn).catch(() => {}); return _notifOpChain; }

/**
 * Adjust a category counter. `kind` is 'sent' or 'clk'; `by` is -1 only for releaseNudgeSlot,
 * which hands back a claim whose create() failed. Fire-and-forget.
 *
 * Never lets a counter go negative: a decrement can outlive the flush that already sent its
 * increment, and a negative would then be subtracted from a LATER flush's real count.
 */
export function bumpNotifCounter(rawCategory, kind, by = 1) {
  if (typeof rawCategory !== 'string' || !rawCategory) return;
  // Clamped to the same 32 chars the worker's blob keeps. Today every caller passes a short
  // literal, so this changes nothing — it is here so that stays true by construction rather than
  // by inspection. An interpolated category (`usage-${orgName}`) would otherwise inflate both the
  // flush body and AE's cardinality, and the flush would find out by being silently dropped.
  const category = rawCategory.slice(0, NOTIF_CATEGORY_MAX_LEN);
  return _notifEnqueue(async () => {
    const store = (await chrome.storage.local.get(NOTIF_COUNTERS_KEY))[NOTIF_COUNTERS_KEY] || {};
    const cur = store[category] || { sent: 0, clk: 0 };
    cur[kind] = Math.max(0, (cur[kind] || 0) + by);
    store[category] = cur;
    await chrome.storage.local.set({ [NOTIF_COUNTERS_KEY]: store });
  });
}

// Notification ID -> the category logNotification() recorded for it. Clicks arrive with only the
// id, so without this the click stream could not be joined to the sent stream and a CTR would be
// impossible. Prefix-matched because most ids carry a timestamp or entity id.
//
// 🔴 Every id built by a chrome.notifications.create() call must appear here, or its clicks land
// in 'other' and that category's CTR silently reads as zero. test/notif-telemetry-guard.mjs pins
// this against the real create() call sites.
export function notifCategoryFromId(notifId) {
  const id = String(notifId || '');
  if (id.startsWith('auth-blocked-r')) return 'auth-blocked-followup';
  if (id === 'auth-blocked') return 'auth-blocked';
  if (id.startsWith('plan-order-')) return 'plan-order';
  if (id.startsWith('promo-push-')) return 'promo-push';
  if (id.startsWith('collect-fail')) return 'collect-fail';
  if (id.startsWith('reset-soon-')) return 'reset-soon';
  if (id.startsWith('reset-done-')) return 'reset-done';
  if (id.startsWith('weekly-report-')) return 'weekly-report';
  // Severity-qualified first: these must return the SAME category the send recorded, or the two
  // streams land in different buckets and every CTR built on them is wrong.
  // Pre-1.29.28 ids carried no severity. They can still be clicked from the tray after an update,
  // and there is no way to tell which category sent them — so they get their own bucket instead
  // of being guessed into one and quietly skewing its CTR.
  if (id.startsWith(`${NOTIF_ID_ALERT}-danger-`)) return 'usage-danger';
  if (id.startsWith(`${NOTIF_ID_ALERT}-warn-`)) return 'usage-warn';
  if (id.startsWith(NOTIF_ID_ALERT)) return 'usage-alert-legacy';
  if (id === NOTIF_ID_OPTIMIZE) return 'plan-change';
  return 'other';
}

/**
 * Create a notification and count it as sent ONLY once the browser confirms it.
 *
 * The counter used to ride logNotification(), which every caller invokes whether or not
 * create() succeeded — so an install with notifications blocked at the OS level reported a full
 * stream of sends that never reached a screen (Codex). That is not a rounding error: it
 * systematically over-counts exactly the population whose notifications do not work, which is
 * the opposite of what a "are we sending too many?" number is for.
 *
 * logNotification() is intentionally left where each caller already had it: it feeds the nudge
 * BUDGET, and changing when the budget is spent is a behaviour change, not a measurement one.
 * Only the counter moved.
 *
 * 🔴 Callers must NOT await this, and none do. The raw create() it replaces was fire-and-forget,
 * so awaiting pushes the dedup write that follows it (`usageAlertState[stateKey] = true`,
 * `collectFailState.stage = …`) behind an async boundary — and a service worker torn down in that
 * window leaves the notification shown but unmarked, re-firing it next cycle. Adding duplicate
 * notifications while measuring notification volume would be its own punchline. The returned
 * promise is for tests, not for sequencing.
 */
export function createCountedNotification(notifId, opts, category, supersedes) {
  return new Promise((resolve) => {
    chrome.notifications.create(notifId, opts, (id) => {
      if (chrome.runtime.lastError || !id) { resolve(null); return; }
      bumpNotifCounter(category, 'sent');
      // 🔴 REPLACE, NEVER JUST REMOVE (#1132, Codex DEPLOY-BLOCKER). The superseded cards are
      // dropped only once the browser has CONFIRMED the successor exists. Clearing first looked
      // equivalent and is not: create() can fail (revoked permission, OS-level block), and the
      // callers cannot retry — collect-fail has already advanced its stage, the usage alert has
      // already written `usageAlertState[stateKey] = true`. The user would be left with neither
      // the old card nor the new one, having previously had a visible warning.
      //
      // It lives HERE rather than at the call sites so the ordering cannot be got wrong by the
      // next person to add a family: passing the list is the only way to express superseding.
      if (supersedes && supersedes.length) clearSupersededNotifications(supersedes);
      resolve(id);
    });
  });
}

/**
 * Drop the notifications a new one REPLACES (#1132).
 *
 * Chrome only substitutes automatically when the id is identical, and several of our families
 * deliberately vary the id so a click can be attributed to the right stage or severity
 * (`auth-blocked-r2` vs `auth-blocked`, `usage-alert-warn-…` vs `usage-alert-danger-…`). Those
 * stages SUPERSEDE each other — "the collection has been down for 24 hours" says everything "…for
 * 4 hours" said — so without this they simply queue up beside one another. On Windows they sit in
 * the notification centre until dismissed by hand, which is how somebody returning from sleep
 * finds five of ours waiting.
 *
 * ⚠️ It costs the superseded notification its chance to be clicked, so a family's CTR is measured
 * against fewer live cards. That is the intended trade: the baseline (2026-08-21..09-03) was
 * 314k sends earning 1,234 clicks — 0.39% — so the cards being removed are cards nobody acted on.
 *
 * Never awaited and never throws: clearing is best-effort housekeeping, and a notification that
 * fails to clear must not stop the new one from being shown.
 */
export function clearSupersededNotifications(ids) {
  for (const id of ids) {
    try { chrome.notifications.clear(id); } catch (e) { /* best effort */ }
  }
}

const NOTIF_EVENT_ENDPOINT = `${DEFAULT_SERVER_URL}/api/event`;
const NOTIF_FLUSH_MAX_ROWS = 50;    // matches the worker's row slice
const NOTIF_FLUSH_MAX_BYTES = 3600; // headroom under the worker's 6144-byte body cap

// Byte-accurate size. Blob is exact for any encoding; str.length is an ASCII-only fallback for
// the (impossible today) case where Blob is unavailable in the service worker.
function _utf8Bytes(str) {
  try { return new Blob([str]).size; } catch { return str.length; }
}

/**
 * Flush accumulated per-category counters to /api/event. Called from the ad-flush alarm
 * (background.js) so notification telemetry adds no request of its own.
 *
 * SUBTRACTS what was actually sent instead of clearing the store: a notification fired while the
 * POST was in flight would otherwise be erased. Same reason the ad flush subtracts. On any
 * failure the counters are left untouched and the next flush retries them — telemetry that
 * silently drops on a blip is worse than telemetry that arrives an hour late.
 */
export function flushNotifCounters() {
  return _notifEnqueue(async () => {
    const store = (await chrome.storage.local.get(NOTIF_COUNTERS_KEY))[NOTIF_COUNTERS_KEY] || {};
    const pending = Object.keys(store).filter((c) => (store[c].sent > 0 || store[c].clk > 0));
    if (!pending.length) return;
    const ver = chrome.runtime.getManifest().version;
    // Accumulate by BYTE BUDGET as well as row count, the same way the ad flush does. The
    // category set is short today and this loop will never trim anything — but the failure it
    // prevents is silent: over the worker's cap the body is dropped while the endpoint still
    // answers 204, and the subtract below would then delete counts that were never recorded.
    // Keys left out stay in the store and drain on the next tick.
    const cats = [];
    const rows = [];
    for (const c of pending) {
      const row = { cat: c, sent: store[c].sent || 0, clk: store[c].clk || 0 };
      const candidate = JSON.stringify({ type: 'notif_batch', ver, rows: rows.concat([row]) });
      // BYTE length, not string length: the worker caps Content-Length, and a non-ASCII category
      // costs up to 3 bytes per char — `.length` could read as under budget while the request is
      // over it, which the worker answers 204 to without parsing, and the subtract below would
      // then delete counts that were never recorded (Codex).
      if (_utf8Bytes(candidate) > NOTIF_FLUSH_MAX_BYTES) {
        if (rows.length) break; // batch full — the rest goes next flush
        continue;               // a lone oversized row: skip rather than force-send and lose it
      }
      rows.push(row);
      cats.push(c);
      if (cats.length >= NOTIF_FLUSH_MAX_ROWS) break;
    }
    if (!rows.length) return;
    let ok = false;
    try {
      // text/plain keeps this a CORS simple request (no preflight), matching the ad beacon.
      const r = await fetch(NOTIF_EVENT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ type: 'notif_batch', ver, rows }),
        keepalive: true,
      });
      ok = r.ok || r.status === 204;
    } catch { ok = false; }
    if (!ok) return; // leave counters intact; retry next flush
    const cur = (await chrome.storage.local.get(NOTIF_COUNTERS_KEY))[NOTIF_COUNTERS_KEY] || {};
    for (const c of cats) {
      if (!cur[c]) continue;
      cur[c].sent -= store[c].sent || 0;
      cur[c].clk -= store[c].clk || 0;
      if (cur[c].sent <= 0 && cur[c].clk <= 0) delete cur[c];
    }
    await chrome.storage.local.set({ [NOTIF_COUNTERS_KEY]: cur });
  });
}

/**
 * Ask for permission to interrupt the user with a NUDGE. Records the slot on success, so callers
 * must NOT also call logNotification() — claiming is the log write.
 *
 * Claim BEFORE chrome.notifications.create(), not after: create() is async, and a check-then-create
 * ordering lets two nudges in the same cycle both observe an unspent budget (checkPromoPush loops
 * over a list, so this is reachable, not theoretical). If create() then fails, release the slot.
 *
 * @returns {Promise<{granted: true, ts: number, category: string} | {granted: false, reason: string}>}
 */
export async function claimNudgeSlot(category, now = Date.now()) {
  return withNotifLogLock(async () => {
    if (inNudgeQuietHours(now)) return { granted: false, reason: 'quiet-hours' };
    const log = await readNotifLog(now);
    // ANY category spends the day, not just nudges — that is the one-directional rule.
    if (log.some((e) => e.ts > now - NOTIF_BUDGET_WINDOW_MS)) return { granted: false, reason: 'budget-spent' };
    log.push({ c: category, ts: now });
    await chrome.storage.local.set({ _notifLog: log });
    // The SECOND telemetry chokepoint. Nudge-class notifications (promo-push,
    // auth-blocked-followup) never call logNotification — claiming the slot IS their log write —
    // so counting only there would make exactly the ad-like notifications invisible.
    bumpNotifCounter(category, 'sent');
    return { granted: true, ts: now, category };
  });
}

/**
 * Give back a claimed slot when the notification failed to appear (revoked permission, OS block).
 * Takes the object returned by claimNudgeSlot, not a bare timestamp.
 *
 * Takes `now` from the caller for the same reason claimNudgeSlot does: readNotifLog prunes against
 * it, so releasing on a different clock than the claim can prune the very entry it came to remove,
 * find nothing, and silently leave the day spent for a notification the user never saw.
 *
 * Matches on category AS WELL AS timestamp. A bare ts match can delete a DIFFERENT producer's entry
 * that landed in the same millisecond — which would hand the day back to a nudge on the strength of
 * an urgent notification the user actually saw, quietly inverting the one-directional rule.
 */
export async function releaseNudgeSlot(slot, now = Date.now()) {
  const ts = slot && slot.ts;
  const category = slot && slot.category;
  if (typeof ts !== 'number' || !category) return;
  return withNotifLogLock(async () => {
    const log = await readNotifLog(now);
    const i = log.findIndex((e) => e.ts === ts && e.c === category);
    if (i === -1) return; // already pruned, or never written — nothing to hand back
    log.splice(i, 1);
    await chrome.storage.local.set({ _notifLog: log });
    // Hand the telemetry count back too. The claim counted a notification that create() then
    // failed to produce; leaving it would report sends that never reached a screen — and this
    // path exists precisely because that failure is real (revoked permission, OS block).
    bumpNotifCounter(category, 'sent', -1);
  });
}

/**
 * Server sync blocked (email-provider guard 401) — fire ONCE per block episode.
 *
 * Why a notification at all: the popup CTA (and the Google one-click beside it) only reach a user
 * who opens the popup, and this extension is built to run unattended. Real accounts stayed broken
 * for days without noticing (2026-07-27); email reached them only because we had their address.
 * The badge is the persistent signal, this is the one-time interrupt that makes them look at it.
 *
 * ⚠️ THIS COMMENT USED TO SAY "deliberately NOT escalating" AND THE CODE NOW ESCALATES. That is a
 * moved boundary, not a contradiction — read checkAuthBlockedLadder() below before changing either.
 * The original objection stands and is still honoured: repeating *without limit* is nagging about
 * something only the user can fix, and the badge already persists until they do. What changed is
 * that the paragraph above gives the counter-evidence — real accounts stayed broken for DAYS and
 * only email reached them. So the ladder is bounded (4 total), spaced (>=72h), yields to every
 * other notification (nudge budget), and announces its own end. "Once" and "forever" were never
 * the only two options.
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
  // The user's opt-out covers THIS notification too, not just the follow-up ladder. Until now only
  // rungs 2-4 were gated, so someone who turned every toggle off still got this one — and since the
  // episode marker is cleared on recovery (background.js), a block that keeps recurring kept
  // re-announcing itself with no way to stop it. One uninstall said exactly that ("알림이 너무 많이
  // 와요") from an account with all eight toggles already off.
  // 🔴 The storage key still says `Followup` while the setting now governs the whole feature. That
  // mismatch is deliberate: renaming the key would reset it to the default `true` for everyone who
  // had deliberately turned it OFF, i.e. would start notifying exactly the people who asked us not
  // to. The label and description are what changed (i18n `notify_authblock_followup*`).
  const { notifyAuthBlockedFollowup = true } =
    await chrome.storage.sync.get({ notifyAuthBlockedFollowup: true });
  if (!notifyAuthBlockedFollowup) return;
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
    message: await bt('authblocked_msg', await collectedProviderLabels()),
    priority: 2,
    // Stay on screen until the user deals with it. Stage 1 is a FAULT REPORT — data is not reaching
    // the server and only the user can fix it — so a banner that slides away after a few seconds
    // can lose the one moment we get. Deliberately NOT applied to stages 2..4: those are
    // persuasion, and the ladder is allowed to exist only because it is bounded, spaced and
    // yields. A sticky persuasion notification is the nagging that whole design rules out, and
    // rung 4 literally promises to stop.
    // ⚠️ Platform-dependent: honoured on Windows/Linux/ChromeOS; macOS routes through the system
    // notification centre where the effect is limited. Cheap either way, no downside where it is
    // ignored.
    requireInteraction: true,
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
  // Already past the confirmed-create bail-out above, so this needs no wrapper.
  bumpNotifCounter('auth-blocked', 'sent');
}

// === Auth-blocked follow-up ladder (stages 2..4) ===
//
// Stage 1 is notifyAuthBlockedOnce() above and is NEVER budgeted — "your data stopped reaching the
// server" is a fault report, and a fault report must not lose to anything. Stages 2..4 are
// persuasion, so they ride the nudge budget and yield to every other notification.
//
// Days are measured from when the BLOCK started, not from when we last spoke.
const AUTH_LADDER_DAYS = [3, 10, 24];             // stage 2, 3, 4
const AUTH_LADDER_MIN_GAP_MS = 72 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const AUTH_LADDER_LAST_STAGE = 1 + AUTH_LADDER_DAYS.length;
// Every key that describes one block episode. Exported so the recovery branch in background.js
// clears exactly this set — two hand-maintained lists would drift, and a single survivor is enough
// to start the NEXT episode mid-ladder.
export const AUTH_LADDER_KEYS = [
  'authBlockedNotifiedAt', 'authBlockedSince', 'authBlockedStage', 'authBlockedLastNotifiedAt',
];

// Storage is not a type system. A corrupted or hand-edited value must degrade to "start over",
// never to `auth-blocked-rNaN` or a stage that skips the bound.
const asStage = (v) => (Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), AUTH_LADDER_LAST_STAGE) : 1);
const asTime = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Advance the auth-blocked ladder if it is due. Safe to call on every wake and every collect cycle:
 * it costs one storage read when nothing is blocked, and every guard below is idempotent.
 */
export async function checkAuthBlockedLadder(now = Date.now()) {
  const { authBlocked } = await chrome.storage.local.get({ authBlocked: false });
  if (authBlocked !== true) return;                 // recovered → nothing to escalate

  // 🔴 The episode start is its OWN key. Reusing `authBlockedNotifiedAt` would look equivalent and
  // is not: that marker is deliberately left UNSET when stage 1's create() fails (revoked
  // notifications permission, OS-level block — see the comment above it). Deriving the ladder from
  // it would mean the user whose first notification never appeared never gets a second one either
  // — precisely the person the ladder exists for. "When did it break" and "when did we speak" are
  // different facts and need different keys.
  const { authBlockedSince } = await chrome.storage.local.get('authBlockedSince');
  if (!Number.isFinite(authBlockedSince) || authBlockedSince <= 0) {
    // An install already blocked before this shipped has no true start date, so it gets `now`.
    // That UNDERSTATES the outage, which is the safe direction — it delays the ladder rather than
    // firing "last reminder" at someone on their very first wake.
    await chrome.storage.local.set({ authBlockedSince: now });
    return;
  }

  const { notifyAuthBlockedFollowup = true } =
    await chrome.storage.sync.get({ notifyAuthBlockedFollowup: true });
  if (!notifyAuthBlockedFollowup) return;           // opt-out that needs no login (see options page)

  const raw = await chrome.storage.local.get({ authBlockedStage: 1, authBlockedLastNotifiedAt: 0 });
  const authBlockedStage = asStage(raw.authBlockedStage);
  const authBlockedLastNotifiedAt = asTime(raw.authBlockedLastNotifiedAt);
  if (authBlockedStage >= AUTH_LADDER_LAST_STAGE) return;            // ladder spent for this episode
  if ((now - authBlockedSince) / DAY_MS < AUTH_LADDER_DAYS[authBlockedStage - 1]) return;
  // Belt and braces next to the day schedule: if `authBlockedSince` is ever stamped late (an
  // install that recovers and re-blocks quickly), the schedule alone could bunch two stages up.
  if (now - authBlockedLastNotifiedAt < AUTH_LADDER_MIN_GAP_MS) return;

  const stage = authBlockedStage + 1;
  const slot = await claimNudgeSlot('auth-blocked-followup', now);
  // Denied = the user already heard from us today, or it is the middle of their night. Return
  // WITHOUT advancing the stage so this exact step retries on a later wake. The ladder slips; it
  // never skips.
  if (!slot.granted) return;

  const notifId = `auth-blocked-r${stage}`;
  // Rung N replaces every earlier card of the same episode (#1132). The ladder is already bounded
  // at 4 and spaced >=72h, but nothing ever removed a rung once shown, so a 24-day block left FOUR
  // of our notifications sitting in the OS notification centre at once.
  const opts = {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: await bt(`authblock_r${stage}_title`),
    message: await bt(`authblock_r${stage}_msg`),
    priority: 1,                                    // below stage 1: persuasion, not a fault report
    buttons: [{ title: await bt('authblocked_btn') }],
  };
  // 🔴 CONSUME THE RUNG BEFORE create(), NOT AFTER. MV3 kills the worker at any await, and the two
  // orderings fail in opposite directions:
  //   set-after-create  → worker dies with the notification ON SCREEN and the rung unconsumed, so
  //                       the same rung fires again once the budget refreshes. "Bounded at 4"
  //                       silently becomes unbounded — the exact thing this design promises not to
  //                       do, and the reason the old code refused to escalate at all.
  //   set-before-create → worker dies before the notification exists and the rung is spent, so the
  //                       user misses one reminder.
  // For a notification whose entire justification is "bounded, not nagging", a skipped rung is
  // strictly better than a repeated one. (Codex DEPLOY-BLOCKER.)
  const prevStage = authBlockedStage;
  const prevLast = authBlockedLastNotifiedAt;
  await chrome.storage.local.set({ authBlockedStage: stage, authBlockedLastNotifiedAt: now });

  // Undo is recovery-aware on purpose. If the user logged in while we were mid-flight, the recovery
  // branch in background.js may ALREADY have wiped the ladder keys — in which case the reservation
  // above resurrected them, and restoring `prevStage` would leave the next episode starting
  // mid-ladder. For a recovered install the correct state is no ladder keys at all, so undo
  // re-runs the cleanup instead of restoring. (Codex DEPLOY-BLOCKER.)
  const undo = async () => {
    const { authBlocked: nowBlocked } = await chrome.storage.local.get({ authBlocked: false });
    if (nowBlocked === true) {
      await chrome.storage.local.set({ authBlockedStage: prevStage, authBlockedLastNotifiedAt: prevLast });
    } else {
      await chrome.storage.local.remove(AUTH_LADDER_KEYS);
    }
    await releaseNudgeSlot(slot, now);            // nothing was shown → the day is not spent
  };

  const created = await new Promise((resolve) => {
    chrome.notifications.create(notifId, opts, (id) => resolve(chrome.runtime.lastError ? null : id));
  });
  if (!created) { await undo(); return; }

  // Same recovery race as stage 1: awaiting bt() and create() leaves a window for a login to land.
  // Keeping the rung burned would be survivable, but leaving "you're missing 10 days of insights"
  // on screen right after the login that fixed it is not.
  const { authBlocked: stillBlocked } = await chrome.storage.local.get({ authBlocked: false });
  if (stillBlocked !== true) {
    chrome.notifications.clear(notifId);
    await undo();
    return;
  }

  // Only NOW do the earlier cards of this episode go away (#1132). Two orderings were wrong before
  // this one:
  //   clear-then-create → create() fails (revoked permission, OS block) and the user is left with
  //                       NOTHING, having had a sticky `auth-blocked` fault card a moment earlier.
  //                       Stage 1 is a fault report; losing it is strictly worse than a duplicate.
  //   clear rung `stage` → the off-by-one that removes the card just created.
  // 🪤 EARLIER rungs only, r2..r(stage-1) — test/authblock-ladder-guard.mjs caught that mistake.
  clearSupersededNotifications(
    ['auth-blocked', ...Array.from({ length: Math.max(0, stage - 2) }, (_, i) => `auth-blocked-r${i + 2}`)]);
  // No logNotification() — claimNudgeSlot already wrote this notification's log entry.
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
      createCountedNotification('collect-fail-firstrun', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: await bt('cf_firstrun_title'),
        message: await bt('cf_firstrun_msg'),
        priority: 2,
        buttons: [{ title: await bt('cf_btn_open') }],
      }, 'collect-fail');
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

  // The stages of ONE episode: "down for 24 hours" says everything "down for 4 hours" said, so the
  // earlier cards are replaced rather than stacked (#1132). Ids stay distinct because the click
  // attribution needs them; the superseding is explicit instead — and applied only after the
  // successor is confirmed, because this function advances `collectFailState.stage` below and
  // therefore never retries.
  createCountedNotification(notifId, opts, 'collect-fail',
    ['collect-fail-firstrun', 'collect-fail-first', 'collect-fail-reminder', 'collect-fail-final']
      .filter((id) => id !== notifId));
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
        // The severity goes in the ID, not just in the category. Sends record 'usage-danger' or
        // 'usage-warn' (which of the two depends on the user's thresholdDanger setting), but a
        // click arrives carrying only the id — so an id of `usage-alert-5h_95` could not be
        // mapped back to the category that sent it, and a CTR grouped by category showed
        // usage-danger at 0% next to a usage-alert bucket with clicks and no sends (Codex).
        // Encoding it makes the two agree by construction rather than by a lookup that would
        // have to re-read a setting that may have changed since.
        // Still prefixed with NOTIF_ID_ALERT, so background.js's settings-button branch
        // (startsWith(NOTIF_ID_ALERT)) keeps matching.
        const severity = threshold >= thresholdDanger ? 'danger' : 'warn';
        // 🔴 Same WINDOW, higher severity → the warning is superseded, not repeated beside it
        // (#1132). Only in that direction: a warn firing while a danger card is up would be older
        // news, and alertThresholds is ordered danger-first so that cannot happen anyway.
        // Passed as `supersedes` rather than cleared here: `usageAlertState[stateKey] = true` is
        // written below whether or not create() succeeded, so a clear-then-fail would leave the
        // user with neither card and nothing that fires again until utilisation drops 10 points.
        const supersedes = severity === 'danger'
          ? [`${NOTIF_ID_ALERT}-warn-${key}_${thresholdWarn}`]
          : undefined;
        createCountedNotification(`${NOTIF_ID_ALERT}-${severity}-${stateKey}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: await bt('alert_title', threshold),
          message: await bt(i18nKey, util.toFixed(1)) + '\n' + await bt('notif_settings_hint'),
          buttons: [{ title: await bt('notif_settings_btn') }],
          priority: threshold >= thresholdDanger ? 2 : 1,
        }, `usage-${severity}`, supersedes);
        logNotification(`usage-${severity}`);
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

// `now` is injectable so the budget guard can pin the wall clock. Without a seam the quiet-hours
// branch makes this function's behaviour depend on what time the test suite happens to run —
// a guard that passes at noon and fails at midnight is worse than no guard.
export async function checkPromoPush(now = Date.now()) {
  try {
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
      // A promo is a nudge: it yields to anything that already interrupted the user in the last
      // 24h, and never fires in quiet hours. Claim BEFORE writing the dedup — a denied promo must
      // stay un-deduped so it retries on a later cycle while its [start,end) window is still open.
      const slot = await claimNudgeSlot('promo-push', now);
      if (!slot.granted) continue;
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
        await releaseNudgeSlot(slot, now); // nothing was shown → the day is not spent
        continue;
      }
      if (ttlSec > 0) {
        // chrome.alarms clamps to ~1-min minimum granularity; it fires even if the SW slept.
        chrome.alarms.create('promopushclear:' + notifId, { delayInMinutes: Math.max(ttlSec, 60) / 60 });
      }
      // No logNotification() here — claimNudgeSlot already wrote this promo's log entry.
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

  // 🔴 A STABLE id (#1132): last week's report is not information any more, and a unique id per
  // send meant every one of them stayed on screen. The `weekly-report-` prefix is load-bearing —
  // notifCategoryFromId() matches on it.
  createCountedNotification('weekly-report-latest', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: await bt('weekly_title'),
    message: `7d avg ${avg7d.toFixed(1)}% (peak ${peak7d.toFixed(0)}%) · 5h avg ${avg5h.toFixed(1)}% (peak ${peak5h.toFixed(0)}%)\n${await bt('notif_settings_hint')}`,
    buttons: [{ title: await bt('notif_settings_btn') }],
    priority: 0,
  }, 'weekly-report');
  logNotification('weekly-report');
}
