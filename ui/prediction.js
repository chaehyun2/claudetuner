// Prediction, status/peak banners, gauge prediction line, and the runner animation for the popup.
// Extracted from popup.js (refactor/popup-prediction). Leaf domain: depends only on shared state
// (ui/state.js) and pure helpers (ui/util.js); i18n `t` is a global from i18n.js.
import { state, _filteredHistory } from './state.js';
import { calcPaceTier, _isDark, formatResetAbsolute } from './util.js';
import { renderGaugeWait, renderGaugeCapped } from './gauge-facts.js';
import { diurnalProject7dAdaptive } from './diurnal.js';

// Projected-at-reset threshold (%) at/above which a window counts as "near the cap" and
// earns the amber-red warning even when it never cleanly crosses 100% (the discount-only
// clamp deliberately holds such forecasts just under 100). Shared with the overview cards.
export const NEAR_LIMIT_PCT = 99;

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
const _predCache = new Map();               // fingerprint -> { at, value }; insertion order = LRU

// Cheap O(1) content fingerprint of a history array. usageHistory is append-only with a front
// trim and an occasional sorted server-snapshot merge (bg/storage.js), so any real change moves
// the length, the first/last timestamps, or the newest sample's values. The midpoint sample and
// the org tag are folded in so two orgs' distinct arrays cannot collide onto one key.
function _predCacheKey(history, key, currentUtil, resetsAt) {
  const n = history.length;
  const first = history[0];
  const last = history[n - 1];
  const mid = history[n >> 1];
  return `${key}|${currentUtil}|${resetsAt}|${n}|${first.t}|${last.t}|${last.org}`
    + `|${last.h5}|${last.d7}|${last.r7}|${mid.t}|${mid.d7}`;
}

function _predCacheGet(cacheKey, nowMs) {
  const hit = _predCache.get(cacheKey);
  if (!hit) return null;
  if (nowMs - hit.at > PRED_CACHE_TTL_MS) { _predCache.delete(cacheKey); return null; }
  _predCache.delete(cacheKey);            // re-insert so the most recently used entry evicts last
  _predCache.set(cacheKey, hit);
  return hit.value;
}

function _predCacheSet(cacheKey, value, nowMs) {
  if (_predCache.size >= PRED_CACHE_MAX) {
    const oldest = _predCache.keys().next().value;
    if (oldest !== undefined) _predCache.delete(oldest);
  }
  _predCache.set(cacheKey, { at: nowMs, value });
}

// Estimate when the current 100% episode began, for an already-capped window.
// History is ascending by time; walk back from the newest sample while util is
// still >= 100 and return the earliest such timestamp — the start of the run the
// user is currently in. Null when history is empty or the newest sample isn't
// capped. Approximate (history is sampled, and if the whole slice is >= 100 the
// true start is earlier than we can see), so callers label the wait "약/~".
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
export function calcPredictedAtReset(history, key, currentUtil, resetsAt) {
  if (!resetsAt || currentUtil === null || !history || history.length < 3) return null;

  const now = Date.now();
  const resetTime = new Date(resetsAt).getTime();
  const hoursToReset = Math.max((resetTime - now) / 3600000, 0);
  if (hoursToReset < 0.05) return null;

  let rate, hoursDiff;

  if (key === 'd7') {
    // 7d: activity-normalized adaptive projection (docs/DESIGN-rate-estimator.md).
    // Estimate the burn rate with a recency-weighted EWMA over ~48h of ACTIVITY time and
    // project through the user's PERSONAL diurnal + weekly curve (global fallback when data
    // is thin). Replaces the old thin/noisy last-6h flat window; the activity-mass model,
    // discount-only clamp and remaining-mass floor are unchanged. Passing the full local
    // history (extension keeps 30d) is what lets the personal curve be built.
    //
    // Memoized (see the "7d projection memo" block above): the model build is the expensive part
    // of a renderOverview() pass. Skip the cache entirely near a reset, where the forecast is
    // both shortest-lived and most sensitive.
    const cacheKey = hoursToReset >= PRED_CACHE_MIN_HOURS_TO_RESET
      ? _predCacheKey(history, key, currentUtil, resetsAt)
      : null;
    if (cacheKey) {
      const cached = _predCacheGet(cacheKey, now);
      // hoursToReset is recomputed from the live clock rather than served from the entry — it is
      // the one field rendered at minute granularity (renderGaugePrediction's tooltip).
      if (cached) return { ...cached, hoursToReset };
    }
    const samples = history
      .filter(p => p.d7 != null && p.r7)
      .map(p => ({ tMs: p.t, util: p.d7, resetMs: new Date(p.r7).getTime() }));
    const dp = diurnalProject7dAdaptive({ samples, currentUtil, resetMs: resetTime, nowMs: now });
    if (!dp) return null;
    const result = {
      rate: dp.rate,
      predicted: dp.predicted,
      hoursToReset: dp.hoursToReset,
      hoursDiff: dp.hoursDiff,
      hoursTo100: dp.hoursTo100,
    };
    // Store a copy so a caller mutating the returned object can never poison the cache.
    // A sub-hour observation window (a brand-new user, or the thin-data fallback) is NOT cached:
    // renderGaugePrediction renders `hoursDiff` in whole MINUTES below 1h, which is fine enough
    // to notice a TTL's worth of staleness — and such a short history is cheap to recompute.
    if (cacheKey && dp.hoursDiff >= 1) _predCacheSet(cacheKey, { ...result }, now);
    return result;
  } else {
    // 5h: rate based on local history
    const lookbacks = [2 * 3600000, 6 * 3600000, Infinity];
    let valid = [];
    for (const lb of lookbacks) {
      valid = history.filter((p) => p[key] !== null && (lb === Infinity || p.t > now - lb));
      if (valid.length >= 2) break;
    }
    if (valid.length < 2) return null;
    const first = valid[0];
    const last = valid[valid.length - 1];
    hoursDiff = (last.t - first.t) / 3600000;
    if (hoursDiff < 0.5) return null;
    rate = (last[key] - first[key]) / hoursDiff;
  }

  const predicted = currentUtil + (rate * hoursToReset);

  return { rate, predicted, hoursToReset, hoursDiff };
}

// Prediction headline strip above the gauges (driven only by the 5h gauge).
// Pass null to hide. tone 'is-alert' for the limit-reached forecast.
export function setPredictHeadline(html, tone) {
  const el = document.getElementById('predict-headline');
  if (!el) return;
  if (!html) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.className = 'predict-headline' + (tone ? ' ' + tone : '');
  el.textContent = html;
  el.classList.remove('hidden');
}

// If a usage window is already maxed (>= 100%), replace the top strip with a plain
// "🚫 {window} 한도 도달 — {reset}까지 대기" message so the user knows WHEN access returns.
// Overrides the day-1 "collecting" teaser (being at the cap is the more urgent, actionable
// fact). When BOTH windows are capped, name the one whose reset is LATEST — access stays
// blocked until every capped window resets. Call AFTER the per-gauge renderGaugePrediction()
// calls so it wins the strip. Returns true when a headline was set.
export function renderLimitReachedHeadline(util5h, resets5h, util7d, resets7d) {
  const capped = [];
  if (util5h != null && util5h >= 100 && resets5h) capped.push({ label: t('win_5h'), reset: resets5h });
  if (util7d != null && util7d >= 100 && resets7d) capped.push({ label: t('win_7d'), reset: resets7d });
  if (!capped.length) return false;
  capped.sort((a, b) => new Date(b.reset) - new Date(a.reset)); // latest reset = the binding window
  setPredictHeadline(t('predict_headline_reached', capped[0].label, formatResetAbsolute(capped[0].reset)), 'is-alert');
  return true;
}

// Per-gauge red warning line under a gauge (the projected-at-reset % itself is shown by the
// bar fill, so we never repeat it as text). Independent of the stable/rising badge split:
//   • projected to hit 100% before reset (limitTimeStr set) → exact "한도 도달 예상 {time}"
//   • else projected NEAR the cap (>= NEAR_LIMIT_PCT) and still rising → "한도 근접 (~X%)", no
//     time (the discount-clamped forecast has no honest hit time here)
//   • otherwise → hidden
function _renderWarnLine(lineEl, predicted, rate, currentUtil, limitTimeStr) {
  if (!lineEl) return;
  let warnHtml = '';
  if (limitTimeStr) {
    warnHtml = '⚠️ ' + t('predict_limit_at', limitTimeStr);
  } else if (predicted >= NEAR_LIMIT_PCT && rate > 0 && currentUtil < 100) {
    warnHtml = '⚠️ ' + t('predict_near_limit', Math.floor(predicted));
  }
  if (warnHtml) {
    lineEl.style.display = 'block';
    lineEl.innerHTML = `<div class="gpl-main" style="color:#ef4444">${warnHtml}</div>`;
  } else {
    lineEl.style.display = 'none';
  }
}

export function renderGaugePrediction(id, history, key, currentUtil, resetsAt) {
  const marker = document.getElementById(`gauge-${id}-predict`);
  const label = document.getElementById(`gauge-${id}-predict-label`);
  const inlineEl = document.getElementById(`gauge-${id}-predict-inline`);
  const fillEl = document.getElementById(`gauge-${id}-predict-fill`);
  const lineEl = document.getElementById(`gauge-${id}-predict-line`);
  const hide = () => {
    if (marker) marker.style.display = 'none';
    if (label) label.style.display = 'none';
    if (inlineEl) inlineEl.style.display = 'none';
    if (fillEl) fillEl.style.display = 'none';
    if (lineEl) lineEl.style.display = 'none';
  };

  const showCollecting = () => {
    hide();
    if (inlineEl) {
      inlineEl.style.display = 'inline';
      inlineEl.style.color = '#9ca3af';
      inlineEl.textContent = '\u25b8\u23f3';
      inlineEl.title = t('predict_tip_collecting');
      inlineEl.style.cursor = 'help';
    }
  };

  // Fully hide if no reset time or utilization is null
  if (!resetsAt || currentUtil === null) {
    hide();
    if (id === '5h') setPredictHeadline(null);
    return;
  }

  // Already at the cap: being at 100% is a fact independent of the forecast, so this
  // must come BEFORE the "collecting" (insufficient-history) guards — otherwise a
  // capped window with < 3 history points would show "collecting" instead of the
  // capped block. Hide the badge/marker; render when the cap was hit (estimated from
  // history; null → reset-line-only) + the total wait it implies.
  if (currentUtil >= 100) {
    hide();
    if (id === '5h') setPredictHeadline(null);
    renderGaugeCapped(id, resetsAt, estimateCapHitTime(history, key), true);
    return;
  }

  // Insufficient history: show collecting indicator + day-1 teaser headline.
  // The forecast needs 2-3 data points, so a new user's first session has none —
  // the teaser conveys the (unique) upcoming value and a reason to come back.
  if (!history || history.length < 3) {
    showCollecting();
    // Only after history has actually loaded, else the teaser flashes on every
    // popup open before the async history fetch resolves.
    if (id === '5h' && state.historyLoaded) setPredictHeadline(t('predict_headline_collecting'));
    return;
  }

  // Use common prediction function
  const pred = calcPredictedAtReset(history, key, currentUtil, resetsAt);
  if (!pred) {
    showCollecting();
    if (id === '5h' && state.historyLoaded) setPredictHeadline(t('predict_headline_collecting'));
    return;
  }

  const { rate, predicted, hoursToReset, hoursDiff, hoursTo100: predHoursTo100 } = pred;
  const clampedPos = Math.min(predicted, 100);
  console.log(`[GaugePred:${id}] rate=${rate.toFixed(3)}/h, hoursDiff=${hoursDiff.toFixed(2)}h, predicted=${predicted.toFixed(1)}%`);

  // Estimated time to reach 100% (exact hit only) — computed BEFORE the "stable" gate because
  // the red warning depends on the LEVEL, not the growth rate: a window parked at 99% with a
  // trickle of growth must still warn. Same MM/DD(day) format as the reset line (formatResetAbsolute).
  const atRisk = predicted >= 100 && rate > 0 && currentUtil < 100;
  let limitTimeStr = '';
  if (atRisk) {
    // Prefer the diurnal-aware time-to-100 (7d); fall back to flat rate (5h / null).
    const hoursTo100 = predHoursTo100 != null ? predHoursTo100 : (100 - currentUtil) / rate;
    // For the badge tooltip only (the wait block shows this time itself).
    limitTimeStr = formatResetAbsolute(new Date(Date.now() + hoursTo100 * 3600000));
    // The wait block (headline = wait span, evidence = limit/reset times) replaces
    // the reset line in #gauge-{id}-reset. The separate warn line is hidden so the
    // limit-hit time isn't shown twice.
    renderGaugeWait(id, resetsAt, hoursTo100, hoursToReset, currentUtil !== null);
    if (lineEl) lineEl.style.display = 'none';
  } else {
    // Not projected to hit the cap: keep the plain reset line rendered earlier and
    // let the warn line handle the "near limit (~X%)" case on its own.
    _renderWarnLine(lineEl, predicted, rate, currentUtil, '');
  }
  // Headline strip is now the day-1 "collecting" teaser only; clear it once we have a forecast.
  if (id === '5h') setPredictHeadline(null);

  // Minimal change or decreasing trend: show the "stable" badge. The level-based warning line
  // above still stands, so only the marker/fill + header badge switch to the stable look.
  if (rate <= 0 || predicted - currentUtil < 3) {
    if (marker) marker.style.display = 'none';
    if (label) label.style.display = 'none';
    if (fillEl) fillEl.style.display = 'none';
    if (inlineEl) {
      inlineEl.style.display = 'inline';
      inlineEl.style.color = '#22c55e';
      inlineEl.style.background = _isDark() ? '#22c55e30' : '#22c55e18';
      inlineEl.textContent = '\u25b8 \u2014';
      inlineEl.title = t('predict_tip_stable');
      inlineEl.style.cursor = 'help';
    }
    return;
  }

  // Colors
  const color = predicted >= 80 ? '#ef4444' : predicted >= 50 ? '#f59e0b' : '#9ca3af';
  const predictText = predicted >= 100 ? '100%' : `${Math.round(predicted)}%`;

  // (A) Header inline prediction: "▸ 78%" or "▸ 4/12 2PM" badge
  if (inlineEl) {
    inlineEl.style.display = 'inline';
    inlineEl.style.color = predicted >= 80 ? '#fff' : color;
    inlineEl.style.background = predicted >= 80 ? color : `${color}${_isDark() ? '30' : '18'}`;
    inlineEl.textContent = `\u25b8 ${predictText}`;
    const obsTime = hoursDiff < 1 ? `${Math.round(hoursDiff * 60)}${t('min')}` : `${hoursDiff.toFixed(1)}${t('hours_short')}`;
    const resetTime2 = hoursToReset < 1 ? `${Math.round(hoursToReset * 60)}${t('min')}` : `${hoursToReset.toFixed(1)}${t('hours_short')}`;
    const tipLine3 = limitTimeStr ? t('predict_limit_at', limitTimeStr) : t('predict_tip_line3', predictText);
    // 7d projection is diurnal-aware (discounts sleep/idle hours) — note it in the tip.
    const diurnalNote = key === 'd7' ? '\n' + t('predict_tip_diurnal') : '';
    inlineEl.title = t('predict_tip_line1', obsTime, rate.toFixed(1)) + '\n' + t('predict_tip_line2', resetTime2) + '\n→ ' + tipLine3 + diurnalNote;
    inlineEl.style.cursor = 'help';
  }

  // (B) Fill predicted range on gauge bar
  if (fillEl) {
    const barColor = id === '5h' ? '#06b6d4' : '#7c3aed';
    fillEl.style.display = 'block';
    fillEl.style.left = `${Math.min(currentUtil, 100)}%`;
    fillEl.style.width = `${Math.min(clampedPos - Math.min(currentUtil, 100), 100)}%`;
    fillEl.style.color = barColor;
  }

  // Marker + label (existing)
  if (marker) {
    marker.style.display = 'block';
    marker.style.left = `${clampedPos}%`;
    marker.style.background = color;
  }
  // Label (number) omitted to avoid text overlap — marker+bar+inline badge is sufficient
  if (label) {
    label.style.display = 'none';
  }
}

// === Status banner (6-tier pace) ===
export function renderStatusBanner(util5h, util7d, history, resets5h, resets7d) {
  const banner = document.getElementById('status-banner');
  if (!banner) return;
  if (util5h === null && util7d === null) { banner.classList.add('hidden'); return; }

  const pace5h = calcPaceTier(util5h, resets5h, 5 * 3600);
  const pace7d = calcPaceTier(util7d, resets7d, 7 * 24 * 3600);

  const severity = { comfortable: 0, ontrack: 1, warming: 2, pressing: 3, critical: 4, runaway: 5 };
  let tier, worstWindow;
  if (pace5h && pace7d) {
    if (severity[pace5h.id] >= severity[pace7d.id]) {
      tier = pace5h; worstWindow = t('win_5h');
    } else {
      tier = pace7d; worstWindow = t('win_7d');
    }
  } else if (pace5h) {
    tier = pace5h; worstWindow = t('win_5h');
  } else if (pace7d) {
    tier = pace7d; worstWindow = t('win_7d');
  }

  let text;
  if (tier) {
    text = t('pace_' + tier.id, worstWindow);
  } else {
    const maxUtil = Math.max(util5h || 0, util7d || 0);
    if (maxUtil >= 95) {
      tier = { id: 'critical', css: 'red' };
      const which = (util5h || 0) >= 95 ? t('win_5h') : t('win_7d');
      text = t('pace_near_static', which);
    } else if (maxUtil >= 80) {
      tier = { id: 'warming', css: 'yellow' };
      text = t('pace_high_static', Math.round(maxUtil));
    } else {
      tier = { id: 'comfortable', css: 'green' };
      text = t('pace_comfortable');
    }
  }

  banner.className = 'status-banner sb-' + tier.css;
  banner.textContent = text;
  banner.classList.remove('hidden');
}

// === Peak hours banner (Anthropic official: weekdays 12:00-18:00 UTC, shown only during peak) ===
// Disabled: Anthropic removed peak hour limit reduction for Pro/Max (2026-05-07)
export function renderPeakBanner() {
  const el = document.getElementById('offpeak-banner');
  if (!el) return;
  el.classList.add('hidden');
  return; // peak hours no longer apply — re-enable if Anthropic brings them back

  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay(); // 0=Sun, 6=Sat
  const isWeekday = utcDay >= 1 && utcDay <= 5;
  const isPeak = isWeekday && utcHour >= 12 && utcHour < 18;

  if (!isPeak) {
    el.classList.add('hidden');
    return;
  }

  const remaining = 18 - utcHour;
  // Convert UTC 12:00-18:00 to user's local time
  const today = new Date();
  const peakStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12));
  const peakEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 18));
  const locale = getLang() === 'ko' ? 'ko-KR' : 'en-US';
  const fmt = (d) => d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', hour12: true });
  const localRange = `${fmt(peakStart)}–${fmt(peakEnd)}`;
  el.className = 'offpeak-banner is-peak';
  const detailText = t('promo_peak_detail', localRange);
  el.innerHTML = `<span class="op-icon">🔥</span><span class="op-text">${t('promo_peak')}<br><span class="op-sub">${t('promo_peak_sub', localRange)} · ${t('promo_peak_remaining', remaining)}</span></span><span class="op-help" title="${detailText}">?</span>`;
  el.classList.remove('hidden');

  // Toggle detail description on ? click
  const helpBtn = el.querySelector('.op-help');
  if (helpBtn) {
    helpBtn.onclick = (e) => {
      e.stopPropagation();
      let tooltip = el.querySelector('.op-tooltip');
      if (tooltip) {
        tooltip.remove();
      } else {
        tooltip = document.createElement('div');
        tooltip.className = 'op-tooltip';
        tooltip.textContent = detailText;
        el.appendChild(tooltip);
      }
    };
  }
}

// === Helper functions ===
// Restore gauge HTML when switching from Enterprise to regular plan
export function _restoreGaugeHTML(gaugeSection) {
  // If gauge-5h-value is missing, innerHTML was replaced with Enterprise layout
  if (document.getElementById('gauge-5h-value')) return;
  gaugeSection.innerHTML =
    '<div class="gauge-row" id="gauge-row-5h"><div class="gauge-header">' +
    '<span class="gauge-label">' + t('usage_5h') + '</span>' +
    '<span class="gauge-value" id="gauge-5h-value" style="color:#06b6d4">-</span>' +
    '<span class="gauge-predict-inline" id="gauge-5h-predict-inline" style="display:none"></span></div>' +
    '<div class="gauge-bar"><div id="gauge-5h-fill" class="gauge-fill" style="width:0;background:#06b6d4"></div>' +
    '<div id="gauge-5h-predict-fill" class="gauge-predict-fill" style="display:none"></div>' +
    '<div id="gauge-5h-predict" class="gauge-predict" style="display:none"></div>' +
    '<span id="gauge-5h-predict-label" class="gauge-predict-label" style="display:none"></span></div>' +
    '<div class="gauge-sub" id="gauge-5h-reset"></div>' +
    '<div class="gauge-predict-line" id="gauge-5h-predict-line" style="display:none"></div></div>' +
    '<div class="gauge-row" id="gauge-row-7d"><div class="gauge-header">' +
    '<span class="gauge-label">' + t('usage_7d') + '</span>' +
    '<span class="gauge-value" id="gauge-7d-value" style="color:var(--accent)">-</span>' +
    '<span class="gauge-predict-inline" id="gauge-7d-predict-inline" style="display:none"></span></div>' +
    '<div class="gauge-bar"><div id="gauge-7d-fill" class="gauge-fill" style="width:0;background:#7c3aed"></div>' +
    '<div id="gauge-7d-predict-fill" class="gauge-predict-fill" style="display:none"></div>' +
    '<div id="gauge-7d-predict" class="gauge-predict" style="display:none"></div>' +
    '<span id="gauge-7d-predict-label" class="gauge-predict-label" style="display:none"></span></div>' +
    '<div class="gauge-sub" id="gauge-7d-reset"></div>' +
    '<div class="gauge-predict-line" id="gauge-7d-predict-line" style="display:none"></div></div>';
}

// === Runner Animation ===
const _runnerStates = [
  { min: 0,  max: 5,  emoji: '😴', rest: true },
  { min: 5,  max: 15, emoji: '🧘', rest: true },
  { min: 15, max: 25, emoji: '😮‍💨', rest: true },
  { min: 25, max: 40, emoji: '🚶' },
  { min: 40, max: 60, emoji: '🏃' },
  { min: 60, max: 80, emoji: '🏃💨' },
  { min: 80, max: 90, emoji: '🏇💨💨' },
  { min: 90, max: 101, emoji: '🏍️💨💨💨' },
];
const _pausedEmojis = {
  high: ['🏃', '😤', '💪', '🔥'],
  mid: ['🚶', '🙂', '☕', '🎵'],
  low: ['😴', '💤', '🧘', '😌', '🍵'],
};

function _getRunnerState(speed) {
  return _runnerStates.find(s => speed >= s.min && speed < s.max) || _runnerStates[0];
}

export function initRunner() {
  const track = document.getElementById('runner-track');
  const char = document.getElementById('runner-char');
  const pauseBtn = document.getElementById('runner-pause');
  if (!track || !char || !pauseBtn) return;

  let pos = 0, dir = 1, paused = false, pausedTimer = 0, speed = 0;

  // Speed calculation: 5h change rate based on usageHistory
  function calcSpeed() {
    const recent = (_filteredHistory() || []).filter(p => p.h5 != null).slice(-3);
    if (recent.length < 2) return 0;
    const first = recent[0], last = recent[recent.length - 1];
    const hoursDiff = (last.t - first.t) / 3600000;
    if (hoursDiff < 0.05) return 0;
    const rate = (last.h5 - first.h5) / hoursDiff; // %/hour
    // Map rate to 0-100 speed: 0%/h=0, 20%/h+=100
    const util5h = last.h5 || 0;
    if (rate <= 0) return Math.min(util5h * 0.3, 20); // Declining/stagnant: low speed
    return Math.min(rate * 5 + util5h * 0.3, 100);
  }

  // Load paused state
  chrome.storage.local.get({ runnerPaused: false }, (r) => {
    paused = r.runnerPaused;
    pauseBtn.textContent = paused ? '▶' : '⏸';
  });

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pausedTimer = 0;
    pauseBtn.textContent = paused ? '▶' : '⏸';
    chrome.storage.local.set({ runnerPaused: paused });
  });

  function animate() {
    speed = calcSpeed();
    const state = _getRunnerState(speed);
    const trackWidth = track.offsetWidth - 24;
    if (trackWidth <= 0) { requestAnimationFrame(animate); return; }

    if (paused) {
      char.textContent = state.emoji;
      char.style.left = '0px';
      char.style.top = '0px';
      char.style.transform = 'scaleX(1)';
      requestAnimationFrame(animate);
      return;
    }

    if (state.rest) {
      // Resting state: fixed at center + breathing animation
      char.textContent = state.emoji;
      char.style.left = (trackWidth / 2 - 8) + 'px';
      char.style.top = '0px';
      const breathe = 1 + Math.sin(Date.now() / 600) * 0.04;
      char.style.transform = `scale(${breathe})`;
    } else {
      // Moving state
      const moveSpeed = 0.3 + (speed / 100) * 2.5;
      pos += moveSpeed * dir;
      if (pos >= trackWidth) { pos = trackWidth; dir = -1; }
      else if (pos <= 0) { pos = 0; dir = 1; }

      char.textContent = state.emoji;
      char.style.left = pos + 'px';
      char.style.transform = dir === 1 ? 'scaleX(-1)' : 'scaleX(1)';

      // High speed: vertical bounce
      if (speed > 70) {
        char.style.top = (Math.sin(Date.now() / 80) * 2) + 'px';
      } else {
        char.style.top = '0px';
      }
    }

    requestAnimationFrame(animate);
  }

  // Show + start
  track.style.display = '';
  pauseBtn.style.display = '';
  animate();
}
