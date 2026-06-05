// Prediction, status/peak banners, gauge prediction line, and the runner animation for the popup.
// Extracted from popup.js (refactor/popup-prediction). Leaf domain: depends only on shared state
// (ui/state.js) and pure helpers (ui/util.js); i18n `t` is a global from i18n.js.
import { state, _filteredHistory } from './state.js';
import { calcPaceTier, _isDark } from './util.js';

// Used by both gauge prediction and banner evaluation
function calcPredictedAtReset(history, key, currentUtil, resetsAt) {
  if (!resetsAt || currentUtil === null || !history || history.length < 3) return null;

  const now = Date.now();
  const resetTime = new Date(resetsAt).getTime();
  const hoursToReset = Math.max((resetTime - now) / 3600000, 0);
  if (hoursToReset < 0.05) return null;

  let rate, hoursDiff;

  if (key === 'd7') {
    // 7d: based on local history r7(resets_at) — same logic as dashboard
    // Sum only positive increments within the same resets_at window
    const sixHoursAgo = now - 6 * 3600000;
    const recent = history.filter(p => p.d7 != null && p.r7 && p.t > sixHoursAgo);
    if (recent.length >= 2) {
      let totalDelta = 0;
      for (let i = 1; i < recent.length; i++) {
        if (recent[i - 1].r7 === recent[i].r7) {
          totalDelta += Math.max(0, recent[i].d7 - recent[i - 1].d7);
        }
      }
      const timeDiffH = (recent[recent.length - 1].t - recent[0].t) / 3600000;
      if (timeDiffH > 0) {
        rate = totalDelta / timeDiffH;
        hoursDiff = timeDiffH;
      }
    }
    // Fallback when r7 data is insufficient: elapsed time based on resets_at window
    if (rate == null) {
      const windowH = 7 * 24;
      const elapsed = windowH - hoursToReset;
      if (elapsed < 1) return null;
      rate = currentUtil / elapsed;
      hoursDiff = elapsed;
    }
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

export function renderGaugePrediction(id, history, key, currentUtil, resetsAt) {
  const marker = document.getElementById(`gauge-${id}-predict`);
  const label = document.getElementById(`gauge-${id}-predict-label`);
  const inlineEl = document.getElementById(`gauge-${id}-predict-inline`);
  const fillEl = document.getElementById(`gauge-${id}-predict-fill`);
  const hide = () => {
    if (marker) marker.style.display = 'none';
    if (label) label.style.display = 'none';
    if (inlineEl) inlineEl.style.display = 'none';
    if (fillEl) fillEl.style.display = 'none';
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

  const { rate, predicted, hoursToReset, hoursDiff } = pred;
  const clampedPos = Math.min(predicted, 100);
  console.log(`[GaugePred:${id}] rate=${rate.toFixed(3)}/h, hoursDiff=${hoursDiff.toFixed(2)}h, predicted=${predicted.toFixed(1)}%`);

  // Minimal change or decreasing trend: show "stable"
  if (rate <= 0 || predicted - currentUtil < 3) {
    hide();
    if (id === '5h') setPredictHeadline(null);
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
  const predictText = predicted >= 100 ? '100%+' : `${Math.round(predicted)}%`;

  // Calculate estimated time to reach 100%
  let limitTimeStr = '';
  if (predicted >= 100 && rate > 0 && currentUtil < 100) {
    const hoursTo100 = (100 - currentUtil) / rate;
    const limitDate = new Date(Date.now() + hoursTo100 * 3600000);
    const mo = limitDate.getMonth() + 1, da = limitDate.getDate();
    const dayNames = getLang() === 'ko' ? ['일','월','화','수','목','금','토'] : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dayStr = dayNames[limitDate.getDay()];
    const hh = limitDate.getHours();
    limitTimeStr = getLang() === 'ko'
      ? `${mo}/${da}(${dayStr}) ${hh >= 12 ? '오후' : '오전'} ${hh % 12 || 12}시`
      : `${mo}/${da}(${dayStr}) ${hh % 12 || 12}${hh >= 12 ? 'PM' : 'AM'}`;
  }

  // Headline: surface the limit-reached forecast prominently (only when we
  // actually project hitting 100%); otherwise keep the strip clean.
  if (id === '5h') {
    setPredictHeadline(limitTimeStr ? t('predict_headline_limit', limitTimeStr) : null,
      limitTimeStr ? 'is-alert' : undefined);
  }

  // (A) Header inline prediction: "▸ 78%" or "▸ 4/12 2PM" badge
  if (inlineEl) {
    inlineEl.style.display = 'inline';
    inlineEl.style.color = predicted >= 80 ? '#fff' : color;
    inlineEl.style.background = predicted >= 80 ? color : `${color}${_isDark() ? '30' : '18'}`;
    inlineEl.textContent = `\u25b8 ${predictText}`;
    const obsTime = hoursDiff < 1 ? `${Math.round(hoursDiff * 60)}${t('min')}` : `${hoursDiff.toFixed(1)}${t('hours_short')}`;
    const resetTime2 = hoursToReset < 1 ? `${Math.round(hoursToReset * 60)}${t('min')}` : `${hoursToReset.toFixed(1)}${t('hours_short')}`;
    const tipLine3 = limitTimeStr ? t('predict_limit_at', limitTimeStr) : t('predict_tip_line3', predictText);
    inlineEl.title = t('predict_tip_line1', obsTime, rate.toFixed(1)) + '\n' + t('predict_tip_line2', resetTime2) + '\n→ ' + tipLine3;
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
    '<div class="gauge-sub" id="gauge-5h-reset"></div></div>' +
    '<div class="gauge-row" id="gauge-row-7d"><div class="gauge-header">' +
    '<span class="gauge-label">' + t('usage_7d') + '</span>' +
    '<span class="gauge-value" id="gauge-7d-value" style="color:var(--accent)">-</span>' +
    '<span class="gauge-predict-inline" id="gauge-7d-predict-inline" style="display:none"></span></div>' +
    '<div class="gauge-bar"><div id="gauge-7d-fill" class="gauge-fill" style="width:0;background:#7c3aed"></div>' +
    '<div id="gauge-7d-predict-fill" class="gauge-predict-fill" style="display:none"></div>' +
    '<div id="gauge-7d-predict" class="gauge-predict" style="display:none"></div>' +
    '<span id="gauge-7d-predict-label" class="gauge-predict-label" style="display:none"></span></div>' +
    '<div class="gauge-sub" id="gauge-7d-reset"></div></div>';
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
