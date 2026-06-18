// Shared snapshot send-gating.
//
// Every collector (Claude primary + extra orgs, ChatGPT, Gemini) collects usage
// each poll cycle, but most cycles are unchanged "heartbeats". Sending those to
// the server is wasteful: the server only dedups them via a D1 read, and at
// fleet scale (~10 POST/s) those reads saturate D1 (cf. extra-org-delta-gate).
// This module is the single place that decides "is this snapshot worth POSTing?"
// so all collectors share one delta-gate instead of each reinventing it.

import { ORG_POLL_CHANGE_THRESHOLD, SEND_HEARTBEAT_FLOOR_MS, SEND_MIN_INTERVAL_MS } from './constants.js';

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
  const { send, reason } = shouldSendSnapshot(prev.lastValues, prev.lastSentAt, currentValues, { force });
  const commit = async () => {
    await chrome.storage.local.set({ [key]: { lastValues: currentValues, lastSentAt: Date.now() } });
  };
  return { send, reason, commit };
}
