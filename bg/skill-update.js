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
//
// Required team skills (#3016, plan §25): an org admin marks a skill 「필수」 and this same check adds it right away through
// the same write path (same queue, same invariants, never an overwrite), says so in one notification the member can act
// on (remove), never adds back what the member removed (the skip list), and reports what happened to the server.
import { chatOrgsOf, personalSkillsOf, uploadSkillZip, checkApplyZip, rejectedResult, removePersonalSkill } from './skills-import.js';

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
// Required team skills (#3016). Keys of the skip list and of the report are `<tuner>|<cacct>|<team skill id>` (reqKey).
export const REQ_PREF_KEY = 'skillRequiredAuto';   // boolean, default true — 「관리자가 정한 필수 팀 스킬 자동 추가」
export const REQ_SKIP_KEY = 'skillReqSkip';        // { <reqKey>: at } — never added automatically again
/** { at, ids: [team ids seen required], state: { <reqKey>: { state, reason? } }, sent: { <reqKey>: sig },
 *  retry: { <reqKey>: at }, forbid: { <reqKey>: { org, n } }, recent: [target + { key, name, at }],
 *  dismissed: { <reqKey>: at }, notif: { targets: [target] } } — target = { tuner, cacct, org, id, sid } (what 「삭제」 may remove) */
export const REQ_META_KEY = 'skillReqMeta';

const TEAM_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const ORG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT_PATH = '/api/account';
/** Ids per server check (the worker's SKILL_UPDATE_IDS_MAX). */
export const UPDATE_IDS_CHUNK = 50;
/** A version claude.ai refused this many times is not tried again until a newer one or the user's 「다시 시도」. */
export const FAIL_STOP = 2;
/** A claude.ai tab opening re-checks when the last check is older than this. */
export const TAB_RECHECK_MS = 60 * 60 * 1000;
// With a tracked copy: a teammate's new version should reach my claude.ai the next time I open it, not hours later
// (2026-11-26 — the 6-hour alarm left a saved v2 unseen). One small GET per claude.ai tab load at most this often.
export const TAB_RECHECK_TRACKED_MS = 10 * 60 * 1000;
/** The dashboard shows the last automatic update (with 「되돌리기」) for this long. */
export const RECENT_UPDATE_MS = 7 * 24 * 60 * 60 * 1000;
// 'follow' = the dashboard just saved a new version: do now what the next automatic check would do (auto mode — the
// switch, a pause, a stopped version are all checked here, never on the page's cached view — 2026-11-26 R1-B1).
const ACTIONS = ['update', 'force', 'untrack', 'revert', 'resume', 'retry', 'follow'];
/** A required skill claude.ai refused (its org's policy, or the skill itself) is tried again after this long. */
export const REQ_RETRY_MS = 24 * 60 * 60 * 1000;
/** The popup's 「관리자 요청으로 추가된 팀 스킬」 line stays this long after the add. */
export const REQ_RECENT_MS = 7 * 24 * 60 * 60 * 1000;
/** Team skill ids remembered as 「required once」 (a later removal in claude.ai is then a 「removed」). */
const REQ_IDS_MAX = 200;
const REQ_RECENT_MAX = 20;
/** Bare 403s (no policy code) in a row on the same Team org before a required skill reads as blocked by its policy (R1-B5). */
export const REQ_FORBID_STOP = 3;
/** claude.ai Team / Enterprise org capabilities: preferred for a required skill (plan §25-1). */
const TEAM_ORG_CAPS = ['raven', 'raven_enterprise'];
/** A refusal code that names a switched-off feature (skills / user-created skills) — read as the org's policy. */
const POLICY_CODE_RE = /disabled|not_enabled|not_allowed|permission|forbidden|policy/;
export const reqKey = (tuner, cacct, id) => `${tuner}|${cacct}|${id}`;
const isTeamOrg = (org) => !!org && Array.isArray(org.capabilities) && org.capabilities.some((c) => TEAM_ORG_CAPS.includes(c));
/** The one claude.ai org a required skill goes to: a Team / Enterprise chat org first, else the personal one. */
export const reqTargetOrg = (orgs) => orgs.find(isTeamOrg) || orgs.find((o) => !isTeamOrg(o)) || null;
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
  // GA (#3016): short params only — never a name, an id or an email.
  const track = (name, params) => { try { if (deps.track) deps.track(name, params); } catch (e) { /* telemetry never breaks a job */ } };

  // ── the serial queue (①) ──
  let chain = Promise.resolve();
  function enqueue(job) {
    const run = chain.then(job, job);
    chain = run.catch(() => {});
    return run;
  }

  // ── storage ──
  async function load() {
    const got = await store.get([TRACK_KEY, META_KEY, PREF_KEY, REQ_PREF_KEY, REQ_SKIP_KEY, REQ_META_KEY]);
    const rm = isObj(got[REQ_META_KEY]) ? got[REQ_META_KEY] : {};
    for (const k of ['state', 'sent', 'retry', 'forbid', 'dismissed']) if (!isObj(rm[k])) rm[k] = {};
    if (!Array.isArray(rm.ids)) rm.ids = [];
    if (!Array.isArray(rm.recent)) rm.recent = [];
    return {
      recs: isObj(got[TRACK_KEY]) ? got[TRACK_KEY] : {},
      meta: isObj(got[META_KEY]) ? got[META_KEY] : {},
      auto: got[PREF_KEY] !== false,
      reqAuto: got[REQ_PREF_KEY] !== false,
      skip: isObj(got[REQ_SKIP_KEY]) ? got[REQ_SKIP_KEY] : {},
      req: rm,
    };
  }
  async function saveRecs(recs) { await store.set({ [TRACK_KEY]: recs }); }
  async function saveMeta(meta) { await store.set({ [META_KEY]: meta }); }
  /** Change the required-skill state: fn(req, skip) edits both in place (inside the queue). */
  async function mutateReq(fn) {
    const { req, skip } = await load();
    fn(req, skip);
    await store.set({ [REQ_META_KEY]: req, [REQ_SKIP_KEY]: skip });
  }
  /** A required skill's copy is gone because the member wanted it gone: never added again, reported 「removed」. */
  const markRemoved = (req, skip, key, id) => {
    skip[key] = now();
    if (req.ids.includes(id)) req.state[key] = { state: 'removed' };
    req.recent = req.recent.filter((x) => x.key !== key);
  };
  /**
   * A tracked copy ended by the member (removed in claude.ai / the dashboard): ALWAYS skip-listed for its (tuner, cacct,
   * id), required now or not — a deletion is deliberate, and the list matters only if the skill is (ever) required. A skill
   * required for the first time in this very run would otherwise be put straight back (batch 1.56.31 B1).
   */
  async function noteEnded(id, rec, via) {
    if (!rec || !rec.tuner || !rec.cacct) return;
    let was = false;
    await mutateReq((req, skip) => {
      was = req.ids.includes(id);
      markRemoved(req, skip, reqKey(rec.tuner, rec.cacct, id), id);
    });
    if (was) track('skill_req_remove', { via });
  }
  /** Change one record: fn(rec) → the new record, or null to drop it. */
  async function mutate(teamId, fn) {
    const { recs } = await load();
    const next = fn(recs[teamId] || null);
    if (next) recs[teamId] = next; else delete recs[teamId];
    await saveRecs(recs);
    return next;
  }

  // ── context (①) ──
  let lastAcctEmail = null;   // the claude.ai login's email, read with the uuid — only for the notification text (#3016)
  async function claudeAccount() {
    try {
      const a = await fetchApi(ACCOUNT_PATH, { quiet: true });
      const uuid = a && typeof a.uuid === 'string' && ORG_UUID_RE.test(a.uuid) ? a.uuid : null;
      const em = uuid ? (a.email || a.email_address) : null;
      lastAcctEmail = typeof em === 'string' && em.includes('@') ? em.slice(0, 120) : null;
      return uuid;
    } catch (e) { return null; }
  }
  /** { email, cacct, orgs } or { reason }. */
  async function context() {
    const email = await server.tokenEmail();
    if (!email) return { reason: 'tuner_login' };
    const cacct = await claudeAccount();
    if (!cacct) return { reason: 'claude_login' };
    const cemail = lastAcctEmail;
    const got = await chatOrgsOf(fetchApi);
    if (got.reason) return { reason: got.reason };
    return { email, cacct, cemail, orgs: got.orgs };
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
        const ended = await mutate(teamId, (r) => (r && !r.inflight && !r.check && (mode !== 'force') ? null : r));
        if (!ended) await noteEnded(teamId, rec, 'claude_ai');
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
      const tracked = await trackedPass();
      // Required skills (#3016) after the tracked ones — the same run, the same queue slot.
      const req = await requiredPass().catch(() => ({ skipped: 'error' }));
      return { ...tracked, req };
    });
  }

  async function trackedPass() {
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
        if (!(await mutate(id, (r) => (r && !r.inflight && !r.check ? null : r)))) await noteEnded(id, rec, 'claude_ai');
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
    const { recs, meta, req } = await load();
    // Nothing tracked still checks for required skills (#3016) — throttled by the last required check too.
    const tracked = Object.keys(recs).length > 0;
    const gap = tracked ? TAB_RECHECK_TRACKED_MS : TAB_RECHECK_MS;
    if ((!tracked && !server.required) || now() - Math.max(meta.lastCheck || 0, req.at || 0) < gap) return { skipped: 'recent' };
    return checkAll();
  }

  // ── 「claude.ai에 바로 추가」 through the extension: the only way a record is born (②) ──

  /**
   * Write a team skill that is not tracked here yet into `org` and start tracking it — the one write path of a new record,
   * for the member's 「추가」 and for a required skill alike (inside the queue). `same` = the same-named claude.ai skill the
   * caller found (only with the user's `overwrite`). `use` = count it as an add (the member pressed it).
   * → the add answer, plus `forbidden` when claude.ai answered 403 (bg/skills-import.js) — callers pass that on to no page.
   */
  async function writeNew(teamId, info, org, same, overwrite, use, ctx, me) {
    const dl = await server.download(teamId, info.latest_version, use);
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
      const forbidden = up.forbidden ? { forbidden: true } : {};
      if (up.reason === 'exists') return { ok: false, reason: 'exists', org_id: org.uuid };
      return up.reason === 'rejected' ? { ...rejectedResult(up.code), ...forbidden } : { ok: false, reason: up.reason, ...forbidden };
    }
    const clash = (same && up.skill.id !== same.skill_id) || up.skill.owner !== ctx.cacct
      || Object.entries((await load()).recs).some(([tid, r]) => tid !== teamId && r && r.cacct === ctx.cacct && r.org === org.uuid && r.sid === up.skill.id);
    if (clash) {
      await mutate(teamId, (r) => (r ? { ...r, inflight: null, sid: r.sid || up.skill.id, check: { reason: CHECK.conflict, retId: up.skill.id } } : r));
      return { ok: false, reason: 'conflict' };
    }
    // addedAt = when THIS copy was written: a mail removal request older than it is not about it (#3016 R1-B3/B4).
    await mutate(teamId, (r) => (r ? { ...r, sid: up.skill.id, name: up.skill.name || info.name, v: info.latest_version, head: up.skill.head, inflight: null, addedAt: now() } : r));
    const meta = (await load()).meta;
    await saveMeta({ ...meta, me, info: { ...(meta.info || {}), [teamId]: infoView(info) } });
    return { ok: true, org_id: org.uuid, skill_id: up.skill.id, name: up.skill.name, v: info.latest_version };
  }

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
      const { forbidden, ...out } = await writeNew(teamId, info, org, same, overwrite, true, ctx, me);
      if (out.ok) await manualAdded(teamId, ctx, me);
      return out;
    });
  }

  /**
   * The member added a team skill themselves (#3016): it leaves the skip list. An older mail removal request no longer
   * applies to this copy by itself — the record's `addedAt` is newer than it (R1-B3/B4: no 「by hand」 signal to the server).
   */
  async function manualAdded(teamId, ctx, me) {
    const key = reqKey(me, ctx.cacct, teamId);
    await mutateReq((req, skip) => { delete skip[key]; delete req.retry[key]; delete req.forbid[key]; });
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
    return { ok: true, me: r.me, skills: r.skills, orgs: r.orgs ?? null, tracked, unsure: !cacct };
  }

  // ── required team skills (#3016, plan §25) ──

  const reqSig = (st) => `${st.state}:${st.reason || ''}`;

  /**
   * Send this account's changed required-skill states (inside the queue). Only records keyed by the pinned context
   * (`me` + `ctx.cacct`), only with the token pinned at its start (as the 「보유」 report — §19 R2-B1). `installed` goes
   * again every run, as 「보유」 does (a heartbeat). Never `manual` (R1-B3/B4 — removal requests are judged by time here).
   * 🔴 `installed` is DERIVED, not remembered (batch 1.56.31 B2, #3025): sent only for keys in `seen` (copies the claude.ai
   * list showed in this run); a stored `installed` not seen now is dropped, never re-sent (not reported 「removed」 either —
   * a removal the member made goes through markRemoved). Without `seen` (a removal right after a button) no `installed`
   * goes and none is dropped.
   */
  async function flushReport(ctx, me, seen = null) {
    if (!server.reqState) return;
    const prefix = `${me}|${ctx.cacct}|`;
    if (seen) {
      await mutateReq((rq) => {
        for (const [key, st] of Object.entries(rq.state)) {
          if (key.startsWith(prefix) && isObj(st) && st.state === 'installed' && !seen.has(key)) { delete rq.state[key]; delete rq.sent[key]; }
        }
      });
    }
    const { req } = await load();
    const items = [], keys = [];
    for (const [key, st] of Object.entries(req.state)) {
      if (!key.startsWith(prefix) || !isObj(st)) continue;
      const id = key.slice(prefix.length);
      if (!TEAM_ID_RE.test(id)) continue;
      const fresh = req.sent[key] !== reqSig(st);
      if (st.state === 'installed' ? !(seen && seen.has(key)) : !fresh) continue;
      const it = { id, state: st.state };
      if (st.state === 'skipped') it.reason = st.reason;
      items.push(it); keys.push(key);
    }
    for (let i = 0; i < items.length && (await sameContext(ctx)); i += UPDATE_IDS_CHUNK) {
      const r = await server.reqState(items.slice(i, i + UPDATE_IDS_CHUNK), ctx.email).catch(() => null);
      if (!r || !r.ok) break;
      const sentKeys = keys.slice(i, i + UPDATE_IDS_CHUNK);
      await mutateReq((rq) => { for (const k of sentKeys) if (rq.state[k]) rq.sent[k] = reqSig(rq.state[k]); });
    }
  }

  /** Set one record's state; true when it changed (a GA event and a report only then). */
  async function setReqState(key, st) {
    let changed = false;
    await mutateReq((req) => {
      const was = req.state[key];
      changed = !was || reqSig(was) !== reqSig(st);
      req.state[key] = st;
    });
    return changed;
  }

  /**
   * Remove a tracked copy the member (or their mail request) wants gone — the record's own sid only, through this queue
   * (inside it). → { ok } | { ok: false, reason }
   */
  async function removeOne(teamId, rec, ctx, me, via) {
    const org = ctx.orgs.find((o) => o.uuid === rec.org);
    if (!org || !rec.sid) return { ok: false, reason: org ? 'not_found' : 'other_account' };
    if (rec.inflight) await mutate(teamId, settleInflight);
    if (!(await sameContext(ctx))) return { ok: false, reason: 'other_account' };
    // The pinned context once more right before the DELETE, after the lookups (R1-B2 — as ①/③ for writes).
    let r = await removePersonalSkill(fetchApi, org.uuid, rec.sid, ctx.cacct, () => sameContext(ctx));
    if (!r.ok && r.reason === 'not_found') {
      // Not a lone personal skill any more: gone already (removed in claude.ai) is what was asked; anything else stays.
      const there = await rowOf(org, rec.sid);
      r = !there.reason && !there.row ? { ok: true } : r;
    }
    if (!r.ok) return r;
    await mutate(teamId, (x) => {
      if (!x) return x;
      // ④ a write we never heard back from may still land after the removal: keep it visible as 'unknown'.
      if (x.inflight || (x.check && x.check.reason === CHECK.unknown)) return { ...x, inflight: null, check: { reason: CHECK.unknown } };
      return null;
    });
    await mutateReq((req, skip) => markRemoved(req, skip, reqKey(me, ctx.cacct, teamId), teamId));
    track('skill_req_remove', { via });
    return { ok: true };
  }

  /**
   * The required-skill part of a check (inside the queue, after the tracked one): mail removal requests first, then adds
   * of what this account does not have, then the report and one notification for what was added.
   */
  async function requiredPass() {
    if (!server.required) return { skipped: 'unavailable' };
    if (!(await server.tokenEmail())) return { skipped: 'tuner_login' };
    await mutateReq((req) => { req.at = now(); });   // throttles maybeCheck, whatever happens next
    // Only accounts with team skills ask (one cached read — the popup's 「팀 스킬」 entry asks the same).
    if (server.skillOrgs) {
      const so = await server.skillOrgs().catch(() => null);
      if (!so || !so.ok || !Array.isArray(so.orgs) || !so.orgs.length) return { skipped: 'no_orgs' };
    }
    const ctx = await context();
    if (ctx.reason) return { skipped: ctx.reason };
    const got = await server.required();
    if (!got || !got.ok || typeof got.me !== 'string') return { skipped: 'server' };
    if (!(await sameContext(ctx))) return { skipped: 'other_account' };
    const { me } = got;
    const key = (id) => reqKey(me, ctx.cacct, id);
    const reqd = got.skills.filter((x) => x.required_at);
    await mutateReq((req) => {
      req.ids = [...new Set([...reqd.map((x) => x.id), ...req.ids])].slice(0, REQ_IDS_MAX);
      req.recent = req.recent.filter((x) => now() - x.at < REQ_RECENT_MS);
    });
    await saveMeta({ ...(await load()).meta, me });
    const lists = new Map();   // org uuid → personal rows (or null: unreadable) — one read per org per run
    const listOf = async (org) => {
      if (!lists.has(org.uuid)) { const l = await personalSkillsOf(fetchApi, org); lists.set(org.uuid, l.reason ? null : l.rows); }
      return lists.get(org.uuid);
    };
    const removed = [];
    // 1. Removal requests from the mail (§25-2): this account's tracked copy goes (never an add — also when no longer
    //    required, §25-6 ②). A copy this account does not track only goes on the skip list: another browser may track it,
    //    and a 「removed」 from here would clear the request it still has to act on.
    //    Only a request NEWER than this copy (R1-B3/B4): a member who added it back after asking keeps it. The request time
    //    is the server's clock, `addedAt` this browser's — a skew of a few minutes between them is accepted. No time (an
    //    older server) or a record from before `addedAt` = honoured.
    for (const s of got.skills.filter((x) => x.remove_requested)) {
      const k = key(s.id);
      const { recs } = await load();
      const askedAt = Date.parse(s.remove_requested_at || '');
      if (ownedBy(recs[s.id], ctx, me)) {
        if (!(Number.isNaN(askedAt) || askedAt > (recs[s.id].addedAt || 0))) continue;   // asked before this copy was added
        if ((await removeOne(s.id, recs[s.id], ctx, me, 'mail')).ok) removed.push(s.id);
      } else {
        await mutateReq((rq, skip) => { if (!skip[k]) skip[k] = now(); });
      }
    }
    // 2. Adds: required, not tracked by this account, not skipped, not asked to be removed.
    const added = [];
    const target = reqTargetOrg(ctx.orgs);
    for (const s of reqd.filter((x) => !x.remove_requested)) {
      const k = key(s.id);
      const { recs, skip, req, reqAuto } = await load();
      if (ownedBy(recs[s.id], ctx, me) || skip[k]) continue;
      // One record per team skill: another account's record in this browser is never replaced by an automatic add
      // (only the member's own 「추가」 does that) — that account keeps its tracking.
      if (recs[s.id]) continue;
      const skipped = async (reason) => { if (await setReqState(k, { state: 'skipped', reason })) track('skill_req_add', { result: reason }); };
      if (!reqAuto) { await skipped('off'); continue; }
      if (req.retry[k] && now() - req.retry[k] < REQ_RETRY_MS) continue;
      if (!target) continue;
      const rows = await listOf(target);
      if (!rows) continue;   // the list could not be read: next run
      // ⑥ a same-named personal skill — never overwritten (whoever tracks it), the member decides on the card.
      if (rows.some((r) => r.name === s.name)) { await skipped('name_taken'); continue; }
      if (!(await sameContext(ctx))) break;
      if (!(await load()).reqAuto) { await skipped('off'); continue; }   // switched off while this run was under way
      const info = { name: s.name, latest_version: s.latest_version, versions: [s.latest_version] };
      const r = await writeNew(s.id, info, target, null, false, false, ctx, me);
      if (r.ok) {
        lists.delete(target.uuid);
        await setReqState(k, { state: 'installed' });
        const tgt = { tuner: me, cacct: ctx.cacct, org: target.uuid, id: s.id, sid: r.skill_id };
        await mutateReq((rq) => {
          delete rq.retry[k];
          delete rq.forbid[k];
          rq.recent = [{ ...tgt, key: k, name: s.name, at: now() }, ...rq.recent.filter((x) => x.key !== k)].slice(0, REQ_RECENT_MAX);
        });
        added.push({ id: s.id, name: s.name, summary: s.summary, org_name: s.org_name, by: s.required_by_name, email: ctx.cemail, target: tgt });
        track('skill_req_add', { result: 'added' });
        continue;
      }
      // R3 (R1-B5): any answer that is not a bare 403 breaks a run of them — before every branch below, `exists` included.
      if (!r.forbidden) await mutateReq((rq) => { delete rq.forbid[k]; });
      if (r.reason === 'exists') { await skipped('name_taken'); continue; }
      // R1-B5: only a code that names the policy is the policy at once. A bare 403 (tab / cookie path / a code that says
      // nothing) may be a passing session or Cloudflare refusal: the next run tries again, and only REQ_FORBID_STOP of them
      // in a row on the same Team org read as its policy (a day's pause). Any success resets the count.
      let policy = r.reason === 'rejected' && POLICY_CODE_RE.test(r.code || '');
      if (!policy && r.forbidden) {
        let n = 0;
        if (isTeamOrg(target)) {
          await mutateReq((rq) => { const f = rq.forbid[k]; n = (f && f.org === target.uuid ? f.n : 0) + 1; rq.forbid[k] = { org: target.uuid, n }; });
        }
        if (n < REQ_FORBID_STOP) { track('skill_req_add', { result: 'error' }); continue; }
        policy = true;
      }
      if (policy) {
        await skipped('org_policy');
        await mutateReq((rq) => { rq.retry[k] = now(); });
      } else {
        // claude.ai refused the skill itself: not again for a day. Anything else (login, network…): the next run.
        if (r.reason === 'rejected') await mutateReq((rq) => { rq.retry[k] = now(); });
        track('skill_req_add', { result: 'error' });
      }
    }
    // 3. 「installed」: required, tracked by this account and just seen in claude.ai — only these are sent (B2).
    const seen = new Set();
    for (const s of reqd) {
      const rec = (await load()).recs[s.id];
      if (!ownedBy(rec, ctx, me) || rec.inflight || !rec.sid) continue;
      const org = ctx.orgs.find((o) => o.uuid === rec.org);
      const rows = org ? await listOf(org) : null;
      if (rows && rows.some((r) => r.skill_id === rec.sid)) { await setReqState(key(s.id), { state: 'installed' }); seen.add(key(s.id)); }
    }
    await flushReport(ctx, me, seen);
    if (added.length && (await sameContext(ctx))) {
      // The exact copies this notification is about: its 「삭제」 removes only these (R1-B1).
      if (await notify({ kind: 'req_added', items: added.map(({ target: _t, ...x }) => x) })) await mutateReq((rq) => { rq.notif = { targets: added.map((a) => a.target) }; });
    }
    return { added: added.length, removed: removed.length };
  }

  /**
   * 「삭제」 on the notification or the popup line: remove the copy THAT notification / line announced — only while the
   * tracked record is still exactly it (same Tuner account, claude.ai account, org and sid) and it is this account's now
   * (R1-B1: an old card must not remove a copy added later under another account). Otherwise nothing is removed or listed.
   */
  function reqRemove(teamId, via) {
    if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) return Promise.resolve({ ok: false, reason: 'invalid' });
    return enqueue(async () => {
      const { req } = await load();
      const from = via === 'notif' ? (req.notif && Array.isArray(req.notif.targets) ? req.notif.targets : []) : req.recent;
      const tgt = from.find((x) => x && x.id === teamId);
      if (!tgt) return { ok: false, reason: 'not_found' };
      const ctx = await context();
      if (ctx.reason) return { ok: false, reason: ctx.reason };
      const got = server.required ? await server.required() : null;
      if (!got || !got.ok || typeof got.me !== 'string') return { ok: false, reason: 'error' };
      if (!(await sameContext(ctx))) return { ok: false, reason: 'other_account' };
      const rec = (await load()).recs[teamId];
      if (!ownedBy(rec, ctx, got.me) || rec.tuner !== tgt.tuner || rec.cacct !== tgt.cacct || rec.org !== tgt.org || !rec.sid || rec.sid !== tgt.sid) {
        return { ok: false, reason: 'other_account' };
      }
      const r = await removeOne(teamId, rec, ctx, got.me, via);
      if (r.ok) await flushReport(ctx, got.me);
      return r;
    });
  }

  /** The popup line's ×: that line is not shown again. */
  function reqDismiss(teamId) {
    if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) return Promise.resolve({ ok: false, reason: 'invalid' });
    return enqueue(async () => {
      await mutateReq((req) => { for (const x of req.recent) if (x.id === teamId) req.dismissed[x.key] = now(); });
      return { ok: true };
    });
  }

  async function setReqPref(on) {
    await store.set({ [REQ_PREF_KEY]: on === true });
    return { ok: true, reqAuto: on === true };
  }

  /** The team skill ids of the last 「추가됐어요」 notification (its buttons act on them). */
  async function reqNotifIds() {
    const n = (await load()).req.notif;
    return n && Array.isArray(n.targets) ? n.targets.map((x) => x && x.id).filter((id) => typeof id === 'string' && TEAM_ID_RE.test(id)) : [];
  }

  // ── what the dashboard / popup shows ──

  async function state() {
    const { recs, meta, auto, reqAuto, req: rq } = await load();
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
    // The popup's 「관리자 요청으로 추가된 팀 스킬」 line (#3016): this account's required adds of the last 7 days, still tracked.
    const req = rq.recent.filter((x) => {
      const rec = recs[x.id];
      return now() - x.at < REQ_RECENT_MS && !rq.dismissed[x.key] && rec && x.key === reqKey(rec.tuner, rec.cacct, x.id)
        && rec.tuner === meta.me && (!cacct || rec.cacct === cacct);
    }).map((x) => ({ team_id: x.id, name: x.name, at: x.at }));
    return { ok: true, proto: TRACK_PROTO_VERSION, auto, reqAuto, tuner: meta.me || null, lastCheck: meta.lastCheck || null, items, req };
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
    if (act === 'untrack') {
      // 「추적 그만」 also means 「do not add it back」 if an admin requires it (#3016): the record's own account context.
      return guarded(async () => {
        const r = (await load()).recs[teamId];
        await mutate(teamId, () => null);
        if (r && r.tuner && r.cacct) await mutateReq((req, skip) => { skip[reqKey(r.tuner, r.cacct, teamId)] = now(); });
        return { ok: true };
      });
    }
    if (act === 'resume') return guarded(async () => ({ ok: !!(await mutate(teamId, (r) => (r ? { ...r, paused: false } : r))) }));
    if (act === 'retry') {
      return guarded(async () => { await mutate(teamId, (r) => (r ? { ...r, fail: null } : r)); return { ok: true }; })
        .then((r) => (r.ok ? runOne(teamId, 'manual', message.acct_key) : r));
    }
    if (act === 'follow') return runOne(teamId, 'auto', message.acct_key);
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
      // R2 (R1-B2): the dashboard's removal is pinned to the accounts it started with — a Tuner / claude.ai switch during
      // the lookups sends no DELETE, and no record changes.
      const email0 = await server.tokenEmail(), cacct0 = await claudeAccount();
      const still = async () => (await server.tokenEmail()) === email0 && (await claudeAccount()) === cacct0;
      const r = await job({ expectAccount: cacct0 || undefined, stillOurs: still });
      if (r && r.ok && message && typeof message.skill_id === 'string' && (await still())) {
        const ids = Object.entries((await load()).recs).filter(([, x]) => x && x.org === message.org_id && x.sid === message.skill_id).map(([id]) => id);
        for (const id of ids) {
          await noteEnded(id, (await load()).recs[id], 'dashboard');   // #3016: removed on purpose → not added back
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

  return { add, listForPicker, checkAll, maybeCheck, state, setPref, action, updateWaiting, legacyApply, removeTracked, enqueue, openSettings,
    reqRemove, reqDismiss, setReqPref, reqNotifIds };
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
