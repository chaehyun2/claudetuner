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

import { imageIdsOf, docCountOf, markerKinds } from './image-store.js';
import { createEntryStore } from './history-store.js';
import { outImagesMarker, readOutImagesMarker, outImageCountOf } from './output-images.js';
import { SESSION_ID_RE, COMPARE_PROVIDERS, MAX_COLUMNS, colIdOf, parseColId, normalizeColId, MODEL_ID_RE, HISTORY_KEY_PREFIX, HISTORY_LOCK_NAME, HISTORY_LOCK_WAIT_MS, HISTORY_MAX, HISTORY_TEXT_MAX, CONTINUATION_MAX_KEYS, CONTINUATION_MAX_VALUE_CHARS, HISTORY_QUESTION_PREVIEW, SUMMARY_MIN_COLUMNS, SUMMARY_QUESTION_MAX, SUMMARY_MODEL_LABEL_MAX, HISTORY_ATTACH_NAME_MAX, ATTACH_MAX_FILES, TURN_KIND_SUMMARY, TURN_KIND_DEBATE, OUT_IMAGE_PERSIST_WAIT_MS, CODE_RESTORED, RETRACTION_MAX } from './constants.js';
import { autoGrow, readTiming } from './helpers.js';
import { readDebateRecord, legacyDebateRecord } from './debate-core.js';
import { foldSaveBy, uniformSaveBy, SAVE_MODE_KEPT } from './save-mode.js';
import { SUGGEST_COUNT, SUGGEST_Q_MAX } from './suggest.js';
import { markHistorySnapshot, contentCount } from './history-sync.js';

/** Installs the history slice onto `ctx` (see the header and compare.js for the ctx contract). */
/**
 * First thing cut when an entry is over its byte bound: a debate's COMPOSED PROMPTS (user turns of
 * kind debate). They are never shown — the timeline is rebuilt from the answers and the record's log,
 * and a continued debate goes on in the site's own conversation — yet each one carries the other
 * speakers' words again, ~3× the answers. Cut them before a single answer is touched (2026-09-28 user:
 * a long debate reopened from 「최근」 showed every answer cut to a few hundred chars, `…`). Halves
 * their clip until `over()` is false, down to the same floor answers get (DEBATE_PROMPT_CLIP_MIN) —
 * never to nothing: a debate opened as columns (the flag off) shows each request folded, and copies
 * it (Codex 1R). Mutates `entry`.
 */
export function clipDebatePrompts(entry, over) {
  let cap = HISTORY_TEXT_MAX;
  while (cap > DEBATE_PROMPT_CLIP_MIN && over()) {
    cap = Math.max(DEBATE_PROMPT_CLIP_MIN, Math.floor(cap / 2));
    for (const c of Object.values(entry.columns || {})) {
      for (const turn of c.turns || []) if (turn.role === 'user' && turn.kind === TURN_KIND_DEBATE && typeof turn.text === 'string' && turn.text.length > cap) turn.text = `${turn.text.slice(0, cap)}…`;
    }
  }
}
const DEBATE_PROMPT_CLIP_MIN = 200; // = fitEntry's floor for an answer
// The marker of an attachment that stayed on the browser it was sent from (#2081): an entry opened from
// the server copy (`attachOmitted`) keeps its request's 「there was a file」 — the retry gate reads it
// (compare.js roundHadImage), so such a round is never re-sent without its file.
const OMITTED_IMG = Object.freeze({ name: '', bytes: 0, omitted: true });

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
  let lastHistoryCount = 0; // from the last SUCCESSFUL read — what the button shows (this account's view)
  // The account the status reads have told this page (#2081): a string = that account, null = signed out, undefined =
  // never known. 🔴 UNKNOWN is not signed out (#2117 `loggedIn: null` — the token read timed out; or no status yet):
  // it leaves the account last known as it was.
  let knownAccount;
  /** Take the current status into the known account — called on every status read (compare.js) and on each use. */
  function noteStatusAccount() {
    const st = state.status;
    if (st && st.loggedIn === true && typeof st.owner === 'string' && /^[0-9a-f]{16}$/.test(st.owner)) knownAccount = st.owner;
    else if (st && st.loggedIn === false) knownAccount = null;
    return knownAccount;
  }
  /** The account signed in now, as last known (null signed out or never known) — #2081 decision A / batch r7. */
  function viewerOwner() {
    return noteStatusAccount() || null;
  }
  /**
   * Whether the history is seen per account (batch r7 view, batch r8 split): only with the server sync offered
   * (`compare_history_sync`) AND the account known. Otherwise everything is as before #2081 — every entry listed,
   * opened, searched, deleted; no split at save (pre-CWS batch review: a flag-off page must not hide anyone's history).
   */
  function accountScoped() {
    const st = state.status;
    return !!(st && st.historySyncOn === true && st.flagOn === true) && noteStatusAccount() !== undefined;
  }
  /**
   * What this account sees of the local history (batch r7, user decision): its own entries and the ones written signed
   * out (no owner). Another account's entries stay on disk, hidden — listed, opened, searched, deleted only by it.
   * Unscoped (see accountScoped): every entry.
   */
  function visibleToMe(entry) {
    return !!entry && (!accountScoped() || !entry.owner || entry.owner === viewerOwner());
  }
  /**
   * This account's view as listed: its visible entries, newest first, at most HISTORY_MAX (Codex K2: entries written
   * signed out and an account's own could add up past the cap; the next write of this account evicts the rest).
   */
  function myView(list) {
    return (Array.isArray(list) ? list : []).filter(visibleToMe).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, HISTORY_MAX);
  }
  const lastErr = () => { try { return chrome && chrome.runtime ? chrome.runtime.lastError : null; } catch { return null; } };
  // The entries themselves (#1877): IndexedDB, compressed — chrome.storage.local only as the fallback
  // (and for an injected test storage, which keeps the old behaviour). `historyStorage` stays the
  // page's chrome.storage.local for everything else (the share map).
  const entryStore = deps.historyEntryStore || (deps.historyStorage ? createEntryStore({ storage: historyStorage, lastErr, idb: null }) : createEntryStore({ storage: historyStorage, lastErr }));
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
      entryStore.getAll().then((r) => done(r.ok ? r.all : null, !r.ok), () => done(null, true));
    });
  }
  /** Re-read ONE key and say whether it still fails validation (true) — absent or valid = false. */
  function storageKeyInvalid(key) {
    return new Promise((resolve) => {
      const done = (r) => {
        if (!r || !r.ok || r.value === undefined) { resolve(false); return; }
        let e = null;
        try { e = normalizeEntry(r.value); } catch { e = null; }
        resolve(e === null);
      };
      entryStore.getOne(key).then(done, () => done(null));
    });
  }
  /** Write entries / remove keys; resolves true only when storage reported success. */
  function storageWrite(setObj, removeKeys) {
    return entryStore.write(setObj, removeKeys).then((ok) => ok === true, () => false);
  }
  /**
   * One history operation under the chain: `mutate(list)` → `{ set?: {key: entry}, remove?: [key] }`
   * or null (read only). A failed READ runs no mutation (Codex hist 1R #5: never rebuild history
   * from an empty read); the resolved list is re-read after a write so callers paint the truth.
   */
  function historyUpdate(mutate) {
    if (!historyStorage || !entryStore) return Promise.resolve({ ok: false, list: [] });
    const step = historyChain.then(() => underHistoryLock(async () => {
      const read = await storageReadAll();
      if (!read.ok) return read;
      // `mutate` may be async (#2081: a delete queues its server DELETE inside this same lock op).
      const change = mutate ? await mutate(read.list, read.keys) : null;
      if (!change) { lastHistoryCount = myView(read.list).length; return read; }
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
      if (after.ok) lastHistoryCount = myView(after.list).length;
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
  /**
   * This session as a storable entry (null when there is nothing to store: no session, incognito, no
   * participating column). `anyMode` builds it for an incognito session too — a SHARE (share.js) is
   * the user's explicit upload to our server, which the site-side temporary chat and the local
   * history (what incognito keeps empty) have nothing to do with. The history writer never passes it.
   */
  function snapshotSession({ anyMode = false } = {}) {
    // #1985 (decision 1a): only an ALL-kept session is stored — a mixed one is not. Its incognito
    // provider's words also ride the kept columns' requests (debate deltas, summary attachments),
    // so no per-column filter could keep them out.
    if (!state.sessionStarted || !state.sessionId || (!anyMode && foldSaveBy(state.sessionSaveBy) !== SAVE_MODE_KEPT)) return null;
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
    // A debate session's record (#1769 후속) — what reopens it as the debate, not as columns.
    const debate = ctx.debateSnapshot ? ctx.debateSnapshot(clipText) : null;
    // `forkedFrom` (#2081 §7.8 ③): this session continues another device's conversation — a copy owned here.
    const forked = state.forkOf && state.forkOf.id === state.sessionId ? state.forkOf.from : null;
    // `splitFrom` (batch r8): this session continues an entry of another account (or a signed-out one) — see persistSession.
    const split = state.splitOf && Object.values(state.splitOf.ids).includes(state.sessionId) ? state.splitOf.from : null;
    // `mixed` (pre-CWS batch r2): this session holds words written under more than one account — see persistSession.
    const mixed = isMixedId(state.sessionId, state.mixedEpoch);
    const snap = { ...(debate ? { debate } : {}), ...(forked ? { forkedFrom: forked } : {}), ...(split ? { splitFrom: split } : {}), ...(mixed ? { mixed: true } : {}), id: state.sessionId, updatedAt: clock.now(), question: clipText(state.question), ...(state.questionImg ? { questionImg: storedImg(state.questionImg) } : {}), src, columns, rounds: state.rounds, ...(Number.isFinite(state.activeRound) ? { activeRound: state.activeRound } : {}), ...(Number.isFinite(state.firstRound) ? { firstRound: state.firstRound } : {}) };
    // #2081: only the LOCAL history's snapshot (all-kept, never `anyMode`) is one the server sync may
    // read (history-sync.js syncEntryOf) — the share's snapshot of an incognito session is never marked.
    return anyMode ? snap : markHistorySnapshot(snap);
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
      return { ...base, summary: { judge: sm.judge, round: sm.round, question: clipText(sm.question), attachments: (sm.attachments || []).map((a) => ({ col: a.col, provider: a.provider, model: a.model ? { id: a.model.id, label: a.model.label } : null, text: clipText(a.text), partial: !!a.partial, clipped: !!a.clipped })), ...(sm.suggest ? { suggest: { avoid: storedAvoid(sm.suggest.avoid) } } : {}) } };
    }
    return { ...base, text: clipText(turn.text), ...(turn.errorText ? { errorText: clipText(turn.errorText) } : {}), ...(turn.errorText && turn.openTabLink ? { openTab: true } : {}), ...(turn.stalled ? { stalled: true } : {}), ...(turn.cutError ? { cutError: true } : {}), ...(turn.retracted ? { retracted: true, ...(turn.retraction ? { retraction: String(turn.retraction).slice(0, RETRACTION_MAX) } : {}) } : {}), ...(turn.role === 'assistant' && readTiming(turn.ms) ? { ms: readTiming(turn.ms) } : {}), ...(turn.img ? { img: storedImg(turn.img) } : {}), ...(outImagesMarker(turn.outImages) ? { images: outImagesMarker(turn.outImages) } : {}), ...(turn.role === 'assistant' && turn.attachOmitted === true ? { attachOmitted: true } : {}), ...(turn.model ? { model: { id: turn.model.id == null ? null : String(turn.model.id).slice(0, SUMMARY_MODEL_LABEL_MAX), label: String(turn.model.label || '').slice(0, SUMMARY_MODEL_LABEL_MAX) } } : {}) };
  }
  /** The attachment MARKER a turn keeps — name (clipped) and size. Never the image; see HISTORY_ATTACH_NAME_MAX. */
  function storedImg(img) {
    // An attachment that stayed on another browser (#2081 — the server copy never carries one): only that it was there.
    if (img.omitted === true) return { ...OMITTED_IMG };
    return {
      name: String(img.name || '').slice(0, HISTORY_ATTACH_NAME_MAX),
      bytes: Number.isFinite(img.bytes) ? img.bytes : 0,
      // How many MORE rode with it (#1634) — omitted for a single file, so a 1.33.0 entry is
      // unchanged and a reader that ignores it still reads the entry.
      ...(Number.isFinite(img.more) && img.more > 0 ? { more: img.more } : {}),
      // The image ids (2026-09-26) — the pictures are in the image store, not the entry.
      ...(imageIdsOf(img.ids, ATTACH_MAX_FILES).length ? { ids: imageIdsOf(img.ids, ATTACH_MAX_FILES) } : {}),
      // How many were documents (#1944) — omitted for images only, as `more` is for one file.
      ...(docCountOf(img.docs, ATTACH_MAX_FILES) ? { docs: docCountOf(img.docs, ATTACH_MAX_FILES) } : {}),
      // Each file's kind (2026-10-05) — omitted when the marker has none (an older one).
      ...markerKinds(img),
    };
  }
  /**
   * Keep the COMPLETE persisted object under the store's bound (`entryStore.maxEntryBytes` —
   * HISTORY_ENTRY_MAX_BYTES_IDB, or HISTORY_ENTRY_MAX_BYTES on the storage.local fallback; 6R #4: measured with
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
  function fitEntry(entry, maxBytes = entryStore.maxEntryBytes) {
    // `maxBytes`: the local store's bound, or the server copy's (#2081, HISTORY_SYNC_ENTRY_MAX_BYTES).
    const over = () => jsonBytes(entry) > maxBytes;
    clipDebatePrompts(entry, over);
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
      // A debate's record carries the user's own words (they exist nowhere else) — cut with them.
      if (entry.debate) for (const e of entry.debate.log) if (e.u !== undefined && e.u.length > cap) e.u = `${e.u.slice(0, cap)}…`;
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
  // The session ids whose conversation holds more than one account's words (pre-CWS batch r2), each with the
  // `state.mixedEpoch`s it was marked in. The epoch moves on every open of a stored entry (loadSession): a mark binds the
  // conversation as it was on screen then — every save snapshotted in that epoch finds it, in the lock too (a split or
  // an eviction never loses it: Codex mixed 1R #1); an entry opened later starts from what is stored (2R / 3R #1).
  // Every epoch an id was marked in is kept (Codex mixed 4R #1): a save of an older epoch landing late adds its own,
  // never replacing the one an open marked since.
  const isMixedId = (id, epoch) => !!id && state.mixedIds instanceof Map && state.mixedIds.has(id) && state.mixedIds.get(id).has(epoch);
  function markMixedId(id, epoch) {
    if (!id) return;
    if (!(state.mixedIds instanceof Map)) state.mixedIds = new Map();
    if (!state.mixedIds.has(id)) state.mixedIds.set(id, new Set());
    state.mixedIds.get(id).add(epoch);
  }
  function persistSession() {
    // Another device's conversation, opened read-only (#2081 §7.8 ②③): it is never written here under ITS id —
    // the first write of it (the user continued it) FORKS it: a new session id, owned by this browser.
    if (state.remoteViewId && state.sessionId === state.remoteViewId) {
      state.forkOf = { id: newSessionId(), from: state.remoteViewId };
      state.sessionId = state.forkOf.id;
      state.remoteViewId = null;
    }
    const snap = snapshotSession();
    if (!snap || !historyStorage) return;
    // `owner` (#2081, decision A / batch r8 (a)): the content belongs to the account of the SCREEN it was written on —
    // the account the page's status says at this snapshot, taken with it into the lock and never read again there
    // (a switch while the save waits does not re-attribute it). An entry written signed out has none and never uploads;
    // whether anything uploads is the SW's call (it compares the stamp with the token).
    // Scoped or not is taken with it too: unscoped (sync not offered, or the account never known) saves as before
    // #2081 — no split, the cap counts every entry.
    const snapOwner = viewerOwner();
    const snapScoped = accountScoped();
    const snapEpoch = state.mixedEpoch;
    historyUpdate((list) => {
      let prev = list.find((e) => e.id === snap.id);
      // 🔴 `mixed` (pre-CWS batch r2, local only): unscoped, an entry continued by an account other than its owner (or
      // by one not known) holds both accounts' words. Its owner stays (it is listed, and its server copy deleted, as
      // that account's) but it is NEVER uploaded again — nor is anything split or rotated from it (the taint follows
      // the session ids: `state.mixedIds`, read here too — Codex mixed 1R #1: a snapshot taken before an earlier save's
      // lock op marked the id, landing after the entry was evicted, still finds the mark).
      const tainted = !!snap.mixed || isMixedId(snap.id, snapEpoch) || !!(prev && prev.mixed) || (!snapScoped && !!prev && (prev.owner || null) !== snapOwner);
      // 🔴 One rule (batch r8): the stored entry's owner (none included) differs from the snapshot's → SPLIT: a new
      // session id owned by the snapshot's account (`splitFrom` = the old id, local only); the old entry is not touched.
      if (snapScoped && prev && (prev.owner || null) !== snapOwner) {
        const from = snap.id;
        // A save of the same conversation already split it for this same account (Codex L1 #2: a debate round saves
        // twice, both snapshots under the old id) — that split id again, even if its first write failed or it was
        // deleted since (L2 #2): the screen is on it. Kept PER ACCOUNT (Codex L3 #1): saves queued under B, signed out,
        // then B again still land in B's one split — a split for another account in between does not displace it.
        const key = snapOwner || '';
        const known = state.splitOf && state.splitOf.from === from ? state.splitOf.ids : {};
        const reuse = Object.prototype.hasOwnProperty.call(known, key) ? known[key] : null;
        const target = reuse ? list.find((e) => e.id === reuse && (e.owner || null) === snapOwner) || null : null;
        snap.id = reuse || newSessionId();
        if (!reuse) state.splitOf = { from, ids: { ...known, [key]: snap.id } };
        snap.splitFrom = from;
        if (state.forkOf && state.forkOf.id === from) state.forkOf = { id: snap.id, from: state.forkOf.from };
        if (state.sessionId === from) state.sessionId = snap.id;
        prev = target || null;
      }
      if (tainted) {
        snap.mixed = true;
        markMixedId(snap.id, snapEpoch);
      }
      // Unscoped, an entry keeps the owner it was first stamped with (as before #2081 — `mixed` marks the rest).
      const owner = snapScoped || !prev ? snapOwner : prev.owner || null;
      // The COMPLETE object is what gets fitted (6R #4): createdAt is on it before it is measured.
      // Object.assign, not a spread (#2081): the fitted entry stays the very snapshot object, so its
      // history-snapshot mark (syncEntryOf's only door) survives — a spread copy would lose it.
      const entry = fitEntry(Object.assign(snap, { createdAt: prev && prev.createdAt > 0 ? prev.createdAt : snap.updatedAt, ...(owner ? { owner } : {}) }));
      if (!entry) { logUnfittable(); return null; }
      // Newest first, HISTORY_MAX kept: the oldest beyond the cap are removed in the same write.
      // The cap is per account VIEW (Codex K1 #1, K3): only entries the signed-in account sees (its own + ownerless) are
      // evicted — another account's entries and images are never pushed out by this one's writes.
      const rest = list.filter((e) => e.id !== snap.id && (!snapScoped || !e.owner || e.owner === snapOwner));
      // The entry written is always in that view (the split above) — it takes one slot (Codex K4 / batch r8).
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
    }).then((r) => {
      // This session has an entry to come back to — what the mode tabs ask before leaving it
      // (debate.js requestMode, plan §17.7). Only once the entry is READ BACK from the store (Codex
      // tabs U1 2R: marking at the request let a failed write leave the session unasked). Never for
      // an incognito session (no snapshot); a pending write counts as not saved yet (it asks).
      // Still THIS session (Codex tabs U1 3R): a late write of the session that was left must not
      // overwrite the mark of the one on screen now (a loaded entry is marked by loadSession).
      if (r.ok && state.sessionId === snap.id && r.list.some((e) => e && e.id === snap.id)) state.persistedId = snap.id;
      syncHistoryButton(r.ok ? r.list : null);
      // The server copy (#2081): only after the local write landed — `snap` is the object written
      // (fitted in place); the sync slice re-checks under the lock that it is still what is stored.
      if (r.ok && ctx.historySyncPush && r.list.some((e) => e && e.id === snap.id)) ctx.historySyncPush(snap);
    });
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
  /** The updatedAt of the entry stored NOW under `id` (null: none / unreadable). Call under the history lock (#2081). */
  /** contentCount of the entry stored NOW under `id` (null: none / unreadable). Call under the history lock (#2081). */
  async function storedCount(id) {
    let r = null;
    try { r = await entryStore.getOne(historyKey(id)); } catch { r = null; }
    if (!r || !r.ok || r.value === undefined) return null;
    let e = null;
    try { e = normalizeEntry(r.value); } catch { e = null; }
    return e ? contentCount(e) : null;
  }
  async function storedUpdatedAt(id) {
    let r = null;
    try { r = await entryStore.getOne(historyKey(id)); } catch { r = null; }
    if (!r || !r.ok || r.value === undefined) return null;
    let e = null;
    try { e = normalizeEntry(r.value); } catch { e = null; }
    return e ? e.updatedAt : null;
  }
  /** Case-insensitive substring match over the question and every stored turn (answers and error lines are text too). */
  function historyMatches(entry, term) {
    if (String(entry.question || '').toLowerCase().includes(term)) return true;
    for (const c of Object.values(entry.columns || {})) {
      for (const turn of c && Array.isArray(c.turns) ? c.turns : []) if (String(turn.text || '').toLowerCase().includes(term)) return true;
    }
    // A debate's own words of the user live only in its record (#1769 후속).
    const log = entry.debate && Array.isArray(entry.debate.log) ? entry.debate.log : [];
    for (const e of log) if (typeof e.u === 'string' && e.u.toLowerCase().includes(term)) return true;
    return false;
  }
  function syncHistoryButton(list) {
    // + the server's items this browser does not have (#2081) — the count is what the panel lists.
    const local = Array.isArray(list) ? myView(list) : state.historyCache || [];
    const ids = new Set(local.map((e) => e && e.id));
    const remoteOnly = (state.historyRemote || []).filter((r) => !ids.has(r.id)).length;
    const n = (Array.isArray(list) ? local.length : lastHistoryCount) + remoteOnly;
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
    state.historyCache = myView(list); // this account's view (batch r7), at most HISTORY_MAX (K2)
    paintHistoryList();
  }
  /** A stored debate: its record, or (written before records) a debate turn in any column. */
  function isDebateEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.debate) return true;
    const cols = entry.columns && typeof entry.columns === 'object' ? Object.values(entry.columns) : [];
    return cols.some((c) => c && Array.isArray(c.turns) && c.turns.some((turn) => turn && turn.kind === TURN_KIND_DEBATE));
  }
  function paintHistoryList() {
    // This browser's entries + the server's items it does not have (#2081) — merged for painting only.
    const local = state.historyCache;
    const have = new Set(local.map((e) => e.id));
    const all = [...local, ...(state.historyRemote || []).filter((r) => !have.has(r.id))].sort((a, b) => b.updatedAt - a.updatedAt);
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
      // Only on the server (#2081): kept by another browser (or dropped from this one's 20).
      if (entry.remoteOnly) {
        const badge = el('span', 'cmp-history-remote', t('history_remote_badge'));
        badge.title = t('history_remote_title');
        meta.appendChild(badge);
      }
      // Continued here from another device's conversation (§7.8 ③) — a copy this browser owns.
      if (entry.forkedFrom) meta.appendChild(el('span', 'cmp-history-remote', t('history_forked_badge')));
      // A debate says so (plan §17.7) — opening it switches the page to the 토론 tab.
      if ((isDebateEntry(entry) || entry.remoteKind === 'debate') && ctx.debateOn && ctx.debateOn()) { // flag off: it opens as columns — no 토론 label
        const badge = el('span', 'cmp-history-debate');
        const glyph = el('span', null, '\u{1F5E3}\u{FE0F}');
        glyph.setAttribute('aria-hidden', 'true');
        badge.appendChild(glyph);
        badge.appendChild(el('span', null, t('history_debate_badge')));
        meta.appendChild(badge);
      }
      // A conversation shared from this browser (#1784 U3, the share map beside the history).
      if (ctx.shareFor && ctx.shareFor(entry.id)) {
        const shared = el('span', 'cmp-history-shared');
        shared.appendChild(ctx.linkIcon());
        shared.title = t('history_shared');
        shared.setAttribute('aria-label', t('history_shared'));
        meta.appendChild(shared);
      }
      for (const key of Object.keys(entry.columns || {})) { const parsed = parseColId(key); if (parsed) meta.appendChild(dot(parsed.provider)); }
      // A debate entry opens frozen (read-only) while the debate is not offered — say so, not 「이어서」.
      const resumable = !entry.remoteOnly && !!(entry.columns && Object.values(entry.columns).some((c) => c && c.continuation)) && !(isDebateEntry(entry) && !(ctx.debateOn && ctx.debateOn()));
      meta.appendChild(el('span', null, [relativeTime(entry.updatedAt), entry.remoteOnly ? '' : resumable ? t('history_resumable') : t('history_readonly')].filter(Boolean).join(' · ')));
      open.appendChild(meta);
      open.setAttribute('aria-label', t('history_open_aria', q));
      // A server item is downloaded, validated and kept here first (history-sync.js historySyncOpenRemote).
      open.addEventListener('click', () => { if (entry.remoteOnly) ctx.historySyncOpenRemote(entry.id); else loadSession(entry); });
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
    if (ctx.syncMySharesEntry) ctx.syncMySharesEntry();
    if (ctx.historySyncPanelSync) ctx.historySyncPanelSync(); // #2081: the switch shows the stored value
    ctx.historySearch.value = ''; // every open starts unfiltered — a stale term would hide the list behind 「검색 결과 없음」
    historyUpdate(null).then((r) => {
      renderHistoryList(r.list); syncHistoryButton(r.ok ? r.list : null);
      // The server's items come after the local list is on screen (a server read never delays it, #2081).
      if (!r.ok || !ctx.historySyncReadRemote) return;
      ctx.historySyncReadRemote(r.list).then((rows) => {
        if (rows === null) return; // outdated on arrival (a delete / wipe / switch since): what is shown stays
        state.historyRemote = rows;
        syncHistoryButton(null);
        if (!ctx.historyPanel.hidden) paintHistoryList();
      }, () => {});
    });
  }
  function closeHistoryPanel() {
    ctx.historyPanel.hidden = true;
    ctx.historyBtn.setAttribute('aria-expanded', 'false');
  }
  /**
   * A new id for the session on screen (a delete of its entry). Another device's conversation shown read-only
   * keeps its origin (Codex F1 #3): continuing it after the rotation is still a fork of it (`forkedFrom`).
   */
  function rotateSessionId() {
    // Another device's conversation on screen (read-only), or a fork of one: its origin moves with the id (Codex F1 #3, F2 #3).
    const from = state.remoteViewId && state.sessionId === state.remoteViewId ? state.remoteViewId
      : state.forkOf && state.forkOf.id === state.sessionId ? state.forkOf.from : null;
    const oldId = state.sessionId;
    state.sessionId = newSessionId();
    if (from) { state.forkOf = { id: state.sessionId, from }; state.remoteViewId = null; }
    if (isMixedId(oldId, state.mixedEpoch)) markMixedId(state.sessionId, state.mixedEpoch);
    if (state.splitOf) {
      const ids = {};
      for (const [k, v] of Object.entries(state.splitOf.ids)) ids[k] = v === oldId ? state.sessionId : v;
      state.splitOf = { from: state.splitOf.from, ids };
    }
  }
  function deleteSession(id) {
    // The live session's id rotates NOW, before the delete is queued: a settle that lands while the
    // delete is in flight then writes under the new id instead of resurrecting the deleted one
    // (Codex hist 1R #3).
    // Never undone, like before #2081 (Codex F3: an undo raced a settle already written under the new id) — a
    // delete that fails leaves the old entry and the screen goes on under the new id, as any failed write did.
    if (id === state.sessionId && state.sessionStarted) rotateSessionId();
    // Its images go with it (2026-09-26), under the same lock as the removal. So does its server copy
    // (#2081): the DELETE is queued inside this lock op, after the rotation above, and goes out before
    // any later upload of that id (history-sync.js). A server-only row is removed from the panel now.
    historyUpdate(async (list) => {
      const own = list.find((e) => e.id === id);
      // Another account's entry is not this account's to delete (it is hidden here — batch r7).
      if (own && !visibleToMe(own)) return null;
      if (ctx.historySyncNoteDelete) await ctx.historySyncNoteDelete([{ id, owner: own ? own.owner : null }]);
      return { remove: [historyKey(id)], afterWrite: () => ctx.imageStore.forget([id]) };
    }).then((r) => {
      // Not done (a storage write — the sync's delete queue included — failed): the list is read again as it is.
      if (!r.ok) { historyUpdate(null).then((rr) => { renderHistoryList(rr.list); syncHistoryButton(rr.ok ? rr.list : null); }); return; }
      state.historyRemote = (state.historyRemote || []).filter((row) => row.id !== id);
      renderHistoryList(r.list); syncHistoryButton(r.ok ? r.list : null);
      track('history_delete', { remaining: r.list.length });
      if (ctx.historySyncDrain) ctx.historySyncDrain();
    });
  }
  function clearHistory() {
    if (state.sessionStarted) rotateSessionId();
    // Every history-prefixed key, valid or not (6R #3) — the read's `keys`, not the validated list.
    // …and the server's (#2081): with the sync on, everything the panel lists (this browser's and the
    // server-only rows) is what 「모두 삭제」 clears; queued inside this lock op like a single delete.
    historyUpdate(async (list, keys) => {
      // This account's view only (batch r7): its entries and the ownerless ones, plus rows that did not validate;
      // another account's entries (and their images) stay on disk for it.
      const mine = list.filter(visibleToMe);
      const valid = new Set(list.map((e) => historyKey(e.id)));
      const remove = [...mine.map((e) => historyKey(e.id)), ...keys.filter((k) => !valid.has(k))];
      if (ctx.historySyncNoteDelete) await ctx.historySyncNoteDelete([...mine.map((e) => ({ id: e.id, owner: e.owner || null })), ...(state.historyRemote || []).map((row) => ({ id: row.id, owner: null }))], { all: true });
      const ids = mine.map((e) => e.id);
      return { remove, afterWrite: () => (list.length === mine.length ? ctx.imageStore.clear() : ctx.imageStore.forget(ids)) };
    }).then((r) => {
      if (!r.ok) { historyUpdate(null).then((rr) => { renderHistoryList(rr.list); syncHistoryButton(rr.ok ? rr.list : null); }); return; }
      state.historyRemote = [];
      renderHistoryList(r.list); syncHistoryButton(r.ok ? r.list : null); track('history_clear');
      if (ctx.historySyncDrain) ctx.historySyncDrain();
    });
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
      // #2081: the marker of an attachment that stayed on another browser — nothing else about it is kept.
      if (v.omitted !== undefined && v.omitted !== true) return undefined;
      if (v.omitted === true) return { ...OMITTED_IMG };
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
      // `docs` (#1944) likewise: a count that could not be this marker's (more documents than
      // files) is dropped, never trusted — it only decides what a share card calls the files.
      const docs = docCountOf(v.docs, 1 + more);
      return { name: name.slice(0, HISTORY_ATTACH_NAME_MAX), bytes, ...(more > 0 ? { more } : {}), ...(ids.length ? { ids } : {}), ...(docs ? { docs } : {}), ...markerKinds({ more, kinds: v.kinds }) };
    };
    // `attachOmitted` (#2081): the server copy's 「an attachment was here」 — the entry / a turn had a
    // file that never left the browser it was sent from. Typed like every other field: a non-true value drops the entry.
    const omittedFlag = (v) => (v === undefined ? false : v === true ? true : undefined);
    const qOmitted = omittedFlag(entry.attachOmitted);
    if (qOmitted === undefined) return null;
    const questionImg = entry.questionImg === undefined ? (qOmitted ? { ...OMITTED_IMG } : null) : readImg(entry.questionImg);
    if (questionImg === undefined) return null;
    const question = str(entry.question);
    const updatedAt = num(entry.updatedAt);
    const createdAt = num(entry.createdAt);
    const rounds = num(entry.rounds);
    const src = entry.src == null ? null : (typeof entry.src === 'string' ? entry.src : undefined);
    // #2081 decision A: the account the entry belongs to — optional, 16 hex; else the entry drops.
    if (entry.owner !== undefined && (typeof entry.owner !== 'string' || !/^[0-9a-f]{16}$/.test(entry.owner))) return null;
    // #2081 §7.8: the server id of another device's conversation this one forked — optional, a session id; else the entry drops.
    if (entry.forkedFrom !== undefined && (typeof entry.forkedFrom !== 'string' || !SESSION_ID_RE.test(entry.forkedFrom))) return null;
    if (entry.splitFrom !== undefined && (typeof entry.splitFrom !== 'string' || !SESSION_ID_RE.test(entry.splitFrom))) return null; // batch r8, same rule
    if (entry.mixed !== undefined && entry.mixed !== true) return null; // pre-CWS batch r2: `true` or absent
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
        if (turn.openTab !== undefined && typeof turn.openTab !== 'boolean') return null; // no_tab's inline link, additive: absent on older entries
        if (turn.retracted !== undefined && typeof turn.retracted !== 'boolean') return null; // a retracted answer, additive like its siblings
        if (turn.retraction !== undefined && typeof turn.retraction !== 'string') return null; // its quoted replacement (plain text, bounded below)
        const retracted = turn.retracted === true && turn.stalled === true && turn.role === 'assistant';
        // The answer's timing (share 「N초」): a display hint — a malformed one is DROPPED, never the entry.
        const ms = turn.role === 'assistant' ? readTiming(turn.ms) : null;
        const round = int(turn.round);
        const text = str(turn.text);
        const errorText = str(turn.errorText);
        const tm = turn.model === undefined ? null : model(turn.model); // absent on a turn = never got a MODEL event
        const img = turn.img === undefined ? null : readImg(turn.img); // absent on every pre-#1616 turn
        const images = turn.images === undefined ? null : readOutImagesMarker(turn.images); // #1684, absent on every older turn
        const omitted = omittedFlag(turn.attachOmitted); // #2081, see the entry's own above
        if (round === undefined || text === undefined || errorText === undefined || tm === undefined || img === undefined || images === undefined || omitted === undefined) return null;
        // A request's file that stayed elsewhere becomes the request's marker (the retry gate reads it); an answer's images, a flag.
        const userImg = img || (omitted && turn.role === 'user' ? { ...OMITTED_IMG } : null);
        // A debate turn (#1769) keeps its kind on both roles: its request is the page's composed
        // prompt (it folds when the session is reloaded), its answer a speaker's turn.
        const kind = turn.kind === TURN_KIND_SUMMARY ? TURN_KIND_SUMMARY : turn.kind === TURN_KIND_DEBATE && turn.role !== 'skipped' ? TURN_KIND_DEBATE : null;
        let summary = null;
        if (kind === TURN_KIND_SUMMARY && turn.role === 'user') {
          if (turn.summary !== undefined) { summary = storedSummary(turn.summary); if (!summary) return null; } // present (null included) but malformed = the entry is
          // else: a bare-text request from before structures — a plain user turn
        }
        if (round !== null) seenRounds.add(round);
        // Optional fields are OMITTED when empty (not written as null), so a normalised entry is
        // itself valid input — loadSession re-validates what the list hands it.
        const k = kind === TURN_KIND_DEBATE ? kind : kind && (turn.role === 'assistant' || summary) ? kind : null;
        turns.push({ role: turn.role, text, round, model: tm, ...(k ? { kind: k } : {}), ...(summary ? { summary } : {}), ...(errorText ? { errorText } : {}), ...(errorText && turn.openTab === true ? { openTab: true } : {}), ...(userImg && turn.role === 'user' ? { img: userImg } : {}), ...(images && turn.role === 'assistant' && images.ids.length ? { images } : {}), ...(omitted && turn.role === 'assistant' ? { attachOmitted: true } : {}), ...(turn.stalled === true && turn.role === 'assistant' ? { stalled: true } : {}), ...(turn.cutError === true && turn.role === 'assistant' ? { cutError: true } : {}), ...(retracted ? { retracted: true, ...(turn.retraction ? { retraction: turn.retraction.slice(0, RETRACTION_MAX) } : {}) } : {}), ...(ms ? { ms } : {}) });
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
    // The debate record (#1769 후속): typed like every other field — present but malformed drops the
    // entry; absent on a debate entry written before records = derived from its turns.
    const debate = entry.debate === undefined ? legacyDebateRecord(columns, firstRound) : readDebateRecord(entry.debate, Object.keys(columns), HISTORY_TEXT_MAX);
    if (debate === undefined) return null;
    return { ...(debate ? { debate } : {}), id: entry.id, question, ...(questionImg ? { questionImg } : {}), rounds: rounds || 1, columns, activeRound, firstRound, updatedAt, createdAt, src, ...(entry.forkedFrom !== undefined ? { forkedFrom: entry.forkedFrom } : {}), ...(entry.splitFrom !== undefined ? { splitFrom: entry.splitFrom } : {}), ...(entry.mixed === true ? { mixed: true } : {}), ...(entry.owner !== undefined ? { owner: entry.owner } : {}) };
  }
  /** `remote`: another device's conversation, shown read-only from memory (#2081 §7.8 ②) — see persistSession's fork. */
  function loadSession(raw, { remote = false } = {}) {
    if (state.disabled) return;
    const entry = normalizeEntry(raw);
    if (!entry) return; // not an entry: the session on screen is left as it is
    // Another account's local entry never opens (Codex K1 #2: a row still painted from before an account switch).
    if (!remote && !visibleToMe(entry)) return;
    ctx.closeViewer(); // an image of the session being replaced must not stay on top of the loaded one
    ctx.closeShareDialog(); // the share dialog was about the session being replaced
    if (!state.columns.size) { ctx.pendingLoad = raw; ctx.pendingLoadOpts = { remote }; closeHistoryPanel(); return; } // applied by readStatus once the columns exist
    // Leave whatever is on screen — accepted or not: a first SEND still waiting for its CONSUME_OK
    // keeps a port whose late answer must never land in the loaded session (Codex hist 1R #1).
    if (state.sending && state.port) { try { state.port.postMessage({ type: 'ABORT' }); } catch { /* gone */ } }
    ctx.closePort();
    if (ctx.debateReset) ctx.debateReset(); // the debate on screen (if any) is left; a debate entry reopens as one below
    // The exclusion checkbox is a first-send choice; a stored session shows every column it holds.
    state.excludeSrc = false; ctx.excludeInput.checked = false;
    for (const col of state.columns.values()) col.node.hidden = false;
    state.sending = false; state.resuming = false; state.resumed = false; state.idleEnded = false;
    state.summaryPending = null; state.judgeChoice = null; ctx.closeSummaryPop();
    state.roundInFlight = null;
    state.footerRound = null; state.footerShownRound = null; state.autoSummaryTried = new Set(); state.autoSkipNote = null; // #1976: no line until a round of THIS session settles
    if (ctx.resetSuggest) ctx.resetSuggest(); // #2026: the loaded session's round ids are not the left session's — no stale row 1, no 「already tried」
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
    state.persistedId = entry.id; // opened FROM the history (or the server — nothing here to lose by leaving it)
    state.remoteViewId = remote ? entry.id : null; // §7.8 ②: never written under this id
    state.forkOf = entry.forkedFrom ? { id: entry.id, from: entry.forkedFrom } : null;
    state.splitOf = entry.splitFrom ? { from: entry.splitFrom, ids: { [entry.owner || '']: entry.id } } : null;
    state.mixedEpoch = (state.mixedEpoch || 0) + 1; // what is on screen now is this entry as stored
    if (entry.mixed === true) markMixedId(entry.id, state.mixedEpoch);
    state.sessionStarted = true;
    state.sessionEnded = true;      // no port carries it: a follow-up resumes (canResume) or is refused
    state.sessionSaveBy = uniformSaveBy(true); // only all-kept sessions are stored
    ctx.resetCrossConsent(); // #1985: another conversation — nothing agreed carries over
    state.rounds = typeof entry.rounds === 'number' ? entry.rounds : 1;
    ctx.commitPrompt(state.question);
    // The entry's columns are shown in the PAGE's order (created next to their service's column when
    // the page does not have them — a stored Opus column next to the page's auto one). The page's
    // other columns are CLOSED for this conversation (closeColumn's state — 새 대화 reopens them):
    // left open they sat beside the thread as empty 「로그인됨 — 새 대화부터」 cards and, being first of
    // their service, carried its plan / gauges / 「같은 계정」 chip (2026-09-26 user feedback).
    ctx.ensureLayout(Object.keys(entry.columns));
    state.layoutFromEntry = true; // the entry's columns and models are this session's only (applyLayout rebuilds on the way out)
    // An entry with no column (never written by snapshotSession — a damaged row) closes nothing: an empty page helps no one (Codex cmp-load 1R 후속).
    if (Object.keys(entry.columns).length) for (const col of ctx.allColumns()) {
      if (Object.prototype.hasOwnProperty.call(entry.columns, col.id)) continue;
      col.closed = true;
      col.node.hidden = true;
    }
    ctx.renderColumns(); // the provider-level UI moves to the first VISIBLE column of each service
    // A debate opens as the debate (#1769 후속): the timeline exists before the turns are drawn, so
    // each one is decorated as it is pushed; restoreFinish lays them out in the debate's order.
    const debating = !!(entry.debate && ctx.debateRestoreBegin && ctx.debateRestoreBegin(entry.debate));
    // FROZEN (1.38 batch review 2R·3R): a debate entry that did not open as the debate (the flag is
    // off — the rollback — or its cast is not on the page) is shown as columns but is not THIS page's
    // conversation to change: nothing may re-save it (it would lose its `debate` record — the user's
    // words, the aliases) and nothing may publish it (a share would post the composed prompts as a
    // plain question). One state, read by every writer: continuation (below) and share.js shareable().
    state.frozenDebate = !!entry.debate && !debating;
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
      // A debate entry that did not open as the debate (the flag is off — the rollback — or its cast
      // is not on the page) is READ-ONLY here: continuing it as columns would re-save the entry
      // without its `debate` record (snapshotSession finds no live debate) and lose the user's words
      // and the aliases for good (1.38 batch review 2R). Kept as is, it reopens whole once it can.
      col.continuation = !state.frozenDebate && stored.continuation && typeof stored.continuation === 'object' ? stored.continuation : null;
      // Now that the turns are back, the thread's mode is known: the model chosen above (before
      // them) is put back in it (1.35.0 batch review).
      ctx.reconcileMode(col);
      ctx.renderQuestionBubbles(); // this column's thread is restored: its bubble (from entry.question) goes on top
      const last = col.turns[col.turns.length - 1];
      col.status = last && last.role === 'assistant' && last.errorText ? 'error' : 'done';
      col.errorCode = col.status === 'error' ? CODE_RESTORED : null;
      ctx.setBadge(col, col.status === 'error' ? 'col_error' : 'col_done', col.status === 'error' ? 'is-error' : 'is-done');
      ctx.renderColumnActions(col);
      targets.push(colId);
    }
    state.followupTargets = new Set(targets);
    state.pendingFollowupCol = null;
    if (debating) ctx.debateRestoreFinish();
    ctx.syncOpenButtons(); // the restored continuations (set after each column's turns settled) — #1978
    ctx.renderColumns(); // and the heads: each shows the facts of the org its restored thread sends to (#2054 — columnFacts)
    ctx.stopBtn.disabled = true;
    ctx.syncWaitTimer();
    closeHistoryPanel();
    // The tab follows what the entry opened AS — the debate room or the columns (plan §17.7).
    if (ctx.debateFollowEntry) ctx.debateFollowEntry(debating);
    ctx.updateControls();
    ctx.showNotice(ctx.canResume() ? 'info' : 'warn', [t(ctx.canResume() ? 'history_loaded_resumable' : 'history_loaded_readonly'), remote ? t('hist_sync_remote_view') : '']);
    track('history_load', { resumable: ctx.canResume(), columns: targets.length, debate: debating });
    if (ctx.canResume()) ctx.focusQuietly(ctx.followup.input);
  }
  /** A stored assistant turn: painted settled (no stream), with its error line when it had one. */
  /**
   * A stored summary structure, validated and bounded (Codex 4R #2/#3) — every field is checked
   * for its PRIMITIVE type before anything is converted (a `{toString:null}` where a string was
   * expected must not throw on load), providers come from the catalog, attachments are at most
   * one per provider, labels / question are cut to their bounds. null when it is not one.
   */
  /** A summary's row-1 questions to avoid, as stored: strings, at most SUGGEST_COUNT, each at most SUGGEST_Q_MAX. */
  const storedAvoid = (list) => (Array.isArray(list) ? list.filter((q) => typeof q === 'string').slice(0, SUGGEST_COUNT).map((q) => q.slice(0, SUGGEST_Q_MAX)) : []);
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
    // #2026 `suggest` (since the suggested-question chips): an object whose `avoid` is a list of strings; anything else drops the entry.
    if (sm.suggest !== undefined && (!sm.suggest || typeof sm.suggest !== 'object' || Array.isArray(sm.suggest) || !Array.isArray(sm.suggest.avoid) || sm.suggest.avoid.some((q) => typeof q !== 'string'))) return null;
    return { judge: normalizeColId(sm.judge), round: Number.isFinite(sm.round) ? sm.round : null, question: (sm.question || '').split('\n')[0].slice(0, SUMMARY_QUESTION_MAX), attachments, ...(sm.suggest ? { suggest: { avoid: storedAvoid(sm.suggest.avoid) } } : {}) };
  }
  function restoreAssistantTurn(col, stored, kind = null, extra = null) {
    const turn = ctx.pushAssistantTurn(col, kind, extra);
    turn.text = String(stored.text || '');
    if (stored.errorText) { turn.errorText = String(stored.errorText); turn.node.classList.add('is-error'); if (stored.openTab === true) turn.openTabLink = true; }
    if (stored.stalled === true) turn.stalled = true;
    if (stored.cutError === true) turn.cutError = true;
    const ms = readTiming(stored.ms);
    if (ms) turn.ms = ms;
    if (stored.retracted === true) { turn.retracted = true; if (stored.retraction) turn.retraction = String(stored.retraction).slice(0, RETRACTION_MAX); }
    if (stored.images) ctx.restoreOutputImages(turn, stored.images);
    if (stored.attachOmitted === true) turn.attachOmitted = true; // #2081: its images stayed on another browser (kept on re-save)
    turn.node.classList.remove('is-streaming');
    col.status = 'done';
    ctx.paintAssistant(col);
    ctx.settleTurn(turn);
    if (turn.attachOmitted) turn.node.appendChild(el('p', 'cmp-turn-attach-omitted', t('hist_sync_attach_omitted')));
    if (turn.activity) turn.activity.box.hidden = true;
  }
  // Everything another file reaches (compare.js destructures the names it calls bare).
  Object.assign(ctx, {
    historyStorage, underHistoryLock, lastErr, storageReadAll, storageKeyInvalid, storageWrite, historyUpdate, historyKey,
    newSessionId, clipText, snapshotSession, storedTurn, jsonBytes, fitEntry, logUnfittable, persistSession, persistLateImages,
    historyMatches, syncHistoryButton, relativeTime, renderHistoryList, paintHistoryList, openHistoryPanel, closeHistoryPanel, deleteSession,
    clearHistory, boundContinuation, normalizeEntry, loadSession, storedSummary, restoreAssistantTurn, storedUpdatedAt, storedCount, viewerOwner, visibleToMe, noteStatusAccount,
  });
}
