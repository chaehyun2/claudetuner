// bg/skills-import.js — 「내 claude.ai 스킬에서 고르기」 for the team-skills dashboard (#2771, docs/plans/skill-team.md §13).
//
//   page → us (onMessageExternal):  { type: 'SKILL_IMPORT_LIST' }                     →  { ok, skills: [{ org_id, org_name, skill_id, name, description, updated_at }] }
//                                   { type: 'SKILL_IMPORT_FETCH', org_id, skill_id }  →  { ok, base64, size } | { ok: false, reason }
//                                   { type: 'SKILL_APPLY', base64, org_id?, overwrite? } →  { ok, org_id, skill_id, name } | { ok: false, reason[, orgs] }
//                                   { type: 'SKILL_APPLY', probe: true }               →  { ok: true, probe: true } (no claude.ai call)
//                                   { type: 'SKILL_REMOVE', org_id, skill_id }        →  { ok } | { ok: false, reason }
//                                   { type: 'SKILL_REMOVE', probe: true }              →  { ok: true, probe: true } (no claude.ai call)
//
// The page uploads what it gets through its own session and the existing team-skills API — we never talk to Claude Tuner here.
// 🔴 NOT A PROXY: the page sends ids (and, for SKILL_APPLY, one zip), never a URL. Every claude.ai path is built here from
// ids that match strict patterns, so no message can make us fetch anything else with the user's claude.ai cookies.
// 🔴 The one write — SKILL_APPLY, 「claude.ai에 바로 추가」 on a team skill — adds a skill to the user's OWN claude.ai
// account after they pressed the button: a zip only (PK header, the team-skills size cap), into one of their chat orgs,
// and it never replaces an existing skill unless the page says `overwrite` (the user confirmed). Measured 2026-11-02
// (docs/plans/skill-team.md §13-6): a same-named skill answers 400 `upload_skill_already_exists`.
// 🔴 The other write — SKILL_REMOVE, 「claude.ai에서 제거」 (#2812 follow-up, measured 2026-11-03): removes ONE personal skill
// the page names by ids, after the user confirmed. claude.ai wraps an uploaded skill in a plugin and removes the plugin
// (`DELETE …/plugins/<plugin_…>` → 200 {status:'deleted'}, again → 404), so we look the plugin up here and remove it only when
// it is personal and carries exactly that one skill — never a plugin that would take other skills with it.
// 🔴 Personal skills only: Anthropic / marketplace skills are already available to every teammate.
// Paths measured 2026-10-31 (docs/plans/skill-team.md §13-1): a `.skill` download is a zip with the skill folder at its root.
import { fetchClaudeApi, base64ToBytes, ERR_ACCOUNT_MISMATCH } from './api.js';
import { CLAUDE_ORGS_PATH } from '../vendor-ai/sites.js';

export const SKILL_IMPORT_LIST = 'SKILL_IMPORT_LIST';
export const SKILL_IMPORT_FETCH = 'SKILL_IMPORT_FETCH';
export const SKILL_APPLY = 'SKILL_APPLY';
export const SKILL_REMOVE = 'SKILL_REMOVE';
const SKILL_MESSAGES = [SKILL_IMPORT_LIST, SKILL_IMPORT_FETCH, SKILL_APPLY, SKILL_REMOVE];
const ORG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SKILL_ID_RE = /^skill_[A-Za-z0-9]{1,64}$/;
const PLUGIN_ID_RE = /^plugin_[A-Za-z0-9]{1,64}$/;
const SKILL_IMPORT_MAX_BYTES = 10 * 1024 * 1024;   // mirrors the team-skills upload cap (SKILL_LIMITS.zipBytes)
const SKILL_LIST_MAX = 200;
const TEXT_MAX = { name: 64, description: 300, org_name: 100 };
const PERSONAL_SOURCE = 'personal';
const CHAT_CAPABILITY = 'chat';   // API-only organizations answer 403 to every skills path
// claude.ai's own upload (「Skill 업로드」, measured 2026-11-02): multipart `file` (a zip named *.skill) + `upload_source`.
const UPLOAD_SOURCE = 'customize_upload';
const UPLOAD_FILE_NAME = 'skill.skill';   // the name inside the zip decides the skill's name, not this
const SKILL_EXISTS_CODE = 'upload_skill_already_exists';
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];   // the zip local-header magic `PK\x03\x04`
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SKILL_APPLY_MAX_BASE64 = Math.ceil(SKILL_IMPORT_MAX_BYTES / 3) * 4;

/** 'ok' | 'invalid' | 'too_large' for the zip a page hands us — decoded and checked before any claude.ai call (Codex R1-B2). */
export function checkApplyZip(b64) {
  if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return 'invalid';
  if (b64.length > SKILL_APPLY_MAX_BASE64) return 'too_large';
  let bytes;
  try { bytes = base64ToBytes(b64); } catch (e) { return 'invalid'; }
  if (bytes.length > SKILL_IMPORT_MAX_BYTES) return 'too_large';
  return ZIP_MAGIC.every((b, i) => bytes[i] === b) ? 'ok' : 'invalid';
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** The personal skills in one org's `library/mine?kind=skill` answer, as list rows. */
export function personalSkillRows(org, body) {
  const items = (body && (body.items || (body.by_kind && body.by_kind.skill && body.by_kind.skill.items))) || [];
  const rows = [];
  for (const it of items) {
    if (!it || !it.provenance || it.provenance.source !== PERSONAL_SOURCE) continue;
    // An uploaded skill is wrapped in a plugin (`plugin_…`); its skill id is in components[] (S0 2026-10-31).
    const comps = (Array.isArray(it.components) ? it.components : []).filter((c) => c && c.type === 'skill' && SKILL_ID_RE.test(c.id));
    for (const c of comps) {
      rows.push({
        org_id: org.uuid, org_name: str(org.name, TEXT_MAX.org_name), skill_id: c.id,
        name: str(c.name || it.name, TEXT_MAX.name), description: str(c.description || it.description, TEXT_MAX.description),
        updated_at: str(it.updated_at, 40), head: str(it.version, 16),
      });
    }
  }
  return rows;
}

function failReason(e) {
  const m = String((e && e.message) || '');
  if (/^err_(session_expired|no_cookies|auth_failed)/.test(m)) return 'claude_login';
  if (m === 'err_rate_limit') return 'rate_limit';
  return 'error';
}

/** The user's claude.ai orgs that have skills (chat), or `{ reason }` when they cannot be read. */
export async function chatOrgsOf(fetchApi) {
  let orgs;
  try { orgs = await fetchApi(CLAUDE_ORGS_PATH, { quiet: true }); } catch (e) { return { reason: failReason(e) }; }
  const chatOrgs = (Array.isArray(orgs) ? orgs : []).filter((o) => o && ORG_UUID_RE.test(o.uuid)
    && Array.isArray(o.capabilities) && o.capabilities.includes(CHAT_CAPABILITY));
  return chatOrgs.length ? { orgs: chatOrgs } : { reason: 'claude_login' };
}

async function listSkills(fetchApi) {
  const got = await chatOrgsOf(fetchApi);
  if (got.reason) return { ok: false, reason: got.reason };
  const chatOrgs = got.orgs;
  const skills = [];
  let failed = 0;
  for (const org of chatOrgs) {
    try {
      skills.push(...personalSkillRows(org, await fetchApi(`${CLAUDE_ORGS_PATH}/${org.uuid}/library/mine?kind=skill&limit=1000`, { quiet: true })));
    } catch (e) { failed++; }
  }
  if (failed === chatOrgs.length) return { ok: false, reason: 'error' };
  return { ok: true, skills: skills.slice(0, SKILL_LIST_MAX) };
}

async function fetchSkill(message, fetchApi) {
  const org = message.org_id, skill = message.skill_id;
  if (typeof org !== 'string' || !ORG_UUID_RE.test(org) || typeof skill !== 'string' || !SKILL_ID_RE.test(skill)) return { ok: false, reason: 'invalid' };
  let r;
  try {
    r = await fetchApi(`${CLAUDE_ORGS_PATH}/${org}/skills/download-dot-skill-file?skill_id=${skill}`, { binary: SKILL_IMPORT_MAX_BYTES, quiet: true });
  } catch (e) { return { ok: false, reason: failReason(e) }; }
  if (!r || r.tooLarge) return { ok: false, reason: r ? 'too_large' : 'error' };
  if (typeof r.base64 !== 'string' || !r.size) return { ok: false, reason: 'error' };
  return { ok: true, base64: r.base64, size: r.size };
}

async function applySkill(message, fetchApi) {
  if (message.probe === true) return { ok: true, probe: true };
  const b64 = message.base64;
  const zip = checkApplyZip(b64);
  if (zip !== 'ok') return { ok: false, reason: zip };
  if (message.org_id !== undefined && (typeof message.org_id !== 'string' || !ORG_UUID_RE.test(message.org_id))) return { ok: false, reason: 'invalid' };
  const got = await chatOrgsOf(fetchApi);
  if (got.reason) return { ok: false, reason: got.reason };
  let org;
  if (message.org_id) {
    org = got.orgs.find((o) => o.uuid === message.org_id);
    if (!org) return { ok: false, reason: 'invalid' };   // only an org this claude.ai login has
  } else if (got.orgs.length === 1) {
    org = got.orgs[0];
  } else {
    return { ok: false, reason: 'pick_org', orgs: got.orgs.map((o) => ({ org_id: o.uuid, org_name: str(o.name, TEXT_MAX.org_name) })) };
  }
  const up = await uploadSkillZip(fetchApi, org.uuid, b64, message.overwrite === true);
  if (!up.ok) return up.reason === 'exists' ? { ok: false, reason: 'exists', org_id: org.uuid } : { ok: false, reason: up.reason === 'unknown' ? 'error' : up.reason };
  return { ok: true, org_id: org.uuid, skill_id: up.skill.id, name: up.skill.name };
}

/** One org's personal skill rows (`library/mine`), or `{ reason }` when it cannot be read. */
export async function personalSkillsOf(fetchApi, org) {
  try {
    return { rows: personalSkillRows(org, await fetchApi(`${CLAUDE_ORGS_PATH}/${org.uuid}/library/mine?kind=skill&limit=1000`, { quiet: true })) };
  } catch (e) { return { reason: failReason(e) }; }
}

/** claude.ai answered (an HTTP status we can read, a login / rate-limit refusal): nothing was written. Anything else after
 *  the request left — a 5xx, a broken answer, no answer — may have been written (plan §15-2 ④: 'unknown'). */
// bg/api.js codes: a 4xx from the tab (`err_http:4xx`, `err_auth_failed:401|403`), the cookie path's 401 / 403 / 429
// (`err_session_expired`, `err_cloudflare`, `err_rate_limit`) and no cookies at all (never sent). Unknown: `err_server:5xx`,
// `err_network`, `err_tab_no_result`, `err_fallback_exhausted`, a broken answer (R1-B4).
const ANSWERED_RE = /^err_(http:4\d\d|auth_failed|session_expired|no_cookies|rate_limit|cloudflare)/;

/**
 * Upload a skill zip into one org (overwrite only when `overwrite === true`). Measured 2026-11-03 (plan §15-1): the answer
 * carries the write's own version (`backing_plugin_head_version`) and the claude.ai account (`owner.uuid`).
 * → { ok: true, skill: { id, name, head, owner } } | { ok: false, reason: 'exists' | 'rejected' | 'claude_login' | 'rate_limit' | 'error' | 'unknown' }
 * ('error' = claude.ai answered a bare 4xx — not written; only 'unknown' may have been written)
 */
export async function uploadSkillZip(fetchApi, orgUuid, b64, overwrite, expectAccount) {
  let r;
  try {
    r = await fetchApi(`${CLAUDE_ORGS_PATH}/${orgUuid}/skills/upload-skill?overwrite=${overwrite === true}&upload_source=${UPLOAD_SOURCE}`, {
      method: 'POST', quiet: true, errorCode: true, expectAccount: expectAccount || undefined,
      multipart: { field: 'file', base64: b64, name: UPLOAD_FILE_NAME, type: 'application/zip', fields: { upload_source: UPLOAD_SOURCE } },
    });
  } catch (e) {
    const m = String((e && e.message) || '');
    if (m === ERR_ACCOUNT_MISMATCH) return { ok: false, reason: 'other_account' };   // checked in the request itself: not sent
    if (m === `err_http:400:${SKILL_EXISTS_CODE}`) return { ok: false, reason: 'exists' };
    if (/^err_http:4\d\d:/.test(m)) return { ok: false, reason: 'rejected' };   // claude.ai refused the skill itself
    if (ANSWERED_RE.test(m)) return { ok: false, reason: failReason(e) };   // 'error' here = answered (a bare 4xx), not written
    return { ok: false, reason: 'unknown' };
  }
  const skill = r && r.skill;
  // 200 with `validation_errors` and no skill (§13-7): claude.ai refused it — nothing written (#2806).
  if (!skill && r && Array.isArray(r.validation_errors) && r.validation_errors.length) return { ok: false, reason: 'rejected' };
  if (!skill || typeof skill.id !== 'string' || !SKILL_ID_RE.test(skill.id)) return { ok: false, reason: 'unknown' };
  return {
    ok: true,
    skill: { id: skill.id, name: str(skill.name, TEXT_MAX.name), head: str(skill.backing_plugin_head_version, 16), owner: str(skill.owner && skill.owner.uuid, 64) },
  };
}

/** The personal plugin that carries exactly this one skill in a `library/mine` answer, or null. */
export function personalPluginOf(body, skillId) {
  const items = (body && (body.items || (body.by_kind && body.by_kind.skill && body.by_kind.skill.items))) || [];
  for (const it of items) {
    if (!it || !it.provenance || it.provenance.source !== PERSONAL_SOURCE || typeof it.id !== 'string' || !PLUGIN_ID_RE.test(it.id)) continue;
    const comps = Array.isArray(it.components) ? it.components : [];
    if (!comps.some((c) => c && c.id === skillId)) continue;
    // Removing the plugin removes everything in it: only one that holds this skill and nothing else.
    return comps.length === 1 ? it.id : null;
  }
  return null;
}

async function removeSkill(message, fetchApi) {
  if (message.probe === true) return { ok: true, probe: true };
  const orgId = message.org_id, skill = message.skill_id;
  if (typeof orgId !== 'string' || !ORG_UUID_RE.test(orgId) || typeof skill !== 'string' || !SKILL_ID_RE.test(skill)) return { ok: false, reason: 'invalid' };
  const got = await chatOrgsOf(fetchApi);
  if (got.reason) return { ok: false, reason: got.reason };
  if (!got.orgs.some((o) => o.uuid === orgId)) return { ok: false, reason: 'invalid' };   // only an org this claude.ai login has
  let plugin;
  try {
    plugin = personalPluginOf(await fetchApi(`${CLAUDE_ORGS_PATH}/${orgId}/library/mine?kind=skill&limit=1000`, { quiet: true }), skill);
  } catch (e) { return { ok: false, reason: failReason(e) }; }
  if (!plugin) return { ok: false, reason: 'not_found' };
  try {
    await fetchApi(`${CLAUDE_ORGS_PATH}/${orgId}/plugins/${plugin}`, { method: 'DELETE', quiet: true, errorCode: true });
  } catch (e) {
    // Gone already (a retry after a cut answer, or removed in another tab): what the user asked for is true.
    if (/^err_http:404/.test(String((e && e.message) || ''))) return { ok: true };
    return { ok: false, reason: failReason(e) };
  }
  return { ok: true };
}

const RUNNERS = { [SKILL_IMPORT_LIST]: (m, f) => listSkills(f), [SKILL_IMPORT_FETCH]: fetchSkill, [SKILL_APPLY]: applySkill, [SKILL_REMOVE]: removeSkill };

/**
 * onMessageExternal: true when the message was ours (the answer comes through sendResponse).
 * `allowed(sender)` is background.js's account-data origin rule (production site, or any origin on a dev build).
 */
export function handleSkillImportExternal(message, sender, sendResponse, allowed, fetchApi = fetchClaudeApi, wrap = null) {
  if (!message || !SKILL_MESSAGES.includes(message.type)) return false;
  if (!allowed(sender)) { sendResponse({ ok: false, reason: 'origin' }); return false; }
  // `wrap(message, job)` = background.js's hook: the writes run in bg/skill-update.js's queue (#2821).
  const job = () => RUNNERS[message.type](message, fetchApi);
  const run = wrap ? wrap(message, job) : job();
  run.then(sendResponse, () => sendResponse({ ok: false, reason: 'error' }));
  return true;
}
