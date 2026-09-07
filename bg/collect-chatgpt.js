import { fetchChatGPTApi, isChatGPTLoggedIn } from './api-chatgpt.js';
import { normalizeResetTime } from './api.js';
import { getConfig, appendUsageHistory, postSnapshot, getOrCreateInstallId, resolveIngestIdentity } from './storage.js';
import { gateProviderSnapshot, shouldForceProviderPost } from './send-gate.js';
import { noteProviderAttempt, noteProviderSuccess, noteProviderError,
         noteProviderSendError, noteProviderSendOk } from './provider-state.js';

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
 *   - the account /wham/usage just collected, under EITHER identifier (see below),
 *   - deactivated accounts (expired/left workspaces — "unused orgs" we skip),
 *   - accounts the current session can't access.
 *
 * 🔴 `activeAccountId` is /wham/usage's `account_id` — the id the primary snapshot is actually
 * keyed by — and it is NOT always accounts/check's `default`. The two endpoints resolve the
 * "active" account independently, and when they disagree (or `accounts.default` is missing, so
 * `defaultAccountId` is null and excludes nothing) the account we just collected WITH usage gets
 * re-enumerated here as an extra workspace and sent again with usage null, ~0.7s later. The
 * latest_snapshot upsert is last-write-wins on collected_at, so that second row overwrites the
 * real one and the dashboard shows the plan with no usage while the popup — which renders from
 * local history — looks fine (#1144: 9 users measured, one at 100% utilization).
 *
 * 🪤 #1144 was opened off 문의 #191, but do NOT read that inquiry as a report of THIS bug. The
 * inquiries table carries no IP/UA/session/logged-in email, so nothing links an inquiry to an
 * account, and a SECOND live defect produces the same "popup fine, dashboard empty" complaint:
 * chart-utils.js `isWeeklyScopedRow` drops the scoped slot below a ~104,000s window, and OpenAI
 * moved the Codex bucket to 18,000s (255 users). The word "codex" in #191 fits that one better.
 * This fix stands on the measured duplicate rows, not on knowing who wrote #191.
 *
 * So the anchor is the entry for `activeAccountId` when accounts/check carries one, falling back
 * to `default`. That also fixes the same mismatch's quieter half: `defaultRenewal`/`defaultPending`
 * are attached to the PRIMARY org, so anchoring on the wrong account stamped another account's
 * renewal date and scheduled plan change onto it.
 */
export function parseAccountsRoster(data, activeAccountId = null) {
  const accounts = data?.accounts || {};
  const def = accounts.default || null;
  // The entry describing the account /wham/usage reported on, when accounts/check names it. It
  // may be absent: `usage.account_id` is sometimes a `user-…` id while accounts/check keys by
  // account UUID, and those never match — in which case `default` remains the only anchor we have.
  //
  // 🪤 `default` is an ALIAS: it repeats one real entry under a second key, so two values can carry
  // the same account_id and a bare `Object.values(...).find` would pick whichever came first (Codex
  // FOLLOW-UP). Search the canonical UUID-keyed entries only — if the alias is the sole match, the
  // `|| def` fallback below reaches the same object anyway, so nothing is lost by skipping it.
  const activeEntry = activeAccountId
    ? (Object.entries(accounts).find(([k, a]) => k !== 'default' && a?.account?.account_id === activeAccountId) || [])[1] || null
    : null;
  const anchor = activeEntry || def;
  // The `default` alias carries the real account UUID of the active account, which
  // lets us exclude it from the extra-workspace list (its usage comes from /wham/usage).
  const defaultAccountId = def?.account?.account_id || null;
  const defaultRenewal = anchor?.entitlement?.renews_at || null;
  const defaultPending = parseChatGPTScheduledChange(anchor);

  const order = Array.isArray(data?.account_ordering) && data.account_ordering.length
    ? data.account_ordering
    : Object.keys(accounts).filter((k) => k !== 'default');

  const workspaces = [];
  for (const id of order) {
    const a = accounts[id];
    const acc = a?.account;
    if (!acc) continue;
    // Both identifiers, not just `default`: either one matching means /wham/usage already
    // collected this account WITH usage, so enumerating it here would duplicate it as a
    // usage-null snapshot under the very same org key (#1144).
    if (acc.account_id === defaultAccountId) continue; // active account → /wham/usage handles it
    if (activeAccountId && acc.account_id === activeAccountId) continue; // ditto, per /wham/usage
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
    // The active id is part of the cache fingerprint above, so a cached roster was always parsed
    // against the same active account it is served for — the exclusion cannot go stale here.
    const roster = parseAccountsRoster(data, activeAccountId);
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
    //
    // 🔴 BUT ONLY A ROSTER FOR THE ACCOUNT WE ARE ACTUALLY LOOKING AT. The cache-hit test above
    // checks the fingerprint; this fallback used to ignore it, so a cycle where the user had
    // switched to account B and `accounts/check` happened to fail would replay account A's
    // workspaces — and they are then sent with B's email and B's identity, to the local store and
    // to the server (Codex round 5). "Stale" is acceptable for the SAME account, where the only
    // cost is a late plan change; for a DIFFERENT one it is fabricated data. An empty roster keeps
    // the active org collecting and simply omits extra workspaces for this cycle.
    const sameAccount = cached?.roster
      && cached.extVer === extVer
      && cached.activeAccountId === activeAccountId
      && cached.activePlanType === activePlanType;
    if (!sameAccount && cached?.roster) {
      console.warn('[Claude Tuner] ChatGPT roster cache belongs to another account/plan — not reusing');
    }
    return (sameAccount ? cached.roster : null)
      || { defaultAccountId: null, defaultRenewal: null, defaultPendingPlan: undefined, defaultPendingChangeDate: undefined, workspaces: [] };
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
// 🔴 Must match windowSpanValue() in worker/src/services/snapshot-service.ts. A span the client
// calls valid but the server rejects is worse than either rule alone: the picker below can let a
// degenerate bucket WIN the scoped slot and then the server stores its span as NULL, so the row
// claims a window it never reported. Same bounds, same rounding, same "reject rather than clamp".
const MAX_WINDOW_SECONDS = 366 * 24 * 60 * 60;

function normalizeSpan(s) {
  if (typeof s !== 'number' || !isFinite(s) || s <= 0 || s > MAX_WINDOW_SECONDS) return null;
  const n = Math.round(s);
  return n > 0 ? n : null;
}

export function windowSpan(w) {
  return normalizeSpan(w?.limit_window_seconds);
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
      // Normalized through the SAME rule the server stores by, so "this bucket has a span" means
      // the same thing here, in the picker below, and in the snapshots row (#926).
      windowSeconds: windowSpan(w),
    });
    if (out.length >= MAX_ADDITIONAL_LIMITS) break;
  }
  return out;
}

// ChatGPT reports per-MODEL state separately from the percentage windows, in `usage.model_usage`
// — keyed by model slug (observed 2026-09-07 on Plus: `{ 'gpt-6-astra': { available: true,
// available_at: null, credits_would_enable: false } }`, Astra having launched 09-03).
//
// 🔴 THIS IS NOT A USAGE METER, and the temptation to draw it as one is the whole reason this
// comment is long. The value carries no percent and no window: it answers "can you use this model
// right now", not "how much of it have you spent". Rendering it as a gauge would invent a number
// the provider never sent — the same class of error #1209 had to correct on the dashboard, where a
// percentage stood without saying what it counted and two users (문의 #195·#196) read it wrong.
//
// So we surface AVAILABILITY only, and only when the model is actually unavailable — an available
// model is the boring default and a row saying "Astra: available" is noise on every account.
//   available          — false means the model is gated right now
//   available_at       — unix seconds when it comes back, or null if unknown
//   creditsWouldEnable — buying credits would unlock it now (an upsell state, not a limit)
// Pure — no I/O.
export function parseModelAvailability(usage) {
  const mu = usage?.model_usage;
  // 🪤 `Array.isArray` is not redundant: `typeof [] === 'object'`, so an array-shaped
  // `model_usage` would sail through and `Object.keys` would hand back '0', '1', … — producing a
  // gate row for a model literally named "0". The stated intent two lines down is that an unknown
  // shape raises NO row, and without this the guard did not match it.
  if (!mu || typeof mu !== 'object' || Array.isArray(mu)) return [];
  const out = [];
  for (const slug of Object.keys(mu)) {
    const m = mu[slug];
    if (!m || typeof m !== 'object') continue;
    // `available` missing is NOT "unavailable" — an unknown shape must not raise a warning row.
    if (m.available !== false) continue;
    out.push({
      model: String(slug).slice(0, 40),
      availableAt: unixToResetTime(m.available_at),
      creditsWouldEnable: m.credits_would_enable === true,
    });
    if (out.length >= MAX_ADDITIONAL_LIMITS) break;
  }
  return out;
}

// Which limit the account actually ran into, straight from the provider (`rate_limit_reached_type`,
// null when nothing is exhausted). This is the field that answers the question our gauge cannot:
// a weekly window at 100% does NOT mean chat is blocked, because OpenAI removed the text-chat limit
// on 2026-08-06 — see docs/CHATGPT-USAGE-SEMANTICS.md for the policy timeline and the measured
// population (kept there, with its queries, rather than restated here as a bare number that later
// gets cited as settled). `limit_reached` (per-window) and this (account-wide) are the provider's own answer;
// everything else we show is inference. Kept as an opaque short string — the vocabulary is OpenAI's
// and rotates, so we store what they said rather than mapping it to an enum we would have to chase.
export function parseReachedType(usage) {
  // 🔴 THREE states, for the same reason summarizeLimitBuckets has three (and this function is
  // where that lesson had to be learned twice). Collapsing "the provider never sent this field"
  // into "the provider said nothing is exhausted" would record an UNREPORTED field as positive
  // confirmation of a healthy account — contaminating the very census that exists to tell a
  // cosmetic 100% from a real one.
  //
  //   undefined — never reported, or reported unreadably. We do not know. (AE: 'unknown')
  //   null      — reported, and nothing is exhausted. This is the healthy live value. (AE: 'none')
  //   string    — reported, and this is what is exhausted. Passed through unmapped; the vocabulary
  //               is OpenAI's and rotates.
  //
  // A present-but-junk value (a number, an object, '') is UNKNOWN, not healthy: we could not read
  // it, and "could not read" is never evidence of anything.
  if (!usage || !('rate_limit_reached_type' in usage)) return undefined;
  const v = usage.rate_limit_reached_type;
  if (v === null) return null;
  return typeof v === 'string' && v ? v.slice(0, 32) : undefined;
}

// Low-dimensional census of the RAW `additional_rate_limits[]` array, for server-side observation
// (#1184 option 1 — Analytics Engine, no hot-path D1).
//
// 🔴 It must read the raw array, NOT parseAdditionalLimits() output. That function caps at 5 and
// drops buckets whose window has no usable percent, so counting its result would answer a
// different question than the one #1184 asks. The open ambiguity there is precisely "is Plus
// sending an empty array, or is pickScopedModel just not choosing?" — and only the raw count
// separates those two. Names only, no percentages: this exists to learn WHICH buckets exist on
// which plans, and a name plus a count is enough for that.
export function summarizeLimitBuckets(usage) {
  const arr = usage?.additional_rate_limits;
  // 🔴 ABSENT IS NOT EMPTY, and collapsing the two would defeat the whole point one level down.
  // The question this census exists to answer is "does this account send an empty array, or do we
  // just fail to pick from a non-empty one" — so `count: 0` has to mean "the provider sent an
  // array and it had nothing in it". If a response omits the field entirely (an older shape, a
  // partial payload, a future rename), coercing that to `[]` would file it as a confirmed empty
  // array and inflate exactly the population we are trying to measure. Returning null keeps the
  // two apart all the way to AE, where a missing bucket_count is recorded as -1 = "not reported".
  if (!Array.isArray(arr)) return null;
  return {
    count: arr.length,
    names: arr
      .slice(0, MAX_ADDITIONAL_LIMITS)
      .map((it) => String(it?.limit_name || it?.metered_feature || '?').slice(0, 40)),
  };
}

// Select the model-scoped bucket (e.g. Codex 'GPT-5.3-Codex-Spark') from the per-feature limits
// and shape it like Claude's weekly_scoped slot ({ utilization, resets_at, model, window_seconds })
// so it can ride the shared `seven_day_omelette` slot. Pure — no I/O.
//
// 🔴 This used to REQUIRE a weekly span and return null otherwise, so a 5h bucket could never be
// mis-persisted into a slot every reader treated as weekly. On 2026-08-20 OpenAI moved the Codex
// Spark bucket from 604800 to 18000 seconds, and that guard did exactly what it promised: 232
// users' Spark usage silently stopped being stored (#926 — omelette holders 232 → 2 overnight).
//
// The guard is obsolete because the row now records the span itself
// (`seven_day_omelette_window_seconds`, Phase 2a). The slot means "the model-scoped bucket"; how
// long its window is, is DATA. Same rule the model name already follows — the model rotates, the
// column does not; now the window rotates too and the column still does not.
//
// Selection keeps the OLD weekly-first `find` and only replaces what happened when it missed:
// `null` becomes "take the first model bucket anyway". Every account that has a weekly bucket
// therefore selects byte-identically to before — including when a LONGER bucket exists.
//
// 🪤 An earlier draft used "longest span wins", which is NOT a generalization: given
// [Weekly 604800, Monthly 2592000] the old rule picks Weekly and longest-span picks Monthly. Free
// and Go already report 30-day windows, so that input is reachable, not hypothetical.
function pickScopedModel(additionalLimits) {
  if (!Array.isArray(additionalLimits) || !additionalLimits.length) return null;
  // Non-model buckets that ride the same additional_rate_limits array (observed 2026-08-22:
  // 'gpt-reserve', #926). They are not model limits, so they must neither occupy the scoped slot
  // nor outrank a real model bucket when both are present; the popup still shows them via
  // parseAdditionalLimits.
  //
  // WHAT 'gpt-reserve' ACTUALLY IS (settled 2026-09-08): OpenAI's **Luna Reserve** — a separate
  // fallback allowance that engages only AFTER the regular 5h/weekly limits are exhausted, on
  // selected Plus/Pro accounts, and that runs GPT-5.6 Luna and nothing else. Official wording:
  // "regular usage supports the models available with your plan, and Luna Reserve provides
  // additional usage only with Luna after regular usage is exhausted." Corroborated by
  // openai/codex#42217 (a /status showing `gpt-reserve Weekly limit: 100% left` beside
  // `Weekly limit: 0% left`) and #42830 (Reserve activation overrides the composer model to
  // `gpt-reserve`). See docs/CHATGPT-USAGE-SEMANTICS.md.
  //
  // 🪤 TWO EARLIER VERSIONS OF THIS COMMENT GUESSED, AND BOTH GUESSED WRONG. The first called it
  // "OpenAI's banked-reset pool" (no evidence; banked reset credits arrive in a SEPARATE top-level
  // field, `rate_limit_reset_credits`). The second replaced that with "looks far more like the
  // base-model (chat) meter", reasoning from `metered_feature: 'base_model_inference'` — but
  // codex#42830 observes the Reserve bucket carrying exactly that metered_feature, so the field is
  // Reserve's own labelling, not a chat meter. Do not read meaning out of payload field names
  // here; that inference has now failed twice on this one bucket.
  //
  // 🔴 THE ZEROS ARE CONSISTENT WITH THIS, NOT EXPLAINED BY IT. Across 71 accounts / 662 rows
  // (08-22~09-07) utilization is essentially all zero, and a reserve that only accrues after the
  // regular allowance is burnt would look like that — but we never checked whether those accounts
  // ever exhausted their regular limit, whether they had Reserve access at all, or whether they
  // used a supported surface, and the sample is biased (only old clients stored this bucket). So
  // the cause of the zeros is UNVERIFIED. Do not treat a zero here as self-evidently correct: if
  // an account demonstrably ran past its regular limit into Reserve and this still reads 0, that
  // is a collection defect, not the expected value. Equally, a NON-zero reading while regular
  // usage is still available would refute the whole identification above — reopen it then.
  //
  // THE EXCLUSION STANDS, on reasons that are per-surface and worth keeping distinct (#1312 will
  // need them separated):
  //   - scoped slot: it is a single WINNER slot, so letting a non-model bucket win would displace
  //     a real model bucket. (The slot itself no longer implies "weekly" — it records
  //     `window_seconds`, see the note above — so "it would assert a weekly limit" is NOT the
  //     reason.)
  //   - 7d chart: the chart draws plan-quota guide lines, which mean nothing for an allowance that
  //     is not the plan's quota.
  //   - feature-limit card: it frames its number as one of the account's per-feature LIMITS, and
  //     an independent fallback allowance is not one.
  // It is NOT excluded for being unnameable any more — it has a name now; display is #1312.
  // Kept INSIDE the function: scripts/scoped-weekly-slots.test.mjs compiles this body in
  // isolation, so an outer constant would have to be stubbed there and could drift.
  const NON_MODEL_LIMIT_NAMES = ['gpt-reserve'];
  const isModelBucket = (b) => NON_MODEL_LIMIT_NAMES.indexOf(b.name) < 0;
  // Usable percent is required to WIN, not just to be returned. The old code tested it after
  // choosing, so a weekly bucket with a junk percent produced null and hid a perfectly good
  // sibling. parseAdditionalLimits already drops those, so this is defence in depth.
  const models = additionalLimits.filter((b) => isModelBucket(b) && typeof b.used === 'number');
  if (!models.length) return null;
  // `windowSeconds` arrives normalized (parseAdditionalLimits → windowSpan), so a positive number
  // here means a span the SERVER will also accept. Re-checking `> 0` keeps a hand-built object in
  // a test from asserting a contract the pipeline cannot actually produce.
  const isKnownSpan = (b) => typeof b.windowSeconds === 'number' && b.windowSeconds > 0;
  const weekly = models.find((b) => isKnownSpan(b) && b.windowSeconds >= WINDOW_SPLIT_SECONDS);
  // The one behaviour change: no weekly bucket no longer means "store nothing". The row records
  // the window length now, so a 5h (or spanless) bucket can ride the slot without implying 7d.
  const chosen = weekly || models[0];
  return {
    utilization: chosen.used,
    resets_at: chosen.resetsAt || null,
    model: chosen.name || null,
    // 🔴 The whole point. Without this the server stores a 5h bucket's utilization in a slot named
    // seven_day_* with no way to tell, which is the mis-persist the old guard existed to prevent.
    window_seconds: isKnownSpan(chosen) ? chosen.windowSeconds : null,
  };
}

/**
 * Collect ChatGPT usage data.
 * Returns { success, orgs: [{ uuid, name, plan, provider, isPrimary, h5, d7, ... }] }
 * Fails silently (returns empty orgs) if user is not logged into ChatGPT.
 */
export async function collectChatGPT(force = false, userManual = false) {
  await noteProviderAttempt('chatgpt');
  const loggedIn = await isChatGPTLoggedIn();
  if (!loggedIn) {
    // 🔴 Record it. This early return is the MOST COMMON failure — signed out of ChatGPT — and it
    // happens before any API call, so it never produced one of the `err_chatgpt_*` codes. Exposing
    // those codes without this would still leave the ordinary case invisible (#852).
    await noteProviderError('chatgpt', 'err_chatgpt_not_logged_in');
    return { success: false, orgs: [] };
  }

  // Per-cycle send outcome. Applied once at the end, so a later workspace's success cannot erase
  // an earlier failure (see sendChatGPTSnapshot).
  const sendOutcome = { failed: null, ok: 0 };
  try {
    const usage = await fetchChatGPTApi('/backend-api/wham/usage');

    if (!usage?.rate_limit) {
      console.warn('[Claude Tuner] ChatGPT: unexpected /wham/usage response');
      await noteProviderError('chatgpt', 'err_chatgpt_collect_failed');
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
      // Models the provider is currently gating (empty on a healthy account — see
      // parseModelAvailability: availability, NOT a usage percentage).
      modelGates: parseModelAvailability(usage),
      // Which limit the account actually ran into, per the provider. null = nothing exhausted,
      // which is the normal state even at 100% on the weekly window (chat is unmetered since 08-06).
      reachedType: parseReachedType(usage),
      // Raw-array census for server-side observation only — never rendered (#1184).
      bucketCensus: summarizeLimitBuckets(usage),
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
      const res = await sendChatGPTSnapshot(org, email, plan, { force: shouldForceProviderPost(gate.reason, userManual), sendOutcome }).catch(e => {
        console.warn('[Claude Tuner] ChatGPT snapshot send failed:', e.message);
        sendOutcome.failed = sendOutcome.failed || 'err_send_failed';
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
    //
    // 🔴 The `ws.accountId !== org.uuid` filter is the invariant itself, stated where the two
    // sends are visible together: ONE CYCLE NEVER SENDS TWO SNAPSHOTS FOR THE SAME ORG KEY. The
    // roster already excludes the active account, but that exclusion depends on accounts/check
    // agreeing with /wham/usage about which account is active — and it is exactly that agreement
    // that failed in #1144. This check needs no such agreement: it compares the id the primary
    // snapshot was keyed by against the id each extra send would be keyed by. Keep both.
    const extraOrgs = roster.workspaces
      .filter((ws) => ws.accountId !== org.uuid)
      .slice(0, MAX_EXTRA_WORKSPACES).map((ws) => ({
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
      const res = await sendChatGPTSnapshot(ex, email, ex.plan, { forceExtraOrg: true, force: shouldForceProviderPost(exGate.reason, userManual), sendOutcome }).catch((e) => {
        console.warn('[Claude Tuner] ChatGPT workspace snapshot send failed:', e.message);
        sendOutcome.failed = sendOutcome.failed || 'err_send_failed';
        return null;
      });
      if (res) await exGate.commit();
    }

    await noteProviderSuccess('chatgpt', email);
    // 🔴 ANY failed POST in this cycle keeps the send axis red, even if others succeeded. A
    // provider sends several snapshots (primary + extra workspaces); clearing per POST let a later
    // workspace 2xx erase the primary's failure (Codex DEPLOY-BLOCKER).
    if (sendOutcome.failed) await noteProviderSendError('chatgpt', sendOutcome.failed);
    else if (sendOutcome.ok) await noteProviderSendOk('chatgpt');
    return { success: true, orgs: [org, ...extraOrgs] };
  } catch (e) {
    console.warn('[Claude Tuner] ChatGPT collection failed:', e.message);
    // The reason dies here otherwise: the caller only sees `success:false`, and background.js
    // catches that again with `.catch(() => {})`. Store it before it is lost (#852).
    await noteProviderError('chatgpt', e);
    return { success: false, orgs: [] };
  }
}

// Send ChatGPT snapshot to server (same /api/snapshots endpoint)
// Uses ext_token email (Claude email) as user_email for server identity,
// preserves ChatGPT email in provider_email for reference.
async function sendChatGPTSnapshot(org, chatgptEmail, plan, { forceExtraOrg = false, force = false, sendOutcome = null } = {}) {
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

  // Model-scoped limit (e.g. Codex 'GPT-5.3-Codex-Spark') rides the shared `seven_day_omelette`
  // slot — the same slot Claude reuses for its weekly_scoped model. The slot name says 7d for
  // historical reasons only; the row's `seven_day_omelette_window_seconds` says how long the
  // window actually is, which is why a 5h bucket may ride it now (#926). Only the primary org
  // carries additionalLimits; extra workspaces have none → slot stays unset.
  const scopedModel = pickScopedModel(org.additionalLimits);
  if (scopedModel) payload.seven_day_omelette = scopedModel;

  // Observation-only rider (#1184). The server writes this to Analytics Engine and stores NOTHING
  // in D1 — the hot path may not take on another D1 statement, read or write. Sent only when there
  // is something to say, so an ordinary heartbeat's body does not grow.
  //
  // 🔴 Deliberately NOT part of the dedup signature. The server's usage-only dedup keys on
  // h5/d7/r7, and that is correct here: if a bucket appears or a model gets gated while usage sits
  // flat, we would rather lose that observation than start forcing stores on every heartbeat.
  // The census is a population question ("which plans see which buckets"), not a per-account
  // timeline, so sampling it through whatever the dedup lets through is sufficient.
  // 🔴 `bucket_count` IS SENT WHEN IT IS ZERO. An earlier cut gated the whole rider on
  // "is there anything to say", counting 0 as nothing — which silently excluded the exact
  // population this rider exists to measure. #1184's open question is "when a Plus account has no
  // scoped bucket, is `additional_rate_limits[]` empty, or did pickScopedModel just not choose?"
  // Only a count-0 row answers that, and under the old gate the ordinary healthy account
  // ({ additional_rate_limits: [], model_usage: {...available...}, rate_limit_reached_type: null })
  // emitted no row at all. Its silence would then be indistinguishable from "not ChatGPT" /
  // "old client" / "dedup-skipped" / "flag off" — so the query in ae.ts would read
  // "no Plus account has an empty array", which is the opposite of what it means.
  //
  // Cost of always sending it: ~20 bytes, on ChatGPT snapshots that already passed the send gate.
  // The optional members below stay conditional — those really are "nothing to say" when absent.
  // 🔴 THREE states, not two, and every pair of them has been conflated at some point in this file:
  //
  //   key absent   — we never fetched /wham/usage for this org at all. EXTRA WORKSPACES are this:
  //                  the roster names them but usage needs a per-account token, so they arrive with
  //                  h5/d7 null and none of these fields set. They must emit NOTHING. Attaching an
  //                  empty rider would have AE record reached_type='none' + bucket_count=-1 for a
  //                  workspace we never looked at — phantom "healthy" rows contaminating the census.
  //   null         — we fetched, and the response had no `additional_rate_limits` field.
  //   object       — we fetched, and the field was there (count may legitimately be 0).
  //
  // `in` rather than a truthiness test precisely because null and undefined must part ways here:
  // the primary org always sets the key (to an object or to null), extra workspaces never set it.
  if ('bucketCensus' in org) {
    const census = org.bucketCensus;
    payload.provider_obs = {
      ...(census ? { bucket_count: census.count } : {}),
      ...(census && census.names.length ? { bucket_names: census.names } : {}),
      // `!== undefined` and NOT a truthiness test: null is a real, load-bearing value here
      // ("reported, nothing exhausted") and must survive into the payload as an explicit null.
      ...(org.reachedType !== undefined ? { reached_type: org.reachedType } : {}),
      ...(org.modelGates && org.modelGates.length
        ? { gated_models: org.modelGates.map((g) => g.model) }
        : {}),
    };
  }

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
  // #1020: a send that never lands is invisible otherwise — the popup keeps showing local data
  // while the dashboard stays empty. `postSnapshot` only calls this for failures that have no
  // other surface; everything auth/upgrade/deletion related already raises its own popup state.
  //
  // 🔴 The outcome is ACCUMULATED for the whole cycle, not applied per POST. One provider can send
  // several snapshots (primary + extra workspaces); clearing on each success let a later workspace
  // 2xx erase the primary's failure, so the user was told everything was fine while their main
  // account never reached the server (Codex DEPLOY-BLOCKER).
  return await postSnapshot(config, payload, (code) => {
    if (!sendOutcome) return;
    if (code) sendOutcome.failed = sendOutcome.failed || code;
    else sendOutcome.ok += 1;
  });
}
