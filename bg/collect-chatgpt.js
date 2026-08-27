import { fetchChatGPTApi, isChatGPTLoggedIn } from './api-chatgpt.js';
import { normalizeResetTime } from './api.js';
import { getConfig, appendUsageHistory, postSnapshot, getOrCreateInstallId, resolveIngestIdentity } from './storage.js';
import { gateProviderSnapshot, shouldForceProviderPost } from './send-gate.js';

// Capitalize first letter: "plus" → "Plus"
function capitalizeFirst(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Map raw ChatGPT plan_type codes to intuitive display names.
// 'prolite' = the $100 Pro tier (5x Plus quota, launched 2026-04); 'pro' = $200 Pro (20x Plus).
const CHATGPT_PLAN_NAMES = {
  free: 'Free', go: 'Go', plus: 'Plus', prolite: 'Pro 5x', pro: 'Pro 20x',
  team: 'Team', business: 'Business', enterprise: 'Enterprise',
  education: 'Education', k12: 'Education (K-12)',
};
function chatgptPlanName(code) {
  return CHATGPT_PLAN_NAMES[(code || 'free').toLowerCase()] || capitalizeFirst(code || 'free');
}

// Map account-level plan codes from accounts/check to display names. These differ
// from /wham/usage's `plan_type`: workspaces carry an `entitlement.subscription_plan`
// (e.g. 'chatgptteamplan') and an account `plan_type` that can be a billing-shape
// code (e.g. 'self_serve_business_usage_based') rather than a plain tier code.
const CHATGPT_SUBSCRIPTION_PLAN_NAMES = {
  chatgptfreeplan: 'Free', chatgptfreeworkspaceplan: 'Free', chatgptgoplan: 'Go',
  chatgptplusplan: 'Plus', chatgptprolite: 'Pro 5x', chatgptpro: 'Pro 20x',
  chatgptteamplan: 'Team', chatgptbusinessplan: 'Business', chatgptenterpriseplan: 'Enterprise',
};
const CHATGPT_ACCOUNT_PLAN_TYPE_NAMES = {
  self_serve_business_usage_based: 'Business',
};

// Derive a workspace's display plan without a per-workspace /wham/usage call:
// prefer the entitlement's subscription_plan, then the account plan_type, then
// fall back to the generic tier-code mapping.
export function chatgptWorkspacePlan(entitlement, accountPlanType) {
  const sub = entitlement?.subscription_plan;
  if (sub && CHATGPT_SUBSCRIPTION_PLAN_NAMES[sub]) return CHATGPT_SUBSCRIPTION_PLAN_NAMES[sub];
  const pt = (accountPlanType || '').toLowerCase();
  if (CHATGPT_ACCOUNT_PLAN_TYPE_NAMES[pt]) return CHATGPT_ACCOUNT_PLAN_TYPE_NAMES[pt];
  return chatgptPlanName(accountPlanType);
}

// Parse a scheduled plan change ("plan changes to X on date Y") from an accounts/check
// account object. ChatGPT exposes it under `entitlement.scheduled_plan_change` (the same
// per-account object that carries `renews_at`): `plan_type` is the target tier code (e.g.
// 'plus') and `changes_at` is the effective date — the pair the ChatGPT UI renders as
// "플랜이 <date>에 <plan>(으)로 변경됩니다". Verified against a live accounts/check response
// (2026-07-21). Mirrors the Claude collector's `scheduled_downgrade` handling (bg/plan.js)
// so the server/dashboard treat both providers' pending plan changes identically. Returns
// the plan as a mapped display label (e.g. 'Plus') so it passes through the dashboard's
// Claude-only PLAN_LABEL unchanged.
export function parseChatGPTScheduledChange(acc) {
  const spc = acc?.entitlement?.scheduled_plan_change;
  // Defensive: a non-string plan_type would throw in chatgptPlanName().toLowerCase(),
  // dropping the whole roster parse; a malformed-but-truthy changes_at would be stored and
  // render as "NaN/NaN" on the dashboard. Validate both — plan_type gates the whole change,
  // an unparseable date is nulled (plan still shows, just without a date).
  if (!spc || typeof spc.plan_type !== 'string' || !spc.plan_type) {
    return { pendingPlan: null, pendingChangeDate: null };
  }
  const changesAt = typeof spc.changes_at === 'string' && !Number.isNaN(Date.parse(spc.changes_at))
    ? spc.changes_at
    : null;
  return {
    pendingPlan: chatgptPlanName(spc.plan_type),
    pendingChangeDate: changesAt,
  };
}

// Convert Unix timestamp (seconds) to ISO string, then normalize to minute precision
function unixToResetTime(ts) {
  if (!ts) return null;
  return normalizeResetTime(new Date(ts * 1000).toISOString());
}

// accounts/check exposes the full multi-workspace roster (one entry per account
// UUID plus a `default` alias for the session's active account) — and it's the
// only source of the next-billing ("renewal") date and any scheduled plan change,
// which /wham/usage omits.
//
// TTL is 1h (the send heartbeat floor), NOT the former 24h. That staleness bit us in
// practice (2026-07-22): the cache stores the PARSED roster, so it pinned a
// pre-scheduling / pre-parser-fix null-pending parse for a full day — every automatic
// send carried pending=null while the popup showed the change from an earlier good
// parse, and the scheduled change was never stored server-side before it applied.
// One authenticated GET per hour per browser is trivial (the ChatGPT webapp itself
// calls accounts/check far more often), so keep the roster no staler than a heartbeat.
const ROSTER_TTL_MS = 60 * 60 * 1000; // 1h — matches SEND_HEARTBEAT_FLOOR_MS
const ROSTER_CACHE_KEY = 'chatgptAccountsRoster';
// Bound how many extra workspaces we enumerate/send, so a profile signed into many
// accounts can't fan out unboundedly.
const MAX_EXTRA_WORKSPACES = 5;

/**
 * Parse an accounts/check response into a roster the collector can act on.
 *
 * ChatGPT's `/wham/usage` is scoped to a single account (the JWT's active
 * account), so per-workspace usage needs per-account tokens — deferred. What we
 * CAN enumerate cheaply from accounts/check is every workspace's plan + renewal.
 *
 * Returns { defaultAccountId, defaultRenewal, workspaces: [...] } where
 * `workspaces` excludes:
 *   - the active/default account (already collected with usage via /wham/usage),
 *   - deactivated accounts (expired/left workspaces — "unused orgs" we skip),
 *   - accounts the current session can't access.
 */
export function parseAccountsRoster(data) {
  const accounts = data?.accounts || {};
  const def = accounts.default || null;
  // The `default` alias carries the real account UUID of the active account, which
  // lets us exclude it from the extra-workspace list (its usage comes from /wham/usage).
  const defaultAccountId = def?.account?.account_id || null;
  const defaultRenewal = def?.entitlement?.renews_at || null;
  const defaultPending = parseChatGPTScheduledChange(def);

  const order = Array.isArray(data?.account_ordering) && data.account_ordering.length
    ? data.account_ordering
    : Object.keys(accounts).filter((k) => k !== 'default');

  const workspaces = [];
  for (const id of order) {
    const a = accounts[id];
    const acc = a?.account;
    if (!acc) continue;
    if (acc.account_id === defaultAccountId) continue; // active account → /wham/usage handles it
    if (acc.is_deactivated) continue;                  // expired/left workspace → skip (unused)
    if (a.can_access_with_session === false) continue; // session can't read this account
    workspaces.push({
      accountId: acc.account_id,
      name: acc.name || null,
      structure: acc.structure || null, // 'workspace' | 'personal'
      plan: chatgptWorkspacePlan(a.entitlement, acc.plan_type),
      renewal: a.entitlement?.renews_at || null,
      hasActiveSubscription: !!a.entitlement?.has_active_subscription,
      ...parseChatGPTScheduledChange(a),
    });
  }
  return {
    defaultAccountId,
    defaultRenewal,
    defaultPendingPlan: defaultPending.pendingPlan,
    defaultPendingChangeDate: defaultPending.pendingChangeDate,
    workspaces,
  };
}

// The roster's `defaultAccountId`/`defaultRenewal` and its active-account exclusion
// are all relative to whichever account was active when accounts/check was fetched.
// If the user switches ChatGPT account/workspace within the TTL, a cache keyed only
// by time would be stale: the now-active account (fresh in /wham/usage) would still
// be listed as an "extra" workspace (→ duplicate null-usage snapshot) and the primary
// org would carry the previous account's renewal date. So bust the cache whenever the
// active-account fingerprint (usage account id + plan) changes, not just on TTL.
//
// `forceRefresh` (a user-manual "수집" click) bypasses the cache entirely so a
// just-scheduled plan change — which does NOT move the account/plan fingerprint and so
// wouldn't otherwise bust the cache — is picked up on the same cycle instead of waiting
// out the TTL.
//
// The cache entry is stamped with the extension version (`extVer`): what's cached is the
// PARSED roster, so without the stamp a parser fix keeps serving the OLD code's output
// until the TTL expires — exactly how the scheduled-plan-change parse fix (PR#623) sat
// invisible behind a cached null-pending parse (2026-07-22 incident). A version mismatch
// forces a refetch so new parser code always takes effect on its first cycle.
async function getChatGPTAccountsRoster(activeAccountId, activePlanType, forceRefresh = false) {
  const extVer = chrome.runtime.getManifest().version;
  const cached = (await chrome.storage.local.get({ [ROSTER_CACHE_KEY]: null }))[ROSTER_CACHE_KEY];
  if (!forceRefresh
      && cached?.roster
      && cached.extVer === extVer
      && cached.activeAccountId === activeAccountId
      && cached.activePlanType === activePlanType
      && (Date.now() - cached.fetchedAt) < ROSTER_TTL_MS) {
    return cached.roster;
  }
  try {
    const data = await fetchChatGPTApi('/backend-api/accounts/check/v4-2023-04-27');
    const roster = parseAccountsRoster(data);
    // One line per (at most hourly) refresh: what the LIVE response carried. This is the
    // signal that was missing while diagnosing the null-pending incident — it separates
    // "the API didn't return a scheduled change" from "we parsed/sent it wrong" at a glance.
    console.log(`[Claude Tuner] ChatGPT roster refreshed: pending=${roster.defaultPendingPlan || 'none'}${roster.defaultPendingChangeDate ? ` @ ${roster.defaultPendingChangeDate}` : ''}, renewal=${roster.defaultRenewal || 'none'}, workspaces=${roster.workspaces.length}`);
    await chrome.storage.local.set({
      [ROSTER_CACHE_KEY]: { roster, fetchedAt: Date.now(), extVer, activeAccountId, activePlanType },
    });
    return roster;
  } catch (e) {
    console.warn('[Claude Tuner] ChatGPT accounts roster fetch failed:', e.message);
    // Reuse a stale roster if we have one; otherwise report an empty roster so the
    // active account (collected separately via /wham/usage) still goes through. Pending is
    // `undefined` (UNKNOWN), NOT null: we couldn't read accounts/check, so we must not let the
    // send gate read a fetch failure as "pending cancelled" and force-store a spurious NULL over a
    // real scheduled change (send-gate.js treats undefined as unknown → no trigger).
    return cached?.roster || { defaultAccountId: null, defaultRenewal: null, defaultPendingPlan: undefined, defaultPendingChangeDate: undefined, workspaces: [] };
  }
}

// Window lengths (seconds) used to classify a rate-limit window by its span
// rather than by its position in the response. ChatGPT no longer guarantees
// primary_window == 5h / secondary_window == 7d: some plans (e.g. Pro 5x
// 'prolite') expose only the 7d window as `primary_window` with a null
// secondary. Classifying by `limit_window_seconds` keeps 5h/7d correct
// regardless of which slot each window arrives in.
const WINDOW_5H_SECONDS = 5 * 60 * 60;   // 18000
const WINDOW_7D_SECONDS = 7 * 24 * 60 * 60; // 604800
// Halfway (in log space) between 5h and 7d — a window shorter than this is
// treated as the 5h window, longer as the 7d window.
const WINDOW_SPLIT_SECONDS = Math.round(Math.sqrt(WINDOW_5H_SECONDS * WINDOW_7D_SECONDS));

// The reported length of a window, or null when the provider did not say.
//
// 🔴 The slot a window lands in is NOT its length. ChatGPT Free/Go report a 30-DAY window, which
// classifyWindows() below correctly files in the 7d slot (there is nowhere else for it to go) —
// but reading that slot as "7 days" is then false for 1,018 users. Keeping the span as a VALUE is
// what lets a consumer label and reason about the real window, instead of guessing from the
// provider or plan name (which is wrong in both directions — see #952).
// See #954 and docs/DESIGN-window-span-preservation.md.
export function windowSpan(w) {
  const s = w?.limit_window_seconds;
  return typeof s === 'number' && isFinite(s) && s > 0 ? s : null;
}

// Pick the 5h and 7d windows out of the rate_limit object by their span.
function classifyWindows(rateLimit) {
  const primary = rateLimit?.primary_window || null;
  const secondary = rateLimit?.secondary_window || null;
  let w5h = null;
  let w7d = null;
  const spanless = [];
  // First pass: classify every window that carries a usable span.
  for (const w of [primary, secondary]) {
    if (!w) continue;
    const span = w.limit_window_seconds;
    if (typeof span !== 'number') { spanless.push(w); continue; }
    if (span < WINDOW_SPLIT_SECONDS) w5h = w;
    else w7d = w;
  }
  // Second pass: fill still-empty slots from spanless windows using the legacy
  // positional assumption (primary=5h, secondary=7d), without ever overwriting
  // a span-classified result. Handles fully-legacy and mixed old/new shapes.
  if (spanless.length) {
    if (!w5h && primary && spanless.includes(primary)) w5h = primary;
    if (!w7d && secondary && spanless.includes(secondary)) w7d = secondary;
  }
  return { w5h, w7d };
}

// Bound how many extra limit buckets we surface, so a future response with many
// metered features can't bloat the popup.
const MAX_ADDITIONAL_LIMITS = 5;

// ChatGPT exposes per-feature rate-limit buckets alongside the main plan window in
// `usage.additional_rate_limits[]` — e.g. Codex's own weekly limit
// ({ limit_name:'GPT-5.3-Codex-Spark', metered_feature:'codex_bengalfox',
//    rate_limit:{ primary_window:{ used_percent, reset_at, limit_window_seconds } } }).
// Each bucket is shaped like a usage window; surface the meaningful window's
// percent + reset so the popup can render a gauge per bucket. Pure — no I/O.
export function parseAdditionalLimits(usage) {
  const arr = Array.isArray(usage?.additional_rate_limits) ? usage.additional_rate_limits : [];
  const out = [];
  for (const item of arr) {
    const rl = item?.rate_limit;
    const w = rl?.primary_window || rl?.secondary_window || null;
    const used = w?.used_percent;
    if (typeof used !== 'number') continue; // skip buckets without a usable window
    out.push({
      name: item.limit_name || item.metered_feature || 'Limit',
      feature: item.metered_feature || null,
      used,
      resetsAt: unixToResetTime(w.reset_at),
      windowSeconds: typeof w.limit_window_seconds === 'number' ? w.limit_window_seconds : null,
    });
    if (out.length >= MAX_ADDITIONAL_LIMITS) break;
  }
  return out;
}

// Select the model-scoped WEEKLY bucket (e.g. Codex 'GPT-5.3-Codex-Spark') from the
// per-feature limits and shape it like Claude's weekly_scoped slot
// ({ utilization, resets_at, model }) so it can ride the shared `seven_day_omelette`
// slot. Prefer a 7d-span bucket; fall back to the first bucket when spans are absent.
// Returns null when there is no usable scoped weekly bucket. Pure — no I/O.
function pickScopedWeekly(additionalLimits) {
  if (!Array.isArray(additionalLimits) || !additionalLimits.length) return null;
  // Non-model buckets that ride the same additional_rate_limits array (observed
  // 2026-08-22: OpenAI's banked-reset pool 'gpt-reserve', #926). They are not model
  // weekly limits, so they must neither occupy the scoped slot nor outrank a real model
  // bucket when both are present; the popup still shows them via parseAdditionalLimits.
  // Kept INSIDE the function: scripts/scoped-weekly-slots.test.mjs compiles this body in
  // isolation, so an outer constant would have to be stubbed there and could drift.
  const NON_MODEL_LIMIT_NAMES = ['gpt-reserve'];
  const isModelBucket = (b) => NON_MODEL_LIMIT_NAMES.indexOf(b.name) < 0;
  const weekly = additionalLimits.find((b) => typeof b.windowSeconds === 'number'
    && b.windowSeconds >= WINDOW_SPLIT_SECONDS && isModelBucket(b));
  // Fall back to the first bucket ONLY when NO bucket carries span metadata (legacy
  // shape). If spans exist but none is weekly, there is no weekly bucket → return null;
  // never mis-persist a 5h bucket into the 7d (omelette) slot.
  const hasSpans = additionalLimits.some((b) => typeof b.windowSeconds === 'number');
  const chosen = weekly || (hasSpans ? null : additionalLimits.find(isModelBucket) || null);
  if (!chosen || typeof chosen.used !== 'number') return null;
  return { utilization: chosen.used, resets_at: chosen.resetsAt || null, model: chosen.name || null };
}

/**
 * Collect ChatGPT usage data.
 * Returns { success, orgs: [{ uuid, name, plan, provider, isPrimary, h5, d7, ... }] }
 * Fails silently (returns empty orgs) if user is not logged into ChatGPT.
 */
export async function collectChatGPT(force = false, userManual = false) {
  const loggedIn = await isChatGPTLoggedIn();
  if (!loggedIn) {
    return { success: false, orgs: [] };
  }

  try {
    const usage = await fetchChatGPTApi('/backend-api/wham/usage');

    if (!usage?.rate_limit) {
      console.warn('[Claude Tuner] ChatGPT: unexpected /wham/usage response');
      return { success: false, orgs: [] };
    }

    const { w5h, w7d } = classifyWindows(usage.rate_limit);
    const plan = chatgptPlanName(usage.plan_type);
    const accountId = usage.account_id || usage.user_id || 'unknown';
    const email = usage.email || null;

    // One accounts/check fetch (cached ~daily, but busted when the active account
    // changes) gives both the active account's renewal date and the full workspace
    // roster for multi-org enumeration. A user-manual "수집" refetches it now, so a
    // just-scheduled plan change lands on this cycle rather than waiting out the 24h roster TTL.
    // Only userManual busts the cache — NOT an automatic `force`, which for this provider comes
    // from an unrelated Claude trigger (e.g. a Claude 429) and shouldn't hit accounts/check.
    const roster = await getChatGPTAccountsRoster(accountId, usage.plan_type, userManual);
    const renewalDate = roster.defaultRenewal;

    const org = {
      uuid: accountId,
      name: email || 'ChatGPT',
      email: email || null, // provider account email (shown in the popup footer)
      plan: plan,
      provider: 'chatgpt',
      isPrimary: false,
      h5: w5h?.used_percent ?? null,
      d7: w7d?.used_percent ?? null,
      resetsAt5h: unixToResetTime(w5h?.reset_at),
      resetsAt7d: unixToResetTime(w7d?.reset_at),
      // Reported window lengths. `w7s` is 2592000 (30 days) for Free/Go and 604800 for everyone
      // else — the popup labels from this rather than assuming the slot's nominal length (#954).
      w5s: windowSpan(w5h),
      w7s: windowSpan(w7d),
      renewalDate, // next-billing date (accounts/check entitlement.renews_at); may be null
      // Scheduled plan change from accounts/check entitlement.scheduled_plan_change
      // (e.g. "changes to Plus on 7/22"); null when no downgrade/change is scheduled.
      pendingPlan: roster.defaultPendingPlan || null,
      pendingChangeDate: roster.defaultPendingChangeDate || null,
      spendUsed: null,
      spendLimit: null,
      extraUsage: null,
      // Per-feature limit buckets (e.g. Codex weekly) — display-only, popup gauges.
      additionalLimits: parseAdditionalLimits(usage),
    };

    // Append to local usage history (for chart display)
    await appendUsageHistory({
      t: Date.now(),
      h5: org.h5,
      d7: org.d7,
      p: plan,
      r7: org.resetsAt7d,
      org: org.uuid,
      eu: null,
      el: null,
    });

    // Send snapshot to server — delta-gated (shared with Claude collectors).
    // Skip unchanged heartbeats the server would only dedup; local history above
    // is always kept so the popup chart stays continuous. Returned org is
    // unaffected, so popup/merge display is independent of the gate.
    // `plan` + `pendingPlan` + `pendingChangeDate` opt this gate into plan/pending-change detection
    // (send-gate.js): a scheduled plan change carries no usage delta, so without these it would only
    // ride the heartbeat and could be dropped by the server's usage-only dedup. The pending fields
    // come from the RAW roster (not org.*, which coerces `|| null`) so a fetch-failure roster's
    // `undefined` stays UNKNOWN and the gate doesn't read it as a cancellation.
    const gateValues = { h5: org.h5, d7: org.d7, extraUsed: null, resetsAt5h: org.resetsAt5h, resetsAt7d: org.resetsAt7d, plan: org.plan, pendingPlan: roster.defaultPendingPlan, pendingChangeDate: roster.defaultPendingChangeDate };
    const gate = await gateProviderSnapshot(org.uuid, gateValues, { force, provider: 'chatgpt', userManual });
    if (gate.send) {
      // Commit only on a confirmed-successful POST so a failed send leaves the
      // gate unadvanced and the next cycle retries (no silent drop of a change).
      const res = await sendChatGPTSnapshot(org, email, plan, { force: shouldForceProviderPost(gate.reason, userManual) }).catch(e => {
        console.warn('[Claude Tuner] ChatGPT snapshot send failed:', e.message);
        return null;
      });
      if (res) {
        await gate.commit();
        // Mirror the skip log for the sent case, WITH the subscription fields the payload
        // carried — a successful send being silent is what made the null-pending incident
        // undiagnosable from the SW console.
        console.log(`[Claude Tuner] ChatGPT snapshot sent (${gate.reason}, pending=${org.pendingPlan || 'none'})`);
      }
    } else {
      console.log(`[Claude Tuner] ChatGPT delta-gate skip (${gate.reason})`);
    }

    // Extra workspaces (Phase 1): enumerate every active, accessible workspace the
    // user belongs to beyond the active account. Per-workspace usage needs a
    // per-account token (/wham/usage is scoped to the JWT's active account), so
    // these carry plan + renewal only — usage stays null until a later phase.
    const extraOrgs = roster.workspaces.slice(0, MAX_EXTRA_WORKSPACES).map((ws) => ({
      uuid: ws.accountId,
      name: ws.name || 'ChatGPT Workspace',
      email: email || null,
      plan: ws.plan,
      provider: 'chatgpt',
      isPrimary: false,
      h5: null,
      d7: null,
      resetsAt5h: null,
      resetsAt7d: null,
      // Usage is null for extra workspaces (per-account token needed), so there is no window
      // either — stated explicitly so org-merge does not carry a stale span forward.
      w5s: null,
      w7s: null,
      renewalDate: ws.renewal,
      pendingPlan: ws.pendingPlan || null,
      pendingChangeDate: ws.pendingChangeDate || null,
      spendUsed: null,
      spendLimit: null,
      extraUsage: null,
    }));

    for (const ex of extraOrgs) {
      // Gate per workspace uuid so unchanged workspaces only re-send on the
      // heartbeat floor (with usage null there's never a "changed" trigger).
      const exGate = await gateProviderSnapshot(
        ex.uuid,
        { h5: null, d7: null, extraUsed: null, resetsAt5h: null, resetsAt7d: null, plan: ex.plan, pendingPlan: ex.pendingPlan, pendingChangeDate: ex.pendingChangeDate },
        { force, provider: 'chatgpt', userManual },
      );
      if (!exGate.send) continue;
      // A workspace is never the user's primary data source, so force is_extra_org
      // even for ChatGPT-only users (must not overwrite the users row's plan). A
      // plan/pending change (or a user-manual collect) marks the POST force so the server
      // stores it rather than deduping this usage-null workspace heartbeat.
      const res = await sendChatGPTSnapshot(ex, email, ex.plan, { forceExtraOrg: true, force: shouldForceProviderPost(exGate.reason, userManual) }).catch((e) => {
        console.warn('[Claude Tuner] ChatGPT workspace snapshot send failed:', e.message);
        return null;
      });
      if (res) await exGate.commit();
    }

    return { success: true, orgs: [org, ...extraOrgs] };
  } catch (e) {
    console.warn('[Claude Tuner] ChatGPT collection failed:', e.message);
    return { success: false, orgs: [] };
  }
}

// Send ChatGPT snapshot to server (same /api/snapshots endpoint)
// Uses ext_token email (Claude email) as user_email for server identity,
// preserves ChatGPT email in provider_email for reference.
async function sendChatGPTSnapshot(org, chatgptEmail, plan, { forceExtraOrg = false, force = false } = {}) {
  const config = await getConfig();
  if (!config.serverUrl) return;

  // Server identity — ONE rule for every collector, in bg/storage.js (see
  // docs/DESIGN-authenticated-attribution.md). The ext_token identity now wins: if this install
  // proved it is A, this provider's usage belongs to A even though the ChatGPT account is B.
  // `accountCache` is still read here for isExtraOrg below (a Claude account means this
  // provider is an extra org, which is a different question from identity).
  const { accountCache } = await chrome.storage.local.get({ accountCache: null });
  const serverEmail = await resolveIngestIdentity(chatgptEmail);
  if (!serverEmail) {
    console.warn('[Claude Tuner] ChatGPT snapshot skipped: no email (no Claude/independent account and no ChatGPT email)');
    return;
  }

  // When there is no Claude account, this provider is the user's primary data,
  // so the snapshot must maintain the users row (current_plan, last_seen_at).
  // For Claude users it's an "extra org" that must not overwrite current_plan.
  // Extra ChatGPT workspaces are never primary data, so callers force this true.
  const isExtraOrg = forceExtraOrg || !!accountCache?.email;

  const extVersion = chrome.runtime.getManifest().version;

  const payload = {
    user_email: serverEmail,
    plan: plan,
    collected_at: new Date().toISOString(),
    ext_version: extVersion,
    // `window_seconds` is additive and OPTIONAL: today's server ignores it, and Phase 2 of
    // docs/DESIGN-window-span-preservation.md persists it. Sending it now means that when the
    // server side ships, the clients already updated are contributing spans immediately instead
    // of waiting out a second CWS review. Absent/null on old clients → NULL column, which every
    // consumer must read as "not reported" (§7 of that doc).
    five_hour: {
      utilization: org.h5,
      resets_at: org.resetsAt5h,
      window_seconds: org.w5s ?? null,
    },
    seven_day: {
      utilization: org.d7,
      resets_at: org.resetsAt7d,
      window_seconds: org.w7s ?? null,
    },
    claude_org_uuid: org.uuid,
    provider: 'chatgpt',
    provider_email: chatgptEmail || null,
    is_extra_org: isExtraOrg,
    install_id: await getOrCreateInstallId(),
    // Force = "store, don't dedup": the server's usage-only dedup (sig cache / D1) keys on
    // h5/d7/r7, so a plan/pending change with flat usage would otherwise be dropped. Set only on
    // plan/pending-change or user-manual sends (shouldForceProviderPost) — flat heartbeats stay dedupable.
    ...(force ? { force: true } : {}),
  };

  // Model-scoped weekly limit (e.g. Codex 'GPT-5.3-Codex-Spark') rides the shared
  // `seven_day_omelette` slot — same slot Claude reuses for its weekly_scoped model.
  // The `model` name is transient (server epoch metadata keys it by provider; the
  // snapshot row stores only utilization/resets_at). Only the primary org carries
  // additionalLimits; extra workspaces have none → slot stays unset.
  const scopedWeekly = pickScopedWeekly(org.additionalLimits);
  if (scopedWeekly) payload.seven_day_omelette = scopedWeekly;

  // Attach the next-billing date and any scheduled plan change so the server persists
  // them on this org's snapshot row (same `subscription` shape the Claude collector
  // uses). The server keeps `users.renewal_date`/`users.pending_plan` Claude-only, so
  // these never overwrite a Claude renewal/pending; the per-(org,provider) snapshot row
  // is what the dashboards read for ChatGPT.
  if (org.renewalDate || org.pendingPlan) {
    payload.subscription = {};
    if (org.renewalDate) payload.subscription.renewal_date = org.renewalDate;
    if (org.pendingPlan) {
      payload.subscription.pending_plan = org.pendingPlan;
      payload.subscription.pending_change_date = org.pendingChangeDate || null;
    }
  }

  // Shared helper handles auth recovery (401/403), account deletion (410),
  // and ext_token rotation — critical for independent accounts whose provider
  // snapshots are their only server contact. Returns the server result on
  // success, or null on any failure (caller uses this to gate the commit).
  return await postSnapshot(config, payload);
}
