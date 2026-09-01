// Prediction, status/peak banners, gauge prediction line, and the runner animation for the popup.
// Extracted from popup.js (refactor/popup-prediction). Leaf domain: depends only on shared state
// (ui/state.js) and pure helpers (ui/util.js); i18n `t` is a global from i18n.js.
import { state, _filteredHistory } from './state.js';
import { _isDark, formatResetAbsolute, windowUnitLabel } from './util.js';
import { renderGaugeWait, renderGaugeCapped } from './gauge-facts.js';
// The forecast maths moved to a pure module so the Worker can import it too (#1026). Re-exported
// here so every existing call site keeps working unchanged.
import {
  calcPredictedAtReset, estimateCapHitTime, windowForecast, windowTier, popupForecastCache,
} from './prediction-core.js';
export { calcPredictedAtReset, estimateCapHitTime, windowForecast, windowTier };

// The tier ladder and every verdict derived from it live in ui/usage-tiers.js — the SoT shared
// with the dashboard through a generated twin. Re-exported here so existing importers (and the
// popup renderers below) keep one obvious place to reach for them.
import {
  PROJECTION_TIERS, AT_LIMIT_TIER, projectionTier, tierSeverity, TIER_COLOR, tierColor, isAlertTier,
  isAtRiskOfCap, isNearLimit, isRisingNotice, isStableLook, crossesCap, windowAverageProjection,
  projectFlatWindow, FLAT_LOOKBACKS_H, FLAT_MIN_SPAN_H,
  etaWithinWindow, pickWorstWindow, degradedApprox,
} from './usage-tiers.js';
export {
  PROJECTION_TIERS, AT_LIMIT_TIER, projectionTier, tierSeverity, TIER_COLOR, tierColor, isAlertTier,
  isAtRiskOfCap, isNearLimit, isRisingNotice, isStableLook, crossesCap,
  etaWithinWindow, pickWorstWindow, projectFlatWindow, windowAverageProjection, degradedApprox,
  FLAT_LOOKBACKS_H, FLAT_MIN_SPAN_H,
};

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
// `span5h`/`span7d`: the provider-reported window lengths, for the same reason the banner takes
// them (#978) — this strip NAMES a window, and a ChatGPT Free/Go user at 100% would otherwise read
// "7일 한도 도달" about a 30-day window while the gauge beside it is labelled 30일.
export function renderLimitReachedHeadline(util5h, resets5h, util7d, resets7d, span5h, span7d) {
  const capped = [];
  if (util5h != null && util5h >= 100 && resets5h) capped.push({ label: windowUnitLabel(span5h) || t('win_5h'), reset: resets5h });
  if (util7d != null && util7d >= 100 && resets7d) capped.push({ label: windowUnitLabel(span7d) || t('win_7d'), reset: resets7d });
  if (!capped.length) return false;
  capped.sort((a, b) => new Date(b.reset) - new Date(a.reset)); // latest reset = the binding window
  setPredictHeadline(t('predict_headline_reached', capped[0].label, formatResetAbsolute(capped[0].reset)), 'is-alert');
  return true;
}

// Per-gauge forecast line, graded by the ladder above. The >= 100% case never reaches here —
// the wait block owns it (it has an honest hit time to show; this line does not).
//   • PRESSING (>= 95%)      → red "⚠️ 리셋 시 한도 근접 (~X%)"
//   • WARMING  (75-95%)      → amber "📈 리셋 시 ~X% 예상", the quiet informational step
//   • below that, or flat/falling → hidden (a calm window earns silence, not a green line)
// The same line, but from the DEGRADED projection — used where there is no measured forecast yet
// and the gauge is showing its "collecting" badge.
//
// Why the gauge speaks at all here: the banner and the chart already act on this fallback, so a
// gauge that stays silent is not being careful, it is disagreeing with the rest of the popup about
// whether anything can be said. The split is deliberate — the coarse estimate drives WORDS, the
// measured forecast drives PIXELS. No marker, no fill, no "▸ X%" badge, because those imply a
// precision a window average does not have; a line that names a level does not.
//
// It always uses `predict_at_reset` (never "한도 근접"), clamped for display: the window average
// can read 300% on a fast start, and "리셋 시 한도 근접 (~300%)" would be both wrong and alarming.
// Severity rides on the colour instead. Only WARMING and above speak; below that, silence.
// Renders the value degradedApprox() already decided on — it does NOT decide again. The badge
// beside this line is chosen from the same value, which is what stops the two from disagreeing
// ("예측 수집 중" over "⚠️ 리셋 시 120%", #1090). Pass null to hide.
function _renderDegradedLine(lineEl, degraded) {
  if (!lineEl) return;
  if (degraded == null) {
    lineEl.style.display = 'none';
    return;
  }
  const icon = isAlertTier(degraded) ? '⚠️ ' : '📈 ';
  const html = icon + t('predict_at_reset', Math.round(Math.min(degraded, 100)));
  lineEl.style.display = 'block';
  lineEl.innerHTML = `<div class="gpl-main" style="color:${tierColor(degraded)}">${html}</div>`;
}

function _renderProjectionLine(lineEl, predicted, rate, currentUtil) {
  if (!lineEl) return;
  let html = '';
  if (isNearLimit(predicted, rate, currentUtil)) {
    html = '⚠️ ' + t('predict_near_limit', Math.floor(predicted));
  } else if (isRisingNotice(predicted, rate, currentUtil)) {
    html = '📈 ' + t('predict_at_reset', Math.round(predicted));
  }
  if (html) {
    lineEl.style.display = 'block';
    lineEl.innerHTML = `<div class="gpl-main" style="color:${tierColor(predicted)}">${html}</div>`;
  } else {
    lineEl.style.display = 'none';
  }
}

// `spanSeconds`: the provider-reported window length for THIS slot (#978). Only the degraded
// branch uses it; pass null/undefined and it falls back to the 5h/7d constants, which is right
// for every provider that does not report one.
export function renderGaugePrediction(id, history, key, currentUtil, resetsAt, spanSeconds) {
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

  // The same slot as showCollecting, saying the OTHER true thing: there is no measured rate, but
  // the window average has a number worth showing — and the line below is already showing it.
  // `~` marks it as an approximation so the badge never reads like a measured forecast (#1090).
  const showApprox = (degraded) => {
    hide();
    if (inlineEl) {
      inlineEl.style.display = 'inline';
      inlineEl.style.color = tierColor(degraded);
      inlineEl.textContent = `\u25b8 ~${Math.round(Math.min(degraded, 100))}%`;
      inlineEl.title = t('predict_tip_approx');
      inlineEl.style.cursor = 'help';
    }
  };

  // ONE decision, three surfaces. Badge, line and headline all read this — recomputing it per
  // surface is exactly how they came to contradict each other.
  const approx = degradedApprox(currentUtil, key, resetsAt, spanSeconds);
  const showFallback = () => {
    // Order matters: show*() calls hide(), which would blank a line rendered before it.
    if (approx != null) showApprox(approx); else showCollecting();
    _renderDegradedLine(lineEl, approx);
    if (id === '5h' && state.historyLoaded) {
      setPredictHeadline(t(approx != null ? 'predict_headline_approx' : 'predict_headline_collecting'));
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
    // The headline only speaks after history has actually loaded, else the teaser flashes on
    // every popup open before the async fetch resolves — showFallback keeps that gate.
    showFallback();
    return;
  }

  // Use common prediction function
  // Scope the cache to the org currently selected in the popup. One popup only ever shows one
  // account, but the cache no longer assumes that — see prediction-core.js.
  const pred = calcPredictedAtReset(history, key, currentUtil, resetsAt,
    { cache: popupForecastCache, scope: state.selectedOrgId || 'default' });
  if (!pred) {
    showFallback();
    return;
  }

  const { rate, predicted, hoursToReset, hoursDiff, hoursTo100: predHoursTo100 } = pred;
  const clampedPos = Math.min(predicted, 100);
  console.log(`[GaugePred:${id}] rate=${rate.toFixed(3)}/h, hoursDiff=${hoursDiff.toFixed(2)}h, predicted=${predicted.toFixed(1)}%`);

  // Estimated time to reach 100% (exact hit only) — computed BEFORE the "stable" gate because
  // the red warning depends on the LEVEL, not the growth rate: a window parked at 99% with a
  // trickle of growth must still warn. Same MM/DD(day) format as the reset line (formatResetAbsolute).
  const atRisk = isAtRiskOfCap(predicted, rate, currentUtil);
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
    // Not projected to hit the cap: keep the plain reset line rendered earlier and let the
    // graded forecast line speak for the near-limit / warming bands on its own.
    _renderProjectionLine(lineEl, predicted, rate, currentUtil);
  }
  // Headline strip is now the day-1 "collecting" teaser only; clear it once we have a forecast.
  if (id === '5h') setPredictHeadline(null);

  // Minimal change or decreasing trend: show the "stable" badge. The level-based warning line
  // above still stands, so only the marker/fill + header badge switch to the stable look —
  // unless that line is UP, in which case isStableLook() withholds the green badge rather than
  // contradict it, and the normal rising badge below renders instead.
  if (isStableLook(predicted, rate, currentUtil)) {
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

  // Colors — from the ladder, so the badge, the fill and the line below always agree.
  const color = tierColor(predicted);
  const loud = isAlertTier(predicted); // PRESSING+ gets the solid treatment, notes stay tinted
  const predictText = `${Math.round(clampedPos)}%`; // a bar cannot read past 100 — a clamp, not a tier

  // (A) Header inline prediction: "▸ 78%" or "▸ 4/12 2PM" badge
  if (inlineEl) {
    inlineEl.style.display = 'inline';
    inlineEl.style.color = loud ? '#fff' : color;
    inlineEl.style.background = loud ? color : `${color}${_isDark() ? '30' : '18'}`;
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
// Reads the SAME forecast as the gauges (calcPredictedAtReset — recent-rate for 5h, the
// diurnal/weekly-aware projector for 7d), not the old window-average pace. Those two disagree
// by a lot on a front-loaded window: 34% used 1h25m into a 5h window is "97% at reset" by
// measured rate and "120%" by window average, and the popup used to show BOTH at once — a
// silent gauge above a red "크게 초과" banner. One forecast, one verdict.
// `span5h`/`span7d` are the provider-reported window lengths (#978) — the banner is the one
// surface that speaks at EVERY tier, so a wrong denominator here is the loudest version of the
// bug: a ChatGPT Free user 5 days from a 30-day reset read "105% — 한도 도달 예상" instead of 36%.
export function renderStatusBanner(util5h, util7d, history, resets5h, resets7d, span5h, span7d) {
  const banner = document.getElementById('status-banner');
  if (!banner) return;
  if (util5h === null && util7d === null) { banner.classList.add('hidden'); return; }

  // Same picker as the dashboard banner (ui/usage-tiers.js): worst tier wins, ties go to the
  // window that gets there sooner. This used to be hand-rolled here with a `>=` that always
  // preferred 5h on a tie — a different rule from the one the shared helper documents, which is
  // how 'both banners agree' quietly stops being true.
  const candidate = (util, key, resetsAt, label, spanSeconds) => {
    const fc = windowForecast(util, key, resetsAt, history, spanSeconds);
    if (!fc) return null;
    const hoursToReset = resetsAt ? (new Date(resetsAt).getTime() - Date.now()) / 3600000 : null;
    return { tier: fc.tier, eta: etaWithinWindow(fc.hoursTo100, hoursToReset), label };
  };
  const win = pickWorstWindow([
    // 🔴 The LABEL comes from the same span as the projection. Static t('win_7d') here would tell
    // a ChatGPT Free/Go user that their "7일" window is projected to 96% while the gauge beside it
    // is labelled 30일 — the label/projection split this whole change exists to remove (#978).
    candidate(util5h, 'h5', resets5h, windowUnitLabel(span5h) || t('win_5h'), span5h),
    candidate(util7d, 'd7', resets7d, windowUnitLabel(span7d) || t('win_7d'), span7d),
  ]);
  let tier = win ? win.tier : undefined;
  const worstWindow = win ? win.label : undefined;

  let text;
  if (tier) {
    text = t('pace_' + tier.id, worstWindow);
  } else {
    const maxUtil = Math.max(util5h || 0, util7d || 0);
    if (maxUtil >= 95) {
      tier = { id: 'critical', css: 'red' };
      const which = (util5h || 0) >= 95
        ? (windowUnitLabel(span5h) || t('win_5h'))
        : (windowUnitLabel(span7d) || t('win_7d'));
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
