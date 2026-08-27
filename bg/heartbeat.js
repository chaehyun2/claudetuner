import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_RETRY_BASE_MS } from './constants.js';

// Heartbeat scheduling, extracted as PURE functions so the one invariant that matters here is
// testable without a browser: an undelivered heartbeat must not consume the send window.
//
// 🔴 WHY THIS EXISTS (#980). The throttle used to be armed by the ATTEMPT — bg/collect.js stamped
// `lastHeartbeatAt` unconditionally, outside the `if (hbEmail)` guard, next to a fire-and-forget
// fetch whose response was never read. Three ways to burn an hour of server-side silence without
// sending anything: no identity to send, a non-2xx answer, or the service worker dying before the
// request flushed (the failure path returns immediately, so nothing keeps the worker alive).
//
// The bias is ONE-DIRECTIONAL, which is what makes it worse than noise: a heartbeat fires only
// when collection failed, and collection failure shares causes with heartbeat failure (offline,
// worker down, network cut). So the attempt-armed throttle drops precisely the population these
// columns exist to count — `users.last_error_code` / `last_heartbeat_at`, read by the
// stale-reminder cron, the weekly report, version-adoption judgments and the admin stale view.

/**
 * Backoff after a heartbeat that did NOT land, by consecutive failure count.
 *
 * 🔴 The cap is HEARTBEAT_INTERVAL_MS — the same cadence a SUCCESSFUL heartbeat uses — and that
 * bound is the whole safety argument, not a rounding choice. It makes the retry ladder strictly
 * bounded by today's behavior: an install whose heartbeat is permanently rejected converges to
 * one request per hour, exactly what it sends now. A flat short retry (e.g. always 5 min) would
 * hand that same install a 12x write amplification, which collides head-on with the KV/D1 cost
 * root issue (#853). Transient failures — the common case — still recover in minutes.
 *
 * @param {number} n consecutive failed deliveries (1 = the first failure)
 * @returns {number} ms to wait before the next attempt
 */
export function heartbeatRetryDelayMs(n) {
  if (!Number.isFinite(n) || n < 1) return HEARTBEAT_RETRY_BASE_MS;
  // 2 ** (n - 1) overflows to Infinity long before it matters; Math.min still clamps it.
  return Math.min(HEARTBEAT_RETRY_BASE_MS * 2 ** (n - 1), HEARTBEAT_INTERVAL_MS);
}

/** Ladder rungs beyond this are indistinguishable (all clamp to the cap) — stop growing the number. */
const HEARTBEAT_RETRY_MAX_N = 64;

/**
 * Next ladder state after a heartbeat that did not land.
 *
 * 🔴 THE COERCION IS THE POINT, not defensive noise (Codex DEPLOY-BLOCKER). `(prev?.n || 0) + 1`
 * looks equivalent and is not: `{ n: "1" }` in storage — corrupt, hand-edited, or written by a
 * future version with a different shape — becomes `"11"`, then `"111"`. Every one of those is
 * non-finite to heartbeatRetryDelayMs(), which floors to the BASE delay, so the ladder never
 * climbs and the install settles at 12 requests/hour forever. That is the exact amplification the
 * cap exists to prevent, reached through the back door. Anything that is not a positive finite
 * number restarts the ladder at rung 1.
 *
 * @param {{at?: number, n?: number}|null} prev
 * @param {number} now
 */
export function nextHeartbeatRetry(prev, now) {
  const prevN = Number.isFinite(prev?.n) && prev.n > 0 ? Math.min(prev.n, HEARTBEAT_RETRY_MAX_N) : 0;
  return { at: now, n: prevN + 1 };
}

/**
 * Elapsed ms since a stored timestamp, or Infinity if that timestamp cannot be trusted.
 *
 * 🔴 A stamp in the FUTURE must read as "long ago", not "just now" (Codex DEPLOY-BLOCKER). Wall
 * time is not monotonic: a device that boots with a bad clock, stamps, and is then corrected by
 * NTP holds a timestamp years ahead. `now - at < window` stays true until wall time catches up, so
 * the install stops heartbeating — and the only paths that clear these keys are a successful
 * collection or a delivered heartbeat, neither of which a permanently-failing install reaches.
 * Treating untrusted stamps as expired costs at most one extra send, after which the state is
 * rewritten with a clean `now` and the normal throttle resumes.
 */
function elapsedSince(at, now) {
  if (!Number.isFinite(at) || at > now) return Infinity;
  return now - at;
}

/**
 * Is a heartbeat due? Two independent windows, both of which must be open:
 *
 *   lastHeartbeatAt — stamped ONLY on a delivered (2xx) heartbeat. The success cadence.
 *   retry           — { at, n } stamped ONLY on a failed delivery. The backoff ladder.
 *
 * Keeping them in separate keys is deliberate. Collapsing the failure into `lastHeartbeatAt` (by
 * back-dating it, say) would make "when did the server last hear from this install" unreadable
 * from the client — and that is the one question the whole mechanism exists to answer.
 *
 * @param {{now?: number, lastHeartbeatAt?: number|null, retry?: {at?: number, n?: number}|null}} s
 */
export function isHeartbeatDue({ now = Date.now(), lastHeartbeatAt = null, retry = null } = {}) {
  if (lastHeartbeatAt && elapsedSince(lastHeartbeatAt, now) < HEARTBEAT_INTERVAL_MS) return false;
  if (retry && retry.at && elapsedSince(retry.at, now) < heartbeatRetryDelayMs(retry.n)) return false;
  return true;
}

/** Storage key holding `{ at, n }` for the failed-delivery backoff ladder. */
export const HEARTBEAT_RETRY_KEY = '_hbRetry';
