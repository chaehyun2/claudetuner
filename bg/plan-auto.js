// bg/plan-auto.js — executes a source='auto' plan order (#2181 U4, plan §4 U6 · §5). BILLING PATH:
// an upgrade is charged to the member's card the moment Claude applies it.
//
// The server delivers an auto order only to an extension that declares AUTO_PATH_CAPABILITY on its
// snapshot POST, and only to the one install that wins the claim (worker services/plan-auto/exec.ts).
// This module is the client half of that contract:
//   1. re-verify on claude.ai, right before acting: the target org exists in THIS browser's org list
//      (ERR_PLAN_ORG_UNVERIFIED otherwise), the subscription is monthly (C1), no reservation sits on
//      it, the plan is still from_plan — each failure ends the order charge-free, with no Claude call;
//   2. ask the server for execute approval (POST /plan-order-execute). No approval — refusal, error,
//      timeout — means Claude is NOT called (fail-closed). The server grants it once per order;
//   3. call Claude ONCE over ONE transport (never the tab→cookie fallback of fetchClaudeApi, which
//      re-sends a request whose first attempt may already have gone through);
//   4. report the result with the org it changed. A report that cannot be sent is queued and retried;
//      the call itself is never retried (an order id is marked done before the call is made).
//
// 🔴 Auto orders live under their OWN storage keys (planAuto*). They are never written to
// `pendingPlanOrder`, which pre-auto-path code (≤ 1.55.7) reads and executes with no approval (Codex U4 R1).
// There is no manual [accept] for an auto order and no dismissRecommendationServer() call: the member
// did not dismiss anything, and a dismiss would raise their recommendation cooldown.
import { PLAN_HIERARCHY, PLAN_API_MAP, ANTHROPIC_HEADERS, SITE_URL, CLAUDE_API_BASE, SITE_TAB_PATTERNS } from './constants.js';
import { bt } from './i18n.js';
import { fetchClaudeApi, fetchViaTab, fetchWithCookies } from './api.js';
import { authedFetch, getOrCreateInstallId } from './storage.js';
import { createCountedNotification, logNotification } from './notifications.js';
import { detectPlan } from './plan-label.js';
import { CLAUDE_ORGS_PATH, isUsableTab } from '../vendor-ai/sites.js';

/** Sent as `plan_auto_exec` on Claude snapshot POSTs. Must equal AUTO_PATH_CAPABILITY in the worker. */
export const AUTO_PATH_CAPABILITY = 1;

/** Outcome codes — must match OUTCOME in worker/src/services/plan-auto/exec.ts. */
export const AUTO_OUTCOME = Object.freeze({
  alreadySatisfied: 'already_satisfied',
  alreadyScheduled: 'already_scheduled',
  changedExternally: 'changed_externally',
  notMonthly: 'not_monthly',
  intervalUnknown: 'interval_unknown',
  orgUnverified: 'org_unverified',
  reservationPresent: 'reservation_present',
  apiError: 'api_error',
  unknown: 'unknown',
});

export const PLAN_AUTO_DONE_KEY = 'planAutoDone';       // { [orderId]: ts } — never act twice
export const PLAN_AUTO_REPORTS_KEY = 'planAutoReports'; // queued result reports (retried)
export const PLAN_AUTO_CARD_KEY = 'planAutoCard';       // what the popup card shows
/** { [orgUuid]: { order_id, plan_type, at } } — downgrades THIS browser scheduled for an auto order and
 *  has watched stay in place since. The only reservations the extension will ever cancel on its own
 *  (D7) or from the card: plan type alone cannot tell ours from one the member re-made after
 *  cancelling ours (Codex U4 ext R2), but a collection that sees ours gone deletes the entry. */
export const PLAN_AUTO_RESERVATIONS_KEY = 'planAutoReservations';
export const PLAN_AUTO_NOTIF_PREFIX = 'plan-auto-';
const MONTHLY = 'monthly';
const EXECUTE_TIMEOUT_MS = 15_000;
const DONE_KEEP_MS = 60 * 24 * 60 * 60 * 1000;          // a done id outlives any order's expiry

/** Explanation page for an order (plan §6.2). */
export function planChangeUrl(orgId, orderId) {
  return `${SITE_URL}/dashboard/team/plan-change/?org=${encodeURIComponent(orgId)}&id=${encodeURIComponent(orderId)}`;
}

const rank = (p) => PLAN_HIERARCHY.indexOf(p);

/**
 * Pure: what to do given the order and what claude.ai says right now. Returns either a final
 * charge-free outcome (no Claude call) or the call to make.
 *   org:  the target org from this browser's org list (null = not here)
 *   sub:  subscription_details of that org
 */
export function planAutoPrecheck(po, org, sub, ours = null) {
  if (!org) return { final: { result: 'failed', outcome: AUTO_OUTCOME.orgUnverified } };
  // The top-level billing_interval has never been observed live (only scheduled_downgrade.billing_interval
  // has). Absent → unverified, not "annual": end charge-free WITHOUT the 90-day lock and let the next
  // decision window try again. Only an explicit value other than 'monthly' is a real not_monthly.
  if (!sub || typeof sub.billing_interval !== 'string') {
    // Diagnostic: the subscription_details top-level KEY names (never values), so the real field name
    // can be confirmed from the server's event log.
    return { final: { result: 'failed', outcome: AUTO_OUTCOME.intervalUnknown, diag_keys: subscriptionKeyNames(sub) } };
  }
  if (sub.billing_interval !== MONTHLY) return { final: { result: 'failed', outcome: AUTO_OUTCOME.notMonthly } };
  const current = detectPlan(org);
  const scheduled = sub.scheduled_downgrade || null;
  const reserved = !!(scheduled || sub.plan_ending_before || sub.payment_paused_until);
  if (po.kind === 'cancel_downgrade') {
    if (!scheduled) return { final: { result: 'completed', outcome: AUTO_OUTCOME.alreadySatisfied } };
    // Only the reservation an auto order made (server: `cancel_of_plan` = that order's to_plan). One the
    // member made themselves — e.g. after cancelling ours — is theirs and is never touched.
    if (!po.cancel_of_plan || scheduled.plan_type !== PLAN_API_MAP[po.cancel_of_plan] || !ours || ours.plan_type !== scheduled.plan_type) {
      return { final: { result: 'failed', outcome: AUTO_OUTCOME.reservationPresent } };
    }
    return { call: { path: `${CLAUDE_ORGS_PATH}/${org.uuid}/cancel_subscription_downgrade`, method: 'PUT', body: null } };
  }
  const isUp = rank(po.to_plan) > rank(po.from_plan);
  if (isUp) {
    if (rank(current) >= rank(po.to_plan)) return { final: { result: 'completed', outcome: AUTO_OUTCOME.alreadySatisfied } };
    // U6-2: an upgrade never touches a reservation — the member's, or one that appeared after the decision.
    if (reserved) return { final: { result: 'failed', outcome: AUTO_OUTCOME.reservationPresent } };
    if (current !== po.from_plan) return { final: { result: 'failed', outcome: AUTO_OUTCOME.changedExternally } };
    const tier = { 'Max 5x': '5x', 'Max 20x': '20x' }[po.to_plan];
    if (!tier) return { final: { result: 'failed', outcome: AUTO_OUTCOME.changedExternally } };
    return { call: { path: `${CLAUDE_ORGS_PATH}/${org.uuid}/upgrade_to_max`, method: 'PUT', body: { max_tier: tier } } };
  }
  if (current === po.to_plan) return { final: { result: 'completed', outcome: AUTO_OUTCOME.alreadySatisfied } };
  if (scheduled && scheduled.plan_type === PLAN_API_MAP[po.to_plan]) {
    return { final: { result: 'completed', outcome: AUTO_OUTCOME.alreadyScheduled } };
  }
  if (reserved) return { final: { result: 'failed', outcome: AUTO_OUTCOME.reservationPresent } };
  if (current !== po.from_plan) return { final: { result: 'failed', outcome: AUTO_OUTCOME.changedExternally } };
  const target = PLAN_API_MAP[po.to_plan];
  if (!target) return { final: { result: 'failed', outcome: AUTO_OUTCOME.changedExternally } };
  return { call: { path: `${CLAUDE_ORGS_PATH}/${org.uuid}/downgrade_individual_claude_subscription`, method: 'PUT', body: { target_plan_type: target } } };
}

const DIAG_KEY_RE = /^[A-Za-z0-9_]{1,64}$/;
const DIAG_KEYS_MAX = 50;
/** Pure: top-level key names of a subscription_details body — names only, no values. */
export function subscriptionKeyNames(sub) {
  if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return [];
  return Object.keys(sub).filter((k) => DIAG_KEY_RE.test(k)).slice(0, DIAG_KEYS_MAX);
}

/** Pure: a mutating call's error → 'api_error' (Claude answered and refused, or the request never
 *  left) or 'unknown' (it may have gone through: transport failure, 5xx, no result). */
export function classifyMutationError(message) {
  const m = String(message || '');
  if (/^err_http:4\d\d$/.test(m) || /^err_auth_failed:/.test(m) || m === 'err_rate_limit'
      || m === 'err_cloudflare' || m === 'err_session_expired' || m === 'err_no_cookies') return AUTO_OUTCOME.apiError;
  return AUTO_OUTCOME.unknown;
}

/** ONE request over ONE transport — no retry, no fallback. */
async function mutateOnce(call) {
  const url = `${CLAUDE_API_BASE}${call.path}`;
  const options = {
    method: call.method,
    headers: { 'Content-Type': 'application/json', ...ANTHROPIC_HEADERS },
    ...(call.body ? { body: JSON.stringify(call.body) } : {}),
  };
  try {
    const tabs = (await chrome.tabs.query({ url: SITE_TAB_PATTERNS.claude })).filter(isUsableTab);
    if (tabs.length > 0) await fetchViaTab(tabs[0].id, url, options);
    else await fetchWithCookies(url, options);
    return { result: 'completed', outcome: null };
  } catch (e) {
    const outcome = classifyMutationError(e?.message);
    return { result: outcome === AUTO_OUTCOME.apiError ? 'failed' : 'unknown', outcome };
  }
}

async function markDone(orderId) {
  const { [PLAN_AUTO_DONE_KEY]: done = {} } = await chrome.storage.local.get({ [PLAN_AUTO_DONE_KEY]: {} });
  const now = Date.now();
  for (const [k, ts] of Object.entries(done)) if (now - ts > DONE_KEEP_MS) delete done[k];
  done[orderId] = now;
  await chrome.storage.local.set({ [PLAN_AUTO_DONE_KEY]: done });
}

async function unmarkDone(orderId) {
  const { [PLAN_AUTO_DONE_KEY]: done = {} } = await chrome.storage.local.get({ [PLAN_AUTO_DONE_KEY]: {} });
  delete done[orderId];
  await chrome.storage.local.set({ [PLAN_AUTO_DONE_KEY]: done });
}

async function isDone(orderId) {
  const { [PLAN_AUTO_DONE_KEY]: done = {} } = await chrome.storage.local.get({ [PLAN_AUTO_DONE_KEY]: {} });
  return !!done[orderId];
}

/** POST /plan-order-execute. true only on an explicit { ok: true }. */
async function requestExecute(config, po, userEmail, installId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EXECUTE_TIMEOUT_MS);
  try {
    const res = await authedFetch(config, `${config.serverUrl}/api/snapshots/plan-order-execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: po.order_id, user_email: userEmail, install_id: installId }),
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// The report queue is read-modify-written from several async paths (a collect cycle, the popup's
// cancel). One promise chain serialises every access so a slow flush cannot overwrite an entry that
// was added while it was sending.
let _queueChain = Promise.resolve();
function withQueue(fn) {
  const p = _queueChain.then(fn, fn);
  _queueChain = p.catch(() => {});
  return p;
}
const RESPONSE_PATH = '/api/snapshots/plan-order-response';
export const REVERT_PATH = '/api/snapshots/plan-order-revert';
/** Statuses worth resending: the server did not process it (5xx) or could not tell who we are yet
 *  (401/403, e.g. a token being refreshed). Any other 4xx is the server's final word on that report. */
const retryable = (status) => status >= 500 || status === 401 || status === 403;

async function enqueue(item) {
  await withQueue(async () => {
    const { [PLAN_AUTO_REPORTS_KEY]: queue = [] } = await chrome.storage.local.get({ [PLAN_AUTO_REPORTS_KEY]: [] });
    queue.push({ tries: 0, ...item });
    await chrome.storage.local.set({ [PLAN_AUTO_REPORTS_KEY]: queue });
  });
}

/** Send queued reports (results and reverts). Never re-runs anything on claude.ai. */
export function flushAutoReports(config) {
  return withQueue(async () => {
    const { [PLAN_AUTO_REPORTS_KEY]: queue = [] } = await chrome.storage.local.get({ [PLAN_AUTO_REPORTS_KEY]: [] });
    if (!queue.length || !config?.serverUrl) return;
    const keep = [];
    // Reports for one order go in order: once one is kept (failed), later ones for the SAME order
    // wait behind it unsent — a revert sent before its completion report would be refused (400) and
    // then dropped (Codex U4 ext R3).
    const blocked = new Set();
    for (const r of queue) {
      const oid = r.body?.order_id;
      if (blocked.has(oid)) { keep.push(r); continue; }
      let status = 0;
      try {
        const res = await authedFetch(config, `${config.serverUrl}${r.path || RESPONSE_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(r.body),
        });
        status = res.status;
      } catch { /* network: status 0 → retry */ }
      if (status >= 200 && status < 300) {
        if (r.path === REVERT_PATH) await markCardReverted(r.body.order_id);
        continue;
      }
      // Never dropped while the server could still take it: a lost completion report would also strand
      // the revert queued behind it, and a revert has no other way to reach the server (its 90-day lock
      // depends on it). The queue only holds reports of orders this browser handled, so it stays small.
      if (status === 0 || retryable(status)) {
        keep.push({ ...r, tries: (r.tries || 0) + 1 });
        blocked.add(oid);
      }
    }
    await chrome.storage.local.set({ [PLAN_AUTO_REPORTS_KEY]: keep });
  });
}

async function markCardReverted(orderId) {
  const { [PLAN_AUTO_CARD_KEY]: card = null } = await chrome.storage.local.get({ [PLAN_AUTO_CARD_KEY]: null });
  if (card && card.order_id === orderId) await chrome.storage.local.set({ [PLAN_AUTO_CARD_KEY]: { ...card, result: 'reverted', at: Date.now() } });
}

async function report(config, po, userEmail, installId, r, changedOrgUuid) {
  const body = {
    order_id: po.order_id, user_email: userEmail, action: 'accepted',
    result: r.result, outcome: r.outcome, install_id: installId,
    ...(changedOrgUuid ? { changed_org_uuid: changedOrgUuid } : {}),
    ...(Array.isArray(r.diag_keys) ? { diag_keys: r.diag_keys } : {}),
  };
  await enqueue({ path: RESPONSE_PATH, body });
  await flushAutoReports(config);
}

/** The member cancelled the downgrade an auto order scheduled: tell the server (→ 'reverted', and the
 *  decision cron locks auto downgrades for 90 days). The card says "reverted" only once the server
 *  accepted it; until then it says the report is pending, and the queue keeps retrying. */
export async function reportAutoRevert(config, orderId, userEmail) {
  const { [PLAN_AUTO_CARD_KEY]: card = null } = await chrome.storage.local.get({ [PLAN_AUTO_CARD_KEY]: null });
  if (card && card.order_id === orderId) await chrome.storage.local.set({ [PLAN_AUTO_CARD_KEY]: { ...card, result: 'revert_pending', at: Date.now() } });
  await enqueue({ path: REVERT_PATH, body: { order_id: orderId, user_email: userEmail } });
  await flushAutoReports(config);
}

async function tellMember(po, r, changeDate, userEmail) {
  const isUp = po.kind !== 'cancel_downgrade' && rank(po.to_plan) > rank(po.from_plan);
  const card = {
    order_id: po.order_id, org_id: po.org_id, kind: po.kind, from_plan: po.from_plan, to_plan: po.to_plan,
    target_org_uuid: po.target_org_uuid, result: r.result, outcome: r.outcome, is_up: isUp,
    change_date: changeDate || null, at: Date.now(), user_email: userEmail || null,
  };
  await chrome.storage.local.set({ [PLAN_AUTO_CARD_KEY]: card });
  // Only real changes and real failures interrupt the member; a charge-free premise skip does not.
  let title = null, message = null;
  if (r.result === 'completed' && !r.outcome) {
    if (po.kind === 'cancel_downgrade') {
      title = await bt('pa_cancel_down_title'); message = await bt('pa_cancel_down_msg', po.from_plan);
    } else if (isUp) {
      title = await bt('pa_done_up_title'); message = await bt('pa_done_up_msg', po.from_plan, po.to_plan);
    } else {
      title = await bt('pa_done_down_title');
      message = await bt('pa_done_down_msg', po.from_plan, po.to_plan, changeDate ? new Date(changeDate).toLocaleDateString() : '—');
    }
  } else if (r.result === 'failed' && r.outcome === AUTO_OUTCOME.apiError) {
    title = await bt('pa_fail_title'); message = await bt('pa_fail_msg', po.from_plan, po.to_plan);
  } else if (r.result === 'unknown') {
    // The call may have gone through: say so instead of "failed" — the cron settles it from the plan.
    title = await bt('pa_unknown_title'); message = await bt('pa_unknown_msg', po.from_plan, po.to_plan);
  }
  if (!title) return;
  createCountedNotification(`plan-auto-${po.order_id}`, {  // = PLAN_AUTO_NOTIF_PREFIX; literal so the telemetry guard sees it
    type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 2,
  }, 'plan-auto');
  logNotification('plan-auto');
}

async function readReservations() {
  const { [PLAN_AUTO_RESERVATIONS_KEY]: m = {} } = await chrome.storage.local.get({ [PLAN_AUTO_RESERVATIONS_KEY]: {} });
  return m;
}
async function ourReservation(orgUuid) {
  return (await readReservations())[orgUuid] || null;
}
async function rememberReservation(orgUuid, orderId, planType) {
  const m = await readReservations();
  m[orgUuid] = { order_id: orderId, plan_type: planType, at: Date.now() };
  await chrome.storage.local.set({ [PLAN_AUTO_RESERVATIONS_KEY]: m });
}
async function forgetReservation(orgUuid) {
  const m = await readReservations();
  if (!(orgUuid in m)) return;
  delete m[orgUuid];
  await chrome.storage.local.set({ [PLAN_AUTO_RESERVATIONS_KEY]: m });
}

/**
 * Called by the collector after a SUCCESSFUL subscription_details read of `orgUuid` (bg/collect.js;
 * `info` = fetchSubscriptionInfo's result). If the downgrade we scheduled there is no longer what is
 * scheduled — the member cancelled it, or replaced it — it stops being ours for good, even if the
 * member later schedules the very same plan again. The card for it is retired too.
 */
export async function noteSubscriptionObservation(orgUuid, info) {
  if (!orgUuid || !info || !('status' in info)) return;  // the read failed: no evidence either way
  const ours = await ourReservation(orgUuid);
  if (!ours || info.pending_plan === ours.plan_type) return;
  await forgetReservation(orgUuid);
  const { [PLAN_AUTO_CARD_KEY]: card = null } = await chrome.storage.local.get({ [PLAN_AUTO_CARD_KEY]: null });
  if (card && card.order_id === ours.order_id && card.result === 'completed') {
    await chrome.storage.local.set({ [PLAN_AUTO_CARD_KEY]: { ...card, result: 'member_changed', at: Date.now() } });
  }
}

const _inFlight = new Set();

/** Entry point from the Claude snapshot POST response (bg/collect.js) for a source='auto' order. */
export async function handleAutoPlanOrder(config, po, userEmail) {
  if (!po || po.source !== 'auto' || !po.order_id || !po.target_org_uuid || !userEmail) {
    await flushAutoReports(config).catch(() => {});
    return;
  }
  // Claimed synchronously, before any await, so two handlers for one order can never both pass.
  if (_inFlight.has(po.order_id)) return;
  _inFlight.add(po.order_id);
  try {
    await flushAutoReports(config).catch(() => {});
    if (await isDone(po.order_id)) return;
    const installId = await getOrCreateInstallId();
    // Read-only checks. Any failure to READ (network, logged out) just tries again on a later POST.
    let org, sub;
    try {
      const orgList = await fetchClaudeApi(CLAUDE_ORGS_PATH);
      org = Array.isArray(orgList) ? (orgList.find((o) => o.uuid === po.target_org_uuid) || null) : undefined;
      if (org === undefined) return;
      sub = org ? await fetchClaudeApi(`${CLAUDE_ORGS_PATH}/${org.uuid}/subscription_details`) : null;
    } catch (e) {
      console.warn(`[Claude Tuner] auto order #${po.order_id}: pre-check read failed, retrying later:`, e?.message);
      return;
    }
    const pre = planAutoPrecheck(po, org, sub, org ? await ourReservation(org.uuid) : null);
    const changeDate = sub?.next_charge_date || null;
    if (pre.final) {
      await markDone(po.order_id);
      await report(config, po, userEmail, installId, pre.final, null);
      await tellMember(po, pre.final, changeDate, userEmail);
      return;
    }
    // 🔴 Done BEFORE asking for approval, so no storage write sits between the approval and the
    // request (Codex U4 ext R1: the server's revoke cannot reach an order it has already approved, so
    // that gap is kept to the request itself). A worker that dies after this line never attempts the
    // order again; the server settles it from observations.
    await markDone(po.order_id);
    if (!(await requestExecute(config, po, userEmail, installId))) {
      console.log(`[Claude Tuner] auto order #${po.order_id}: no execute approval — not calling Claude`);
      await unmarkDone(po.order_id);  // nothing ran: a later delivery may try again
      return;
    }
    const r = await mutateOnce(pre.call);
    if (r.result === 'completed') {
      if (po.kind === 'cancel_downgrade') await forgetReservation(org.uuid);
      else if (rank(po.to_plan) < rank(po.from_plan)) await rememberReservation(org.uuid, po.order_id, PLAN_API_MAP[po.to_plan]);
    }
    await report(config, po, userEmail, installId, r, r.result === 'completed' ? org.uuid : null);
    await tellMember(po, r, changeDate, userEmail);
  } finally {
    _inFlight.delete(po.order_id);
  }
}

/** [예약 취소] for a downgrade an auto order scheduled: on the order's org (not whatever the popup
 *  shows), only if the downgrade scheduled there is still the one the order made. Free on Claude's side. */
export async function cancelAutoDowngrade(orgUuid, scheduledPlan) {
  try {
    const orgList = await fetchClaudeApi(CLAUDE_ORGS_PATH);
    const org = Array.isArray(orgList) ? orgList.find((o) => o.uuid === orgUuid) : null;
    if (!org) return { success: false, error: 'err_plan_org_unverified' };
    const sub = await fetchClaudeApi(`${CLAUDE_ORGS_PATH}/${org.uuid}/subscription_details`);
    if (!sub?.scheduled_downgrade) return { success: false, error: 'No scheduled downgrade found' };
    // Only the downgrade the auto order scheduled — not one the member set up since (Codex U4 ext R1).
    const ours = await ourReservation(org.uuid);
    if (sub.scheduled_downgrade.plan_type !== PLAN_API_MAP[scheduledPlan] || !ours || ours.plan_type !== sub.scheduled_downgrade.plan_type) {
      return { success: false, error: 'No scheduled downgrade found' };
    }
    const r = await mutateOnce({ path: `${CLAUDE_ORGS_PATH}/${org.uuid}/cancel_subscription_downgrade`, method: 'PUT', body: null });
    if (r.result === 'completed') await forgetReservation(org.uuid);
    return r.result === 'completed' ? { success: true } : { success: false, error: r.outcome };
  } catch (e) {
    return { success: false, error: e?.message || 'cancel failed' };
  }
}
