// bg/skill-update.js — keeps the claude.ai copies of team skills up to date (#2821, docs/plans/skill-team.md §15).
//
// 「claude.ai에 바로 추가」 through this extension starts tracking: we remember which team skill went into which claude.ai
// skill, and every few hours ask Claude Tuner whether it has a newer version. Auto mode (the default) writes it; manual
// mode only says so. The rules are the plan's §15-2 invariants — every one of them is enforced HERE, nowhere else:
//
//  ① this module is the only source of truth and the only writer. Every write (auto, manual, a notification button, the
//    dashboard, the old SKILL_APPLY, a removal, a rollback) runs through ONE serial queue, one job at a time. A job pins
//    its context {tuner, cacct, org} at start and changes a record only while that context still holds.
//  ② the baseline (sid, name, head, cacct) comes only from the answer to OUR upload of a zip WE fetched from the server.
//    A re-read of the list never becomes a baseline.
//  ③ an automatic write needs all of: same Tuner account · same claude.ai account and org · the skill still there with
//    the recorded name and version mark · no inflight / check / paused — checked again right before the write.
//  ④ the intent is stored before the upload (`inflight`). An answer we did not get leaves it → `check: 'unknown'`,
//    never retried by itself, and never cleared except by the user (「추적 그만」 / 「팀 판으로 바꾸기」).
//  ⑤ anything doubtful becomes `check` — the user decides. A false alarm only costs one more question.
//  ⑥ one claude.ai skill ↔ one team skill, checked BEFORE writing.
//  ⑦ known gap (accepted): claude.ai has no conditional write, so a change made in the seconds between the last check and
//    the upload can be overwritten.
//
// The page never sends a zip or a URL here — team skill ids only. The zip comes from our server (`server.download`).
import { chatOrgsOf, personalSkillsOf, uploadSkillZip, checkApplyZip, rejectedResult } from './skills-import.js';

export const SKILL_TRACK_PROTO = 'SKILL_TRACK_PROTO';
export const SKILL_ADD_TRACKED = 'SKILL_ADD_TRACKED';
export const SKILL_TRACK_STATE = 'SKILL_TRACK_STATE';
export const SKILL_TRACK_ACTION = 'SKILL_TRACK_ACTION';
export const SKILL_UPDATE_PREF = 'SKILL_UPDATE_PREF';
/** The dashboard's 「⚙ 설정」: open this extension's options at the auto-update switch (proto ≥ 2). */
export const SKILL_OPEN_SETTINGS = 'SKILL_OPEN_SETTINGS';
export const SKILL_TRACK_MESSAGES = [SKILL_TRACK_PROTO, SKILL_ADD_TRACKED, SKILL_TRACK_STATE, SKILL_TRACK_ACTION, SKILL_UPDATE_PREF, SKILL_OPEN_SETTINGS];
/** What a page asks with SKILL_TRACK_PROTO. SKILL_APPLY's probe only says 「바로 추가」 works, not that tracking does.
 *  2 = SKILL_OPEN_SETTINGS (the switch lives in the options page; the dashboard only links to it). */
export const TRACK_PROTO_VERSION = 2;

/** chrome.storage.local keys. */
export const TRACK_KEY = 'skillTracked';      // { <team skill id>: record }
export const PREF_KEY = 'skillUpdateAuto';    // boolean, default true
export const META_KEY = 'skillUpdateMeta';    // { me, lastCheck, info: { <id>: server row }, doneDay, waitKeys: [] }

const TEAM_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const ORG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT_PATH = '/api/account';
/** Ids per server check (the worker's SKILL_UPDATE_IDS_MAX). */
export const UPDATE_IDS_CHUNK = 50;
/** A version claude.ai refused this many times is not tried again until a newer one or the user's 「다시 시도」. */
export const FAIL_STOP = 2;
/** A claude.ai tab opening re-checks when the last check is older than this. */
export const TAB_RECHECK_MS = 60 * 60 * 1000;
/** The dashboard shows the last automatic update (with 「되돌리기」) for this long. */
export const RECENT_UPDATE_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIONS = ['update', 'force', 'untrack', 'revert', 'resume', 'retry'];
/** Why a record is held for the user (plan §15-2 ⑤). */
export const CHECK = { changed: 'changed', unknown: 'unknown', conflict: 'conflict' };

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * deps:
 *  fetchApi(path, options)   claude.ai (bg/api.js fetchClaudeApi)
 *  server.tokenEmail()       the login-proven ext_token's email, or null (local — detects a switch mid-job)
 *  server.updates(ids)       → { ok: true, me, skills, gone } | { ok: false }
 *  server.held(ids, email)   → { ok }  (#2915 — optional: absent = not reported; only with `email`'s token)
 *  server.download(id, v, use) → { ok: true, base64, version } | { ok: false, status }
 *  store.get(keys) / store.set(obj)   chrome.storage.local
 *  notify({ kind: 'done' | 'wait' | 'clear_wait', items })  → Promise<boolean> (shown) — the background words it
 *  now(), newId()
 */
export function createSkillUpdater(deps) {
  const { fetchApi, server, store, notify = async () => false, now = Date.now, newId = () => crypto.randomUUID(), openSettings = async () => false } = deps;

  // ── the serial queue (①) ──
  let chain = Promise.resolve();
  function enqueue(job) {
    const run = chain.then(job, job);
    chain = run.catch(() => {});
    return run;
  }

  // ── storage ──
  async function load() {
    const got = await store.get([TRACK_KEY, META_KEY, PREF_KEY]);
    return {
      recs: isObj(got[TRACK_KEY]) ? got[TRACK_KEY] : {},
      meta: isObj(got[META_KEY]) ? got[META_KEY] : {},
      auto: got[PREF_KEY] !== false,
    };
  }
  async function saveRecs(recs) { await store.set({ [TRACK_KEY]: recs }); }
  async function saveMeta(meta) { await store.set({ [META_KEY]: meta }); }
  /** Change one record: fn(rec) → the new record, or null to drop it. */
  async function mutate(teamId, fn) {
    const { recs } = await load();
    const next = fn(recs[teamId] || null);
    if (next) recs[teamId] = next; else delete recs[teamId];
    await saveRecs(recs);
    return next;
  }

  // ── context (①) ──
  async function claudeAccount() {
    try {
      const a = await fetchApi(ACCOUNT_PATH, { quiet: true });
      return a && typeof a.uuid === 'string' && ORG_UUID_RE.test(a.uuid) ? a.uuid : null;
    } catch (e) { return null; }
  }
  /** { email, cacct, orgs } or { reason }. */
  async function context() {
    const email = await server.tokenEmail();
    if (!email) return { reason: 'tuner_login' };
    const cacct = await claudeAccount();
    if (!cacct) return { reason: 'claude_login' };
    const got = await chatOrgsOf(fetchApi);
    if (got.reason) return { reason: got.reason };
    return { email, cacct, orgs: got.orgs };
  }
  /** The pinned context still holds (Tuner token and claude.ai account unchanged). */
  async function sameContext(ctx) {
    return (await server.tokenEmail()) === ctx.email && (await claudeAccount()) === ctx.cacct;
  }
  /** The record belongs to this context. */
  const ownedBy = (rec, ctx, me) => rec && rec.tuner === me && rec.cacct === ctx.cacct;

  async function rowOf(org, sid) {
    const got = await personalSkillsOf(fetchApi, org);
    if (got.reason) return { reason: got.reason };
    return { row: got.rows.find((r) => r.skill_id === sid) || null, rows: got.rows };
  }

  /** A job left an `inflight` behind (the worker died, or the answer never came): it is now a held 'unknown' (④). */
  const settleInflight = (rec) => (rec && rec.inflight ? { ...rec, inflight: null, check: { reason: CHECK.unknown, v: rec.inflight.v } } : rec);

  /**
   * One update of a tracked skill. mode: 'auto' | 'manual' | 'force' (after a check: skips the version-mark test only) |
   * 'revert' (to prevV). `info` = the server row for it. Runs inside the queue.
   * → { ok: true, v } | { ok: false, reason }
   */
  async function runUpdate(teamId, mode, info, ctx, me) {
    let rec = (await load()).recs[teamId];
    if (!rec) return { ok: false, reason: 'not_tracked' };
    if (!ownedBy(rec, ctx, me)) return { ok: false, reason: 'other_account' };
    const org = ctx.orgs.find((o) => o.uuid === rec.org);
    if (!org) return { ok: false, reason: 'other_account' };
    if (rec.inflight) { await mutate(teamId, settleInflight); return { ok: false, reason: 'check' }; }
    if (mode !== 'force' && rec.check) return { ok: false, reason: 'check' };
    if (mode === 'auto' && rec.paused) return { ok: false, reason: 'paused' };
    const versions = Array.isArray(info.versions) ? info.versions : [info.latest_version];
    const target = mode === 'revert' ? rec.prevV : info.latest_version;
    if (!Number.isInteger(target) || !versions.includes(target)) return { ok: false, reason: mode === 'revert' ? 'no_prev' : 'error' };
    if ((mode === 'auto' || mode === 'manual') && !(target > (rec.v || 0))) return { ok: false, reason: 'up_to_date' };
    if (mode === 'auto' && rec.fail && rec.fail.v === target && rec.fail.n >= FAIL_STOP) return { ok: false, reason: 'failed' };

    // ③ the copy is still ours, as we left it — then once more right before the write.
    const verify = async () => {
      const got = await rowOf(org, rec.sid);
      if (got.reason) return got.reason;
      if (!got.row) return 'removed';
      if (got.row.name !== rec.name) return 'renamed';
      if (mode !== 'force' && got.row.head !== rec.head) return 'changed';
      return null;
    };
    const held = async (why) => {
      // A list read under another account (switched mid-job) must not end or hold this account's record (R1-B1).
      if ((why === 'removed' || why === 'renamed' || why === 'changed') && !(await sameContext(ctx))) return { ok: false, reason: 'other_account' };
      if (why === 'removed') {
        // The user removed it in claude.ai: stop tracking — never reinstall. A held record stays for the user (④).
        await mutate(teamId, (r) => (r && !r.inflight && !r.check && (mode !== 'force') ? null : r));
        return { ok: false, reason: 'removed' };
      }
      if (why === 'renamed' || why === 'changed') {
        // A rename makes an overwrite create a NEW skill (measured §15-1): even 「팀 판으로 바꾸기」 cannot do it.
        await mutate(teamId, (r) => (r ? { ...r, check: { reason: CHECK.changed, renamed: why === 'renamed' || undefined } } : r));
        return { ok: false, reason: why };
      }
      return { ok: false, reason: why };   // claude_login / rate_limit / error: next time
    };
    let why = await verify();
    if (why) return held(why);

    const dl = await server.download(teamId, target, false);
    if (!dl.ok || dl.version !== target || checkApplyZip(dl.base64) !== 'ok') return { ok: false, reason: 'error' };
    if (!(await sameContext(ctx))) return { ok: false, reason: 'other_account' };
    why = await verify();
    if (why) return held(why);

    // Auto-update switched off while this run was under way: no automatic write from here on (R1-B2).
    if (mode === 'auto' && !(await load()).auto) return { ok: false, reason: 'auto_off' };
    // ④ the intent before the write.
    rec = await mutate(teamId, (r) => (r ? { ...r, inflight: { v: target, mode, at: now() } } : r));
    if (!rec) return { ok: false, reason: 'not_tracked' };
    // The account once more as the last request before the write: a switch after the list read must not let the upload
    // land in the other account (batch R1-B1). What remains is ⑦'s gap — one request, no conditional write.
    if (!(await sameContext(ctx))) {
      await mutate(teamId, (r) => (r ? { ...r, inflight: null } : r));
      return { ok: false, reason: 'other_account' };
    }
    const up = await uploadSkillZip(fetchApi, org.uuid, dl.base64, true, ctx.cacct);
    if (!up.ok) {
      if (up.reason === 'unknown') { await mutate(teamId, settleInflight); return { ok: false, reason: 'unknown' }; }
      await mutate(teamId, (r) => {
        if (!r) return r;
        const out = { ...r, inflight: null };
        if (up.reason === 'rejected') out.fail = { v: target, n: (r.fail && r.fail.v === target ? r.fail.n : 0) + 1 };
        return out;
      });
      return up.reason === 'rejected' ? rejectedResult(up.code) : { ok: false, reason: up.reason };
    }
    if (up.skill.id !== rec.sid || up.skill.owner !== rec.cacct) {
      // ⑤ not the skill we meant: maybe a new one, maybe another. Kept for the user; never re-linked or removed.
      await mutate(teamId, (r) => (r ? { ...r, inflight: null, check: { reason: CHECK.conflict, retId: up.skill.id } } : r));
      return { ok: false, reason: 'conflict' };
    }
    await mutate(teamId, (r) => (r ? {
      ...r, v: target, head: up.skill.head, name: up.skill.name || r.name, inflight: null, fail: null,
      check: mode === 'force' ? null : r.check,
      prevV: mode === 'revert' ? null : r.v,
      last: mode === 'revert' ? null : { from: r.v, v: target, at: now(), mode },
    } : r));
    return { ok: true, v: target };
  }

  // ── the periodic check ──

  /** Server rows for these ids, chunked. → { me, rows: Map, gone: Set } | null (could not ask: skip the run) */
  async function ask(ids) {
    const rows = new Map(), gone = new Set();
    let me = null;
    for (let i = 0; i < ids.length; i += UPDATE_IDS_CHUNK) {
      const r = await server.updates(ids.slice(i, i + UPDATE_IDS_CHUNK));
      if (!r || !r.ok || typeof r.me !== 'string' || (me && r.me !== me)) return null;
      me = r.me;
      for (const s of r.skills || []) if (s && TEAM_ID_RE.test(s.id) && Number.isInteger(s.latest_version)) rows.set(s.id, s);
      for (const g of r.gone || []) gone.add(g);
    }
    return { me, rows, gone };
  }
  const infoView = (s) => ({
    name: s.name, latest_version: s.latest_version, versions: s.versions, edit_summary: s.edit_summary || null,
    by: s.proposed_by_name || s.uploaded_by_name || null, uploaded_at: s.uploaded_at || null,
  });

  /**
   * Check every tracked skill once (inside the queue). Auto mode writes what is safe; manual mode only lists it.
   * Notifications: at most one 「완료」 a day, one 「대기」 per new (record, version) set (plan §15-6).
   */
  function checkAll() {
    return enqueue(async () => {
      const { recs, meta, auto } = await load();
      const ids = Object.keys(recs).filter((id) => TEAM_ID_RE.test(id));
      if (!ids.length) return { skipped: 'none' };
      const ctx = await context();
      if (ctx.reason) return { skipped: ctx.reason };
      const got = await ask(ids);
      if (!got) return { skipped: 'server' };
      const { me, rows, gone } = got;
      if (!(await sameContext(ctx))) return { skipped: 'other_account' };
      const done = [];
      // A copy removed in claude.ai itself ends its record even with no new version to write (batch R1-B4): each org's
      // list is read once per run; a list we could not read decides nothing.
      const lists = new Map();
      const present = async (rec) => {
        if (!rec.sid) return null;
        if (!lists.has(rec.org)) {
          const org = ctx.orgs.find((o) => o.uuid === rec.org);
          const got = org ? await personalSkillsOf(fetchApi, org) : { reason: 'other_account' };
          lists.set(rec.org, got.reason ? null : got.rows);
        }
        const rows = lists.get(rec.org);
        return rows ? rows.some((r) => r.skill_id === rec.sid) : null;
      };
      for (const id of ids) {
        const rec = (await load()).recs[id];
        if (!ownedBy(rec, ctx, me)) continue;   // another account's record: never touched (①)
        if (rec.inflight) { await mutate(id, settleInflight); continue; }   // no job runs now: a leftover is 'unknown'
        if (gone.has(id)) {
          // deleted / left the org / outside the rollout — held ones stay (④), and only under the context we asked with (①)
          if (!rec.check && (await sameContext(ctx))) await mutate(id, () => null);
          continue;
        }
        if (!rec.check && (await present(rec)) === false && (await sameContext(ctx))) {
          await mutate(id, (r) => (r && !r.inflight && !r.check ? null : r));
          continue;
        }
        const info = rows.get(id);
        if (!info || !auto || rec.check || rec.paused || !(info.latest_version > (rec.v || 0))) continue;
        const r = await runUpdate(id, 'auto', info, ctx, me);
        if (r.ok) done.push({ id, name: info.name, v: r.v, summary: info.edit_summary || null, by: infoView(info).by });
      }
      // 「보유」 (#2915): only this account's records whose copy the claude.ai list just showed — never a guess.
      if (server.held && (await sameContext(ctx))) {
        const recsNow = (await load()).recs, held = [];
        for (const id of ids) {
          const rec = recsNow[id];
          if (rec && ownedBy(rec, ctx, me) && !rec.inflight && !gone.has(id) && (await present(rec)) === true) held.push(id);
        }
        // Sent only with the token of the account pinned at the start (R2-B1): a switch while the lists were read sends nothing.
        for (let i = 0; i < held.length && (await sameContext(ctx)); i += UPDATE_IDS_CHUNK) await server.held(held.slice(i, i + UPDATE_IDS_CHUNK), ctx.email).catch(() => null);
      }
      const info = {};
      for (const [id, s] of rows) info[id] = infoView(s);
      const next = { ...(await load()).meta, me, lastCheck: now(), info };
      await saveMeta(next);
      await announce(done, ctx, me);
      return { done: done.length };
    });
  }

  const localDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

  /** The two notifications. Waiting = manual-mode new versions (not held, not paused). */
  async function announce(done, ctx, me) {
    const { recs, meta, auto } = await load();
    let changed = false;
    if (done.length && meta.doneDay !== localDay(now())) {
      if (await notify({ kind: 'done', items: done })) { meta.doneDay = localDay(now()); changed = true; }
    }
    const waiting = auto ? [] : waitingOf(recs, meta, ctx, me);
    const keys = waiting.map((w) => `${w.lid}:${w.v}`).sort();
    const known = new Set(Array.isArray(meta.waitKeys) ? meta.waitKeys : []);
    if (!keys.length) {
      if (known.size) { await notify({ kind: 'clear_wait', items: [] }); meta.waitKeys = []; changed = true; }
    } else if (keys.some((k) => !known.has(k))) {
      if (await notify({ kind: 'wait', items: waiting })) { meta.waitKeys = keys; changed = true; }
    }
    if (changed) await saveMeta(meta);
  }

  function waitingOf(recs, meta, ctx, me) {
    const out = [];
    for (const [id, rec] of Object.entries(recs)) {
      const info = meta.info && meta.info[id];
      if (!info || (ctx && !ownedBy(rec, ctx, me)) || rec.check || rec.paused || rec.inflight) continue;
      if (info.latest_version > (rec.v || 0)) out.push({ id, lid: rec.lid, name: info.name || rec.name, v: info.latest_version, from: rec.v, summary: info.edit_summary, by: info.by });
    }
    return out;
  }

  /** A claude.ai tab opened: check when the last one is old enough. */
  async function maybeCheck() {
    const { recs, meta } = await load();
    if (!Object.keys(recs).length || now() - (meta.lastCheck || 0) < TAB_RECHECK_MS) return { skipped: 'recent' };
    return checkAll();
  }

  // ── 「claude.ai에 바로 추가」 through the extension: the only way a record is born (②) ──

  function add(message) {
    const teamId = message && message.team_id;
    if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) return Promise.resolve({ ok: false, reason: 'invalid' });
    if (message.org_id !== undefined && (typeof message.org_id !== 'string' || !ORG_UUID_RE.test(message.org_id))) return Promise.resolve({ ok: false, reason: 'invalid' });
    const overwrite = message.overwrite === true;
    return enqueue(async () => {
      const ctx = await context();
      if (ctx.reason) return { ok: false, reason: ctx.reason };
      const got = await ask([teamId]);
      if (!got) return { ok: false, reason: 'error' };
      const info = got.rows.get(teamId);
      if (!info) return { ok: false, reason: 'not_found' };
      const { me } = got;
      // The page names its account; the extension acts only when it is the same one (U3 R1-B2).
      if (message.acct_key !== me) return { ok: false, reason: 'other_account' };
      const { recs } = await load();
      const mine = recs[teamId];
      // ⑥ already tracked here: the update path (its held states stand — 「추가」 again does not reset them).
      if (ownedBy(mine, ctx, me)) {
        if (mine.inflight || mine.check) return { ok: false, reason: 'check' };
        if (mine.paused) return { ok: false, reason: 'paused' };   // a rollback stands until 「다시 켜기」 (R1-B3)
        if (info.latest_version > (mine.v || 0)) {
          const r = await runUpdate(teamId, 'manual', info, ctx, me);
          return r.ok ? { ok: true, org_id: mine.org, skill_id: mine.sid, name: mine.name, v: r.v } : r;
        }
        // Up to date — if the copy is still there. One removed in claude.ai is added afresh (batch R1-B4).
        const mineOrg = ctx.orgs.find((o) => o.uuid === mine.org);
        const there = mineOrg && mine.sid ? await rowOf(mineOrg, mine.sid) : { reason: 'other_account' };
        if (there.reason) return { ok: false, reason: there.reason };
        if (there.row) return { ok: true, org_id: mine.org, skill_id: mine.sid, name: mine.name, v: mine.v, already: true };
        if (!(await sameContext(ctx))) return { ok: false, reason: 'other_account' };
        await mutate(teamId, () => null);
      }
      let org;
      if (message.org_id) {
        org = ctx.orgs.find((o) => o.uuid === message.org_id);
        if (!org) return { ok: false, reason: 'invalid' };
      } else if (ctx.orgs.length === 1) {
        org = ctx.orgs[0];
      } else {
        return { ok: false, reason: 'pick_org', orgs: ctx.orgs.map((o) => ({ org_id: o.uuid, org_name: String(o.name || '').slice(0, 100) })) };
      }
      // ⑥ before writing: a same-named claude.ai skill that another team skill tracks is not ours to overwrite.
      const list = await personalSkillsOf(fetchApi, org);
      if (list.reason) return { ok: false, reason: list.reason };
      const same = list.rows.find((r) => r.name === info.name) || null;
      if (same) {
        const linked = Object.entries(recs).some(([tid, r]) => tid !== teamId && r && r.cacct === ctx.cacct && r.org === org.uuid && r.sid === same.skill_id);
        if (linked) return { ok: false, reason: 'linked_other' };
        if (!overwrite) return { ok: false, reason: 'exists', org_id: org.uuid };
      }
      const dl = await server.download(teamId, info.latest_version, true);
      if (!dl.ok || dl.version !== info.latest_version || checkApplyZip(dl.base64) !== 'ok') return { ok: false, reason: 'error' };
      if (!(await sameContext(ctx))) return { ok: false, reason: 'other_account' };
      const lid = newId();
      // Another account's record this add would replace: put back when the add stops before writing (batch R2-B1).
      const prev = (await load()).recs[teamId] || null;
      const restore = () => mutate(teamId, () => prev);
      // ④ the intent before the write (a fresh record — an explicit 「추가」 replaces another account's old one here).
      await mutate(teamId, () => ({ lid, tuner: me, cacct: ctx.cacct, org: org.uuid, sid: same ? same.skill_id : null, name: info.name, v: null, head: null, inflight: { v: info.latest_version, mode: 'add', at: now() } }));
      if (!(await sameContext(ctx))) { await restore(); return { ok: false, reason: 'other_account' }; }   // batch R1-B1
      const up = await uploadSkillZip(fetchApi, org.uuid, dl.base64, overwrite, ctx.cacct);
      if (!up.ok) {
        if (up.reason === 'unknown') { await mutate(teamId, settleInflight); return { ok: false, reason: 'unknown' }; }
        await restore();   // answered, nothing written: the replaced record stands
        if (up.reason === 'exists') return { ok: false, reason: 'exists', org_id: org.uuid };
        return up.reason === 'rejected' ? rejectedResult(up.code) : { ok: false, reason: up.reason };
      }
      const clash = (same && up.skill.id !== same.skill_id) || up.skill.owner !== ctx.cacct
        || Object.entries((await load()).recs).some(([tid, r]) => tid !== teamId && r && r.cacct === ctx.cacct && r.org === org.uuid && r.sid === up.skill.id);
      if (clash) {
        await mutate(teamId, (r) => (r ? { ...r, inflight: null, sid: r.sid || up.skill.id, check: { reason: CHECK.conflict, retId: up.skill.id } } : r));
        return { ok: false, reason: 'conflict' };
      }
      await mutate(teamId, (r) => (r ? { ...r, sid: up.skill.id, name: up.skill.name || info.name, v: info.latest_version, head: up.skill.head, inflight: null } : r));
      const meta = (await load()).meta;
      await saveMeta({ ...meta, me, info: { ...(meta.info || {}), [teamId]: infoView(info) } });
      return { ok: true, org_id: org.uuid, skill_id: up.skill.id, name: up.skill.name, v: info.latest_version };
    });
  }

  /**
   * The claude.ai picker's 「스킬」 list (#2905): the team skills + which this account tracks now (Tuner key from the
   * list answer + the current claude.ai account; a record of another account says nothing here). Read-only.
   */
  async function listForPicker() {
    if (!server.list) return { ok: false, reason: 'unavailable' };
    const r = await server.list();
    if (!r.ok) return { ok: false, status: r.status || 0 };
    const { recs, meta } = await load();
    const cacct = await claudeAccount();
    const tracked = {};
    for (const [id, rec] of Object.entries(recs)) {
      // The claude.ai account unknown (no tab, cookie path blocked): no record is claimed as this account's (R1-B1) —
      // the button then offers 「추가」 and the add path decides with the account it reads itself.
      if (!rec || !cacct || rec.tuner !== r.me || rec.cacct !== cacct) continue;
      const latest = (r.skills.find((x) => x.id === id) || {}).latest_version || (meta.info && meta.info[id] && meta.info[id].latest_version) || 0;
      tracked[id] = rec.inflight || rec.check ? 'check' : rec.paused ? 'paused' : latest > (rec.v || 0) ? 'stale' : 'have';
    }
    return { ok: true, me: r.me, skills: r.skills, tracked, unsure: !cacct };
  }

  // ── what the dashboard / popup shows ──

  async function state() {
    const { recs, meta, auto } = await load();
    // Another claude.ai account's records are hidden: they say nothing about this one's copies (batch R1-B3). When the
    // account cannot be read now (no claude.ai tab and the cookie path blocked) they all show — hiding them made a tracked
    // copy read 「✓ 있음」 after a new version (2026-11-03 report); a button only asks, and the write checks the account.
    const cacct = await claudeAccount();
    const items = Object.entries(recs).filter(([, rec]) => rec && (!cacct || rec.cacct === cacct)).map(([id, rec]) => {
      const info = (meta.info && meta.info[id]) || {};
      let st = 'ok';
      if (rec.inflight || rec.check) st = 'check';
      else if (rec.paused) st = 'paused';
      else if (info.latest_version > (rec.v || 0)) st = 'wait';
      return {
        team_id: id, name: info.name || rec.name, v: rec.v, latest_version: info.latest_version || null, state: st,
        reason: rec.inflight ? CHECK.unknown : (rec.check ? rec.check.reason : null), renamed: !!(rec.check && rec.check.renamed),
        prevV: rec.prevV || null, can_revert: !!(rec.prevV && Array.isArray(info.versions) && info.versions.includes(rec.prevV)),
        last: rec.last && now() - rec.last.at < RECENT_UPDATE_MS ? rec.last : null,
        failed: !!(rec.fail && rec.fail.n >= FAIL_STOP && rec.fail.v === info.latest_version),
        summary: info.edit_summary || null, by: info.by || null, org_id: rec.org, skill_id: rec.sid, tuner: rec.tuner,
        // The claude.ai account could not be read now: this record may be another account's (R1-B2).
        unsure: !cacct,
      };
    });
    return { ok: true, proto: TRACK_PROTO_VERSION, auto, tuner: meta.me || null, lastCheck: meta.lastCheck || null, items };
  }

  async function setPref(autoOn) {
    await store.set({ [PREF_KEY]: autoOn === true });
    const meta = (await load()).meta;
    // The other mode's 「대기」 card does not carry over — it is cleared, not just forgotten (R1-B6).
    if (Array.isArray(meta.waitKeys) && meta.waitKeys.length) await notify({ kind: 'clear_wait', items: [] });
    await saveMeta({ ...meta, waitKeys: [] });
    return { ok: true, auto: autoOn === true };
  }

  /** One user action on one record (plan §15-4 / 15-5). */
  function action(message) {
    const teamId = message && message.team_id, act = message && message.action;
    if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId) || !ACTIONS.includes(act)) return Promise.resolve({ ok: false, reason: 'invalid' });
    if (typeof message.acct_key !== 'string') return Promise.resolve({ ok: false, reason: 'invalid' });
    // Only on a record of the account the page is signed in as (U3 R1-B2) — checked again by runOne against the server.
    const guarded = (job) => enqueue(async () => {
      const r = (await load()).recs[teamId];
      if (!r || r.tuner !== message.acct_key) return { ok: false, reason: 'other_account' };
      return job();
    });
    if (act === 'revert') {
      // The pause is stored first: whatever the write does, the next auto run does not undo the rollback (§15-5).
      return guarded(async () => { await mutate(teamId, (r) => (r ? { ...r, paused: true } : r)); return { ok: true }; })
        .then((r) => (r.ok ? runOne(teamId, 'revert', message.acct_key) : r));
    }
    if (act === 'untrack') return guarded(async () => { await mutate(teamId, () => null); return { ok: true }; });
    if (act === 'resume') return guarded(async () => ({ ok: !!(await mutate(teamId, (r) => (r ? { ...r, paused: false } : r))) }));
    if (act === 'retry') {
      return guarded(async () => { await mutate(teamId, (r) => (r ? { ...r, fail: null } : r)); return { ok: true }; })
        .then((r) => (r.ok ? runOne(teamId, 'manual', message.acct_key) : r));
    }
    return runOne(teamId, act === 'force' ? 'force' : 'manual', message.acct_key);
  }

  function runOne(teamId, mode, acctKey) {
    return enqueue(async () => {
      const ctx = await context();
      if (ctx.reason) return { ok: false, reason: ctx.reason };
      const got = await ask([teamId]);
      if (!got) return { ok: false, reason: 'error' };
      const info = got.rows.get(teamId);
      if (!info) return { ok: false, reason: 'not_found' };
      if (acctKey !== got.me) return { ok: false, reason: 'other_account' };
      if (mode === 'force') {
        // 「팀 판으로 바꾸기」 on a held record: the user decided — an unknown write is settled into the check it is.
        await mutate(teamId, settleInflight);
      }
      const r = await runUpdate(teamId, mode, info, ctx, got.me);
      await announce([], ctx, got.me);
      return r;
    });
  }

  /** The 「모두 업데이트」 button: what is waiting NOW, re-read (never a stale list from the notification). */
  function updateWaiting() {
    return enqueue(async () => {
      const ctx = await context();
      if (ctx.reason) return { ok: false, reason: ctx.reason };
      const { recs, meta } = await load();
      const ids = waitingOf(recs, meta, null, null).map((w) => w.id);
      if (!ids.length) return { ok: true, done: 0 };
      const got = await ask(ids);
      if (!got || got.me !== meta.me) return { ok: false, reason: 'other_account' };
      let n = 0;
      for (const id of ids) {
        const info = got.rows.get(id);
        if (info && (await runUpdate(id, 'manual', info, ctx, got.me)).ok) n++;
      }
      await announce([], ctx, got.me);
      return { ok: true, done: n };
    });
  }

  // ── the old page path (SKILL_APPLY with a page-made zip) and removals: through the same queue ──

  /** Run `job` (the SKILL_APPLY runner) in the queue; refuse an overwrite while anything is tracked (⑥). */
  function legacyApply(message, job) {
    return enqueue(async () => {
      const { recs } = await load();
      // Only where something is tracked: that org (or, with no org named, any) — other orgs keep the old path (R1-B5).
      const tracked = Object.values(recs).some((x) => x && (typeof message.org_id !== 'string' || x.org === message.org_id));
      if (message && message.probe !== true && message.overwrite === true && tracked) return { ok: false, reason: 'reload' };
      const r = await job();
      if (r && r.ok) {
        // Written by the page's zip over a tracked copy (a race with the check above): held for the user.
        const ids = Object.entries((await load()).recs).filter(([, x]) => x && x.org === r.org_id && x.sid === r.skill_id).map(([id]) => id);
        for (const id of ids) await mutate(id, (x) => (x ? { ...x, check: { reason: CHECK.changed } } : x));
      }
      return r;
    });
  }

  /** Run `job` (the SKILL_REMOVE runner) in the queue; a removed copy stops being tracked — unless its last write is unknown. */
  function removeTracked(message, job) {
    return enqueue(async () => {
      const r = await job();
      if (r && r.ok && message && typeof message.skill_id === 'string') {
        const ids = Object.entries((await load()).recs).filter(([, x]) => x && x.org === message.org_id && x.sid === message.skill_id).map(([id]) => id);
        for (const id of ids) {
          await mutate(id, (x) => {
            if (!x) return x;
            // ④ a write we never heard back from may still land after the removal: keep it visible as 'unknown'.
            if (x.inflight || (x.check && x.check.reason === CHECK.unknown)) return { ...x, inflight: null, check: { reason: CHECK.unknown } };
            return null;
          });
        }
      }
      return r;
    });
  }

  return { add, listForPicker, checkAll, maybeCheck, state, setPref, action, updateWaiting, legacyApply, removeTracked, enqueue, openSettings };
}

/**
 * The dashboard's 「⚙ 설정」 → this extension's options at the auto-update switch. One tab: an open options tab is reused
 * (found through runtime.getContexts — no `tabs` permission), and calls while one is opening share it — repeated clicks, or a
 * page sending the message in a loop, never open more tabs (R1-B1). The tab we opened is remembered and tried first: a
 * just-created tab is not in getContexts until its document loads (R2).
 * deps: { url, page, contexts() → [{ documentUrl, tabId, windowId }], update(tabId, url) → tab, focus(windowId), create(url) → tab }
 */
export function makeSettingsOpener(deps) {
  let opening = null;
  let ours = null;   // { tabId, windowId } of the tab we created
  return function open() {
    if (opening) return opening;
    opening = (async () => {
      if (ours) {
        try {
          const t = await deps.update(ours.tabId, deps.url);
          if (t && t.windowId >= 0) ours.windowId = t.windowId;   // the tab may have been moved to another window (R3)
          if (ours.windowId >= 0) await Promise.resolve(deps.focus(ours.windowId)).catch(() => {});
          return true;
        } catch (e) { ours = null; }   // closed since: look again
      }
      const list = await Promise.resolve(deps.contexts()).catch(() => []);
      const ctx = (Array.isArray(list) ? list : []).find((c) => c && String(c.documentUrl || '').startsWith(deps.page) && c.tabId >= 0);
      if (ctx) {
        await deps.update(ctx.tabId, deps.url);
        if (ctx.windowId >= 0) await Promise.resolve(deps.focus(ctx.windowId)).catch(() => {});
      } else {
        const tab = await deps.create(deps.url);
        if (tab && tab.id >= 0) ours = { tabId: tab.id, windowId: tab.windowId };
      }
      return true;
    })().finally(() => { opening = null; });
    return opening;
  };
}

/**
 * onMessageExternal for the tracking messages: true when ours (the answer comes through sendResponse).
 * `allowed(sender)` = background.js's account-data origin rule.
 */
export function handleSkillTrackExternal(message, sender, sendResponse, allowed, updater) {
  if (!message || !SKILL_TRACK_MESSAGES.includes(message.type)) return false;
  if (!allowed(sender)) { sendResponse({ ok: false, reason: 'origin' }); return false; }
  let run;
  if (message.type === SKILL_TRACK_PROTO) run = Promise.resolve({ ok: true, proto: TRACK_PROTO_VERSION });
  else if (message.type === SKILL_ADD_TRACKED) run = updater.add(message);
  else if (message.type === SKILL_TRACK_STATE) run = updater.state();
  else if (message.type === SKILL_TRACK_ACTION) run = updater.action(message);
  else if (message.type === SKILL_OPEN_SETTINGS) run = Promise.resolve(updater.openSettings()).then((ok) => ({ ok: ok !== false }));
  else run = typeof message.auto === 'boolean' ? updater.setPref(message.auto) : Promise.resolve({ ok: false, reason: 'invalid' });
  run.then(sendResponse, () => sendResponse({ ok: false, reason: 'error' }));
  return true;
}
