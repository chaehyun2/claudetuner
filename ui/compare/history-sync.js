// ui/compare/history-sync.js — the SERVER copy of the compare history (#2081, plan
// docs/plans/compare-history-sync.md — §7 overrides §4).
//
// What goes up: a kept (never incognito, never mixed) session's history entry, as the local history
// writes it, through ONE whitelist — syncEntryOf — that drops every attachment and generated image
// (and their names, sizes, counts, ids) and leaves `attachOmitted: true` in their place. Nothing else
// builds an upload body: syncEntryOf accepts only an object snapshotSession() marked as a HISTORY
// snapshot (markHistorySnapshot), so the share path's `anyMode` snapshot of an incognito session can
// never reach it.
//
// When: after the local write of a settle (history.js persistSession), only while every gate holds —
// Tuner login (ext_token, re-checked in the SW), the user's switch (HISTORY_SYNC_PREF_KEY, default on),
// the first-screen notice SHOWN in this browser (HISTORY_SYNC_NOTICED_KEY), and the remote flag
// `compare_history_sync` (status.historySyncOn, default off). Old local history is never bulk-uploaded:
// only a conversation written after the gates opened goes up.
//
// SINGLE WRITER (user decision 2026-10-05, plan §7.8): a conversation is written by ONE browser — the
// one that made it (or forked it). Only this browser's own entries go up. Another device's item is listed
// in 「최근」 (「다른 기기」), opened READ-ONLY from memory (never stored here, never uploaded), and
// continuing it FORKS it: a new local session id (`forkedFrom` = the server id), owned here from then on.
//
// Order (the invariants the guard pins):
//   • per id, the server's `rev` is kept beside the entries (HISTORY_SYNC_STATE_KEY), read and
//     written only under the history lock; a PUT carries it as `baseRev` (0 = new).
//   • a 409 can only come from another tab of THIS browser (single writer): retried once on the
//     server's rev, no UI, no loop.
//   • a local delete / 「모두 삭제」 queues the server DELETE inside the same lock op that removes the
//     entry (after the id rotation); queued deletes go out BEFORE any PUT, and a PUT of an id (or of
//     anything, after 「모두 삭제」) waits while its delete is still queued.
//   • the network side runs one request at a time across tabs (HISTORY_SYNC_LOCK_NAME), never while
//     holding the history lock.
//
// The top of the file is pure (test/compare-history-sync-guard.mjs runs it); installHistorySync() is a
// ctx slice (the contract is written up in history.js).

import {
  COMPARE_PROVIDERS, SESSION_ID_RE, TURN_KIND_DEBATE, HISTORY_SYNC_PREF_KEY, HISTORY_SYNC_NOTICED_KEY, HISTORY_SYNC_STATE_KEY,
  HISTORY_SYNC_LOCK_NAME, HISTORY_SYNC_MSG_TYPE, HISTORY_SYNC_ENTRY_MAX_BYTES, HISTORY_SYNC_SERVER_MAX, HISTORY_SYNC_QUEUE_MAX,
  HISTORY_SYNC_META_Q_MAX, HISTORY_LOCK_WAIT_MS, HISTORY_SYNC_WIPE_KEY,
} from './constants.js';
import { sendMessage, storageGet } from './helpers.js';

const plain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

// ── what may never go up ──
/** Keys that carry an attachment / a generated image anywhere in an entry (the server refuses them too, 400). */
export const SYNC_IMAGE_KEYS = Object.freeze(['questionImg', 'img', 'images']);
const SYNC_DEPTH_MAX = 64;

/** The path of the first image-carrying key anywhere inside `v`, or null — the deep check every upload passes. */
export function findImageKey(v, path = '$', depth = 0) {
  if (depth > SYNC_DEPTH_MAX) return path; // deeper than any entry: refuse rather than miss one
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const p = findImageKey(v[i], `${path}[${i}]`, depth + 1); if (p) return p; }
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  for (const k of Object.keys(v)) {
    if (SYNC_IMAGE_KEYS.includes(k)) return `${path}.${k}`;
    const p = findImageKey(v[k], `${path}.${k}`, depth + 1);
    if (p) return p;
  }
  return null;
}

// The objects history.js snapshotSession() built for the LOCAL history (never `anyMode`). A WeakSet,
// not a property: nothing serialised, copied or spread carries the mark — only that very object.
const HISTORY_SNAPSHOTS = new WeakSet();
/** Mark `o` as a history snapshot (snapshotSession without anyMode — only an all-kept session gets one). */
export function markHistorySnapshot(o) {
  if (o && typeof o === 'object') HISTORY_SNAPSHOTS.add(o);
  return o;
}
export function isHistorySnapshot(o) {
  return !!o && typeof o === 'object' && HISTORY_SNAPSHOTS.has(o);
}

const str = (v) => (typeof v === 'string' ? v : '');
const modelOf = (m) => (plain(m) ? { id: typeof m.id === 'string' ? m.id : null, label: str(m.label) } : null);
const finiteOr = (v, keep) => (typeof v === 'number' && Number.isFinite(v) ? keep(v) : {});

/** One stored turn, field by field — an attachment / an answer's images become `attachOmitted`. */
function syncTurn(turn) {
  if (!plain(turn)) return null;
  const out = { role: turn.role };
  if (typeof turn.kind === 'string') out.kind = turn.kind;
  if (Number.isInteger(turn.round)) out.round = turn.round;
  if (plain(turn.summary)) {
    const sm = turn.summary;
    out.summary = {
      judge: str(sm.judge),
      ...(Number.isInteger(sm.round) ? { round: sm.round } : {}),
      question: str(sm.question),
      // Only these fields of an attachment (the answer it quotes) — never anything about a file.
      attachments: (Array.isArray(sm.attachments) ? sm.attachments : []).filter(plain).map((a) => ({
        col: str(a.col), provider: str(a.provider), model: modelOf(a.model), text: str(a.text), partial: a.partial === true, clipped: a.clipped === true,
      })),
      ...(plain(sm.suggest) && Array.isArray(sm.suggest.avoid) ? { suggest: { avoid: sm.suggest.avoid.filter((q) => typeof q === 'string') } } : {}),
    };
  } else {
    out.text = str(turn.text);
  }
  if (typeof turn.errorText === 'string' && turn.errorText) out.errorText = turn.errorText;
  for (const k of ['openTab', 'stalled', 'cutError', 'retracted']) if (turn[k] === true) out[k] = true;
  if (typeof turn.retraction === 'string' && turn.retraction) out.retraction = turn.retraction;
  if (plain(turn.ms)) out.ms = JSON.parse(JSON.stringify(turn.ms));
  if (turn.model !== undefined) out.model = modelOf(turn.model);
  // 🔴 The attachment of a request, the images of an answer: their PRESENCE only, nothing about them.
  if (turn.img != null || turn.images != null || turn.attachOmitted === true) out.attachOmitted = true;
  return out;
}

/**
 * The upload body for a history entry — the ONLY producer of one (plan §7.3·§7.4). null unless `entry`
 * is a history snapshot (markHistorySnapshot): an incognito / mixed session has none, and the share
 * path's `anyMode` snapshot is never marked. A fresh object built by whitelist: `questionImg`, every
 * turn's `img` / `images` (names, sizes, counts, ids) are gone, `attachOmitted: true` says something
 * was there. Fails closed: anything image-shaped left anywhere → null.
 */
export function syncEntryOf(entry) {
  // `mixed` (pre-CWS batch r2): words of more than one account — never an upload body.
  if (!isHistorySnapshot(entry) || entry.mixed === true || typeof entry.id !== 'string' || !SESSION_ID_RE.test(entry.id) || !plain(entry.columns)) return null;
  const columns = {};
  for (const [colId, c] of Object.entries(entry.columns)) {
    if (!plain(c)) continue;
    const turns = [];
    for (const turn of Array.isArray(c.turns) ? c.turns : []) { const s = syncTurn(turn); if (s) turns.push(s); }
    columns[colId] = {
      ...(typeof c.provider === 'string' ? { provider: c.provider } : {}),
      ...(c.colModel === null || typeof c.colModel === 'string' ? { colModel: c.colModel } : {}),
      turns,
      model: modelOf(c.model),
      // The provider's own conversation ids — what lets another browser on the same AI account continue (§7.3).
      continuation: plain(c.continuation) ? Object.fromEntries(Object.entries(c.continuation).filter(([, v]) => typeof v === 'string')) : null,
    };
  }
  const out = {
    // The debate record holds the cast, the aliases and the user's own words — no file of any kind.
    ...(plain(entry.debate) ? { debate: JSON.parse(JSON.stringify(entry.debate)) } : {}),
    id: entry.id,
    updatedAt: entry.updatedAt,
    ...finiteOr(entry.createdAt, (v) => ({ createdAt: v })),
    question: str(entry.question),
    ...(entry.questionImg != null || entry.attachOmitted === true ? { attachOmitted: true } : {}),
    src: typeof entry.src === 'string' ? entry.src : null,
    columns,
    rounds: typeof entry.rounds === 'number' && Number.isFinite(entry.rounds) ? entry.rounds : 1,
    ...(Number.isInteger(entry.activeRound) ? { activeRound: entry.activeRound } : {}),
    ...(Number.isInteger(entry.firstRound) ? { firstRound: entry.firstRound } : {}),
  };
  return findImageKey(out) === null ? out : null;
}

// ── whose conversation it is (batch r6 decision A) ──
/** The OWNER stamp: sha256 of the lower-cased email, first 16 hex — local only, never uploaded. */
export const OWNER_RE = /^[0-9a-f]{16}$/;
export async function ownerOfEmail(email, subtle = globalThis.crypto && globalThis.crypto.subtle) {
  if (typeof email !== 'string' || !email.trim() || !subtle) return null;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
/**
 * The owner of an ext_token (a JWT whose payload carries `email`) — read, not verified: the request goes with that
 * very token, and the server verifies it. null when it is not one.
 */
export async function ownerOfExtToken(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return payload && typeof payload.email === 'string' ? ownerOfEmail(payload.email) : null;
  } catch { return null; }
}

/** `compare` | `debate` — what the server lists the entry as. */
export function syncKindOf(entry) {
  if (!entry) return 'compare';
  if (plain(entry.debate)) return 'debate';
  const cols = plain(entry.columns) ? Object.values(entry.columns) : [];
  return cols.some((c) => c && Array.isArray(c.turns) && c.turns.some((tn) => tn && tn.kind === TURN_KIND_DEBATE)) ? 'debate' : 'compare';
}

// ── the server's list ──
/** epoch ms of a server `updatedAt` (a number, or an ISO string); NaN when neither. */
export function remoteTime(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}

/** A list item of `GET /api/compare/history`, validated — or null. Never trusted beyond what the row paints. */
export function readRemoteItem(raw) {
  if (!plain(raw) || typeof raw.id !== 'string' || !SESSION_ID_RE.test(raw.id) || !Number.isInteger(raw.rev) || raw.rev < 1) return null;
  const updatedAt = remoteTime(raw.updatedAt);
  if (!Number.isFinite(updatedAt)) return null;
  const meta = plain(raw.meta) ? raw.meta : {};
  const providers = Array.isArray(meta.providers) ? [...new Set(meta.providers.filter((p) => COMPARE_PROVIDERS.includes(p)))] : [];
  return { id: raw.id, rev: raw.rev, updatedAt, kind: raw.kind === 'debate' ? 'debate' : 'compare', q: str(meta.q).slice(0, HISTORY_SYNC_META_Q_MAX), providers };
}

/**
 * The rows the 「최근」 panel adds for the server's items this browser does not have (by id), minus the
 * ones whose delete is still queued here. A light stand-in (`remoteOnly`), newest first; the local
 * cache itself is never touched (the search and every op keep reading it).
 */
export function remoteOnlyRows(localList, items, dels = []) {
  const have = new Set((localList || []).map((e) => e && e.id));
  const gone = new Set(dels);
  const out = [];
  for (const raw of items || []) {
    const it = readRemoteItem(raw);
    if (!it || have.has(it.id) || gone.has(it.id) || gone.has(SYNC_DELETE_ALL)) continue;
    const columns = {};
    for (const p of it.providers) columns[`${p}:auto`] = { turns: [] };
    out.push({ id: it.id, question: it.q, updatedAt: it.updatedAt, createdAt: it.updatedAt, columns, remoteOnly: true, remoteRev: it.rev, remoteKind: it.kind });
    if (out.length >= HISTORY_SYNC_SERVER_MAX) break;
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── the bookkeeping beside the entries ──
/** The queued 「delete everything」 (「모두 삭제」 while the sync was on). */
export const SYNC_DELETE_ALL = '*';

/** HISTORY_SYNC_STATE_KEY as read, normalised: `{revs: {id: rev}, dels: [id|'*'], gone: [id], held: {id: n}, wipeSeen}`. */
export function readSyncState(raw) {
  const s = plain(raw) ? raw : {};
  const idMap = (m) => Object.fromEntries(Object.entries(plain(m) ? m : {}).filter(([id, rev]) => SESSION_ID_RE.test(id) && Number.isInteger(rev) && rev >= 0));
  const idList = (a, max = HISTORY_SYNC_QUEUE_MAX) => [...new Set((Array.isArray(a) ? a : []).filter((id) => typeof id === 'string' && (id === SYNC_DELETE_ALL || SESSION_ID_RE.test(id))))].slice(-max);
  return {
    revs: idMap(s.revs), dels: idList(s.dels), gone: idList(s.gone).filter((id) => id !== SYNC_DELETE_ALL),
    // id → the conversation's CONTENT COUNT (contentCount: turns across every column + rounds) of this
    // browser's stored entry when a 410 `wiped` came back: it goes up again (as new) only from a settle whose
    // stored count is HIGHER — the user continued it here (plan §7.8 ⑥). No clock, no page memory: the same in
    // every tab and after a reload. NOT bounded (a cut entry would release a hold) — an id leaves it only when
    // it is uploaded again, gone, or deleted.
    held: idMap(s.held),
    // The last 「서버 기록도 삭제」 (HISTORY_SYNC_WIPE_KEY) this ledger has taken in — see ledgerAfterWipe.
    wipeSeen: typeof s.wipeSeen === 'number' && Number.isFinite(s.wipeSeen) ? s.wipeSeen : 0,
  };
}

/**
 * A local delete of `ids` (or 「모두 삭제」 = `all`), decided inside the history lock: the server DELETEs
 * are queued — for an id the server may hold (`known`: it has a rev here, or the panel listed it as a
 * server item, or the sync is on now) — and the id's bookkeeping goes. Pure: returns the new state.
 */
export function queueDeletes(state, ids, { all = false, syncOn = false, offered = syncOn, remoteIds = [] } = {}) {
  const s = readSyncState(state);
  const remote = new Set(remoteIds);
  const add = [];
  if (all && syncOn) add.push(SYNC_DELETE_ALL);
  for (const id of ids) {
    if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) continue;
    // `offered` (flag + login, the switch NOT consulted — Codex B6): a delete is always safe to send, and an
    // upload may be in flight with no rev recorded yet; the switch only decides 「delete everything」. Another
    // device's item deleted from this list (`remote`) is a server DELETE only — it was never stored here.
    if (offered || syncOn || remote.has(id) || Object.hasOwn(s.revs, id)) add.push(id);
    delete s.revs[id];
    delete s.held[id];
  }
  s.dels = [...new Set([...s.dels, ...add])].slice(-HISTORY_SYNC_QUEUE_MAX);
  return s;
}

/**
 * The ledger once a 「서버 기록도 삭제」 at `at` is first SEEN (by an engine, under the history lock — see
 * HISTORY_SYNC_WIPE_KEY): the 410 marks are forgotten (what they referred to is gone), so the
 * next settle of each conversation tries again. The revs are KEPT (Codex C2: a rev cleared by a reset that
 * lands late was a fresh post-wipe rev → baseRev 0 → 409): a pre-wipe rev heals itself — the server answers
 * 410 `wiped`, the engine forgets the rev, and a settle that ADDS to it uploads as new. The queued deletes stay.
 */
export function ledgerAfterWipe(state, at) {
  const s = readSyncState(state);
  return { ...s, gone: [], wipeSeen: at };
}

/**
 * What the user has DONE in a conversation, as one number: turns across every column + rounds. It only grows
 * with the conversation (a send, a follow-up, an answer) — never with a clock, a reload or another tab (§7.8 ⑥).
 */
export function contentCount(entry) {
  if (!plain(entry)) return null;
  let turns = 0;
  for (const c of Object.values(plain(entry.columns) ? entry.columns : {})) turns += c && Array.isArray(c.turns) ? c.turns.length : 0;
  return turns + (Number.isInteger(entry.rounds) && entry.rounds > 0 ? entry.rounds : 0);
}

/** Whether a PUT of `id` must wait: its own delete (or a 「delete everything」) is still queued. */
export function putBlocked(state, id) {
  const s = readSyncState(state);
  return s.dels.includes(SYNC_DELETE_ALL) || s.dels.includes(id) || s.gone.includes(id);
}

// SW answers that mean 「the feature is off server-side / here」 — stop for this page, quietly.
// `account_deleted` (403 on a write): the account is being erased — never retried from this page.
const SYNC_ACCOUNT_DELETED = 'account_deleted';
const SYNC_OFF_CODES = Object.freeze(['history_sync_disabled', 'history_sync_off', SYNC_ACCOUNT_DELETED]);
// 503 `busy` is NOT 「off」 (told apart by the server's `error` field): a GET retries after a short backoff.
const SYNC_BUSY = 'busy';
// PUT 404 `not_found` (baseRev > 0): the server dropped it under its cap — re-uploaded as new, once.
const SYNC_NOT_FOUND = 'not_found';
// PUT 410 `wiped` (baseRev > 0 against a whole-account wipe tombstone): the rev is forgotten, nothing re-sent now.
const SYNC_WIPED = 'wiped';
export const HISTORY_SYNC_GET_BACKOFF_MS = Object.freeze([800, 2000]);
// Longest a read of the switch waits for this page's own pending writes of it (see writePref).
const HISTORY_SYNC_PREF_WRITE_WAIT_MS = 3000;
// …and 「not signed in」: nothing is sent, the queue waits for a login.
const SYNC_NO_TOKEN = 'ext_token_required';
// The entry belongs to another account than the one signed in now: quiet, never sent.
const SYNC_OTHER_ACCOUNT = 'history_sync_other_account';
// The SW found this browser's switch off (or the notice not shown) right before a PUT: quiet, the next settle re-checks.
const SYNC_PAUSED = 'history_sync_paused';
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_BAD_REQUEST = 400;
const HTTP_TOO_LARGE = 413;
const HTTP_UNAVAILABLE = 503;

/**
 * The sync engine over injected effects (the guard drives it with fakes):
 *   request(msg)            → the SW's answer ({ok, status, code, …})
 *   underHistoryLock(fn)    → fn() under the history's cross-tab lock
 *   withSyncLock(fn)        → fn() under HISTORY_SYNC_LOCK_NAME (network one at a time across tabs)
 *   readState() / writeState(s)   the bookkeeping (call only under the history lock)
 *   storedUpdatedAt(id)     → the updatedAt of the entry stored NOW under `id`, or null (under the history lock)
 *   storedCount(id)         → contentCount of that entry, or null (under the history lock)
 *   gatesOpen()             → every upload gate holds (login · switch · notice shown · flag)
 *   deletesOpen()           → queued deletes may go out (the sync offered: flag · login) — else they wait in the ledger
 */
export function createSyncEngine({ request, underHistoryLock, withSyncLock, readState, writeState, storedUpdatedAt, storedCount = async () => null, gatesOpen, deletesOpen = async () => true, readWipeAt = async () => 0, warn = () => {} }) {
  let chain = Promise.resolve();
  let off = false; // the server / SW said the feature is off: nothing more from this page
  const mutateState = (fn) => underHistoryLock(async () => {
    const s = await readLedger();
    const next = (await fn(s)) || s;
    await writeState(next);
    return next;
  });
  /**
   * 403 account_deleted (a PUT or a DELETE): the account is being erased with everything it had on the server, so
   * this browser's ledger for it goes WHOLE — every queued delete (a `*` included), every rev, every 410 mark —
   * under the history lock; then the page stops (batch r6: a `*` left queued was sent after the user signed up again
   * with the same email and wiped the NEW account's history).
   */
  async function forgetAccount() {
    off = true;
    await mutateState((s) => ({ ...s, revs: {}, dels: [], gone: [], held: {} }));
  }
  const stopIf = (r) => {
    if (r && SYNC_OFF_CODES.includes(r.code)) { off = true; return true; }
    return false;
  };

  /**
   * The ledger as decisions must see it — call under the history lock: a 「서버 기록도 삭제」 it has not taken in
   * yet (HISTORY_SYNC_WIPE_KEY newer than `wipeSeen`) is taken in first and written back (ledgerAfterWipe).
   */
  async function readLedger() {
    let s = readSyncState(await readState());
    const wipeAt = await readWipeAt();
    if (wipeAt > s.wipeSeen) { s = ledgerAfterWipe(s, wipeAt); await writeState(s); }
    return s;
  }
  /** Queued deletes, oldest first; stops at the first that fails (the rest keep their order). */
  async function drainDeletes() {
    const s = await underHistoryLock(readLedger);
    const done = [];
    for (const d of s.dels) {
      // Re-read before EACH request (Codex I1 #2): a delete another tab already sent, or a ledger forgotten since
      // (account_deleted), is not sent from this older read. The ledger is this ACCOUNT's (batch r7: one per owner),
      // and the SW sends a delete only with that owner's token — no other account's queue is ever drained here.
      const now = await underHistoryLock(readLedger);
      if (!now.dels.includes(d)) continue;
      // Not with the sync not offered (pre-CWS batch review) — checked before EACH request (Codex gate 1R #2: the flag
      // can go off while one is in flight): a queued delete waits in the ledger for the flag.
      if (!(await deletesOpen())) break;
      const r = await request(d === SYNC_DELETE_ALL ? { op: 'clear' } : { op: 'delete', id: d });
      if (r && (r.ok || r.status === HTTP_NOT_FOUND || r.status === HTTP_GONE)) { done.push(d); continue; }
      // 403 account_deleted (a DELETE too, like a PUT): the whole ledger goes (forgetAccount) — nothing is retried.
      if (r && r.code === SYNC_ACCOUNT_DELETED) { await forgetAccount(); return readSyncState(null); }
      stopIf(r);
      break;
    }
    if (!done.length) return s;
    return mutateState((cur) => { cur.dels = cur.dels.filter((x) => !done.includes(x)); });
  }

  async function putOnce(body, retried = false, baseOverride = null, owner = null) {
    if (!(await gatesOpen())) return;
    // Decided under the history lock from what is stored NOW: deleted (or written again) since this
    // settle → not this body. A newer settle sends its own.
    const pre = await underHistoryLock(async () => ({ s: await readLedger(), at: await storedUpdatedAt(body.id), count: await storedCount(body.id) }));
    if (pre.at !== body.updatedAt) return;
    if (putBlocked(pre.s, body.id)) return;
    // Wiped since (see `held`): goes up only once the conversation has grown here past what it was at the 410.
    if (Object.hasOwn(pre.s.held, body.id) && !(Number.isInteger(pre.count) && pre.count > pre.s.held[body.id])) return;
    const baseRev = baseOverride !== null ? baseOverride : (pre.s.revs[body.id] || 0);
    // `owner` rides beside the body (never in it): the SW sends the PUT only for the account that owns the entry.
    const r = await request({ op: 'put', id: body.id, baseRev, entry: body, owner });
    if (r && r.ok && Number.isInteger(r.rev)) {
      // Deleted while the PUT was in flight: its DELETE is queued and goes out next (after this PUT).
      await mutateState((s) => { if (!putBlocked(s, body.id)) { s.revs[body.id] = r.rev; delete s.held[body.id]; } });
      return;
    }
    if (r && r.code === SYNC_ACCOUNT_DELETED) { await forgetAccount(); return; }
    if (stopIf(r) || !r) return;
    // A blocking mark (gone) is recorded only if no wipe was taken in since this PUT was decided (Codex C3 #1):
    // an answer from before a 「서버 기록도 삭제」 describes a server copy that no longer exists.
    const sameWipe = (s) => s.wipeSeen === pre.s.wipeSeen;
    if (r.status === HTTP_CONFLICT && Number.isInteger(r.rev) && !retried) {
      // Single writer: only another tab of THIS browser wrote it meanwhile — this body (the latest stored, checked
      // above) goes on top of the server's rev, once. No UI, no loop (a second 409 waits for the next settle).
      await putOnce(body, true, r.rev, owner);
    } else if (r.status === HTTP_NOT_FOUND && r.code === SYNC_NOT_FOUND && baseRev > 0 && !retried) {
      // Dropped by the server's 50-per-account cap (not anything the user asked for): this browser's copy goes
      // up again as NEW (baseRev 0), once, right now; a second refusal is handled like any other.
      // Only while the rev is still the one that 404'd (Codex B1 #3): another PUT that set a new rev
      // meanwhile owns the id now — this older body is not sent on top of it.
      let reset = false;
      await mutateState((s) => { if (s.revs[body.id] === baseRev) { delete s.revs[body.id]; reset = true; } });
      if (reset) await putOnce(body, true, null, owner);
    } else if (r.status === HTTP_GONE && r.code === SYNC_WIPED && baseRev > 0) {
      // 「서버 기록도 삭제」 (any browser) since this rev: the rev is forgotten but NOTHING is sent now — a PUT
      // begun before the wipe must not bring an old conversation back without the user. The count stored NOW
      // already holds every settle written before this 410 (queued ones included): only a settle that adds to
      // it — the user continuing it here — uploads it again, as new (plan §7.8 ⑥). Only while the rev is unchanged.
      await mutateState(async (s) => {
        if (s.revs[body.id] !== baseRev) return;
        delete s.revs[body.id];
        const n = await storedCount(body.id);
        s.held[body.id] = Number.isInteger(n) ? n : 0;
      });
    } else if (r.status === HTTP_GONE) {
      // Deleted by the user (on another device too): this browser keeps its copy, and never uploads it again.
      await mutateState((s) => { if (sameWipe(s)) { delete s.revs[body.id]; delete s.held[body.id]; s.gone = [...new Set([...s.gone, body.id])].slice(-HISTORY_SYNC_QUEUE_MAX); } });
    } else if (r.status === HTTP_BAD_REQUEST || r.status === HTTP_TOO_LARGE) {
      // bad_id · bad_base_rev · bad_entry · attachment_not_allowed · too_large: the same conversation would be
      // refused again — it is not uploaded any more (no retry storm), logged once.
      await mutateState((s) => { s.gone = [...new Set([...s.gone, body.id])].slice(-HISTORY_SYNC_QUEUE_MAX); });
      warn(`upload refused (${r.status} ${r.code || ''}) — this conversation is no longer uploaded`);
    } else if (r.code !== SYNC_NO_TOKEN && r.code !== SYNC_PAUSED && r.code !== SYNC_OTHER_ACCOUNT) {
      // 409 again, 429 rate_limited, 5xx, network: one PUT per settle at most — the next settle retries quietly.
      warn(`upload failed (${r.status || 0} ${r.code || ''}) — retried at the next settle`);
    }
  }

  /** Deletes first, then (when given) the PUT of `body` — one at a time in this page, and across tabs. */
  function flush(body = null, owner = null) {
    const step = chain.then(() => (off ? null : withSyncLock(async () => {
      const s = await drainDeletes();
      if (off || !body) return;
      // putOnce decides from the ledger as it is THEN (readLedger — a queued delete, a wipe taken in since:
      // Codex C3 #2), never from this earlier read.
      await putOnce(body, false, null, owner);
      // A delete queued while the PUT was in flight goes right after it (never before). Only a NEW one:
      // a delete that already failed this flush waits for the next.
      const before = new Set(s.dels);
      if (!off && readSyncState(await underHistoryLock(readState)).dels.some((d) => !before.has(d))) await drainDeletes();
    }))).catch((e) => { warn(`sync step failed: ${e && e.message ? e.message : e}`); });
    chain = step.then(() => undefined, () => undefined);
    return step;
  }

  return { flush, mutateState, readLedger, isOff: () => off, stop: () => { off = true; } };
}

/** Installs the sync slice onto `ctx` (see ui/compare/history.js for the ctx contract). */
export function installHistorySync(ctx) {
  const { chrome, state, t, nav, con, clock, el, track } = ctx;
  const local = ctx.localStorageArea || null;
  // The switch lives in chrome.storage.LOCAL — this browser only (batch r5: chrome.storage.sync carried it to the
  // user's other browsers through Chrome sync; the privacy statement says the choice is per browser).
  const prefArea = local;
  let warned = false;
  const warn = (what) => {
    if (warned || !con || typeof con.warn !== 'function') return;
    warned = true;
    try { con.warn(`[compare] history sync: ${what}`); } catch { /* logging is not the op */ }
  };
  const lastErr = () => { try { return chrome && chrome.runtime ? chrome.runtime.lastError : null; } catch { return null; } };
  const setLocal = (obj) => new Promise((resolve) => {
    if (!local) { resolve(false); return; }
    try {
      const r = local.set(obj, () => resolve(!lastErr()));
      if (r && typeof r.then === 'function') r.then(() => resolve(true), () => resolve(false));
    } catch { resolve(false); }
  });
  const request = async (msg) => {
    const r = await sendMessage(chrome, { type: HISTORY_SYNC_MSG_TYPE, ...msg });
    return r && typeof r === 'object' ? r : { ok: false, status: 0, code: 'sw_unanswered' };
  };
  const locks = nav && nav.locks && typeof nav.locks.request === 'function' ? nav.locks : null;
  /** The network side's own cross-tab lock (bounded wait like the history lock; degraded = in-page chain only). */
  async function withSyncLock(fn) {
    if (!locks) return fn();
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    // A holder waiting on a slow server must not freeze the others forever: past the wait, run anyway.
    const timer = ac ? clock.setTimeout(() => { try { ac.abort(); } catch { /* settled */ } }, HISTORY_LOCK_WAIT_MS * 4) : null;
    try {
      return await locks.request(HISTORY_SYNC_LOCK_NAME, ac ? { signal: ac.signal } : {}, fn);
    } catch (e) {
      if (!(ac && ac.signal.aborted)) throw e;
      return fn();
    } finally {
      if (timer != null) clock.clearTimeout(timer);
    }
  }
  // The ledger is kept PER ACCOUNT (batch r7): `{ owners: { [owner]: ledger } }`. Each account's queue, revs and marks
  // are read and written only through ITS slot — signed in as B, nothing of A's is drained, uploaded or deleted.
  const readAll = async () => {
    const v = local ? await storageGet(chrome, local, HISTORY_SYNC_STATE_KEY) : null;
    const raw = v ? v[HISTORY_SYNC_STATE_KEY] : null;
    return { owners: plain(raw) && plain(raw.owners) ? { ...raw.owners } : {} };
  };
  const readStateOf = (owner) => async () => (await readAll()).owners[owner] || null;
  // Read-modify-write of the one key — callers hold the history lock (every ledger write does).
  const writeStateOf = (owner) => async (s) => {
    const all = await readAll();
    all.owners[owner] = readSyncState(s);
    return setLocal({ [HISTORY_SYNC_STATE_KEY]: all });
  };
  /** The account signed in now, as this page last read it (null signed out). */
  const currentOwner = () => ctx.viewerOwner();

  // ── the gates ──
  const flagOn = () => !!(state.status && state.status.historySyncOn === true && state.status.flagOn === true);
  const loggedIn = () => !!(state.status && state.status.loggedIn === true);
  // This page's writes of the switch, ONE chain (Codex B3·B4 — an override value raced every ordering of
  // late writes and other pages' changes): writes go out one after another, and every read of the switch
  // waits for them first, then reads what is STORED — the one truth, the options page's changes included.
  // Bounded: a write that never completes cannot hold a gate (read inside the history lock) for ever.
  let prefWrites = Promise.resolve();
  function writePref(on) {
    prefWrites = prefWrites.then(() => new Promise((resolve) => {
      try {
        if (!prefArea) { resolve(); return; }
        const r = prefArea.set({ [HISTORY_SYNC_PREF_KEY]: on }, () => { void lastErr(); resolve(); });
        if (r && typeof r.then === 'function') r.then(resolve, resolve);
      } catch { resolve(); }
    }));
    return prefWrites;
  }
  async function prefOn() {
    let timer = null;
    const settled = await Promise.race([prefWrites.then(() => true), new Promise((resolve) => { timer = clock.setTimeout(() => resolve(false), HISTORY_SYNC_PREF_WRITE_WAIT_MS); })]);
    if (timer != null) clock.clearTimeout(timer);
    // A write of the switch still not done: CLOSED (Codex B5) — the stored value may be the one the user just changed away from.
    if (!settled) return false;
    if (!prefArea) return false;
    const v = await storageGet(chrome, prefArea, { [HISTORY_SYNC_PREF_KEY]: true });
    return !!v && v[HISTORY_SYNC_PREF_KEY] !== false;
  }
  async function noticed() {
    if (!local) return false;
    const v = await storageGet(chrome, local, HISTORY_SYNC_NOTICED_KEY);
    return !!v && v[HISTORY_SYNC_NOTICED_KEY] === true;
  }
  /** Every upload / list gate: flag · login · the user's switch · the notice shown in this browser. */
  async function historySyncActive() {
    if (!flagOn() || !loggedIn()) return false;
    return (await prefOn()) && (await noticed());
  }

  // One engine per account: its own ledger slot, its own wipe mark, and every request it sends carries its owner (the SW
  // refuses a request whose owner is not the signed-in token's).
  const engines = new Map();
  function engineFor(owner) {
    if (!engines.has(owner)) {
      engines.set(owner, createSyncEngine({
        request: (msg) => request({ ...msg, owner }),
        underHistoryLock: (fn) => ctx.underHistoryLock(fn),
        withSyncLock,
        readState: readStateOf(owner),
        writeState: writeStateOf(owner),
        storedUpdatedAt: (id) => ctx.storedUpdatedAt(id),
        storedCount: (id) => ctx.storedCount(id),
        readWipeAt: async () => {
          const v = local ? await storageGet(chrome, local, HISTORY_SYNC_WIPE_KEY) : null;
          const marks = v ? v[HISTORY_SYNC_WIPE_KEY] : null;
          const at = plain(marks) ? marks[owner] : 0;
          return typeof at === 'number' && Number.isFinite(at) ? at : 0;
        },
        gatesOpen: historySyncActive,
        deletesOpen: async () => flagOn() && loggedIn(),
        warn,
      }));
    }
    return engines.get(owner);
  }
  const NO_ENGINE = Object.freeze({ flush: async () => null, isOff: () => true, stop: () => {} });
  const engineNow = () => { const o = currentOwner(); return o ? engineFor(o) : NO_ENGINE; };

  /**
   * After a settle's local write (history.js persistSession): `entry` is the very object written —
   * a history snapshot. Its upload body comes from syncEntryOf alone, fitted to the server's bound.
   */
  function historySyncPush(entry) {
    if (!flagOn() || !loggedIn()) return; // cheap first: a page without the feature does nothing at all
    // No owner (written while signed out, or before the feature): never uploaded — whoever signs in later (decision A).
    if (typeof entry.owner !== 'string' || !OWNER_RE.test(entry.owner)) return;
    if (entry.mixed === true) return; // more than one account's words: never uploaded (syncEntryOf refuses it too)
    const body = syncEntryOf(entry);
    if (!body) return;
    const fitted = ctx.fitEntry(body, HISTORY_SYNC_ENTRY_MAX_BYTES);
    if (!fitted || findImageKey(fitted) !== null) return;
    engineFor(entry.owner).flush(fitted, entry.owner);
  }

  /**
   * Inside a delete's / a clear's history-lock op: queue the server DELETEs (see queueDeletes) — each into the ledger of
   * the account that OWNS the entry (`items`: [{id, owner}]); another device's row (this account's server item) into
   * the signed-in account's. An entry with no owner was never uploaded: nothing to delete on a server.
   */
  async function historySyncNoteDelete(items, { all = false } = {}) {
    const me = currentOwner();
    const offered = flagOn() && loggedIn();
    // The switch is read (it may wait for a pending write of it) only for 「모두 삭제」, the one case it decides.
    const syncOn = all && offered && me ? await historySyncActive() : false;
    const remoteIds = (state.historyRemote || []).map((r) => r.id);
    const byOwner = new Map();
    for (const it of items) {
      const owner = it && typeof it.owner === 'string' && OWNER_RE.test(it.owner) ? it.owner : remoteIds.includes(it && it.id) ? me : null;
      if (!owner) continue;
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner).push(it.id);
    }
    if (all && syncOn && !byOwner.has(me)) byOwner.set(me, []);
    for (const [owner, ids] of byOwner) {
      // 「delete everything」 (`*`) only for the signed-in account, whose server rows the panel showed.
      const next = queueDeletes(await readStateOf(owner)(), ids, { all: all && owner === me, syncOn: syncOn && owner === me, offered: offered && owner === me, remoteIds });
      // Not queued = not deleted (Codex F1 #1): a ledger write that fails fails the delete op (historyUpdate runs no
      // write after a throwing mutate), so the entry stays and nothing reappears from the server later.
      if (!(await writeStateOf(owner)(next))) throw new Error('sync ledger write failed — delete not done');
    }
    listEpoch += 1; // a server list already on its way predates this delete (Codex F1 #2)
  }
  /** Out of the lock, after the delete's write: send what was queued (deletes first, always) — the signed-in account's. */
  function historySyncDrain() { engineNow().flush(null); }

  /**
   * The server's items this browser does not have — for the 「최근」 panel: [] while a gate is closed, null when
   * the answer is OUTDATED on arrival (a delete / 「서버 기록도 삭제」 / the switch since — Codex F2 #2: the caller
   * keeps what it shows rather than painting an empty list).
   */
  async function historySyncReadRemote(localList) {
    const epoch = listEpoch;
    const me = currentOwner();
    if (!me || engineFor(me).isOff() || !(await historySyncActive())) return [];
    await engineFor(me).flush(null); // queued deletes go first — and before the list, so a deleted item is not listed back
    const r = await request({ op: 'list', owner: me });
    if (!r || !r.ok || !Array.isArray(r.items)) return [];
    const s = readSyncState(await readStateOf(me)());
    // The account changed while the list was on its way: not this account's rows.
    if (currentOwner() !== me) return null;
    // Switched off while the list was on its way (Codex B1 #2): nothing from the server is painted under an off switch.
    // The epoch is compared LAST, after every await (Codex B2 #1): nothing can switch it between this check and the return.
    const active = await historySyncActive();
    if (!active) return [];
    if (listEpoch !== epoch) return null;
    return remoteOnlyRows(localList, r.items, s.dels);
  }

  let opening = false;
  /**
   * Open another device's item READ-ONLY (plan §7.8 ②): download it, validate it exactly like a stored entry
   * (normalizeEntry), and show it from memory — it is never written to this browser's history and never
   * uploaded from here. Continuing it forks it (history.js persistSession: a new session id, `forkedFrom`).
   * Opened only over the screen it was asked from: another conversation, 「새 대화」, a send or a typed first
   * question meanwhile is never replaced (Codex 4R·9R); drafts in the composers survive the load (5R).
   */
  async function historySyncOpenRemote(id) {
    if (opening || state.disabled || typeof id !== 'string' || !SESSION_ID_RE.test(id)) return;
    opening = true;
    const sessionAtStart = state.sessionId;
    const ownerAtStart = currentOwner(); // the account the item was listed for (Codex K1 #3)
    const freshDraft = () => (!state.sessionStarted && ctx.qInput ? String(ctx.qInput.value || '').trim() : '');
    const draftAtStart = freshDraft();
    try {
      ctx.closeHistoryPanel();
      let r = await request({ op: 'get', id, owner: currentOwner() });
      // 503 busy: a short backoff, a bounded number of times (never the 「off」 503 — see SYNC_BUSY).
      for (const ms of HISTORY_SYNC_GET_BACKOFF_MS) {
        if (!(r && r.status === HTTP_UNAVAILABLE && r.code === SYNC_BUSY)) break;
        await new Promise((resolve) => clock.setTimeout(resolve, ms));
        r = await request({ op: 'get', id, owner: currentOwner() });
      }
      if (r && SYNC_OFF_CODES.includes(r.code)) engineNow().stop(); // switched off server-side: nothing more from this page
      const entry = r && r.ok && plain(r.entry) && r.entry.id === id && Number.isInteger(r.rev) ? ctx.normalizeEntry(r.entry) : null;
      if (!entry) { ctx.showNotice('error', [t('hist_sync_open_failed')]); return; }
      if (state.sending || state.sessionId !== sessionAtStart || freshDraft() !== draftAtStart || currentOwner() !== ownerAtStart) { ctx.showNotice('info', [t('hist_sync_open_skipped')]); return; }
      track('history_remote_open', {});
      const keep = (ctx.composers || []).map((c) => (c && c.input ? c.input.value : ''));
      ctx.loadSession(entry, { remote: true });
      // loadSession empties the composers — what the user typed is put back (Codex 5R).
      (ctx.composers || []).forEach((c, i) => { if (c && c.input && keep[i] && !c.input.value) c.input.value = keep[i]; });
    } finally {
      opening = false;
    }
  }

  // ── the first-screen notice (plan §1 / §7.7): once per browser, before anything uploads ──
  let banner = null;
  let noticeDone = false; // shown on this page, or already shown in this browser — never asked again here
  let noticeChecking = false;
  // The account the history is shown for (batch r7): a status read that finds another one re-draws 「최근」 for it.
  let shownOwner;
  function followAccount() {
    const me = currentOwner();
    if (shownOwner === undefined) { shownOwner = me; return; }
    if (me === shownOwner) return;
    shownOwner = me;
    listEpoch += 1; // a server list on its way was the previous account's
    state.historyRemote = [];
    // The rows on screen are re-filtered NOW, not after the read below (Codex K1 #2).
    if (ctx.renderHistoryList) ctx.renderHistoryList(state.historyCache || []);
    ctx.historyUpdate(null).then((r) => {
      ctx.syncHistoryButton(r.ok ? r.list : null);
      if (ctx.historyPanel && !ctx.historyPanel.hidden) ctx.openHistoryPanel(); // re-read for the new account (its server rows too)
    }, () => {});
  }
  async function historySyncStatus() {
    followAccount();
    if (noticeDone || noticeChecking || banner || state.disabled || !flagOn() || !loggedIn() || !local) return;
    noticeChecking = true;
    try {
      // The switch off is NOT final (Codex 1R #3): turned on later in the options, the next status read asks again.
      if (!(await prefOn())) return;
      if (await noticed()) { noticeDone = true; return; }
      if (state.disabled || banner) return;
      banner = renderBanner();
      // Only a banner that is ON the page opens the gate (Codex 2R #1) — nowhere to put it, ask again later.
      if (banner) noticeDone = true;
    } finally {
      noticeChecking = false;
    }
    if (!banner) return;
    // SHOWN = the gate opens (the notice is the user's chance to say no before anything goes up).
    await setLocal({ [HISTORY_SYNC_NOTICED_KEY]: true });
    track('history_sync_notice', { action: 'shown' });
  }
  function renderBanner() {
    const box = el('div', 'cmp-hist-sync-banner');
    box.id = 'cmp-hist-sync-banner';
    box.setAttribute('role', 'note');
    const text = el('div', 'cmp-hist-sync-banner-text');
    text.appendChild(el('p', 'cmp-hist-sync-banner-title', t('hist_sync_notice_title')));
    text.appendChild(el('p', 'cmp-hist-sync-banner-desc', t('hist_sync_notice_desc')));
    box.appendChild(text);
    const actions = el('div', 'cmp-hist-sync-banner-actions');
    const offBtn = el('button', 'cmp-btn cmp-btn-sm', t('hist_sync_notice_off'));
    offBtn.type = 'button';
    const okBtn = el('button', 'cmp-btn cmp-btn-sm cmp-btn-primary', t('hist_sync_notice_ok'));
    okBtn.type = 'button';
    const close = () => { if (box.parentNode) box.parentNode.removeChild(box); banner = null; };
    offBtn.addEventListener('click', () => {
      // The same switch the options page shows (chrome.storage.local — this browser only).
      writePref(false);
      track('history_sync_notice', { action: 'off' });
      close();
    });
    okBtn.addEventListener('click', () => { track('history_sync_notice', { action: 'ok' }); close(); });
    actions.appendChild(offBtn);
    actions.appendChild(okBtn);
    box.appendChild(actions);
    if (!ctx.noticeBox || !ctx.noticeBox.parentNode) return null;
    ctx.noticeBox.parentNode.insertBefore(box, ctx.noticeBox);
    return box;
  }

  // ── the 「최근」 panel's own controls (batch review: /privacy §10.2 promises the switch ON this page) ──
  // The same switch as the options page (HISTORY_SYNC_PREF_KEY in chrome.storage.sync) and the same
  // 「서버 기록도 삭제」 (COMPARE_HISTORY `clear`) — always there while the feature is offered, not only in
  // the one-time banner.
  let panelBox = null;
  let listEpoch = 0; // bumped by the panel switch, a delete, 「서버 기록도 삭제」 — a list read started before it is dropped (Codex B1·F1)
  let panelToggle = null;
  let panelClear = null;
  let panelMsg = null;
  function historySyncPanelControls() {
    panelBox = el('div', 'cmp-hist-sync-panel');
    panelBox.id = 'cmp-hist-sync-panel';
    panelBox.hidden = true;
    const label = el('label', 'cmp-hist-sync-panel-label');
    panelToggle = el('input', 'cmp-hist-sync-toggle');
    panelToggle.type = 'checkbox';
    panelToggle.id = 'cmp-hist-sync-toggle';
    label.appendChild(panelToggle);
    label.appendChild(el('span', null, t('hist_sync_toggle')));
    panelBox.appendChild(label);
    panelClear = el('button', 'cmp-btn cmp-btn-sm cmp-hist-sync-clear', t('hist_sync_server_clear'));
    panelClear.type = 'button';
    panelBox.appendChild(panelClear);
    panelMsg = el('span', 'cmp-hist-sync-panel-msg');
    panelMsg.setAttribute('role', 'status');
    panelBox.appendChild(panelMsg);
    panelToggle.addEventListener('change', async () => {
      const on = !!panelToggle.checked;
      listEpoch += 1;
      // Off: the server rows leave the list at once, not after the write (Codex B2 #2).
      if (!on) { state.historyRemote = []; ctx.syncHistoryButton(null); ctx.paintHistoryList(); }
      // Every gate read waits for this write (writePref / prefOn) — the notice check below included (Codex B1 #1).
      await writePref(on);
      track('history_sync_toggle', { on: on ? 1 : 0 });
      // Switched on here without the first-screen notice ever shown: it shows now (and only then opens the gate);
      // then the server's rows come in without a reopen (Codex F1 #4).
      if (on) {
        await historySyncStatus();
        // The FULL local list (not the capped view on screen — Codex K3): a local entry is never listed again as a server row.
        const all = await ctx.historyUpdate(null);
        const rows = all.ok ? await historySyncReadRemote(all.list) : null;
        if (rows !== null && panelToggle.checked) { state.historyRemote = rows; ctx.syncHistoryButton(null); ctx.paintHistoryList(); }
      }
    });
    panelClear.addEventListener('click', async () => {
      const ask = ctx.win && typeof ctx.win.confirm === 'function' ? ctx.win.confirm.bind(ctx.win) : null;
      if (ask && !ask(t('hist_sync_server_clear_confirm'))) return;
      panelClear.disabled = true;
      panelMsg.textContent = '';
      const r = await request({ op: 'clear', wipe: true, owner: currentOwner() }); // the SW marks the wipe for that account
      panelClear.disabled = !loggedIn();
      if (r && r.ok) {
        listEpoch += 1; // a list read already on its way predates the wipe (Codex F1 #2)
        state.historyRemote = [];
        ctx.syncHistoryButton(null);
        ctx.paintHistoryList();
      }
      panelMsg.textContent = t(r && r.ok ? 'hist_sync_server_clear_done' : r && r.code === SYNC_NO_TOKEN ? 'hist_sync_server_clear_login' : 'hist_sync_server_clear_failed');
      track('history_sync_server_clear', { ok: r && r.ok ? 1 : 0 });
    });
    return panelBox;
  }
  // The switch changed elsewhere (the options page, another tab) while the panel is open: it follows, and an 「off」
  // takes the server rows out at once (batch r6 후속).
  try {
    if (chrome && chrome.storage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes || !changes[HISTORY_SYNC_PREF_KEY]) return;
        const on = changes[HISTORY_SYNC_PREF_KEY].newValue !== false;
        if (panelToggle) panelToggle.checked = on;
        if (!on) { listEpoch += 1; state.historyRemote = []; ctx.syncHistoryButton(null); if (ctx.historyPanel && !ctx.historyPanel.hidden) ctx.paintHistoryList(); }
      });
    }
  } catch { /* no storage events (tests): the next panel open reads it */ }
  /** On every panel open: shown while the feature is offered; the switch reads the stored value. */
  async function historySyncPanelSync() {
    if (!panelBox) return;
    panelBox.hidden = !flagOn();
    if (panelBox.hidden) return;
    panelMsg.textContent = '';
    panelClear.disabled = !loggedIn();
    panelToggle.checked = await prefOn();
  }

  Object.assign(ctx, { historySyncPanelControls, historySyncPanelSync, historySyncPush, historySyncNoteDelete, historySyncDrain, historySyncReadRemote, historySyncOpenRemote, historySyncStatus, historySyncActive });
}
