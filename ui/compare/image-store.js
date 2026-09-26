// ui/compare/image-store.js — the images a round carried, kept so the user can SEE them again
// (2026-09-26, user request: 「히스토리를 확인해봐도 내가 어떤 이미지를 올렸는지 알 수가 없어」).
//
// A turn that carried images keeps their ids (the history entry stays small — see
// IMAGE_DB_NAME in constants.js for why the pictures are not in it). This module owns the pictures:
//
//   add(id, source)        at send — a PREVIEW is made from the file (long edge ≤ 1600, re-encoded)
//                          and held in memory for this page. Nothing touches the disk yet.
//   persist(session, ids)  at the history write (persistSession) — the ONLY way a preview reaches
//                          IndexedDB. So an incognito session (no history write) and a round that
//                          was rolled back (never written) leave nothing on disk.
//   url(id)                for an <img>: memory first, then IndexedDB; null when the preview is gone.
//   forget(sessions) / clear() / sweep(liveSessions)
//                          follow the history: a deleted, evicted or cleared entry takes its images
//                          with it, and anything no entry names (a missed delete, another tab's
//                          abandoned session) is removed once it is IMAGE_ORPHAN_MIN_AGE_MS old.
//
// Pure of the page: the backend (IndexedDB), the preview maker (canvas) and URL are injected, so
// the guard drives the logic with in-memory fakes — test/lib/mini-dom.mjs has none of the three.

import {
  IMAGE_DB_NAME, IMAGE_DB_VERSION, IMAGE_STORE, IMAGE_SESSION_INDEX,
  IMAGE_PREVIEW_MAX_EDGE, IMAGE_PREVIEW_TYPE, IMAGE_PREVIEW_QUALITY,
  IMAGE_ID_RE, IMAGE_ORPHAN_MIN_AGE_MS,
} from './constants.js';

/** An id this page could have minted — the only kind ever looked up or stored. */
export function isImageId(v) {
  return typeof v === 'string' && IMAGE_ID_RE.test(v);
}

/** The image ids of a marker, validated and capped at `max`; [] for anything else (an older marker has none). */
export function imageIdsOf(v, max) {
  return Array.isArray(v) ? v.filter(isImageId).slice(0, max) : [];
}

/**
 * The preview of an image Blob: decoded, scaled so its long edge is at most
 * IMAGE_PREVIEW_MAX_EDGE, re-encoded. null when this browser cannot decode it — the turn then
 * shows the file's name, as it always did.
 */
export async function makePreviewBlob(blob, { createImageBitmap: decode = globalThis.createImageBitmap, OffscreenCanvas: Canvas = globalThis.OffscreenCanvas } = {}) {
  if (typeof decode !== 'function' || typeof Canvas !== 'function') return null;
  let bmp = null;
  try {
    bmp = await decode(blob);
    const scale = Math.min(1, IMAGE_PREVIEW_MAX_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new Canvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    return await canvas.convertToBlob({ type: IMAGE_PREVIEW_TYPE, quality: IMAGE_PREVIEW_QUALITY });
  } catch {
    return null;
  } finally {
    try { bmp?.close?.(); } catch { /* already released */ }
  }
}

const reqPromise = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

/**
 * The IndexedDB backend: one object store of `{ id, session, blob, at }`, keyed by `id`, indexed by
 * `session`. Every method rejects on failure; the store above treats a failure as "not kept".
 */
export function idbBackend(idb = globalThis.indexedDB) {
  let opened = null;
  const db = () => {
    if (!idb) return Promise.reject(new Error('no indexedDB'));
    if (!opened) {
      const req = idb.open(IMAGE_DB_NAME, IMAGE_DB_VERSION);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(IMAGE_STORE, { keyPath: 'id' });
        store.createIndex(IMAGE_SESSION_INDEX, 'session');
      };
      opened = reqPromise(req);
      // A failed open is not cached: the next call tries again.
      opened.catch(() => { opened = null; });
    }
    return opened;
  };
  const run = async (mode, fn) => {
    const tx = (await db()).transaction(IMAGE_STORE, mode);
    const out = fn(tx.objectStore(IMAGE_STORE));
    await txDone(tx);
    return out;
  };
  return {
    put: (rec) => run('readwrite', (s) => { s.put(rec); }),
    get: async (id) => {
      let rec = null;
      await run('readonly', (s) => { const r = s.get(id); r.onsuccess = () => { rec = r.result || null; }; });
      return rec;
    },
    /** Delete every record of these sessions. */
    forget: (sessions) => run('readwrite', (s) => {
      const idx = s.index(IMAGE_SESSION_INDEX);
      for (const session of sessions) {
        const cur = idx.openKeyCursor(session); // a key is its own exact-match query
        cur.onsuccess = () => { const c = cur.result; if (c) { s.delete(c.primaryKey); c.continue(); } };
      }
    }),
    clear: () => run('readwrite', (s) => { s.clear(); }),
    /** Delete every record whose session `keep` does not name and whose `at` is before `before`. */
    sweep: (keep, before) => run('readwrite', (s) => {
      const cur = s.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        const v = c.value || {};
        if (!keep.has(v.session) && !(v.at >= before)) c.delete();
        c.continue();
      };
    }),
  };
}

/**
 * The store the page uses. `backend` null → nothing is persisted (previews live for the page only).
 */
export function createImageStore({ backend = null, makePreview = makePreviewBlob, urls = globalThis.URL, now = () => Date.now(), delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  // id → Promise<Blob|null> — the previews this page made (add) or read back (url).
  const mem = new Map();
  // id → Blob, once a preview EXISTS. 🔴 persist() writes only these, never waits and never comes
  // back for one later (Codex img 2/2 2R·3R): it runs inside the cross-tab history lock, where a
  // wait (a large image still decoding) outlasted another tab's lock timeout and let its delete run
  // unserialised; and a "write it when it lands" callback wrote into whatever session was current
  // by then — resurrecting a deleted one, or missing the one it belonged to. The page starts the
  // preview when the file is ATTACHED, so it is ready long before the round's history write; one
  // that is not is simply not kept (the next write of that session keeps it, if there is one).
  const ready = new Map();
  // ids whose preview attempt has finished (made or not) — what whenReady() no longer waits for.
  const settled = new Set();
  // id → object URL, for the page's lifetime. 🔴 Never revoked early (Codex 1R): a URL handed to an
  // <img> that has not loaded yet would break it — a bounded cache revoked URLs its own callers were
  // still about to use. The page holds only the images its sessions carried.
  const urlCache = new Map();
  // 🔴 What a delete already removed must not come back (Codex 1R): a persist that was waiting on its
  // preview when forget()/clear() ran would otherwise write the image again, fresh enough for the
  // sweep to keep it a day. A forgotten session id never returns (a deleted live session rotates to
  // a new id), and a clear() ends every persist that started before it.
  const forgotten = new Set();
  let clearEpoch = 0;

  return {
    /** Start the preview of an image this page is sending. Never throws; never writes the disk. */
    add(id, source) {
      if (!isImageId(id) || !source || mem.has(id)) return;
      const made = Promise.resolve().then(() => makePreview(source)).catch(() => null);
      mem.set(id, made);
      made.then((blob) => { settled.add(id); if (blob) ready.set(id, blob); });
    },

    /**
     * A promise that settles once the previews of `ids` this page is still making are done, or after
     * `ms` — or null when none of them is pending. #1684: an answer's image lands right before its
     * DONE, so the round's write can miss its preview; the history writes it on its own once this
     * settles (history.js persistLateImages). Never awaited inside the history lock — see `ready`.
     */
    whenReady(ids, ms) {
      const waits = (ids || []).filter((id) => mem.has(id) && !settled.has(id)).map((id) => mem.get(id));
      if (!waits.length) return null;
      return Promise.race([Promise.all(waits), delay(ms)]).then(() => undefined, () => undefined);
    },

    /** An object URL for the preview, or null when there is none (never made, or gone). */
    async url(id) {
      if (!isImageId(id)) return null;
      if (urlCache.has(id)) return urlCache.get(id);
      let blob = mem.has(id) ? await mem.get(id) : null;
      if (!blob && backend) {
        try { blob = (await backend.get(id))?.blob || null; } catch { blob = null; }
        if (blob) { mem.set(id, Promise.resolve(blob)); ready.set(id, blob); }
      }
      if (!blob || typeof urls?.createObjectURL !== 'function') return null;
      // Another call may have made one while this one awaited.
      if (urlCache.has(id)) return urlCache.get(id);
      const url = urls.createObjectURL(blob);
      urlCache.set(id, url);
      return url;
    },

    /**
     * Write the previews of `ids` under `session` — at the history write, so only a session the
     * user keeps reaches the disk. Idempotent (a put replaces), and re-keys a preview whose
     * session id rotated (a deleted live session writes on under its new id).
     */
    async persist(session, ids) {
      if (!backend || typeof session !== 'string' || !session) return;
      const epoch = clearEpoch;
      for (const id of ids) {
        if (!isImageId(id) || !mem.has(id)) continue;
        const blob = ready.get(id);
        if (!blob) continue;   // not made (yet, or ever) — see `ready`
        // Checked right before each write: a delete in this tab may have run since the last one.
        if (forgotten.has(session) || epoch !== clearEpoch) return;
        try { await backend.put({ id, session, blob, at: now() }); } catch { /* not kept — the turn shows the name */ }
      }
    },

    async forget(sessions) {
      const list = (sessions || []).filter((s) => typeof s === 'string' && s);
      for (const s of list) forgotten.add(s);
      if (!backend || !list.length) return;
      try { await backend.forget(list); } catch { /* the sweep catches it later */ }
    },

    async clear() {
      clearEpoch += 1;
      if (!backend) return;
      try { await backend.clear(); } catch { /* the sweep catches it later */ }
    },

    /** Remove what no live session names, once it is old enough to be nobody's work in progress. */
    async sweep(liveSessions) {
      if (!backend) return;
      const keep = new Set((liveSessions || []).filter((s) => typeof s === 'string' && s));
      try { await backend.sweep(keep, now() - IMAGE_ORPHAN_MIN_AGE_MS); } catch { /* next time */ }
    },
  };
}
