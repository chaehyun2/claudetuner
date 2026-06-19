// Server-tunable cadence with hardcoded-default resilience.
//
// Two externalities need different levers:
//   - collection (fetch from Claude/ChatGPT/Gemini) loads the PROVIDER → server can
//     impose a floor / pause for provider incidents (outage, rate-limit change).
//   - server POST loads OUR D1 primary → server sets the send floor directly.
// Server steering propagates via POST responses (~minutes, vs days for a CWS
// release), so it is the fast fleet-wide lever — but it is an OVERRIDE on top of a
// hardcoded default, never a hard dependency: the extension always works standalone.
//
// Resilience ladder (getCadence):
//   1. valid + fresh server override   (normal server-steered)
//   2. last-known-good (stored)        (transient server outage — within TTL)
//   3. hardcoded default               (no override / invalid / stale > TTL)
//
// The TTL decay (3) is what makes the UNCLAMPED send floor safe: an aggressive value
// the server pushes then can't correct (server died) expires back to the safe
// default after CADENCE_TTL_MS. Clamps are kept ONLY where a bad value causes
// EXTERNAL, hard-to-reverse harm: heartbeat floor (too large → false disconnection
// emails) and collect floor (too small → provider ban).

import {
  SEND_MIN_INTERVAL_MS, SEND_HEARTBEAT_FLOOR_MS,
  COLLECT_HARD_FLOOR_MS, HEARTBEAT_FLOOR_MIN_MS, HEARTBEAT_FLOOR_MAX_MS,
  CADENCE_TTL_MS,
} from './constants.js';

// Hardcoded defaults = the standalone-safe base (used when no/invalid/stale override).
export const CADENCE_DEFAULTS = Object.freeze({
  collectFloorMs:   COLLECT_HARD_FLOOR_MS,    // min interval between collections (provider load)
  collectPauseUntil: 0,                       // epoch ms; while now < this, collection is paused
  sendFloorMs:      SEND_MIN_INTERVAL_MS,     // min interval between CHANGED server POSTs (our load)
  heartbeatFloorMs: SEND_HEARTBEAT_FLOOR_MS,  // force-send unchanged snapshot at least this often (liveness)
});

const STORE_KEY = '_cadenceOverride';

// Optional handler fired when the resolved cadence changes (e.g. reschedule the poll
// alarm so a new collect floor/pause takes effect immediately, not at the next
// activity event). Injected by background.js via setCadenceChangeHandler (the same
// ref-injection pattern as setCollectAndSendRef) to avoid a circular import.
let _onChange = null;
export function setCadenceChangeHandler(fn) { _onChange = fn; }

// Accept only finite, NON-NEGATIVE numbers; everything else (null/NaN/string/negative)
// is rejected so a malformed server value can never break the cadence math — it just
// falls back to the default for that field. A negative floor would otherwise make
// `sinceSent >= floor` always true (over-send). Mandatory even with clamps removed.
function num(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null; }

/**
 * Persist a server-provided cadence override from a POST response. Validates each
 * field (drops invalid ones) and stamps updatedAt for TTL decay. Missing fields are
 * simply not stored (→ default applies). Returns true if anything valid was stored.
 *
 * Expected server fields (all minutes, all optional):
 *   collect_floor_minutes, collect_pause_minutes, send_floor_minutes, heartbeat_floor_minutes
 */
export async function applyServerCadence(response, now = Date.now()) {
  if (!response || typeof response !== 'object') return false;
  // Build the override from THIS response (REPLACE, not merge): the server is
  // env-driven and re-sends every set field on every 200, so the fields present
  // express its full current intent. An omitted field = that env var is unset =
  // revert to the hardcoded default. (No response at all — 5xx/offline — never
  // reaches here; that case is covered by the TTL decay in getCadence.)
  const next = {};
  const cfMin = num(response.collect_floor_minutes);
  if (cfMin != null) next.collectFloorMs = cfMin * 60_000;
  const psMin = num(response.collect_pause_minutes);
  if (psMin != null) next.collectPauseUntil = psMin > 0 ? now + psMin * 60_000 : 0;
  const sfMin = num(response.send_floor_minutes);
  if (sfMin != null) next.sendFloorMs = sfMin * 60_000;
  const hbMin = num(response.heartbeat_floor_minutes);
  if (hbMin != null) next.heartbeatFloorMs = hbMin * 60_000;

  let prev = null;
  try { prev = (await chrome.storage.local.get({ [STORE_KEY]: null }))[STORE_KEY]; } catch { prev = null; }
  const prevValues = (prev && prev.values) || null;

  if (Object.keys(next).length === 0) {
    // A 200 with NO cadence fields = server is not overriding → clear any stored
    // override so the fleet recovers to defaults within one POST (not after the 12h
    // TTL) when an admin removes the throttle env vars.
    if (prevValues) { await chrome.storage.local.remove(STORE_KEY); await fireChange(); }
    return false;
  }
  await chrome.storage.local.set({ [STORE_KEY]: { values: next, updatedAt: now } });
  // Fire the change handler only when something that affects the alarm actually
  // changed — the stable floors, or the paused/not-paused STATE (not the moving
  // pause epoch, which advances every POST while a pause is held).
  const stableChanged = ['collectFloorMs', 'sendFloorMs', 'heartbeatFloorMs']
    .some(k => (next[k] ?? null) !== (prevValues ? (prevValues[k] ?? null) : null));
  const wasPaused = !!(prevValues && prevValues.collectPauseUntil > now);
  const nowPaused = !!(next.collectPauseUntil && next.collectPauseUntil > now);
  if (!prevValues || stableChanged || wasPaused !== nowPaused) await fireChange();
  return true;
}

async function fireChange() {
  if (_onChange) { try { await _onChange(); } catch { /* handler failure never breaks ingest */ } }
}

/**
 * Resolve the effective cadence: defaults overlaid with a fresh, validated, clamped
 * server override. Clamps applied here (not at store time) so tightening a clamp in
 * a future release re-bounds an already-stored value. Always returns a complete
 * object — callers never see undefined.
 */
export async function getCadence(now = Date.now()) {
  const out = { ...CADENCE_DEFAULTS };
  let stored;
  try {
    stored = (await chrome.storage.local.get({ [STORE_KEY]: null }))[STORE_KEY];
  } catch { stored = null; }

  // TTL decay: a stale override (server hasn't reconfirmed within CADENCE_TTL_MS) is
  // ignored → revert to hardcoded defaults. This bounds the damage of any bad value
  // if the server goes dark.
  if (stored && stored.values && now - (stored.updatedAt || 0) < CADENCE_TTL_MS) {
    const v = stored.values;
    if (num(v.collectFloorMs) != null) out.collectFloorMs = v.collectFloorMs;
    if (num(v.collectPauseUntil) != null) out.collectPauseUntil = v.collectPauseUntil;
    if (num(v.sendFloorMs) != null) out.sendFloorMs = v.sendFloorMs;
    if (num(v.heartbeatFloorMs) != null) out.heartbeatFloorMs = v.heartbeatFloorMs;
  }

  // Kept clamps (external, hard-to-reverse harm only):
  //  - collect floor: never BELOW the hard 5min floor (too fast → provider ban).
  out.collectFloorMs = Math.max(COLLECT_HARD_FLOOR_MS, out.collectFloorMs);
  //  - heartbeat floor: stay within [60min, 140min) — below the chart gap / 3h skip
  //    / 6h disconnection email gates, above the 60min server dedup window.
  out.heartbeatFloorMs = Math.min(HEARTBEAT_FLOOR_MAX_MS - 1, Math.max(HEARTBEAT_FLOOR_MIN_MS, out.heartbeatFloorMs));
  //  - send floor: intentionally UNCLAMPED (server-free; only type-validated above).
  //    A bad value self-heals via TTL decay; slowing sends can't trigger false
  //    disconnection because the heartbeat floor is the independent liveness signal.

  return out;
}

/** True while the server has paused collection (provider-incident circuit breaker). */
export function isCollectionPaused(cadence, now = Date.now()) {
  return !!(cadence && cadence.collectPauseUntil && now < cadence.collectPauseUntil);
}
