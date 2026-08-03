// The projected-at-reset tier ladder and the verdicts derived from it — pure, dependency-free.
//
// THIS FILE IS THE SINGLE SOURCE OF TRUTH for what a usage forecast MEANS. The extension imports
// it as an ES module; the dashboard cannot (classic global scripts, separate CF Pages deploy), so
// it uses an AUTO-GENERATED classic-script twin at site/shared/usage-tiers.js — produced by
// `node scripts/sync-usage-tiers.mjs` and guarded by `scripts/check-usage-tiers-parity.mjs`
// (wired into npm test / test:guards). Edit the rules HERE only, then re-run sync; never
// hand-edit the twin.
//
// Why it exists: the extension bucketed by projected-%, the dashboard by hoursTo100, and the
// popup itself had a third window-average pace. One account could be "주의" in the popup and
// "빠듯" on the dashboard for the same usage. Keeping the FORECAST shared (ui/diurnal.js) was
// never enough — the verdict has to be shared too.
//
// Keep this file free of imports and of DOM/chrome/i18n access: the sync script only strips
// import/export keywords, so anything else would break the twin.

// === The projected-at-reset ladder ===========================================================
// ONE definition of "how bad is this forecast", shared by the gauge line, the status banner and
// the chart info label. Cuts are the projection AT RESET (%), not the current value.
//
// WHY A LADDER AND NOT A THRESHOLD — the popup used to show a graded per-gauge forecast line;
// it was deleted on 2026-07-25 (0d2e7d3e) as redundant with the bar's striped fill, and 13
// minutes later (d40a3594) the hole that left was patched with ONE hard cut (NEAR_LIMIT_PCT =
// 99) picked from the single case in hand. That is why a window projected to 97% said nothing
// at all. These are the cuts the pace banner had all along — now applied to the projection
// everything else already uses, so one forecast drives every signal.
//
// WHY PRESSING IS 95 AND NOT 90 — the 7d projector is discount-ONLY (ui/diurnal.js clamps the
// activity-mass result to the flat-linear one), so a window that will genuinely finish at the
// cap surfaces just BELOW it; 95-100 is where those land. Under that, WARMING already speaks,
// so the red line can stay rare enough to still mean something.
//
// AT_LIMIT is a STATE, not a forecast — `min: Infinity` makes it unreachable by projection, so
// only the explicit capped branch in windowTier() can select it. It exists because the loudest
// pace rung was saying "크게 넘는 페이스" to someone who is not moving at all: they are blocked,
// waiting for a reset. A pace verdict about a stopped user is simply false.
export const PROJECTION_TIERS = [
  { id: 'at_limit',    min: Infinity, css: 'darkred' },
  { id: 'runaway',     min: 120, css: 'darkred' },
  { id: 'critical',    min: 100, css: 'red' },
  { id: 'pressing',    min: 95,  css: 'orange' },
  { id: 'warming',     min: 75,  css: 'yellow' },
  { id: 'ontrack',     min: 50,  css: 'green' },
  { id: 'comfortable', min: 0,   css: 'green' },
];

const _tierMin = (id) => PROJECTION_TIERS.find((tier) => tier.id === id).min;
const _tier = (id) => PROJECTION_TIERS.find((tier) => tier.id === id);

// The capped state, selected only by windowTier()'s explicit branch (see the note above).
export const AT_LIMIT_TIER = _tier('at_limit');

// Ordered worst-first, so the first match IS the tier and the index IS the severity rank.
// Returns null for a missing/non-finite projection so callers can tell "no forecast yet" from
// "forecast says you are fine" — the two must not render the same.
export function projectionTier(predicted) {
  if (predicted == null || !Number.isFinite(predicted)) return null;
  return PROJECTION_TIERS.find((tier) => predicted >= tier.min)
    || PROJECTION_TIERS[PROJECTION_TIERS.length - 1]; // a falling window can project below 0
}

export function tierSeverity(tier) {
  const i = PROJECTION_TIERS.indexOf(tier);
  return i < 0 ? -1 : PROJECTION_TIERS.length - i; // higher = worse
}

// One shade per rung, for every projection-colored element: the forecast line, the "▸ X%" badge
// and the striped projection fill, in both the detail gauges and the overview cards. These used
// to carry their own >= 80 / >= 50 cuts, which is why a badge could read red while the line
// beside it stayed amber.
export const TIER_COLOR = {
  runaway: '#dc2626', critical: '#ef4444', pressing: '#ef4444',
  warming: '#f59e0b', ontrack: '#9ca3af', comfortable: '#9ca3af',
};

export function tierColor(predicted) {
  const tier = projectionTier(predicted);
  return tier ? TIER_COLOR[tier.id] : TIER_COLOR.comfortable;
}

// PRESSING and above — the levels that get an alarm rather than a note. Drives the solid/tinted
// badge treatment so "loud" means the same thing everywhere.
export function isAlertTier(predicted) {
  const tier = projectionTier(predicted);
  return !!tier && tierSeverity(tier) >= tierSeverity(PROJECTION_TIERS.find((x) => x.id === 'pressing'));
}

// Minimum projected GROWTH (%p over the current value) worth drawing a marker for. Below it the
// forecast is visually indistinguishable from the current fill, so the gauge shows a "stable" look
// instead of a marker that hasn't moved.
const STABLE_DELTA_PCT = 3;

// === Verdict predicates — THE single source of truth for what a projection means ==============
// The detail gauges (this file) and the overview cards (ui/overview.js) render different DOM from
// the SAME forecast, so the verdict itself must be shared: a projection that warns in one tab and
// stays silent in the other is a bug users read as flakiness. Keep every threshold here; a caller
// that re-derives one locally is exactly the drift this consolidates (test/limit-eta-guard.mjs
// fails if either renderer grows its own copy).
//
// All three take a RISING window that is not already capped — a forecast built on a flat or
// falling rate is not a claim about the future, and a capped window has the capped block instead.
function _forecastApplies(rate, currentUtil) {
  return rate > 0 && currentUtil < 100;
}

// Does this projection cross the cap at all? The rate/util guards are deliberately absent —
// callers that only need "is there an arrival time to name" ask this, and callers that need a
// verdict about a rising, uncapped window ask isAtRiskOfCap below. Both read the cap from the
// ladder, so `100` lives in exactly one place.
export function crossesCap(predicted) {
  return predicted != null && predicted >= _tierMin('critical');
}

// CRITICAL/RUNAWAY: projected to reach the cap before the window resets → the wait block.
export function isAtRiskOfCap(predicted, rate, currentUtil) {
  return crossesCap(predicted) && _forecastApplies(rate, currentUtil);
}

// PRESSING: projected close to the cap without cleanly crossing it → the red near-limit line.
export function isNearLimit(predicted, rate, currentUtil) {
  return !isAtRiskOfCap(predicted, rate, currentUtil) &&
    predicted >= _tierMin('pressing') && _forecastApplies(rate, currentUtil);
}

// WARMING: heading up but with room left → the quiet amber "projected ~X% at reset" line. This
// is the graded step 0d2e7d3e removed; without it the only choice was "silent" or "red".
export function isRisingNotice(predicted, rate, currentUtil) {
  return predicted < _tierMin('pressing') &&
    predicted >= _tierMin('warming') && _forecastApplies(rate, currentUtil);
}

// The green "▸ —" stable badge. Flat/falling usage earns it — EXCEPT while the near-limit line is
// up: a green "nothing to worry about" badge sitting next to a red "about to run out" warning is a
// contradiction the user has to resolve, and the level-based warning is the one that matters.
// (The amber WARMING line is informational, not a warning, so it does not withhold the badge.)
export function isStableLook(predicted, rate, currentUtil) {
  return (rate <= 0 || predicted - currentUtil < STABLE_DELTA_PCT) &&
    !isNearLimit(predicted, rate, currentUtil);
}

// === The short-window (5h) forecast ==========================================================
// THE flat-rate projection, shared by the popup and the dashboard. It used to be two hand-written
// copies with different rules — the popup walked a 2h/6h/all lookback ladder and took a net
// slope; the dashboard used a fixed 2h window and summed positive deltas across matching reset
// ids. One ladder applied to two different numbers is not "one forecast", and the two could land
// in different tiers for the same account.
//
// The 7d window has its own projector (ui/diurnal.js) because a multi-day horizon needs the
// diurnal/weekly shape. Five hours does not — the horizon is short enough that a flat rate is the
// honest model, which is why diurnal.js documents itself as 7d-only.
//
// `samples`: [{ tMs, util, resetKey? }] in any order, from whatever store the caller has.
// Callers map their own shape in; that is the only part that stays per-runtime. resetKey is the
// window's reset identity when the caller has one — see the boundary rules below.
export const FLAT_LOOKBACKS_H = [2, 6, Infinity];
// Below this span the two endpoints are too close in time for the slope between them to mean
// anything — a 5-minute sampling jitter would dominate.
export const FLAT_MIN_SPAN_H = 0.5;

export function projectFlatWindow({ samples, currentUtil, hoursToReset, nowMs }) {
  if (currentUtil == null || !Number.isFinite(currentUtil)) return null;
  if (!Number.isFinite(hoursToReset) || !Number.isFinite(nowMs) || !Array.isArray(samples)) return null;
  const usable = samples
    .filter((s) => s && Number.isFinite(s.tMs) && s.util != null && Number.isFinite(s.util))
    .sort((a, b) => a.tMs - b.tMs);

  // Widen the lookback until there is something to measure: a quiet account has no samples in the
  // last 2h but may have plenty in the last 6.
  let win = [];
  for (const lookbackH of FLAT_LOOKBACKS_H) {
    win = usable.filter((s) => lookbackH === Infinity || s.tMs > nowMs - lookbackH * 3600000);
    if (win.length >= 2) break;
  }
  if (win.length < 2) return null;

  const hoursDiff = (win[win.length - 1].tMs - win[0].tMs) / 3600000;
  if (!(hoursDiff >= FLAT_MIN_SPAN_H)) return null;

  // Burn is summed interval by interval, and how an interval is read depends on whether a window
  // boundary sits inside it:
  //
  //  • KNOWN boundary (resetKey present on both ends and different) — the newer sample belongs to
  //    a fresh cycle that started at 0, so everything it holds was burned in this interval. The
  //    value can RISE across such a boundary (49% -> reset -> 50%), which is exactly the case a
  //    drop heuristic cannot see: it would read +1 while the new cycle is already at 50.
  //  • otherwise — POSITIVE delta only. The value falls for two reasons, a reset or a plan change
  //    under it, and neither is negative usage. A net (last - first) slope reads both as burning
  //    backwards: measured, a 2h lookback straddling a 5h reset reported -33.6%/h and a
  //    "comfortable" verdict for a user 90 minutes from the cap. Positive deltas are identical to
  //    the net slope for a window that only rises, and refuse to invent negative usage for one
  //    that dips.
  //
  // resetKey is optional because not every caller has one: extension samples written before r5
  // was recorded carry none, and they fall to the second rule rather than being discarded.
  let totalDelta = 0;
  for (let i = 1; i < win.length; i++) {
    const prev = win[i - 1], curr = win[i];
    const knownBoundary = prev.resetKey != null && curr.resetKey != null && prev.resetKey !== curr.resetKey;
    totalDelta += knownBoundary ? Math.max(0, curr.util) : Math.max(0, curr.util - prev.util);
  }

  const rate = totalDelta / hoursDiff;
  return { rate, predicted: currentUtil + rate * hoursToReset, hoursDiff, dataPoints: win.length };
}

// === Window verdict for the banner =========================================================
// How long each window runs, for the degraded projection below.
const WINDOW_SECONDS = { h5: 5 * 3600, d7: 7 * 24 * 3600 };
// Below this share of the window elapsed, an average over it is noise, not a pace.
const DEGRADED_MIN_ELAPSED_FRAC = 0.10;

// Degraded projection, used ONLY where the real forecast has nothing to say. The 5h branch of
// calcPredictedAtReset needs ~30 minutes of local samples, so a fresh install or a just-added
// org has no rate yet — and utilization alone (">= 95 is red, else green") would hand a heavy
// user the green "여유 — 마음껏 사용하세요!" banner. This assumes the window's average pace holds
// to the end: exactly the estimate the deleted calcPaceTier made for EVERYONE, now demoted to a
// fallback. It feeds the SAME ladder, so it can never invent a different scale.
//
// It does NOT follow that it "cannot contradict the gauges" — this comment claimed that and the
// claim was wrong. When this speaks, the detail gauges and the overview cards are showing
// "collecting", because they call calcPredictedAtReset directly and never see this fallback. So
// the banner and the chart state a tier while the gauges beside them decline to. That is a
// coverage gap between consumers, not a contradiction in the number, and it is still a gap.
//
// It substitutes for EVERY null calcPredictedAtReset returns, not only thin history: also a reset
// within ~3 minutes, and the 7d helper's own near-reset/invalid-input exits. That is deliberate
// and safe rather than merely tolerated — near the end of a window `fraction` approaches 1, so
// this returns approximately the current utilization, which is what actually happened. It is the
// early-window cases that need the guard below, and they have it.
export function windowAverageProjection(currentUtil, key, resetsAt) {
  const windowSeconds = WINDOW_SECONDS[key];
  if (currentUtil == null || !resetsAt || !windowSeconds) return null;
  if (currentUtil === 0) return 0;
  const remaining = Math.max((new Date(resetsAt).getTime() - Date.now()) / 1000, 0);
  const fraction = (windowSeconds - remaining) / windowSeconds;
  if (!(fraction >= DEGRADED_MIN_ELAPSED_FRAC) || fraction >= 1) return null;
  return currentUtil / fraction;
}

// === Picking what to say when both windows have an opinion ===================================

// An arrival time that lands AFTER the window's own reset is not an arrival time: the window
// resets first and the count starts over. Returns the hours-to-100 only when it is real, so a
// caller can treat "non-null" as "there is a moment worth naming".
//
// Without this, 80% used at +3%/h with 5h to reset projects to 95% at reset (no crossing) yet
// still yields hoursTo100 = 6.7h — and a banner that says "5시간 한도 도달 예상" for a moment
// that arrives after the 5-hour window has already reset.
export function etaWithinWindow(hoursTo100, hoursToReset) {
  if (hoursTo100 == null || !Number.isFinite(hoursTo100) || hoursTo100 <= 0) return null;
  if (hoursToReset == null || !Number.isFinite(hoursToReset)) return null;
  return hoursTo100 <= hoursToReset ? hoursTo100 : null;
}

// Which window does the one-line status speak about? The worst tier wins; on a tie the window
// that gets there SOONER is the one worth naming. Both the popup banner and the dashboard banner
// answer this same question, so they answer it with the same code.
//
// `candidates`: [{ tier, eta }] — `eta` already passed through etaWithinWindow(). Extra fields
// are preserved on the returned object, so callers can hang their own labels/resets on it.
export function pickWorstWindow(candidates) {
  const usable = (candidates || []).filter((c) => c && c.tier);
  if (!usable.length) return null;
  return usable.slice().sort((a, b) =>
    tierSeverity(b.tier) - tierSeverity(a.tier)
    || ((a.eta == null ? Infinity : a.eta) - (b.eta == null ? Infinity : b.eta))
  )[0];
}

