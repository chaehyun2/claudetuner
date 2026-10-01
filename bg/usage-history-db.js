// Where the collected usage points live (#1957, 2026-10-01). Shared by the service worker (the only
// writer) and the extension pages that read it (popup / side panel). Content scripts never read it.
//
// The history used to be one flat `usageHistory` array in chrome.storage.local (~2 MB at 14k points,
// 98% of the extension's local storage), rewritten WHOLE on every append. Every rewrite fired
// storage.onChanged with old+new (~4 MB) into every context that listens — the claude.ai content
// scripts and the compare frame included — up to five times per collection run. That is what the
// Windows stutter while typing in claude.ai traced to. Points now live in IndexedDB: an append is one
// `add`, and IndexedDB writes fire nothing anywhere.
//
// Stores: `points` (autoIncrement key, index `t`) and `meta` ({ key, value } — `migrated`, `lastPrune`,
// `clearedAt`).
//
// Legacy array: moved over once, on the first open in any context. The array is read OUTSIDE the
// transaction; ONE readwrite transaction over points+meta then adds it only while meta.migrated is
// unset, and sets it. Readwrite transactions over the same stores are serialised, so two contexts
// migrating at once add the points once. The storage key is removed only after that commits.
// clearHistory() clears the points and sets meta.migrated in ONE transaction too, so a migration that
// read the array before a reset cannot bring the cleared points back. It also records `clearedAt`:
// an append checks it in its own transaction and drops a point collected before the reset — an
// append that was still waiting for the open when another context reset the history (Codex 3R).
//
// 🔴 NOTHING HERE EVER WRITES the `usageHistory` storage key — it is only the one-time migration's
// source. When IndexedDB will not open, or an append's transaction fails, that point is DROPPED with a
// warning. Codex 1R/2R #1957: every storage fallback write raced the migration (a point appended
// after the migration read the array was deleted with the key; a merge path brought reset points
// back). The history is local-only data for the popup's charts and forecasts; the server keeps its
// own snapshots, so a lost point costs a dot on a chart. Reads without IndexedDB use the legacy array
// when one is still there (a profile that never migrated), else [].

import { HISTORY_MAX_AGE_MS } from './constants.js';
import { reqPromise, txDone } from '../ui/idb.js';

/** The chrome.storage.local key the history lived under before #1957 — read once, never written. */
export const LEGACY_HISTORY_KEY = 'usageHistory';
/** Runtime message the service worker sends after an append, so an open popup redraws right away. */
export const HISTORY_UPDATED = 'HISTORY_UPDATED';

export const HISTORY_DB_NAME = 'ct-usage-history';
export const HISTORY_DB_VERSION = 1;
const POINTS = 'points';
const META = 'meta';
const T_INDEX = 't';
const MIGRATED_KEY = 'migrated';
const LAST_PRUNE_KEY = 'lastPrune';
const CLEARED_AT_KEY = 'clearedAt';
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // the 30-day cut runs at most hourly
// An open another connection keeps blocked (onblocked) gives up after this: reads then take the
// no-IndexedDB path and appends are dropped, instead of every op waiting forever (Codex 3R).
const OPEN_BLOCKED_TIMEOUT_MS = 5000;

const isFresh = (p, cutoff) => !!p && p.t > cutoff;

/**
 * The store over injected platform pieces (the guard passes fakes). `storage` is a
 * chrome.storage.local-shaped callback API; `lastErr` reports chrome.runtime.lastError.
 */
export function createUsageHistoryStore({ idb, keyRange, storage, lastErr = () => null, now = () => Date.now(), blockedTimeoutMs = OPEN_BLOCKED_TIMEOUT_MS }) {
  // --- the legacy array (chrome.storage.local) ---
  const legacyGet = () => new Promise((resolve, reject) => {
    if (!storage) { resolve(null); return; }
    storage.get({ [LEGACY_HISTORY_KEY]: null }, (r) => {
      const err = lastErr();
      if (err) reject(err);
      else resolve(r ? r[LEGACY_HISTORY_KEY] : null);
    });
  });
  const legacyCall = (method, arg) => new Promise((resolve) => {
    if (!storage) { resolve(false); return; }
    storage[method](arg, () => resolve(!lastErr()));
  });
  const legacyRead = async () => {
    try {
      const arr = await legacyGet();
      const cutoff = now() - HISTORY_MAX_AGE_MS;
      return Array.isArray(arr) ? arr.filter((p) => isFresh(p, cutoff)) : [];
    } catch { return []; }
  };
  // A point IndexedDB could not take is dropped, never written to storage.local (see the header).
  const dropped = (e) => {
    console.warn('[Claude Tuner] usage history point dropped:', e?.message || e);
    return false;
  };

  // --- IndexedDB ---
  let opened = null;
  /** The raw connection. A failed open is not cached: the next op tries again. */
  const open = () => {
    if (!idb || typeof idb.open !== 'function' || !keyRange) return Promise.reject(new Error('no indexedDB'));
    if (!opened) {
      const req = idb.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(POINTS)) d.createObjectStore(POINTS, { autoIncrement: true }).createIndex(T_INDEX, 't');
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'key' });
      };
      opened = new Promise((resolve, reject) => {
        let timer = null;
        let gaveUp = false;
        req.onblocked = () => {
          if (!timer) timer = setTimeout(() => { gaveUp = true; reject(new Error('indexedDB open blocked')); }, blockedTimeoutMs);
        };
        req.onsuccess = () => {
          clearTimeout(timer);
          if (gaveUp) { req.result.close(); return; } // too late: this attempt was already given up
          resolve(req.result);
        };
        req.onerror = () => { clearTimeout(timer); reject(req.error); };
      }).then((d) => {
        // A later version opened elsewhere must not wait on this connection forever.
        d.onversionchange = () => { d.close(); opened = null; ready = null; };
        return d;
      });
      opened.catch(() => { opened = null; });
    }
    return opened;
  };

  /** Move the legacy array in (see the header). Resolves once IndexedDB holds the history. */
  async function migrate(d) {
    const arr = await legacyGet(); // a failed read fails the open: reads keep the legacy array
    const cutoff = now() - HISTORY_MAX_AGE_MS;
    const tx = d.transaction([POINTS, META], 'readwrite');
    const points = tx.objectStore(POINTS);
    const meta = tx.objectStore(META);
    const mark = meta.get(MIGRATED_KEY);
    mark.onsuccess = () => {
      if (mark.result) return; // another context (or a reset) got here first
      if (Array.isArray(arr)) for (const p of arr) if (isFresh(p, cutoff)) points.add(p);
      meta.put({ key: MIGRATED_KEY, value: true });
    };
    await txDone(tx);
    // Only after the commit. A failed remove leaves a key no one reads; the next open retries it.
    if (arr != null) await legacyCall('remove', LEGACY_HISTORY_KEY);
  }

  let ready = null;
  /** The connection, after the legacy array has been moved. Not cached on failure. */
  const db = () => {
    if (!ready) {
      ready = open().then(async (d) => { await migrate(d); return d; });
      ready.catch(() => { ready = null; });
    }
    return ready;
  };

  return {
    /** Add one point; prune points older than HISTORY_MAX_AGE_MS at most hourly. True when stored. */
    async append(point) {
      let d;
      try { d = await db(); } catch (e) { return dropped(e); }
      try {
        const t = now();
        const tx = d.transaction([POINTS, META], 'readwrite');
        const points = tx.objectStore(POINTS);
        const meta = tx.objectStore(META);
        let stored = false;
        const cleared = meta.get(CLEARED_AT_KEY);
        cleared.onsuccess = () => {
          // `<=`, not `<` (Codex 4R): a point stamped in the SAME millisecond as the reset cannot be
          // told from one collected just before it, and a reset that leaves a point behind is the
          // worse outcome — the next collection refills a dropped local point within minutes.
          if (cleared.result && point.t <= cleared.result.value) return; // collected before (or at) a reset
          points.add(point);
          stored = true;
        };
        const last = meta.get(LAST_PRUNE_KEY);
        last.onsuccess = () => {
          if (last.result && t - last.result.value < PRUNE_INTERVAL_MS) return;
          const old = points.index(T_INDEX).getAllKeys(keyRange.upperBound(t - HISTORY_MAX_AGE_MS));
          old.onsuccess = () => { for (const k of old.result) points.delete(k); };
          meta.put({ key: LAST_PRUNE_KEY, value: t });
        };
        await txDone(tx);
        return stored || dropped(new Error('collected before the last reset'));
      } catch (e) { return dropped(e); }
    },

    /** Points with t > since (default: the whole 30 days), oldest first — the old array's shape. */
    async read({ since = -Infinity } = {}) {
      const lower = Math.max(since, now() - HISTORY_MAX_AGE_MS);
      let d;
      try { d = await db(); } catch { return (await legacyRead()).filter((p) => p.t > lower); }
      try {
        const tx = d.transaction(POINTS, 'readonly');
        const out = await reqPromise(tx.objectStore(POINTS).index(T_INDEX).getAll(keyRange.lowerBound(lower, true)));
        return out || [];
      } catch { return []; }
    },

    /** The newest `n` points that `accept`, oldest first — without reading the whole history. */
    async readLast(n, accept = () => true) {
      const cutoff = now() - HISTORY_MAX_AGE_MS;
      let d;
      try { d = await db(); } catch { return (await legacyRead()).filter(accept).slice(-n); }
      try {
        const tx = d.transaction(POINTS, 'readonly');
        const req = tx.objectStore(POINTS).index(T_INDEX).openCursor(keyRange.lowerBound(cutoff, true), 'prev');
        const out = [];
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return;
          if (accept(c.value)) out.unshift(c.value);
          if (out.length < n) c.continue();
        };
        await txDone(tx);
        return out;
      } catch { return []; }
    },

    /**
     * Drop every point (options 「reset data」), and the legacy array with them. True only when BOTH
     * are gone: with IndexedDB unavailable its points survive, and the reset must not read as done
     * (Codex 1R #1957). The legacy key is only removed, never written.
     */
    async clear() {
      let idbCleared = false;
      try {
        const d = await open(); // not db(): a reset needs no migration first — it marks one done
        const tx = d.transaction([POINTS, META], 'readwrite');
        tx.objectStore(POINTS).clear();
        tx.objectStore(META).put({ key: MIGRATED_KEY, value: true });
        tx.objectStore(META).put({ key: CLEARED_AT_KEY, value: now() });
        await txDone(tx);
        idbCleared = true;
      } catch { /* reported below */ }
      const legacyCleared = await legacyCall('remove', LEGACY_HISTORY_KEY);
      return idbCleared && legacyCleared;
    },
  };
}

// The store for this context, built on first use (so a guard can install its globals first).
let _store = null;
const store = () => _store || (_store = createUsageHistoryStore({
  idb: globalThis.indexedDB,
  keyRange: globalThis.IDBKeyRange,
  storage: globalThis.chrome?.storage?.local,
  lastErr: () => globalThis.chrome?.runtime?.lastError,
}));

export const appendPoint = (point) => store().append(point);
export const readHistory = (opts) => store().read(opts);
export const readLast = (n, accept) => store().readLast(n, accept);
export const clearHistory = () => store().clear();
