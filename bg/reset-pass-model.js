// Usage-limit reset passes — the normalized shape both providers parse into (#2092).
//
// Claude grants (`/usage?cedar_ember=1`) and ChatGPT reset credits (`/wham/usage`
// `rate_limit_reset_credits`) are different protocols with one meaning: "you hold N passes that
// clear your usage windows". bg/parse-claude.js and bg/parse-chatgpt.js each map their provider
// into the shape below (docs/plans/usage-reset-passes.md §2). The "we could not read it" summary
// lives here once, because both parsers must return exactly the same literal for it — a renderer
// that tells 「모름」 from 「0장」 by `known` breaks the moment the two copies disagree.
//
// 🔴 ZERO IMPORTS, NO chrome.*. Both parse modules import this file, and those must stay loadable
// under plain Node (test/provider-contract-guard.mjs section [5]).
//
// ResetPassSummary = {
//   provider: 'claude' | 'chatgpt',
//   known: boolean,                 // false = field absent / ineligible / unreadable → show nothing
//   available: number,              // passes left, counting only full / five_hour / weekly
//   usable_now: number | null,
//   by_kind: { full, five_hour, weekly, unknown },  // unknown is observed, never shown or summed
//   next_expires_at: string | null,
//   blocked_by_other: boolean,
//   cooldown_until: string | null,
//   observed_at: number,            // ms
//   eligible: boolean | null,       // claude: cedar_ember.eligible when boolean; chatgpt: null
//   ineligible_reason: string | null,  // claude only, closed vocabulary (else 'other'); null when eligible
//   kinds_known: boolean,           // claude known: true; chatgpt: false until the detail is merged
//   usable_by_kind: { full, five_hour, weekly },  // passes usable NOW per kind (0 = not usable / unknown)
//   tickets: [{ kind, expires_at }],  // one per held pass (known kinds only), earliest expiry first,
//                                     // ≤ RESET_PASS_TICKETS_MAX — the popup's ticket chips. No id/key.
// }

export function emptyResetPassKinds() {
  return { full: 0, five_hour: 0, weekly: 0, unknown: 0 };
}

/** Per-kind "usable now" counts — no `unknown` bucket: an unknown kind is never usable. */
export function emptyUsableKinds() {
  return { full: 0, five_hour: 0, weekly: 0 };
}

// Our weekly slot names: seven_day and every scoped seven_day_* (seven_day_opus, …_overage_included).
export const WEEKLY_SLOT_RE = /^seven_day(?:_[a-z_]+)?$/;
export const FIVE_HOUR_SLOT = 'five_hour';

// The ONLY pages a reset-pass affordance may open: each provider's own usage settings, where the
// user spends a pass themselves. We never spend one (plan §4) — a click is a deep link, nothing else.
// Paths only: origins come from vendor-ai/sites.js SITE_ORIGINS (no SW module spells a provider
// origin, #2067), passed in so this file stays import-free.
const RESET_PASS_SITE_PATHS = Object.freeze({
  claude: '/new#settings/usage',
  chatgpt: '/settings/usage?tab=overview',
});

/** The usage-settings URL for a provider, or null for any provider without one. */
export function resetPassSiteUrl(provider, origins) {
  if (!Object.hasOwn(RESET_PASS_SITE_PATHS, provider) || typeof origins?.[provider] !== 'string') return null;
  return origins[provider] + RESET_PASS_SITE_PATHS[provider];
}

// The provider's own help article explaining what a reset pass is — the 「?」 beside every
// holdings line, for users who have never seen one. Help-center hosts, not the provider's app
// origin, so they are spelled here (provider-fetch-diag [10] bans only the app origins in bg/).
const RESET_PASS_HELP_URLS = Object.freeze({
  claude: 'https://support.claude.com/en/articles/17007452-what-is-a-limit-reset',
  chatgpt: 'https://help.openai.com/en/articles/20001507-paid-weekly-work-and-codex-rate-limit-resets',
});

/** The provider's "what is a reset pass" article, or null for any provider without one. */
export function resetPassHelpUrl(provider) {
  return Object.hasOwn(RESET_PASS_HELP_URLS, provider) ? RESET_PASS_HELP_URLS[provider] : null;
}

// A slot name no pass kind clears — what a window that is not the nominal 5h / 7d one is called
// (ChatGPT Free/Go report a 30-day window in the 7d slot, #954; a weekly pass does not reach it).
export const UNCLEARABLE_SLOT = 'other_window';
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;
// A reported span within this of the nominal one IS the nominal window (a second's rounding must
// not turn a weekly block into one no pass clears — Codex 2R). One hour keeps 5h, 7d and the
// 30-day window far apart.
const SPAN_TOLERANCE_SECONDS = 60 * 60;
const isSpan = (reported, nominal) => reported == null
  || (typeof reported === 'number' && Math.abs(reported - nominal) <= SPAN_TOLERANCE_SECONDS);

/**
 * The slots of a collected org that are at their limit now, in canClearNow's vocabulary.
 * Reads only the card fields every surface already renders from: h5 / d7 (percent) and the
 * reported spans w5s / w7s (null = not reported → the nominal window).
 */
export function blockedSlotsOf(org) {
  const out = [];
  if (!org || typeof org !== 'object') return out;
  if (typeof org.h5 === 'number' && org.h5 >= 100) {
    out.push(isSpan(org.w5s, FIVE_HOUR_SECONDS) ? FIVE_HOUR_SLOT : UNCLEARABLE_SLOT);
  }
  if (typeof org.d7 === 'number' && org.d7 >= 100) {
    out.push(isSpan(org.w7s, SEVEN_DAY_SECONDS) ? 'seven_day' : UNCLEARABLE_SLOT);
  }
  return out;
}

// Which of our slots one pass of each kind clears. canClearNow matches blocked slots against this.
const KIND_CLEARS = {
  full: (slot) => slot === FIVE_HOUR_SLOT || WEEKLY_SLOT_RE.test(slot),
  five_hour: (slot) => slot === FIVE_HOUR_SLOT,
  weekly: (slot) => WEEKLY_SLOT_RE.test(slot),
};

/** The 「모름」 summary. Never confuse with a known summary whose `available` is 0. */
export function unknownResetPassSummary(provider, now = Date.now()) {
  return {
    provider,
    known: false,
    available: 0,
    usable_now: null,
    by_kind: emptyResetPassKinds(),
    next_expires_at: null,
    blocked_by_other: false,
    cooldown_until: null,
    observed_at: now,
    eligible: null,
    ineligible_reason: null,
    kinds_known: false,
    usable_by_kind: emptyUsableKinds(),
    tickets: [],
  };
}

// Ticket chips (one per held pass) are capped: a pass with `left: 5` is five tickets, and a list
// longer than this is summarised as 「+N」 by the renderer, which reads `available` for the total.
export const RESET_PASS_TICKETS_MAX = 20;
const TICKET_KINDS = new Set(['full', 'five_hour', 'weekly']);

/**
 * Normalised passes → `[{ kind, expires_at }]`, one entry per pass held (a grant with `left: 2` is
 * two), known kinds only, unexpired at `now`, earliest expiry first, capped. Carries nothing that
 * identifies a pass (no pass_key / id) — only what the chips draw.
 */
export function ticketsFromPasses(passes, now = Date.now()) {
  const out = [];
  for (const p of Array.isArray(passes) ? passes : []) {
    if (!p || !TICKET_KINDS.has(p.kind) || typeof p.expires_at !== 'string') continue;
    const t = Date.parse(p.expires_at);
    if (!Number.isFinite(t) || t <= now) continue;
    const n = isPassCount(p.left) ? Math.min(p.left, RESET_PASS_TICKETS_MAX) : 0;
    for (let i = 0; i < n; i++) out.push({ kind: p.kind, expires_at: p.expires_at, _t: t });
  }
  out.sort((a, b) => a._t - b._t || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return out.slice(0, RESET_PASS_TICKETS_MAX).map(({ kind, expires_at }) => ({ kind, expires_at }));
}

/** A pass count as the providers send it: a non-negative integer, anything else unreadable. */
export function isPassCount(n) {
  return Number.isInteger(n) && n >= 0;
}

/** The summary says the user holds at least one countable pass. 「모름」 never holds any. */
export function holdsAny(summary) {
  return summary?.known === true && isPassCount(summary.available) && summary.available > 0;
}

/**
 * True only when ONE pass usable right now would clear EVERY slot currently at its limit
 * (docs/plans/usage-reset-passes.md P1-2). Two partial passes do not add up: the site spends one
 * pass per click, so 5h + 7d blocked with only a five_hour pass and a weekly pass is still false.
 *
 * @param {object} summary       ResetPassSummary
 * @param {string[]} blockedSlots our slot names at limit now, e.g. ['five_hour', 'seven_day']
 */
export function canClearNow(summary, blockedSlots) {
  if (summary?.known !== true || summary.kinds_known !== true || summary.blocked_by_other !== false) return false;
  if (!Array.isArray(blockedSlots) || blockedSlots.length === 0) return false;
  if (!blockedSlots.every((s) => typeof s === 'string')) return false;
  const usable = summary.usable_by_kind;
  if (!usable || typeof usable !== 'object') return false;
  return Object.keys(KIND_CLEARS).some((kind) => isPassCount(usable[kind]) && usable[kind] > 0
    && blockedSlots.every(KIND_CLEARS[kind]));
}
