// Shared snapshot send-gating.
//
// Every collector (Claude primary + extra orgs, ChatGPT, Gemini) collects usage
// each poll cycle, but most cycles are unchanged "heartbeats". Sending those to
// the server is wasteful: the server only dedups them via a D1 read, and at
// fleet scale (~10 POST/s) those reads saturate D1 (cf. extra-org-delta-gate).
// This module is the single place that decides "is this snapshot worth POSTing?"
// so all collectors share one delta-gate instead of each reinventing it.

import { ORG_POLL_CHANGE_THRESHOLD, SEND_HEARTBEAT_FLOOR_MS, SEND_MIN_INTERVAL_MS, SERVER_BACKOFF_BASE_MS, SERVER_BACKOFF_CAP_MS } from './constants.js';

// ── Server-failure backoff ──────────────────────────────────────────────────
// Global (not per-org) because a 5xx means the shared server/D1 is unhealthy, so
// every collector should back off together rather than each hammering it. Set by
// the POST paths on 5xx/network failure, cleared on the next confirmed success.
const SERVER_BACKOFF_KEY = '_serverBackoff';

// Serialize all read-modify-write of _serverBackoff. Multiple collectors (primary
// + extra orgs + providers) can POST concurrently in one service-worker cycle, so
// without this two failures could both read fails=0 and both write fails=1, losing
// the exponential escalation (or a success/failure could interleave). A module-level
// promise chain runs the mutations one at a time within this SW instance.
let _backoffMutex = Promise.resolve();
function withBackoffLock(fn) {
  const run = _backoffMutex.then(fn, fn);
  _backoffMutex = run.then(() => {}, () => {});
  return run;
}

/** True while we're inside a server-failure backoff window — callers skip the POST. */
export async function isServerBackedOff(now = Date.now()) {
  const { [SERVER_BACKOFF_KEY]: b } = await chrome.storage.local.get({ [SERVER_BACKOFF_KEY]: null });
  return !!(b && b.until && now < b.until);
}

/**
 * Record a transient server failure (5xx / network) and extend the backoff.
 * Exponential on CONSECUTIVE failures: BASE, 2×, 4×, … capped at CAP. The FIRST
 * failure is exactly BASE (no jitter) so a one-off blip behaves like today's
 * next-tick retry; escalated waits get ±15% jitter so the fleet doesn't resume in
 * lockstep. Serialized via withBackoffLock so concurrent failures don't clobber
 * the counter.
 */
export async function noteServerFailure(now = Date.now()) {
  return withBackoffLock(async () => {
    const { [SERVER_BACKOFF_KEY]: b } = await chrome.storage.local.get({ [SERVER_BACKOFF_KEY]: null });
    const fails = ((b && b.fails) || 0) + 1;
    const capped = Math.min(SERVER_BACKOFF_BASE_MS * Math.pow(2, fails - 1), SERVER_BACKOFF_CAP_MS);
    const wait = fails <= 1 ? capped : Math.round(capped * (0.85 + Math.random() * 0.3));
    await chrome.storage.local.set({ [SERVER_BACKOFF_KEY]: { until: now + wait, fails } });
  });
}

/** Clear the backoff after a confirmed-successful POST. */
export async function noteServerSuccess() {
  return withBackoffLock(async () => {
    const { [SERVER_BACKOFF_KEY]: b } = await chrome.storage.local.get({ [SERVER_BACKOFF_KEY]: null });
    if (b && (b.fails || b.until)) await chrome.storage.local.set({ [SERVER_BACKOFF_KEY]: { until: 0, fails: 0 } });
  });
}

/** Compare usage values; true if changed beyond threshold (or a 5h/7d reset window rolled over). */
export function hasOrgUsageChanged(prev, current) {
  prev = prev || {};
  const diff = (a, b) => a != null && b != null && Math.abs(a - b) >= ORG_POLL_CHANGE_THRESHOLD;
  // A reset_at change (new window) is meaningful even when utilization is flat.
  // First comparison (prev absent) counts as a change so a real reset isn't missed.
  const resetChanged = (a, b) => b != null && a !== b;
  return diff(prev.h5, current.h5) || diff(prev.d7, current.d7) || diff(prev.extraUsed, current.extraUsed)
    || resetChanged(prev.resetsAt5h, current.resetsAt5h) || resetChanged(prev.resetsAt7d, current.resetsAt7d);
}

/**
 * Pure send decision, shared by all collectors. Send when: forced, OR usage
 * changed since the last SENT values (rate-limited to SEND_MIN_INTERVAL_MS), OR
 * the 1h liveness floor elapsed. Otherwise skip — an unchanged heartbeat the
 * server would only dedup.
 *
 * NOTE: prevValues/lastSentAt must track the last SENT snapshot, not the last
 * polled one — comparing against last-sent catches slow cumulative drift and
 * matches what the server last stored.
 */
export function shouldSendSnapshot(prevValues, lastSentAt, currentValues, { force = false, now = Date.now() } = {}) {
  // Always compute the real change (vs last sent) — callers use it to set the
  // is_heartbeat flag and to drive the adaptive tier, which must NOT be told
  // "changed" just because a forced/needHistory send bypassed the gate.
  const changed = hasOrgUsageChanged(prevValues, currentValues);
  if (force) return { send: true, changed, reason: 'force' };
  const sinceSent = now - (lastSentAt || 0);
  if (changed && sinceSent >= SEND_MIN_INTERVAL_MS) return { send: true, changed, reason: 'changed' };
  if (sinceSent >= SEND_HEARTBEAT_FLOOR_MS) return { send: true, changed, reason: 'floor' };
  return { send: false, changed, reason: changed ? 'rate-limited' : 'unchanged' };
}

// Per-uuid send-gate state for collectors that have no adaptive poll-state of
// their own (ChatGPT/Gemini). Claude orgs reuse their existing orgPollState
// (primary: lastValues/lastPollAt; extra: lastSentValues/lastSentAt) instead.
// Stored under one storage key PER uuid (ctSendGate_<uuid>) rather than a single
// shared map, so commit() writes only its own key — two overlapping collection
// cycles can't clobber each other's keys via a whole-map read-modify-write.
// Growth is bounded by the user's distinct provider accounts (a handful, stable),
// so no pruning is needed.
const SEND_GATE_PREFIX = 'ctSendGate_';

/**
 * Storage-backed gate for ChatGPT/Gemini. Returns { send, reason, commit }; call
 * commit() only AFTER a confirmed-successful POST so a failed send leaves the
 * gate unadvanced and the next cycle retries. Kept here so providers don't
 * duplicate the read/write.
 */
export async function gateProviderSnapshot(uuid, currentValues, { force = false } = {}) {
  const key = SEND_GATE_PREFIX + uuid;
  const prev = (await chrome.storage.local.get({ [key]: null }))[key] || {};
  // ChatGPT/Gemini are collected outside the alarm's collectAndSend path, so the
  // background.js server-path gate doesn't cover them — honor the backoff here so
  // they also stop POSTing while the server is in a 5xx backoff window.
  if (await isServerBackedOff()) return { send: false, reason: 'server-backoff', commit: async () => {} };
  const { send, reason } = shouldSendSnapshot(prev.lastValues, prev.lastSentAt, currentValues, { force });
  const commit = async () => {
    await chrome.storage.local.set({ [key]: { lastValues: currentValues, lastSentAt: Date.now() } });
  };
  return { send, reason, commit };
}
