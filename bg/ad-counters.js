// In-house ad measurement: the single-owner counter and its batched flush.
// Moved verbatim out of background.js (#1126); only the `export` keywords and these imports are new.
import { getCadence } from './cadence-config.js';
import { getExtToken } from './storage.js';

// ══════════════════════════════════════════════════════════════════════════
// In-house ad measurement — SINGLE-OWNER counter + batched flush (design §5.3/§5.4)
// ══════════════════════════════════════════════════════════════════════════
// The background service worker is the SINGLE OWNER of all ad impression/click
// counters: it does BOTH the increments (from content-script 'ad_metric' messages)
// AND the periodic flush to /api/event, serialized through ONE async op-chain
// (_adEnqueue) so there is never a read-modify-write race across tabs or between an
// increment and an in-flight flush. Content scripts never touch the counter storage.

const AD_COUNTERS_KEY = '__ct_ad_counters'; // { "campaign|content|placement": {imp,clk} }
export const AD_FLUSH_ALARM = 'ad-flush';
const AD_EVENT_ENDPOINT = 'https://api.claudetuner.com/api/event';
// Per-flush row cap. The worker /api/event caps the body at 4096 bytes AND 50 rows;
// campaign/content IDs can be up to 128 chars each, so a fixed row count can exceed the
// worker's 4096-byte /api/event cap → the worker drops the body but returns 204 while
// the client would subtract/delete the counters = silent count loss. The flush builds
// its batch by BYTE BUDGET (AD_FLUSH_MAX_BYTES, headroom under 4096) with a 50-row hard
// cap; excess keys stay in the store and drain over subsequent flush ticks (design §5.4).
const AD_FLUSH_MAX_ROWS = 50;   // hard row cap (matches the worker's row slice)
const AD_FLUSH_MAX_BYTES = 3600; // serialized-body byte budget (headroom under the worker's 4096)

// Byte-accurate size of a string: Blob is exact for any encoding; str.length is an
// ASCII-only fallback (ad IDs are ASCII, so char ≈ byte) when Blob is unavailable.
function _adByteSize(str) {
  try { return new Blob([str]).size; } catch { return str.length; }
}

// Single async op-chain (mutex): every counter read-modify-write — increment AND
// flush — is appended here so they can never interleave. Failures are swallowed so
// one bad op never wedges the chain.
let _adOpChain = Promise.resolve();
function _adEnqueue(fn) { _adOpChain = _adOpChain.then(fn).catch(() => {}); return _adOpChain; }

function _adValidStr(v) { return typeof v === 'string' && v.length > 0; }

// Increment one counter cell from an 'ad_metric' message. Ignored unless all three
// identity keys are non-empty strings and kind is a known event.
export function incrementAdCounter(message) {
  const { kind, campaign, content, placement } = message || {};
  if (!_adValidStr(campaign) || !_adValidStr(content) || !_adValidStr(placement)) return;
  if (kind !== 'impression' && kind !== 'click') return;
  _adEnqueue(async () => {
    const store = (await chrome.storage.local.get(AD_COUNTERS_KEY))[AD_COUNTERS_KEY] || {};
    const key = campaign + '|' + content + '|' + placement;
    const e = store[key] || { imp: 0, clk: 0 };
    if (kind === 'impression') e.imp++; else e.clk++;
    store[key] = e;
    await chrome.storage.local.set({ [AD_COUNTERS_KEY]: store });
  });
}

// Flush batched counters to /api/event. Runs through the op-chain so it never races
// an increment. Sends a snapshot of the current non-empty cells, then SUBTRACTS
// exactly what was sent from a FRESH re-read (never zeroes the store) so increments
// that arrived during the in-flight POST are preserved. No-op when nothing to send;
// on POST failure the counters are left intact for the next flush.
export function flushAdCounters() {
  return _adEnqueue(async () => {
    const store = (await chrome.storage.local.get(AD_COUNTERS_KEY))[AD_COUNTERS_KEY] || {};
    const keys = Object.keys(store).filter((k) => store[k].imp > 0 || store[k].clk > 0);
    if (!keys.length) return;
    const ver = chrome.runtime.getManifest().version;
    // Accumulate rows by BYTE BUDGET: add one at a time and stop before the serialized
    // body would exceed AD_FLUSH_MAX_BYTES OR AD_FLUSH_MAX_ROWS is reached (whichever
    // first). Keys not included stay in the store and drain next flush (only the keys in
    // `batch` are subtracted below). A single row that alone exceeds the budget (only
    // possible with corrupted/impossible keys — a valid 128-char-ID row is ~375B) is
    // SKIPPED, never force-sent, so the worker can't silently drop it and cause the
    // subtract-on-204 to delete real counts.
    const batch = [];
    const rows = [];
    for (const k of keys) {
      const [campaign, content, placement] = k.split('|');
      const row = { campaign, content, placement, imp: store[k].imp, clk: store[k].clk };
      const candidate = JSON.stringify({ type: 'banner_batch', ver, rows: rows.concat([row]) });
      if (_adByteSize(candidate) > AD_FLUSH_MAX_BYTES) {
        if (rows.length) break; // batch full — send the rest next flush
        continue;               // lone oversized row — skip (don't force-send + lose it)
      }
      rows.push(row);
      batch.push(k);
      if (batch.length >= AD_FLUSH_MAX_ROWS) break; // hard row cap
    }
    if (!rows.length) return; // nothing sendable this tick
    let ok = false;
    try {
      // text/plain keeps this a CORS simple request (no preflight), matching the project's
      // simplePost convention. The server always returns 204.
      //
      // `_auth` carries the ext_token ONLY so the server can count DISTINCT users reached
      // (privacy §9: it is hashed with a server secret, held <=24h as a de-duplication key,
      // and never written to analytics). ext_token only — never the shared public api_key,
      // which identifies nobody and would collapse the whole fleet onto one key. Absent
      // token → the beacon stays anonymous and impressions still count, we just get no reach.
      const extToken = await getExtToken();
      const payload = { type: 'banner_batch', ver, rows };
      if (extToken) payload._auth = extToken;
      const r = await fetch(AD_EVENT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      ok = r.ok || r.status === 204;
    } catch { ok = false; }
    if (!ok) return; // leave counters intact; retry on next flush
    // Re-read and SUBTRACT what was actually sent (preserve concurrent increments).
    const cur = (await chrome.storage.local.get(AD_COUNTERS_KEY))[AD_COUNTERS_KEY] || {};
    for (const k of batch) {
      if (!cur[k]) continue;
      cur[k].imp -= store[k].imp;
      cur[k].clk -= store[k].clk;
      if (cur[k].imp <= 0 && cur[k].clk <= 0) delete cur[k];
    }
    await chrome.storage.local.set({ [AD_COUNTERS_KEY]: cur });
  });
}

// (Re)schedule the periodic flush alarm from the server-tunable flush cadence
// (getCadence().flushMaxMs; default 60min). Called from setupAlarm (startup/install)
// and the cadence-change handler.
export async function updateAdFlushAlarm() {
  const cadence = await getCadence();
  // Clamp to [1min, 1440min (24h)] so a pathological server cadence value can't set an
  // absurd alarm period. The value self-heals via cadence TTL, but bound it anyway.
  const minutes = Math.min(1440, Math.max(1, Math.round(cadence.flushMaxMs / 60000)));
  const existing = await chrome.alarms.get(AD_FLUSH_ALARM);
  if (existing && Math.abs(existing.periodInMinutes - minutes) < 0.5) return; // no change needed
  chrome.alarms.create(AD_FLUSH_ALARM, { periodInMinutes: minutes });
}
