import { sendGAEvent } from './analytics.js';
import {
  ALARM_NAME, DEFAULT_INTERVAL_MINUTES, FREE_PLAN_INTERVAL_MINUTES,
  HEARTBEAT_TIMEOUT_MS, SEAT_TIER_MAP, NON_PERSONAL_PLANS,
  ORG_POLL_TIERS, ORG_POLL_TIER_ORDER,
  DEFAULT_SERVER_URL,
} from './constants.js';
import { hasOrgUsageChanged, shouldSendSnapshot, noteServerFailure, noteServerSuccess, isServerBackedOff } from './send-gate.js';
import { noteUpgradeRequired, isUpgradePostSuppressed, clearUpgradeBlocked } from './upgrade-gate.js';
import { getCadence, isCollectionPaused, applyServerCadence, pruneStreamCadence } from './cadence-config.js';
import { applyPinMoveTitle } from './badge.js';
import { bgLang, bt } from './i18n.js';
import { fetchClaudeApi, fetchWithCookies, normalizeResetTime } from './api.js';
import { updateBadge, updateBadgeForSelectedOrg, getSelectedOrgUsage, updateBadgeError, refreshRecNotice } from './badge.js';
import { checkCollectFailNotification, checkUsageAlerts, checkPromoPush, logNotification, createCountedNotification } from './notifications.js';
import {
  detectPlan, refineTeamPlan, fetchSubscriptionInfo,
  acceptPlanOrder, reportPlanOrderResult,
} from './plan.js';
import { upsertClaudeOrg } from './org-merge.js';
import { noteProviderSuccess, reportClaudeCollectFail } from './provider-state.js';
import { getRecDismiss, recDismissActive } from './rec-dismiss.js';
import { isHeartbeatDue, nextHeartbeatRetry, HEARTBEAT_RETRY_KEY } from './heartbeat.js';
import { getConfig, setStatus, getLastStatus, appendUsageHistory, authedFetch, simplePost, simpleAuthedPost, setExtToken, setExtTokenNoDowngrade, clearExtTokenIfMatches, getOrCreateInstallId, serverSyncWithheldReason, isServerSyncPaused, noteAuthBlocked, clearAuthBlocked, isAuthBlockSuppressed, noteTokenWithheld, resolveIngestIdentity, readLinkedCanonical } from './storage.js';
// #1122 — install-beacon imports only from storage.js, so this does not close an import cycle.
import { maybeSendFirstGatedBeacon } from './install-beacon.js';

// One-time server-side upgrade of an email (independent) account to a Claude
// account, once Claude collection is confirmed working via a valid ext_token.
//
// An account created by magic-link login has auth_provider='email'. Email accounts
// are barred from the shared-API_KEY fallback (impersonation guard), so when their
// ext_token expires the extension can no longer authenticate and Claude collection
// dies silently with no recovery path. This helper is called ONLY after a Claude
// snapshot POST was accepted by the server (proof this account really is collecting
// Claude), so we flip it to 'claude' via /api/auth/link-claude — the Bearer token
// proves control of the account identity — and the API_KEY fallback then works so
// collection survives future token expiry.
//
// Precise + cheap: only fires when (a) auth was via ext_token (Bearer, not API_KEY),
// AND (b) this install carries an `independentAccount` (email login). Normal Claude
// accounts have no `independentAccount`, so they never call it. Runs at most once
// per install (claudeLinkDone guard). Off the ingest hot path; best-effort.
async function maybeLinkClaudeAccount(config, sentToken) {
  if (!sentToken || !config.serverUrl) return; // Bearer (ext_token) auth only
  const { independentAccount = null, claudeLinkDone = false } =
    await chrome.storage.local.get({ independentAccount: null, claudeLinkDone: false });
  if (!independentAccount?.email || claudeLinkDone) return;
  try {
    const res = await fetch(`${config.serverUrl}/api/auth/link-claude`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sentToken}` },
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.ok) {
      // One-time reconcile: never call again. Keep `independentAccount` intact —
      // the ChatGPT/Gemini collectors still read it as a server-email fallback
      // (collect-chatgpt.js / collect-gemini.js), so removing it would fragment
      // this user's multi-provider collection.
      await chrome.storage.local.set({ claudeLinkDone: true });
      console.log('[Claude Tuner] Email account linked to Claude — survives token expiry.');
    }
  } catch (e) {
    // Best-effort — retried on the next successful Bearer collection cycle.
  }
}

// Canonical plan label (accepts server labels or personal api-ids) → known label, or null
// when absent/unrecognized so the stale-rec guard fires only on a confident mismatch.
const _PLAN_CANON = { pro_monthly: 'Pro', max_5x_monthly: 'Max 5x', max_20x_monthly: 'Max 20x' };
const _KNOWN_PLANS = ['Free', 'Pro', 'Team Standard', 'Team Premium', 'Max 5x', 'Max 20x', 'Enterprise'];
function _canonPlanBg(p) {
  if (p == null) return null;
  const v = _PLAN_CANON[p] || p;
  return _KNOWN_PLANS.includes(v) ? v : null;
}
// True when an actionable (upgrade/downgrade) rec's basis plan no longer matches the current
// plan (both resolve to known labels and differ) — i.e. a stale rec cached before a plan change.
// Such recs must not be saved/badged/shown (e.g. cached "Pro→Max 5x upgrade" after Pro→Max 20x).
function _recPlanStale(rec, planVal) {
  if (!rec || (rec.type !== 'upgrade' && rec.type !== 'downgrade')) return false;
  const from = _canonPlanBg(rec.from_plan || rec.fromPlan);
  const cur = _canonPlanBg(planVal);
  return from != null && cur != null && from !== cur;
}

// === Adaptive Polling helpers ===
export function getOrgPollDefault() {
  // lastValues/lastPollAt drive the adaptive tier (updated every poll).
  // lastSentValues/lastSentAt drive the send-gate (updated only when we POST) —
  // kept separate because "changed since last poll" (tier) and "changed since
  // last sent" (gate) are different questions. Primary reuses lastValues/
  // lastPollAt since its updateOrgPollState only runs when it sends.
  return { tier: 'active', unchangedCount: 0, lastValues: { h5: null, d7: null, extraUsed: null, resetsAt5h: null, resetsAt7d: null }, lastPollAt: 0, lastSentValues: null, lastSentAt: 0 };
}

/** Check if an org is due for polling based on its adaptive tier */
export function isOrgDueForPoll(state, now, baseIntervalMs) {
  const tierInfo = ORG_POLL_TIERS[state.tier] || ORG_POLL_TIERS.active;
  const effectiveInterval = tierInfo.intervalMs || baseIntervalMs;
  return (now - state.lastPollAt) >= effectiveInterval * 0.9;
}

/** Update org poll state after a poll. Returns the updated state object */
export function updateOrgPollState(state, currentValues, changed) {
  if (changed) {
    return { ...state, tier: 'active', unchangedCount: 0, lastValues: currentValues, lastPollAt: Date.now() };
  }
  // Zombie org: no active 5h window (h5=0/null, r5=null) → fast-track to dormant
  const isZombie = (currentValues.h5 == null || currentValues.h5 === 0) && !currentValues.resetsAt5h;
  if (isZombie && state.tier !== 'dormant') {
    console.log(`[Claude Tuner] Org poll zombie detected (h5=0, r5=null): ${state.tier} → dormant`);
    return { ...state, tier: 'dormant', unchangedCount: 0, lastValues: currentValues, lastPollAt: Date.now() };
  }
  const newCount = state.unchangedCount + 1;
  const tierInfo = ORG_POLL_TIERS[state.tier];
  const tierIdx = ORG_POLL_TIER_ORDER.indexOf(state.tier);
  if (newCount >= tierInfo.promoteAfter && tierIdx < ORG_POLL_TIER_ORDER.length - 1) {
    const nextTier = ORG_POLL_TIER_ORDER[tierIdx + 1];
    console.log(`[Claude Tuner] Org poll tier promoted: ${state.tier} → ${nextTier}`);
    return { ...state, tier: nextTier, unchangedCount: 0, lastValues: currentValues, lastPollAt: Date.now() };
  }
  return { ...state, unchangedCount: newCount, lastValues: currentValues, lastPollAt: Date.now() };
}

/** Normalize raw extra_usage API response into a consistent shape */
function normalizeExtraUsage(raw) {
  if (!raw) return null;
  return {
    is_enabled: raw.is_enabled || false,
    monthly_limit: raw.monthly_limit ?? null,
    used_credits: raw.used_credits ?? null,
    utilization: raw.utilization ?? null,
  };
}

/** Parse grove_enabled from API response text via regex */
function parseGroveFromText(text) {
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  const m = str.match(/"grove_enabled"\s*:\s*(true|false|null)/);
  if (!m) return null;
  return m[1] === 'true' ? true : m[1] === 'false' ? false : null;
}

/** Save grove detection result to local cache */
function saveGroveCache(value, detected) {
  chrome.storage.local.set({ groveCache: { value, detected, ts: Date.now() } });
}

/** Build a history point from a snapshot for appendUsageHistory */
function buildHistoryPoint(snapshot, plan) {
  return {
    t: Date.now(),
    h5: snapshot.five_hour?.utilization ?? null,
    d7: snapshot.seven_day?.utilization ?? null,
    p: plan,
    // 🔴 r5 IS NOT OPTIONAL METADATA — it is the 5h window's identity, and the shared flat
    // projection (ui/usage-tiers.js projectFlatWindow) reads it to tell "this window reset" from
    // "usage fell". Without it that function falls back to positive-delta-only, which cannot see
    // a reset the value rose across: 49% -> reset -> 50% reads as +1 while the new cycle is
    // already at 50. Claude was the ONLY producer omitting it — the dashboard passes it from
    // snapshot rows, the widget Worker passes it, and the ChatGPT/Gemini history writers in
    // background.js pass it — so the popup was the one surface answering differently for the same
    // account (measured: 61.3 vs 112.9 on identical input, #1032).
    //
    // Safe to switch on: over 7 days of live snapshots the reset id moved WITHOUT a real reset in
    // 54 of ~46,000 transitions (0.1%); 4-5.5h and >5.5h shifts account for the rest. The
    // "utilization did not drop" cases the boundary rule now counts in full are genuine
    // post-reset accumulation, which is exactly what the drop heuristic could not see.
    r5: snapshot.five_hour?.resets_at || null,
    r7: snapshot.seven_day?.resets_at || null,
    org: snapshot.claude_org_uuid || null,
    eu: snapshot.extra_usage?.used_credits ?? null,
    el: snapshot.extra_usage?.monthly_limit ?? null,
  };
}

/**
 * Resolve the two model-scoped weekly slots from the usage response.
 *
 * Anthropic moved the per-model weekly limit out of the top-level
 * `seven_day_<model>` fields (now null) into the generic `limits[]` array:
 * entries with `kind === 'weekly_scoped'` carry `scope.model.display_name`
 * (e.g. "Fable") and a 0-100 `percent` on the same scale as the old
 * `.utilization`. We map each scoped entry into the two legacy numeric slots
 * (omelette / sonnet) so the entire server + chart pipeline keeps working
 * unchanged. The `model` sub-field is transient metadata: the server's epoch
 * observer reads it to label the slot; snapshot storage ignores it.
 *
 * Slot assignment is deterministic (sorted by model name) so a given model keeps
 * a stable slot — a single active scoped model always lands in the omelette slot.
 * Falls back to the legacy top-level fields when `limits[]` is absent/empty
 * (older API shape or a slot with no active scoped model).
 */
function resolveScopedWeeklySlots(usageData) {
  const scoped = Array.isArray(usageData.limits)
    ? usageData.limits
        .filter((l) => l && l.kind === 'weekly_scoped' && l.scope?.model?.display_name)
        .map((l) => ({
          model: l.scope.model.display_name,
          utilization: l.percent ?? null,
          resets_at: l.resets_at ?? null,
        }))
        // Locale-independent (code-unit) order so slot assignment is deterministic
        // across browser locales — localeCompare could otherwise order two model names
        // differently per user and swap their slots.
        .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
    : [];

  const slotFrom = (entry, legacy) => entry
    ? {
        utilization: entry.utilization,
        resets_at: normalizeResetTime(entry.resets_at),
        model: entry.model,
      }
    : {
        utilization: legacy?.utilization ?? null,
        resets_at: normalizeResetTime(legacy?.resets_at),
        model: null,
      };

  return {
    omelette: slotFrom(scoped[0], usageData.seven_day_omelette),
    sonnet: slotFrom(scoped[1], usageData.seven_day_sonnet),
  };
}

/** Build common usage window fields shared by primary & extra org snapshots */
async function buildUsageFields(usageData, config) {
  const scopedSlots = resolveScopedWeeklySlots(usageData);
  return {
    five_hour: {
      utilization: usageData.five_hour?.utilization ?? null,
      resets_at: normalizeResetTime(usageData.five_hour?.resets_at),
    },
    seven_day: {
      utilization: usageData.seven_day?.utilization ?? null,
      resets_at: normalizeResetTime(usageData.seven_day?.resets_at),
    },
    seven_day_omelette: scopedSlots.omelette,
    seven_day_sonnet: scopedSlots.sonnet,
    extra_usage: normalizeExtraUsage(usageData.extra_usage),
    user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    user_language: await bgLang(),
    poll_interval: config.intervalMinutes || DEFAULT_INTERVAL_MINUTES,
    poll_interval_explicit: !!config.intervalExplicitlySet,
  };
}

/** Sync notification permission to server (fire-and-forget, on change only) */
function syncNotificationPermission(config, userEmail) {
  chrome.notifications.getPermissionLevel((level) => {
    const blocked = level === 'denied';
    chrome.storage.local.get({ _lastNotifBlocked: null }, (r) => {
      if (r._lastNotifBlocked === blocked) return; // no change
      chrome.storage.local.set({ _lastNotifBlocked: blocked });

      const payload = { user_email: userEmail, notifications_blocked: blocked };

      // When newly blocked, include notification stats for analysis
      if (blocked) {
        chrome.storage.local.get({ _notifLog: [] }, ({ _notifLog }) => {
          if (_notifLog.length > 0) {
            const now = Date.now();
            const d7 = now - 7 * 24 * 60 * 60 * 1000;
            const recent = _notifLog.filter(e => e.ts > d7);
            // Per-category counts (last 7 days)
            const counts = {};
            for (const e of recent) counts[e.c] = (counts[e.c] || 0) + 1;
            // Last notification before block
            const last = _notifLog[_notifLog.length - 1];
            // Days with at least one notification (for daily avg)
            const days = new Set(recent.map(e => new Date(e.ts).toDateString())).size || 1;
            payload.notification_stats = JSON.stringify({
              last_category: last.c,
              last_ts: last.ts,
              seven_day_counts: counts,
              seven_day_total: recent.length,
              daily_avg: +(recent.length / days).toFixed(1),
            });
          }
          authedFetch(config, `${config.serverUrl}/api/users/preferences`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(() => {});
        });
      } else {
        authedFetch(config, `${config.serverUrl}/api/users/preferences`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      }
    });
  });
}

/** Sync notification toggle preferences to server (fire-and-forget, on change only) */
function syncNotificationPrefs(config, userEmail) {
  const defaults = {
    notifyUsageWarn: false, notifyUsageDanger: true,
    notifyResetSoon: true, notifyResetDone: true,
    notifyWeeklyReport: true, notifyCollectFail: true, notifyPlanChange: true,
  };
  chrome.storage.sync.get(defaults, (prefs) => {
    const json = JSON.stringify(prefs);
    chrome.storage.local.get({ _lastNotifPrefs: null }, (r) => {
      if (r._lastNotifPrefs === json) return; // no change
      chrome.storage.local.set({ _lastNotifPrefs: json });
      authedFetch(config, `${config.serverUrl}/api/users/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: userEmail, notification_prefs: json }),
      }).catch(() => {});
    });
  });
}



// === Org detection based on lastActiveOrg cookie ===

/**
 * Record that Claude collected, and WHICH account it collected (#1038).
 *
 * 🔴 `account` IS THE CLAUDE PROVIDER ADDRESS THIS CYCLE OBSERVED, NOT A RE-READ OF `accountCache`
 * AND NOT `userEmail`.
 * The first cut re-read the cache here, which looks equivalent and is not: the cache is only
 * refreshed when the ORG-DERIVED address changes, so two accounts inside one org keep the first
 * one for up to 8 hours — and re-stamping it on every successful collect would have laundered that
 * stale value into a permanently "fresh" label, i.e. this change would have made the staleness it
 * exists to remove unexpirable (Codex round 1). The second cut passed `userEmail`, which is worse
 * still: it is REASSIGNED to the ingest identity before these call sites, so the popup would have
 * disclosed the user's own login account as the thing being collected (Codex round 2).
 * `claudeProviderEmail` is set only where the Claude account itself is determined.
 *
 * 'unknown' is the collector's own sentinel for "could not determine" and must not be disclosed —
 * it becomes null, and bg/provider-state.js then omits the provider rather than naming nothing.
 *
 * 🔴 SUCCESS ONLY, NEVER AN ERROR. bg/provider-state.js is explicit that Claude failures must not
 * live in that store: ui/render.js demotes a Claude error when another provider is healthy, and a
 * Claude entry in the shared error slot would let that branch use the failing provider as evidence
 * of health. This writes `lastSuccessAt`/`account` and nothing else.
 */
async function noteClaudeCollected(account) {
  try {
    // 🔴 `undefined`, NOT `null`, when this cycle observed nothing: null ERASES a label that is
    // still within its own TTL, and "we did not look" is not "there is no account".
    const observed = account && account !== 'unknown' ? account : undefined;
    await noteProviderSuccess('claude', observed);
  } catch (_) { /* disclosure bookkeeping must never fail a collection */ }
}

export async function getLastActiveOrgId() {
  try {
    const cookie = await chrome.cookies.get({ name: 'lastActiveOrg', url: 'https://claude.ai' });
    return cookie?.value || null;
  } catch (e) {
    console.warn('[Claude Tuner] lastActiveOrg cookie read failed:', e.message);
    return null;
  }
}

// === Core Collection Engine ===
// Serialize all Claude collection runs. Multiple call sites (alarm, tab-collect,
// 429 force, popup/manual) can fire concurrently; each loads orgPollState at the
// start and writes the whole object at the end, so overlapping runs would
// last-writer-wins and lose each other's per-org state. Chain runs so they never
// overlap. Each caller still gets its OWN run's result; a throw doesn't break the
// chain (next run proceeds either way).
let _collectChain = Promise.resolve();
// ── POST /api/heartbeat — ONE sender, two callers (#1119) ─────────────────────────────────────
//
// Extracted rather than copied: the failure-path heartbeat and the pause/resume edge report build
// the same body against the same endpoint, and a second hand-maintained copy is precisely how the
// three `authedFetch` variants drifted (#745). The body is the contract the server reads
// (index.ts POST /api/heartbeat), so it has exactly one construction site.
//
// 🔴 `sync_paused` IS ALWAYS SENT, on every heartbeat, and that is the safety property the server
// migration leans on. The server writes `sync_paused = COALESCE(?, sync_paused)`, so each heartbeat
// overwrites the stored flag with the client's LIVE state. Since the reminder crons all require a
// recent `last_heartbeat_at`, and this is the only request that writes it, an account can only be
// reminded if it heartbeated recently — i.e. the flag the crons read is never older than the last
// heartbeat. A resumed install therefore cannot be silenced: the failure that would trigger the
// reminder is what produces the heartbeat that clears the flag.
//
// Returns true only on a 2xx. Never throws.
// `error_code` of the pause/resume edge report. 🔴 SHARED CONTRACT WITH THE WORKER
// (index.ts SYNC_PAUSE_HEARTBEAT_CODE): the server excludes a heartbeat carrying this code from
// the 6h "연결이 끊겼습니다" decision, because this request is a STATE NOTIFICATION and says
// nothing about whether collection works. Changing it on one side only re-opens the mail.
const SYNC_PAUSE_HEARTBEAT_CODE = 'sync_pause_change';

async function postHeartbeat(cfg, { email, errorCode, extVersion, syncPaused }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HEARTBEAT_TIMEOUT_MS);
  try {
    const resp = await authedFetch(cfg, `${cfg.serverUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, error_code: errorCode, ext_version: extVersion, sync_paused: syncPaused }),
      signal: ac.signal,
    });
    return !!resp?.ok;
  } catch (_) {
    // Network error / abort — false, which is what the caller's backoff is for.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tell the server the user just paused or resumed server sync (#1119).
 *
 * WHY AN EDGE REPORT AT ALL, given every heartbeat already carries the flag: the heartbeat only
 * fires from the FAILURE path of collectAndSend, so a paused install that keeps collecting fine
 * would never report the pause. That is mostly harmless — no heartbeat also means the reminder
 * crons cannot see it — but it leaves one real hole: an install that pauses shortly after a run of
 * collection failures still has a fresh `last_heartbeat_at` and a stale `sync_paused = 0`, and can
 * be reminded before its next failure would have set the flag. This closes it.
 *
 * 🔴 SAME SEND GATE AS THE HEARTBEAT — `accountCache?.email`, via the same resolver. Widening it to
 * `independentAccount` would make installs that stay silent today start heartbeating, and their
 * requests go out on the SHARED API KEY, which enlarges the `hb_gate` shadow population feeding the
 * pending HEARTBEAT_IDENTITY_ENFORCE decision (#758). Fixing one thing must not redefine the
 * population another decision rests on. (Same argument as the failure-path comment below.)
 *
 * 🔴 DOES NOT TOUCH `lastHeartbeatAt`. This is an EXTRA report, not one of the hourly ones —
 * stamping the throttle here would let a pause click postpone a real failure heartbeat by an hour.
 *
 * Best-effort: a lost edge report is not a failure mode, because the next hourly heartbeat carries
 * the same live value.
 */
export async function reportSyncPauseState() {
  try {
    const cfg = await getConfig();
    if (!cfg.serverUrl || !cfg.apiKey) return false;
    const { accountCache } = await chrome.storage.local.get('accountCache');
    // 🔴 THE SAME EXPRESSION SHAPE AS THE FAILURE-PATH HEARTBEAT, not merely the same intent:
    // test/ingest-identity-guard.mjs checks every heartbeat identity site for the gate-then-resolve
    // ternary (#834 + the Codex population-widening DEPLOY-BLOCKER), and two spellings of one rule
    // is how a guard ends up checking only the site it happened to find first.
    const hbEmail = accountCache?.email
      ? await resolveIngestIdentity(accountCache.email, await readLinkedCanonical(accountCache.email))
      : null;
    if (!hbEmail) return false;
    return await postHeartbeat(cfg, {
      email: hbEmail,
      // Not an error — this report exists to carry `sync_paused`. It doubles as the marker the
      // SERVER uses to keep this heartbeat out of the disconnection-mail decision (worker
      // index.ts SYNC_PAUSE_HEARTBEAT_CODE — the two literals are one contract, like
      // `code: 'ext_token_invalid'`). It lands in `last_error_code`, which is honest for a paused
      // install ("quiet because the user paused") and is cleared by the next successful ingest
      // (snapshot-service.ts sets it to NULL).
      errorCode: SYNC_PAUSE_HEARTBEAT_CODE,
      extVersion: chrome.runtime.getManifest().version,
      syncPaused: await isServerSyncPaused(),
    });
  } catch (_) {
    return false;
  }
}

export function collectAndSend(opts = {}) {
  const run = () => collectAndSendImpl(opts);
  const p = _collectChain.then(run, run);
  _collectChain = p.catch(() => {});
  return p;
}

async function collectAndSendImpl({ force = false, skipServer = false, userManual = false } = {}) {
  const _t0 = performance.now();
  const _timings = {};
  // Skip collection if account is deleted
  const { account_deleted } = await chrome.storage.local.get({ account_deleted: false });
  if (account_deleted) {
    console.log('[Claude Tuner] Account deleted. Skipping collection.');
    return { success: false, account_deleted: true };
  }

  // Provider-incident collection pause (server circuit breaker): skip the whole
  // collection (provider fetch) while paused, regardless of what scheduled the tick —
  // this is the authoritative guard (the alarm reschedule in updatePollAlarm is just
  // an optimization). force (manual/welcome) bypasses: negligible volume, user-initiated.
  if (!force) {
    const _pauseCadence = await getCadence();
    if (isCollectionPaused(_pauseCadence)) {
      console.log('[Claude Tuner] Collection paused by server (provider incident). Skipping.');
      return { success: false, paused: true };
    }
  }

  // Centralized server-failure backoff: while a 5xx backoff window is active, do
  // all the local collection/UI work but skip the server POST (primary + extra
  // orgs). Done here — not at the alarm/tab gate — so every collectAndSend caller
  // (force collect, idle wake, 429 retry, reset/expire, manual, plan-order) is
  // covered, not just the two periodic gates. Automatic force does NOT bypass: the
  // server is down, so forcing only adds load (mirrors gateProviderSnapshot for
  // ChatGPT/Gemini). A USER-initiated collect (userManual: popup "수집" / onboarding)
  // DOES bypass — the person explicitly asked for fresh data now, one request is fine.
  if (!skipServer && !userManual && await isServerBackedOff()) {
    skipServer = true;
  }

  // Version block (server 426 upgrade_required — bg/upgrade-gate.js). Same placement and same
  // effect as the 5xx backoff above: local collection/history/UI keep running, only the POST is
  // skipped. Deliberately does NOT honor `userManual`, unlike the 5xx case: a 5xx might be over by
  // the time the user presses 수집, but the version verdict is a pure function of (env threshold,
  // this install's version) — a manual retry from the SAME build can only produce the same 426.
  // Bypassing would hand the user a button that silently does nothing.
  if (!skipServer && await isUpgradePostSuppressed()) {
    console.log('[Claude Tuner] Upgrade required — server POST paused until the extension updates.');
    skipServer = true;
  }

  const config = await getConfig();

  if (!config.serverUrl || !config.apiKey) {
    const error = 'Server URL 또는 API Key가 설정되지 않았습니다. 옵션 페이지에서 설정해주세요.';
    await setStatus({ error, timestamp: Date.now() });
    return { success: false, error };
  }

  try {
    // 1. Fetch organization info (cookie auth, org-scoped endpoint)
    let _ts = performance.now();
    const orgList = await fetchClaudeApi('/api/organizations');
    _timings['1_organizations'] = Math.round(performance.now() - _ts);

    if (!Array.isArray(orgList) || orgList.length === 0) {
      throw new Error('err_no_orgs');
    }

    // Detect plan for each org (skip API-only orgs)
    const orgPlans = orgList.map(o => { const p = detectPlan(o); return `${o.name}(${p})${p === 'API' ? '[skip]' : ''}`; });
    console.log(`[Claude Tuner] ${orgList.length} orgs:`, orgPlans.join(' | '));
    const planScoreMap = { 'Max 20x': 7, 'Team Premium': 6, 'Max 5x': 5, 'Team Standard': 4, 'Max': 3.5, 'Enterprise': 3, 'Team': 2.5, 'Team Tier 2': 2.5, 'Pro': 2, 'Free': 1 };

    // === Primary org selection: manual > cookie > plan score fallback ===
    let bestOrg = null;
    let bestPlan = 'unknown';
    let selectionMethod = '';
    const cookieOrgId = await getLastActiveOrgId();

    // 1) Manual selection (selectedOrgId)
    if (config.selectedOrgId) {
      bestOrg = orgList.find(o => o.uuid === config.selectedOrgId);
      if (bestOrg) {
        bestPlan = detectPlan(bestOrg);
        selectionMethod = 'manual';
      } else {
        // selectedOrgId may be an external provider (ChatGPT/Gemini) — don't reset
        const { collectedOrgs = [] } = await chrome.storage.local.get({ collectedOrgs: [] });
        const isExternal = collectedOrgs.some(o => o.uuid === config.selectedOrgId && o.provider && o.provider !== 'claude');
        if (!isExternal) {
          console.warn('[Claude Tuner] selectedOrgId not found, resetting to auto');
          await chrome.storage.sync.set({ selectedOrgId: null });
        }
      }
    }

    // 2) lastActiveOrg cookie (automatically set by Claude.ai on org switch)
    if (!bestOrg) {
      if (cookieOrgId) {
        const cookieOrg = orgList.find(o => o.uuid === cookieOrgId && detectPlan(o) !== 'API');
        if (cookieOrg) {
          bestOrg = cookieOrg;
          bestPlan = detectPlan(cookieOrg);
          selectionMethod = 'cookie';
        } else {
          console.log(`[Claude Tuner] lastActiveOrg cookie (${cookieOrgId}) not in org list or is API, falling back`);
        }
      } else {
        console.log('[Claude Tuner] lastActiveOrg cookie not found, falling back to plan scoring');
      }
    }

    // 3) Plan score-based fallback (when cookie is missing or match fails)
    if (!bestOrg) {
      const nonApiOrgs = orgList.filter(o => detectPlan(o) !== 'API');
      const isMultiOrg = nonApiOrgs.length > 1;
      let topScore = -1;
      for (const o of nonApiOrgs) {
        const p = detectPlan(o);
        if (isMultiOrg && p === 'Free') continue;
        const score = planScoreMap[p] || (p.startsWith('Max') ? 3 : 0);
        if (score > topScore) {
          topScore = score;
          bestOrg = o;
          bestPlan = p;
        }
      }
      selectionMethod = 'score';
    }

    console.log(`[Claude Tuner] Primary org: ${bestOrg?.name} (${bestPlan}) [${selectionMethod}]`);
    // Save auto-selected org info for options page display
    if (bestOrg && selectionMethod !== 'manual') {
      await chrome.storage.local.set({ autoSelectedOrg: { name: bestOrg.name, plan: bestPlan, uuid: bestOrg.uuid } });
    }

    // Extract email: prefer org with email_address, fallback to parsing from org.name
    let userEmail = 'unknown';
    // 🔴 THE CLAUDE PROVIDER LABEL, KEPT SEPARATE FROM `userEmail` ON PURPOSE (#1038).
    // `userEmail` starts as the Claude account but is REASSIGNED below to the ingest IDENTITY
    // (resolveIngestIdentity: a verified link, then the ext_token's address). That is the account
    // usage is filed under — the exact thing the disclosure contrasts the provider account WITH.
    // Passing it as the label would make the popup say "this browser collects <your login>",
    // which is both meaningless and hides the account actually being absorbed (Codex round 2).
    let claudeProviderEmail = null;
    for (const o of orgList) {
      const e = o.email_address || o.owner?.email_address;
      if (e) { userEmail = e; break; }
    }
    if (userEmail === 'unknown') {
      for (const o of orgList) {
        if (o.name) {
          const m = o.name.match(/^([^\s]+@[^\s]+)'s\s/i);
          if (m) { userEmail = m[1]; break; }
        }
      }
    }
    // Snapshot the org-derived address before /api/account can overwrite userEmail below. Used
    // to notice a provider account-email change: it is the only email signal we get on a cached
    // cycle, so a change in it is our cue that accountCache needs re-fetching.
    const orgDerivedEmail = userEmail === 'unknown' ? null : userEmail;
    // Fetch email + seat_tier from /api/account (cached 8 hours)
    // grove_enabled has separate cache (30 min) — may change more frequently
    let seatTier = null;
    let groveEnabled = null;
    let groveDetected = false; // Whether grove_enabled was successfully read from the API
    {
      const ACCOUNT_CACHE_TTL = 8 * 60 * 60 * 1000; // 8 hours
      const GROVE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
      const cached = await chrome.storage.local.get(['accountCache', 'groveCache']);
      const cache = cached.accountCache;
      const groveC = cached.groveCache;

      // --- account (email, seatTier) ---
      // Changing your provider account email moves neither the org uuid nor the clock, so the
      // TTL/org checks alone would keep serving the OLD address for up to 8 hours. That is not
      // cosmetic: the provider collectors (bg/collect-{chatgpt,gemini}.js) send accountCache's
      // address as their server identity, and the server mints the ext_token from whatever a
      // successful POST carried — so a stale cache makes ChatGPT/Gemini re-mint a token for the
      // OLD account every cycle, rolling the migration back until the TTL finally expires.
      //
      // Detect it by CHANGE in the org-derived address, not by disagreement with cache.email:
      // those two legitimately differ forever for a team member (the org list can only offer the
      // owner's address), and comparing them would refetch /api/account on every single cycle.
      // Comparing against the org-derived value recorded when the cache was written is stable —
      // it only trips when the signal itself moves. Entries written before this field existed
      // have no recorded value, so they keep the old behaviour until their next natural refresh.
      const acctOrgEmailChanged = !!cache?.orgEmail && !!orgDerivedEmail && cache.orgEmail !== orgDerivedEmail;
      const acctCacheValid = !force && cache && (Date.now() - cache.ts) < ACCOUNT_CACHE_TTL
        && cache.orgUuid === bestOrg?.uuid && !acctOrgEmailChanged;
      if (acctOrgEmailChanged) {
        console.log('[Claude Tuner] account email changed:', cache.orgEmail, '->', orgDerivedEmail, '— refreshing accountCache');
      }
      if (acctCacheValid) {
        if (userEmail === 'unknown' && cache.email) userEmail = cache.email;
        // 🔴 NO LABEL FROM A CACHE HIT. Nothing was verified this cycle: the usage below is
        // fetched with the CURRENT cookie session, while `cache.email` is a profile read that can
        // be up to 8 hours old — and the cache only refreshes when the ORG-DERIVED address moves,
        // so two accounts inside one team org keep the first one indefinitely. Stamping it here
        // would say "we checked, it is Alice" when Bob is the one signed in (Codex round 3).
        // The previously observed label stays stored with its own timestamp and ages out on its
        // own; `undefined` means "no new observation", which is different from "no account".
        seatTier = cache.seatTier || null;
        console.log('[Claude Tuner] Account (cached):', cache.email, 'seat:', seatTier);
      } else {
        try {
          _ts = performance.now();
          const acct = await fetchClaudeApi('/api/account', { quiet: true });
          _timings['2_account'] = Math.round(performance.now() - _ts);
          const acctEmail = acct?.email || acct?.email_address;
          const memberships = acct?.memberships || [];
          const bestOrgUuid = bestOrg?.uuid;
          const membership = memberships.find(m =>
            m.organization_uuid === bestOrgUuid || m.organization?.uuid === bestOrgUuid
          ) || memberships[0];
          seatTier = membership?.seat_tier || null;
          if (acctEmail) userEmail = acctEmail;
          if (acctEmail) claudeProviderEmail = acctEmail;   // fetched live this cycle

          // 🔴 A seat_tier the response did not carry is UNKNOWN — it is not "Team Standard" (#969).
          // Both readers of this cache collapse those two: refineTeamPlan() returns a bare 'Team',
          // which the server's normalizePlan() folds to 'Team Standard', and the primary path below
          // does the same through `SEAT_TIER_MAP[x] || 'Team Standard'`. So losing a tier here
          // silently DOWNGRADES a Team Premium member.
          //
          // The loss was on WRITE, not on read: allSeatTiers was rebuilt from an empty object and
          // the whole cache replaced, so a single response without seat_tier erased what we already
          // knew — and the 8h TTL meant that happened on a schedule. Measured before the fix: 602
          // users / 935 day-over-day label changes, and every Premium→Standard sample had an
          // UNCHANGED quota, i.e. the "downgrades" were this fallback rather than real ones.
          //
          // Merge over what we knew instead. A real downgrade still lands immediately — it arrives
          // as seat_tier:'team_standard' and overwrites its key. Only ABSENCE is preserved.
          // 🔴 Only inherit from a cache belonging to the SAME account. This branch also runs when
          // acctCacheValid was false BECAUSE the account email changed (acctOrgEmailChanged above),
          // and a seat tier is a property of the person in the seat — carrying it across an identity
          // change would report the previous account's tier as the new one's.
          const sameAccount = !!cache && !!acctEmail && cache.email === acctEmail;
          // Keep tiers only for orgs this account is STILL a member of, so a tier from an org the
          // user left cannot resurface if they rejoin and that response omits seat_tier. Skipped
          // when memberships is empty — an empty list is far more likely a degraded response than
          // a real "left every org", and pruning on it would reinstate the very wipe this fixes.
          const currentOrgUuids = new Set(
            memberships.map((m) => m.organization_uuid || m.organization?.uuid).filter(Boolean)
          );
          const allSeatTiers = {};
          if (sameAccount && cache.allSeatTiers) {
            for (const [uuid, tier] of Object.entries(cache.allSeatTiers)) {
              if (currentOrgUuids.size === 0 || currentOrgUuids.has(uuid)) allSeatTiers[uuid] = tier;
            }
          }
          for (const m of memberships) {
            const mOrgUuid = m.organization_uuid || m.organization?.uuid;
            if (mOrgUuid && m.seat_tier) allSeatTiers[mOrgUuid] = m.seat_tier;
          }
          // Same rule for the primary org's tier: same account AND same org.
          if (!seatTier && sameAccount && cache.seatTier && cache.orgUuid === bestOrgUuid) {
            seatTier = cache.seatTier;
            console.warn('[Claude Tuner] /api/account carried no seat_tier — keeping last known:', seatTier);
          }
          const acctName = acct?.full_name || acct?.display_name || '';
          // orgEmail = the org-derived address seen alongside this fetch. It is the baseline the
          // cached branch compares against to notice an account-email change (see above); it is
          // NOT the identity — `email` from /api/account is.
          await chrome.storage.local.set({ accountCache: { email: acctEmail, name: acctName, seatTier, orgUuid: bestOrgUuid, allSeatTiers, orgEmail: orgDerivedEmail, ts: Date.now() } });
          console.log('[Claude Tuner] Account API:', acctEmail, 'seat:', seatTier, 'org:', bestOrgUuid);
          // Parse grove_enabled from the same response (no extra API call needed)
          const groveNeedsFresh = force || !groveC || (Date.now() - groveC.ts) >= GROVE_CACHE_TTL;
          if (groveNeedsFresh && acct?.settings != null && typeof acct.settings === 'object' && 'grove_enabled' in acct.settings) {
            groveEnabled = acct.settings.grove_enabled === true ? true : acct.settings.grove_enabled === false ? false : null;
            groveDetected = true;
            saveGroveCache(groveEnabled, true);
            console.log('[Claude Tuner] grove from account API:', groveEnabled);
          }
        } catch (e) {
          console.warn('[Claude Tuner] Account API failed:', e.message);
          if (cache) {
            if (userEmail === 'unknown' && cache.email) userEmail = cache.email;
            seatTier = cache.seatTier || null;
          }
        }
      }

      // --- grove_enabled (separate cache, 30 min) ---
      const groveCacheValid = !force && groveC && (Date.now() - groveC.ts) < GROVE_CACHE_TTL;
      if (groveCacheValid) {
        groveEnabled = groveC.value ?? null;
        groveDetected = groveC.detected ?? false;
        console.log('[Claude Tuner] grove (cached):', groveEnabled, 'detected:', groveDetected);
      } else if (!groveDetected) {
        // Skip if already parsed from account API above
        try {
          _ts = performance.now();
          const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
          if (tabs.length > 0) {
            const groveResult = await chrome.scripting.executeScript({
              target: { tabId: tabs[0].id },
              world: 'MAIN',
              func: async () => {
                try {
                  const r = await fetch('/api/account', { credentials: 'include' });
                  const status = r.status;
                  if (!r.ok) return { value: null, debug: { status, error: 'http_error', response_length: 0, has_settings: false, has_grove_key: false, grove_context: null, settings_keys: 0 } };
                  const t = await r.text();
                  const m = t.match(/"grove_enabled"\s*:\s*(true|false|null)/);
                  if (m) return { value: m[1] === 'true' ? true : m[1] === 'false' ? false : null, debug: null };
                  // Parse failed — collect debug info
                  let hasSettings = false, settingsKeys = 0, hasGroveKey = false, groveContext = null;
                  try {
                    const j = JSON.parse(t);
                    hasSettings = j.settings != null && typeof j.settings === 'object';
                    if (hasSettings) settingsKeys = Object.keys(j.settings).length;
                    hasGroveKey = t.includes('"grove_enabled"');
                    if (hasGroveKey) {
                      const idx = t.indexOf('"grove_enabled"');
                      groveContext = t.slice(Math.max(0, idx - 10), idx + 50);
                    }
                  } catch {}
                  return { value: null, debug: { status, error: null, response_length: t.length, has_settings: hasSettings, has_grove_key: hasGroveKey, grove_context: groveContext, settings_keys: settingsKeys } };
                } catch (e) { return { value: null, debug: { status: -1, error: e.message, response_length: 0, has_settings: false, has_grove_key: false, grove_context: null, settings_keys: 0 } }; }
              },
              args: [],
            });
            const gr = groveResult?.[0]?.result;
            if (gr && !gr.debug) {
              // Regex match success (includes true/false/null) — explicit detection
              groveEnabled = gr.value;
              groveDetected = true;
            } else if (gr) {
              // Parse failed — debug info available
              if (gr.value != null) groveEnabled = gr.value;
            }
            saveGroveCache(groveEnabled, groveDetected);
            console.log('[Claude Tuner] grove API:', groveEnabled, 'detected:', groveDetected);
          } else {
            // No tabs available — cookie fallback
            const acctNo = await fetchWithCookies('https://claude.ai/api/account');
            const parsed = parseGroveFromText(acctNo);
            if (parsed !== null) {
              groveEnabled = parsed;
              groveDetected = true;
              saveGroveCache(groveEnabled, true);
              console.log('[Claude Tuner] grove no-tab cookie fallback:', groveEnabled);
            }
          }
        } catch (ge) {
          console.warn('[Claude Tuner] grove executeScript failed, trying cookie fallback:', ge.message);
          // Cookie-based fallback: when executeScript fails (insufficient permissions, etc.)
          try {
            const acct = await fetchWithCookies('https://claude.ai/api/account');
            const parsed = parseGroveFromText(acct);
            if (parsed !== null) {
              groveEnabled = parsed;
              groveDetected = true;
              saveGroveCache(groveEnabled, true);
              console.log('[Claude Tuner] grove cookie fallback:', groveEnabled, 'detected:', groveDetected);
            }
          } catch (ce) {
            console.warn('[Claude Tuner] grove cookie fallback failed:', ce.message);
            if (groveC) {
              groveEnabled = groveC.value ?? null;
              groveDetected = groveC.detected ?? false;
            }
          }
        }
        _timings['3_grove'] = Math.round(performance.now() - _ts);
      }
    }

    // Refine plan based on seat tier
    if (bestPlan === 'Team' && seatTier) {
      // An unmapped tier (a new 'team_tier_N' Anthropic adds) would otherwise become Team Standard
      // with no trace — the same silent downgrade as a missing tier, just from a different cause.
      if (!SEAT_TIER_MAP[seatTier]) {
        console.warn(`[Claude Tuner] unmapped seat_tier "${seatTier}" — falling back to Team Standard (#969)`);
      }
      bestPlan = SEAT_TIER_MAP[seatTier] || 'Team Standard';
      console.log(`[Claude Tuner] Team seat_tier: ${seatTier} → ${bestPlan}`);
    } else if (bestPlan === 'Enterprise' && seatTier) {
      console.log(`[Claude Tuner] Enterprise seat_tier: ${seatTier}`);
    }

    // Check for non-monitorable orgs (API-only)
    if (!bestOrg || bestPlan === 'API') {
      const hasAPI = orgList.some(o => detectPlan(o) === 'API');
      if (hasAPI) {
        throw new Error('err_api_only');
      } else {
        throw new Error('err_no_monitorable');
      }
    }

    // Free plan: force poll interval to 60 min / restore on upgrade
    {
      const { intervalExplicitlySet } = await chrome.storage.sync.get({ intervalExplicitlySet: false });
      if (!intervalExplicitlySet) {
        const currentInterval = config.intervalMinutes || DEFAULT_INTERVAL_MINUTES;
        if (bestPlan === 'Free' && currentInterval !== FREE_PLAN_INTERVAL_MINUTES) {
          console.log(`[Claude Tuner] Free plan: poll interval ${currentInterval}m → ${FREE_PLAN_INTERVAL_MINUTES}m`);
          await chrome.storage.sync.set({ intervalMinutes: FREE_PLAN_INTERVAL_MINUTES });
          chrome.alarms.create(ALARM_NAME, { delayInMinutes: FREE_PLAN_INTERVAL_MINUTES, periodInMinutes: FREE_PLAN_INTERVAL_MINUTES });
        } else if (bestPlan !== 'Free' && currentInterval === FREE_PLAN_INTERVAL_MINUTES) {
          const restoreInterval = (await chrome.storage.local.get('serverPollInterval')).serverPollInterval || DEFAULT_INTERVAL_MINUTES;
          console.log(`[Claude Tuner] Upgraded from Free: poll interval ${FREE_PLAN_INTERVAL_MINUTES}m → ${restoreInterval}m`);
          await chrome.storage.sync.set({ intervalMinutes: restoreInterval });
          chrome.alarms.create(ALARM_NAME, { delayInMinutes: restoreInterval, periodInMinutes: restoreInterval });
        }
      }
    }

    // Fetch usage data from the selected primary org
    let org = bestOrg;
    let orgId = bestOrg?.uuid;
    let usageData = null;
    try {
      _ts = performance.now();
      usageData = await fetchClaudeApi(`/api/organizations/${orgId}/usage`);
      _timings['4_usage'] = Math.round(performance.now() - _ts);
    } catch (e) {
      console.warn(`[Claude Tuner] Usage fetch failed for ${bestOrg.name}: ${e.message}`);
      if (e.message && e.message.includes('err_rate_limit')) {
        throw new Error('err_rate_limit');
      }
    }
    if (!org || !usageData) {
      throw new Error('err_usage_failed');
    }

    const plan = bestPlan;
    console.log(`[Claude Tuner] User: ${userEmail}, Plan: ${plan}, UsageOrg: ${org.name} (${orgId})`);

    // 2-1. Fetch subscription info (renewal date, pending plan changes)
    // Team/Enterprise can't access subscription_details (403) — only try personal orgs
    let subscriptionInfo = {};
    const isPersonalPlan = !NON_PERSONAL_PLANS.some(t => bestPlan.startsWith(t));
    if (isPersonalPlan) {
      _ts = performance.now();
      // Find org to fetch subscription info from (personal orgs only — excludes Team/Enterprise/API)
      const subOrgId = await (async () => {
        const personalOrgs = (selectionMethod === 'manual' && bestOrg) ? [bestOrg] : orgList.filter(o => {
          const p = detectPlan(o);
          return !NON_PERSONAL_PLANS.some(s => p.startsWith(s));
        });
        for (const o of personalOrgs) {
          try {
            await fetchClaudeApi(`/api/organizations/${o.uuid}/subscription_details`, { quiet: true });
            return o.uuid;
          } catch (_) {}
        }
        return orgId;
      })();
      subscriptionInfo = await fetchSubscriptionInfo(subOrgId);
      _timings['5_subscription'] = Math.round(performance.now() - _ts);
    }

    // Cross-email link (step C): if this claude.ai account email has a verified
    // link to a canonical Tuner account, tag the snapshot with the canonical email
    // so /api/snapshots accepts it. The ext_token identity is the canonical (Tuner)
    // email, not this claude.ai account email, so an unsubstituted user_email would
    // be rejected (403 Email mismatch) and the data silently dropped.
    // See docs/DESIGN-identity-email-auth-trap.md (step C).
    // Derivation lives in storage.js (readLinkedCanonical) because the heartbeat path needs the
    // same answer — see #834, where heartbeat having its OWN identity rule was the whole bug.
    const linkedCanonical = await readLinkedCanonical(userEmail);

    // …then the ONE identity rule every collector shares (bg/storage.js — see
    // docs/DESIGN-authenticated-attribution.md): the authenticated identity wins. Claude was the
    // odd one out. It keyed on the claude.ai account email and repaired the mismatch from
    // `claudeAliasLink`, which is DEVICE-local state; losing it (new browser, reinstall) meant a
    // 403 on every POST, a cleared ext_token and permanent shared-api_key fallback — 22 of 297
    // installs (7.4%) were measured in exactly that hole.
    //
    // 🔴 A verified link is passed in and OUTRANKS the token — do not "simplify" this by letting
    // the resolver read the token first. Linking does not refresh the token, so right after a
    // link the install still holds one bound to the OLD address; token-first silently undoes the
    // link, permanently (the server then sees authedEmail === bodyEmail and re-mints the old
    // one). Rationale in full at pickIngestIdentity(); regression covered by test:ingest-identity.
    userEmail = (await resolveIngestIdentity(userEmail, linkedCanonical)) || userEmail;

    // 3. Build snapshot (resets_at normalized to minute precision)
    const extVersion = chrome.runtime.getManifest().version;
    const snapshot = {
      user_email: userEmail,
      plan: plan,
      rate_limit_tier: bestOrg?.rate_limit_tier || null,
      seat_tier: seatTier || null,
      ext_version: extVersion,
      collected_at: new Date().toISOString(),
      subscription: subscriptionInfo,
      ...await buildUsageFields(usageData, config),
      grove_enabled: groveEnabled,
      grove_detected: groveDetected,
      claude_org_uuid: bestOrg?.uuid || null,
      claude_org_name: bestOrg?.name || null,
      is_primary_org: !!config.selectedOrgId && config.selectedOrgId === bestOrg?.uuid,
      last_active_org_uuid: cookieOrgId || null,
      install_id: await getOrCreateInstallId(),
    };

    // Include ref_source (removed after first send)
    const { ref_source } = await chrome.storage.local.get('ref_source');
    if (ref_source) {
      snapshot.ref_source = ref_source;
      await chrome.storage.local.remove('ref_source');
    }

    // Phase 2 단계 4 login-first gate: a FRESH (non-grandfathered) install that has not
    // logged in shows usage LOCALLY but never POSTs to the server via the shared api_key —
    // server sync requires a login-proven token (so no ingest-token TOFU is minted for new
    // users). Existing users (grandfathered on update) and any logged-in user (extToken
    // present) are unaffected. We surface the login CTA once so the popup/welcome can nudge.
    // 🔴 ASK THE GATE FOR ITS REASON — do not add a second condition here. `token_lost` is the new
    // case: an install that HELD a token and no longer does used to fall back to the shared key,
    // which keeps the account syncing (so nothing looks broken) while its writes quietly stop
    // being attributable to a proven identity. A grandfathered install that never authenticated
    // still gets `null` and is untouched — withholding from THEM would be authentication
    // enforcement, an open decision (#767) and not this change's to make.
    const withheldReason = await serverSyncWithheldReason();
    const blockServerNewUser = !!withheldReason;
    if (blockServerNewUser) await chrome.storage.local.set({ showLoginPrompt: true });
    // #1119 — the user's OWN choice to stop sending, read from its own key (bg/storage.js) and
    // never from the gate above: they hold a valid token, so `showLoginPrompt` must stay untouched
    // or a pause would raise a login CTA at someone who is already logged in.
    const userPaused = await isServerSyncPaused();

    // 4. Send to server (local save only when skipServer/boost, gated new user, or user-paused)
    if (skipServer || blockServerNewUser || userPaused) {
      console.log(`[Claude Tuner] Local-only collection (${blockServerNewUser ? `login required for server sync: ${withheldReason}` : userPaused ? 'user paused server sync' : 'boost mode'})`);
      // Hoisted so the GA event below reports the SAME fetch mode the status records, without a
      // second chrome.tabs.query on a path that runs on every alarm tick.
      const withheldFetchMode = (await chrome.tabs.query({ url: 'https://claude.ai/*' })).length > 0 ? 'tab' : 'cookie';
      await setStatus({
        success: true,
        // 🔴 The COLLECTION succeeded; the SERVER SYNC did not. Recording only `success: true`
        // made the popup paint the same green ✓ as a fully synced collect, so a withheld install
        // looks healthy while its dashboard and team report go empty — and the user's next move
        // is to reinstall, which is what put a re-installed account into `login_first` in the
        // first place (background.js sets serverSyncGrandfathered:false on a FRESH install).
        // Null for boost mode (`skipServer`), which is a deliberate local-only collect and not a
        // gate. setStatus REPLACES lastStatus, so a later synced collect drops this field —
        // it can never latch.
        serverWithheld: withheldReason || null,
        // #1119 — a DIFFERENT fact from serverWithheld: this collect reached the server's door and
        // was held back by the user, not by a missing credential. Written on the same replace-only
        // status (setStatus REPLACES lastStatus) so it can never latch past its cause, and derived
        // from the key rather than hardcoded so boost mode stays unflagged, exactly as the field
        // above does.
        syncPaused: userPaused,
        timestamp: Date.now(),
        lastSuccessTimestamp: Date.now(),
        snapshot: snapshot,
        recommendation: (await getLastStatus())?.recommendation || null,
        fetchMode: withheldFetchMode,
      });
      // This branch RETURNS below, so it never reaches the `collect_success` event at the end of
      // this function — which is why the gated population's collection was unobservable: we knew
      // HOW MANY installs were gated (extension_loaded + auth) but nothing about whether they
      // were actually collecting. This event is the only report they ever file.
      //
      // 🔴 A SEPARATE event name, not `collect_success` with a flag. Widening collect_success to
      // cover withheld collects would move ~13% of the install base into a metric that has been
      // read as "synced collects" everywhere it has ever been quoted (#1023 sizing, the Phase 2
      // adoption curves), silently invalidating every comparison against its own history.
      //
      // Gated on blockServerNewUser, NOT on the shared `if` above: boost mode (`skipServer`) is a
      // deliberate local-only collect, not a gate, and folding it in would inflate the population
      // this exists to size — the same distinction the serverWithheld field above already makes.
      //
      // `reason` reuses the custom dimension already registered for extension_installed, so the
      // login_first / token_lost split is queryable without a GA4 schema change.
      //
      // 🔴 POSITION IS LOAD-BEARING: sendGAEvent is fire-and-forget (no await, errors swallowed),
      // and an in-flight fetch does not keep an MV3 service worker alive. Sitting here, several
      // awaited storage operations still follow and hold the worker up while the beacon flushes.
      // Moved down next to the `return` — which reads tidier — it would be dropped whenever the
      // worker idles out first, i.e. it would UNDERCOUNT exactly the population it exists to
      // count. `collect_success` gets away with fire-and-forget because ~400 lines follow it.
      if (blockServerNewUser) {
        sendGAEvent('collect_withheld', { reason: withheldReason, plan: snapshot.plan, fetch_mode: withheldFetchMode });
      } else if (userPaused) {
        // 🔴 ITS OWN EVENT NAME, for the reason the block above spells out: `collect_withheld` is
        // read as "installs that CANNOT sync" everywhere it has been quoted, and a user who chose
        // this is a different population with a different remedy. Same reporting position (several
        // awaited storage writes still follow) so the fire-and-forget beacon flushes before the
        // MV3 worker idles out.
        sendGAEvent('collect_paused', { plan: snapshot.plan, fetch_mode: withheldFetchMode });
      }

      // #1122 — file this install's FIRST server-side report now, rather than waiting for the 12h
      // alarm whose first fire is spread uniformly across ~12 hours. An install that passes through
      // the gate faster than its own offset files nothing at all, and #1023's welcome page exists to
      // make exactly that happen within minutes of install ⇒ the alarm alone is blind to the
      // conversions the recovery work produces. Throttled inside (once per gate reason, ≥1h apart),
      // so this is not a per-collection request.
      //
      // 🔴 ITS OWN BLOCK, not folded into the GA branch above, for two independent reasons:
      //   1. Different transport, different failure semantics — GA is fire-and-forget and tolerates
      //      being dropped; this is an AWAITED POST that must not be, and awaiting it inside a
      //      branch whose comment argues for fire-and-forget positioning would read as a
      //      contradiction of that argument.
      //   2. test/local-only-status-guard.mjs pins the GA branch's SHAPE — its mutations match
      //      `if (blockServerNewUser) { sendGAEvent(…) }` as a single-statement block, so any
      //      statement added in there silently stops those mutations from applying and four of them
      //      report "NOT caught" while testing nothing. Keep this out of that block.
      //
      // 🔴 Awaited on purpose: an in-flight fetch does not keep an MV3 worker alive, and this POST
      // is heavier than a GA beacon. It cannot stall collection (the send carries its own
      // AbortController timeout) and it cannot throw (it swallows everything internally).
      if (blockServerNewUser) await maybeSendFirstGatedBeacon(withheldReason);
      // Keep collectedOrgs fresh so sidebar/input get this collection
      // (storage.onChanged on collectedOrgs triggers pushSidebarUsage).
      const { collectedOrgs: prevOrgs = [] } = await chrome.storage.local.get({ collectedOrgs: [] });
      // UPSERT, not map — see bg/org-merge.js for why a withheld install loses its Claude org
      // otherwise. The logic lives there so it can be executed by a test instead of regex-matched.
      const updatedOrgs = upsertClaudeOrg(prevOrgs, bestOrg, snapshot);
      await chrome.storage.local.set({ collectedOrgs: updatedOrgs });
      await appendUsageHistory(buildHistoryPoint(snapshot, plan));
      await refreshRecNotice();
      await updateBadgeForSelectedOrg(snapshot);
      // 🔴 The local-only path matters MORE than the synced one here: this is the withheld/gated
      // install, i.e. exactly the population that gets shown the login CTA the disclosure sits in.
      await noteClaudeCollected(claudeProviderEmail);
      return { success: true, snapshot, localOnly: true };
    }

    const body = { ...snapshot, ...(force ? { force: true } : {}) };

    // === Primary org delta-gated send ===
    // We gate ONLY the server POST; the local UI/history/badge below still run
    // every alarm tick so the popup stays fresh regardless. Send when usage
    // changed (and >= MIN_INTERVAL since the last POST) or the 1h heartbeat
    // FLOOR elapsed; otherwise skip the POST. This replaces the old tier-cadence
    // gate (active→idle 30m→dormant 2h), which delayed a real change by up to 2h
    // on the dashboard. lastValues/lastPollAt are advanced only on a POST (below),
    // so they track the last *sent* values/time — exactly what the gate needs.
    // orgPollState load is shared with the extra-org loop (single get/set → no race).
    const { orgPollState: _pollState = {} } = await chrome.storage.local.get({ orgPollState: {} });
    const orgPollState = _pollState || {};
    const baseIntervalMs = (config.intervalMinutes || DEFAULT_INTERVAL_MINUTES) * 60 * 1000;
    const now = Date.now();
    if (bestOrg?.uuid && !orgPollState[bestOrg.uuid]) orgPollState[bestOrg.uuid] = getOrgPollDefault();
    const primaryState = (bestOrg?.uuid && orgPollState[bestOrg.uuid]) || getOrgPollDefault();
    const primaryCurrentValues = {
      h5: snapshot.five_hour?.utilization ?? null,
      d7: snapshot.seven_day?.utilization ?? null,
      extraUsed: snapshot.extra_usage?.used_credits ?? null,
      resetsAt5h: snapshot.five_hour?.resets_at ?? null,
      resetsAt7d: snapshot.seven_day?.resets_at ?? null,
      extraUsage: snapshot.extra_usage ?? null,
    };
    // force (manual/welcome) always posts. Otherwise the shared gate decides:
    // changed (10min min-interval) OR the 1h heartbeat floor.
    // Primary reuses lastPollAt as "last sent" — updateOrgPollState below runs only
    // in this send branch, so lastValues/lastPollAt already track the last POST.
    const primaryCadence = await getCadence(Date.now(), { uuid: bestOrg?.uuid, provider: 'claude' });
    const { send: primaryDue, changed: primaryChanged, reason: primaryGateReason } = shouldSendSnapshot(
      primaryState.lastValues, primaryState.lastPollAt, primaryCurrentValues,
      { force, sendFloorMs: primaryCadence.sendFloorMs, heartbeatFloorMs: primaryCadence.heartbeatFloorMs },
    );
    if (!primaryDue) {
      console.log(`[Claude Tuner] Primary delta-gate skip (${primaryGateReason})`);
    } else {
      // Advance state optimistically so lastValues/lastPollAt track the last
      // *sent* values/time (the gate above depends on this). On a TRANSIENT POST
      // failure we roll this back (below) so the next tick retries — otherwise a
      // failed heartbeat would silently block the next send for a full FLOOR (1h).
      const prevPrimaryValues = primaryState.lastValues;
      const prevPrimaryPollAt = primaryState.lastPollAt;
      if (bestOrg?.uuid) {
        orgPollState[bestOrg.uuid] = updateOrgPollState(primaryState, primaryCurrentValues, primaryChanged);
      }
      // Roll the primary org's send-state back to its pre-POST values on a
      // transient failure (5xx/network). Persistent rejects (403 mismatch / 401 /
      // 410) intentionally do NOT roll back — they should back off, not hammer.
      const rollbackPrimary = async () => {
        if (!bestOrg?.uuid) return;
        const { orgPollState: cur = {} } = await chrome.storage.local.get({ orgPollState: {} });
        if (cur[bestOrg.uuid]) {
          cur[bestOrg.uuid] = { ...cur[bestOrg.uuid], lastValues: prevPrimaryValues, lastPollAt: prevPrimaryPollAt };
          await chrome.storage.local.set({ orgPollState: cur });
        }
      };

    // authBlocked (401 login_required) backoff — bg/storage.js. Checked HERE rather than at the
    // top-level skipServer gate because only here is the identity the POST will actually claim
    // known, and the backoff is scoped to the blocked email. The optimistic send-state advance
    // above is deliberately left in place: this is a persistent reject, and the convention on
    // those (see rollbackPrimary) is to back off rather than re-arm an immediate resend.
    // Local collection/history/UI already ran, so the popup stays fresh — only the send stops.
    if (await isAuthBlockSuppressed(body && body.user_email)) {
      console.log('[Claude Tuner] Auth blocked — server POST backed off until login.');
    } else {
    // === Server POST: fire-and-forget (don't wait for response) ===
    // Send server save in background, proceed with local UI update first.
    // Preflight-free simple request (storage.js simplePost) — auth in body.
    simplePost(config, `${config.serverUrl}/api/snapshots`, body).then(async ({ response, sentToken }) => {
      if (response.status === 403) {
        // 403 = email mismatch: this Claude snapshot's account email differs from
        // the Tuner login identity bound to the ext_token, so the server rejects it.
        // Common for multi-provider users whose claude.ai account email ≠ their
        // Tuner login (ChatGPT/Gemini keep the token bound to the Tuner email, so
        // Claude silently never collects). Surface a popup warning explaining why.
        const errData = await response.json().catch(() => ({}));
        // Phase 2 scope_insufficient: /api/snapshots is NOT scope-gated today (an ingest token
        // is meant to write snapshots, §4.1.1) so this cannot fire now, but if a future contract
        // scope-gates it, the valid ingest token must NOT be cleared (clearing → api_key re-TOFU
        // → ingest loop). Raise needsFullLogin and return without clearing (Codex review).
        if (errData.code === 'scope_insufficient' && sentToken) {
          await chrome.storage.local.set({ needsFullLogin: true });
          return;
        }
        if (errData.error === 'Email mismatch') {
          await chrome.storage.local.set({
            claudeEmailMismatch: { claudeEmail: snapshot.user_email || null, ts: Date.now() },
          });
          // This 403 IS the server telling us the token identity and the snapshot identity have
          // diverged, which is exactly the event accountCache needs to hear about — and a far
          // more reliable signal than the org-list heuristic used at collection time, which
          // cannot see a member's own address change when the org list only exposes the owner's.
          // Expire the entry (rather than removing it) so the next cycle refetches /api/account,
          // the authority, while seatTier/allSeatTiers stay available as a fallback meanwhile.
          // Without this, the provider collectors keep sending the stale cached address, the
          // server re-mints the token against it, and the migration is undone every cycle until
          // the 8h TTL finally lapses.
          const { accountCache: _staleAcct } = await chrome.storage.local.get('accountCache');
          if (_staleAcct && _staleAcct.ts) {
            await chrome.storage.local.set({ accountCache: { ..._staleAcct, ts: 0 } });
            console.log('[Claude Tuner] accountCache expired by 403 email mismatch — will refetch /api/account');
          }
        }
        // Keep existing token-clear behavior (race-safe: only clears if unchanged).
        const cleared = await clearExtTokenIfMatches(sentToken);
        if (cleared) {
          console.log('[Claude Tuner] ext_token cleared (403). Will re-auth on next cycle.');
        }
        return;
      }
      if (response.status === 401) {
        // email-provider guard (401 login_required): an auth_provider='email' account is barred
        // from the shared api_key, so this POST was rejected AND not stored. The reject is
        // intended; the SILENCE was the bug — these installs hold no ext_token, so the clear
        // below is a no-op and nothing ever surfaced. Raise authBlocked for the popup CTA.
        if (await noteAuthBlocked(response, sentToken, `${config.serverUrl}/api/snapshots`, body && body.user_email)) return;
        // ext_token invalid/expired — clear and fall back to API key next cycle.
        // Race-safe: only clear if the token we sent is still the stored one.
        const cleared = await clearExtTokenIfMatches(sentToken);
        if (cleared) {
          console.log('[Claude Tuner] ext_token cleared (401). Will re-auth on next cycle.');
        }
        return;
      }
      if (response.status === 410) {
        const errData = await response.json().catch(() => ({}));
        if (errData.account_deleted) {
          console.log('[Claude Tuner] Account has been deleted. Stopping collection.');
          await chrome.storage.local.set({ account_deleted: true });
          chrome.alarms.clear(ALARM_NAME);
          // 🔴 Through updateBadgeError(), not a raw setBadgeText (#994). The icon is now a
          // semantic channel: painting the `!` badge without the error icon leaves the NORMAL
          // icon next to an alarm badge, which reads as two states at once. Chrome persists the
          // icon across service-worker restarts, so a missed paint is permanent, not transient.
          updateBadgeError();
          return;
        }
      }
      if (response.status === 426) {
        // MIN_INGEST_VERSION gate (worker/src/services/version-gate.ts): this build is below the
        // server minimum, so NOTHING was stored and nothing will be until the extension updates.
        // Raise the block (backoff + badge + popup banner) and return BEFORE the generic !ok
        // handler — persistent rejects must not roll back the send-state (rolling back would
        // re-arm an immediate resend, i.e. exactly the hammering this branch exists to stop).
        // 🔴 No token is touched on this path: the ext_token is VALID, the extension is old.
        // Clearing it would force an api_key re-TOFU and put a logged-in user back on the ingest
        // path — the same trap as scope_insufficient (bg/storage.js:574-577).
        if (await noteUpgradeRequired(response, `${config.serverUrl}/api/snapshots`)) return;
      }
      if (!response.ok) {
        console.warn(`[Claude Tuner] Server POST failed: ${response.status} ${response.statusText}`);
        await rollbackPrimary(); // transient (e.g. 5xx) → let the next tick retry
        // 5xx → server/D1 overload: extend the shared backoff so the next tick
        // doesn't immediately re-hammer a saturated server (#228 retry-on-5xx).
        if (response.status >= 500) await noteServerFailure();
        return;
      }
      const result = await response.json();
      await noteServerSuccess(); // confirmed-healthy POST clears any backoff
      console.log(`[Claude Tuner] Snapshot sent: ${result.success ? 'ok' : 'fail'}${result.skipped ? ' (skipped)' : ''}`);

      // Claude accepted (email matched the token identity) — clear any prior
      // email-mismatch warning so the popup banner disappears once collection works.
      await chrome.storage.local.remove('claudeEmailMismatch');
      // Same for the email-provider block, but keyed on a TOKEN rather than on any 2xx: the
      // [C1] guard fails OPEN on ingest when its D1 read times out (no 401), so a plain
      // api_key POST can be accepted while the account is still blocked — clearing there
      // would blink the CTA off for the length of a primary stall. A Bearer we sent, or a
      // token the server minted, is the only real proof of recovery (Codex review).
      if (sentToken || result?.ext_token) await clearAuthBlocked();
      // Version block: cleared on ANY 2xx, with no token condition — unlike the authBlocked case
      // above there is no fail-open to confuse a recovery with. The version gate does zero I/O
      // (pure env + ext_version, version-gate.ts), so an accepted POST is proof the gate no longer
      // rejects us — e.g. the operator lowered MIN_INGEST_VERSION or set the mode back to shadow.
      await clearUpgradeBlocked();

      // Confirmed Claude collection via a valid ext_token → if this is an email
      // (independent) account, upgrade it to 'claude' server-side (one-time) so it
      // doesn't get stranded when the ext_token later expires.
      await maybeLinkClaudeAccount(config, sentToken);

      // Store ext_token from server (TOFU issuance or refresh). No-downgrade: a refresh that
      // returns 'ingest' must not strip a logged-in user's 'full' token (Phase 2 단계 4).
      if (result.ext_token) {
        await setExtTokenNoDowngrade(result.ext_token);
      }
      // …and the inverse. A 200 with no ext_token, on a POST we sent WITHOUT one, means the
      // server withheld it (degraded [C1] guard read) and this install still has nothing — the
      // one case that used to fall through here silently and wait a full cycle.
      // `result` is already parsed, so pass it instead of making the helper re-clone.
      await noteTokenWithheld(response, sentToken, { result, email: body && body.user_email });

      // Apply server-provided poll_interval
      if (result.poll_interval_minutes && result.poll_interval_minutes > 0) {
        const serverInterval = result.poll_interval_minutes;
        await chrome.storage.local.set({ serverPollInterval: serverInterval });
        const { intervalExplicitlySet } = await chrome.storage.sync.get({ intervalExplicitlySet: false });
        if (!intervalExplicitlySet && bestPlan !== 'Free') {
          const currentInterval = config.intervalMinutes || DEFAULT_INTERVAL_MINUTES;
          if (serverInterval !== currentInterval) {
            console.log(`[Claude Tuner] Updating poll interval: ${currentInterval}m → ${serverInterval}m (server)`);
            await chrome.storage.sync.set({ intervalMinutes: serverInterval });
            chrome.alarms.create(ALARM_NAME, { delayInMinutes: serverInterval, periodInMinutes: serverInterval });
          }
        }
      }

      // Store server-tunable cadence override from THIS Claude response. The Claude
      // primary/extra paths POST via authedFetch directly (not postSnapshot), so they
      // need their own call — postSnapshot's call covers only ChatGPT/Gemini. Paths
      // are disjoint (Claude→authedFetch, providers→postSnapshot) so no double-apply.
      await applyServerCadence(result, Date.now(), { uuid: bestOrg?.uuid, provider: 'claude', account: body && body.user_email });

      // Save review nudge state
      if (result.review_nudge) {
        await chrome.storage.local.set({ ct_review_nudge: result.review_nudge });
      }
      // Save auto-approve setting
      if (result.admin_order_auto_approve !== undefined) {
        await chrome.storage.local.set({ ct_admin_order_auto_approve: result.admin_order_auto_approve });
      }

      // Handle plan change order (skip if already completed)
      if (result.plan_order) {
        const po = result.plan_order;
        const { completedPlanOrder: cpo } = await chrome.storage.local.get('completedPlanOrder');
        if (cpo && cpo.order_id === po.order_id) {
          console.log(`[Claude Tuner] Plan order #${po.order_id} already completed, skipping`);
        } else {
        console.log(`[Claude Tuner] Plan order received: #${po.order_id} ${po.from_plan} → ${po.to_plan} (auto_approve=${po.auto_approve})`);
        await chrome.storage.local.set({ pendingPlanOrder: po });
        // 🔴 A pending order no longer takes the badge or the icon (#994) — see bg/badge.js for
        // why. The sticky notification below is what replaces it, so WHO GETS IT matters more
        // than it used to. It used to be "manual orders only"; an auto order that FAILED fell
        // through to no notification at all, and relied on the next updateBadge() painting 📋.
        // That badge is gone, so a failed auto order would have been left with only the popup
        // banner — a surface the user has to think to open (Codex DEPLOY-BLOCKER). A failed auto
        // order is precisely the case that needs a person: the change did not happen and only
        // they can retry or reject it.
        let needsUserDecision = !po.auto_approve;
        let autoAttemptFailed = false;
        if (po.auto_approve) {
          console.log('[Claude Tuner] Auto-approving plan order');
          try {
            await acceptPlanOrder(config, po, userEmail, { auto: true });
          } catch (e) {
            console.error('[Claude Tuner] Auto plan order failed:', e.message);
            await reportPlanOrderResult(config, po.order_id, userEmail, 'accepted', 'failed', e.message);
          }
          // 🔴 ASK STORAGE WHAT HAPPENED, DO NOT INFER IT FROM CONTROL FLOW (Codex, 2nd pass).
          // The obvious version set this flag in the `catch` — and the catch almost never runs,
          // because executePlanChange() swallows the API failure and acceptPlanOrder() RETURNS
          // `{ success: false }` rather than throwing. So the flag stayed false on exactly the
          // path it existed for. (The guard that pinned it was a false green for the same reason:
          // it asserted the SHAPE `catch { ... = true }` instead of the outcome.)
          //
          // The outcome is legible in one place: acceptPlanOrder clears `pendingPlanOrder` when
          // the order is resolved — succeeded, or "already changed externally". Still set means
          // still stuck, whatever route it took to get there. That also covers a throw, a returned
          // failure, and any future third way, which is why it is a re-read and not a return code.
          const { pendingPlanOrder: stillPending } = await chrome.storage.local.get('pendingPlanOrder');
          if (stillPending) { needsUserDecision = true; autoAttemptFailed = true; }
        }
        if (needsUserDecision) {
          createCountedNotification('plan-order-' + po.order_id, {
            type: 'basic', iconUrl: 'icons/icon128.png',
            // 🔴 THE TWO NOTIFICATIONS MUST NOT DISAGREE. When the auto attempt failed, the user
            // has ALREADY been shown executePlanChange's "플랜 변경 실패" toast. Titling this one
            // "플랜 변경 요청" would then announce a brand-new request for a change that just
            // failed — two toasts telling different stories about one event. Same title, so this
            // reads as the actionable follow-up to the failure rather than a separate event.
            // (Composed from existing keys on purpose: new strings would need adding to BOTH
            // dictionaries plus a drift guard, which is #994 unit 3's work, not this one's.)
            title: await bt(autoAttemptFailed ? 'opt_fail_title' : 'po_title'),
            message: await bt('po_msg', po.org_name, po.from_plan, po.to_plan),
            buttons: [
              { title: await bt('po_accept') },
              { title: await bt('po_reject') },
            ],
            requireInteraction: true,
          }, 'plan-order');
          logNotification('plan-order');
        }
        }
      }

      // Update lastStatus with server recommendation (also refreshes badge)
      if (!result.skipped && result.recommendation) {
        // The server caches recs by email (~1h) without the plan in the key, so a plan-change
        // POST can return a rec computed for the prior plan. Drop such a stale actionable rec
        // before saving/badging so neither the card nor the badge shows it (non-actionable
        // recs like "adequate" are unaffected). Card is also guarded in ui/recommend.js.
        const rec = _recPlanStale(result.recommendation, snapshot.plan) ? null : result.recommendation;
        const curStatus = await getLastStatus();
        if (curStatus) {
          curStatus.recommendation = rec;
          await setStatus(curStatus);
        }
        // 🔴 The recommendation no longer touches the badge (#994 unit 2). Recompute the derived
        // notice state (the rec just changed), then repaint — updateBadge() decides the ICON, so
        // this pair keeps the percentage current AND lights or clears the marker. Order matters:
        // the paint reads what the refresh writes.
        await refreshRecNotice();
        await updateBadgeForSelectedOrg(snapshot);
      }

      // RETIRED (2026-09-01, #1080/#1081): history backfill — the whole mechanism, not just its
      // broken half. What used to sit here merged `result.recent_snapshots` from the snapshot POST
      // response into local history, with an `/api/me` fallback when the response carried none.
      // Both halves were dead, and the feature was measured before deleting rather than assumed:
      //
      //  1. The FALLBACK could never succeed (#1080). It asked `/api/me` with an ext_token, and
      //     `/api/me`+`/api/me/*` are mounted under googleAuthMiddleware (worker/src/index.ts),
      //     which takes ONLY `iss:'claudetuner'` session JWTs or Google ID tokens — an ext_token is
      //     `iss:'claudetuner-ext'`, so it 401'd by construction, ~6,234 times a day. Its own
      //     comment asserted the opposite, which is how the same mistake shipped three times
      //     (#745, #747, #1080). 🔴 Do NOT "fix" that by widening /api/me to ext_tokens: pre-enforce
      //     TOFU minted them for any claimed email and ~533 are still live, so that would let their
      //     holders read other people's usage (#764, watched by test/authz-guard.mjs).
      //  2. The RESPONSE branch was inert too. The worker stopped answering `need_history` in
      //     dc47d6b8 (2026-04-24) six hours after 3fb6830e added it, so `result.recent_snapshots`
      //     was never present. Backfill had been dead end-to-end for four months.
      //  3. Reviving it was rejected on EVIDENCE, not taste (#1081). Local history appends every
      //     alarm tick regardless of the send gate, and the 5h forecast needs 3 history points at
      //     the caller (calcPredictedAtReset, ui/prediction-core.js) of which 2 must span 30 min
      //     under a lookback that widens to Infinity (projectFlatWindow, ui/usage-tiers.js) — so a
      //     quiet account with an old history still gets a measured forecast, and only the first
      //     ~30 minutes after an install or a data reset are degraded (and even then
      //     windowAverageProjection feeds the SAME tier ladder). The 7d model has
      //     its own thin-data fallback and wants 48h of activity plus 14+ days of curve, which 6h
      //     of backfill cannot move. ⇒ reviving would have added a read to the ingest hot path to
      //     buy 30 minutes on one gauge.
      //  4. The trigger could not even find the people it was for: `need_history` fired on
      //     `recent6h.length < 30`, which at idle/dormant cadence is PERMANENTLY true (see the old
      //     HISTORY_BACKFILL_COOLDOWN_MS note), while the population whose forecast is actually
      //     degraded is "installed in the last half hour". It also forced a POST past the delta
      //     gate for everyone it fired on — a real cost paid for nothing.
      //
      // The legacy `historyEmptyUntil` storage key is deliberately NOT deleted from users'
      // profiles. Removing this code is reversible; wiping storage is not, and nobody reads it.
      // Pinned by test/ext-api-me-guard.mjs.
    }).catch((e) => {
      console.warn('[Claude Tuner] Server POST fire-and-forget error:', e.message);
      rollbackPrimary().catch(() => {}); // transient network failure → retry next tick
      noteServerFailure().catch(() => {}); // network failure → extend shared backoff
    });
    } // end authBlocked backoff guard (inner body intentionally left at its original indent so
      // the guard reads as a diff of one condition, not a reflow of 240 lines)
    } // end primary adaptive gate (primaryDue)

    // === Local UI update (don't wait for server response) ===
    const claudeTabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    const fetchMode = claudeTabs.length > 0 ? 'tab' : 'cookie';

    // Keep previous recommendation (will be async-updated when server response arrives)
    const prevStatus = await getLastStatus();
    let recommendation = prevStatus?.recommendation || null;
    // 🔴 ...but never carry forward one the user has dismissed. This write is a read-modify-write of
    // the whole container from a value read EARLIER, so a collect already in flight when the user
    // clicks "not now" writes the dismissed rec back AFTER the dismissal cleared it — the exact
    // symptom of #1004, re-created by ordering alone. Deciding it HERE, from the same stored record
    // both other readers use, makes the race unwinnable rather than merely unlikely.
    // Claude-scoped like the dismiss buttons; a non-Claude rec in this slot is carried as before.
    if (recommendation && (recommendation.provider || 'claude') === 'claude'
        && recDismissActive(await getRecDismiss())) {
      recommendation = null;
    }
    // Drop a stale actionable rec whose basis plan no longer matches the current snapshot
    // plan (the user changed plans since it was cached; server 24h-throttle + snapshot dedup
    // can leave the prior rec). Prevents a nonsensical card/badge (e.g. a Max 20x user seeing
    // a cached "upgrade to Max 5x") until the server returns a fresh rec.
    if (_recPlanStale(recommendation, snapshot.plan)) recommendation = null;

    await setStatus({
      success: true,
      timestamp: Date.now(),
      lastSuccessTimestamp: Date.now(),
      snapshot: snapshot,
      recommendation,
      fetchMode,
    });

    // Review nudge: track install date + success count
    chrome.storage.local.get({ ct_install_date: null, ct_success_count: 0 }, (r) => {
      const u = { ct_success_count: (r.ct_success_count || 0) + 1 };
      if (!r.ct_install_date) u.ct_install_date = Date.now();
      chrome.storage.local.set(u);

      // Update uninstall tracking URL
      const daysUsed = r.ct_install_date ? Math.floor((Date.now() - r.ct_install_date) / 86400000) : 0;
      const params = new URLSearchParams({
        email: snapshot.user_email || '',
        plan: snapshot.plan || '',
        v: chrome.runtime.getManifest().version,
        days: String(daysUsed),
        lang: snapshot.user_language || (chrome.i18n?.getUILanguage?.()?.startsWith('ko') ? 'ko' : 'en'),
      });
      chrome.runtime.setUninstallURL(`${DEFAULT_SERVER_URL}/api/uninstall?${params}`);
    });

    // 4-0.5 Sync notification permission & preferences to server (fire-and-forget, on change only)
    syncNotificationPermission(config, snapshot.user_email);
    syncNotificationPrefs(config, snapshot.user_email);

    // 4-1. Save local usage history (last 7 days, for sparkline + prediction)
    await appendUsageHistory(buildHistoryPoint(snapshot, plan));

    // 4-2. Update badge (based on previous recommendation, async-updated on server response)
    // One authority: updateBadge() decides the icon (hard block > unacknowledged recommendation >
    // normal) and the badge keeps the percentage. Refresh first — this path also rewrites
    // lastStatus, so the derived notice state has to catch up before the paint reads it.
    await refreshRecNotice();
    await updateBadgeForSelectedOrg(snapshot);

    // 4-3. Usage threshold alerts (use selected org data if pinned to non-Claude org)
    const selectedUsage = await getSelectedOrgUsage();
    if (selectedUsage) {
      await checkUsageAlerts({
        five_hour: { utilization: selectedUsage.h5 },
        seven_day: { utilization: selectedUsage.d7 },
      });
    } else {
      await checkUsageAlerts(snapshot);
    }

    // Server-signaled promo push (e.g. Product Hunt launch) — best-effort, deduped, throttled
    await checkPromoPush();

    sendGAEvent('collect_success', { plan: snapshot.plan, fetch_mode: fetchMode });
    // On success: reset heartbeat timer + clear error code + reset collect fail state.
    // HEARTBEAT_RETRY_KEY goes with it — a surviving backoff ladder would make the NEXT failure
    // episode start mid-ladder (up to a full hour of silence on its first heartbeat) for reasons
    // that stopped existing the moment collection worked again.
    chrome.storage.local.remove(['lastHeartbeatAt', HEARTBEAT_RETRY_KEY, 'collectFailState']);

    // === Multi-org collection: send all monitorable orgs; server-side 3-org cap
    // drops snapshots for orgs the user hasn't selected as active.
    if (!skipServer) {
      // RETIRED (2026-07-31): the legacy `selectedOrgIds` → server `selected_orgs` migration that
      // used to live here has been REMOVED, not fixed. Do not reintroduce it. Four facts, each
      // verified in code, make every version of it either useless or destructive:
      //
      //  1. It could never succeed. It PATCHed `/api/me/selected-orgs` with an ext_token, but
      //     `/api/me/*` is mounted under googleAuthMiddleware (worker index.ts), which accepts only
      //     `iss:'claudetuner'` session JWTs or Google ID tokens — an ext_token is
      //     `iss:'claudetuner-ext'`, so the call 401s by construction. `resp.ok` was unreachable.
      //  2. It had no terminal state, and that was DELIBERATE — the old comment said 401 need not be
      //     marked done because "authedFetch already cleared it → next cycle is tokenless → the
      //     getExtToken() gate skips". PR #745 stopped clearing tokens on a codeless 401, which
      //     removed that brake: the gate stayed open and this re-fired every collect cycle
      //     (~575 requests/hour, rising with rollout). The loop was the visible symptom.
      //  3. Nothing writes `selectedOrgIds` any more, so the value is frozen. options.js reads it
      //     into memory but never persists or sends it, and options.html no longer even renders the
      //     org checklist — that code is vestigial.
      //  4. Reviving it would be DESTRUCTIVE, which is why "just give it an endpoint that accepts
      //     ext_token" is the wrong fix. Org selection is now owned by the dashboard
      //     (PATCH /api/me/selected-orgs under Google auth). Replaying a months-old local list over
      //     it would overwrite the user's current choice — and for the many users whose
      //     `selected_orgs` is unset, ingest currently lets every org through, so writing a stale
      //     1-3 entry list would newly cap them and start DROPPING orgs they are collecting today.
      //
      // Retiring changes no behaviour: by (1) this never ran to completion for anyone, and the
      // extension does not read server `selected_orgs` to decide what to collect (it sends all
      // monitorable orgs below and lets the server decide what to persist).
      //
      // The legacy keys are deliberately NOT deleted. Removing this block is reversible; wiping a
      // user's storage is not, and it buys nothing — nobody reads them.
      // Pinned by test/selected-orgs-retired-guard.mjs.

      // Determine target orgs: exclude API + exclude Free if multi-org.
      // No client-side count cap — the server's selected_orgs decides what is
      // persisted; non-selected orgs come back as {skipped:true, skip_org:true}.
      const isMultiOrg = orgList.filter(o => detectPlan(o) !== 'API').length > 1;
      const monitorableOrgs = orgList.filter(o => {
        const p = detectPlan(o);
        if (p === 'API') return false;
        if (isMultiOrg && p === 'Free') return false;
        return true;
      });
      const targetOrgs = monitorableOrgs;

      // Collect additional orgs beyond primary (continue collecting other orgs on individual failure)
      // === Adaptive polling: secondary orgs adjust poll interval based on usage changes ===
      _ts = performance.now();
      const additionalOrgs = targetOrgs.filter(o => o.uuid !== bestOrg?.uuid);
      const successOrgs = [bestOrg?.uuid]; // primary already succeeded
      const orgUsageMap = {}; // Per-org usage storage (for popup chip display)
      orgUsageMap[bestOrg?.uuid] = {
        h5: snapshot.five_hour.utilization, d7: snapshot.seven_day.utilization,
        spendUsed: snapshot.extra_usage?.used_credits ?? null,
        spendLimit: snapshot.extra_usage?.monthly_limit ?? null,
        plan: plan, // bestPlan (seat_tier refinement done)
        resetsAt5h: snapshot.five_hour?.resets_at || null,
        resetsAt7d: snapshot.seven_day?.resets_at || null,
        extraUsage: snapshot.extra_usage || null,
      };
      const failedOrgs = [];
      const skippedOrgs = []; // Orgs skipped by adaptive polling

      // orgPollState / baseIntervalMs / now were loaded once in the primary-org
      // gate above; reuse the same in-memory map so primary + extra mutations are
      // persisted by the single set() below (no second get/set → no race).

      for (const extraOrg of additionalOrgs) {
        // Initialize poll state for new orgs
        if (!orgPollState[extraOrg.uuid]) {
          orgPollState[extraOrg.uuid] = getOrgPollDefault();
        }
        const pollState = orgPollState[extraOrg.uuid];

        // Check if this org is due for polling (skip if not, unless forced)
        if (!force && !isOrgDueForPoll(pollState, now, baseIntervalMs)) {
          skippedOrgs.push({ uuid: extraOrg.uuid, name: extraOrg.name, tier: pollState.tier });
          // Use cached values for popup display (don't remove from collectedOrgs)
          if (pollState.lastValues.h5 != null || pollState.lastValues.d7 != null || pollState.lastValues.extraUsed != null) {
            successOrgs.push(extraOrg.uuid);
            orgUsageMap[extraOrg.uuid] = {
              h5: pollState.lastValues.h5, d7: pollState.lastValues.d7,
              spendUsed: pollState.lastValues.extraUsed, spendLimit: null,
              plan: await refineTeamPlan(detectPlan(extraOrg), extraOrg.uuid),
              resetsAt5h: pollState.lastValues.resetsAt5h || null,
              resetsAt7d: pollState.lastValues.resetsAt7d || null,
              extraUsage: pollState.lastValues.extraUsage || null,
            };
          }
          continue;
        }

        try {
          const extraUsage = await fetchClaudeApi(`/api/organizations/${extraOrg.uuid}/usage`);
          if (!extraUsage) {
            failedOrgs.push({ uuid: extraOrg.uuid, name: extraOrg.name, reason: 'empty_usage' });
            continue;
          }

          let extraPlan = await refineTeamPlan(detectPlan(extraOrg), extraOrg.uuid);
          // Look up this org's seat_tier from allSeatTiers (for server submission)
          const acctCache = await chrome.storage.local.get({ accountCache: null });
          const extraSeatTier = acctCache.accountCache?.allSeatTiers?.[extraOrg.uuid] || null;

          // Adaptive polling: compare current values with previous
          const currentValues = {
            h5: extraUsage.five_hour?.utilization ?? null,
            d7: extraUsage.seven_day?.utilization ?? null,
            extraUsed: extraUsage.extra_usage?.used_credits ?? null,
            // Cache these for popup display when skipping future polls
            resetsAt5h: normalizeResetTime(extraUsage.five_hour?.resets_at) || null,
            resetsAt7d: normalizeResetTime(extraUsage.seven_day?.resets_at) || null,
            extraUsage: normalizeExtraUsage(extraUsage.extra_usage),
          };
          // Tier uses change-vs-last-poll (consecutive flat polls → back off).
          const usageChanged = hasOrgUsageChanged(pollState.lastValues, currentValues);
          orgPollState[extraOrg.uuid] = updateOrgPollState(pollState, currentValues, usageChanged);

          // Send gate (shared with primary/ChatGPT/Gemini) uses change-vs-last-SENT
          // — pollState is the pre-update reference; its lastValues is bumped every
          // poll for the tier, so the gate reads the separate lastSent* fields.
          const extraCadence = await getCadence(Date.now(), { uuid: extraOrg.uuid, provider: 'claude' });
          const { send: extraDue, changed: extraChanged, reason: extraGateReason } = shouldSendSnapshot(
            pollState.lastSentValues, pollState.lastSentAt, currentValues,
            { force, sendFloorMs: extraCadence.sendFloorMs, heartbeatFloorMs: extraCadence.heartbeatFloorMs },
          );

          const isPersonalExtra = !NON_PERSONAL_PLANS.some(t => extraPlan.startsWith(t));
          const extraSnapshot = {
            user_email: userEmail,
            plan: extraPlan,
            rate_limit_tier: extraOrg.rate_limit_tier || null,
            seat_tier: extraSeatTier,
            ext_version: extVersion,
            collected_at: new Date().toISOString(),
            subscription: isPersonalExtra ? await fetchSubscriptionInfo(extraOrg.uuid) : {},
            ...await buildUsageFields(extraUsage, config),
            grove_enabled: null,
            grove_detected: false,
            claude_org_uuid: extraOrg.uuid,
            claude_org_name: extraOrg.name || null,
            // Heartbeat = unchanged vs what the server last received (last sent),
            // matching the gate — NOT vs last poll, or a changed snapshot sent
            // after a rate-limited window would be mislabeled and re-deduped.
            is_heartbeat: !extraChanged,
            install_id: await getOrCreateInstallId(),
          };

          // Usage API success — populate orgUsageMap/successOrgs immediately (regardless of server POST result)
          successOrgs.push(extraOrg.uuid);
          orgUsageMap[extraOrg.uuid] = {
            h5: extraUsage.five_hour?.utilization ?? null, d7: extraUsage.seven_day?.utilization ?? null,
            spendUsed: extraUsage.extra_usage?.used_credits ?? null, spendLimit: extraUsage.extra_usage?.monthly_limit ?? null,
            plan: extraPlan,
            resetsAt5h: normalizeResetTime(extraUsage.five_hour?.resets_at) || null,
            resetsAt7d: normalizeResetTime(extraUsage.seven_day?.resets_at) || null,
            extraUsage: normalizeExtraUsage(extraUsage.extra_usage),
          };
          // Save extra org history too (for per-org view)
          await appendUsageHistory(buildHistoryPoint(extraSnapshot, extraPlan));
          const tierTag = orgPollState[extraOrg.uuid].tier !== 'active' ? ` [${orgPollState[extraOrg.uuid].tier}]` : '';
          console.log(`[Claude Tuner] Extra org snapshot: ${extraOrg.name} (${extraPlan})${tierTag}${extraChanged ? '' : ' [heartbeat]'}`);

          // Delta-gated server POST. Skip unchanged heartbeats the server would
          // only dedup; local history above is always kept.
          if (extraDue) {
            // Advance the send-state optimistically (persisted in the batch save
            // below). On a TRANSIENT failure roll it back so the next tick retries
            // — mirrors the primary path; otherwise a failed send would suppress
            // the next POST for a full heartbeat floor (1h).
            const prevSentValues = pollState.lastSentValues;
            const prevSentAt = pollState.lastSentAt;
            orgPollState[extraOrg.uuid] = { ...orgPollState[extraOrg.uuid], lastSentValues: currentValues, lastSentAt: Date.now() };
            const rollbackExtra = async () => {
              // Revert in-memory first: if the batch save at the end of the loop
              // hasn't run yet, it then persists the reverted state instead of the
              // optimistic advance. If it already ran, the storage write below
              // reverts the persisted copy. Covers both orderings.
              if (orgPollState[extraOrg.uuid]) {
                orgPollState[extraOrg.uuid] = { ...orgPollState[extraOrg.uuid], lastSentValues: prevSentValues, lastSentAt: prevSentAt };
              }
              const { orgPollState: cur = {} } = await chrome.storage.local.get({ orgPollState: {} });
              if (cur[extraOrg.uuid]) {
                cur[extraOrg.uuid] = { ...cur[extraOrg.uuid], lastSentValues: prevSentValues, lastSentAt: prevSentAt };
                await chrome.storage.local.set({ orgPollState: cur });
              }
            };
            // authBlocked backoff, same identity scoping as the primary POST. Checked here and
            // not inside simpleAuthedPost because that wrapper owes its caller a Response, and
            // every synthetic one misreports: a 2xx would run the caller's r.ok branch and clear
            // a 5xx backoff nothing recovered from, a non-2xx would log a failure for a request
            // that was never sent. The 426 block needs no check here — the top-level skipServer
            // gate already covers this whole loop.
            // The optimistic send-state advance above is left standing on purpose: a persistent
            // reject should back off, not re-arm an immediate resend (same rule as rollbackExtra).
            if (await isAuthBlockSuppressed(extraSnapshot && extraSnapshot.user_email)) {
              console.log(`[Claude Tuner] Extra org ${extraOrg.name}: auth blocked — POST backed off until login.`);
            } else {
            // Server POST: fire-and-forget. Preflight-free simple request
            // (auth in body) with authedFetch's 401 auto-clear semantics.
            simpleAuthedPost(config, `${config.serverUrl}/api/snapshots`,
              force ? { ...extraSnapshot, force: true } : extraSnapshot,
            ).then(r => {
              // 5xx/network → transient, roll back to retry. 4xx (401/403/410) →
              // persistent; leave advanced so we back off, not hammer.
              if (r && !r.ok) {
                console.warn(`[Claude Tuner] Extra org ${extraOrg.name} server: ${r.status}`);
                if (r.status >= 500) { rollbackExtra(); noteServerFailure().catch(() => {}); }
              } else if (r && r.ok) {
                noteServerSuccess().catch(() => {}); // healthy POST clears backoff
                // Extra-org responses used to be read for status ONLY, so an extra org could
                // never receive a cadence override — and with per-stream standby (design 안 B)
                // that would strand it at full cadence forever. Consume it here, scoped to
                // THIS org's stream. Failure is non-fatal (cadence stays as-is).
                r.json()
                  .then(body => applyServerCadence(body, Date.now(), { uuid: extraOrg.uuid, provider: 'claude', account: userEmail }))
                  .catch(() => {});
              }
            }).catch(e => {
              console.warn(`[Claude Tuner] Extra org ${extraOrg.name} POST failed:`, e.message);
              rollbackExtra();
              noteServerFailure().catch(() => {}); // network failure → extend shared backoff
            });
            } // end authBlocked backoff guard (inner body left at its original indent)
          } else {
            console.log(`[Claude Tuner] Extra org ${extraOrg.name} delta-gate skip (${extraGateReason})`);
          }
        } catch (e) {
          // 403/401 = removed from org, 429 = rate limited, etc. — continue collecting other orgs
          failedOrgs.push({ uuid: extraOrg.uuid, name: extraOrg.name, reason: e.message });
          console.warn(`[Claude Tuner] Extra org ${extraOrg.name} failed:`, e.message);
        }
      }

      // Clean up poll state for orgs no longer in targetOrgs. Always keep the
      // primary (bestOrg) — a multi-org Free primary is excluded from targetOrgs
      // but still has an active gate entry that must not be pruned.
      const activeOrgIds = new Set([bestOrg?.uuid, ...targetOrgs.map(o => o.uuid)]);
      for (const uuid of Object.keys(orgPollState)) {
        if (!activeOrgIds.has(uuid)) delete orgPollState[uuid];
      }
      await chrome.storage.local.set({ orgPollState });
      // Same cleanup for the per-stream cadence keys — an inert (TTL-expired) key is still a
      // key, and a user who rotates through orgs would accumulate them until storage writes
      // start failing silently. Only Claude streams are known here; ChatGPT/Gemini keys are
      // left alone (their own collectors own those uuids), and a stale one still self-drops
      // on its next read via the TTL sweep in getCadence.
      await pruneStreamCadence([
        ...[...activeOrgIds].filter(Boolean).map(uuid => ({ uuid, provider: 'claude' })),
        // Never prune other providers' keys from the Claude cycle.
        ...Object.keys(await chrome.storage.local.get(null))
          .filter(k => k.startsWith('ctStreamCadence_') && !k.startsWith('ctStreamCadence_claude|'))
          .map(k => {
            const [provider, uuid] = k.slice('ctStreamCadence_'.length).split('|');
            return { uuid, provider };
          }),
      ]);

      if (skippedOrgs.length > 0) {
        console.log(`[Claude Tuner] Adaptive skip: ${skippedOrgs.map(s => `${s.name}(${s.tier})`).join(', ')}`);
      }
      if (failedOrgs.length > 0) {
        console.log(`[Claude Tuner] Multi-org: ${successOrgs.length} ok, ${failedOrgs.length} failed:`,
          failedOrgs.map(f => `${f.name}(${f.reason})`).join(', '));
      }

      // Save collected org list (only successful orgs shown in popup, with usage data)
      // Preserve non-Claude orgs (ChatGPT/Gemini) — they are merged separately
      const { collectedOrgs: prevOrgsAll = [] } = await chrome.storage.local.get({ collectedOrgs: [] });
      const nonClaudeOrgs = prevOrgsAll.filter(o => o.provider && o.provider !== 'claude');
      // Preserve user's pinned primary org if it still exists
      const prevPrimaryUuid = prevOrgsAll.find(o => o.isPrimary)?.uuid;
      const collectedOrgsRaw = targetOrgs.filter(o => successOrgs.includes(o.uuid));
      const allNewUuids = [...collectedOrgsRaw.map(o => o.uuid), ...nonClaudeOrgs.map(o => o.uuid)];
      const primaryUuid = (prevPrimaryUuid && allNewUuids.includes(prevPrimaryUuid))
        ? prevPrimaryUuid : bestOrg?.uuid;
      const collectedOrgs = [];
      for (const o of collectedOrgsRaw) {
        collectedOrgs.push({
          uuid: o.uuid, name: o.name, plan: orgUsageMap[o.uuid]?.plan || await refineTeamPlan(detectPlan(o), o.uuid),
          provider: 'claude',
          isPrimary: o.uuid === primaryUuid,
          h5: orgUsageMap[o.uuid]?.h5 ?? null,
          d7: orgUsageMap[o.uuid]?.d7 ?? null,
          spendUsed: orgUsageMap[o.uuid]?.spendUsed ?? null,
          spendLimit: orgUsageMap[o.uuid]?.spendLimit ?? null,
          resetsAt5h: orgUsageMap[o.uuid]?.resetsAt5h ?? null,
          resetsAt7d: orgUsageMap[o.uuid]?.resetsAt7d ?? null,
          extraUsage: orgUsageMap[o.uuid]?.extraUsage ?? null,
          updatedAt: Date.now(),
        });
      }

      // Update isPrimary for non-Claude orgs to match the resolved primary
      const mergedNonClaude = nonClaudeOrgs.map(o => ({ ...o, isPrimary: o.uuid === primaryUuid }));
      await chrome.storage.local.set({ collectedOrgs: [...collectedOrgs, ...mergedNonClaude], failedOrgs: failedOrgs.length > 0 ? failedOrgs : null });
      _timings['7_extra_orgs'] = Math.round(performance.now() - _ts);
    }

    _timings['TOTAL'] = Math.round(performance.now() - _t0);
    console.log(`[Claude Tuner] ⏱️ Timing (ms):`, JSON.stringify(_timings));
    await noteClaudeCollected(claudeProviderEmail);
    return { success: true, snapshot };

  } catch (error) {
    const errorMsg = error.message || 'Unknown error';
    console.error('[Claude Tuner] Collection failed:', errorMsg);
    const prevStatus = await getLastStatus();
    await setStatus({
      error: errorMsg,
      timestamp: Date.now(),
      lastSuccessTimestamp: prevStatus?.lastSuccessTimestamp
        || (prevStatus?.success ? prevStatus?.timestamp : null),
      // 🔴 The gate is independent of whether THIS collection worked. Carrying the reason only on
      // the success path meant a failed Claude collect wrote a status with no `serverWithheld`,
      // and ui/render.js's "Claude failed but a provider has data" demotion then painted the
      // healthy green again — on an install that is sending nothing to the server. Observed live:
      // logging out of claude.ai turned "⚠ 로컬 전용" back into "✓ Gemini Work".
      // "Is my data reaching the server?" does not become No-and-then-Yes because a fetch failed.
      serverWithheld: await serverSyncWithheldReason(),
      // Same argument, same fix: the pause is independent of whether THIS collection worked, so a
      // failed collect must not write a status that reads "not paused".
      syncPaused: await isServerSyncPaused(),
    });

    // On collection failure: show error badge + check collect-fail notification
    updateBadgeError();
    await checkCollectFailNotification(errorMsg);

    // 🔴 THE REASON GOES ON THE SHARED `provider_collect_fail` AXIS, not on this event.
    // `error` carried `errorMsg.slice(0, 100)` — a raw API fragment, and never registered as a GA4
    // custom dimension, so it could not be queried at all: 208,135 events over two days
    // (2026-09-02..03) with an unreadable cause, and GA4 has no retroactive registration, so the
    // backlog stays unreadable forever (#1021 → #1143). It also meant Claude — the largest
    // population — was the one provider missing from the reason breakdown the other two have.
    //
    // This event stays as the UNTHROTTLED volume counter it has always been (its history is
    // continuous only if the name and cadence do not change); the reason is whitelisted, carries
    // no free text, and is throttled to once per reason per day like ChatGPT's and Gemini's.
    sendGAEvent('collect_fail');
    // 🔴 NOT AWAITED, and the reason is what comes NEXT in this block: the failure heartbeat, which
    // is what the server turns into a disconnection email. The reporter swallows its own rejections
    // but it still awaits a `chrome.storage.local.set`, and a storage write that hangs rather than
    // fails would hold this catch block open — converting a reported failure into a silent one,
    // which is the exact class of defect this change exists to remove (Codex DEPLOY-BLOCKER). Same
    // rule the GA send itself follows: telemetry never delays a collection cycle.
    reportClaudeCollectFail(error);

    // Send heartbeat at most once per HEARTBEAT_INTERVAL_MS (1 hour — this comment said "every 6
    // hours" until #980; the constant has been 1 h and the stale figure was live-misread once).
    // Notifies the server of connection failure state.
    try {
      const { lastHeartbeatAt, [HEARTBEAT_RETRY_KEY]: hbRetry } =
        await chrome.storage.local.get({ lastHeartbeatAt: null, [HEARTBEAT_RETRY_KEY]: null });
      if (isHeartbeatDue({ lastHeartbeatAt, retry: hbRetry })) {
        const cfg = await getConfig();
        if (cfg.serverUrl && cfg.apiKey) {
          const ver = chrome.runtime.getManifest().version;
          // 🔴 THE SAME RESOLVER THE COLLECTORS USE (#834). This used to be `accountCache?.email`
          // raw, which gave the heartbeat its own identity rule — and the resolver ranks the
          // ext_token ABOVE accountCache, so any install whose provider account differs from its
          // token identity sent one address to /api/snapshots and a different one here. The
          // snapshot passed, the heartbeat got 403 Email mismatch, and last_heartbeat_at /
          // last_error_code / ext_version stopped updating for 23 accounts/day — 22 of which were
          // ingesting normally at the time. Identity has ONE source; the heartbeat is not an
          // exception just because it carries no usage.
          //
          // 🔴 WHO SENDS IS UNCHANGED; ONLY WHAT IT REPORTS CHANGES. `accountCache?.email` stays
          // the send gate (Codex DEPLOY-BLOCKER). Calling the resolver unconditionally would let
          // it answer from `independentAccount` when there is no accountCache, so an install that
          // used to stay silent would start heartbeating — and with no ext_token that request goes
          // out on the SHARED API KEY, making the server emit an `hb_gate` row for it. `hb_gate`'s
          // shadow population is the input to the pending HEARTBEAT_IDENTITY_ENFORCE flip (#758);
          // silently enlarging it makes post-rollout counts incomparable to the baseline that
          // decision rests on. Fixing a reported identity must not redefine the measured population.
          const { accountCache } = await chrome.storage.local.get('accountCache');
          const hbEmail = accountCache?.email
            ? await resolveIngestIdentity(accountCache.email, await readLinkedCanonical(accountCache.email))
            : null;
          // 🔴 DELIBERATELY NOT GATED, unlike the snapshot paths. Codex flagged this as the one
          // shared-key write still landing while sync is withheld, and gating it was wrong on
          // three counts:
          //   1. ZERO security value. An attacker is not running this client, so refusing to send
          //      OUR heartbeat stops nobody who holds the public key — it only silences honest
          //      installs.
          //   2. It is not usage data. The silent downgrade this change exists to stop is USAGE
          //      being attributed to an unproven identity; a heartbeat writes last_heartbeat_at /
          //      last_error_code / ext_version and nothing else.
          //   3. It is the ONLY server-side trace a withheld install leaves. #775 was opened
          //      precisely because gated installs are invisible server-side, and cutting this
          //      would recreate that blind spot for the population we most need to count —
          //      last_error_code is how we size it.
          // 🔴 THE THROTTLE IS ARMED BY DELIVERY, NOT BY THE ATTEMPT (#980). `lastHeartbeatAt` used
          // to be stamped unconditionally, right here, outside the `if (hbEmail)` below and next to
          // a fire-and-forget fetch whose response was never read — so three different non-events
          // (no identity to send, a non-2xx answer, the worker dying before the request flushed)
          // each bought an hour of server-side silence. `await` is load-bearing for the third: the
          // failure path returns immediately and the alarm listener awaits collectAndSend, so
          // awaiting here is what keeps the MV3 worker alive long enough to flush the request.
          // See bg/heartbeat.js for why losing these specifically biases the numbers one way.
          let delivered = false;
          if (hbEmail) {
            delivered = await postHeartbeat(cfg, {
              email: hbEmail,
              errorCode: errorMsg.split(':')[0].slice(0, 50),
              extVersion: ver,
              // #1119 — the live pause state on EVERY heartbeat. See postHeartbeat's contract for
              // why this, and not the edge report, is what makes a stale server flag impossible.
              syncPaused: await isServerSyncPaused(),
            });
          }
          if (delivered) {
            await chrome.storage.local.set({ lastHeartbeatAt: Date.now() });
            await chrome.storage.local.remove(HEARTBEAT_RETRY_KEY);
          } else {
            // Undelivered: back off instead of consuming the success window. The ladder is capped
            // at HEARTBEAT_INTERVAL_MS (bg/heartbeat.js), so the worst case — an install the server
            // rejects forever — converges to the one-per-hour rate it already sends today.
            // nextHeartbeatRetry coerces the stored rung — a non-numeric `n` would floor the delay
            // to the base forever, i.e. the 12x amplification the cap exists to prevent.
            await chrome.storage.local.set({
              [HEARTBEAT_RETRY_KEY]: nextHeartbeatRetry(hbRetry, Date.now()),
            });
          }
        }
      }
    } catch (_) {}

    return { success: false, error: errorMsg };
  }
}
