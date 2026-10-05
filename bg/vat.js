// VAT verdict of the personal Claude subscription (#2157) — for the team dashboard.
//
// Invoices change once a month, so the read is cached for a day per org, and the verdict is PUT to
// /api/users/vat only when it CHANGES (or weekly, to heal a lost write). It deliberately does not ride
// the snapshot: `users` is at D1's column cap and the ingest hot path must not grow a statement.
// Parsing lives in parse-claude.js (chrome-free, under the provider contract).
//
// Three answers, matching the server (worker/src/utils/vat-status.ts):
//   { vat_status, vat_invoice_at, vat_org_uuid } — a verdict
//   { vat_status: null }                         — CLEAR: no paid personal org any more, or its
//                                                  invoices hold nothing to judge (Codex 2R: a member
//                                                  who moved to a Team seat kept "paying VAT" forever)
//   {}                                           — unknown this cycle (read failed, nothing cached): keep
import { fetchClaudeApi } from './api.js';
import { parseClaudeVatStatus } from './parse-claude.js';
import { claudeOrgPlan } from '../vendor-ai/models.js';
import { authedFetch, extTokenEmailRaw, getConfig, getExtToken, isServerSyncPaused } from './storage.js';

const VAT_CACHE_KEY = 'vatCache';   // { [orgUuid]: { result, ok, ts } }
const VAT_TTL_MS = 24 * 60 * 60 * 1000;
// A failed read is retried sooner, but not every poll — the endpoint is not ours to hammer.
const VAT_FAIL_RETRY_MS = 6 * 60 * 60 * 1000;
// Plans billed to the member personally (claude.ai Pro/Max). Team/Enterprise seats are billed to the org.
const PERSONAL_PAID_PLANS = new Set(['pro', 'max', 'max_5x', 'max_20x']);
const CLEAR = Object.freeze({ vat_status: null });
const VAT_SENT_KEY = 'vatSent';     // { email, sig, ok, ts } — last attempt; ok = the server accepted it
const VAT_RESEND_MS = 7 * 24 * 60 * 60 * 1000;
const VAT_REJECTED_RETRY_MS = 6 * 60 * 60 * 1000;
// The invoice read is optional; a hung tab or cookie fetch must not keep this promise alive.
const VAT_READ_TIMEOUT_MS = 15_000;

/** The member's paid personal org, if the org list shows one. */
export function pickVatOrg(orgList) {
  if (!Array.isArray(orgList)) return null;
  return orgList.find(o => o?.uuid && PERSONAL_PAID_PLANS.has(claudeOrgPlan(o))) || null;
}

function vatFields(orgUuid, result) {
  if (!result) return CLEAR;
  return { vat_status: result.status, vat_invoice_at: result.invoiceAt, vat_org_uuid: orgUuid };
}

/**
 * @param {Array|null} orgList the Claude org list read this cycle (null/empty = not observed → keep)
 * @returns {Promise<object>} payload fields (see header)
 */
export async function readVatFields(orgList) {
  if (!Array.isArray(orgList) || orgList.length === 0) return {};
  const org = pickVatOrg(orgList);
  if (!org) return CLEAR;
  try {
    return await readVatFieldsFor(org.uuid);
  } catch (e) {
    // Never let this optional field cost the snapshot it rides on.
    console.warn('[Claude Tuner] VAT read skipped:', e?.message);
    return {};
  }
}

async function readVatFieldsFor(orgUuid) {
  const { [VAT_CACHE_KEY]: stored } = await chrome.storage.local.get(VAT_CACHE_KEY);
  const cache = (stored && typeof stored === 'object' && !('orgUuid' in stored)) ? stored : {};
  const entry = cache[orgUuid];
  const age = entry ? Date.now() - (entry.ts || 0) : Infinity;
  if (entry && age < (entry.ok ? VAT_TTL_MS : VAT_FAIL_RETRY_MS)) {
    return entry.ok || entry.result ? vatFields(orgUuid, entry.result) : {};
  }

  let next;
  try {
    const invoices = await Promise.race([
      fetchClaudeApi(`/api/stripe/${orgUuid}/invoices`, { quiet: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('vat_read_timeout')), VAT_READ_TIMEOUT_MS)),
    ]);
    next = { result: parseClaudeVatStatus(invoices), ok: true, ts: Date.now() };
  } catch (e) {
    // Keep the last verdict for this org (a failed read is not a changed invoice).
    console.warn('[Claude Tuner] VAT invoice read failed (non-critical):', e?.message);
    next = { result: entry?.result ?? null, ok: false, ts: Date.now() };
  }
  await chrome.storage.local.set({ [VAT_CACHE_KEY]: { ...cache, [orgUuid]: next } });
  // A failed read with nothing cached says nothing — keep the server's value rather than clearing it.
  return next.ok || next.result ? vatFields(orgUuid, next.result) : {};
}

/**
 * Read the verdict and PUT it to the server when it changed since the last accepted send. Needs an
 * ext_token, and only when its identity is `ingestEmail` — the identity this cycle's snapshot is filed
 * under (resolveIngestIdentity). The server keys the row on the token, so the verdict then belongs to
 * the same Tuner account as the usage; when the snapshot goes elsewhere, nothing is sent. Never throws.
 */
export async function syncVatStatus(orgList, ingestEmail) {
  try {
    const token = await getExtToken();
    // RAW, as resolveIngestIdentity reads it — the lowercased form would never equal a mixed-case
    // ingest identity, and those accounts would send nothing (Codex 5R).
    const email = token ? extTokenEmailRaw(token) : null;
    if (!email || !ingestEmail || email !== ingestEmail) return;
    if (await isServerSyncPaused()) return;
    const fields = await readVatFields(orgList);
    if (!('vat_status' in fields)) return;               // unknown this cycle → nothing to say
    const sig = JSON.stringify(fields);
    const { [VAT_SENT_KEY]: sent } = await chrome.storage.local.get(VAT_SENT_KEY);
    if (sent?.email === email && sent.sig === sig
        && Date.now() - (sent.ts || 0) < (sent.ok ? VAT_RESEND_MS : VAT_REJECTED_RETRY_MS)) return;
    const config = await getConfig();
    if (!config?.serverUrl) return;
    const resp = await authedFetch(config, `${config.serverUrl}/api/users/vat`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: sig,
    });
    // Only a 2xx counts as sent. A 4xx (malformed, no live account) cannot change by resending the same
    // body every poll, so it is retried after a few hours; 401/5xx are retried next cycle.
    if (resp.ok || (resp.status >= 400 && resp.status < 500 && resp.status !== 401)) {
      await chrome.storage.local.set({ [VAT_SENT_KEY]: { email, sig, ok: resp.ok, ts: Date.now() } });
    }
  } catch (e) {
    console.warn('[Claude Tuner] VAT sync skipped:', e?.message);
  }
}
