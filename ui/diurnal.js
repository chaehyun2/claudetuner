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

// ===========================================================================================
// pace-how 7d projection (#1681) — the 7d forecast on every surface (popup, sidebar, dashboard,
// mobile widget). Replaces diurnalProject7dAdaptive, which was tuned on synthetic truth ("every
// trajectory ends at exactly 100%") and, against REAL reset-time utilization, carried the last one
// or two days' pace across the whole week: front-loaded users over-predicted, back-loaded users
// under-predicted, false limit alarms early in the week (scripts/pred7d/ANALYSIS.md, RESEARCH.md).
//
// Model: the increment still to come is a per-horizon median regression on
//   [cycle-to-date pace, recent 24h rate, gap to the last prior-cycle finals, has-prior, 1]
// with pace and rate measured per unit of a global UTC hour-of-week activity curve and projected
// over the activity mass left until reset, then saturated onto the remaining headroom. A second
// (tau=0.65) table decides "likely to hit the limit" (`willHit`).
//
// The core between the markers is a MECHANICAL port of the validated candidate — keep it byte-for-
// byte in step with scripts/pred7d/candidates/pace-how.mjs (fixture parity:
// test/pred7d-pace-how-guard.mjs). Every top-level name is `p7`/`P7_`-prefixed: the dashboard loads
// the generated classic twin as page globals, where a clash with another script's name breaks the
// page. No imports: sync-diurnal.mjs drops import lines.
// ===========================================================================================

// === P7 CORE BEGIN — mechanical port of scripts/pred7d/candidates/pace-how.mjs (#1681) ===
const P7_HOUR_MS = 3600000;
const P7_DAY_MS = 24 * P7_HOUR_MS;
const P7_DEFAULT_CYCLE_H = 168;          // Claude 7d; callers pass opts.cycleHours (window span) otherwise
const P7_SAME_CYCLE_TOL_MS = 6 * P7_HOUR_MS;
const P7_RECENT_H = 24;
const P7_PRIOR_K = 2;
const P7_PRIOR_END_GAP_H = 36;           // a sample-derived prior cycle must be seen this close to its reset
const P7_SUMMARY_SPAN_D = [5, 9];        // daily_usage segments of about one cycle
const P7_PRIOR_MIN_SPAN_FRAC = 5 / 7;    // sample-derived prior cycle span bounds, as fractions of the window
const P7_PRIOR_MAX_SPAN_FRAC = 9 / 7;
const P7_MASS_FLOOR_FRAC = 0.1;          // mass floor (fraction of wall hours) against trough blow-ups
const P7_MIN_OBS_MASS = 6;               // absolute floor (~6 average hours) so minutes-old windows cannot explode a rate
export const P7_SNAP_AT = 97;            // projections this close to the cap report 100
const P7_IDLE_MIN_SPAN_H = 72;           // idle guard: min observed history span

// Global activity weight per UTC hour-of-week (index = getUTCDay()*24 + getUTCHours(), mean 1),
// from ALL keys' short (<=12h) positive increments, 2026-09-10..09-22 (Chuseok excluded).
export const P7_HOW = [
  0.31, 0.3, 0.37, 0.37, 0.47, 0.52, 0.54, 0.53, 0.49, 0.49, 0.44, 0.5, 0.56, 0.58, 0.53, 0.42, 0.32, 0.24, 0.21, 0.18, 0.14, 0.19, 0.37, 1,
  1.99, 2.78, 2.61, 1.94, 2.42, 2.89, 2.93, 3.04, 2.65, 2.01, 1.41, 1.21, 1.07, 0.98, 0.83, 0.62, 0.47, 0.37, 0.28, 0.26, 0.27, 0.33, 0.49, 1.18,
  2.24, 3.07, 2.81, 2.05, 2.55, 3.07, 3.12, 3.14, 2.8, 2.04, 1.37, 1.16, 1.02, 0.96, 0.75, 0.31, 0.24, 0.16, 0.14, 0.11, 0.1, 0.15, 0.24, 0.58,
  1.06, 1.45, 1.35, 0.98, 1.25, 1.55, 1.57, 1.5, 1.37, 1, 0.7, 0.63, 0.55, 0.44, 0.4, 0.34, 0.25, 0.19, 0.14, 0.12, 0.11, 0.13, 0.23, 0.59,
  1.86, 2.68, 2.52, 1.86, 2.29, 2.82, 2.98, 2.86, 2.48, 1.82, 1.19, 1.07, 0.97, 0.84, 0.73, 0.61, 0.47, 0.34, 0.27, 0.21, 0.24, 0.3, 0.48, 1.11,
  2.01, 2.7, 2.37, 1.81, 2.12, 2.69, 2.67, 2.54, 2.06, 1.44, 0.91, 0.75, 0.68, 0.71, 0.63, 0.56, 0.46, 0.31, 0.25, 0.21, 0.2, 0.23, 0.22, 0.3,
  0.4, 0.46, 0.47, 0.42, 0.45, 0.47, 0.5, 0.5, 0.45, 0.42, 0.41, 0.42, 0.51, 0.52, 0.46, 0.43, 0.36, 0.23, 0.18, 0.16, 0.14, 0.17, 0.21, 0.28,
];

// [hoursToReset, a(paceMass), b(recentMass), c(priorGap), d(hasPrior), e(intercept)]
// Median (tau=0.5): the number shown.
export const P7_COEF = [
  [6, 0.269, 0.5, 0.00404, -0.0306, -0.0707],
  [12, 0.342, 0.458, 0.00853, -0.0796, -0.117],
  [24, 0.512, 0.388, 0.0312, -0.215, -0.1],
  [48, 0.796, 0.207, 0.0967, -0.597, -0.0133],
  [72, 0.895, 0.0997, 0.219, -1.67, 0.299],
  [96, 0.912, 0.0344, 0.314, -3.51, 1.7],
  [120, 0.822, -0.026, 0.424, -7.25, 5.96],
  [144, 0.234, 0.234, 0.631, -17.8, 18.3],
  [152, 0.162, 0.162, 0.732, -22.2, 23.7],
  [160, 0.0959, 0.0959, 0.848, -29.1, 31.1],
  [166, 0.0664, 0.0664, 0.917, -33.6, 36.0],
];
// Warning tier (tau=0.65): "likely to hit the limit" when this quantile reaches the cap.
export const P7_COEF_WARN = [
  [6, 0.433, 0.731, 0.00757, -0.0499, -0.027],
  [12, 0.541, 0.621, 0.0191, -0.128, -0.04],
  [24, 0.727, 0.472, 0.0667, -0.34, 0.0822],
  [48, 0.968, 0.243, 0.162, -0.793, 0.37],
  [72, 1.05, 0.107, 0.306, -2.75, 1.84],
  [96, 0.992, 0.0374, 0.404, -6.06, 5.41],
  [120, 0.823, 0.000312, 0.554, -12.7, 12.9],
  [144, 0.232, 0.232, 0.709, -24.6, 29.2],
  [152, 0.154, 0.154, 0.791, -30.7, 37.4],
  [160, 0.0963, 0.0963, 0.895, -39.1, 46.3],
  [166, 0.0882, 0.0882, 0.92, -39.0, 47.4],
];
// Flat-curve tables for non-KST timezones (fitted on keys whose activity timing is not
// KST-like; used when opts.tzOffsetMin is known and != +540).
export const P7_COEF_FLAT = [
  [6, 0.159, 0.542, 0.0074, -0.05, 0.0193],
  [12, 0.194, 0.553, 0.0217, -0.128, -0.0242],
  [24, 0.319, 0.582, 0.0883, -0.333, 0.0853],
  [48, 0.614, 0.39, 0.134, -0.615, 0.14],
  [72, 0.766, 0.235, 0.259, -2.01, 0.83],
  [96, 0.852, 0.112, 0.328, -4.07, 2.67],
  [120, 0.63, 0.229, 0.412, -7.59, 6.13],
  [144, 0.216, 0.216, 0.703, -21.2, 22.0],
  [152, 0.124, 0.124, 0.82, -22.1, 23.7],
  [160, 0.0535, 0.0535, 0.916, -37.9, 40.5],
  [166, 0.024, 0.024, 0.959, -41.1, 44.5],
];
export const P7_COEF_FLAT_WARN = [
  [6, 0.332, 0.899, 0.0258, -0.113, 0.0734],
  [12, 0.532, 0.725, 0.0678, -0.245, 0.0341],
  [24, 0.485, 0.746, 0.148, -0.494, 0.32],
  [48, 0.787, 0.394, 0.282, -1.31, 0.946],
  [72, 0.873, 0.275, 0.336, -3.86, 3.32],
  [96, 0.912, 0.106, 0.45, -7.84, 7.61],
  [120, 0.641, 0.188, 0.57, -14.3, 15.1],
  [144, 0.219, 0.219, 0.747, -28.4, 32.9],
  [152, 0.138, 0.138, 0.818, -33.0, 41.1],
  [160, 0.0647, 0.0647, 0.896, -36.4, 46.1],
  [166, 0.0625, 0.0625, 0.917, -37.9, 48.9],
];

// Activity mass over [aMs, bMs): hour-of-week weighted, or plain hours when flat.
function p7Mass(aMs, bMs, flat) {
  if (flat) return Math.max(0, bMs - aMs) / P7_HOUR_MS;
  let m = 0;
  for (let t = aMs; t < bMs;) {
    const next = Math.min(bMs, (Math.floor(t / P7_HOUR_MS) + 1) * P7_HOUR_MS);
    const d = new Date(t);
    m += P7_HOW[d.getUTCDay() * 24 + d.getUTCHours()] * (next - t) / P7_HOUR_MS;
    t = next;
  }
  return m;
}

function p7Median(xs) {
  const a = xs.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Group sorted samples into cycles keyed by resetMs (cycleResetMs when provided), jitter-tolerant.
function p7Cycles(samples, nowMs) {
  const pts = [];
  for (const s of samples || []) {
    if (!s || !(s.tMs <= nowMs) || !Number.isFinite(s.util)) continue;
    const r = Number.isFinite(s.cycleResetMs) ? s.cycleResetMs : s.resetMs;
    if (Number.isFinite(r)) pts.push({ tMs: s.tMs, util: s.util, r });
  }
  pts.sort((a, b) => a.tMs - b.tMs);
  const cycles = [];
  for (const p of pts) {
    const c = cycles[cycles.length - 1];
    if (!c || Math.abs(p.r - c.resetMs) >= P7_SAME_CYCLE_TOL_MS) cycles.push({ resetMs: p.r, pts: [p] });
    else c.pts.push(p);
  }
  return cycles;
}

// Linear interpolation of a cycle's util at tMs (null before its first sample).
function p7UtilAt(pts, tMs) {
  if (tMs < pts[0].tMs) return null;
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i].tMs <= tMs) {
      const a = pts[i], b = pts[i + 1];
      if (!b) return a.util;
      return a.util + (b.util - a.util) * (tMs - a.tMs) / (b.tMs - a.tMs);
    }
  }
  return null;
}

// Newest-last finals of completed prior cycles: explicit summary rows (daily_usage) merged with
// cycles observed in the samples near their reset. A sample-derived cycle counts only once its reset
// has passed (<= nowMs): a reset that moved later without a util drop leaves an older cycle id whose
// reset is still in the future, and its "final" would be a partial value of the running cycle.
function p7PriorFinals(cycles, current, priorCycles, resetMs, nowMs, cycleH) {
  const out = [];
  if (Array.isArray(priorCycles)) {
    for (const c of priorCycles) {
      if (!c) continue;
      let end = Number(c.resetMs);
      if (!Number.isFinite(end) && c.endDate) end = Date.parse(c.endDate);
      if (Number.isFinite(end) && end > resetMs - P7_SAME_CYCLE_TOL_MS) continue;
      if (c.startDate && c.endDate) {
        const spanD = (Date.parse(c.endDate) - Date.parse(c.startDate)) / P7_DAY_MS;
        if (!(spanD >= P7_SUMMARY_SPAN_D[0] && spanD <= P7_SUMMARY_SPAN_D[1])) continue;
      }
      const f = Number(c.finalUtil ?? c.peakUtil);
      if (Number.isFinite(f)) out.push({ end: Number.isFinite(end) ? end : 0, f });
    }
  }
  for (let i = 0; i < cycles.length; i++) {
    const c = cycles[i];
    if (c === current || c.resetMs > nowMs || c.resetMs > resetMs - P7_SAME_CYCLE_TOL_MS || c.pts.length < 2) continue;
    const last = c.pts[c.pts.length - 1];
    if ((c.resetMs - last.tMs) / P7_HOUR_MS > P7_PRIOR_END_GAP_H) continue;
    // A cycle cut short by a moved reset (previous reset < ~5/7 window earlier) has a partial final.
    // (Util is cumulative from the true cycle start, so late observation start is fine.)
    if (i > 0) {
      const spanH = (c.resetMs - cycles[i - 1].resetMs) / P7_HOUR_MS;
      if (spanH < cycleH * P7_PRIOR_MIN_SPAN_FRAC || spanH > cycleH * P7_PRIOR_MAX_SPAN_FRAC) continue;
    }
    if (out.some((o) => Math.abs(o.end - c.resetMs) < 1.5 * P7_DAY_MS)) continue;
    out.push({ end: c.resetMs, f: last.util });
  }
  out.sort((a, b) => a.end - b.end);
  return out.map((o) => o.f);
}

function p7Sat(x, cap) { return cap > 0 ? cap * (1 - Math.exp(-Math.max(0, x) / cap)) : 0; }

// Feature vector [paceMass, recentMass, priorGap, hasPrior, 1] and context.
// The hour-of-week curve is KST-shaped: use it for UTC+9 or unknown timezone (~85% of users are
// KST), a flat curve (with its own coefficient table) for any other known offset.
export const P7_KST_OFFSET_MIN = 540;
export function p7UsesFlat(opts) {
  return Number.isFinite(opts.tzOffsetMin) && opts.tzOffsetMin !== P7_KST_OFFSET_MIN;
}

export function p7Features({ samples, nowMs, resetMs, currentUtil, priorCycles }, opts = {}) {
  const flat = opts.flat ?? p7UsesFlat(opts);
  if (![nowMs, resetMs, currentUtil].every(Number.isFinite)) return null;
  const rem = (resetMs - nowMs) / P7_HOUR_MS;
  if (!(rem > 0)) return null;
  const cur = Math.max(0, Math.min(100, currentUtil));
  const cap = 100 - cur;
  const cycles = p7Cycles(samples, nowMs);
  const current = cycles.find((c) => Math.abs(c.resetMs - resetMs) < P7_SAME_CYCLE_TOL_MS) || null;
  // Window span comes from the caller (seven_day_window_seconds etc.). Not inferred from reset
  // spacing: resets move (e.g. 09-04T21 -> 09-05T05), which made inferred spans wrong.
  const cycleH = Math.max(Number.isFinite(opts.cycleHours) && opts.cycleHours > 0 ? opts.cycleHours : P7_DEFAULT_CYCLE_H, rem);
  const startMs = resetMs - cycleH * P7_HOUR_MS;
  const elapsedH = (nowMs - startMs) / P7_HOUR_MS;
  const massRem = p7Mass(nowMs, resetMs, flat);
  const massEl = Math.max(p7Mass(startMs, nowMs, flat), P7_MASS_FLOOR_FRAC * elapsedH, P7_MIN_OBS_MASS);
  const pace = elapsedH >= 1 ? (cur / massEl) * massRem : 0;
  let recent = pace;
  // Observed wall-clock burn rate (%/h) and the span it was measured over, for the UI tip; falls back
  // to the cycle-to-date average when there is no usable recent window.
  let rate = elapsedH >= 1 ? cur / elapsedH : 0;
  let rateSpanH = Math.max(0, elapsedH);
  let ratePerMass = elapsedH >= 1 ? cur / massEl : 0;
  if (current) {
    const t0 = Math.max(nowMs - P7_RECENT_H * P7_HOUR_MS, startMs);
    let u0 = p7UtilAt(current.pts, t0);
    if (u0 == null && t0 === startMs) u0 = 0;
    const u1 = p7UtilAt(current.pts, nowMs);
    const spanH = (nowMs - t0) / P7_HOUR_MS;
    if (u0 != null && u1 != null && spanH > 0) {
      const m = Math.max(p7Mass(t0, nowMs, flat), P7_MASS_FLOOR_FRAC * spanH, P7_MIN_OBS_MASS);
      recent = (Math.max(0, u1 - u0) / m) * massRem;
      rate = Math.max(0, u1 - u0) / spanH;
      ratePerMass = Math.max(0, u1 - u0) / m;
      rateSpanH = spanH;
    }
  }
  const k = Number.isFinite(opts.maxPrior) ? opts.maxPrior : P7_PRIOR_K;
  const finals = k > 0 ? p7PriorFinals(cycles, current, priorCycles, resetMs, nowMs, cycleH).slice(-k) : [];
  const pf = finals.length ? p7Median(finals) : null;
  const gap = pf != null ? Math.min(cap, Math.max(0, pf - cur)) : 0;
  return {
    cur, hoursToReset: rem, nowMs, resetMs, flat, massRem, rate, rateSpanH, ratePerMass, cycles,
    x: [p7Sat(pace, cap), p7Sat(recent, cap), gap, pf != null ? 1 : 0, 1],
  };
}

function p7CoefAt(h, K) {
  if (h <= K[0][0]) return K[0];
  for (let i = 1; i < K.length; i++) {
    if (h <= K[i][0]) {
      const f = (h - K[i - 1][0]) / (K[i][0] - K[i - 1][0]);
      return K[i].map((v, j) => K[i - 1][j] + f * (v - K[i - 1][j]));
    }
  }
  return K[K.length - 1];
}

// Projected increment by reset (unclamped) under coefficient table K.
function p7Increment(f, K) {
  const w = p7CoefAt(f.hoursToReset, K);
  let inc = 0;
  for (let j = 0; j < f.x.length; j++) inc += w[j + 1] * f.x[j];
  return inc;
}

// Hours from now until the cap at the observed per-activity rate (the "at this pace" ETA the UI shows),
// walking the activity curve; capped at hoursToReset (the model says the cap is reached by reset even
// when the raw pace alone would not get there).
function p7HoursTo100(f) {
  const cap = 100 - f.cur;
  if (cap <= 0) return 0;
  if (!(f.ratePerMass > 0)) return f.hoursToReset;
  const target = cap / f.ratePerMass;
  let m = 0;
  for (let t = f.nowMs; t < f.resetMs;) {
    const next = Math.min(f.resetMs, (Math.floor(t / P7_HOUR_MS) + 1) * P7_HOUR_MS);
    const dm = p7Mass(t, next, f.flat);
    if (m + dm >= target) {
      const frac = dm > 0 ? (target - m) / dm : 0;
      return (t + frac * (next - t) - f.nowMs) / P7_HOUR_MS;
    }
    m += dm;
    t = next;
  }
  return f.hoursToReset;
}

// Idle guard: a history spanning >= P7_IDLE_MIN_SPAN_H with no same-cycle increase at all means
// the user is not using the product; the population prior would only add phantom usage.
// `cycles` = p7Cycles output (sorted, <= now, grouped by cycle).
function p7IsIdle(cycles, nowMs) {
  if (!cycles.length) return false;
  const first = cycles[0].pts[0];
  if ((nowMs - first.tMs) / P7_HOUR_MS < P7_IDLE_MIN_SPAN_H) return false;
  let n = 0;
  for (const c of cycles) {
    n += c.pts.length;
    for (let i = 1; i < c.pts.length; i++) if (c.pts[i].util > c.pts[i - 1].util) return false;
  }
  return n >= 2;
}

// Result (superset of what calcPredictedAtReset returns today):
//   predicted   median projection at reset (the number shown; >= P7_SNAP_AT reports 100)
//   willHit     warning tier: the tau=0.65 projection reaches the cap ("likely to hit the limit")
//   hoursTo100  when predicted >= 100 or willHit: hours until the cap at the observed per-activity
//               rate (<= hoursToReset); otherwise null
//   rate        observed %/h over the last <=24h (cycle-to-date average when unavailable)
//   hoursDiff   span (h) that `rate` was measured over;  hoursToReset
// input: { samples:[{tMs,util,resetMs,cycleResetMs?}] sorted asc, nowMs, resetMs, currentUtil,
//          priorCycles? }   opts: { tzOffsetMin?, cycleHours? (window span), maxPrior? }
export function p7Predict(input, opts = {}) {
  const flat = opts.flat ?? p7UsesFlat(opts);
  const f = p7Features(input, { ...opts, flat });
  if (!f) return null;
  const base = { rate: f.rate, hoursDiff: f.rateSpanH, hoursToReset: f.hoursToReset };
  if (p7IsIdle(f.cycles, f.nowMs)) {
    return { predicted: f.cur, willHit: false, hoursTo100: f.cur >= 100 ? 0 : null, ...base };
  }
  const inc = p7Increment(f, flat ? P7_COEF_FLAT : P7_COEF);
  const incWarn = p7Increment(f, flat ? P7_COEF_FLAT_WARN : P7_COEF_WARN);
  const p = Math.min(100, Math.max(f.cur, f.cur + inc));
  const pWarn = Math.min(100, Math.max(f.cur, f.cur + incWarn));
  const predicted = p >= P7_SNAP_AT ? 100 : p;
  const willHit = pWarn >= P7_SNAP_AT;
  const hoursTo100 = predicted >= 100 || willHit ? p7HoursTo100(f) : null;
  return { predicted, willHit, hoursTo100, ...base };
}
// === P7 CORE END ===

// Without `willHit` the tier-facing number stays below the cap: the tier ladder
// (ui/usage-tiers.js) reads >= 100 as "will hit the limit", and that verdict belongs to the
// tau=0.65 table, not to the median.
const P7_NO_HIT_MAX = 99;
const P7_UTIL_CAP = 100;
// daily_usage reset detection (same rule as scripts/pred7d/build-dataset.mjs dailySegments):
// a drop of at least P7_DAILY_DROP_ABS points AND to at most P7_DAILY_DROP_REL of the previous value.
const P7_DAILY_DROP_ABS = 3;
const P7_DAILY_DROP_REL = 0.5;

// SCOPE GATE. pace-how is fitted on Claude's 7-day window only. ChatGPT (whose "7d" slot is a
// 30-day window on Free/Go, #954) and Gemini keep diurnalProject7dAdaptive unchanged until they
// have their own fit. The span check also keeps a Claude slot that ever reports a non-weekly span
// off a model fitted on weekly cycles. An UNKNOWN provider is not Claude: every caller names it.
const P7_PROVIDER = 'claude';
const P7_SPAN_MIN_H = 160;
const P7_SPAN_MAX_H = 176;
export function p7Applies(provider, windowSeconds) {
  if (provider !== P7_PROVIDER) return false;
  if (windowSeconds == null) return true;              // Claude does not report a span: 7 days
  const h = Number(windowSeconds) / 3600;
  return Number.isFinite(h) && h >= P7_SPAN_MIN_H && h <= P7_SPAN_MAX_H;
}

function p7CycleHours(windowSeconds) {
  return Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds / 3600 : P7_DEFAULT_CYCLE_H;
}

// The runtime entry point. Pure; returns null when inputs are insufficient.
//   samples       : [{ tMs, util, resetMs }] this org's history, ascending (more = more prior cycles)
//   currentUtil   : latest utilization %
//   resetMs       : window reset time (epoch ms)
//   nowMs         : current time (epoch ms) — passed in, never read from the clock here
//   windowSeconds : provider-reported window span (default 7 days; ChatGPT Free/Go is 30 days)
//   tzOffsetMin   : the viewer's UTC offset in minutes (+540 = KST); unknown -> the KST curve
//   priorCycles   : optional summary rows from p7PriorCyclesFromDaily (merged with sample-derived)
// Returns { predicted, predictedMedian, willHit, rate, hoursDiff, hoursToReset, hoursTo100 }:
//   predictedMedian : the median projection (the model's number, <= 100)
//   predicted       : what the tier ladder reads — exactly 100 when willHit, else the median held
//                     below the cap — so projectionTier / isAtRiskOfCap / crossesCap everywhere take
//                     the limit verdict from willHit without each caller re-deriving it
//   rate, hoursDiff : observed %/h and the span it was measured over (tooltip). When nothing was
//                     observed but growth is still projected, the implied forward rate, so
//                     `rate > 0` holds exactly when the projection rises (the verdict predicates
//                     gate on it)
//   hoursTo100      : when willHit, hours until the cap (<= hoursToReset); else null
export function p7ProjectAtReset({ samples, currentUtil, resetMs, nowMs, windowSeconds, tzOffsetMin, priorCycles }) {
  if (![currentUtil, resetMs, nowMs].every(Number.isFinite)) return null;
  const hoursToReset = (resetMs - nowMs) / 3600000;
  if (hoursToReset < 0.05) return null;
  const sorted = Array.isArray(samples) ? samples.slice().sort((a, b) => a.tMs - b.tMs) : [];
  const r = p7Predict(
    { samples: sorted, nowMs, resetMs, currentUtil, priorCycles },
    { tzOffsetMin, cycleHours: p7CycleHours(windowSeconds) },
  );
  if (!r) return null;
  const cur = Math.max(0, Math.min(P7_UTIL_CAP, currentUtil));
  const willHit = !!r.willHit && cur < P7_UTIL_CAP;
  const predicted = willHit ? P7_UTIL_CAP : Math.min(r.predicted, Math.max(cur, P7_NO_HIT_MAX));
  let rate = r.rate;
  let hoursDiff = r.hoursDiff;
  if (!(rate > 0) && predicted > cur) {
    rate = (predicted - cur) / hoursToReset;
    hoursDiff = hoursToReset;
  }
  const hoursTo100 = willHit && r.hoursTo100 != null ? Math.min(r.hoursTo100, hoursToReset) : null;
  return { predicted, predictedMedian: r.predicted, willHit, rate, hoursDiff, hoursToReset, hoursTo100 };
}

// Sample-derived prior cycles (completed, seen near their reset), oldest first, as finals.
// Exposed for tests; the projection derives these itself from `samples`.
export function p7PriorFinalsFromSamples(samples, resetMs, nowMs, windowSeconds) {
  if (![resetMs, nowMs].every(Number.isFinite)) return [];
  const cycles = p7Cycles(samples, nowMs);
  const current = cycles.find((c) => Math.abs(c.resetMs - resetMs) < P7_SAME_CYCLE_TOL_MS) || null;
  return p7PriorFinals(cycles, current, null, resetMs, nowMs, p7CycleHours(windowSeconds));
}

// daily_usage rows -> prior-cycle summaries for p7ProjectAtReset({ priorCycles }).
//   rows : [{ date:'YYYY-MM-DD', seven_day_vals: number[] | JSON string, seven_day_peak }], any
//          order, ONE org/provider (the caller filters)
// Splits the per-day util series into cycles at reset drops and keeps only the segments that end
// on/before the current cycle's start day — the current cycle must never be read as a prior one.
// Returns [{ resetMs|null, startDate, endDate, peakUtil, finalUtil }], oldest first, at most K.
export function p7PriorCyclesFromDaily(rows, resetMs, windowSeconds) {
  if (!Array.isArray(rows) || !Number.isFinite(resetMs)) return [];
  const days = rows.filter((r) => r && typeof r.date === 'string')
    .slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const segs = [];
  let cur = null;
  for (const d of days) {
    let vals = d.seven_day_vals;
    if (typeof vals === 'string') {
      try { vals = JSON.parse(vals); } catch (e) { vals = null; }
    }
    if (!Array.isArray(vals) || !vals.length) vals = Number.isFinite(d.seven_day_peak) ? [d.seven_day_peak] : [];
    for (const v of vals) {
      if (!Number.isFinite(v)) continue;
      const drop = cur && cur.last - v >= P7_DAILY_DROP_ABS && v <= cur.last * P7_DAILY_DROP_REL;
      if (!cur || drop) {
        if (cur) segs.push(cur);
        cur = { startDate: d.date, endDate: d.date, peakUtil: v, finalUtil: v, last: v };
      }
      cur.endDate = d.date;
      cur.peakUtil = Math.max(cur.peakUtil, v);
      cur.finalUtil = v;
      cur.last = v;
    }
  }
  if (cur) segs.push(cur);
  const cycleMs = p7CycleHours(windowSeconds) * 3600000;
  const cycleStartDate = new Date(resetMs - cycleMs).toISOString().slice(0, 10);
  return segs
    .filter((s) => s.endDate <= cycleStartDate)
    .slice(-P7_PRIOR_K)
    .map((s) => {
      // Tag the reset instant when the segment ends on the date of an earlier in-phase reset.
      const k = Math.round((resetMs - Date.parse(`${s.endDate}T12:00:00Z`)) / cycleMs);
      const rk = resetMs - k * cycleMs;
      const tagged = k >= 1 && new Date(rk).toISOString().slice(0, 10) === s.endDate ? rk : null;
      return { resetMs: tagged, startDate: s.startDate, endDate: s.endDate, peakUtil: s.peakUtil, finalUtil: s.finalUtil };
    });
}
