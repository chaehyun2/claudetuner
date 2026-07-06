// Diurnal-aware 7d reset projection — shared pure helper.
//
// Single source of truth: docs/DESIGN-diurnal-7d-projection.md §3.
// Imported by ui/prediction.js (calcPredictedAtReset) and background.js
// (calcSidebarPrediction) so the extension keeps ONE copy of the weighting math.
//
// THIS FILE IS THE SINGLE SOURCE OF TRUTH. The dashboard cannot import an ES module
// at its call site (classic global scripts, separate CF Pages deploy), so it uses an
// AUTO-GENERATED classic-script twin at site/shared/diurnal.js — produced by
// `node scripts/sync-diurnal.mjs` and guarded by `scripts/check-diurnal-parity.mjs`
// (CI fails on drift). Edit the math HERE only, then re-run sync; never hand-edit the twin.
//
// Scope: the 7-day (7d) window only. The 5h window stays flat-linear (short horizon,
// same-day, diurnal weighting adds noise not signal).
//
// Idea: replace flat `predicted = currentUtil + rate * hoursToReset` (which assumes a
// busy-afternoon rate holds 24/7 through every remaining night) with an activity-mass
// projection that discounts idle/sleep hours. A flat weight curve reproduces the old
// formula exactly, so this is a strict generalization.

// 24-element UTC-hour weight curve, mean ~= 1. EMPIRICAL — volume-summed
// daily_usage.hourly_tokens across the userbase, normalized to mean 1 (Subtask B backtest,
// 6078 real 7-day trajectories, docs/VALIDATION-diurnal-7d-projection.md). Index = UTC hour
// 0..23. Shape reflects the Korea-dominant userbase: peak UTC00–08 (KST daytime), trough
// UTC17–21 (KST night). Synced to site/shared/diurnal.js via scripts/sync-diurnal.mjs.
export const DEFAULT_DIURNAL_WEIGHTS = [
  2.28, 2.69, 1.94, 1.27, 1.57, 1.78, // 00–05 UTC
  1.72, 1.69, 1.50, 1.19, 0.80, 0.77, // 06–11 UTC
  0.80, 0.77, 0.72, 0.60, 0.48, 0.31, // 12–17 UTC
  0.18, 0.13, 0.12, 0.13, 0.22, 0.35, // 18–23 UTC
];

// Never discount a remaining window below this fraction of its raw hours. Guards the
// "user legitimately on track to 100%" hazard (design §7 case 6) — the aggregate curve
// must not turn a real 100% into a comfortable sub-100%. Tunable from Subtask B backtest.
const REMAINING_MASS_FLOOR_FRAC = 0.6;

function _weights(weights) {
  // Fall back to the default on a wrong-length OR non-finite custom curve (a NaN/Infinity
  // weight would otherwise propagate through the mass integral).
  return (Array.isArray(weights) && weights.length === 24 && weights.every(Number.isFinite))
    ? weights : DEFAULT_DIURNAL_WEIGHTS;
}

// Resolve a weight curve into a pure (utcHour, utcDay) -> weight function. Supported forms:
//   - number[24]              : hour-of-day only (day-of-week ignored)  [LEGACY — byte-identical path]
//   - number[168]             : full weekly grid, index = utcDay*24 + utcHour
//   - { hourly:[24], dow:[7] }: multiplicative hour-of-day x day-of-week factor (the personal
//                               weekly curve — robust: a 24h base times a coarse DOW factor)
//   - anything else           : DEFAULT_DIURNAL_WEIGHTS (hour-of-day only)
// The number[24] and default branches ignore `dow`, so diurnalProject7d's numbers are unchanged
// (the parity guard depends on this).
function _curveFn(curve) {
  if (Array.isArray(curve) && curve.length === 24 && curve.every(Number.isFinite)) {
    return (h) => curve[h];
  }
  if (Array.isArray(curve) && curve.length === 168 && curve.every(Number.isFinite)) {
    return (h, dow) => curve[dow * 24 + h];
  }
  if (curve && Array.isArray(curve.hourly) && curve.hourly.length === 24 && curve.hourly.every(Number.isFinite)
      && Array.isArray(curve.dow) && curve.dow.length === 7 && curve.dow.every(Number.isFinite)) {
    return (h, dow) => curve.hourly[h] * curve.dow[dow];
  }
  return (h) => DEFAULT_DIURNAL_WEIGHTS[h];
}

// Integral of the weight curve over [startMs, endMs], in "effective active hours".
// Walks UTC-hour boundaries so each wall-clock hour contributes w(utcHour,utcDay)*fractionOfHour.
// A flat weights array returns exactly (endMs-startMs)/3600000.
export function diurnalActivityMass(startMs, endMs, weights) {
  const wf = _curveFn(weights);
  if (!(endMs > startMs)) return 0;
  let mass = 0;
  let t = startMs;
  while (t < endMs) {
    const d = new Date(t);
    const hour = d.getUTCHours();
    const dow = d.getUTCDay();
    const intoHourMs = d.getUTCMinutes() * 60000 + d.getUTCSeconds() * 1000 + d.getUTCMilliseconds();
    const nextBoundary = t - intoHourMs + 3600000;
    const segEnd = Math.min(nextBoundary, endMs);
    mass += wf(hour, dow) * (segEnd - t) / 3600000;
    t = segEnd;
  }
  return mass;
}

// Wall-clock hours from nowMs until `targetMass` effective-active-hours accrue.
// Returns null if the reset arrives first (limit not reached this window).
export function hoursForMass(nowMs, targetMass, resetMs, weights) {
  const wf = _curveFn(weights);
  let acc = 0;
  let t = nowMs;
  while (t < resetMs) {
    const d = new Date(t);
    const hour = d.getUTCHours();
    const dow = d.getUTCDay();
    const intoHourMs = d.getUTCMinutes() * 60000 + d.getUTCSeconds() * 1000 + d.getUTCMilliseconds();
    const nextBoundary = t - intoHourMs + 3600000;
    const segEnd = Math.min(nextBoundary, resetMs);
    const segHours = (segEnd - t) / 3600000;
    const segMass = wf(hour, dow) * segHours;
    if (segMass > 0 && acc + segMass >= targetMass) {
      const frac = (targetMass - acc) / segMass;
      return (t - nowMs) / 3600000 + segHours * frac;
    }
    acc += segMass;
    t = segEnd;
  }
  return null;
}

// Shared projection tail: given a measured level (wall-clock `rate` and per-active-mass
// `ratePerMass`) and the already-floored `remainingMass`, apply the discount-only clamp and
// derive the time-to-100. Extracted so diurnalProject7d (legacy 6h window) and
// diurnalProject7dAdaptive (EWMA-over-activity window) share ONE copy of the safety net.
//
// Discount-only clamp: the goal is one-sided — stop OVER-predicting. When the rate is
// sampled in a low-activity trough and projected across a peak, the mass model can AMPLIFY
// beyond old-linear; never let the diurnal endpoint exceed it. Validated (docs/VALIDATION-
// diurnal-7d-projection.md): without it the empirical curve makes over-prediction WORSE
// (-0.9% viewing-weighted, -51% for night-owls); with it every cohort strictly improves.
function _finishProjection({ currentUtil, rate, ratePerMass, remainingMass, hoursToReset, nowMs, resetMs, weights }) {
  const oldLinearPredicted = currentUtil + rate * hoursToReset;
  const predicted = Math.min(currentUtil + ratePerMass * remainingMass, oldLinearPredicted);

  let hoursTo100 = null;
  if (ratePerMass > 0 && currentUtil < 100) {
    const massTo100 = (100 - currentUtil) / ratePerMass;
    const diurnalHoursTo100 = hoursForMass(nowMs, massTo100, resetMs, weights);
    // Same one-sided rule on the time-to-limit that drives the "on track to hit limit"
    // banners: never sooner (more alarming) than old-linear.
    const flatHoursTo100 = (100 - currentUtil) / rate;
    if (diurnalHoursTo100 != null) {
      hoursTo100 = Math.max(diurnalHoursTo100, flatHoursTo100);
    } else if (predicted >= 100) {
      // predicted crossed 100 via the remaining-mass floor while the unfloored mass path did
      // not reach it before reset — keep the "100%+" badge and its ETA consistent (else the UI
      // shows 100%+ with no limit time). predicted >= 100 ⟹ oldLinear >= 100, so flatHoursTo100
      // is finite and <= hoursToReset.
      hoursTo100 = flatHoursTo100;
    }
  }
  return { predicted, hoursTo100 };
}

// Full diurnal-aware 7d projection. Pure. Returns null when inputs are insufficient.
//   t0Ms, nowMs : observation window the rate was measured over
//   totalDelta  : summed positive util increments over that window (same resets_at only)
//   currentUtil : latest utilization %
//   resetMs     : 7d reset time (epoch ms)
//   weights     : optional 24-element UTC curve; defaults to DEFAULT_DIURNAL_WEIGHTS
// Returns { predicted, rate, ratePerMass, observedMass, remainingMass, hoursToReset, hoursTo100 }.
// `rate` is the legacy %/hr (unchanged meaning) so the observed-rate tip stays truthful;
// only `predicted`/`hoursTo100` become diurnal-aware.
export function diurnalProject7d({ t0Ms, nowMs, totalDelta, currentUtil, resetMs, weights }) {
  if (currentUtil == null || resetMs == null || totalDelta == null) return null;
  // Reject non-finite inputs before the mass integrals: a NaN would propagate silently and
  // resetMs = Infinity would make the hour-boundary walk loop forever.
  if (![t0Ms, nowMs, totalDelta, currentUtil, resetMs].every(Number.isFinite)) return null;
  const hoursToReset = (resetMs - nowMs) / 3600000;
  if (hoursToReset < 0.05) return null;

  const observedHours = (nowMs - t0Ms) / 3600000;
  if (observedHours <= 0) return null;
  const rate = totalDelta / observedHours;

  let observedMass = diurnalActivityMass(t0Ms, nowMs, weights);
  // Guard: an observation window entirely inside a very-low-weight band could make
  // observedMass ~0 and explode ratePerMass. Floor it at 10% of the raw hours.
  observedMass = Math.max(observedMass, observedHours * 0.1);
  const ratePerMass = totalDelta / observedMass;

  let remainingMass = diurnalActivityMass(nowMs, resetMs, weights);
  // Never discount below the floor fraction of raw remaining hours (design §7 case 6).
  remainingMass = Math.max(remainingMass, hoursToReset * REMAINING_MASS_FLOOR_FRAC);

  const { predicted, hoursTo100 } = _finishProjection({
    currentUtil, rate, ratePerMass, remainingMass, hoursToReset, nowMs, resetMs, weights,
  });

  return { predicted, rate, ratePerMass, observedMass, remainingMass, hoursToReset, hoursTo100 };
}

// ===========================================================================================
// Adaptive rate estimator (docs/DESIGN-rate-estimator.md). Replaces the thin, noisy last-6h
// flat-window rate with an activity-normalized EWMA over a ~48h window, projected through a
// PERSONAL activity curve when the user has enough history (else the shipped global curve).
// The activity-mass model, discount-only clamp and remaining-mass floor above are unchanged —
// this only makes the RATE LEVEL longer + recency-weighted and the SHAPE personal.
// ===========================================================================================

// --- Tunable constants (Subtask A backtest hands final values in here) ---------------------
// Rate-level lookback: how far back the EWMA samples the burn rate. Long enough to average
// out integer-% quantization jitter, short enough to still react to a ramp.
export const RATE_WINDOW_HOURS = 48;
// EWMA recency half-life (wall-clock hours): a sample's weight halves every this-many hours.
// Damps quantization noise while keeping the estimate responsive. Seed range 12–24.
export const RATE_EWMA_HALFLIFE_HOURS = 18;
// Minimum distinct days of history before a PERSONAL activity curve is trusted; below this we
// fall back to the global DEFAULT_DIURNAL_WEIGHTS (shape needs weeks, not hours, to stabilize).
export const PERSONAL_CURVE_MIN_DAYS = 14;
// How far back personalActivityCurve reads when building the per-hour histogram.
export const PERSONAL_CURVE_LOOKBACK_DAYS = 28;
// Per-hour floor (fraction of the mean) applied to a personal curve so a single quiet hour in
// the sample never hard-zeros the mass integral (which would explode ratePerMass).
const PERSONAL_WEIGHT_FLOOR = 0.05;
// A full 7d cycle in hours — used only by the thin-data fallback (average over elapsed cycle).
const SEVEN_DAY_HOURS = 168;
// Minimum total measured activity (summed positive util %) before a personal curve is trusted.
const PERSONAL_CURVE_MIN_ACTIVITY = 5;

// --- Weekly (day-of-week) seasonality (leader requirement 2026-07-05) ----------------------
// The 7d remaining window crosses a weekend, so a Mon–Fri-heavy user viewed on Friday should
// discount the coming Sat/Sun. We layer a COARSE weekday/weekend day-type factor on top of the
// personal 24h curve (24h base x weekday/weekend factor) with SHRINKAGE toward the no-effect
// ratio 1 by the observed weekend-activity-DAY count — NOT 168 free per-DOW slots (weekend has
// only 2/7 the data; per-DOW was rejected as too sparse, docs/VALIDATION-rate-estimator.md §4/§5).
// A weekly layer needs a PERSONAL curve (a global 168h curve smears weekends across timezones);
// it is TZ-correct here because it is fit + projected on the SAME UTC clock. The shrinkage
// SUBSUMES any hard threshold: with K=6 the factor is ≈1 until several weekend-days accrue, so
// weektype is the default and the ONLY gate is the minDays=14 personal-curve gate (VALIDATION §5).
// This mirrors the validated backtest harness (scripts/backtest-rate-estimator.mjs makeWeightAt).
// Refs: MSTL / TBATS / double-seasonal Holt-Winters — we use the pragmatic shrunk multiplier.
export const WEEKEND_SHRINK_K = 6;            // weekend-day shrinkage constant: factor -> 1 until ~K weekend-days accrue
const WEEKEND_DOWS = [0, 6];                  // getUTCDay(): 0=Sun, 6=Sat
const WEEKDAY_DOWS = [1, 2, 3, 4, 5];

// Normalize + sort a raw sample array to the canonical shape the adaptive path consumes:
// ascending [{ tMs, util, resetMs }]. Drops points missing any field or non-finite.
function _cleanSamples(samples) {
  if (!Array.isArray(samples)) return [];
  const out = [];
  for (const s of samples) {
    if (!s) continue;
    const tMs = s.tMs, util = s.util, resetMs = s.resetMs;
    if (!Number.isFinite(tMs) || !Number.isFinite(util) || !Number.isFinite(resetMs)) continue;
    out.push({ tMs, util, resetMs });
  }
  out.sort((a, b) => a.tMs - b.tMs);
  return out;
}

// Distribute `amount` across 24 UTC-hour buckets proportional to the wall-clock time each hour
// occupies in [startMs, endMs]. Mirrors the hour-boundary walk in diurnalActivityMass so the
// personal histogram is built on the exact same time base as the mass integral.
function _spreadOverHours(buckets, startMs, endMs, amount) {
  if (!(endMs > startMs) || amount <= 0) return;
  const span = endMs - startMs;
  let t = startMs;
  while (t < endMs) {
    const d = new Date(t);
    const hour = d.getUTCHours();
    const intoHourMs = d.getUTCMinutes() * 60000 + d.getUTCSeconds() * 1000 + d.getUTCMilliseconds();
    const nextBoundary = t - intoHourMs + 3600000;
    const segEnd = Math.min(nextBoundary, endMs);
    buckets[hour] += amount * (segEnd - t) / span;
    t = segEnd;
  }
}

// Normalize a raw 24-hour histogram to a mean-1 curve with a per-hour floor (no hard zeros).
function _normalizeHourly(buckets) {
  const mean = buckets.reduce((a, b) => a + b, 0) / 24;
  if (!(mean > 0)) return null;
  let w = buckets.map((b) => Math.max(b / mean, PERSONAL_WEIGHT_FLOOR));
  const mean2 = w.reduce((a, b) => a + b, 0) / 24;
  w = w.map((x) => x / mean2);
  return w.every(Number.isFinite) ? w : null;
}

// Build a PERSONAL activity curve from the user's own history. Base is a 24-UTC-hour histogram
// of positive util increments (same construction as the global curve, but for one user). A coarse
// weekday/weekend FACTOR is layered on (24h base x day-type multiplier) with shrinkage toward the
// no-effect ratio 1 by observed weekend-day count, so a sparse weekend can't over-swing the
// projection (weektype; the shrinkage subsumes any hard weekend gate). Returns null when there is
// not enough history — the caller then uses the global DEFAULT_DIURNAL_WEIGHTS.
//   samples : [{ tMs, util, resetMs }] (any order; will be cleaned/sorted)
//   opts    : { nowMs, minDays, lookbackDays }
// Returns { weights, days, weekly, weeks } where weights is number[24] (hour-of-day only) or
// { hourly:number[24], dow:number[7] } (weekly), consumable by diurnalActivityMass via _curveFn.
export function personalActivityCurve(samples, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : null;
  const minDays = Number.isFinite(opts.minDays) ? opts.minDays : PERSONAL_CURVE_MIN_DAYS;
  const lookbackDays = Number.isFinite(opts.lookbackDays) ? opts.lookbackDays : PERSONAL_CURVE_LOOKBACK_DAYS;
  const pts = _cleanSamples(samples);
  if (pts.length < 2) return null;

  const startMs = nowMs != null ? nowMs - lookbackDays * 24 * 3600000 : -Infinity;
  const hourly = new Array(24).fill(0);
  const dowActivity = new Array(7).fill(0);
  const dowDays = Array.from({ length: 7 }, () => new Set());
  const daySet = new Set();
  let totalActivity = 0;

  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1], curr = pts[i];
    // Only same-cycle consecutive samples measure real burn; a reset boundary is not activity.
    if (prev.resetMs !== curr.resetMs) continue;
    // Clip the interval to the lookback window [startMs, nowMs]: an interval crossing the lookback
    // start must contribute only its in-window portion, and future/clock-skew samples (tMs > nowMs)
    // are excluded (upper bound). Consistent with activityNormalizedRate's window clip.
    const clipStart = Math.max(startMs, prev.tMs);
    const clipEnd = nowMs != null ? Math.min(nowMs, curr.tMs) : curr.tMs;
    if (!(clipEnd > clipStart)) continue;
    const rawDelta = curr.util - prev.util;
    if (!(rawDelta > 0)) continue;
    // Prorate the interval's util gain to the retained (clipped) span so a partially-in-window
    // interval doesn't dump its full delta into fewer hours.
    const fullSpan = curr.tMs - prev.tMs;
    const delta = fullSpan > 0 ? rawDelta * (clipEnd - clipStart) / fullSpan : rawDelta;
    _spreadOverHours(hourly, clipStart, clipEnd, delta);
    totalActivity += delta;
    // Count the calendar-UTC day of the (clipped) interval so "days of coverage" is real span.
    const dayIdx = Math.floor(clipStart / (24 * 3600000));
    daySet.add(dayIdx);
    const dow = new Date(clipStart).getUTCDay();
    dowActivity[dow] += delta;
    dowDays[dow].add(dayIdx);
  }

  const days = daySet.size;
  if (days < minDays || totalActivity < PERSONAL_CURVE_MIN_ACTIVITY) return null;

  const hourlyW = _normalizeHourly(hourly);
  if (!hourlyW) return null;

  // --- Weekly weekday/weekend factor (weektype, shrunk) — identical to the validated harness ---
  // Day-type intensity = (that type's summed activity / number of those days observed). The robust
  // day-type ratio = weekend avg daily activity / weekday avg daily activity (1.0 = no effect). It
  // is shrunk toward 1 by the observed weekend-DAY count (K=6): scarce weekend data -> factor ≈1, a
  // graceful degrade to the plain 24h curve. The shrunk ratio is then split into weekday/weekend
  // multipliers fWd/fWe that keep the 5-weekday + 2-weekend day-count-weighted mean at exactly 1.
  // Matches scripts/backtest-rate-estimator.mjs makeWeightAt('weektype'). No hard weekend gate.
  const weeks = days / 7;
  const weekendDays = WEEKEND_DOWS.reduce((a, d) => a + dowDays[d].size, 0);
  const weekdayDays = WEEKDAY_DOWS.reduce((a, d) => a + dowDays[d].size, 0);
  const weekendAct = WEEKEND_DOWS.reduce((a, d) => a + dowActivity[d], 0);
  const weekdayAct = WEEKDAY_DOWS.reduce((a, d) => a + dowActivity[d], 0);
  const weAvg = weekendDays > 0 ? weekendAct / weekendDays : 0;
  const wdAvg = weekdayDays > 0 ? weekdayAct / weekdayDays : 0;
  const weekendRatio = (wdAvg > 0 && weAvg > 0) ? weAvg / wdAvg : 1;
  const shrink = weekendDays / (weekendDays + WEEKEND_SHRINK_K);
  const ratio = 1 + shrink * (weekendRatio - 1);
  const fWd = 7 / (5 + 2 * ratio);
  const fWe = ratio * fWd;
  let dowFactor = null;
  if (Number.isFinite(fWd) && Number.isFinite(fWe) && fWd > 0 && fWe > 0) {
    const dw = new Array(7).fill(fWd);
    for (const d of WEEKEND_DOWS) dw[d] = fWe;
    dowFactor = dw; // day-count-weighted mean is exactly 1 by construction — no renormalization
  }

  if (dowFactor) {
    return { weights: { hourly: hourlyW, dow: dowFactor }, days, weekly: true, weeks };
  }
  return { weights: hourlyW, days, weekly: false, weeks };
}

// Activity-normalized EWMA burn rate over the recent RATE_WINDOW_HOURS. Instead of a single
// flat 6h slope, this is a recency-weighted ratio-of-sums: each same-cycle interval contributes
// its positive util delta and its active-mass, both scaled by an EWMA recency weight keyed on
// the interval's end time. Weighting by mass (not count) keeps a tiny noisy interval from
// dominating; the EWMA reacts to ramps while damping integer-% quantization jitter.
//   samples : [{ tMs, util, resetMs }]
//   opts    : { nowMs, weights, windowH, halfLifeH }
// Returns { ratePerMass, rate, observedMass, observedHours, t0Ms, nIntervals } or null.
export function activityNormalizedRate(samples, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : null;
  if (nowMs == null) return null;
  const weights = opts.weights;
  const windowH = Number.isFinite(opts.windowH) ? opts.windowH : RATE_WINDOW_HOURS;
  const halfLifeH = Number.isFinite(opts.halfLifeH) && opts.halfLifeH > 0 ? opts.halfLifeH : RATE_EWMA_HALFLIFE_HOURS;
  const pts = _cleanSamples(samples);
  if (pts.length < 2) return null;

  const startMs = nowMs - windowH * 3600000;
  const halfLifeMs = halfLifeH * 3600000;
  let sumAlphaDelta = 0, sumAlphaMass = 0, sumAlphaHours = 0;
  let t0Ms = null, nIntervals = 0;

  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1], curr = pts[i];
    if (curr.tMs <= startMs) continue;          // interval ends before the window
    if (curr.tMs > nowMs) continue;             // future sample (clock skew) — ignore
    if (prev.resetMs !== curr.resetMs) continue; // don't measure across a reset boundary
    // Clip the interval to the window [startMs, nowMs] so the effective observed span can never
    // exceed windowH (auto-cap to min(windowH, hoursSinceCycleStart)). A single sparse interval
    // that starts before startMs (e.g. samples at now-96h and now) must contribute only its last
    // windowH hours, not its full 96h span.
    const clipStart = Math.max(startMs, prev.tMs);
    const clipEnd = Math.min(nowMs, curr.tMs);
    const hours = (clipEnd - clipStart) / 3600000;
    if (!(hours > 0)) continue;
    const fullSpan = curr.tMs - prev.tMs;
    const fullMass = diurnalActivityMass(prev.tMs, curr.tMs, weights);
    const mass = diurnalActivityMass(clipStart, clipEnd, weights);
    const rawDelta = Math.max(0, curr.util - prev.util);
    // Prorate the interval's util gain to the retained (clipped) portion by activity mass so the
    // per-activity burn rate is invariant to clipping (time-fraction fallback when mass ~0).
    const frac = fullMass > 0 ? mass / fullMass : (fullSpan > 0 ? (clipEnd - clipStart) / fullSpan : 0);
    const delta = rawDelta * frac;
    // EWMA recency weight, keyed on the interval END time (its "age" now).
    const alpha = Math.pow(0.5, (nowMs - curr.tMs) / halfLifeMs);
    sumAlphaDelta += alpha * delta;
    sumAlphaMass += alpha * mass;
    sumAlphaHours += alpha * hours;
    if (t0Ms == null) t0Ms = clipStart;         // clipped start -> hoursDiff <= windowH
    nIntervals++;
  }

  if (nIntervals === 0 || !(sumAlphaHours > 0)) return null;
  // Same explosion guard as diurnalProject7d: floor the (recency-weighted) mass at 10% of the
  // (recency-weighted) hours so a window sitting in a low-weight trough can't blow up the rate.
  const observedMass = Math.max(sumAlphaMass, sumAlphaHours * 0.1);
  const ratePerMass = sumAlphaDelta / observedMass;
  const rate = sumAlphaDelta / sumAlphaHours;
  return { ratePerMass, rate, observedMass, observedHours: sumAlphaHours, t0Ms, nIntervals };
}

// Adaptive 7d projection: the drop-in successor to diurnalProject7d for the call sites that can
// pass their full local history. Picks a personal or global activity curve, estimates the rate
// with an activity-normalized EWMA over ~48h, then reuses the SAME activity-mass projection +
// discount-only clamp + remaining-mass floor. Falls back to a full-cycle average when the
// recent window is too thin (mirrors the legacy fallback, but on the chosen curve).
//   samples     : [{ tMs, util, resetMs }] full available history for this org/provider
//   currentUtil : latest utilization %
//   resetMs     : 7d reset time (epoch ms)
//   nowMs       : current time (epoch ms)
//   weights     : optional override for the GLOBAL fallback curve (defaults to DEFAULT_DIURNAL_WEIGHTS)
//   halfLifeH/windowH/minDays/curveLookbackDays : optional constant overrides (else the module constants)
// Returns the same shape as diurnalProject7d, plus { hoursDiff, usedPersonalCurve, curveDays,
// weekly }. `hoursDiff` is the effective observed-window span in hours the rate was measured over
// (nowMs - clipped t0Ms, <= windowH); prediction.js/background.js read it for the observed-rate tip.
export function diurnalProject7dAdaptive({
  samples, currentUtil, resetMs, nowMs, weights,
  halfLifeH, windowH, minDays, curveLookbackDays,
}) {
  if (currentUtil == null || resetMs == null || nowMs == null) return null;
  if (![currentUtil, resetMs, nowMs].every(Number.isFinite)) return null;
  const hoursToReset = (resetMs - nowMs) / 3600000;
  if (hoursToReset < 0.05) return null;

  // Shape: personal curve when we have the history for it, else the global default.
  const personal = personalActivityCurve(samples, { nowMs, minDays, lookbackDays: curveLookbackDays });
  const usedPersonalCurve = personal != null;
  const projWeights = usedPersonalCurve ? personal.weights : _weights(weights);
  const curveDays = usedPersonalCurve ? personal.days : 0;
  const weekly = usedPersonalCurve ? !!personal.weekly : false;

  // Level: activity-normalized EWMA over the recent window on the chosen curve.
  let rate, ratePerMass, observedMass, hoursDiff;
  const est = activityNormalizedRate(samples, { nowMs, weights: projWeights, windowH, halfLifeH });
  if (est) {
    rate = est.rate;
    ratePerMass = est.ratePerMass;
    observedMass = est.observedMass;
    hoursDiff = (nowMs - est.t0Ms) / 3600000; // wall-clock span the rate was measured over
  } else {
    // Thin-data fallback: no usable recent intervals. Treat currentUtil as accrued over the
    // elapsed portion of the cycle and average it through the chosen curve (legacy behavior).
    const elapsed = SEVEN_DAY_HOURS - hoursToReset;
    if (elapsed < 1) return null;
    const t0Ms = nowMs - elapsed * 3600000;
    rate = currentUtil / elapsed;
    observedMass = Math.max(diurnalActivityMass(t0Ms, nowMs, projWeights), elapsed * 0.1);
    ratePerMass = currentUtil / observedMass;
    hoursDiff = elapsed;
  }

  let remainingMass = diurnalActivityMass(nowMs, resetMs, projWeights);
  remainingMass = Math.max(remainingMass, hoursToReset * REMAINING_MASS_FLOOR_FRAC);

  const { predicted, hoursTo100 } = _finishProjection({
    currentUtil, rate, ratePerMass, remainingMass, hoursToReset, nowMs, resetMs, weights: projWeights,
  });

  return {
    predicted, rate, ratePerMass, observedMass, remainingMass, hoursToReset, hoursDiff, hoursTo100,
    usedPersonalCurve, curveDays, weekly,
  };
}
