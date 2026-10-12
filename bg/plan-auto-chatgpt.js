// bg/plan-auto-chatgpt.js — executes a source='auto' ChatGPT DOWNGRADE order (#2332). The ChatGPT twin of
// bg/plan-auto.js, sharing its done-set, execute approval, report queue and member card.
//
// Protocol (docs/SPEC-chatgpt-plan-change.md, measured 08-07 / 10-06 / 10-12):
//   - schedule a downgrade:  POST /backend-api/subscriptions/update {account_id, updated_plan: <slug>} → 200 {}
//   - cancel it (free):      POST /backend-api/subscriptions/renew  {account_id}                      → 200 {}
//   - both answer an EMPTY 200, so success is proven only by re-reading accounts/check:
//     entitlement.scheduled_plan_change = {plan_type, changes_at} (or null after a renew).
//   - Bearer token from /api/auth/session, obtained and used INSIDE the chatgpt.com page — it never
//     leaves the page, let alone reaches our server.
//
// 🔑 WHICH ACCOUNT. A ChatGPT snapshot — and so the order's target_org_uuid — is keyed by the ACTIVE
// session's /wham/usage id, which for personal accounts is a `user-…` id that accounts/check never carries
// (measured 2026-10-12: 609 Plus / 237 Pro 5x / 139 Pro 20x members keyed `user-…`, 8 by UUID). So the
// target is proven by the SESSION: /wham/usage must report the order's key, and the account changed is the
// ONE personal account whose `account_user_id` starts with that `user-…` id (measured 2026-10-12: every
// account of the user carries it; a user has one personal account). It does not depend on `default`,
// which /wham/usage and accounts/check have disagreed on (Codex unit-3 R1). Its UUID goes in the request
// body. The usage key is read again right before asking for approval, so a login switch does nothing.
//
// Same contract as the Claude path, in order:
//   1. re-verify on chatgpt.com right before acting: the target account is in THIS browser's
//      accounts/check, it is the member's PERSONAL account, billed monthly, not on trial / delinquent /
//      gratis, nothing is scheduled or cancelling on it, and it is still on from_plan. Each failure ends
//      the order charge-free with no write call;
//   2. a usable chatgpt.com tab must exist — the write goes through the page only (no cookie fallback,
//      which would re-send a request whose first attempt may already have landed);
//   3. execute approval from the server (POST /plan-order-execute) — none means no call (fail-closed);
//   4. ONE write call, never retried; then one re-read to prove it; report with the account it changed.
// A downgrade never charges (₩0 preview, measured) and only takes effect at renewal.
import { fetchChatGPTApi } from './api-chatgpt.js';
import { chatgptPlanName, chatgptUsageAccountId, CHATGPT_USAGE_PATH } from './parse-chatgpt.js';
import { SITE_TAB_PATTERNS, CHATGPT_API_BASE } from './constants.js';
import { isUsableTab } from '../vendor-ai/sites.js';
import { getOrCreateInstallId } from './storage.js';
import {
  AUTO_OUTCOME, flushAutoReports, isDone, markDone, unmarkDone, requestExecute, reportAutoResult, tellMember,
  ourReservation, rememberReservation, forgetReservation, PLAN_AUTO_CARD_KEY,
} from './plan-auto.js';

export const CHATGPT_ACCOUNTS_CHECK_PATH = '/backend-api/accounts/check/v4-2023-04-27';
export const CHATGPT_UPDATE_PATH = '/backend-api/subscriptions/update';
export const CHATGPT_RENEW_PATH = '/backend-api/subscriptions/renew';
/** Slugs for `updated_plan` (SPEC; `chatgptproplan` answers 400). Downgrade targets only. */
export const CHATGPT_PLAN_SLUG = Object.freeze({ Plus: 'chatgptplusplan', 'Pro 5x': 'chatgptprolite', 'Pro 20x': 'chatgptpro' });
/** The ladder automatic ChatGPT orders move down (worker policy.ts CHATGPT_AUTO_LADDER). */
const CG_LADDER = ['Plus', 'Pro 5x', 'Pro 20x'];
const MONTHLY = 'monthly';       // entitlement.billing_period, measured 2026-10-12 (personal + workspaces)
const WRITE_TIMEOUT_MS = 30_000; // a downgrade answered in ~6 s, an upgrade ~15 s
const PROOF_READS = 3;           // re-reads after a 200 (reads are safe to repeat; the write never is)
const PROOF_GAP_MS = 2_000;
/** postOnceViaTab: the script could not be injected, so nothing was sent. */
const NOT_SENT = -1;

const rank = (p) => CG_LADDER.indexOf(p);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The accounts/check entry an order keyed `usageKey` (the /wham/usage key) targets, or null:
 *   - `user-…` key → the ONE personal account whose account_user_id starts with it (two or none → null);
 *   - UUID key     → the account with that account_id.
 * Canonical (UUID-keyed) entries only — `default` is an alias. Pure.
 */
export function resolveActiveChatgptAccount(data, usageKey) {
  const accounts = isObj(data?.accounts) ? data.accounts : null;
  if (!accounts || typeof usageKey !== 'string' || !usageKey || usageKey === 'unknown') return null;
  const entries = Object.entries(accounts).filter(([k, a]) => k !== 'default' && isObj(a) && isObj(a.account)).map(([, a]) => a);
  if (usageKey.startsWith('user-')) {
    // account_user_id = `${user_id}__${account_id}` (measured 2026-10-12, every account) — matched whole.
    const mine = entries.filter((a) => a.account.structure === 'personal'
      && a.account.account_user_id === `${usageKey}__${a.account.account_id}`);
    return mine.length === 1 ? mine[0] : null;
  }
  const hit = entries.filter((a) => a.account.account_id === usageKey);
  return hit.length === 1 ? hit[0] : null;
}

/** entitlement top-level KEY names (never values) — diagnostic for an unreadable billing period. Pure. */
function entitlementKeyNames(ent) {
  return isObj(ent) ? Object.keys(ent).filter((k) => /^[A-Za-z0-9_]{1,64}$/.test(k)).slice(0, 50) : [];
}

/**
 * Pure: what to do given the order and the account as chatgpt.com reports it right now. Returns a final
 * charge-free outcome (no write call) or the call to make. `ours` = the reservation THIS browser made
 * for an earlier auto order on this account ({ order_id, plan_type: <label> }) or null.
 */
export function planAutoPrecheckChatgpt(po, acct, ours = null) {
  const fail = (outcome, extra = {}) => ({ final: { result: 'failed', outcome, ...extra } });
  // `acct` is the active account the caller resolved AFTER proving the session reports the order's key.
  if (!acct || typeof acct.account?.account_id !== 'string') return fail(AUTO_OUTCOME.orgUnverified);
  // A workspace seat is the organization's purchase, never the member's to change.
  if (acct.account?.structure !== 'personal') return fail(AUTO_OUTCOME.orgUnverified);
  const ent = isObj(acct.entitlement) ? acct.entitlement : {};
  if (typeof ent.billing_period !== 'string') return fail(AUTO_OUTCOME.intervalUnknown, { diag_keys: entitlementKeyNames(ent) });
  if (ent.billing_period !== MONTHLY) return fail(AUTO_OUTCOME.notMonthly);
  const current = chatgptPlanName(acct.account?.plan_type);
  const sched = isObj(ent.scheduled_plan_change) ? ent.scheduled_plan_change : null;
  const schedPlan = sched ? chatgptPlanName(sched.plan_type) : null;
  // A pending cancellation is invisible in scheduled_plan_change (SPEC) — cancels_at carries it here.
  // Trial / delinquent / gratis: the subscription is not in a state an automatic change should touch.
  const reserved = !!sched || !!ent.cancels_at || !!ent.trial || !!ent.is_delinquent || !!ent.is_active_subscription_gratis;
  const accountId = acct.account.account_id;
  if (po.kind === 'cancel_downgrade') {
    if (!sched) return { final: { result: 'completed', outcome: AUTO_OUTCOME.alreadySatisfied } };
    // Only the reservation an auto order made and this browser has watched since — never the member's own.
    if (!po.cancel_of_plan || schedPlan !== po.cancel_of_plan || !ours || ours.plan_type !== schedPlan || ent.cancels_at) {
      return fail(AUTO_OUTCOME.reservationPresent);
    }
    return { call: { path: CHATGPT_RENEW_PATH, body: { account_id: accountId }, expect: null } };
  }
  // Downgrades only, ONE step (the policy's D4): anything else is refused, never executed.
  if (rank(po.to_plan) < 0 || rank(po.from_plan) < 0 || rank(po.from_plan) - rank(po.to_plan) !== 1) return fail(AUTO_OUTCOME.changedExternally);
  if (current === po.to_plan) return { final: { result: 'completed', outcome: AUTO_OUTCOME.alreadySatisfied } };
  if (schedPlan === po.to_plan && !ent.cancels_at) return { final: { result: 'completed', outcome: AUTO_OUTCOME.alreadyScheduled } };
  if (reserved) return fail(AUTO_OUTCOME.reservationPresent);
  if (current !== po.from_plan) return fail(AUTO_OUTCOME.changedExternally);
  const slug = CHATGPT_PLAN_SLUG[po.to_plan];
  if (!slug) return fail(AUTO_OUTCOME.changedExternally);
  return { call: { path: CHATGPT_UPDATE_PATH, body: { account_id: accountId, updated_plan: slug }, expect: po.to_plan } };
}

/** Pure: is the write proven by the re-read? `expect` = the plan now scheduled, or null = nothing scheduled. */
export function chatgptWriteProven(acct, expect) {
  if (!acct) return false;
  const ent = isObj(acct.entitlement) ? acct.entitlement : {};
  const sched = isObj(ent.scheduled_plan_change) ? ent.scheduled_plan_change : null;
  if (expect == null) return !sched;
  return !!sched && chatgptPlanName(sched.plan_type) === expect;
}

/** Pure: an HTTP status from the page → outcome. A 4xx is ChatGPT refusing (nothing changed); anything
 *  else — 0 (no answer), 5xx, a missing status — may have gone through. */
export function classifyChatgptWrite(status) {
  if (status === NOT_SENT) return { result: 'failed', outcome: AUTO_OUTCOME.apiError };
  if (typeof status === 'number' && status >= 200 && status < 300) return { result: 'completed', outcome: null };
  if (typeof status === 'number' && status >= 400 && status < 500) return { result: 'failed', outcome: AUTO_OUTCOME.apiError };
  return { result: 'unknown', outcome: AUTO_OUTCOME.unknown };
}

async function usableChatgptTab() {
  try {
    const tabs = (await chrome.tabs.query({ url: SITE_TAB_PATTERNS.chatgpt })).filter(isUsableTab);
    return tabs[0] || null;
  } catch { return null; }
}

/** ONE POST through ONE open chatgpt.com tab — no retry, no cookie fallback. → HTTP status (0 = no answer). */
async function postOnceViaTab(tabId, path, body) {
  const run = chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (url, json) => {
      try {
        const sr = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
        if (!sr.ok) return { status: 401 };
        const s = await sr.json();
        if (!s?.accessToken) return { status: 401 };
        const r = await fetch(url, {
          method: 'POST', credentials: 'include', cache: 'no-store',
          headers: { Authorization: 'Bearer ' + s.accessToken, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: json,
        });
        return { status: r.status };
      } catch { return { status: 0 }; }
    },
    args: [`${CHATGPT_API_BASE}${path}`, JSON.stringify(body)],
  });
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), WRITE_TIMEOUT_MS); });
  try {
    const res = await Promise.race([run, timeout]);
    const status = res?.[0]?.result?.status;
    return typeof status === 'number' ? status : 0;
  } catch {
    // executeScript itself refused (tab closed / navigated away before injection): the page never ran,
    // so the request was never sent — not an unclear outcome (Codex unit-3 R1 follow-up).
    return NOT_SENT;
  } finally {
    clearTimeout(timer);
  }
}

/** The session's usage key (the snapshot / order key of the active account). Throws on a failed read. */
async function activeUsageKey() {
  return chatgptUsageAccountId(await fetchChatGPTApi(CHATGPT_USAGE_PATH));
}

/** Re-read until the write shows (or PROOF_READS run out). The proving account entry, or null. Never throws. */
async function proveWrite(orderKey, expect) {
  for (let i = 0; i < PROOF_READS; i++) {
    if (i) await new Promise((r) => setTimeout(r, PROOF_GAP_MS));
    try {
      const acct = await readActiveAccount(orderKey);
      if (chatgptWriteProven(acct, expect)) return acct;
    } catch { /* next read */ }
  }
  return null;
}

/** The active account, only while the session still reports `orderKey`; null otherwise. Throws on a failed read. */
async function readActiveAccount(orderKey) {
  const key = await activeUsageKey();
  if (key !== orderKey) return null;
  return resolveActiveChatgptAccount(await fetchChatGPTApi(CHATGPT_ACCOUNTS_CHECK_PATH), key);
}

const _inFlight = new Set();

/** Entry point from a ChatGPT snapshot POST response (bg/collect-chatgpt.js) for a source='auto' order. */
export async function handleAutoChatgptOrder(config, po, userEmail) {
  if (!po || po.source !== 'auto' || po.provider !== 'chatgpt' || !po.order_id || !po.target_org_uuid || !userEmail) {
    await flushAutoReports(config).catch(() => {});
    return;
  }
  if (_inFlight.has(po.order_id)) return;
  _inFlight.add(po.order_id);
  try {
    await flushAutoReports(config).catch(() => {});
    if (await isDone(po.order_id)) return;
    const installId = await getOrCreateInstallId();
    let acct;
    try {
      // The session must be the order's account right now. Another login (the member's second ChatGPT
      // account) is not a failure of the order — nothing happens, and a later POST from the right
      // session tries again before the order expires.
      if ((await activeUsageKey()) !== po.target_org_uuid) return;
      const data = await fetchChatGPTApi(CHATGPT_ACCOUNTS_CHECK_PATH);
      // An unreadable roster is a failed READ (retry later), not "the account is gone".
      if (!isObj(data?.accounts)) return;
      acct = resolveActiveChatgptAccount(data, po.target_org_uuid);
    } catch (e) {
      console.warn(`[Claude Tuner] auto ChatGPT order #${po.order_id}: pre-check read failed, retrying later:`, e?.message);
      return;
    }
    const pre = planAutoPrecheckChatgpt(po, acct, acct ? await ourReservation(po.target_org_uuid) : null);
    let changeDate = acct?.entitlement?.renews_at || null;
    if (pre.final) {
      await markDone(po.order_id);
      await reportAutoResult(config, po, userEmail, installId, pre.final, null);
      await tellMember(po, pre.final, changeDate, userEmail);
      return;
    }
    // The write goes through the page only. No usable tab = nothing done this time (no approval asked,
    // nothing marked): a later POST with a tab open tries again before the order expires.
    const tab = await usableChatgptTab();
    if (!tab) {
      console.log(`[Claude Tuner] auto ChatGPT order #${po.order_id}: no chatgpt.com tab — waiting`);
      return;
    }
    // The session again, as late as possible BEFORE approval: a login switch since the pre-check ends
    // nothing — this run simply stops. (After approval an 'unknown' would count toward the global API
    // kill, and a switch is no API failure.) The remaining gap is the approval round trip; the body names
    // the pre-checked account's UUID, which another session cannot change.
    let sameSession = false;
    try { sameSession = (await activeUsageKey()) === po.target_org_uuid; } catch { /* unread = not proven */ }
    if (!sameSession) return;
    // 🔴 Done BEFORE approval (same reason as the Claude path): no storage write between the approval and
    // the call, and a worker that dies after this line never attempts the order again.
    await markDone(po.order_id);
    if (!(await requestExecute(config, po, userEmail, installId))) {
      await unmarkDone(po.order_id);
      return;
    }
    let r = classifyChatgptWrite(await postOnceViaTab(tab.id, pre.call.path, pre.call.body));
    let changed = null;
    if (r.result === 'completed') {
      // The 200 body is empty either way: only the re-read proves it. Unproven = 'unknown' (the call
      // went out and answered 200), which the server settles from the account's own observations.
      const proof = await proveWrite(po.target_org_uuid, pre.call.expect);
      if (proof) {
        // The real switch date (it has differed from renews_at — SPEC 08-07).
        changeDate = proof.entitlement?.scheduled_plan_change?.changes_at || changeDate;
        changed = po.target_org_uuid;
        if (po.kind === 'cancel_downgrade') await forgetReservation(po.target_org_uuid);
        else await rememberReservation(po.target_org_uuid, po.order_id, po.to_plan);
      } else {
        r = { result: 'unknown', outcome: AUTO_OUTCOME.unknown };
      }
    }
    await reportAutoResult(config, po, userEmail, installId, r, changed);
    await tellMember(po, r, changeDate, userEmail);
  } finally {
    _inFlight.delete(po.order_id);
  }
}

/** How often the collector re-checks a reservation this browser made (a read of accounts/check). */
const RESERVATION_CHECK_MS = 60 * 60 * 1000;

/**
 * Pure: is our reservation still what is scheduled on the order's account? `acct` = that account's entry
 * as resolveActiveChatgptAccount picks it (never `default` — Codex unit-3 R2), or null = no evidence.
 * → 'keep' | 'applied' (the downgrade took effect: the plan IS the reserved one) | 'gone' | 'unknown'.
 */
export function reservationStillOurs(acct, ours) {
  if (!acct || !ours) return 'unknown';
  const sched = isObj(acct.entitlement?.scheduled_plan_change) ? acct.entitlement.scheduled_plan_change : null;
  if (sched && chatgptPlanName(sched.plan_type) === ours.plan_type) return 'keep';
  if (chatgptPlanName(acct.account?.plan_type) === ours.plan_type) return 'applied';
  return 'gone';
}

/**
 * Collector hook (bg/collect-chatgpt.js), once per ChatGPT cycle: if this browser made a reservation on
 * `accountKey` (the order key) and the account no longer has it scheduled — the member cancelled or
 * replaced it — it stops being ours for good (same rule as the Claude path's noteSubscriptionObservation)
 * and the card stops offering [예약 취소]. Reads accounts/check itself, on the order's own account, only
 * while a reservation exists and at most hourly. Never throws.
 */
export async function checkChatgptReservation(accountKey) {
  try {
    if (!accountKey) return;
    const ours = await ourReservation(accountKey);
    if (!ours || Date.now() - (ours.checked_at || ours.at || 0) < RESERVATION_CHECK_MS) return;
    let verdict = 'unknown';
    try {
      verdict = reservationStillOurs(resolveActiveChatgptAccount(await fetchChatGPTApi(CHATGPT_ACCOUNTS_CHECK_PATH), accountKey), ours);
    } catch { /* a failed read is no evidence */ }
    if (verdict === 'keep' || verdict === 'unknown') {
      await rememberReservation(accountKey, ours.order_id, ours.plan_type, { checked_at: Date.now() });
      return;
    }
    await forgetReservation(accountKey);
    // Applied as scheduled: nothing left to cancel, and the card (which retires itself after the change
    // date) must not claim the member changed anything.
    if (verdict === 'applied') return;
    const { [PLAN_AUTO_CARD_KEY]: card = null } = await chrome.storage.local.get({ [PLAN_AUTO_CARD_KEY]: null });
    if (card && card.order_id === ours.order_id && card.result === 'completed') {
      await chrome.storage.local.set({ [PLAN_AUTO_CARD_KEY]: { ...card, result: 'member_changed', at: Date.now() } });
    }
  } catch { /* never fails the cycle */ }
}

/** [예약 취소] for a ChatGPT downgrade an auto order scheduled — only if it is still exactly ours. Free. */
export async function cancelAutoDowngradeChatgpt(accountId, scheduledPlan) {
  try {
    // `accountId` is the order's key (the usage key): the session must be that account.
    const acct = await readActiveAccount(accountId);
    if (!acct || acct.account?.structure !== 'personal') return { success: false, error: 'err_plan_org_unverified' };
    const sched = acct.entitlement?.scheduled_plan_change;
    const ours = await ourReservation(accountId);
    if (!sched || chatgptPlanName(sched.plan_type) !== scheduledPlan || !ours || ours.plan_type !== scheduledPlan) {
      return { success: false, error: 'No scheduled downgrade found' };
    }
    const tab = await usableChatgptTab();
    if (!tab) return { success: false, error: 'err_chatgpt_no_tab' };
    const r = classifyChatgptWrite(await postOnceViaTab(tab.id, CHATGPT_RENEW_PATH, { account_id: acct.account.account_id }));
    if (r.result !== 'completed') return { success: false, error: r.outcome };
    if (!(await proveWrite(accountId, null))) return { success: false, error: AUTO_OUTCOME.unknown };
    await forgetReservation(accountId);
    return { success: true };
  } catch (e) {
    return { success: false, error: e?.message || 'cancel failed' };
  }
}
