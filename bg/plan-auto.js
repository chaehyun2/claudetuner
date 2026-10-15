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
//      timeout — means Claude is NOT called (fail-closed). The server grants it once per order. A lost
//      answer (timeout, network, 5xx) is reported, not forgotten: the server may have approved (#2390);
//   3. call Claude ONCE over ONE transport (never the tab→cookie fallback of fetchClaudeApi, which
//      re-sends a request whose first attempt may already have gone through);
//   4. report the result with the org it changed. A report that cannot be sent is queued and retried;
//      the call itself is never retried (an order id is marked done before the call is made). The done
//      mark is written together with a journal entry (#2358): if the worker dies mid-order, the next
//      flush reports that order 'unknown' — it is never run again, and its report is never lost.
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
  executeUnconfirmed: 'execute_unconfirmed',  // #2390: the approval's answer was lost; Claude NOT called
  callTimeout: 'call_timeout',                // #2390: approved, the Claude call never answered
});

export const PLAN_AUTO_DONE_KEY = 'planAutoDone';       // { [orderId]: ts } — never act twice
export const PLAN_AUTO_REPORTS_KEY = 'planAutoReports'; // queued result reports (retried)
/** { [orderId]: { at, body, card, report? } } — the order journal (#2358). Written in the SAME storage
 *  write as the done mark, before approval is asked. `report` is set when the handler knows the result;
 *  an entry that never got one and whose handler is no longer running (the service worker died, or the
 *  handler threw) is reported as 'unknown' by the next flush — never re-executed (the done mark stays). */
export const PLAN_AUTO_JOURNAL_KEY = 'planAutoJournal';
/** What the popup card shows — ONE card per service (#2358): a Claude and a ChatGPT order around the same
 *  time must not overwrite each other's card (the earlier one's [예약 취소] would vanish). */
export const PLAN_AUTO_CARD_KEYS = Object.freeze({ claude: 'planAutoCardClaude', chatgpt: 'planAutoCardChatgpt' });
/** ≤ 1.55.18 kept a single card for both services here. Still read (for its own service, until that
 *  service writes a new card, which clears it) so a scheduled downgrade's [예약 취소] survives the update. */
export const PLAN_AUTO_LEGACY_CARD_KEY = 'planAutoCard';
/** { [orgUuid]: { order_id, plan_type, at } } — downgrades THIS browser scheduled for an auto order and
 *  has watched stay in place since. The only reservations the extension will ever cancel on its own
 *  (D7) or from the card: plan type alone cannot tell ours from one the member re-made after
 *  cancelling ours (Codex U4 ext R2), but a collection that sees ours gone deletes the entry. */
export const PLAN_AUTO_RESERVATIONS_KEY = 'planAutoReservations';
export const PLAN_AUTO_NOTIF_PREFIX = 'plan-auto-';
const MONTHLY = 'monthly';
const EXECUTE_TIMEOUT_MS = 15_000;
/** #2390: an in-page request has no deadline of its own (a frozen tab, a request claude.ai never
 *  answers) and its handler would hold the order in _inFlight — and its report back — for good. */
const MUTATE_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 30_000;
const ERR_PLAN_AUTO_TIMEOUT = 'err_plan_auto_timeout';
const REPORT_TIMEOUT_MS = 15_000;
/** One flush sends for at most this long in total (#2358): with several reports the server never answers,
 *  N × REPORT_TIMEOUT_MS would hold the queue — and anything waiting on it. The rest wait, untouched. */
const FLUSH_BUDGET_MS = 30_000;
/** MV3 ends an idle service worker after ~30 s; any extension API call resets that clock. */
const KEEPALIVE_MS = 20_000;
const DONE_KEEP_MS = 60 * 24 * 60 * 60 * 1000;          // a done id outlives any order's expiry

/** Explanation page for an order (plan §6.2). */
export function planChangeUrl(orgId, orderId) {
  return `${SITE_URL}/dashboard/team/plan-change/?org=${encodeURIComponent(orgId)}&id=${encodeURIComponent(orderId)}`;
}

const rank = (p) => PLAN_HIERARCHY.indexOf(p);

/** `promise`, or a rejection (ERR_PLAN_AUTO_TIMEOUT) after `ms`. The work itself is not cancelled — a
 *  request that times out may still land, so a timed-out WRITE is 'unknown', never 'failed'. */
export function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(ERR_PLAN_AUTO_TIMEOUT)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
/** A read (pre-check or proof; Claude or ChatGPT), bounded. A timeout throws like any failed read. */
export const boundedRead = (promise) => withDeadline(promise, READ_TIMEOUT_MS);

const PROVIDERS = Object.keys(PLAN_AUTO_CARD_KEYS);
const providerOf = (card) => (card?.provider === 'chatgpt' ? 'chatgpt' : 'claude');
/** The storage keys a card read needs (both services + the legacy single card). */
export const PLAN_AUTO_CARD_READ_KEYS = Object.freeze([...Object.values(PLAN_AUTO_CARD_KEYS), PLAN_AUTO_LEGACY_CARD_KEY]);

/**
 * Pure: { claude, chatgpt } cards from a storage read of PLAN_AUTO_CARD_READ_KEYS. A service's own key
 * wins; the legacy single card (≤ 1.55.18) fills in only for the service it names (no provider = Claude).
 */
export function pickPlanAutoCards(store) {
  const out = {};
  const legacy = store?.[PLAN_AUTO_LEGACY_CARD_KEY];
  for (const p of PROVIDERS) {
    const own = store?.[PLAN_AUTO_CARD_KEYS[p]];
    out[p] = own && own.order_id ? own : (legacy && legacy.order_id && providerOf(legacy) === p ? legacy : null);
  }
  return out;
}

export async function readPlanAutoCards() {
  return pickPlanAutoCards(await chrome.storage.local.get(PLAN_AUTO_CARD_READ_KEYS));
}

/** The card (of either service) for `orderId`, or null. Order ids are server-wide unique. */
export async function findPlanAutoCard(orderId) {
  const cards = await readPlanAutoCards();
  return PROVIDERS.map((p) => cards[p]).find((c) => c && c.order_id === orderId) || null;
}

/** Write `card` under its service's key; the legacy card is cleared in the same write once it is that
 *  service's (it would otherwise come back if the new card were ever removed). Callers hold withState:
 *  every card read-modify-write is serialised there, so a late write for an older order can never land
 *  between another order's read and write (Codex #2358 R1). */
async function writeCardLocked(card) {
  const p = providerOf(card);
  const { [PLAN_AUTO_CARD_KEYS[p]]: cur = null, [PLAN_AUTO_LEGACY_CARD_KEY]: legacy = null } =
    await chrome.storage.local.get({ [PLAN_AUTO_CARD_KEYS[p]]: null, [PLAN_AUTO_LEGACY_CARD_KEY]: null });
  // Server order ids only grow: a card for an OLDER order of this service that finishes late must not
  // replace a newer order's card (it would hide that reservation's [예약 취소]). Batch review 1.55.19.
  if (cur?.order_id != null && card.order_id != null && Number(cur.order_id) > Number(card.order_id)) return false;
  await chrome.storage.local.set({
    [PLAN_AUTO_CARD_KEYS[p]]: card,
    ...(legacy && providerOf(legacy) === p ? { [PLAN_AUTO_LEGACY_CARD_KEY]: null } : {}),
  });
  return true;
}

/** Patch the card of `orderId` (whichever service) when `cond(card)` holds. */
export function patchPlanAutoCard(orderId, patch, cond = () => true) {
  return withState(async () => {
    const card = await findPlanAutoCard(orderId);
    if (card && cond(card)) await writeCardLocked({ ...card, ...patch, at: Date.now() });
  });
}

/** Keep the service worker alive while `fn` runs (an order spans approval + write + proof reads, each
 *  network-bound with no extension API call in between). Never changes what `fn` does. */
export async function withWorkerKeepalive(fn) {
  const ping = () => { try { chrome.runtime?.getPlatformInfo?.()?.catch?.(() => {}); } catch { /* best effort */ } };
  const timer = setInterval(ping, KEEPALIVE_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

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
    await withDeadline((async () => {
      const tabs = (await chrome.tabs.query({ url: SITE_TAB_PATTERNS.claude })).filter(isUsableTab);
      if (tabs.length > 0) await fetchViaTab(tabs[0].id, url, options);
      else await fetchWithCookies(url, options);
    })(), MUTATE_TIMEOUT_MS);
    return { result: 'completed', outcome: null };
  } catch (e) {
    // Never retried: the request may still land after the deadline.
    if (e?.message === ERR_PLAN_AUTO_TIMEOUT) return { result: 'unknown', outcome: AUTO_OUTCOME.callTimeout };
    const outcome = classifyMutationError(e?.message);
    return { result: outcome === AUTO_OUTCOME.apiError ? 'failed' : 'unknown', outcome };
  }
}

// The done set, the order journal and the popup cards are read-modify-written by both services'
// handlers, which run concurrently (#2332 ChatGPT orders are not awaited by their collector), and by the
// flush. One promise chain serialises them: an interleaved write would drop the other service's done
// mark, or put an older order's card back over a newer one (#2358). withState callbacks never call
// withQueue (the queue chain may call this one) — no deadlock.
let _stateChain = Promise.resolve();
function withState(fn) {
  const p = _stateChain.then(fn, fn);
  _stateChain = p.catch(() => {});
  return p;
}
async function readState() {
  return chrome.storage.local.get({ [PLAN_AUTO_DONE_KEY]: {}, [PLAN_AUTO_JOURNAL_KEY]: {} });
}

/** Orders whose handler is running in THIS service worker, both services. Claimed synchronously (no
 *  await before the claim) so two handlers for one order can never both pass; a journal entry of an
 *  order that is not in here belongs to a handler that is gone. */
const _inFlight = new Set();
export function claimOrder(orderId) {
  if (_inFlight.has(orderId)) return false;
  _inFlight.add(orderId);
  return true;
}
export function releaseOrder(orderId) { _inFlight.delete(orderId); }

/** The fields of an order's report that do not depend on its result — fixed when the order starts, so the
 *  account a report names is the one the order ran for, whatever the browser has switched to since. */
function reportBase(po, userEmail, installId) {
  return { order_id: po.order_id, user_email: userEmail, action: 'accepted', install_id: installId };
}
function reportFields(r, changedOrgUuid) {
  return {
    result: r.result, outcome: r.outcome,
    ...(changedOrgUuid ? { changed_org_uuid: changedOrgUuid } : {}),
    ...(Array.isArray(r.diag_keys) ? { diag_keys: r.diag_keys } : {}),
  };
}

/**
 * 🔴 Mark `po` done and open its journal entry in ONE storage write — before execute approval is asked.
 * From here on the order is never attempted again by this browser (no retry of the write call), and its
 * report cannot be lost: either the handler settles the entry, or the next flush finds it orphaned and
 * reports 'unknown'. With `r`, the entry is born settled (a charge-free pre-check result).
 */
export function beginOrder(po, userEmail, installId, r = null, changeDate = null) {
  return withState(async () => {
    const { [PLAN_AUTO_DONE_KEY]: done, [PLAN_AUTO_JOURNAL_KEY]: journal } = await readState();
    const now = Date.now();
    for (const [k, ts] of Object.entries(done)) if (now - ts > DONE_KEEP_MS) delete done[k];
    done[po.order_id] = now;
    journal[po.order_id] = {
      at: now, body: reportBase(po, userEmail, installId), card: cardFor(po, null, changeDate, userEmail),
      ...(r ? { report: reportFields(r, null) } : {}),
    };
    await chrome.storage.local.set({ [PLAN_AUTO_DONE_KEY]: done, [PLAN_AUTO_JOURNAL_KEY]: journal });
  });
}

/** No execute approval: nothing ran. Un-mark it and drop its entry (one write) — a later delivery may try. */
export function abortOrder(orderId) {
  return withState(async () => {
    const { [PLAN_AUTO_DONE_KEY]: done, [PLAN_AUTO_JOURNAL_KEY]: journal } = await readState();
    delete done[orderId];
    delete journal[orderId];
    await chrome.storage.local.set({ [PLAN_AUTO_DONE_KEY]: done, [PLAN_AUTO_JOURNAL_KEY]: journal });
  });
}

/** The handler knows the result: settle the journal entry. The next flush turns it into a report. */
function settleOrder(orderId, r, changedOrgUuid) {
  return withState(async () => {
    const { [PLAN_AUTO_JOURNAL_KEY]: journal } = await readState();
    if (!journal[orderId]) return;
    journal[orderId] = { ...journal[orderId], report: reportFields(r, changedOrgUuid) };
    await chrome.storage.local.set({ [PLAN_AUTO_JOURNAL_KEY]: journal });
  });
}

export async function isDone(orderId) {
  const { [PLAN_AUTO_DONE_KEY]: done = {} } = await chrome.storage.local.get({ [PLAN_AUTO_DONE_KEY]: {} });
  return !!done[orderId];
}

/** requestExecute verdicts (#2390). Only `approved` lets Claude be called. `refused` = the server
 *  answered and did not approve (any 4xx, or a 2xx without { ok: true }). `ambiguous` = no answer we can
 *  read (timeout, network, 5xx, unparsable body): the approval may have been granted and committed. */
export const EXECUTE_VERDICT = Object.freeze({ approved: 'approved', refused: 'refused', ambiguous: 'ambiguous' });

/** Pure: an execute response → verdict. `status` 0 = no response; `body` undefined = unreadable. */
export function classifyExecuteResponse(status, body) {
  if (status >= 200 && status < 300) {
    if (body === undefined) return EXECUTE_VERDICT.ambiguous;
    return body?.ok === true ? EXECUTE_VERDICT.approved : EXECUTE_VERDICT.refused;
  }
  if (status >= 400 && status < 500) return EXECUTE_VERDICT.refused;
  return EXECUTE_VERDICT.ambiguous;
}

/** POST /plan-order-execute → EXECUTE_VERDICT. */
export async function requestExecute(config, po, userEmail, installId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EXECUTE_TIMEOUT_MS);
  try {
    // The signal only bounds the fetch; withDeadline also bounds the auth-header step before it (Codex #2390 R1).
    const res = await withDeadline(authedFetch(config, `${config.serverUrl}/api/snapshots/plan-order-execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: po.order_id, user_email: userEmail, install_id: installId }),
      signal: ctrl.signal,
    }), EXECUTE_TIMEOUT_MS);
    const status = res?.status || 0;
    const body = status >= 200 && status < 300 ? await res.json().catch(() => undefined) : null;
    return classifyExecuteResponse(status, body);
  } catch {
    return EXECUTE_VERDICT.ambiguous;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask for execute approval for an order begun with beginOrder (no result yet). true = approved: call
 * the service now, once. Otherwise the order is settled here and the caller stops:
 *   refused   → nothing ran; un-marked, so a later delivery may try (abortOrder).
 *   ambiguous → 🔴 kept done and reported failed/execute_unconfirmed (#2390 H1). The server may have
 *               moved it to 'executing', which it never delivers again — un-marking it would leave it
 *               with no report at all. Claude is still NOT called (fail-closed). A still-'delivered'
 *               order ends charge-free on that report; an 'executing' one becomes 'unknown'.
 */
export async function approveOrSettle(config, po, userEmail, installId) {
  const verdict = await requestExecute(config, po, userEmail, installId);
  if (verdict === EXECUTE_VERDICT.approved) return true;
  console.log(`[Claude Tuner] auto order #${po.order_id}: execute ${verdict} — not calling the service`);
  if (verdict === EXECUTE_VERDICT.refused) await abortOrder(po.order_id);
  else await reportAutoResult(config, po, { result: 'failed', outcome: AUTO_OUTCOME.executeUnconfirmed }, null);
  return false;
}

// The report queue is read-modify-written from several async paths (a collect cycle, the popup's
// cancel). One promise chain serialises every access so a slow flush cannot overwrite an entry that
// was added while it was sending. Order handlers never wait on it: they write the journal (withState).
let _queueChain = Promise.resolve();
function withQueue(fn) {
  const p = _queueChain.then(fn, fn);
  _queueChain = p.catch(() => {});
  return p;
}
const RESPONSE_PATH = '/api/snapshots/plan-order-response';
export const REVERT_PATH = '/api/snapshots/plan-order-revert';
/** Statuses worth resending: the server did not process it (5xx) or could not tell who we are yet
 *  (401/403, e.g. a token being refreshed), or turned it away for now (429/408). Any other 4xx is the
 *  server's final word on that report. */
const retryable = (status) => status >= 500 || status === 401 || status === 403 || status === 429 || status === 408;

/**
 * Inside withQueue: move journal entries into `queue` — settled ones as their report, orphaned ones (no
 * report, handler not running here) as 'unknown'. Decided inside the state chain, so a handler cannot
 * settle an entry between the read and the decision; the queue and the journal are written in ONE
 * storage write, so a report is never in both or in neither.
 */
async function drainJournalInto(queue) {
  await withState(async () => {
    const { [PLAN_AUTO_JOURNAL_KEY]: journal } = await readState();
    let moved = false;
    for (const [id, e] of Object.entries(journal)) {
      if (!e?.body) {
        delete journal[id];
      } else if (e.report) {
        queue.push({ tries: 0, path: RESPONSE_PATH, body: { ...e.body, ...e.report } });
        delete journal[id];
      } else if (!_inFlight.has(e.body.order_id)) {
        // 🔴 Its handler is gone after the done mark — maybe after approval, maybe mid-call. Whether the
        // write went out is unknowable, so the report says so ('unknown': the server holds the cap and
        // settles it from observations; an order it never approved answers 409 and the report ends
        // there). The done mark stays: the order is never attempted again.
        queue.push({
          tries: 0, path: RESPONSE_PATH, body: { ...e.body, result: 'unknown', outcome: AUTO_OUTCOME.unknown },
          recovered: { card: e.card || null, at: e.at || 0 },
        });
        delete journal[id];
      } else continue;
      moved = true;
    }
    if (moved) await chrome.storage.local.set({ [PLAN_AUTO_REPORTS_KEY]: queue, [PLAN_AUTO_JOURNAL_KEY]: journal });
  });
}

async function enqueue(item) {
  await withQueue(async () => {
    const { [PLAN_AUTO_REPORTS_KEY]: queue = [] } = await chrome.storage.local.get({ [PLAN_AUTO_REPORTS_KEY]: [] });
    // Settled results first: a revert queued ahead of its order's completion report would be refused.
    await drainJournalInto(queue);
    queue.push({ tries: 0, ...item });
    await chrome.storage.local.set({ [PLAN_AUTO_REPORTS_KEY]: queue });
  });
}

/** Send queued reports (results and reverts), the journal's first. Never re-runs anything on claude.ai /
 *  chatgpt.com. Sends for at most `budgetMs` in total; what is left waits, untouched, for the next flush. */
export function flushAutoReports(config, { budgetMs = FLUSH_BUDGET_MS } = {}) {
  return withQueue(async () => {
    const { [PLAN_AUTO_REPORTS_KEY]: queue = [] } = await chrome.storage.local.get({ [PLAN_AUTO_REPORTS_KEY]: [] });
    await drainJournalInto(queue);
    if (!queue.length || !config?.serverUrl) return;
    const keep = [];
    // Reports for one order go in order: once one is kept (failed), later ones for the SAME order
    // wait behind it unsent — a revert sent before its completion report would be refused (400) and
    // then dropped (Codex U4 ext R3).
    const blocked = new Set();
    const deadline = Date.now() + budgetMs;
    for (const r of queue) {
      const oid = r.body?.order_id;
      if (blocked.has(oid)) { keep.push(r); continue; }
      const left = deadline - Date.now();
      // Out of budget (#2358): kept as is — not a failed try — and its order's later reports stay behind it.
      if (left <= 0) { keep.push(r); blocked.add(oid); continue; }
      let status = 0;
      // Bounded (#2332 CWS batch review): a report the server never answers must not hold the queue.
      // A timeout is status 0 → retried.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(REPORT_TIMEOUT_MS, left));
      try {
        const res = await authedFetch(config, `${config.serverUrl}${r.path || RESPONSE_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(r.body),
          signal: ctrl.signal,
        });
        status = res?.status || 0;
      } catch { /* network / timeout: status 0 → retry */ } finally { clearTimeout(timer); }
      if (status >= 200 && status < 300) {
        if (r.path === REVERT_PATH) await patchPlanAutoCard(r.body.order_id, { result: 'reverted' });
        else if (r.recovered) await showRecoveredCard(r.recovered);
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

/** An interrupted order the server accepted as 'unknown' (it had approved it): the member sees "checking"
 *  — unless their card already shows a newer order of that service. */
function showRecoveredCard({ card, at }) {
  if (!card?.order_id) return undefined;
  return withState(async () => {
    const cur = (await readPlanAutoCards())[providerOf(card)];
    if (cur && cur.order_id !== card.order_id && (cur.at || 0) > at) return;
    await writeCardLocked({ ...card, result: 'unknown', outcome: AUTO_OUTCOME.unknown, at: Date.now() });
  });
}

/** Record the result of an order begun with beginOrder, and send it — not awaited by the order (#2358:
 *  a backlog of unsent reports must not hold the collector; the journal keeps the report until sent). */
export async function reportAutoResult(config, po, r, changedOrgUuid) {
  await settleOrder(po.order_id, r, changedOrgUuid);
  void flushAutoReports(config).catch(() => {});
}

/** The member cancelled the downgrade an auto order scheduled: tell the server (→ 'reverted', and the
 *  decision cron locks auto downgrades for 90 days). The card says "reverted" only once the server
 *  accepted it; until then it says the report is pending, and the queue keeps retrying. */
export async function reportAutoRevert(config, orderId, userEmail) {
  await patchPlanAutoCard(orderId, { result: 'revert_pending' });
  await enqueue({ path: REVERT_PATH, body: { order_id: orderId, user_email: userEmail } });
  await flushAutoReports(config);
}

/** The popup card for `po` with result `r` (null = not known yet: the journal's copy). */
function cardFor(po, r, changeDate, userEmail) {
  // ChatGPT orders are downgrades only (#2332); PLAN_HIERARCHY is Claude's and cannot rank their plans.
  const isUp = po.provider !== 'chatgpt' && po.kind !== 'cancel_downgrade' && rank(po.to_plan) > rank(po.from_plan);
  return {
    provider: po.provider || 'claude',
    order_id: po.order_id, org_id: po.org_id, kind: po.kind, from_plan: po.from_plan, to_plan: po.to_plan,
    target_org_uuid: po.target_org_uuid, result: r ? r.result : null, outcome: r ? r.outcome : null, is_up: isUp,
    change_date: changeDate || null, at: Date.now(), user_email: userEmail || null,
  };
}

export async function tellMember(po, r, changeDate, userEmail) {
  const card = cardFor(po, r, changeDate, userEmail);
  const isUp = card.is_up;
  await withState(() => writeCardLocked(card));
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
export async function ourReservation(orgUuid) {
  return (await readReservations())[orgUuid] || null;
}
export async function rememberReservation(orgUuid, orderId, planType, extra = null) {
  const m = await readReservations();
  // `extra` (#2332): a re-check stamp on an existing entry — its original `at` is kept.
  const prev = m[orgUuid];
  m[orgUuid] = { order_id: orderId, plan_type: planType, at: extra && prev?.order_id === orderId ? prev.at : Date.now(), ...(extra || {}) };
  await chrome.storage.local.set({ [PLAN_AUTO_RESERVATIONS_KEY]: m });
}
export async function forgetReservation(orgUuid) {
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
  await patchPlanAutoCard(ours.order_id, { result: 'member_changed' }, (card) => card.result === 'completed');
}

/** Entry point from the Claude snapshot POST response (bg/collect.js) for a source='auto' order. */
export async function handleAutoPlanOrder(config, po, userEmail) {
  // 🔴 Claude orders only. Another service's order (#2332, `provider` on the payload) is never run against
  // claude.ai, whatever response it arrived on — the server already delivers per provider; this is the
  // second lock.
  if (!po || po.source !== 'auto' || !po.order_id || !po.target_org_uuid || !userEmail || (po.provider && po.provider !== 'claude')) {
    void flushAutoReports(config).catch(() => {});
    return;
  }
  // Claimed synchronously, before any await, so two handlers for one order can never both pass.
  if (!claimOrder(po.order_id)) return;
  try {
    await withWorkerKeepalive(() => runAutoPlanOrder(config, po, userEmail));
  } finally {
    releaseOrder(po.order_id);
  }
}

async function runAutoPlanOrder(config, po, userEmail) {
  // Queued reports go out on their own (#2358): this order — and the collector awaiting it — never waits on them.
  void flushAutoReports(config).catch(() => {});
  if (await isDone(po.order_id)) return;
  const installId = await getOrCreateInstallId();
  // Read-only checks. Any failure to READ (network, logged out) just tries again on a later POST.
  let org, sub;
  try {
    const orgList = await boundedRead(fetchClaudeApi(CLAUDE_ORGS_PATH));
    org = Array.isArray(orgList) ? (orgList.find((o) => o.uuid === po.target_org_uuid) || null) : undefined;
    if (org === undefined) return;
    sub = org ? await boundedRead(fetchClaudeApi(`${CLAUDE_ORGS_PATH}/${org.uuid}/subscription_details`)) : null;
  } catch (e) {
    console.warn(`[Claude Tuner] auto order #${po.order_id}: pre-check read failed, retrying later:`, e?.message);
    return;
  }
  const pre = planAutoPrecheck(po, org, sub, org ? await ourReservation(org.uuid) : null);
  const changeDate = sub?.next_charge_date || null;
  if (pre.final) {
    // Done and its (charge-free) report recorded in one write.
    await beginOrder(po, userEmail, installId, pre.final, changeDate);
    void flushAutoReports(config).catch(() => {});
    await tellMember(po, pre.final, changeDate, userEmail);
    return;
  }
  // 🔴 Done (and journaled) BEFORE asking for approval, so no storage write sits between the approval
  // and the request (Codex U4 ext R1: the server's revoke cannot reach an order it has already approved,
  // so that gap is kept to the request itself). A worker that dies after this line never attempts the
  // order again; the next flush reports it 'unknown' from the journal (#2358).
  await beginOrder(po, userEmail, installId, null, changeDate);
  if (!(await approveOrSettle(config, po, userEmail, installId))) return;
  const r = await mutateOnce(pre.call);
  // The result is journaled first — a failure in the bookkeeping below must not turn it into 'unknown'.
  await reportAutoResult(config, po, r, r.result === 'completed' ? org.uuid : null);
  if (r.result === 'completed') {
    if (po.kind === 'cancel_downgrade') await forgetReservation(org.uuid);
    else if (rank(po.to_plan) < rank(po.from_plan)) await rememberReservation(org.uuid, po.order_id, PLAN_API_MAP[po.to_plan]);
  }
  await tellMember(po, r, changeDate, userEmail);
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
