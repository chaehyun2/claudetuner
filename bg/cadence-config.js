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
  CADENCE_TTL_MS, IMPRESSION_FLUSH_DEFAULT_MS,
} from './constants.js';

// Hardcoded defaults = the standalone-safe base (used when no/invalid/stale override).
export const CADENCE_DEFAULTS = Object.freeze({
  collectFloorMs:   COLLECT_HARD_FLOOR_MS,    // min interval between collections (provider load)
  collectPauseUntil: 0,                       // epoch ms; while now < this, collection is paused
  sendFloorMs:      SEND_MIN_INTERVAL_MS,     // min interval between CHANGED server POSTs (our load)
  heartbeatFloorMs: SEND_HEARTBEAT_FLOOR_MS,  // force-send unchanged snapshot at least this often (liveness)
  flushMaxMs:       IMPRESSION_FLUSH_DEFAULT_MS, // max interval between ad impression/click counter flushes
});

const STORE_KEY = '_cadenceOverride';
// Per-stream cadence overrides (server field `stream_cadence`, design 안 B). The browser-
// global override above throttles EVERY provider at once, so the server could only demote a
// browser that was redundant on ALL of its streams, and had to pin the standby heartbeat to
// the tightest chart gap across providers. A per-stream override lifts both limits.
//
// Keyed locally by (uuid, provider): the server does NOT send a key — each POST response
// simply describes the stream that POST carried, and the caller knows which one that was.
// So there is no cross-runtime key format to keep in sync (no drift risk).
// Bounded by the user's distinct streams (3-org cap × providers), so no pruning needed.
//
// ONE STORAGE KEY PER STREAM, not a single map — the same reason send-gate.js keeps its gate
// state under ctSendGate_<uuid>: two collection cycles routinely overlap (Claude and Gemini
// finish independently), and a whole-map read-modify-write lets the slower writer clobber the
// faster one's stream. Per-key writes cannot collide. Growth is bounded by the user's distinct
// streams (3-org cap × providers), so no pruning is needed.
const STREAM_KEY_PREFIX = 'ctStreamCadence_';

/** Local storage key for a stream. Never crosses the wire — see above. */
function streamKey(ref) {
  if (!ref || !ref.uuid) return null;
  return `${STREAM_KEY_PREFIX}${ref.provider || 'claude'}|${ref.uuid}`;
}

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
 *   collect_floor_minutes, collect_pause_minutes, send_floor_minutes, heartbeat_floor_minutes,
 *   impression_flush_minutes, ad_refresh_minutes
 */
export async function applyServerCadence(response, now = Date.now(), streamRef = null) {
  if (!response || typeof response !== 'object') return false;
  // Per-stream standby override for the stream THIS response answered. Same REPLACE
  // semantics as the global override: present → store; ABSENT → clear, so a server-side
  // rollback (flag off) restores full cadence on the very next POST instead of waiting out
  // the TTL. Only touches the stream we just posted; other streams keep their own state.
  //
  // EXCEPT a 3-org-cap drop (`skip_org`): that response is not authoritative about this
  // stream's standby state. The server discards the snapshot, so it never claims or renews a
  // lease for it — once the old lease expires the stream reads as vacant and the drop
  // response would carry no verdict, silently CLEARING a legitimate standby override and
  // bouncing the browser back to full cadence forever (Codex MEDIUM, this PR). Leave the
  // stream's state exactly as the last authoritative response left it.
  if (!response.skip_org) await applyStreamCadence(response.stream_cadence, streamRef, now);
  // Piggyback: the server reads cf.country and returns it on POST responses so the
  // ad-server targeting filter (usage-shared.js) has a country signal without any
  // extra Worker call (design §3.2/§4). Cache it here — the shared POST chokepoint.
  // Absent/empty → leave the last-known value (don't clobber on a country-less 200).
  if (typeof response.country === 'string' && response.country) {
    try { await chrome.storage.local.set({ _ct_country: response.country.toUpperCase() }); } catch { /* storage hiccup — non-fatal */ }
  }
  // Same piggyback channel, same reason: the sidebars' ad ROTATION PERIOD, mirrored into a
  // storage key the content scripts can read (they cannot import this ESM module — runtime
  // boundary). REPLACE semantics like the cadence override below: field absent = the env var
  // is unset = clear the key so the client falls back to its built-in default on the very
  // next POST, instead of holding a stale period forever.
  // ⚠️ Key literal is duplicated in usage-shared.js (AD_REFRESH_KEY) and pinned by
  // test/ads-dry-guard.mjs. Rename in BOTH or neither.
  const adMin = num(response.ad_refresh_minutes);
  try {
    if (adMin != null && adMin > 0) await chrome.storage.local.set({ _ct_ad_refresh_ms: adMin * 60_000 });
    else await chrome.storage.local.remove('_ct_ad_refresh_ms');
  } catch { /* storage hiccup — non-fatal, client keeps its default */ }
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
  const flMin = num(response.impression_flush_minutes);
  if (flMin != null) next.flushMaxMs = flMin * 60_000;

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
  const stableChanged = ['collectFloorMs', 'sendFloorMs', 'heartbeatFloorMs', 'flushMaxMs']
    .some(k => (next[k] ?? null) !== (prevValues ? (prevValues[k] ?? null) : null));
  const wasPaused = !!(prevValues && prevValues.collectPauseUntil > now);
  const nowPaused = !!(next.collectPauseUntil && next.collectPauseUntil > now);
  if (!prevValues || stableChanged || wasPaused !== nowPaused) await fireChange();
  return true;
}

/** Store/clear the per-stream override for ONE stream. No-op without a stream ref (callers
 *  that don't know their stream — e.g. the pause probe — must not clobber anything). */
async function applyStreamCadence(sc, streamRef, now) {
  const key = streamKey(streamRef);
  if (!key) return;

  const next = {};
  if (sc && typeof sc === 'object') {
    const sf = num(sc.send_floor_minutes);
    if (sf != null) next.sendFloorMs = sf * 60_000;
    const hb = num(sc.heartbeat_floor_minutes);
    if (hb != null) next.heartbeatFloorMs = hb * 60_000;
  }

  try {
    if (Object.keys(next).length === 0) {
      await chrome.storage.local.remove(key);   // absent = "not standby" → clear (rollback path)
    } else {
      await chrome.storage.local.set({ [key]: { values: next, updatedAt: now } });
    }
  } catch { /* storage hiccup — non-fatal; the next POST re-states the server's intent */ }
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
export async function getCadence(now = Date.now(), streamRef = null) {
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
    if (num(v.flushMaxMs) != null) out.flushMaxMs = v.flushMaxMs;
  }

  // Per-stream override (design 안 B) for THIS stream, layered on the global one. Both are
  // BRAKES, so the SLOWER wins — never a plain overwrite. That matters during a D1 incident:
  // ops raises the fleet floors, every response carries them, but a stream's own standby
  // value was last written before the brake and would otherwise keep that stream sending
  // faster than the fleet until it happens to POST again (Codex MEDIUM, this PR). Taking the
  // max makes the brake bind immediately, on every stream, from the first response that
  // carries it. Applied before the clamps below so the same bounds bind it, and TTL-decayed
  // the same way — a stale entry is ignored (and swept, so it can't accumulate).
  const sKey = streamKey(streamRef);
  if (sKey) {
    let ent;
    try { ent = (await chrome.storage.local.get({ [sKey]: null }))[sKey]; } catch { ent = null; }
    const fresh = ent && ent.values && now - (ent.updatedAt || 0) < CADENCE_TTL_MS;
    if (fresh) {
      if (num(ent.values.sendFloorMs) != null) out.sendFloorMs = Math.max(out.sendFloorMs, ent.values.sendFloorMs);
      if (num(ent.values.heartbeatFloorMs) != null) out.heartbeatFloorMs = Math.max(out.heartbeatFloorMs, ent.values.heartbeatFloorMs);
    } else if (ent) {
      // Expired → drop the key rather than leave it inert forever (storage hygiene).
      chrome.storage.local.remove(sKey).catch(() => {});
    }
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

/**
 * Drop per-stream cadence keys for streams that are no longer active. TTL already makes a
 * stale entry inert, but inert is not gone: a user who rotates through orgs/accounts would
 * accumulate keys forever and could eventually hit the storage quota, at which point writes
 * fail SILENTLY (Codex LOW, this PR). Called from the same place orgPollState is pruned.
 *
 * `activeKeys` = the (provider, uuid) refs still in use. Anything else with our prefix goes.
 */
export async function pruneStreamCadence(activeRefs) {
  const keep = new Set((activeRefs || []).map(streamKey).filter(Boolean));
  let all;
  try { all = await chrome.storage.local.get(null); } catch { return; }
  const dead = Object.keys(all).filter(k => k.startsWith(STREAM_KEY_PREFIX) && !keep.has(k));
  if (dead.length === 0) return;
  try { await chrome.storage.local.remove(dead); } catch { /* non-fatal */ }
}

/** True while the server has paused collection (provider-incident circuit breaker). */
export function isCollectionPaused(cadence, now = Date.now()) {
  return !!(cadence && cadence.collectPauseUntil && now < cadence.collectPauseUntil);
}
