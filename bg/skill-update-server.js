// bg/skill-update-server.js — the Claude Tuner side of bg/skill-update.js (#2821): the two /api/ext team-skills reads.
// Only a login-proven ext_token, and every answer is dropped when the token changed while it was in flight (the same
// rule as bg/prompts.js skillOrgsCached). Paths are fixed here — no message ever names a URL.
import { getConfig, authedFetch, getAuthHeaders, isLoginProvenToken } from './storage.js';
import { extTokenEmailRaw } from './ext-token-claims.js';
import { bytesToBase64 } from './api.js';

const TEAM_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const ZIP_MAX_BYTES = 10 * 1024 * 1024;   // the team-skills upload cap (SKILL_LIMITS.zipBytes)
const VERSION_HEADER = 'X-Skill-Version';

async function tokenEmail() {
  const config = await getConfig().catch(() => null);
  if (!config?.serverUrl) return null;
  const auth = await getAuthHeaders(config).catch(() => ({}));
  const tok = auth.Authorization?.startsWith('Bearer ') ? auth.Authorization.slice(7) : null;
  return tok && isLoginProvenToken(tok) ? extTokenEmailRaw(tok) : null;
}

/** GET with the login-proven token of `email`; null when there is none, or it changed meanwhile. */
async function get(path, email) {
  const config = await getConfig().catch(() => null);
  if (!config?.serverUrl || !email) return null;
  const resp = await authedFetch(config, `${config.serverUrl}${path}`, {}, { requireTokenEmail: email }).catch(() => null);
  if (!resp) return null;
  return resp;
}

export const skillUpdateServer = {
  tokenEmail,
  async updates(ids) {
    if (!Array.isArray(ids) || !ids.every((id) => TEAM_ID_RE.test(id))) return { ok: false };
    const email = await tokenEmail();
    const resp = await get(`/api/ext/team-skills/updates?ids=${ids.join(',')}`, email);
    if (!resp || !resp.ok) return { ok: false, status: resp ? resp.status : 0 };
    const data = await resp.json().catch(() => null);
    if ((await tokenEmail()) !== email || !data) return { ok: false };
    return { ok: true, me: data.me, skills: Array.isArray(data.skills) ? data.skills : [], gone: Array.isArray(data.gone) ? data.gone : [] };
  },
  /** The picker's 「스킬」 list (#2905): { ok, me, skills } — every team skill this account reads. */
  async list() {
    const email = await tokenEmail();
    const resp = await get('/api/ext/team-skills/list', email);
    if (!resp || !resp.ok) return { ok: false, status: resp ? resp.status : 0 };
    const data = await resp.json().catch(() => null);
    if ((await tokenEmail()) !== email || !data || typeof data.me !== 'string') return { ok: false };
    const skills = (Array.isArray(data.skills) ? data.skills : []).filter((x) => x && TEAM_ID_RE.test(x.id) && typeof x.name === 'string')
      .map((x) => ({ id: x.id, org_id: x.org_id, name: x.name, description: typeof x.description === 'string' ? x.description : '',
        latest_version: Number(x.latest_version) || 0, holders: Number(x.holders) || 0 }));
    return { ok: true, me: data.me, skills };
  },
  /** 「these are in my claude.ai now」 (#2915) — best effort; the dashboard's 「보유 N명」 is built from it. */
  async held(ids, email) {
    // `email` = the account the caller pinned: authedFetch refuses to send with any other token (R2-B1).
    if (!Array.isArray(ids) || !ids.length || !ids.every((id) => TEAM_ID_RE.test(id)) || !email || (await tokenEmail()) !== email) return { ok: false };
    const config = await getConfig().catch(() => null);
    if (!config?.serverUrl || !email) return { ok: false };
    const resp = await authedFetch(config, `${config.serverUrl}/api/ext/team-skills/held`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
    }, { requireTokenEmail: email }).catch(() => null);
    return { ok: !!resp?.ok };
  },
  async download(id, v, use) {
    if (!TEAM_ID_RE.test(id) || !Number.isInteger(v) || v < 1) return { ok: false };
    const email = await tokenEmail();
    const resp = await get(`/api/ext/team-skills/${id}/download?v=${v}${use ? '&use=1' : ''}`, email);
    if (!resp || !resp.ok) return { ok: false, status: resp ? resp.status : 0 };
    const declared = Number(resp.headers.get('Content-Length') || 0);
    if (declared > ZIP_MAX_BYTES) return { ok: false };
    const buf = new Uint8Array(await resp.arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (!buf.length || buf.length > ZIP_MAX_BYTES || (await tokenEmail()) !== email) return { ok: false };
    return { ok: true, base64: bytesToBase64(buf), version: Number(resp.headers.get(VERSION_HEADER)) };
  },
};
