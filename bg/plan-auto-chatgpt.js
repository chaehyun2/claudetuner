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
//   2. the write goes through a chatgpt.com page only (no cookie fallback, which would re-send a request
//      whose first attempt may already have landed). An open tab is used; with none open, one is opened
//      in the background for this order and closed after it (#2503 — measured: hidden tab, 3-5 s);
//   3. execute approval from the server (POST /plan-order-execute) — none means no call (fail-closed);
//   4. ONE write call, never retried; then one re-read to prove it; report with the account it changed.
// A downgrade never charges (₩0 preview, measured) and only takes effect at renewal.
import { fetchChatGPTApi } from './api-chatgpt.js';
import { chatgptPlanName, chatgptUsageAccountId, chatgptPersonalOrgKey, CHATGPT_USAGE_PATH, resolveActiveChatgptAccount } from './parse-chatgpt.js';
// Re-exported: the guard and callers reach it through this module (it lives with the parsers so the
// roster and the auto-downgrade resolve "the active account" by one rule).
export { resolveActiveChatgptAccount };
import { SITE_TAB_PATTERNS, CHATGPT_API_BASE } from './constants.js';
import { isUsableTab } from '../vendor-ai/sites.js';
import { getOrCreateInstallId } from './storage.js';
import {
  AUTO_OUTCOME, flushAutoReports, isDone, beginOrder, approveOrSettle, boundedRead, reportAutoResult, tellMember,
  ourReservation, rememberReservation, forgetReservation, patchPlanAutoCard, claimOrder, releaseOrder, withWorkerKeepalive,
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
const TAB_LOAD_TIMEOUT_MS = 30_000; // a background chatgpt.com tab loaded in 1.6-3.2 s (#2503)
/**
 * Why a run ended with nothing marked, nothing asked and nothing reported — the order simply waits for a
 * later POST. Without this the server could not tell any of them apart (order 63 sat `delivered` for days,
 * #2503). Closed vocabulary — the worker drops anything else (services/ae/plan-auto-wait.ts).
 */
export const CG_WAIT = Object.freeze({
  session: 'session_mismatch', roster: 'roster_unreadable', read: 'precheck_read_failed',
  noWindow: 'no_window', tab: 'tab_open_failed', switched: 'session_switched',
});
const WAIT_KEY = 'planAutoChatgptWait';
/** A noted wait rides ChatGPT POSTs for at most this long (an order lives ~a week). */
const WAIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** One background tab per order per hour: a tab that never loads must not reopen on every POST. */
const TAB_OPEN_KEY = 'planAutoChatgptTabOpen';
const TAB_REOPEN_MS = 60 * 60 * 1000;
/**
 * The background tab we opened, in storage.SESSION (Codex R1-B1): a worker that dies while using it
 * never reaches its finally, and the next run would take the leftover tab for the member's own. The
 * session area is cleared on browser restart, so a recorded id can never name a different tab after a
 * restart (tab ids are reused across browser sessions, never within one).
 */
// One key PER TAB (Codex R2): two runs opening tabs at once must not overwrite each other's record.
const OUR_TAB_PREFIX = 'planAutoChatgptOurTab:';
/**
 * Tabs this worker opened and has not finished closing. NEVER handed to another run (Codex R1-B2 → no
 * sharing at all): each run opens its own background tab and closes only that one, so no run can close
 * a tab another is using. Lives and dies with the worker; a dead worker's tabs are swept (above).
 */
const ourTabs = new Set();
/**
 * Choosing / opening / sweeping tabs runs one at a time (not the write itself): between "a tab exists"
 * and "it is in ourTabs" another run must not look and take our new tab for the member's own.
 */
let tabLock = Promise.resolve();
function withTabLock(fn) {
  const run = tabLock.then(fn, fn);
  tabLock = run.catch(() => {});
  return run;
}

const rank = (p) => CG_LADDER.indexOf(p);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

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
    const tabs = (await chrome.tabs.query({ url: SITE_TAB_PATTERNS.chatgpt })).filter((t) => isUsableTab(t) && !ourTabs.has(t.id));
    return tabs[0] || null;
  } catch { return null; }
}

/** Resolves true once the tab finished loading on chatgpt.com, false on timeout / close / a redirect away. */
function chatgptTabLoaded(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(v);
    };
    // A logged-out session lands on auth.openai.com — not a page the write may run in.
    const onChatgpt = (url) => { try { return new URL(url).origin === CHATGPT_API_BASE; } catch { return false; } };
    const onUpdated = (id, info, tab) => { if (id === tabId && info.status === 'complete') finish(onChatgpt(tab?.url)); };
    const onRemoved = (id) => { if (id === tabId) finish(false); };
    const timer = setTimeout(() => finish(false), TAB_LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    // Already complete before the listener was attached.
    chrome.tabs.get(tabId).then((t) => { if (t?.status === 'complete') finish(onChatgpt(t.url)); }, () => finish(false));
  });
}

/**
 * A chatgpt.com tab for the write: an open one, else one opened in the BACKGROUND for this order only
 * (#2503 — the member downgraded is the one who rarely opens ChatGPT, so "wait for a tab" never ended).
 * Never opens a window: with no normal window a new tab would pop up a visible one, so that run waits.
 * Incognito windows are skipped (other cookies — another session). → { tab, opened } | { wait: CG_WAIT.* }
 */
function acquireChatgptTab(orderId) {
  return withTabLock(async () => {
    await sweepLocked();
    const open = await usableChatgptTab();
    if (open) return { tab: open, opened: false };
    let tab = null;
    try {
      const wins = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter((w) => !w.incognito);
      if (!wins.length) return { wait: CG_WAIT.noWindow };
      // orderId null = the member's own [예약 취소] — never rate-limited (they are there, clicking).
      if (orderId != null) {
        const last = (await chrome.storage.local.get(TAB_OPEN_KEY))[TAB_OPEN_KEY];
        if (last?.order_id === orderId && Date.now() - last.at < TAB_REOPEN_MS) return { wait: CG_WAIT.tab };
        await chrome.storage.local.set({ [TAB_OPEN_KEY]: { order_id: orderId, at: Date.now() } });
      }
      const win = wins.find((w) => w.focused) || wins[0];
      tab = await chrome.tabs.create({ url: `${CHATGPT_API_BASE}/`, active: false, windowId: win.id });
      ourTabs.add(tab.id);
      // Best effort (Codex R2-B1): without the record only a worker death would leave this tab behind.
      try { await chrome.storage.session.set({ [OUR_TAB_PREFIX + tab.id]: Date.now() }); } catch { /* not recorded */ }
      if (await chatgptTabLoaded(tab.id)) return { tab, opened: true };
    } catch { /* fall through: close what was opened */ }
    if (tab) await closeOpenedTab(tab);
    return { wait: CG_WAIT.tab };
  });
}

/** Closes a tab this run opened. It leaves ourTabs only once closed, so no run can take it meanwhile. */
async function closeOpenedTab(tab) {
  try {
    try { await chrome.storage.session.remove(OUR_TAB_PREFIX + tab.id); } catch { /* recorded nothing */ }
    await removeUnlessViewed(tab.id);
  } finally {
    ourTabs.delete(tab.id);
  }
}

/** A tab the member switched to (they clicked it while it ran) is theirs now — left open. */
async function removeUnlessViewed(id) {
  try {
    if ((await chrome.tabs.get(id))?.active) return;
    await chrome.tabs.remove(id);
  } catch { /* already gone */ }
}

/**
 * Closes background tabs a dead worker left behind: recorded in this browser session and not opened by
 * THIS worker. Before every acquisition (inside the lock) and on every ChatGPT cycle. Never throws.
 */
export function sweepOrphanChatgptTab() {
  return withTabLock(sweepLocked);
}

async function sweepLocked() {
  try {
    const all = await chrome.storage.session.get(null);
    for (const key of Object.keys(all || {})) {
      if (!key.startsWith(OUR_TAB_PREFIX)) continue;
      const id = Number(key.slice(OUR_TAB_PREFIX.length));
      if (!Number.isInteger(id) || ourTabs.has(id)) continue;
      // Inside the tab lock: no run can look for a tab until this one is gone (Codex R3-B1).
      await chrome.storage.session.remove(key);
      await removeUnlessViewed(id);
    }
  } catch { /* no session storage */ }
}

async function noteWait(orderId, reason) {
  try { await chrome.storage.local.set({ [WAIT_KEY]: { order_id: orderId, reason, at: Date.now() } }); } catch { /* observation only */ }
}

/** The last noted wait, for the next ChatGPT POST (`plan_auto_wait`), or null. Never throws. */
export async function readPlanAutoWait() {
  try {
    const w = (await chrome.storage.local.get(WAIT_KEY))[WAIT_KEY];
    if (!w || !Number.isInteger(w.order_id) || typeof w.reason !== 'string' || !(Date.now() - w.at < WAIT_MAX_AGE_MS)) return null;
    return w;
  } catch { return null; }
}

/** Clears the wait a POST carried — only that one (a newer wait noted meanwhile stays for the next POST). */
export async function clearPlanAutoWait(sent) {
  try {
    const w = (await chrome.storage.local.get(WAIT_KEY))[WAIT_KEY];
    if (w && sent && w.at === sent.at) await chrome.storage.local.remove(WAIT_KEY);
  } catch { /* observation only */ }
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

/**
 * The session's org key (the snapshot / order key of the active account): the /wham/usage key, except a
 * personal account reported under its UUID maps to its `user-…` key exactly as the collector files it
 * (#2458) — otherwise an order keyed `user-…` would wait, or a cancel fail, whenever /wham/usage answers
 * with the UUID. The extra accounts/check read happens only on such a UUID answer. Throws on a failed read.
 */
async function activeUsageKey() {
  const key = chatgptUsageAccountId(await fetchChatGPTApi(CHATGPT_USAGE_PATH));
  if (key === 'unknown' || key.startsWith('user-')) return key;
  return chatgptPersonalOrgKey(await fetchChatGPTApi(CHATGPT_ACCOUNTS_CHECK_PATH), key) || key;
}

/** Re-read until the write shows (or PROOF_READS run out). The proving account entry, or null. Never throws. */
async function proveWrite(orderKey, expect) {
  for (let i = 0; i < PROOF_READS; i++) {
    if (i) await new Promise((r) => setTimeout(r, PROOF_GAP_MS));
    try {
      const acct = await boundedRead(readActiveAccount(orderKey));
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

/**
 * Entry point from a ChatGPT snapshot POST response (bg/collect-chatgpt.js) for a source='auto' order.
 * The collector does not await it; the service worker is kept alive while it runs, and if the worker dies
 * anyway the order's journal entry (written with its done mark) is reported 'unknown' by the next flush.
 */
export async function handleAutoChatgptOrder(config, po, userEmail) {
  if (!po || po.source !== 'auto' || po.provider !== 'chatgpt' || !po.order_id || !po.target_org_uuid || !userEmail) {
    void flushAutoReports(config).catch(() => {});
    return;
  }
  // One claim set for both services (bg/plan-auto.js) — the journal recovery reads it. Synchronous.
  if (!claimOrder(po.order_id)) return;
  try {
    await withWorkerKeepalive(() => runAutoChatgptOrder(config, po, userEmail));
  } finally {
    releaseOrder(po.order_id);
  }
}

async function runAutoChatgptOrder(config, po, userEmail) {
  void flushAutoReports(config).catch(() => {});
  if (await isDone(po.order_id)) return;
  const installId = await getOrCreateInstallId();
  let acct;
  try {
    // The session must be the order's account right now. Another login (the member's second ChatGPT
    // account) is not a failure of the order — nothing happens, and a later POST from the right
    // session tries again before the order expires.
    if ((await boundedRead(activeUsageKey())) !== po.target_org_uuid) return noteWait(po.order_id, CG_WAIT.session);
    const data = await boundedRead(fetchChatGPTApi(CHATGPT_ACCOUNTS_CHECK_PATH));
    // An unreadable roster is a failed READ (retry later), not "the account is gone".
    if (!isObj(data?.accounts)) return noteWait(po.order_id, CG_WAIT.roster);
    acct = resolveActiveChatgptAccount(data, po.target_org_uuid);
  } catch (e) {
    console.warn(`[Claude Tuner] auto ChatGPT order #${po.order_id}: pre-check read failed, retrying later:`, e?.message);
    return noteWait(po.order_id, CG_WAIT.read);
  }
  const pre = planAutoPrecheckChatgpt(po, acct, acct ? await ourReservation(po.target_org_uuid) : null);
  let changeDate = acct?.entitlement?.renews_at || null;
  if (pre.final) {
    await beginOrder(po, userEmail, installId, pre.final, changeDate);
    void flushAutoReports(config).catch(() => {});
    await tellMember(po, pre.final, changeDate, userEmail);
    return;
  }
  // The write goes through the page only. No tab to be had (no window, or the background tab did not
  // load) = nothing done this time (no approval asked, nothing marked): a later POST tries again.
  const got = await acquireChatgptTab(po.order_id);
  if (!got.tab) {
    console.log(`[Claude Tuner] auto ChatGPT order #${po.order_id}: no chatgpt.com tab (${got.wait}) — waiting`);
    return noteWait(po.order_id, got.wait);
  }
  try {
    await runInTab(config, po, userEmail, installId, pre, got.tab, changeDate);
  } finally {
    // Only the tab this order opened — never one the member had open.
    if (got.opened) await closeOpenedTab(got.tab);
  }
}

async function runInTab(config, po, userEmail, installId, pre, tab, changeDate) {
  // The session again, as late as possible BEFORE approval: a login switch since the pre-check ends
  // nothing — this run simply stops. (After approval an 'unknown' would count toward the global API
  // kill, and a switch is no API failure.) The remaining gap is the approval round trip; the body names
  // the pre-checked account's UUID, which another session cannot change.
  let sameSession = false;
  try { sameSession = (await boundedRead(activeUsageKey())) === po.target_org_uuid; } catch { /* unread = not proven */ }
  if (!sameSession) return noteWait(po.order_id, CG_WAIT.switched);
  // 🔴 Done (and journaled) BEFORE approval (same reason as the Claude path): no storage write between
  // the approval and the call, and a worker that dies after this line never attempts the order again.
  await beginOrder(po, userEmail, installId, null, changeDate);
  if (!(await approveOrSettle(config, po, userEmail, installId))) return;
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
    } else {
      r = { result: 'unknown', outcome: AUTO_OUTCOME.unknown };
    }
  }
  // Journaled first — a failure in the bookkeeping below must not turn the result into 'unknown'.
  await reportAutoResult(config, po, r, changed);
  if (changed) {
    if (po.kind === 'cancel_downgrade') await forgetReservation(po.target_org_uuid);
    else await rememberReservation(po.target_org_uuid, po.order_id, po.to_plan);
  }
  await tellMember(po, r, changeDate, userEmail);
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
    await patchPlanAutoCard(ours.order_id, { result: 'member_changed' }, (card) => card.result === 'completed');
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
    const got = await acquireChatgptTab(null);
    if (!got.tab) return { success: false, error: 'err_chatgpt_no_tab' };
    try {
      const r = classifyChatgptWrite(await postOnceViaTab(got.tab.id, CHATGPT_RENEW_PATH, { account_id: acct.account.account_id }));
      if (r.result !== 'completed') return { success: false, error: r.outcome };
      if (!(await proveWrite(accountId, null))) return { success: false, error: AUTO_OUTCOME.unknown };
      await forgetReservation(accountId);
      return { success: true };
    } finally {
      if (got.opened) await closeOpenedTab(got.tab);
    }
  } catch (e) {
    return { success: false, error: e?.message || 'cancel failed' };
  }
}
