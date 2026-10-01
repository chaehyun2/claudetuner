// Where the compare page's history ENTRIES live (#1877, 2026-09-28).
//
// An entry used to be one chrome.storage.local key (`compareHistory:<id>`) capped at
// HISTORY_ENTRY_MAX_BYTES (200 KB) — the whole extension shares a 10 MB quota there. A long debate
// (300 turns: ~540 KB of Korean answers alone) was cut to fit. Entries now live in IndexedDB,
// deflate-compressed, capped at HISTORY_ENTRY_MAX_BYTES_IDB; chrome.storage.local stays the
// fallback (no IndexedDB / no CompressionStream) with the old cap.
//
// Both stores speak one small promise API that history.js's read → validate → decide → write ops
// run on (always under the history lock — this module does not lock):
//   getAll()          → { ok, all: { key: rawEntry } }   every history key, raw (history.js validates)
//   getOne(key)       → { ok, value }                   value undefined when absent
//   write(set, remove)→ boolean                          true only when storage reported success
//   maxEntryBytes                                         the bound fitEntry keeps an entry's JSON under
//
// The IndexedDB store keeps two object stores: `meta` ({ key, rev } — tiny) and `body`
// ({ key, z } — the compressed JSON). Every read takes the revs first and decompresses only the
// bodies whose rev this page has not seen (another tab wrote them), so a save after every settle does
// not re-inflate twenty long debates. The legacy keys are moved over once, on the first read.

import { HISTORY_KEY_PREFIX, HISTORY_ENTRY_MAX_BYTES, HISTORY_ENTRY_MAX_BYTES_IDB, HISTORY_DB_NAME, HISTORY_DB_VERSION, HISTORY_STORE_MARK_KEY } from './constants.js';
import { reqPromise, txDone } from '../idb.js';

const META = 'meta';
const BODY = 'body';

/** deflate-raw of a string, or of bytes back to the string — the platform's own streams. */
export function zipCodec({ CS = globalThis.CompressionStream, DS = globalThis.DecompressionStream, BlobC = globalThis.Blob, ResponseC = globalThis.Response } = {}) {
  if (typeof CS !== 'function' || typeof DS !== 'function' || typeof BlobC !== 'function' || typeof ResponseC !== 'function') return null;
  return {
    async zip(str) { return new Uint8Array(await new ResponseC(new BlobC([str]).stream().pipeThrough(new CS('deflate-raw'))).arrayBuffer()); },
    async unzip(bytes) { return new ResponseC(new BlobC([bytes]).stream().pipeThrough(new DS('deflate-raw'))).text(); },
  };
}

/** chrome.storage.local, as before #1877 — the fallback, and the legacy source the IndexedDB store drains. */
export function localEntryStore(storage, lastErr = () => null) {
  const get = (arg) => new Promise((resolve) => {
    const done = (v, failed) => resolve(failed || !v || typeof v !== 'object' ? null : v);
    try {
      const r = storage.get(arg, (v) => done(v, !!lastErr()));
      if (r && typeof r.then === 'function') r.then((v) => done(v, false), () => done(null, true));
    } catch { done(null, true); }
  });
  const call = (fn, arg) => new Promise((resolve) => {
    try {
      const r = fn(arg, () => resolve(!lastErr()));
      if (r && typeof r.then === 'function') r.then(() => resolve(true), () => resolve(false));
    } catch { resolve(false); }
  });
  return {
    kind: 'local',
    maxEntryBytes: HISTORY_ENTRY_MAX_BYTES,
    /** The 「entries moved to IndexedDB」 mark: true / false, or null when the read failed. */
    async moved() { const v = await get(HISTORY_STORE_MARK_KEY); return v ? v[HISTORY_STORE_MARK_KEY] === 'idb' : null; },
    markMoved() { return call((a, cb) => storage.set(a, cb), { [HISTORY_STORE_MARK_KEY]: 'idb' }); },
    async getAll() {
      const all = await get(null);
      if (!all) return { ok: false, all: {} };
      const out = {};
      for (const k of Object.keys(all)) if (k.startsWith(HISTORY_KEY_PREFIX)) out[k] = all[k];
      return { ok: true, all: out };
    },
    async getOne(key) {
      const v = await get(key);
      if (!v) return { ok: false, value: undefined };
      return { ok: true, value: Object.hasOwn(v, key) ? v[key] : undefined };
    },
    async write(set, remove) {
      let ok = true;
      if (remove && remove.length) ok = (await call((a, cb) => storage.remove(a, cb), remove)) && ok;
      if (set && Object.keys(set).length) ok = (await call((a, cb) => storage.set(a, cb), set)) && ok;
      return ok;
    },
  };
}

/**
 * storage.local AS the history — only while no page ever moved the entries to IndexedDB (the mark).
 * Checked on EVERY op, never cached (Codex 2R: a tab that fell back once, or one without
 * CompressionStream, went on reading an empty history and writing beside the moved one). Moved, or
 * the mark unreadable: the op fails (ok:false / false) — the history is unavailable, never empty.
 */
export function guardedLocal(legacy) {
  const allowed = async () => (await legacy.moved()) === false;
  return {
    kind: 'local',
    maxEntryBytes: legacy.maxEntryBytes,
    async getAll() { return (await allowed()) ? legacy.getAll() : { ok: false, all: {} }; },
    async getOne(key) { return (await allowed()) ? legacy.getOne(key) : { ok: false, value: undefined }; },
    async write(set, remove) { return (await allowed()) ? legacy.write(set, remove) : false; },
  };
}

/**
 * The IndexedDB store; `legacy` (a localEntryStore) is drained into it on the first read. Opening
 * IndexedDB can fail (a profile that refuses it): the page then keeps using `legacy` — nothing was
 * moved yet, so nothing is lost.
 */
export function idbEntryStore({ idb = globalThis.indexedDB, codec, legacy, uuid = () => globalThis.crypto.randomUUID() }) {
  let opened = null;
  const local = guardedLocal(legacy); // when IndexedDB will not open — see guardedLocal
  let lastOpenFailed = false; // only for the bound: a write that goes to storage.local must fit ITS bound
  let migrated = false;
  const cache = new Map(); // key → { rev, json }
  const newRev = () => uuid(); // never repeats — a repeated rev would hide another tab's write from this cache (Codex 1R)
  const db = () => {
    if (!opened) {
      const req = idb.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'key' });
        if (!d.objectStoreNames.contains(BODY)) d.createObjectStore(BODY, { keyPath: 'key' });
      };
      opened = reqPromise(req);
      opened.catch(() => { opened = null; });
    }
    return opened;
  };
  /** true = IndexedDB is open. Else the op goes to `local` (guardedLocal: fails once entries moved — Codex 1R #2). */
  const usable = async () => {
    try { await db(); lastOpenFailed = false; return true; } catch { lastOpenFailed = true; return false; } // not cached: the next op tries again
  };
  /** Revs of every key, and the bodies this page has not inflated at that rev — one snapshot. */
  async function readRaw(onlyKey = null) {
    const tx = (await db()).transaction([META, BODY], 'readonly');
    const metas = [];
    const bodies = new Map();
    const metaStore = tx.objectStore(META);
    const bodyStore = tx.objectStore(BODY);
    const want = (m) => { const c = cache.get(m.key); if (!c || c.rev !== m.rev) { const r = bodyStore.get(m.key); r.onsuccess = () => { if (r.result) bodies.set(m.key, r.result.z); }; } };
    if (onlyKey) {
      const r = metaStore.get(onlyKey);
      r.onsuccess = () => { if (r.result) { metas.push(r.result); want(r.result); } };
    } else {
      const r = metaStore.getAll();
      r.onsuccess = () => { for (const m of r.result || []) { metas.push(m); want(m); } };
    }
    await txDone(tx);
    return { metas, bodies };
  }
  async function inflate({ metas, bodies }) {
    const out = {};
    for (const m of metas) {
      let json = null;
      const c = cache.get(m.key);
      if (c && c.rev === m.rev) json = c.json;
      else if (bodies.has(m.key)) {
        // A body that will not inflate FAILS THE READ (Codex 1R #1): read as a malformed row it would
        // be deleted by the next write, and a failure here may be the platform's, not the data's.
        json = await codec.unzip(bodies.get(m.key));
        cache.set(m.key, { rev: m.rev, json });
      }
      // Inflated but not JSON (or a rev without a body): a malformed row — history.js rejects it.
      try { out[m.key] = json === null ? null : JSON.parse(json); } catch { out[m.key] = null; }
    }
    return out;
  }
  async function put(set, remove) {
    const rows = [];
    for (const [key, value] of Object.entries(set || {})) {
      const json = JSON.stringify(value);
      rows.push({ key, rev: newRev(), json, z: await codec.zip(json) });
    }
    const tx = (await db()).transaction([META, BODY], 'readwrite');
    const metaStore = tx.objectStore(META);
    const bodyStore = tx.objectStore(BODY);
    for (const key of remove || []) { metaStore.delete(key); bodyStore.delete(key); }
    for (const r of rows) { bodyStore.put({ key: r.key, z: r.z }); metaStore.put({ key: r.key, rev: r.rev }); }
    await txDone(tx);
    for (const key of remove || []) cache.delete(key);
    for (const r of rows) cache.set(r.key, { rev: r.rev, json: r.json });
  }
  /** Move the chrome.storage.local entries over once: copy what IndexedDB does not have, then drop them there. */
  async function migrate() {
    if (migrated) return;
    const old = await legacy.getAll();
    if (!old.ok) throw new Error('legacy read failed'); // the read fails — never an empty-looking history (Codex 1R 후속)
    const keys = Object.keys(old.all);
    // The mark first — even with nothing to move: from here on entries are written HERE, and no page
    // may take storage.local for the history (see usable()).
    if (!(await legacy.markMoved())) throw new Error('mark write failed');
    if (keys.length) {
      // ONE rule, nothing judged (Codex 2R–4R — every 「which copy is newer」 rule lost a row in some
      // corner): a key IndexedDB does not have is copied, and ONLY what was copied here is removed
      // from storage.local. A key already in IndexedDB is left alone in both places — its local copy
      // is never read again (the mark) and never deleted, so no row is ever lost.
      const { metas } = await readRaw();
      const have = new Set(metas.map((m) => m.key));
      const set = {};
      for (const k of keys) if (!have.has(k) && old.all[k] && typeof old.all[k] === 'object') set[k] = old.all[k];
      await put(set, []);
      const copied = Object.keys(set);
      if (copied.length && !(await legacy.write(null, copied))) return; // the copies are in; the next read retries the removal
    }
    migrated = true;
  }
  return {
    kind: 'idb',
    // fitEntry measures against this; after a failed open the write goes to storage.local, so its bound.
    get maxEntryBytes() { return lastOpenFailed ? legacy.maxEntryBytes : HISTORY_ENTRY_MAX_BYTES_IDB; },
    async getAll() {
      try {
        if (!(await usable())) return local.getAll();
        await migrate();
        return { ok: true, all: await inflate(await readRaw()) };
      } catch { return { ok: false, all: {} }; }
    },
    async getOne(key) {
      try {
        if (!(await usable())) return local.getOne(key);
        const raw = await readRaw(key);
        const all = await inflate(raw);
        return { ok: true, value: Object.hasOwn(all, key) ? all[key] : undefined };
      } catch { return { ok: false, value: undefined }; }
    },
    async write(set, remove) {
      try {
        if (!(await usable())) return local.write(set, remove);
        await put(set, remove);
        return true;
      } catch { return false; }
    },
  };
}

/** The store the page uses: IndexedDB + compression when the platform has both, else chrome.storage.local. */
export function createEntryStore({ storage, lastErr, idb = globalThis.indexedDB, codec = zipCodec() } = {}) {
  if (!storage) return null;
  const legacy = localEntryStore(storage, lastErr);
  if (!idb || typeof idb.open !== 'function' || !codec) return guardedLocal(legacy); // honours the mark too (Codex 2R #1)
  return idbEntryStore({ idb, codec, legacy });
}
