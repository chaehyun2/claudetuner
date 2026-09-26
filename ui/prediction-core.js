// Pure forecast core — no DOM, no chrome APIs, no module-level UI state.
//
// WHY THIS FILE EXISTS. The same forecast has to run in three places that share no runtime:
// the extension popup, the dashboard, and now the Cloudflare Worker that serves the mobile
// widget (#1026). Copying it three times is how the numbers start disagreeing between the
// surfaces a user checks against each other, so this is the one canonical implementation and
// every consumer imports it.
//
// 🔴 KEEP THIS FILE PURE. `prediction.js` still owns the DOM renderers; the moment a
// `document.` lands in here the Worker can no longer import it and the copy-paste starts
// again. test/prediction-core-purity-guard.mjs fails the build on that.
//
// The Worker can import this directly (its tsconfig is moduleResolution:"Bundler" and wrangler
// bundles with esbuild), so unlike diurnal.js/usage-tiers.js — which the DASHBOARD cannot import
// because it has no bundler and needs a synced global-script twin — no third copy is needed here.
import { diurnalProject7dAdaptive, p7ProjectAtReset, p7Applies } from './diurnal.js';
import {
  AT_LIMIT_TIER, projectionTier, windowAverageProjection, projectFlatWindow,
} from './usage-tiers.js';

// === 7d projection memo =====================================================================
// The `d7` branch of calcPredictedAtReset rebuilds the user's PERSONAL diurnal + weekly curve
// from the FULL 30-day history on every call (ui/diurnal.js: personalActivityCurve +
// activityNormalizedRate are both O(history)). renderOverview() calls it once per org and re-runs
// on every chrome.storage.onChanged, so the identical model was rebuilt from scratch on every
// repaint — measured at ~1.6ms per org for a 30-day history at the 5-minute sample cadence, and
// ~8.7ms at 1-minute. Memoizing the result makes a repeat render (detail -> overview, or a
// storage-event repaint) cost ~0.
//
// The memo deliberately lives HERE and not in ui/diurnal.js: that file is the canonical source
// for the auto-generated dashboard twin site/shared/diurnal.js, so touching it would require
// regenerating the twin and bumping every `shared/diurnal.js?v=` reference plus the service
// worker CACHE_VERSION. Caching the composed result skips the whole model build anyway.
//
// Invalidation is caller-free: the key is a content fingerprint of every input, so any new data
// point (or a changed util/reset) misses the cache. The ONE input not in the key is wall-clock
// `now`, which is bounded instead by a short TTL. Worst-case staleness at the TTL is far below
// what the UI can render: `predicted` drifts by ratePerMass x (one weight-hour x TTL) — under
// 0.1%pt even for a user burning a full 7d window in a day, against a display that rounds to
// whole percent; the limit ETA is hour-granular (formatResetAbsolute); and `hoursToReset`, the
// one field shown at minute granularity, is recomputed fresh on every cache hit.
const PRED_CACHE_MAX = 24;                  // orgs x windows x a couple of renders — bounds memory
const PRED_CACHE_TTL_MS = 30000;            // max age of a served entry (see staleness note above)
const PRED_CACHE_MIN_HOURS_TO_RESET = 0.25; // never serve a cached forecast this close to a reset
/**
 * Create a cache the CALLER owns.
 *
 * The extension keeps one process-wide instance (`popupForecastCache`) because a popup serves one
 * account. A server must NOT do that: one isolate handles many accounts, so it should either pass
 * a per-request cache or pass none at all. Making the cache an argument is what turns that from a
 * convention into something the type of the call site shows.
 */
export function forecastCache() { return new Map(); }  // fingerprint -> { at, value }; LRU by insertion

/** The extension's single-account cache. Do NOT import this from a server. */
export const popupForecastCache = forecastCache();

// Cheap O(1) content fingerprint of a history array. usageHistory is append-only with a front
// trim and an occasional sorted server-snapshot merge (bg/storage.js), so any real change moves
// the length, the first/last timestamps, or the newest sample's values. The midpoint sample and
// the org tag are folded in so two orgs' distinct arrays cannot collide onto one key.
// 🔴 `scope` is REQUIRED and is what makes this cache safe to share.
//
// The rest of the key is a deliberately LOSSY fingerprint of the history — length, the first and
// last timestamps, the newest sample's values, one midpoint. That is fine when a cache instance
// only ever sees one account (the popup), and it is a cross-account leak the moment it does not:
// two different users' histories can produce the same fingerprint, and the second caller then
// receives the FIRST caller's forecast. Reproduced, not theorised — `first.d7` is not in the
// fingerprint at all, so two histories differing only in their oldest value collide exactly.
//
// So the caller must name the account (or org, or whatever isolation boundary applies) and the
// scope is folded in first. A caller that cannot name one gets no caching — see forecastCache().
//
// 🔴 Every forecast INPUT that is not the history must be in the key too — the window span, the
// viewer's timezone and any caller-supplied prior cycles (`_priorDigest`). Prior cycles DERIVED
// from the history need nothing extra: they come from its oldest part, and a front trim moves
// `first.t`/`n`.
// The digest carries EVERY field the 7d model reads from a prior (ui/diurnal.js p7PriorFinals):
// resetMs/endDate place it, startDate+endDate decide whether it is a whole cycle, finalUtil
// (else peakUtil) is its value. Dropping one lets a changed prior reuse a stale entry (Codex R1).
function _priorDigest(priorCycles) {
  if (!Array.isArray(priorCycles)) return '';
  return priorCycles.map((c) => (c
    ? [c.resetMs, c.startDate, c.endDate, c.finalUtil, c.peakUtil].map((v) => (v == null ? '' : String(v))).join(':')
    : '')).join(',');
}

function _predCacheKey(scope, history, key, currentUtil, resetsAt, fcOpts) {
  const n = history.length;
  const first = history[0];
  const last = history[n - 1];
  const mid = history[n >> 1];
  return `${scope}\u0000${key}|${currentUtil}|${resetsAt}|${n}|${first.t}|${last.t}|${last.org}`
    + `|${last.h5}|${last.d7}|${last.r7}|${mid.t}|${mid.d7}`
    + `|${fcOpts.provider ?? ''}|${fcOpts.windowSeconds ?? ''}|${fcOpts.tzOffsetMin ?? ''}|${_priorDigest(fcOpts.priorCycles)}`;
}

function _predCacheGet(cache, cacheKey, nowMs) {
  const hit = cache.get(cacheKey);
  if (!hit) return null;
  if (nowMs - hit.at > PRED_CACHE_TTL_MS) { cache.delete(cacheKey); return null; }
  cache.delete(cacheKey);            // re-insert so the most recently used entry evicts last
  cache.set(cacheKey, hit);
  return hit.value;
}

function _predCacheSet(cache, cacheKey, value, nowMs) {
  cache.set(cacheKey, { at: nowMs, value });
  while (cache.size > PRED_CACHE_MAX) cache.delete(cache.keys().next().value);
}

export function estimateCapHitTime(history, key) {
  if (!Array.isArray(history) || !history.length) return null;
  let hitT = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const u = history[i][key];
    if (u != null && u >= 100) hitT = history[i].t;
    else break; // run of >=100 (walking back from now) ended → episode started after this
  }
  return hitT;
}

// Used by both gauge prediction and banner evaluation (and the overview cards).
// opts (all optional):
//   cache, scope   — the memo (see above); both or neither
//   windowSeconds  — the provider-reported window span (7d slot: 7 days for Claude, 30 days for
//                    ChatGPT Free/Go). Unknown -> 7 days
//   tzOffsetMin    — the viewer's UTC offset in minutes. Passed by the CALLER
//                    (`-new Date().getTimezoneOffset()`); this file must not read the environment
//   priorCycles    — daily_usage summaries (p7PriorCyclesFromDaily), when the caller has them
//   provider       — 'claude' | 'chatgpt' | 'gemini'. 🔴 Selects the 7d model (p7Applies): the
//                    pace-how projection is fitted on Claude's 7-day window only, so every other
//                    provider — and a caller that does not say — keeps the adaptive projector
// The pace-how 7d result additionally carries `willHit` ("likely to hit the limit") and
// `predictedMedian`; its `predicted` already encodes willHit for the tier ladder (p7ProjectAtReset).
export function calcPredictedAtReset(history, key, currentUtil, resetsAt, opts = {}) {
  // Caching is OPT-IN and needs both a store and a scope. Omit either and every call recomputes —
  // slower, never wrong. That default is deliberate: the failure mode of the other default is a
  // user seeing someone else's number, which nothing downstream could detect.
  const _cache = opts.cache || null;
  const _scope = opts.scope != null ? String(opts.scope) : null;
  if (!resetsAt || currentUtil === null || !history || history.length < 3) return null;

  const now = Date.now();
  const resetTime = new Date(resetsAt).getTime();
  const hoursToReset = Math.max((resetTime - now) / 3600000, 0);
  if (hoursToReset < 0.05) return null;

  let rate, hoursDiff;

  if (key === 'd7') {
    // 7d: the pace-how projection (ui/diurnal.js p7ProjectAtReset, #1681) — cycle-to-date pace,
    // recent 24h rate and the user's prior-cycle finals, on a global hour-of-week activity curve.
    // Passing the full local history (extension keeps 30d) is what supplies the prior cycles.
    //
    // Memoized (see the "7d projection memo" block above): the model build is the expensive part
    // of a renderOverview() pass. Skip the cache entirely near a reset, where the forecast is
    // both shortest-lived and most sensitive.
    const fcOpts = {
      provider: typeof opts.provider === 'string' ? opts.provider : null,
      windowSeconds: Number.isFinite(opts.windowSeconds) && opts.windowSeconds > 0 ? opts.windowSeconds : null,
      tzOffsetMin: Number.isFinite(opts.tzOffsetMin) ? opts.tzOffsetMin : null,
      priorCycles: Array.isArray(opts.priorCycles) ? opts.priorCycles : null,
    };
    const cacheKey = (_cache && _scope !== null && hoursToReset >= PRED_CACHE_MIN_HOURS_TO_RESET)
      ? _predCacheKey(_scope, history, key, currentUtil, resetsAt, fcOpts)
      : null;
    if (cacheKey) {
      const cached = _predCacheGet(_cache, cacheKey, now);
      // hoursToReset is recomputed from the live clock rather than served from the entry — it is
      // the one field rendered at minute granularity (renderGaugePrediction's tooltip).
      if (cached) return { ...cached, hoursToReset };
    }
    const samples = history
      .filter(p => p.d7 != null && p.r7)
      .map(p => ({ tMs: p.t, util: p.d7, resetMs: new Date(p.r7).getTime() }));
    // Claude 7d -> pace-how (#1681). Anything else -> the adaptive projector, exactly as before it.
    const dp = p7Applies(fcOpts.provider, fcOpts.windowSeconds)
      ? p7ProjectAtReset({
        samples, currentUtil, resetMs: resetTime, nowMs: now,
        windowSeconds: fcOpts.windowSeconds ?? undefined,
        tzOffsetMin: fcOpts.tzOffsetMin ?? undefined,
        priorCycles: fcOpts.priorCycles ?? undefined,
      })
      : diurnalProject7dAdaptive({ samples, currentUtil, resetMs: resetTime, nowMs: now });
    if (!dp) return null;
    const result = {
      rate: dp.rate,
      predicted: dp.predicted,
      // pace-how only; undefined on the adaptive path (its tier comes from `predicted` as before)
      predictedMedian: dp.predictedMedian,
      willHit: dp.willHit,
      hoursToReset: dp.hoursToReset,
      hoursDiff: dp.hoursDiff,
      hoursTo100: dp.hoursTo100,
    };
    // Store a copy so a caller mutating the returned object can never poison the cache.
    // A sub-hour observation window (a brand-new user, or the thin-data fallback) is NOT cached:
    // renderGaugePrediction renders `hoursDiff` in whole MINUTES below 1h, which is fine enough
    // to notice a TTL's worth of staleness — and such a short history is cheap to recompute.
    if (cacheKey && dp.hoursDiff >= 1) _predCacheSet(_cache, cacheKey, { ...result }, now);
    return result;
  } else {
    // 5h: the SHARED flat projection (ui/usage-tiers.js). The dashboard runs the same function on
    // its own samples, so the two surfaces can no longer land in different tiers because one of
    // them measured the rate differently. Only the sample mapping is per-runtime — here, local
    // history; there, the snapshot rows.
    const flat = projectFlatWindow({
      samples: history.map((p) => ({ tMs: p.t, util: p[key], resetKey: key === 'h5' ? p.r5 : p.r7 })),
      currentUtil,
      hoursToReset,
      nowMs: now,
    });
    if (!flat) return null;
    return { rate: flat.rate, predicted: flat.predicted, hoursToReset, hoursDiff: flat.hoursDiff };
  }

  const predicted = currentUtil + (rate * hoursToReset);

  return { rate, predicted, hoursToReset, hoursDiff };
}

// Prediction headline strip above the gauges (driven only by the 5h gauge).
// Pass null to hide. tone 'is-alert' for the limit-reached forecast.
// THE verdict for one window, WITH the numbers behind it: the measured forecast when there is
// one, the degraded projection when there is not, and null only when even that is impossible.
// Returns { tier, predicted, rate, hoursTo100, measured } — a caller that DRAWS the projection and one
// that LABELS it must not end up on different values, which is what happens when each derives
// its own. `rate` is null on the degraded path (there is no measured rate to report).
// `spanSeconds` is the window length the PROVIDER reported for this slot — 2592000 for a
// ChatGPT Free/Go 30-day "7d" window, null when the provider did not say (Claude, Gemini, any
// client before 1.29.46), which falls back to the 5h/7d constants. It feeds the DEGRADED branch
// and, since #1681, the measured 7d forecast too (its cycle-to-date pace needs the cycle start).
// Threading it is #978 — before, `remaining` came from the real resets_at while the denominator
// was hard-coded to 7 days, which inflated the projection inside ~6.3 days of a 30-day reset.
// `fcOpts` ({ provider, tzOffsetMin, priorCycles }) is forwarded to calcPredictedAtReset; the span is threaded
// in as its windowSeconds, so the measured 7d forecast uses the real window length too (#978).
export function windowForecast(currentUtil, key, resetsAt, history, spanSeconds, fcOpts = {}) {
  if (currentUtil == null || !resetsAt) return null;
  // Already at the cap: there is no forecast past 100, and no pace verdict is true of someone
  // who is blocked and waiting. AT_LIMIT is its own rung for exactly this — the old code took
  // the loudest PACE rung here and told a stopped user they were "한도를 크게 넘는 페이스".
  if (currentUtil >= 100) return { tier: AT_LIMIT_TIER, predicted: currentUtil, rate: null, hoursTo100: null, measured: false };
  const pred = calcPredictedAtReset(history, key, currentUtil, resetsAt, {
    windowSeconds: spanSeconds, tzOffsetMin: fcOpts.tzOffsetMin, priorCycles: fcOpts.priorCycles,
    provider: fcOpts.provider,
  });
  if (pred) {
    return {
      tier: projectionTier(pred.predicted), predicted: pred.predicted, rate: pred.rate,
      hoursTo100: pred.hoursTo100 != null ? pred.hoursTo100 : null, measured: true,
      willHit: pred.willHit === true,
    };
  }
  const degraded = windowAverageProjection(currentUtil, key, resetsAt, spanSeconds);
  const tier = projectionTier(degraded);
  return tier ? { tier, predicted: degraded, rate: null, hoursTo100: null, measured: false } : null;
}

// Tier-only convenience for callers that render nothing but the verdict.
export function windowTier(currentUtil, key, resetsAt, history, spanSeconds, fcOpts = {}) {
  return windowForecast(currentUtil, key, resetsAt, history, spanSeconds, fcOpts)?.tier ?? null;
}
