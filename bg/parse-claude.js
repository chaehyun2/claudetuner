// Pure parsing for Claude's usage response — no chrome.*, no fetch, no Date.now().
//
// Same reason as bg/parse-chatgpt.js (#1315): bg/collect.js imports chrome-only siblings at the
// top, so these helpers were unreachable from anything but the extension itself, and the contract
// runner had to slice them out of the source text by signature string. Placement mirrors the
// ChatGPT side.
//
// 🔴 KEEP THIS FILE IMPORTABLE UNDER PLAIN NODE — bg/reset-time.js's normalizeResetTime is the only
// dependency it may take.
//
// Extracted from bg/collect.js with NO behaviour change; verified against the #1316 contract's
// captured case outputs.
import { normalizeResetTime } from './reset-time.js';
import {
  emptyResetPassKinds, emptyUsableKinds, FIVE_HOUR_SLOT, isPassCount, ticketsFromPasses, unknownResetPassSummary, WEEKLY_SLOT_RE,
} from './reset-pass-model.js';

/** Normalize raw extra_usage API response into a consistent shape */
export function normalizeExtraUsage(raw) {
  if (!raw) return null;
  return {
    is_enabled: raw.is_enabled || false,
    monthly_limit: raw.monthly_limit ?? null,
    used_credits: raw.used_credits ?? null,
    utilization: raw.utilization ?? null,
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
export function resolveScopedWeeklySlots(usageData) {
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

/**
 * The provider-response half of a Claude usage snapshot.
 *
 * Split out of buildUsageFields() (#1315), which mixed these five fields with the user's timezone,
 * UI language and poll settings. Those four are environment, not response — they cannot be pinned
 * by a fixture and their presence is what kept this whole block out of reach of a contract. The
 * caller re-joins the two halves; the key order is preserved so the emitted payload is unchanged.
 *
 * 🔴 Deliberately NOT null-tolerant: it reads `usageData.five_hour` without optional chaining, the
 * same as resolveScopedWeeklySlots below it, so a null response throws here rather than producing
 * a snapshot of nulls that would look like a real reading of an idle account. Preserved from the
 * original; changing it is a decision, not a cleanup.
 */
/**
 * TRUE when Claude answered but told us nothing — every window null and no scoped limits.
 *
 * 🔴 THIS IS NOT "we have not collected yet", and the difference is the whole point. Anthropic
 * stopped giving Free-plan accounts their windows at 2026-08-21 17:00 UTC: the request still
 * returns 200 and the KEYS ARE STILL THERE, filled with explicit `null`, with `limits: []`
 * (verified against a live Free account 2026-09-10; 821 weekly active users). The widgets could
 * not tell that apart from a cold start, so they rendered "수집 중" or nothing at all and a user
 * reasonably concluded the extension was broken — which is what inquiry #198 actually was.
 *
 * 🪤 DELIBERATELY NOT A PLAN CHECK. Gating on `plan === 'Free'` would be a guess about WHY, would
 * miss any other plan this happens to, and would keep lying after Anthropic changes it back. The
 * response's own emptiness is the fact; the plan is a story about it.
 *
 * Returns false for a null/absent response: that is a FAILED read, which the error path already
 * describes and must not be relabelled as "the provider withheld it".
 */
export function claudeUsageWithheld(usageData) {
  if (!usageData || typeof usageData !== 'object' || Array.isArray(usageData)) return false;
  const empty = (w) => w == null || w.utilization == null;
  if (!empty(usageData.five_hour) || !empty(usageData.seven_day)) return false;
  if (!empty(usageData.seven_day_omelette) || !empty(usageData.seven_day_sonnet)) return false;
  // A scoped limit is still usage we can show, so its presence means nothing was withheld.
  if (Array.isArray(usageData.limits) && usageData.limits.length > 0) return false;
  // 🔴 THE WINDOWS WE WATCH BUT DO NOT RENDER COUNT TOO. cl2 (drift-obs.js) watches six more keys
  // because we could not answer "did the usage move somewhere else in this response". If it ever
  // does move there, the conventional windows go null and this predicate would have said "the
  // provider withheld it" — a FALSE statement while the provider is in fact serving usage we
  // simply cannot draw yet. Not drawing it is a gap; asserting it was not sent is a lie, and this
  // whole change exists to stop the widget saying untrue things.
  //
  // 🪤 SPELLED OUT, NOT LOOPED. `usageData[k]` slips past the read-set scan in
  // test/provider-contract-guard.mjs section [6], which derives "what this file reads" from
  // `usageData.<field>`. A bracket index makes that derivation blind, so the guard rejects it —
  // rightly: the point of the scan is that a field this file reads cannot become invisible.
  if (!empty(usageData.nimbus_quill)) return false;
  if (!empty(usageData.spend)) return false;
  if (!empty(usageData.seven_day_opus)) return false;
  if (!empty(usageData.seven_day_cowork)) return false;
  if (!empty(usageData.seven_day_oauth_apps)) return false;
  if (!empty(usageData.seven_day_breakdown)) return false;
  return true;
}

/**
 * The keys cl2 added over cl1 (bg/drift-obs.js DRIFT_KEYSETS). Exported so a guard can execute
 * both sides and prove this list has not drifted from the keyset — a silent divergence would put
 * the notice back over a window the provider actually served.
 */
export const CL2_WATCHED_WINDOWS = [
  'nimbus_quill', 'spend', 'seven_day_opus', 'seven_day_cowork',
  'seven_day_oauth_apps', 'seven_day_breakdown',
];

export function parseClaudeUsageWindows(usageData) {
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
  };
}

// Which windows a grant clears decides its kind — the grant carries no kind field, and the
// claude.ai bundle classifies it from `clears[]` the same way (docs/plans/usage-reset-passes.md
// §1.1). The values are already our slot names (five_hour / seven_day / seven_day_*).
//
// 🔴 STRICT, because a kind is a promise about what one pass clears (canClearNow reads the kind,
// not the grant): `full` must clear five_hour AND the plain seven_day, `weekly` the plain seven_day
// without five_hour, `five_hour` five_hour alone. A grant clearing five_hour + only a scoped weekly
// (seven_day_opus) is none of them — calling it `full` claimed it lifts the plain 7d limit (Codex
// 1R). Such combinations are `unknown`: observed, never counted or offered.
const SEVEN_DAY_SLOT = 'seven_day';
function claudeResetPassKind(clears) {
  const fiveHour = clears.includes(FIVE_HOUR_SLOT);
  const sevenDay = clears.includes(SEVEN_DAY_SLOT);
  const anyWeekly = clears.some((c) => WEEKLY_SLOT_RE.test(c));
  if (fiveHour && sevenDay) return 'full';
  if (!fiveHour && sevenDay) return 'weekly';
  if (fiveHour && !anyWeekly) return 'five_hour';
  return 'unknown';
}

const isTimestamp = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

// `ineligible_reason` is a provider enum. Only the values the claude.ai bundle lists (plan §1.1) are
// kept; anything else — a new value, free text — collapses to 'other', so P0b counts a closed
// vocabulary and never carries provider prose.
const INELIGIBLE_REASONS = new Set([
  'config_off', 'tier', 'seat', 'mobile', 'surface', 'cli_version', 'no_grant', 'tenure',
  'other_experiment', 'control', 'not_enrolled', 'plan_changed', 'unavailable',
]);
const INELIGIBLE_REASON_OTHER = 'other';

function claudeEligibility(ce) {
  const eligible = typeof ce.eligible === 'boolean' ? ce.eligible : null;
  let reason = null;
  if (eligible !== true && ce.ineligible_reason != null) {
    reason = INELIGIBLE_REASONS.has(ce.ineligible_reason) ? ce.ineligible_reason : INELIGIBLE_REASON_OTHER;
  }
  return { eligible, ineligible_reason: reason };
}

/**
 * Reset passes from Claude's `/usage?cedar_ember=1` response → { summary, passes }
 * (ResetPassSummary / ResetPass[], bg/reset-pass-model.js). Pure; never throws.
 *
 * 🔴 「모름」 IS NOT 0장. A missing/null `cedar_ember` (the bare `/usage` sends null),
 * `eligible !== true`, or an unreadable block all answer known:false — the renderer hides the
 * pass row instead of claiming the user holds none.
 *
 * Kept: grant id (a global promotion id, not personal) as pass_key, counts, window names, times,
 * `eligible` and `ineligible_reason` (enum token or 'other' — P0b counts reasons; filled on the
 * known:false summary too). Never kept: `label`, `event_props` (tier / tenure / billing),
 * `blocking` contents — only whether blocking is non-empty.
 *
 * usable_by_kind counts a grant only if it is `usable_now`, blocks on nothing, and — when the
 * response names one — is `next_grant_id`: claude.ai spends exactly that grant, so a usable full
 * grant behind a five_hour `next_grant_id` would not be the one the button uses.
 *
 * Unknown kinds (clears names no window we know) stay in `passes` and `by_kind.unknown` for
 * observation but are not added to `available` / `usable_now`, matching the ChatGPT rule.
 */
export function parseClaudeResetPasses(usageData, now = Date.now()) {
  try {
    const ce = usageData?.cedar_ember;
    if (!ce || typeof ce !== 'object' || Array.isArray(ce)) return { summary: unknownResetPassSummary('claude', now), passes: [] };
    const eligibility = claudeEligibility(ce);
    const unknown = () => ({ summary: { ...unknownResetPassSummary('claude', now), ...eligibility }, passes: [] });
    if (ce.eligible !== true || !Array.isArray(ce.grants)) return unknown();
    const nextGrantId = typeof ce.next_grant_id === 'string' ? ce.next_grant_id : null;

    const passes = [];
    const usableByKind = emptyUsableKinds();
    let blocked = false;
    for (const g of ce.grants) {
      // 🔴 A MALFORMED grant makes the whole summary 「모름」. Skipping it and answering
      // known:true would report "0장" for a pass we simply could not read.
      if (!g || typeof g !== 'object' || Array.isArray(g) || typeof g.id !== 'string' || !g.id
        || !isPassCount(g.resets_left) || (g.ends_at !== null && !isTimestamp(g.ends_at))) {
        return unknown();
      }
      // Well-formed but not held: used up, expired, or an explicit `ends_at: null` (claude.ai drops
      // those itself — expiry is mandatory). A MISSING ends_at key is malformed (caught above).
      if (g.resets_left === 0 || g.ends_at === null || Date.parse(g.ends_at) <= now) continue;
      // A HELD grant whose `clears` is missing or unreadable is malformed too: without it we cannot
      // say what the pass is, and counting it as an uncounted `unknown` would read as "0장".
      if (!Array.isArray(g.clears) || !g.clears.every((c) => typeof c === 'string')) return unknown();
      const rawClears = g.clears;
      const clears = rawClears.filter((c) => c === FIVE_HOUR_SLOT || WEEKLY_SLOT_RE.test(c));
      const kind = claudeResetPassKind(clears);
      passes.push({
        provider: 'claude',
        kind,
        clears,
        left: g.resets_left,
        total: isPassCount(g.resets_total) ? g.resets_total : null,
        starts_at: isTimestamp(g.starts_at) ? g.starts_at : null,
        expires_at: g.ends_at,
        usable_now: typeof g.usable_now === 'boolean' ? g.usable_now : null,
        requires_limit: typeof g.use_requires_limit === 'boolean' ? g.use_requires_limit : null,
        pass_key: g.id.slice(0, 100),
        raw_type: rawClears.join(',').slice(0, 200),
      });
      const grantBlocked = Array.isArray(g.blocking) && g.blocking.length > 0;
      if (kind !== 'unknown' && grantBlocked) blocked = true;
      if (kind !== 'unknown' && g.usable_now === true && !grantBlocked && (nextGrantId === null || g.id === nextGrantId)) {
        usableByKind[kind] += g.resets_left;
      }
    }

    const byKind = emptyResetPassKinds();
    let available = 0;
    let usableNow = null;
    let nextExpires = null;
    for (const p of passes) {
      byKind[p.kind] += p.left;
      if (p.kind === 'unknown') continue;
      available += p.left;
      if (p.usable_now !== null) usableNow = (usableNow ?? 0) + (p.usable_now ? p.left : 0);
      if (nextExpires === null || Date.parse(p.expires_at) < Date.parse(nextExpires)) nextExpires = p.expires_at;
    }
    return {
      summary: {
        provider: 'claude',
        known: true,
        available,
        usable_now: usableNow,
        by_kind: byKind,
        next_expires_at: nextExpires,
        blocked_by_other: blocked,
        cooldown_until: isTimestamp(ce.cooldown_until) ? ce.cooldown_until : null,
        observed_at: now,
        ...eligibility,
        kinds_known: true,
        usable_by_kind: usableByKind,
        tickets: ticketsFromPasses(passes, now),
      },
      passes,
    };
  } catch {
    return { summary: unknownResetPassSummary('claude', now), passes: [] };
  }
}

/**
 * VAT verdict of a personal subscription from claude.ai `GET /api/stripe/{org}/invoices` (#2157).
 * Live shape (2026-10-05): an array of `{ total, total_excluding_tax, currency, status, created_ts, … }`
 * in minor units. The verdict comes from the NEWEST paid invoice that actually charged something:
 *   tax = total − total_excluding_tax  →  > 0 'charged' (no business number in Korea) · else 'none'.
 * Zero-total invoices (credits, free switches) and unpaid ones say nothing about tax and are skipped.
 * Only the verdict and that invoice's date leave this function — never an amount.
 * @returns {{ status: 'charged'|'none', invoiceAt: string } | null} null = nothing to judge from
 */
export function parseClaudeVatStatus(invoices) {
  if (!Array.isArray(invoices)) return null;
  let newest = null;
  for (const inv of invoices) {
    if (!inv || typeof inv !== 'object' || inv.status !== 'paid') continue;
    const { total, total_excluding_tax: net, created_ts: ts } = inv;
    if (![total, net, ts].every(Number.isFinite) || total <= 0) continue;
    if (!newest || ts > newest.ts) newest = { ts, tax: total - net };
  }
  if (!newest) return null;
  return { status: newest.tax > 0 ? 'charged' : 'none', invoiceAt: new Date(newest.ts * 1000).toISOString() };
}

/**
 * Tax on the NEXT bill, from claude.ai `GET /api/stripe/{org}/upcoming_invoice` (#2157, shadow).
 * Live shape (2026-10-06): `{ invoice: { total, currency, status: 'draft', lines: [{ total, proration, … }], … } }`
 * — no tax field, so tax = total − Σ lines[].total. Stripe recomputes the preview with the customer's
 * CURRENT tax IDs, so a business number entered today should show here at once, unlike the paid invoices
 * (unverified on a taxed account — collected next to the invoice verdict to compare before use).
 * Only the verdict leaves this function — never an amount.
 * @returns {'charged'|'none'|null|undefined} null = nothing to judge (no upcoming bill, zero total) ·
 *   undefined = unreadable body
 */
export function parseClaudeUpcomingVat(body) {
  if (!body || typeof body !== 'object') return undefined;
  const inv = body.invoice;
  if (inv === null) return null;
  if (!inv || typeof inv !== 'object' || !Array.isArray(inv.lines) || !Number.isFinite(inv.total)) return undefined;
  if (inv.total <= 0 || inv.lines.length === 0) return null;
  let lines = 0;
  for (const l of inv.lines) {
    if (!Number.isFinite(l?.total)) return undefined;
    lines += l.total;
  }
  return inv.total - lines > 0 ? 'charged' : 'none';
}

/**
 * Billing country from claude.ai `GET /api/organizations/{org}/address` (#2157): `billing_address.country`
 * (ISO 3166-1 alpha-2, e.g. 'KR'). Decides whether a verdict is VAT at all — a US "tax" is sales tax,
 * which a business number does not remove. Only the country code leaves this function.
 * @returns {string|null} null = no billing address / unreadable
 */
export function parseClaudeBillingCountry(body) {
  const c = body?.billing_address?.country;
  return typeof c === 'string' && /^[A-Za-z]{2}$/.test(c) ? c.toUpperCase() : null;
}
