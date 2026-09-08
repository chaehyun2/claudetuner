// Pure parsing for ChatGPT's provider responses — no chrome.*, no fetch, no Date.now().
//
// WHY THIS IS ITS OWN MODULE (#1315). bg/collect-chatgpt.js imports chrome-only siblings at the
// top (api-chatgpt.js, storage.js, send-gate.js), so nothing can import it outside a browser
// extension — not the contract runner, not a guard, not Node at all. Marking these functions
// `export` would not have changed that: the barrier is the module's own import list, one line
// above. So the parsing moved to a module whose only dependency is bg/api.js's pure
// normalizeResetTime, and the collector imports it back.
//
// What that buys: test/provider-contract-guard.mjs calls these through a real `import` instead of
// slicing them out of the source text by signature string — a technique that silently stops
// covering a function the moment someone renames or reformats its declaration.
//
// 🔴 THIS FILE MUST STAY IMPORTABLE UNDER PLAIN NODE. Adding an import of storage.js, api-chatgpt.js
// or anything else that touches chrome.* at module scope re-erects exactly the barrier this module
// exists to remove, and the contract runner would start failing at load with an error that looks
// like a test bug rather than a design regression.
//
// Extracted from bg/collect-chatgpt.js with NO behaviour change — the #1316 contract's 149 case
// outputs were captured before and after the move and compared byte for byte.
import { normalizeResetTime } from './api.js';

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
export function chatgptPlanName(code) {
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
export function unixToResetTime(ts) {
  if (!ts) return null;
  return normalizeResetTime(new Date(ts * 1000).toISOString());
}

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
export const MAX_WINDOW_SECONDS = 366 * 24 * 60 * 60;

export function normalizeSpan(s) {
  if (typeof s !== 'number' || !isFinite(s) || s <= 0 || s > MAX_WINDOW_SECONDS) return null;
  const n = Math.round(s);
  return n > 0 ? n : null;
}

export function windowSpan(w) {
  return normalizeSpan(w?.limit_window_seconds);
}

// Pick the 5h and 7d windows out of the rate_limit object by their span.
export function classifyWindows(rateLimit) {
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

// Buckets that ride the additional_rate_limits array without being MODEL limits (observed
// 2026-08-22: 'gpt-reserve', OpenAI's Luna Reserve — a fallback allowance that engages only after
// the regular 5h/weekly limits are exhausted). pickScopedModel() excludes them from the scoped
// slot; see the long note there for why, per surface.
//
// 🔴 THIS LIST HAS TWO HAND-SYNCED TWINS, in classic scripts that cannot import it:
//   claude-tuner-extension/usage-shared.js   NON_MODEL_BUCKET_NAMES
//   site/shared/chart-renderers.js           NON_MODEL_SLOT_NAMES
// The runtime boundary (extension ESM / dashboard classic) forces the copies, so the project rule
// applies: single canonical source + drift guard. THIS is the canonical one, and
// test/chatgpt-astra-obs-guard.mjs is the guard — it now imports this array and EXECUTES
// pickScopedModel against every name in it, instead of comparing three regex matches. A text
// comparison could only prove the three lists were spelled the same; it could not prove the picker
// actually excludes what the list says, which is the thing that matters.
//
// It used to live inside pickScopedModel's body, because scripts/scoped-weekly-slots.test.mjs
// compiled that body in isolation and an outer constant would have had to be stubbed. That file is
// gone (#1316) and the picker is a real export (#1315), so the constraint that kept it inline no
// longer exists.
export const NON_MODEL_LIMIT_NAMES = ['gpt-reserve'];

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
export function pickScopedModel(additionalLimits) {
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
  // The list itself is module-scope and EXPORTED (see NON_MODEL_LIMIT_NAMES above).
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
