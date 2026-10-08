// ChatGPT training-data setting (#1889) — 「모델 개선을 위한 데이터 학습 허용」, for the team dashboard.
//
// Source: `GET /backend-api/settings/user` → settings.training_allowed (what chatgpt.com/settings/data-controls
// shows). Measured 2026-10-07: the setting is ACCOUNT-level (ON in the personal workspace made every Business
// workspace read true as well) and only applies to personal plans — OpenAI does not train on Business or
// Enterprise. So it is filed under the member's PERSONAL account, and the team dashboard marks only that
// account's row.
//
// Read at most every 30 minutes (Claude's Grove cache uses the same TTL — the setting can be flipped any
// time), and PUT to /api/users/training only when it CHANGES (or weekly, to heal a lost write) — it does
// not ride the snapshot, for the same reason as the VAT verdict (bg/vat.js): `users` is at D1's column cap
// and the ingest hot path must not grow a statement.
//
// Three answers, matching the server (worker/src/utils/training-status.ts):
//   { training_allowed: true|false, org_uuid } — the setting, filed under the personal account
//   { training_allowed: null }                 — CLEAR: no personal account any more
//   {}                                         — unknown this cycle (read failed / undecidable): keep
import { fetchChatGPTApi } from './api-chatgpt.js';
import { pickChatGPTPersonalAccount, CHATGPT_USAGE_PATH, chatgptUsageAccountId } from './parse-chatgpt.js';
import { ChatGPTClient } from '../vendor-ai/chatgpt-client.js';
import { authedFetch, getConfig } from './storage.js';
import { sendableIdentity, withTimeout } from './vat.js';
import { TRAINING_CACHE_KEY_CHATGPT } from './training-view.js';

const TRAINING_TTL_MS = 30 * 60 * 1000;
const TRAINING_FAIL_RETRY_MS = 30 * 60 * 1000;
const TRAINING_RESEND_MS = 7 * 24 * 60 * 60 * 1000;
const TRAINING_REJECTED_RETRY_MS = 6 * 60 * 60 * 1000;
const CHATGPT_ACCOUNTS_PATH = '/backend-api/accounts/check/v4-2023-04-27';
const CHATGPT_USER_SETTINGS_PATH = '/backend-api/settings/user';
const CLEAR = Object.freeze({ training_allowed: null });
const KEYS = { cache: TRAINING_CACHE_KEY_CHATGPT, sent: 'trainingSentChatgpt' };

// Log a code only — a provider error message can carry part of the response body.
function errCode(e) {
  const m = typeof e?.message === 'string' ? e.message : '';
  return /^(err_|vat_|training_)[a-z0-9_]+$/.test(m) ? m : 'error';
}

/**
 * The setting for the account the extension is collecting under. Cached per (active account, plan): the
 * org key is derived from them, so switching accounts re-reads instead of replaying a value filed under the
 * old key (the same rule as readChatGPTVatFields).
 * @param {string|null} activeUsageAccountId `/wham/usage` account id — the org key ChatGPT snapshots (and so
 *   the team-sharing policy) use for the ACTIVE account; other accounts use their UUID.
 * @param {string|null} activeUsagePlanType `/wham/usage` plan_type, to confirm that id IS the personal account.
 */
export async function readChatGPTTrainingFields(activeUsageAccountId, activeUsagePlanType) {
  try {
    const cacheKey = `${activeUsageAccountId || '-'}|${activeUsagePlanType || '-'}`;
    const { [KEYS.cache]: stored } = await chrome.storage.local.get(KEYS.cache);
    const cache = stored && typeof stored === 'object' ? stored : {};
    const entry = cache[cacheKey];
    const age = entry ? Date.now() - (entry.ts || 0) : Infinity;
    let next = entry;
    if (!entry || age >= (entry.ok ? TRAINING_TTL_MS : TRAINING_FAIL_RETRY_MS)) {
      try {
        next = { result: await readOnce(activeUsageAccountId, activeUsagePlanType), ok: true, ts: Date.now() };
      } catch (e) {
        console.warn('[Claude Tuner] training setting read failed (non-critical):', errCode(e));
        next = { result: entry?.result, ok: false, ts: Date.now() };
      }
      // Only this account's entry is kept — older accounts' entries have nothing left to say.
      await chrome.storage.local.set({ [KEYS.cache]: { [cacheKey]: next } });
    }
    const r = next.result;
    if (r === null) return CLEAR;
    if (!r || r === 'undecidable') return {};
    return { training_allowed: r.allowed, org_uuid: r.orgUuid };
  } catch (e) {
    console.warn('[Claude Tuner] training setting read skipped:', errCode(e));
    return {};
  }
}

// → { allowed, orgUuid } | null (no personal account → clear) | 'undecidable' (→ keep). Throws on a failed read.
async function readOnce(activeUsageAccountId, activeUsagePlanType) {
  const data = await withTimeout(fetchChatGPTApi(CHATGPT_ACCOUNTS_PATH));
  // A signed-in member always has at least one account: an unreadable body is a FAILED read (keep), not
  // "no personal account" (clear).
  const accounts = data?.accounts;
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts) || Object.keys(accounts).length === 0) {
    throw new Error('training_unreadable');
  }
  const acct = pickChatGPTPersonalAccount(data);
  if (!acct) return null;
  // The org key must be the one the team-sharing policy hides by, or a hidden personal account would show.
  // Active account → the `/wham/usage` id, but only when usage visibly reports THIS account (same plan).
  let orgUuid = acct.accountId;
  if (acct.isDefault) {
    if (!activeUsageAccountId || activeUsagePlanType !== acct.planType) return 'undecidable';
    orgUuid = activeUsageAccountId;
  }
  const settings = await withTimeout(fetchChatGPTApi(CHATGPT_USER_SETTINGS_PATH));
  // The package's parser (vendor-ai v0.17.0) — a non-boolean stays null, never coerced to OFF.
  const { trainingAllowed } = ChatGPTClient.parseDataControls(settings);
  if (trainingAllowed === null) throw new Error('training_unreadable');
  // 🔴 The default account's key is BORROWED from the usage read the caller made earlier, and the plan
  // check above cannot tell two personal Free accounts apart: a ChatGPT login switch between that usage
  // read and these reads would file account B's setting under account A's key — and if B is the one the
  // member hides from the team, it would show (Codex 1R). The usage id often cannot be compared with
  // accounts/check directly (a `user-…` id), so the usage read is repeated AFTER the settings read: the
  // same id on both sides of the reads means the session did not change in between. Otherwise: no verdict.
  if (acct.isDefault) {
    const after = await withTimeout(fetchChatGPTApi(CHATGPT_USAGE_PATH));
    if (chatgptUsageAccountId(after) !== activeUsageAccountId) return 'undecidable';
  }
  return { allowed: trainingAllowed, orgUuid };
}

async function sendTraining(fields, email) {
  if (!('training_allowed' in fields)) return;          // unknown this cycle → nothing to say
  const body = { provider: 'chatgpt', ...fields };
  const sig = JSON.stringify(body);
  const { [KEYS.sent]: sent } = await chrome.storage.local.get(KEYS.sent);
  if (sent?.email === email && sent.sig === sig
      && Date.now() - (sent.ts || 0) < (sent.ok ? TRAINING_RESEND_MS : TRAINING_REJECTED_RETRY_MS)) return;
  const config = await getConfig();
  if (!config?.serverUrl) return;
  // The value was read under `email`; authedFetch sends nothing if the token it attaches is another account's.
  const resp = await authedFetch(config, `${config.serverUrl}/api/users/training`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, { requireTokenEmail: email });
  if (!resp) return;
  // Only a 2xx counts as sent. A 4xx (malformed, no live account) cannot change by resending the same body
  // every poll, so it is retried after a few hours; 401/5xx are retried next cycle.
  if (resp.ok || (resp.status >= 400 && resp.status < 500 && resp.status !== 401)) {
    await chrome.storage.local.set({ [KEYS.sent]: { email, sig, ok: resp.ok, ts: Date.now() } });
  }
}

/** bg/collect-chatgpt.js. Checks the send conditions BEFORE reading — a blocked or paused install does not
 * touch the settings endpoint at all. Never throws. */
export async function syncChatGPTTraining(activeUsageAccountId, activeUsagePlanType, ingestEmail) {
  try {
    const email = await sendableIdentity(ingestEmail);
    if (!email) return;
    await sendTraining(await readChatGPTTrainingFields(activeUsageAccountId, activeUsagePlanType), email);
  } catch (e) {
    console.warn('[Claude Tuner] training setting sync skipped:', errCode(e));
  }
}
