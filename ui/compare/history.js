// ui/compare/history.js — the LOCAL HISTORY slice of mountComparePage() (compare.js): the
// chrome.storage.local entries (one key per session), the cross-tab lock, snapshot / fit /
// persist, the validated read (normalizeEntry), the panel list and loading a stored session.
// Bodies are exactly as they were in compare.js (test/mutants/compare-page.json anchors on them).
//
// The `ctx` contract (the template for every ui/compare/*.js slice):
//   • compare.js builds ONE `ctx` right after `state`, `track` and the DOM helpers, holding the
//     stable platform refs (chrome, doc, win, clock, nav, con, t, state, el/clear/link/dot, track,
//     deps, …); those may be destructured at install time (the `const { … } = ctx` below).
//   • compare.js registers its own nested functions on ctx (`Object.assign(ctx, {…})`, hoisted
//     declarations) and attaches DOM refs AS THEY ARE CREATED (`ctx.qInput = qInput`). A slice
//     therefore calls another file's function as `ctx.name(...)` AT CALL TIME and reads DOM refs
//     lazily (`ctx.historyList`) — never destructure either at install (TDZ / not created yet).
//   • install runs BEFORE the page DOM is built and registers functions only; nothing here runs
//     at install. Same-file calls stay bare. Every function another file calls is registered on
//     ctx at the end (`Object.assign(ctx, { … })`); compare.js destructures what it needs after
//     the install block. A `let` shared across files goes through a ctx field (ctx.pendingLoad)
//     or a setter registered by its owner (ctx.bumpStatusEpoch).

import { imageIdsOf } from './image-store.js';
import { outImagesMarker, readOutImagesMarker, outImageCountOf } from './output-images.js';
import { COMPARE_PROVIDERS, MAX_COLUMNS, colIdOf, parseColId, normalizeColId, MODEL_ID_RE, HISTORY_KEY_PREFIX, HISTORY_LOCK_NAME, HISTORY_LOCK_WAIT_MS, HISTORY_MAX, HISTORY_TEXT_MAX, HISTORY_ENTRY_MAX_BYTES, CONTINUATION_MAX_KEYS, CONTINUATION_MAX_VALUE_CHARS, HISTORY_QUESTION_PREVIEW, SUMMARY_MIN_COLUMNS, SUMMARY_QUESTION_MAX, SUMMARY_MODEL_LABEL_MAX, HISTORY_ATTACH_NAME_MAX, ATTACH_MAX_FILES, TURN_KIND_SUMMARY, OUT_IMAGE_PERSIST_WAIT_MS } from './constants.js';
import { autoGrow } from './helpers.js';

/** Installs the history slice onto `ctx` (see the header and compare.js for the ctx contract). */
export function installHistory(ctx) {
  const { chrome, deps, state, t, clock, nav, con, src, el, clear, dot, track } = ctx;
  // ── local history (recent sessions) ──
  // Storage: chrome.storage.local (an extension page has it directly); injectable for the flow guard,
  // absent in mini-dom → the feature stays hidden. Every write is serialised so a settle and a
  // delete cannot interleave into a lost update.
  const historyStorage = deps.historyStorage || (chrome && chrome.storage && chrome.storage.local) || null;
  let historyChain = Promise.resolve();
  // Cross-tab serialisation (Codex 8R #1): two compare tabs share ONE chrome.storage.local, and a
  // history op is read → validate → decide → write. Tab A's read may reject a key that tab B
  // re-saves valid before A's delete lands — the in-page promise chain only serialises ops of the
  // SAME tab. Every extension page lives on the chrome-extension:// origin, so a Web Lock under
  // one name serialises the ops of every tab; the compare-and-delete re-read stays as the second
  // line of defence. Without `navigator.locks` (the flow guard's mini env, an old browser) the
  // op runs directly under the in-page chain. The wait for the lock is bounded
  // (HISTORY_LOCK_WAIT_MS) through an AbortController driven by the injected clock — not
  // `AbortSignal.timeout`, whose real timer the flow guard could not advance: on abort the op runs
  // degraded (in-page chain only), the user sees nothing, the console says so once.
  const historyLocks = nav && nav.locks && typeof nav.locks.request === 'function' ? nav.locks : null;
  let lockTimeoutLogged = false;
  async function underHistoryLock(fn) {
    if (!historyLocks) return fn();
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? clock.setTimeout(() => { try { ac.abort(); } catch { /* already settled */ } }, HISTORY_LOCK_WAIT_MS) : null;
    try {
      return await historyLocks.request(HISTORY_LOCK_NAME, ac ? { signal: ac.signal } : {}, fn);
    } catch (e) {
      if (!(ac && ac.signal.aborted)) throw e;
      if (!lockTimeoutLogged) {
        lockTimeoutLogged = true;
        if (con && typeof con.warn === 'function') { try { con.warn(`[compare] history lock not granted within ${HISTORY_LOCK_WAIT_MS} ms — running this op without cross-tab serialisation`); } catch { /* logging is not the op */ } }
      }
      return fn();
    } finally {
      if (timer != null) clock.clearTimeout(timer);
    }
  }
  let lastHistoryCount = 0; // from the last SUCCESSFUL read — what the button shows
  const lastErr = () => { try { return chrome && chrome.runtime ? chrome.runtime.lastError : null; } catch { return null; } };
  /** Every stored entry (any key with the prefix), newest first; `ok:false` when the read failed. */
  function storageReadAll() {
    return new Promise((resolve) => {
      const done = (all, failed) => {
        if (failed || !all || typeof all !== 'object') { resolve({ ok: false, list: [] }); return; }
        // Every entry is validated HERE, once, as it leaves storage (Codex 5R #2): the list, the
        // search and a load all see normalised entries; one with malformed content anywhere inside
        // is dropped whole — never sanitised into something that then replaces the live session.
        // A row that makes the validator itself throw is just another rejected row (6R #2). The
        // rejected keys ride along so the next history op deletes them (6R #3), and every
        // history-prefixed key so 「모두 삭제」 clears the invalid ones too.
        const keys = Object.keys(all).filter((k) => k.startsWith(HISTORY_KEY_PREFIX));
        const list = [];
        const rejected = [];
        for (const k of keys) {
          let e = null;
          try { e = normalizeEntry(all[k]); } catch { e = null; }
          if (e) list.push(e); else rejected.push(k);
        }
        list.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve({ ok: true, list, keys, rejected });
      };
      try {
        const r = historyStorage.get(null, (v) => done(v, !!lastErr()));
        if (r && typeof r.then === 'function') r.then((v) => done(v, false), () => done(null, true));
      } catch { done(null, true); }
    });
  }
  /** Re-read ONE key and say whether it still fails validation (true) — absent or valid = false. */
  function storageKeyInvalid(key) {
    return new Promise((resolve) => {
      const done = (v, failed) => {
        if (failed || !v || typeof v !== 'object' || !Object.hasOwn(v, key)) { resolve(false); return; }
        let e = null;
        try { e = normalizeEntry(v[key]); } catch { e = null; }
        resolve(e === null);
      };
      try {
        const r = historyStorage.get(key, (v) => done(v, !!lastErr()));
        if (r && typeof r.then === 'function') r.then((v) => done(v, false), () => done(null, true));
      } catch { done(null, true); }
    });
  }
  /** Write entries / remove keys; resolves true only when storage reported success. */
  function storageWrite(setObj, removeKeys) {
    const call = (fn, arg) => new Promise((resolve) => {
      try {
        const r = fn(arg, () => resolve(!lastErr()));
        if (r && typeof r.then === 'function') r.then(() => resolve(true), () => resolve(false));
      } catch { resolve(false); }
    });
    return (async () => {
      let ok = true;
      if (removeKeys && removeKeys.length) ok = (await call((a, cb) => historyStorage.remove(a, cb), removeKeys)) && ok;
      if (setObj && Object.keys(setObj).length) ok = (await call((a, cb) => historyStorage.set(a, cb), setObj)) && ok;
      return ok;
    })();
  }
  /**
   * One history operation under the chain: `mutate(list)` → `{ set?: {key: entry}, remove?: [key] }`
   * or null (read only). A failed READ runs no mutation (Codex hist 1R #5: never rebuild history
   * from an empty read); the resolved list is re-read after a write so callers paint the truth.
   */
  function historyUpdate(mutate) {
    if (!historyStorage) return Promise.resolve({ ok: false, list: [] });
    const step = historyChain.then(() => underHistoryLock(async () => {
      const read = await storageReadAll();
      if (!read.ok) return read;
      const change = mutate ? mutate(read.list, read.keys) : null;
      if (!change) { lastHistoryCount = read.list.length; return read; }
      // Rows the validator rejected are deleted with a WRITING op (save / delete / clear — never a
      // read-only open), so an invalid row does not linger as a physical key re-validated on every
      // open (6R #3) — but only after a compare-and-delete (7R #2): another tab may have re-saved
      // a valid entry under that key since this read, so each one is re-read right before and
      // deleted only while it is STILL invalid.
      const stale = read.rejected.filter((k) => !(change.set && Object.hasOwn(change.set, k)) && !(change.remove || []).includes(k));
      const stillInvalid = [];
      for (const k of stale) if (await storageKeyInvalid(k)) stillInvalid.push(k);
      const remove = [...(change.remove || []), ...stillInvalid];
      const ok = await storageWrite(change.set, remove);
      // `afterWrite` (2026-09-26): what must follow a SUCCESSFUL write while the cross-tab lock is
      // still held — the images of the entries it wrote or removed. Inside the lock so another tab's
      // delete cannot land between this write and its images (Codex img 2/2 #2: a delete in tab B,
      // then tab A's late image write, resurrected the images of an entry that no longer exists).
      if (ok && typeof change.afterWrite === 'function') { try { await change.afterWrite(); } catch { /* the sweep catches it */ } }
      const after = await storageReadAll();
      if (after.ok) lastHistoryCount = after.list.length;
      return ok && after.ok ? after : { ok: false, list: after.list };
    })).catch(() => ({ ok: false, list: [] }));
    historyChain = step.then(() => undefined, () => undefined);
    return step;
  }
  const historyKey = (id) => `${HISTORY_KEY_PREFIX}${id}`;
  const newSessionId = () => {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch { /* no crypto */ }
    return `s-${clock.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  };
  const clipText = (v) => String(v || '').slice(0, HISTORY_TEXT_MAX);
  /** This session as a storable entry (null when there is nothing to store: no session, incognito, no participating column). */
  function snapshotSession() {
    if (!state.sessionStarted || !state.sessionId || state.sessionSaveHistory !== true) return null;
    const columns = {};
    // Page order (state.columnIds), not the Map's insertion order — a replaced or re-keyed column
    // is re-inserted at the Map's end, and the entry's key order is what the history row's dots show.
    for (const col of ctx.allColumns()) {
      if (!col.participated) continue; // an excluded (hidden) column that took part earlier is still part of the record (Codex hist 1R #2)
      columns[col.id] = {
        provider: col.provider,
        colModel: col.model, // the column's own (requested) model — `model` below is the SERVED one, as before
        // `kind` (C5) only when set — an entry written before the field, or a plain turn, has none.
        turns: col.turns.map(storedTurn),
        model: col.servedModel ? { id: col.servedModel.id == null ? null : String(col.servedModel.id).slice(0, SUMMARY_MODEL_LABEL_MAX), label: String(col.servedModel.label || '').slice(0, SUMMARY_MODEL_LABEL_MAX) } : null,
        continuation: boundContinuation(col.continuation), // bounded like the model labels (6R #4)
      };
    }
    if (!Object.keys(columns).length) return null;
    return { id: state.sessionId, updatedAt: clock.now(), question: clipText(state.question), ...(state.questionImg ? { questionImg: storedImg(state.questionImg) } : {}), src, columns, rounds: state.rounds, ...(Number.isFinite(state.activeRound) ? { activeRound: state.activeRound } : {}), ...(Number.isFinite(state.firstRound) ? { firstRound: state.firstRound } : {}) };
  }
  /**
   * A turn as stored. `kind` / `round` / `model` only when set (an entry written before a field,
   * or a plain turn, has none). A 「요약·비교」 request stores its STRUCTURE, not its text (Codex 3R
   * #2): the prompt is regenerated on reload / retry, so fences and tail can never be lost to the
   * history bound — fitEntry cuts attachment bodies, never structure.
   */
  function storedTurn(turn) {
    const base = { role: turn.role, ...(turn.kind ? { kind: turn.kind } : {}), ...(Number.isFinite(turn.round) ? { round: turn.round } : {}) };
    if (turn.role === 'user' && turn.kind === TURN_KIND_SUMMARY && turn.summary) {
      const sm = turn.summary;
      return { ...base, summary: { judge: sm.judge, round: sm.round, question: clipText(sm.question), attachments: (sm.attachments || []).map((a) => ({ col: a.col, provider: a.provider, model: a.model ? { id: a.model.id, label: a.model.label } : null, text: clipText(a.text), partial: !!a.partial, clipped: !!a.clipped })) } };
    }
    return { ...base, text: clipText(turn.text), ...(turn.errorText ? { errorText: clipText(turn.errorText) } : {}), ...(turn.stalled ? { stalled: true } : {}), ...(turn.cutError ? { cutError: true } : {}), ...(turn.img ? { img: storedImg(turn.img) } : {}), ...(outImagesMarker(turn.outImages) ? { images: outImagesMarker(turn.outImages) } : {}), ...(turn.model ? { model: { id: turn.model.id == null ? null : String(turn.model.id).slice(0, SUMMARY_MODEL_LABEL_MAX), label: String(turn.model.label || '').slice(0, SUMMARY_MODEL_LABEL_MAX) } } : {}) };
  }
  /** The attachment MARKER a turn keeps — name (clipped) and size. Never the image; see HISTORY_ATTACH_NAME_MAX. */
  function storedImg(img) {
    return {
      name: String(img.name || '').slice(0, HISTORY_ATTACH_NAME_MAX),
      bytes: Number.isFinite(img.bytes) ? img.bytes : 0,
      // How many MORE rode with it (#1634) — omitted for a single file, so a 1.33.0 entry is
      // unchanged and a reader that ignores it still reads the entry.
      ...(Number.isFinite(img.more) && img.more > 0 ? { more: img.more } : {}),
      // The image ids (2026-09-26) — the pictures are in the image store, not the entry.
      ...(imageIdsOf(img.ids, ATTACH_MAX_FILES).length ? { ids: imageIdsOf(img.ids, ATTACH_MAX_FILES) } : {}),
    };
  }
  /**
   * Keep the COMPLETE persisted object under HISTORY_ENTRY_MAX_BYTES (6R #4: measured with
   * createdAt / activeRound / firstRound already on it) by halving the clip of what carries the
   * bulk — every answer, every attachment body inside a 「요약·비교」 request (the request's
   * structure — judge, question, fences, tail — is never touched; a cut attachment is marked
   * `clipped` so the regenerated prompt still says so), then the user's own words (a long
   * 「전체」 follow-up is stored once per column) — until it fits. Still over: whole ROUNDS are
   * evicted, oldest first, every turn of that round in every column together (6R blocker: a
   * lone verdict without its request, or answers without their question, must never survive),
   * the round the user is working on (activeRound, else the latest comparison round) last — and
   * when even that has to go, activeRound is dropped with it. null when nothing fits: the entry
   * is then NOT persisted (the caller logs once) rather than written over the bound.
   */
  const jsonBytes = (v) => { const str = JSON.stringify(v); try { return new TextEncoder().encode(str).length; } catch { return str.length * 3; } };
  function fitEntry(entry) {
    const over = () => jsonBytes(entry) > HISTORY_ENTRY_MAX_BYTES;
    let cap = HISTORY_TEXT_MAX;
    for (let i = 0; i < 12 && over(); i++) {
      cap = Math.max(200, Math.floor(cap / 2));
      for (const c of Object.values(entry.columns)) {
        for (const turn of c.turns) {
          if (turn.role === 'assistant' && turn.text.length > cap) turn.text = `${turn.text.slice(0, cap)}…`;
          if (turn.role === 'user' && turn.summary) {
            for (const a of turn.summary.attachments) if (a.text.length > cap) { a.text = a.text.slice(0, cap); a.clipped = true; }
          }
        }
      }
    }
    const mark = `…\n\n_${t('summary_clipped')}_`;
    for (let i = 0; i < 12 && over(); i++) {
      cap = Math.max(200, Math.floor(cap / 2));
      for (const c of Object.values(entry.columns)) for (const turn of c.turns) if (turn.role === 'user' && !turn.summary && turn.text.length > cap) turn.text = `${turn.text.slice(0, cap)}${mark}`;
    }
    // Round-group eviction. A turn without a round (an entry from before provenance) belongs to
    // the oldest group. The protected round is the active one, else the latest comparison round
    // (≥ SUMMARY_MIN_COLUMNS columns with a real answer in it — an image-only answer counts, #1684).
    const roundOf = (turn) => (Number.isFinite(turn.round) ? turn.round : -Infinity);
    const rounds = () => { const set = new Set(); for (const c of Object.values(entry.columns)) for (const turn of c.turns) set.add(roundOf(turn)); return [...set].sort((a, b) => a - b); };
    const protectedRound = () => {
      if (Number.isFinite(entry.activeRound)) return entry.activeRound;
      const per = new Map();
      for (const [p, c] of Object.entries(entry.columns)) for (const turn of c.turns) if (turn.role === 'assistant' && (turn.text || outImageCountOf(turn)) && turn.kind !== TURN_KIND_SUMMARY && Number.isFinite(turn.round)) { if (!per.has(turn.round)) per.set(turn.round, new Set()); per.get(turn.round).add(p); }
      let best = null;
      for (const [r, cols] of per) if (cols.size >= SUMMARY_MIN_COLUMNS && (best === null || r > best)) best = r;
      return best;
    };
    const evict = (round) => { for (const c of Object.values(entry.columns)) c.turns = c.turns.filter((turn) => roundOf(turn) !== round); };
    for (let i = 0; i < 1000 && over(); i++) {
      const all = rounds();
      if (!all.length) break;
      const keep = protectedRound();
      const victim = all.find((r) => r !== keep);
      if (victim === undefined) { evict(keep); delete entry.activeRound; } // only the working round is left and it still does not fit
      else evict(victim);
    }
    // Turns are all gone and it still does not fit (metadata alone over the bound): nothing to write.
    if (over()) return null;
    return entry;
  }
  let unfittableLogged = false;
  /** Once per page: an entry that could not be fitted under the bound was not written (metadata alone over it). */
  function logUnfittable() {
    if (unfittableLogged) return;
    unfittableLogged = true;
    if (con && typeof con.warn === 'function') { try { con.warn('[compare] history entry over the size bound even with every turn evicted — not persisted'); } catch { /* logging is not the write */ } }
  }
  function persistSession() {
    const snap = snapshotSession();
    if (!snap || !historyStorage) return;
    historyUpdate((list) => {
      const prev = list.find((e) => e.id === snap.id);
      // The COMPLETE object is what gets fitted (6R #4): createdAt is on it before it is measured.
      const entry = fitEntry({ ...snap, createdAt: prev && prev.createdAt > 0 ? prev.createdAt : snap.updatedAt });
      if (!entry) { logUnfittable(); return null; }
      // Newest first, HISTORY_MAX kept: the oldest beyond the cap are removed in the same write.
      const rest = list.filter((e) => e.id !== snap.id);
      const evicted = rest.slice(HISTORY_MAX - 1).map((e) => e.id);
      // The images follow the entry (2026-09-26): this session's previews reach the disk only with
      // its write — a session never written (incognito, nothing to store) never puts one there —
      // and an evicted entry's go with it. 🔴 The ids come from the ENTRY being written, not from
      // the page (Codex img 2/2 #1): a write that lands late would otherwise read the NEXT session's
      // markers — an incognito one's included — and store them under this one's id.
      const ids = entryImageIds(entry);
      return {
        set: { [historyKey(entry.id)]: entry },
        remove: evicted.map(historyKey),
        afterWrite: async () => {
          // A preview still being made cannot be written now (#1684: an answer's image lands right
          // before its DONE); once it exists it is written on its own — see persistLateImages.
          // 🔴 Taken BEFORE persist() (Codex B 2R): one that completes while persist() is still
          // writing the others was skipped by it AND no longer pending afterwards — lost for good.
          // A preview that makes it into both is simply written twice (persist is idempotent).
          // Its own try (Codex B 3R follow-up): a failure here must not cost the images persist() can write now.
          let late = null;
          try { late = typeof ctx.imageStore.whenReady === 'function' ? ctx.imageStore.whenReady(ids, OUT_IMAGE_PERSIST_WAIT_MS) : null; } catch { late = null; }
          if (late) late.then(() => persistLateImages(entry.id, ids));
          await ctx.imageStore.persist(entry.id, ids);
          if (evicted.length) await ctx.imageStore.forget(evicted);
        },
      };
    }).then((r) => syncHistoryButton(r.ok ? r.list : null));
  }
  /**
   * The previews of `ids` for the stored entry `entryId`, once they exist (#1684). 🔴 Decided INSIDE
   * the history lock from what is stored NOW, never from the page: only while that entry still
   * exists and still names the image — a delete in any tab since the write wins (nothing is
   * resurrected), and a switch to another conversation meanwhile changes nothing (the entry was
   * already written; the wait never held the conversation back). The round's write itself never
   * waits (Codex B 1R: a wait before the write lost the round to a 「새 대화」 and resurrected an
   * entry another tab had deleted). Idempotent: persist() re-puts what is already there.
   */
  function persistLateImages(entryId, ids) {
    historyUpdate((list) => {
      const stored = list.find((e) => e.id === entryId);
      if (!stored) return null;
      const named = new Set(entryImageIds(stored));
      const keep = ids.filter((id) => named.has(id));
      if (!keep.length) return null;
      return { afterWrite: () => ctx.imageStore.persist(entryId, keep) };
    });
  }
  /** Every image id a stored entry names (its first-round bubble and every turn). */
  function entryImageIds(entry) {
    const ids = [...imageIdsOf(entry.questionImg && entry.questionImg.ids, ATTACH_MAX_FILES)];
    for (const c of Object.values(entry.columns || {})) {
      for (const turn of (c && c.turns) || []) {
        if (turn && turn.img) ids.push(...imageIdsOf(turn.img.ids, ATTACH_MAX_FILES));
        // The answer's own images (#1684; `null` slots are failures and are filtered here) — without them here they are never persisted, and the
        // orphan sweep would then remove the previews of a kept entry.
        if (turn && turn.images) ids.push(...imageIdsOf(turn.images.ids, ATTACH_MAX_FILES));
      }
    }
    return [...new Set(ids)];
  }
  /** Case-insensitive substring match over the question and every stored turn (answers and error lines are text too). */
  function historyMatches(entry, term) {
    if (String(entry.question || '').toLowerCase().includes(term)) return true;
    for (const c of Object.values(entry.columns || {})) {
      for (const turn of c && Array.isArray(c.turns) ? c.turns : []) if (String(turn.text || '').toLowerCase().includes(term)) return true;
    }
    return false;
  }
  function syncHistoryButton(list) {
    const n = Array.isArray(list) ? list.length : lastHistoryCount;
    // Always visible once storage is reachable: an empty panel says 「저장된 대화가 없어요」 — a
    // button that only appears after the first saved conversation was invisible to a fresh install.
    ctx.historyBtn.hidden = !historyStorage;
    ctx.historyBtn.textContent = n ? t('history_btn_n', n) : t('history_btn');
    ctx.historyBtn.title = t('history_title');
  }
  /** 「2시간 전」-style relative time for the list (minutes / hours / days; older = the date). */
  function relativeTime(ts) {
    const diff = Math.max(0, clock.now() - ts);
    const m = Math.floor(diff / 60000);
    if (m < 1) return t('time_just_now');
    if (m < 60) return t('time_minutes_ago', m);
    const h = Math.floor(m / 60);
    if (h < 24) return t('time_hours_ago', h);
    const d = Math.floor(h / 24);
    if (d < 7) return t('time_days_ago', d);
    const date = new Date(ts);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
  }
  /** A fresh read from storage: cache it, then paint through the current search term. */
  function renderHistoryList(list) {
    state.historyCache = Array.isArray(list) ? list : [];
    paintHistoryList();
  }
  function paintHistoryList() {
    const all = state.historyCache;
    clear(ctx.historyList);
    if (!all.length) { ctx.historyList.appendChild(el('p', 'cmp-history-empty', t('history_empty'))); ctx.historyClearBtn.disabled = true; return; }
    ctx.historyClearBtn.disabled = false;
    const term = String(ctx.historySearch.value || '').trim().toLowerCase();
    const list = term ? all.filter((entry) => historyMatches(entry, term)) : all;
    if (!list.length) { ctx.historyList.appendChild(el('p', 'cmp-history-empty', t('history_search_none'))); return; }
    for (const entry of list) {
      const row = el('div', 'cmp-history-item');
      row.setAttribute('data-id', entry.id);
      if (entry.id === state.sessionId) row.classList.add('is-current');
      const open = el('button', 'cmp-history-open');
      open.type = 'button';
      const q = String(entry.question || '').split('\n')[0];
      open.appendChild(el('span', 'cmp-history-q', q.length > HISTORY_QUESTION_PREVIEW ? `${q.slice(0, HISTORY_QUESTION_PREVIEW)}…` : q));
      const meta = el('span', 'cmp-history-meta');
      for (const key of Object.keys(entry.columns || {})) { const parsed = parseColId(key); if (parsed) meta.appendChild(dot(parsed.provider)); }
      const resumable = !!(entry.columns && Object.values(entry.columns).some((c) => c && c.continuation));
      meta.appendChild(el('span', null, [relativeTime(entry.updatedAt), resumable ? t('history_resumable') : t('history_readonly')].filter(Boolean).join(' · ')));
      open.appendChild(meta);
      open.setAttribute('aria-label', t('history_open_aria', q));
      open.addEventListener('click', () => { loadSession(entry); });
      row.appendChild(open);
      // 「이어서 →」 (C2): the resumable state as a verb — loads the session and puts the caret in
      // the bottom composer. Only where a continuation survived; the row click still just opens.
      if (resumable) {
        const cont = el('button', 'cmp-btn cmp-btn-sm cmp-history-continue', t('history_continue'));
        cont.type = 'button';
        cont.setAttribute('aria-label', t('history_continue_aria', q));
        cont.addEventListener('click', (e) => { e.stopPropagation(); loadSession(entry); ctx.focusQuietly(ctx.followup.input); });
        row.appendChild(cont);
      }
      const del = el('button', 'cmp-history-del');
      del.type = 'button';
      del.textContent = '×';
      del.title = t('history_delete');
      del.setAttribute('aria-label', t('history_delete_aria', q));
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(entry.id); });
      row.appendChild(del);
      ctx.historyList.appendChild(row);
    }
  }
  function openHistoryPanel() {
    if (!historyStorage) return;
    ctx.historyPanel.hidden = false;
    ctx.historyBtn.setAttribute('aria-expanded', 'true');
    track('history_open');
    ctx.historySearch.value = ''; // every open starts unfiltered — a stale term would hide the list behind 「검색 결과 없음」
    historyUpdate(null).then((r) => { renderHistoryList(r.list); syncHistoryButton(r.ok ? r.list : null); });
  }
  function closeHistoryPanel() {
    ctx.historyPanel.hidden = true;
    ctx.historyBtn.setAttribute('aria-expanded', 'false');
  }
  function deleteSession(id) {
    // The live session's id rotates NOW, before the delete is queued: a settle that lands while the
    // delete is in flight then writes under the new id instead of resurrecting the deleted one
    // (Codex hist 1R #3).
    if (id === state.sessionId && state.sessionStarted) state.sessionId = newSessionId();
    // Its images go with it (2026-09-26), under the same lock as the removal.
    historyUpdate(() => ({ remove: [historyKey(id)], afterWrite: () => ctx.imageStore.forget([id]) })).then((r) => {
      renderHistoryList(r.list); syncHistoryButton(r.ok ? r.list : null);
      track('history_delete', { remaining: r.list.length });
    });
  }
  function clearHistory() {
    if (state.sessionStarted) state.sessionId = newSessionId();
    // Every history-prefixed key, valid or not (6R #3) — the read's `keys`, not the validated list.
    historyUpdate((list, keys) => ({ remove: keys, afterWrite: () => ctx.imageStore.clear() })).then((r) => { renderHistoryList(r.list); syncHistoryButton(r.ok ? r.list : null); track('history_clear'); });
  }
  /**
   * Open a stored session in place of whatever is on screen: the question card freezes to its
   * question, every stored column shows its turns, and — when a continuation was stored — the
   * follow-up composers are live through the resume path (a fresh port, SEND{resume}); without
   * one the session is read-only and the notice says so.
   */
  ctx.pendingLoad = null; // an entry chosen before the status built the columns (Codex hist 1R #7)
  /** A continuation within the bounds, copied; null (the column loads / stores read-only) for anything else. */
  function boundContinuation(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    const keys = Object.keys(c);
    if (keys.length > CONTINUATION_MAX_KEYS || keys.some((k) => typeof c[k] !== 'string' || c[k].length > CONTINUATION_MAX_VALUE_CHARS)) return null;
    return { ...c };
  }
  /**
   * A stored entry, validated and normalised BEFORE anything on screen is touched (Codex 4R #2,
   * strict since 5R #2, typed per field since 6R #2): every PRESENT field must have its primitive
   * type — strings, finite numbers, integers, booleans — and is only defaulted when ABSENT (an
   * older entry); a wrong type anywhere, or a summary structure that is present but malformed,
   * makes the whole entry null — it is DROPPED, never sanitised into something that then replaces
   * the live session. Metadata is bounded (model labels, continuations). null when not an entry.
   */
  function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || !entry.columns || typeof entry.columns !== 'object' || Array.isArray(entry.columns)) return null;
    // ABSENT (undefined — an older entry never wrote the field) → default; PRESENT → typed, and
    // `null` counts as present: a string / number slot holding null is a wrong type (7R #1). Only
    // the slots the writer itself leaves null — activeRound / firstRound (no round yet), a
    // continuation (none handed out), a column model or an attachment model (no MODEL event) —
    // accept null. `undefined` from a helper marks a wrong type.
    const str = (v) => (v === undefined ? '' : (typeof v === 'string' ? v : undefined));
    const num = (v) => (v === undefined ? 0 : (typeof v === 'number' && Number.isFinite(v) ? v : undefined));
    const int = (v) => (v == null ? null : (Number.isInteger(v) ? v : undefined)); // nullable by design
    const plain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
    /**
     * An attachment MARKER (#1616 ④): `{name, bytes}` or `undefined` for a malformed one — which,
     * like every other typed field here, drops the WHOLE entry rather than being cleaned up. A
     * history that silently repairs what it reads would let a live session be replaced by a tidied
     * version of a broken one.
     */
    const readImg = (v) => {
      if (!plain(v)) return undefined;
      const name = str(v.name);
      const bytes = num(v.bytes);
      // 🔴 An INTEGER inside the cap (2R follow-up 2). `num()` alone accepted `1.5` and `1e100`,
      // and the marker then read 「외 1.5장」 / 「외 1e+100장」 — a stored file cannot be half a
      // file, and nothing can have ridden with more than the cap allows.
      const more = v.more === undefined ? 0 : num(v.more);
      if (name === undefined || bytes === undefined || bytes < 0) return undefined;
      if (more === undefined || !Number.isInteger(more) || more < 0 || more > ATTACH_MAX_FILES - 1) return undefined;
      // `ids` are optional and only ever filtered (an entry from before them has none, and a bad id
      // costs the thumbnail, never the entry).
      const ids = imageIdsOf(v.ids, ATTACH_MAX_FILES);
      return { name: name.slice(0, HISTORY_ATTACH_NAME_MAX), bytes, ...(more > 0 ? { more } : {}), ...(ids.length ? { ids } : {}) };
    };
    const questionImg = entry.questionImg === undefined ? null : readImg(entry.questionImg);
    if (questionImg === undefined) return null;
    const question = str(entry.question);
    const updatedAt = num(entry.updatedAt);
    const createdAt = num(entry.createdAt);
    const rounds = num(entry.rounds);
    const src = entry.src == null ? null : (typeof entry.src === 'string' ? entry.src : undefined);
    const activeRoundRaw = int(entry.activeRound);
    const firstRoundRaw = int(entry.firstRound);
    if ([question, updatedAt, createdAt, rounds, src, activeRoundRaw, firstRoundRaw].includes(undefined)) return null;
    const model = (m) => {
      if (m == null) return null; // a column / attachment that never got a MODEL event stores null
      if (!plain(m) || (m.id != null && typeof m.id !== 'string') || (m.label != null && typeof m.label !== 'string')) return undefined;
      return { id: m.id == null ? null : m.id.slice(0, SUMMARY_MODEL_LABEL_MAX), label: (m.label || '').slice(0, SUMMARY_MODEL_LABEL_MAX) };
    };
    const continuation = (c) => (c != null && !plain(c) ? undefined : boundContinuation(c));
    const columns = {};
    const seenRounds = new Set();
    // Keys are colIds (`claude:auto`, `claude:claude-opus-5`); a LEGACY entry's keys are bare
    // provider ids and read as that provider's `auto` column. Anything else is not a column.
    const keys = Object.keys(entry.columns);
    if (keys.length > MAX_COLUMNS) return null;
    for (const key of keys) {
      const colId = normalizeColId(key);
      if (!colId || columns[colId]) return null; // a foreign key, or a legacy key colliding with a colId
      const c = entry.columns[key];
      if (c == null) continue;
      if (!plain(c) || (c.turns !== undefined && !Array.isArray(c.turns))) return null;
      const cm = model(c.model);
      const cont = continuation(c.continuation);
      if (cm === undefined || cont === undefined) return null;
      const { provider, model: idModel } = parseColId(colId);
      if (c.provider !== undefined && c.provider !== provider) return null;
      // The column's own REQUESTED model (Codex integration #1): what the thread was using, which may
      // differ from the id's model after an in-session change (`claude:auto` sending Sonnet). Stored =
      // honoured (null = auto); absent (an older entry) = the id's model.
      if (c.colModel !== undefined && c.colModel !== null && (typeof c.colModel !== 'string' || !MODEL_ID_RE.test(c.colModel))) return null;
      const colModel = c.colModel !== undefined ? (c.colModel === null ? null : String(c.colModel)) : idModel;
      const turns = [];
      for (const turn of c.turns || []) {
        if (!plain(turn) || !['user', 'assistant', 'skipped'].includes(turn.role)) return null;
        if (turn.kind !== undefined && typeof turn.kind !== 'string') return null;
        if (turn.stalled !== undefined && typeof turn.stalled !== 'boolean') return null; // #1519, additive: absent on older entries
        if (turn.cutError !== undefined && typeof turn.cutError !== 'boolean') return null; // #1527, same rule — typed like its sibling, not silently dropped
        const round = int(turn.round);
        const text = str(turn.text);
        const errorText = str(turn.errorText);
        const tm = turn.model === undefined ? null : model(turn.model); // absent on a turn = never got a MODEL event
        const img = turn.img === undefined ? null : readImg(turn.img); // absent on every pre-#1616 turn
        const images = turn.images === undefined ? null : readOutImagesMarker(turn.images); // #1684, absent on every older turn
        if (round === undefined || text === undefined || errorText === undefined || tm === undefined || img === undefined || images === undefined) return null;
        const kind = turn.kind === TURN_KIND_SUMMARY ? TURN_KIND_SUMMARY : null;
        let summary = null;
        if (kind && turn.role === 'user') {
          if (turn.summary !== undefined) { summary = storedSummary(turn.summary); if (!summary) return null; } // present (null included) but malformed = the entry is
          // else: a bare-text request from before structures — a plain user turn
        }
        if (round !== null) seenRounds.add(round);
        // Optional fields are OMITTED when empty (not written as null), so a normalised entry is
        // itself valid input — loadSession re-validates what the list hands it.
        const k = kind && (turn.role === 'assistant' || summary) ? kind : null;
        turns.push({ role: turn.role, text, round, model: tm, ...(k ? { kind: k } : {}), ...(summary ? { summary } : {}), ...(errorText ? { errorText } : {}), ...(img && turn.role === 'user' ? { img } : {}), ...(images && turn.role === 'assistant' && images.ids.length ? { images } : {}), ...(turn.stalled === true && turn.role === 'assistant' ? { stalled: true } : {}), ...(turn.cutError === true && turn.role === 'assistant' ? { cutError: true } : {}) });
      }
      columns[colId] = { provider, colModel, turns, model: cm, continuation: cont };
    }
    // The round the user was working on when the entry was written (Codex 5R #1): only when it is
    // one of the stored rounds; otherwise null and the latest comparison round applies. The first
    // SEND round (its request is the question card): as stored, else — an older entry — the
    // lowest stored round.
    const activeRound = activeRoundRaw !== null && seenRounds.has(activeRoundRaw) ? activeRoundRaw : null;
    const lowest = seenRounds.size ? Math.min(...seenRounds) : null;
    const firstRound = firstRoundRaw !== null ? firstRoundRaw : lowest;
    return { id: entry.id, question, ...(questionImg ? { questionImg } : {}), rounds: rounds || 1, columns, activeRound, firstRound, updatedAt, createdAt, src };
  }
  function loadSession(raw) {
    if (state.disabled) return;
    const entry = normalizeEntry(raw);
    if (!entry) return; // not an entry: the session on screen is left as it is
    ctx.closeViewer(); // an image of the session being replaced must not stay on top of the loaded one
    if (!state.columns.size) { ctx.pendingLoad = raw; closeHistoryPanel(); return; } // applied by readStatus once the columns exist
    // Leave whatever is on screen — accepted or not: a first SEND still waiting for its CONSUME_OK
    // keeps a port whose late answer must never land in the loaded session (Codex hist 1R #1).
    if (state.sending && state.port) { try { state.port.postMessage({ type: 'ABORT' }); } catch { /* gone */ } }
    ctx.closePort();
    // The exclusion checkbox is a first-send choice; a stored session shows every column it holds.
    state.excludeSrc = false; ctx.excludeInput.checked = false;
    for (const col of state.columns.values()) col.node.hidden = false;
    state.sending = false; state.resuming = false; state.resumed = false; state.idleEnded = false;
    state.summaryPending = null; state.judgeChoice = null; ctx.closeSummaryPop();
    state.roundInFlight = null;
    ctx.setColumnFocus(null); // a loaded session opens as the grid (the focus was about the session being left)
    state.roundSeq = 0; // re-derived from the stored rounds below (never a leftover of the session being left)
    state.activeRound = entry.activeRound; // the comparison the user was working on when it was saved (validated; null = latest comparison round)
    state.firstRound = entry.firstRound; // the SEND round — the only round whose request is the question card
    state.pendingFollowup = ''; state.roundTargets = []; state.roundStartedAt = null;
    ctx.bumpStatusEpoch();
    for (const col of state.columns.values()) ctx.resetColumn(col);
    ctx.clearCopyFeedback();
    for (const c of ctx.composers) { c.input.value = ''; autoGrow(c.input); }
    ctx.clearNotice();
    state.question = String(entry.question || '');
    state.questionImg = entry.questionImg || null; // the first round's marker rides the entry, not a turn
    state.sessionId = entry.id;
    state.sessionStarted = true;
    state.sessionEnded = true;      // no port carries it: a follow-up resumes (canResume) or is refused
    state.sessionSaveHistory = true; // only kept sessions are stored
    state.rounds = typeof entry.rounds === 'number' ? entry.rounds : 1;
    ctx.commitPrompt(state.question);
    // The entry's columns are shown in the PAGE's order (created next to their service's column when
    // the page does not have them — a stored Opus column next to the page's auto one). The page's
    // other columns are CLOSED for this conversation (closeColumn's state — 새 대화 reopens them):
    // left open they sat beside the thread as empty 「로그인됨 — 새 대화부터」 cards and, being first of
    // their service, carried its plan / gauges / 「같은 계정」 chip (2026-09-26 user feedback).
    ctx.ensureLayout(Object.keys(entry.columns));
    // An entry with no column (never written by snapshotSession — a damaged row) closes nothing: an empty page helps no one (Codex cmp-load 1R 후속).
    if (Object.keys(entry.columns).length) for (const col of ctx.allColumns()) {
      if (Object.prototype.hasOwnProperty.call(entry.columns, col.id)) continue;
      col.closed = true;
      col.node.hidden = true;
    }
    ctx.renderColumns(); // the provider-level UI moves to the first VISIBLE column of each service
    const targets = [];
    for (const colId of Object.keys(entry.columns)) {
      const stored = entry.columns[colId];
      const col = state.columns.get(colId);
      if (!stored || !col || col.id !== colId) continue;
      col.participated = true;
      col.gate = null;
      // The thread's requested model comes back with it (Codex integration #1) — before the turns
      // render and before any resume, so the next FOLLOWUP sends what this thread was using. A
      // user-level fact (modelTouched): the provider seed must not override it.
      col.modelTouched = true;
      col.model = stored.colModel === undefined ? col.model : stored.colModel;
      ctx.renderModelSelect(col);
      ctx.renderPickerLabel(col);
      clear(col.body);
      for (const turn of Array.isArray(stored.turns) ? stored.turns : []) {
        const { round, summary, kind } = turn; // normalised above (normalizeEntry)
        // Round recovery: the next send must not reuse a stored round id (the comparison would pair
        // a new answer with old ones).
        if (round !== null && round > state.roundSeq) state.roundSeq = round; // the next send must not reuse a stored round id
        // A summary request loads from its STRUCTURE (regenerated prompt); one stored as bare text
        // (no structure) is a plain user turn. Absent kind (older entries) = plain.
        // 🔴 `img` rides the restore too. It is not decoration: the retry gate reads it to decide
        // whether a round went out WITH an image, so a marker lost here would let a reloaded
        // session retry an image round without its image — and be charged for it (the very defect
        // 1.33.0's batch review found).
        if (turn.role === 'user') ctx.pushUserTurn(col, summary ? ctx.renderSummaryPrompt(summary) : turn.text, kind, { round, summary, ...(turn.img ? { img: turn.img } : {}) });
        else if (turn.role === 'skipped') ctx.pushSkippedTurn(col);
        else restoreAssistantTurn(col, turn, kind, { round, model: turn.model || stored.model });
      }
      if (stored.model && typeof stored.model === 'object') col.servedModel = { id: stored.model.id == null ? null : String(stored.model.id), label: stored.model.label == null ? '' : String(stored.model.label), source: 'reported' };
      col.continuation = stored.continuation && typeof stored.continuation === 'object' ? stored.continuation : null;
      // Now that the turns are back, the thread's mode is known: the model chosen above (before
      // them) is put back in it (1.35.0 batch review).
      ctx.reconcileMode(col);
      ctx.renderQuestionBubbles(); // this column's thread is restored: its bubble (from entry.question) goes on top
      const last = col.turns[col.turns.length - 1];
      col.status = last && last.role === 'assistant' && last.errorText ? 'error' : 'done';
      col.errorCode = col.status === 'error' ? 'restored' : null;
      ctx.setBadge(col, col.status === 'error' ? 'col_error' : 'col_done', col.status === 'error' ? 'is-error' : 'is-done');
      ctx.renderColumnActions(col);
      targets.push(colId);
    }
    state.followupTargets = new Set(targets);
    state.pendingFollowupCol = null;
    ctx.stopBtn.disabled = true;
    ctx.syncWaitTimer();
    closeHistoryPanel();
    ctx.updateControls();
    ctx.showNotice(ctx.canResume() ? 'info' : 'warn', [t(ctx.canResume() ? 'history_loaded_resumable' : 'history_loaded_readonly')]);
    track('history_load', { resumable: ctx.canResume(), columns: targets.length });
    if (ctx.canResume()) ctx.focusQuietly(ctx.followup.input);
  }
  /** A stored assistant turn: painted settled (no stream), with its error line when it had one. */
  /**
   * A stored summary structure, validated and bounded (Codex 4R #2/#3) — every field is checked
   * for its PRIMITIVE type before anything is converted (a `{toString:null}` where a string was
   * expected must not throw on load), providers come from the catalog, attachments are at most
   * one per provider, labels / question are cut to their bounds. null when it is not one.
   */
  function storedSummary(sm) {
    if (!sm || typeof sm !== 'object' || Array.isArray(sm) || typeof sm.judge !== 'string' || !normalizeColId(sm.judge) || !Array.isArray(sm.attachments)) return null;
    if (sm.question !== undefined && typeof sm.question !== 'string') return null; // written as a string, always
    if (sm.round != null && !Number.isInteger(sm.round)) return null; // nullable: the structure's own round
    const attachments = [];
    for (const a of sm.attachments) {
      if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.provider !== 'string' || !COMPARE_PROVIDERS.includes(a.provider)) return null;
      // `col` (colId) since the column model; a legacy attachment names only the provider = its auto column.
      const col = a.col === undefined ? colIdOf(a.provider, null) : normalizeColId(a.col);
      if (!col || parseColId(col).provider !== a.provider) return null;
      if (a.text !== undefined && typeof a.text !== 'string') return null;
      if ((a.partial !== undefined && typeof a.partial !== 'boolean') || (a.clipped !== undefined && typeof a.clipped !== 'boolean')) return null;
      if (a.model != null && (typeof a.model !== 'object' || Array.isArray(a.model) || (a.model.id != null && typeof a.model.id !== 'string') || (a.model.label != null && typeof a.model.label !== 'string'))) return null; // nullable: no MODEL event
      if (attachments.some((x) => x.col === col)) return null; // one answer per column
      attachments.push({ col, provider: a.provider, model: a.model ? { id: a.model.id == null ? null : a.model.id.slice(0, SUMMARY_MODEL_LABEL_MAX), label: (a.model.label || '').slice(0, SUMMARY_MODEL_LABEL_MAX) } : null, text: a.text || '', partial: a.partial === true, clipped: a.clipped === true });
    }
    if (attachments.length > MAX_COLUMNS) return null;
    return { judge: normalizeColId(sm.judge), round: Number.isFinite(sm.round) ? sm.round : null, question: (sm.question || '').split('\n')[0].slice(0, SUMMARY_QUESTION_MAX), attachments };
  }
  function restoreAssistantTurn(col, stored, kind = null, extra = null) {
    const turn = ctx.pushAssistantTurn(col, kind, extra);
    turn.text = String(stored.text || '');
    if (stored.errorText) { turn.errorText = String(stored.errorText); turn.node.classList.add('is-error'); }
    if (stored.stalled === true) turn.stalled = true;
    if (stored.cutError === true) turn.cutError = true;
    if (stored.images) ctx.restoreOutputImages(turn, stored.images);
    turn.node.classList.remove('is-streaming');
    col.status = 'done';
    ctx.paintAssistant(col);
    ctx.settleTurn(turn);
    if (turn.activity) turn.activity.box.hidden = true;
  }
  // Everything another file reaches (compare.js destructures the names it calls bare).
  Object.assign(ctx, {
    historyStorage, underHistoryLock, lastErr, storageReadAll, storageKeyInvalid, storageWrite, historyUpdate, historyKey,
    newSessionId, clipText, snapshotSession, storedTurn, jsonBytes, fitEntry, logUnfittable, persistSession, persistLateImages,
    historyMatches, syncHistoryButton, relativeTime, renderHistoryList, paintHistoryList, openHistoryPanel, closeHistoryPanel, deleteSession,
    clearHistory, boundContinuation, normalizeEntry, loadSession, storedSummary, restoreAssistantTurn,
  });
}
