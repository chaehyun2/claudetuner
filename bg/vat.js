// VAT verdict of the member's personal subscriptions (#2157) — for the team dashboard.
//
// Claude: the latest paid invoice (`/api/stripe/{org}/invoices`), plus — shadow, not shown yet — the next
// bill's tax (`upcoming_invoice`) and the billing country (`address`). ChatGPT: whether the personal
// account's billing info carries a tax ID (`/backend-api/payments/billing_info`, parse-chatgpt.js). Both are read at most
// once a day per account, and the verdict is PUT to /api/users/vat (with its `provider`) only when it
// CHANGES (or weekly, to heal a lost write). It deliberately does not ride the snapshot: `users` is at
// D1's column cap and the ingest hot path must not grow a statement. Parsing is chrome-free, under the
// provider contract.
//
// Three answers per service, matching the server (worker/src/utils/vat-status.ts):
//   { vat_status, vat_invoice_at, vat_org_uuid } — a verdict
//   { vat_status: null }                         — CLEAR: no paid personal plan any more, or its bills
//                                                  hold nothing to judge (Codex 2R: a member who moved
//                                                  to a Team seat kept "paying VAT" forever)
//   {}                                           — unknown this cycle (read failed, nothing cached, or
//                                                  undecidable — e.g. ChatGPT's top tier): keep
import { fetchClaudeApi } from './api.js';
import { fetchChatGPTApi } from './api-chatgpt.js';
import { parseClaudeVatStatus, parseClaudeUpcomingVat, parseClaudeBillingCountry } from './parse-claude.js';
import { pickChatGPTVatAccount, parseChatGPTBillingInfo } from './parse-chatgpt.js';
import { claudeOrgPlan } from '../vendor-ai/models.js';
import { CLAUDE_ORGS_PATH } from '../vendor-ai/sites.js';
import { authedFetch, extTokenEmailRaw, getConfig, getExtToken, isServerSyncPaused, isAuthBlockSuppressed } from './storage.js';
import { isUpgradePostSuppressed } from './upgrade-gate.js';

const VAT_TTL_MS = 24 * 60 * 60 * 1000;
// A failed read is retried sooner, but not every poll — the endpoints are not ours to hammer.
const VAT_FAIL_RETRY_MS = 6 * 60 * 60 * 1000;
const VAT_RESEND_MS = 7 * 24 * 60 * 60 * 1000;
const VAT_REJECTED_RETRY_MS = 6 * 60 * 60 * 1000;
// The reads are optional; a hung tab or cookie fetch must not keep this promise alive.
const VAT_READ_TIMEOUT_MS = 15_000;
// Plans billed to the member personally (claude.ai Pro/Max). Team/Enterprise seats are billed to the org.
const CLAUDE_PERSONAL_PAID_PLANS = new Set(['pro', 'max', 'max_5x', 'max_20x']);
const CLEAR = Object.freeze({ vat_status: null });
const CHATGPT_ACCOUNTS_PATH = '/backend-api/accounts/check/v4-2023-04-27';
const CHATGPT_BILLING_INFO_PATH = '/backend-api/payments/billing_info';

// Storage keys. Claude's keep their 1.55.4 names so an update does not re-read and re-send everything.
const KEYS = {
  claude: { cache: 'vatCache', sent: 'vatSent' },
  // New cache name: 1.55.5 cached plan-change-preview verdicts under 'vatCacheChatgpt' (a signal that
  // turned out to read `none` for everyone) — they must not be replayed as billing_info verdicts.
  // Same for the sent record: a 1.55.5 'none' must not suppress the first billing_info 'none' — the server
  // row it describes came from the invalid signal and has to be replaced (Codex).
  chatgpt: { cache: 'vatCacheChatgptBi', sent: 'vatSentChatgptBi' },
};

// Log a code only: a provider error message can carry part of the response body (api-chatgpt.js), and a
// billing response may hold the member's tax ID (Codex).
function vatErrCode(e) {
  const m = typeof e?.message === 'string' ? e.message : '';
  return /^(err_|vat_)[a-z0-9_]+$/.test(m) ? m : 'error';
}

function withTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('vat_read_timeout')), VAT_READ_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

/** The member's paid personal Claude org, if the org list shows one. */
export function pickVatOrg(orgList) {
  if (!Array.isArray(orgList)) return null;
  return orgList.find(o => o?.uuid && CLAUDE_PERSONAL_PAID_PLANS.has(claudeOrgPlan(o))) || null;
}

// `accountKey` fills the org for entries 1.55.4 cached (keyed by org uuid, result without `orgUuid`).
// Claude's shadow fields (next bill's tax, billing country) ride along only when the read produced them —
// ChatGPT's results and entries cached before they existed send neither, and the server stores NULL.
function vatFields(result, accountKey) {
  if (!result) return CLEAR;
  const fields = { vat_status: result.status, vat_invoice_at: result.invoiceAt, vat_org_uuid: result.orgUuid ?? accountKey };
  if ('next' in result) fields.vat_next_status = result.next;
  if ('country' in result) fields.vat_billing_country = result.country;
  return fields;
}

// Optional side reads next to the invoice verdict — never a failed verdict read. A failure or an
// unreadable body keeps the value the last read saw (`prev`, null if none), so one bad day does not
// erase what the comparison needs (Codex 1R); a readable "nothing to judge" is null.
async function readOptional(path, parse, prev) {
  try {
    const v = parse(await withTimeout(fetchClaudeApi(path, { quiet: true })));
    return v === undefined ? (prev ?? null) : v;
  } catch (e) {
    console.warn('[Claude Tuner] VAT side read failed (non-critical):', vatErrCode(e));
    return prev ?? null;
  }
}

/**
 * Day-cached read for one account. `read(prevResult)` (the last cached result, for fallbacks) resolves to { result } where result is
 * { status, invoiceAt, orgUuid } | null (nothing to judge → clear) | 'undecidable' (→ keep).
 * A failed read keeps the last verdict for that account (a failed read is not a changed bill).
 */
async function cachedRead(provider, accountKey, read) {
  const key = KEYS[provider].cache;
  const { [key]: stored } = await chrome.storage.local.get(key);
  // Per-account map; 1.55.4's single-slot shape ({orgUuid, …}) is ignored rather than misread.
  const cache = (stored && typeof stored === 'object' && !('orgUuid' in stored)) ? stored : {};
  const entry = cache[accountKey];
  const age = entry ? Date.now() - (entry.ts || 0) : Infinity;
  let next = entry;
  if (!entry || age >= (entry.ok ? VAT_TTL_MS : VAT_FAIL_RETRY_MS)) {
    try {
      next = { result: (await read(entry?.result)).result, ok: true, ts: Date.now() };
    } catch (e) {
      console.warn(`[Claude Tuner] VAT ${provider} read failed (non-critical):`, vatErrCode(e));
      next = { result: entry?.result ?? null, ok: false, ts: Date.now() };
    }
    await chrome.storage.local.set({ [key]: { ...cache, [accountKey]: next } });
  }
  if (next.result === 'undecidable') return {};
  // A failed read with nothing cached says nothing — keep the server's value rather than clearing it.
  return next.ok || next.result ? vatFields(next.result, accountKey) : {};
}

/** Claude: payload fields from the paid personal org's latest invoice. Never throws. */
export async function readVatFields(orgList) {
  if (!Array.isArray(orgList) || orgList.length === 0) return {};
  const org = pickVatOrg(orgList);
  if (!org) return CLEAR;
  try {
    return await cachedRead('claude', org.uuid, async (prev) => {
      const invoices = await withTimeout(fetchClaudeApi(`/api/stripe/${org.uuid}/invoices`, { quiet: true }));
      // An unreadable body is a FAILED read (keep), not "no invoice to judge" (clear) — Codex.
      if (!Array.isArray(invoices)) throw new Error('vat_unreadable');
      const r = parseClaudeVatStatus(invoices);
      if (!r) return { result: null };
      // Shadow (#2157): the next bill's tax should flip as soon as a business number is entered, where the
      // paid invoices lag up to a month; the billing country tells VAT from US sales tax. Collected to be
      // compared against the invoice verdict before either is shown.
      const [next, country] = await Promise.all([
        readOptional(`/api/stripe/${org.uuid}/upcoming_invoice`, parseClaudeUpcomingVat, prev?.next),
        readOptional(`${CLAUDE_ORGS_PATH}/${org.uuid}/address`, parseClaudeBillingCountry, prev?.country),
      ]);
      return { result: { ...r, orgUuid: org.uuid, next, country } };
    });
  } catch (e) {
    console.warn('[Claude Tuner] VAT read skipped:', vatErrCode(e));
    return {};
  }
}

/**
 * ChatGPT: payload fields from the paid personal account's billing info (tax ID present?). Never throws.
 * @param {string|null} activeUsageAccountId `/wham/usage` account id — the org key ChatGPT snapshots
 *   (and so the team-sharing policy) use for the ACTIVE account; other accounts use their UUID.
 * @param {string|null} activeUsagePlanType `/wham/usage` plan_type, to confirm that id IS the personal
 *   account before borrowing it.
 */
export async function readChatGPTVatFields(activeUsageAccountId, activeUsagePlanType) {
  try {
    // Keyed by the ACTIVE account as /wham/usage reports it: the verdict's org key is derived from it, so
    // switching accounts must re-read rather than replay a verdict filed under the old key (Codex — a
    // personal account hidden after the switch would otherwise still show).
    const cacheKey = `${activeUsageAccountId || '-'}|${activeUsagePlanType || '-'}`;
    return await cachedRead('chatgpt', cacheKey, async () => {
      const data = await withTimeout(fetchChatGPTApi(CHATGPT_ACCOUNTS_PATH));
      // An unreadable body is a FAILED read (keep), not "no paid personal account" (clear) — Codex.
      // A signed-in member always has at least one account, so an array or an empty map is unreadable too.
      const accounts = data?.accounts;
      if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts) || Object.keys(accounts).length === 0) {
        throw new Error('vat_unreadable');
      }
      const acct = pickChatGPTVatAccount(data);
      if (!acct) return { result: null };
      // The org key must be the one the team-sharing policy hides by, or a hidden personal account would
      // show. Active account → the `/wham/usage` id, but only when usage is visibly reporting THIS account
      // (same plan); if accounts/check and usage disagree, judge nothing (Codex).
      let orgUuid = acct.accountId;
      if (acct.isDefault) {
        if (!activeUsageAccountId || activeUsagePlanType !== acct.planType) return { result: 'undecidable' };
        orgUuid = activeUsageAccountId;
      }
      const info = await withTimeout(fetchChatGPTApi(`${CHATGPT_BILLING_INFO_PATH}?account_id=${encodeURIComponent(acct.accountId)}`));
      const verdict = parseChatGPTBillingInfo(info);
      if (verdict === undefined) throw new Error('vat_unreadable');   // failed read → keep
      // No tax ID outside Korea: whether VAT applies is unknown → judge nothing.
      if (verdict === null) return { result: 'undecidable' };
      return { result: { status: verdict.status, invoiceAt: new Date().toISOString(), orgUuid } };
    });
  } catch (e) {
    console.warn('[Claude Tuner] VAT ChatGPT read skipped:', vatErrCode(e));
    return {};
  }
}

/**
 * PUT `fields` for `provider` when they changed since the last accepted send. Needs an ext_token, and
 * only when its identity is `ingestEmail` — the identity this cycle's snapshot is filed under
 * (resolveIngestIdentity) — and only past the same blocks the snapshot POST obeys. Never throws.
 */
async function sendableIdentity(ingestEmail) {
  const token = await getExtToken();
  // RAW, as resolveIngestIdentity reads it — the lowercased form would never equal a mixed-case
  // ingest identity, and those accounts would send nothing (Codex 5R).
  const email = token ? extTokenEmailRaw(token) : null;
  if (!email || !ingestEmail || email !== ingestEmail) return null;
  if (await isServerSyncPaused() || await isUpgradePostSuppressed() || await isAuthBlockSuppressed(email)) return null;
  return email;
}

async function sendVat(provider, fields, email) {
  if (!('vat_status' in fields)) return;               // unknown this cycle → nothing to say
  const body = { provider, ...fields };
  // ChatGPT's date is the day of the read, so it moves daily; only the verdict and the account decide
  // whether this is news (the weekly resend refreshes the date).
  const sig = JSON.stringify(provider === 'chatgpt' ? { ...body, vat_invoice_at: undefined } : body);
  const sentKey = KEYS[provider].sent;
  const { [sentKey]: sent } = await chrome.storage.local.get(sentKey);
  if (sent?.email === email && sent.sig === sig
      && Date.now() - (sent.ts || 0) < (sent.ok ? VAT_RESEND_MS : VAT_REJECTED_RETRY_MS)) return;
  const config = await getConfig();
  if (!config?.serverUrl) return;
  // The fields were read under `email`, and the billing reads can be slow. If the account changed
  // meanwhile, these facts belong to the old one — authedFetch checks the token it actually attaches
  // and sends nothing when it is another account's (1.55.7 batch review, 2R: a getExtToken() check
  // before the call left a gap before authedFetch read the token again).
  const resp = await authedFetch(config, `${config.serverUrl}/api/users/vat`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, { requireTokenEmail: email });
  if (!resp) return;
  // Only a 2xx counts as sent. A 4xx (malformed, no live account) cannot change by resending the same
  // body every poll, so it is retried after a few hours; 401/5xx are retried next cycle.
  if (resp.ok || (resp.status >= 400 && resp.status < 500 && resp.status !== 401)) {
    await chrome.storage.local.set({ [sentKey]: { email, sig, ok: resp.ok, ts: Date.now() } });
  }
}

/** Claude (bg/collect.js, server-path cycles only). Never throws. */
// Both check the send conditions BEFORE reading: a blocked or paused install does not touch the
// provider's billing endpoints at all (as 1.55.4 did — Codex).
export async function syncVatStatus(orgList, ingestEmail) {
  try {
    const email = await sendableIdentity(ingestEmail);
    if (!email) return;
    await sendVat('claude', await readVatFields(orgList), email);
  } catch (e) {
    console.warn('[Claude Tuner] VAT sync skipped:', vatErrCode(e));
  }
}

/** ChatGPT (bg/collect-chatgpt.js). Never throws. */
export async function syncChatGPTVatStatus(activeUsageAccountId, activeUsagePlanType, ingestEmail) {
  try {
    const email = await sendableIdentity(ingestEmail);
    if (!email) return;
    await sendVat('chatgpt', await readChatGPTVatFields(activeUsageAccountId, activeUsagePlanType), email);
  } catch (e) {
    console.warn('[Claude Tuner] VAT ChatGPT sync skipped:', vatErrCode(e));
  }
}
