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

/**
 * The ONE 「clear it now」 call every surface may emphasise (popup headline, overview badge, in-page
 * sidebar line): canClearNow AND the blocked windows do not refill on their own within
 * RP_ADVICE_RESET_SOON_H. Batch review 1.55.2: with 2h to a natural reset the headline, badge and
 * sidebar said 「지금 풀 수 있어요」 while the advice line said 「아껴두세요 — 2시간 뒤 저절로」.
 * A refill time we do not know leaves only the fact (canClearNow) to speak.
 */
export function clearNowWorthIt(summary, blockedSlots, resets5hMs, resets7dMs, nowMs = Date.now()) {
  if (!canClearNow(summary, blockedSlots)) return false;
  const ends = blockedSlots.map((sl) => (sl === FIVE_HOUR_SLOT ? resets5hMs : resets7dMs));
  if (!ends.every(Number.isFinite)) return true;
  return Math.max(...ends) - nowMs > RP_ADVICE_RESET_SOON_H * HOUR_MS;
}

// ── 「지금 쓰세요 / 아껴두세요」 — when spending a pass pays off (#2092, user idea 2026-10-05) ─────
//
// A pass is worth the most against a LONG block and nothing once it lapses. v2 (user ask + a design
// debate, 2026-10-05) compares LENGTHS, not counts: the block in front of the user against the
// blocks this account usually hits, discounted by the chance of hitting the limit again before the
// pass expires. Local history only; nothing is sent anywhere for this. Pure: every input passed in.
//
// The comparison leans toward 「use the certain block now」 (debate consensus — 2~4 past cycles make
// any finer model overconfident):
//   P     = P(at least k more weekly walls before the passes expire), the per-cycle wall rate shrunk
//           toward ½ as (walled+1)/(seen+2) with the current (walled) cycle counted in; k = passes
//           that clear the weekly limit
//   R     = hours until the blocked windows refill on their own
//   lo/med = the shortest / median past block (hours from the estimated wall to the reset)
//   G     = what spending now buys: min(R, the usual burn from 0 = 168h − a past block) — a weekly
//           pass keeps resets_at (v3, 2026-10-08), so a fast burner is blocked again before the reset.
//           G_hold uses the longest burn (168 − lo), G_use the median one (168 − med)
//   hold  when P × lo  ≥ RP_ADVICE_HOLD_MARGIN × G_hold — even a short usual block, discounted, beats now
//   use   when P × med ≤ G_use                         — now buys at least a usual block
//   useAfter (fact, use/similar lines only): when R > 168 − med, spending at reset − (168 − med)
//           buys the same unblocked time and keeps the pass until then
//   else  「비슷해요」 (similar) — no confident call either way
// The current cycle's own block is NOT a sample: the user's case is exactly 「this week is short,
// usually long」. A pattern that really changed is caught by the last-chance rule (no cycle left
// before expiry → use now) and by the new short blocks entering the history.
//
// Verdicts (`null` = say nothing — the chip and the headline link already state the facts):
//   use_now          reason last (no wall can come before the first pass expires) | longer
//                    (G_use ≥ P × med) | five_hour (5h-only block, a 5h pass held) | no_weekly_ahead
//                    (5h-only block, only a full pass, no weekly wall expected while it is valid)
//   use_or_lose      not blocked, a 7d-clearing pass expires within RP_ADVICE_EXPIRY_DAYS, no wall
//                    is forecast before it does, and the site lets it be spent now
//   similar          blocked, neither rule is confident
//   hold_for_wall    reason longer (P × lo ≥ margin × G_hold) | save_full (5h-only block, only a full
//                    pass, a weekly wall expected while it is valid)
//   hold_until_wall  not blocked yet, but the 7d forecast hits 100% before the reset (`at`)
//   hold_reset_soon  blocked, and the window refills on its own within RP_ADVICE_RESET_SOON_H
//
// Measured 2026-10-05 (plan §6-1): a Claude weekly/full pass keeps seven_day.resets_at and zeroes
// the usage; a 5-hour pass restarts its window. ChatGPT is not measured — the same G is applied.
export const RP_ADVICE_RESET_SOON_H = 3;
export const RP_ADVICE_EXPIRY_DAYS = 3;
export const RP_ADVICE_HOLD_MARGIN = 1.5;
// Past blocks needed before lengths are compared at all; fewer and only last / reset-soon speak.
export const RP_ADVICE_MIN_BLOCKS = 2;
// A wall happens late in its cycle, so a cycle whose end is at most this much after the pass
// expires can still be walled while the pass is valid.
const RP_ADVICE_WALL_LEAD_MS = 24 * 3600000;
const HOUR_MS = 3600000;
const WEEK_MS = SEVEN_DAY_SECONDS * 1000;
// Two resets_at values this close are one cycle (the same jitter tolerance p7Cycles uses).
const SAME_CYCLE_TOL_MS = 6 * HOUR_MS;
// A completed cycle counts only if it was observed this close to its reset — else its peak is
// a partial value and a missing wall would read as 「did not hit the limit」.
const PAST_CYCLE_END_GAP_MS = 24 * HOUR_MS;
// A block's length needs the wall pinned: the last <100% and first 100% samples at most this far
// apart (the wall is taken as their midpoint). A wider gap still counts the wall, not its length.
const BLOCK_HIT_GAP_MS = 6 * HOUR_MS;
// A cycle shorter than this share of a week was cut short (a pass used, or a moved reset): its
// wall and length do not describe a normal week, so it is skipped altogether.
const MIN_CYCLE_SPAN_FRAC = 5 / 7;
// A fall this large inside one cycle is a cleared window (a pass used — the same threshold the
// 7d forecast re-anchors on): its later 100% samples are a second, unrelated wall.
// A copy of ui/diurnal.js P7_PASS_DROP_PTS (this file imports nothing); test/pred7d-pace-how-guard.mjs
// asserts the two are equal.
export const SAME_CYCLE_FALL_PTS = 20;
const WEEKLY_PASS_KINDS = new Set(['full', 'weekly']);

/**
 * One org's usage-history rows — the rule the popup's _filteredHistory, the in-page sidebar and the
 * reset-pass notifier share: rows tagged with this org, plus the legacy untagged rows when this is
 * the Claude primary org (`includeLegacy`). No org id → every row. Here (not in bg/sidebar-usage.js)
 * so the notifier can reuse it without importing the sidebar's runtime dependencies.
 */
export function orgHistory(history, orgUuid, includeLegacy) {
  if (!Array.isArray(history)) return [];
  return orgUuid ? history.filter((p) => p.org === orgUuid || (includeLegacy && !p.org)) : history;
}

/**
 * The completed weekly cycles in `points` (usage history rows `{ t, d7, r7 }`, one org): how many
 * were seen, how many hit 100%, and the block lengths (hours from the estimated wall to the reset)
 * of the walled ones whose wall is pinned. A cycle counts only once its reset has passed and it was
 * observed within a day of it; one cut short is skipped.
 */
export function pastWeeklyBlocks(points, nowMs) {
  const cycles = [];
  const pts = (Array.isArray(points) ? points : [])
    .map((p) => ({ t: Number(p && p.t), u: p && p.d7 != null ? Number(p.d7) : NaN, r: p && p.r7 ? Date.parse(p.r7) : NaN }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.u) && Number.isFinite(p.r) && p.t <= nowMs)
    .sort((a, b) => a.t - b.t);
  for (const p of pts) {
    const c = cycles[cycles.length - 1];
    if (!c || Math.abs(p.r - c.r) >= SAME_CYCLE_TOL_MS) cycles.push({ r: p.r, pts: [p] });
    else c.pts.push(p);
  }
  let seen = 0, walled = 0;
  const blocks = [];
  for (let i = 0; i < cycles.length; i++) {
    const c = cycles[i];
    const last = c.pts[c.pts.length - 1].t;
    if (c.r > nowMs || c.r - last > PAST_CYCLE_END_GAP_MS) continue;
    if (i > 0 && c.r - cycles[i - 1].r < WEEK_MS * MIN_CYCLE_SPAN_FRAC) continue;
    if (c.pts.some((p, j) => j > 0 && p.u <= c.pts[j - 1].u - SAME_CYCLE_FALL_PTS)) continue; // Codex v2 1R
    seen++;
    const hit = c.pts.findIndex((p) => p.u >= 100);
    if (hit < 0) continue;
    walled++;
    const before = hit > 0 ? c.pts[hit - 1] : null;
    if (!before || c.pts[hit].t - before.t > BLOCK_HIT_GAP_MS) continue;
    blocks.push((c.r - (before.t + c.pts[hit].t) / 2) / HOUR_MS);
  }
  return { seen, walled, blocks };
}

/**
 * Weekly cycles ending after `resets7dMs` whose wall can still fall before `expiresMs`. A wall comes
 * `leadMs` before its cycle ends — at least a day, longer for a user whose blocks usually are (Codex
 * v2 1R: a 100h-block user's next wall lands before a pass that outlives the cycle end by 0h).
 */
function cyclesBefore(expiresMs, resets7dMs, leadMs = RP_ADVICE_WALL_LEAD_MS) {
  if (!Number.isFinite(expiresMs) || !Number.isFinite(resets7dMs)) return 0;
  const lead = Math.max(RP_ADVICE_WALL_LEAD_MS, Number.isFinite(leadMs) ? leadMs : 0);
  let n = 0;
  for (let end = resets7dMs + WEEK_MS; end <= expiresMs + lead; end += WEEK_MS) n++;
  return n;
}

/** P(X ≥ k) for X ~ Binomial(n, p). */
function atLeast(n, p, k) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let sum = 0, c = 1; // c = C(n, i)
  for (let i = 0; i <= n; i++) {
    if (i >= k) sum += c * p ** i * (1 - p) ** (n - i);
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, Math.max(0, sum));
}

const median = (xs) => {
  const a = xs.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * The advice for one org, or null.
 * @param {object} a
 * @param {object} a.summary          ResetPassSummary (needs kinds_known + tickets)
 * @param {string[]} a.blocked        blockedSlotsOf(...) for the values on screen
 * @param {number|null} a.resets5hMs
 * @param {number|null} a.resets7dMs
 * @param {number|null} a.hoursTo100  7d forecast: hours until 100% when it lands before the reset
 * @param {{seen:number, walled:number, blocks:number[]}|null} a.past  pastWeeklyBlocks(...)
 * @param {number} a.nowMs
 */
export function resetPassAdvice({ summary, blocked, resets5hMs, resets7dMs, hoursTo100, past, nowMs }) {
  const s = summary;
  if (!holdsAny(s) || s.kinds_known !== true || !Number.isFinite(nowMs)) return null;
  const tickets = (Array.isArray(s.tickets) ? s.tickets : [])
    .map((x) => ({ kind: x && x.kind, exp: x ? Date.parse(x.expires_at) : NaN }))
    .filter((x) => TICKET_KINDS.has(x.kind) && Number.isFinite(x.exp) && x.exp > nowMs)
    .sort((a, b) => a.exp - b.exp);
  if (!tickets.length) return null;
  const weekly = tickets.filter((x) => WEEKLY_PASS_KINDS.has(x.kind));
  // Only a kind the provider says is usable now may be advised for use — an expiring pass that
  // cannot be spent must not hurry the user into spending a different one (Codex 1R).
  const usableNow = (x) => (s.usable_by_kind?.[x.kind] || 0) > 0;
  // Usability is reported per KIND, expiry per ticket. When only some tickets of a kind are usable
  // we cannot tell which, and every verdict below leans on a usable pass's expiry — so say nothing
  // rather than guess (Codex 2R: an unusable 10/6 full beside a usable 10/15 full read as 「last」).
  // Held = the provider's per-kind count, not the tickets (capped at RESET_PASS_TICKETS_MAX, Codex 3R).
  const held = {};
  for (const x of tickets) held[x.kind] = (held[x.kind] || 0) + 1;
  for (const k of TICKET_KINDS) held[k] = Math.max(held[k] || 0, isPassCount(s.by_kind?.[k]) ? s.by_kind[k] : 0);
  if (Object.keys(held).some((k) => { const u = s.usable_by_kind?.[k] || 0; return u > 0 && u < held[k]; })) return null;
  const weeklyUsable = weekly.filter(usableNow);
  const r7 = Number.isFinite(resets7dMs) ? resets7dMs : null;
  const seen = past && Number.isInteger(past.seen) ? past.seen : 0;
  const walledPast = past && Number.isInteger(past.walled) ? past.walled : 0;
  const blocks = (past && Array.isArray(past.blocks) ? past.blocks : []).filter((h) => Number.isFinite(h) && h > 0);
  const wallAt = Number.isFinite(hoursTo100) && hoursTo100 >= 0 ? nowMs + hoursTo100 * HOUR_MS : null;
  const slots = Array.isArray(blocked) ? blocked : [];

  if (slots.length) {
    if (!canClearNow(s, slots)) return null;
    const ends = slots.map((sl) => (sl === FIVE_HOUR_SLOT ? resets5hMs : r7)).filter(Number.isFinite);
    if (ends.length !== slots.length) return null;
    const hours = (Math.max(...ends) - nowMs) / HOUR_MS;
    if (hours <= RP_ADVICE_RESET_SOON_H) return { verdict: 'hold_reset_soon', hours };
    const weeklyBlocked = slots.some((sl) => WEEKLY_SLOT_RE.test(sl));
    if (!weeklyBlocked) {
      // Only the 5h window: a five_hour pass is made for this; a full pass is worth more later
      // against the weekly limit when a weekly wall is expected while it is still valid (Codex 1R).
      if ((s.usable_by_kind?.five_hour || 0) > 0) return { verdict: 'use_now', reason: 'five_hour', hours };
      // The full pass the site would spend first (earliest-expiring usable), with the wall lead
      // taken from this user's own blocks — the same basis as the weekly branch (Codex v2 2R).
      const fullExp = tickets.find((x) => x.kind === 'full' && usableNow(x))?.exp;
      const rate = seen >= RP_ADVICE_MIN_BLOCKS ? (walledPast + 1) / (seen + 2) : 0;
      const leadMs = blocks.length >= RP_ADVICE_MIN_BLOCKS ? Math.min(...blocks) * HOUR_MS : 0;
      const weeklyAhead = Number.isFinite(fullExp) && ((wallAt != null && wallAt < fullExp)
        || (r7 != null && atLeast(cyclesBefore(fullExp, r7, leadMs), rate, 1) >= 0.5));
      return weeklyAhead ? { verdict: 'hold_for_wall', reason: 'save_full', hours }
        : { verdict: 'use_now', reason: 'no_weekly_ahead', hours };
    }
    if (!weeklyUsable.length || r7 == null) return null;
    // The decision is about the pass the site would spend first: the earliest-expiring USABLE one
    // (Codex v2 1R — unusable passes and later expiries must not dilute it).
    const first = weeklyUsable[0];
    const enough = blocks.length >= RP_ADVICE_MIN_BLOCKS;
    const lo = enough ? Math.min(...blocks) : 0;
    const leadMs = lo * HOUR_MS; // the shortest usual block: the conservative (latest) wall
    const nFirst = cyclesBefore(first.exp, r7, leadMs);
    // The first pass has no wall left before it lapses: this block is its last chance.
    if (nFirst === 0) return { verdict: 'use_now', reason: 'last', hours, expiresAt: first.exp };
    if (!enough) return null;
    // The current cycle is walled (we are blocked), so it is one more seen + walled observation.
    const rate = (walledPast + 1 + 1) / (seen + 1 + 2);
    // Saving the first pass pays only if enough walls come before IT expires for every usable pass
    // that expires by then too (they compete for the same walls); later passes have walls of their own.
    const k = weeklyUsable.filter((x) => cyclesBefore(x.exp, r7, leadMs) <= nFirst).length;
    const prob = atLeast(nFirst, rate, k);
    const hi = Math.max(...blocks), med = median(blocks);
    // What spending now buys. A weekly pass zeroes usage but KEEPS resets_at (measured 2026-10-05,
    // plan §6-1), so the fresh 100% lasts as long as this user takes to burn a week's budget from 0
    // — a cycle minus its block — or until the reset, whichever comes first. A user who walls on day
    // 3 and is blocked for 4 days gets ~3 days back, not 4. Each side takes its conservative end:
    // holding is weighed against the LONGEST usual burn (the most a spend could buy), spending
    // against the median one.
    const weekH = WEEK_MS / HOUR_MS;
    // A block can read ≥ a week only from a broken sample; a burn is never negative (Codex v3 1R).
    const burnLong = Math.max(0, weekH - lo), burnMed = Math.max(0, weekH - med);
    const gainHold = Math.min(hours, burnLong);
    const gainUse = Math.min(hours, burnMed);
    const facts = { hours, lo, hi, prob };
    // Spent now, the usual burn ends before the reset: the block comes back. Spending it later —
    // once at most that burn is left before the reset — buys the same unblocked time and keeps the
    // pass until then. A fact for the line, not a separate verdict (clearNowCall is unchanged).
    if (burnMed > 0 && hours > burnMed) facts.useAfter = r7 - burnMed * HOUR_MS;
    if (prob * lo >= RP_ADVICE_HOLD_MARGIN * gainHold) return { verdict: 'hold_for_wall', reason: 'longer', ...facts };
    if (prob * med <= gainUse) return { verdict: 'use_now', reason: 'longer', ...facts };
    return { verdict: 'similar', ...facts };
  }

  if (!weekly.length) return null;
  const first = weekly[0];
  if (first.exp - nowMs <= RP_ADVICE_EXPIRY_DAYS * 24 * HOUR_MS) {
    if (wallAt != null && wallAt < first.exp) return { verdict: 'hold_until_wall', at: wallAt, expiresAt: first.exp };
    // Not blocked and no wall before it lapses: say so only when the site lets it be spent now
    // (ChatGPT reports nothing applicable off-limit) — otherwise the line would be an order the
    // user cannot follow.
    return usableNow(first) ? { verdict: 'use_or_lose', expiresAt: first.exp } : null;
  }
  if (wallAt != null) return { verdict: 'hold_until_wall', at: wallAt };
  return null;
}

/**
 * THE view every reset-pass surface decides from — notification cards, popup chip/headline/advice,
 * overview badge, in-page sidebar (#2092 P2 Codex 5R; surfaces since the 1.55.9 batch review: each path filtering expiry on its own
 * left the count fallback and clearNowCall reading passes that had lapsed). A summary is observed at
 * collection time; by the time a card is decided — a deferred one at 08:00, a stale one after
 * failed collections — some passes it lists may have expired. Those are taken OUT here:
 *   · tickets are earliest-first and capped at RESET_PASS_TICKETS_MAX, so the lapsed ones are always
 *     inside the list and subtracting them from `available` / `by_kind` is exact even past the cap;
 *   · which pass the provider called usable is not known per ticket, so a summary with any lapsed
 *     pass is `stale` and each kind's usable count loses its lapsed passes (assumed usable) —
 *     clearNowCall (still the one judgement) is fed this view;
 *   · a ticketless summary (ChatGPT before its detail read) whose next_expires_at has passed is
 *     `stale` too; with no next_expires_at its expiry is simply unknown (`expiryKnown: false`).
 */
export function resetPassLiveView(rp, now) {
  const tickets = Array.isArray(rp.tickets) ? rp.tickets.filter((t) => t && typeof t.kind === 'string') : [];
  const lapsed = tickets.filter((t) => !(Date.parse(t.expires_at) > now));
  const nextExp = Date.parse(rp.next_expires_at || '');
  const expiryKnown = rp.kinds_known === true && Array.isArray(rp.tickets);
  const stale = lapsed.length > 0 || (Number.isFinite(nextExp) && nextExp <= now);
  if (!stale) return { rp, stale, expiryKnown };
  const byKind = { ...(rp.by_kind || {}) };
  for (const t of lapsed) byKind[t.kind] = Math.max(0, (Number(byKind[t.kind]) || 0) - 1);
  const live = tickets.filter((t) => !lapsed.includes(t));
  // Usable counts lose the lapsed passes of their kind — assuming each lapsed one was usable, the
  // side that never over-promises — so a still-valid pass keeps its 「지금 풀 수 있어요」 (Codex: zeroing
  // every kind on one lapse hid a valid weekly pass). A ticketless summary whose next expiry passed
  // cannot say which kind lapsed: nothing is usable until a fresh collection.
  const lapsedBy = {};
  for (const t of lapsed) lapsedBy[t.kind] = (lapsedBy[t.kind] || 0) + 1;
  const usable = {};
  for (const k of Object.keys(rp.usable_by_kind || {})) {
    usable[k] = lapsed.length ? Math.max(0, (Number(rp.usable_by_kind[k]) || 0) - (lapsedBy[k] || 0)) : 0;
  }
  const usableNow = lapsed.length && Number.isFinite(rp.usable_now) ? Math.max(0, rp.usable_now - lapsed.length) : 0;
  return {
    stale, expiryKnown,
    rp: {
      ...rp, available: Math.max(0, rp.available - lapsed.length), by_kind: byKind, tickets: live,
      next_expires_at: live.length ? live[0].expires_at : null, usable_by_kind: usable, usable_now: usableNow,
    },
  };
}

/**
 * The summary with passes that have expired since it was observed taken out — what every surface
 * renders and judges (resetPassLiveView). A missing or 「모름」 summary comes back as it is.
 */
export function liveResetPasses(rp, nowMs = Date.now()) {
  if (!rp || rp.known !== true || !isPassCount(rp.available)) return rp ?? null;
  return resetPassLiveView(rp, nowMs).rp;
}

/**
 * THE 「지금 풀 수 있어요」 call — the only function any surface (popup headline, overview badge,
 * in-page sidebar line) may use to emphasise spending a pass now (batch review 1.55.2, 2 rounds:
 * each surface deciding on its own put 「clear it now」 beside 「아껴두세요」). True only when
 * clearNowWorthIt holds AND the advice for the same inputs is not a hold. Every caller passes the
 * same local history (pastWeeklyBlocks over the org's own rows, legacy rows for the Claude primary).
 */
export function clearNowCall(summary, blockedSlots, resets5hMs, resets7dMs, past, nowMs = Date.now()) {
  if (!clearNowWorthIt(summary, blockedSlots, resets5hMs, resets7dMs, nowMs)) return false;
  // Only the 5h window blocked and no five_hour pass to spend: the call would be a FULL pass on a
  // 5h block, whose advice also weighs the 7d forecast — which not every surface has. Never
  // emphasise it (the detail advice line may still say use it). This keeps every verdict that reads
  // the forecast out of clearNowCall, so 「clear now ⇒ advice not hold」 holds on every surface
  // whatever forecast it has (batch review 1.55.2 R3).
  if (!blockedSlots.some((sl) => WEEKLY_SLOT_RE.test(sl)) && !((summary.usable_by_kind?.five_hour || 0) > 0)) return false;
  const adv = resetPassAdvice({ summary, blocked: blockedSlots, resets5hMs, resets7dMs, hoursTo100: null, past, nowMs });
  return !(adv && typeof adv.verdict === 'string' && adv.verdict.startsWith('hold'));
}
