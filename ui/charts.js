// Chart rendering + 5h/7d tab state for the popup, extracted from popup.js (refactor/popup-charts).
// Self-contained: no shared popup mutable state. Pure helpers come from ui/util.js;
// i18n `t` is referenced as a global (i18n.js, a classic script that loads first).
import {
  _isDark, _cGrid, _cLabel, _cTick, gaugeColor, planToMultiplier,
  buildPlanLimitLines, chartMaxY,
} from './util.js';
import { windowForecast } from './prediction.js';

// === Chart tab state ===
let _activeChartTab = '5h';
let _chartRollIntervalId = null;
let _chartAutoRoll = true; // Default: auto-rolling enabled
let _no5hMode = false; // True when the current org has no 5h window (e.g. ChatGPT): 5h tab/pane hidden, pinned to 7d
let _yFixed = false; // Default: auto-scale y-axis to data (shows over-100% spikes)
let _lastDraw = null; // Last drawCharts args, cached so the y-axis toggle can re-render

export function _switchChartTab(target) {
  if (target === _activeChartTab) return;
  // No 5h window (ChatGPT): the 5h tab is hidden, so never switch to it — this also
  // makes the auto-roll a no-op (it stays on 7d) without needing to stop the timer.
  if (target === '5h' && _no5hMode) return;
  // Don't switch 5h/7d when Enterprise spending chart is displayed
  const spendPane = document.getElementById('chart-pane-spend');
  if (spendPane && spendPane.style.display !== 'none') return;
  _activeChartTab = target;
  // Scope to the real 5h/7d tabs — the auto-roll and Y-axis buttons ALSO carry
  // `.chart-tab` (popup.html) and own their own `.active` state, so a bare
  // `.chart-tab` selector would wrongly clear them on every tab switch.
  document.querySelectorAll('.chart-tab[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === target));
  document.getElementById('chart-pane-5h').style.display = target === '5h' ? '' : 'none';
  document.getElementById('chart-pane-7d').style.display = target === '7d' ? '' : 'none';
  _syncChartInfo();
}

export function _startChartAutoRoll() {
  if (_chartRollIntervalId) return;
  _chartRollIntervalId = setInterval(() => {
    _switchChartTab(_activeChartTab === '5h' ? '7d' : '5h');
  }, 5000);
}

export function _stopChartAutoRoll() {
  if (_chartRollIntervalId) { clearInterval(_chartRollIntervalId); _chartRollIntervalId = null; }
}

export function _toggleChartAutoRoll() {
  _chartAutoRoll = !_chartAutoRoll;
  const btn = document.getElementById('chart-autoroll-btn');
  if (_chartAutoRoll) {
    _startChartAutoRoll();
    if (btn) { btn.textContent = '⏸'; btn.classList.add('active'); }
  } else {
    _stopChartAutoRoll();
    if (btn) { btn.textContent = '🔄'; btn.classList.remove('active'); }
  }
  chrome.storage.local.set({ ct_chart_autoroll: _chartAutoRoll });
}

// Y-axis scale toggle: auto (data-driven, shows over-100%) ↔ fixed 100% (clean
// reference view, over-100% clipped). Mirrors the dashboard's Y축 100%/자동 toggle.
function _syncYAxisBtn() {
  const btn = document.getElementById('chart-yaxis-btn');
  if (!btn) return;
  // Label shows the CURRENT mode (same convention as the dashboard button).
  btn.textContent = _yFixed ? 'Y: 100%' : 'Y: auto';
  btn.classList.toggle('active', _yFixed);
}

export function _toggleChartYAxis() {
  _yFixed = !_yFixed;
  _syncYAxisBtn();
  chrome.storage.local.set({ ct_chart_yfixed: _yFixed });
  // Re-render with the last data so the new scale takes effect immediately.
  if (_lastDraw) drawCharts(_lastDraw.history, _lastDraw.plan, _lastDraw.snapshot);
}

// Load saved settings (only disable if explicitly set to false)
chrome.storage.local.get('ct_chart_autoroll', (r) => {
  if (r.ct_chart_autoroll === false) {
    _chartAutoRoll = false;
    const btn = document.getElementById('chart-autoroll-btn');
    if (btn) { btn.textContent = '🔄'; btn.classList.remove('active'); }
  } else {
    const btn = document.getElementById('chart-autoroll-btn');
    if (btn) { btn.textContent = '⏸'; btn.classList.add('active'); }
  }
});

// Load saved y-axis preference (only enable fixed if explicitly set to true).
// storage.get is async: if the first drawCharts already ran with the default
// (auto), re-render so the restored setting applies to the chart, not just the
// button — otherwise the button could read 100% while the chart stayed auto.
chrome.storage.local.get('ct_chart_yfixed', (r) => {
  _yFixed = r.ct_chart_yfixed === true;
  _syncYAxisBtn();
  if (_yFixed && _lastDraw) drawCharts(_lastDraw.history, _lastDraw.plan, _lastDraw.snapshot);
});

// Clean up timers on popup unload
window.addEventListener('unload', () => {
  _stopChartAutoRoll();
});

// Read-only accessors so popup.js can gate auto-roll without owning the state.
export function isChartAutoRoll() { return _chartAutoRoll; }
export function isChartRolling() { return _chartRollIntervalId != null; }

// === Charts (5h / 7d split + prediction line) ===
export function drawCharts(history, plan, snapshot) {
  // Cache args so the y-axis toggle can re-render without popup.js re-plumbing state.
  _lastDraw = { history, plan, snapshot };
  // Enterprise usage-based: spending summary instead of 5h/7d charts
  const isEnterprise = (plan || '').includes('Enterprise');
  const isUsageBasedEnt = isEnterprise && snapshot?.five_hour?.utilization == null && snapshot?.seven_day?.utilization == null;
  // No 5h window (ChatGPT): 5h null but 7d present. Set the module flag first so the
  // tab-switch guard / auto-roll respect it even on the early returns below.
  const no5h = snapshot?.five_hour?.utilization == null && snapshot?.seven_day?.utilization != null;
  _no5hMode = no5h;
  const chartSection = document.getElementById('chart-section');
  const tabsRow = chartSection?.querySelector('.chart-tabs')?.parentElement;

  if (isUsageBasedEnt) {
    const pane5h = document.getElementById('chart-pane-5h');
    const pane7d = document.getElementById('chart-pane-7d');
    const paneSpend = document.getElementById('chart-pane-spend');
    const placeholder = document.getElementById('chart-placeholder');
    if (pane5h) pane5h.style.display = 'none';
    if (pane7d) pane7d.style.display = 'none';
    if (tabsRow) tabsRow.style.display = 'none';

    // Filter spending history (only points with eu field)
    const spendHistory = history.filter(p => p.eu != null).sort((a, b) => a.t - b.t);

    if (spendHistory.length >= 2) {
      // Show spending chart
      if (placeholder) { placeholder.style.display = 'none'; placeholder.style.height = ''; }
      if (paneSpend) {
        paneSpend.style.display = '';
        // Force reflow
        void chartSection.offsetHeight;
      }

      const now = Date.now();
      const d = new Date(now);
      const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();

      drawSpendingChart({
        canvasId: 'chart-spend',
        infoId: 'chart-spend-info',
        sorted: spendHistory,
        now,
        monthStart,
        monthEnd,
      });

      // Sync active info
      const srcInfo = document.getElementById('chart-spend-info');
      const dstInfo = document.getElementById('chart-active-info');
      if (srcInfo && dstInfo) dstInfo.innerHTML = srcInfo.innerHTML;
    } else {
      // Insufficient spending data: static text fallback
      if (paneSpend) paneSpend.style.display = 'none';
      if (placeholder) {
        const eu = snapshot?.extra_usage;
        if (eu && eu.monthly_limit) {
          const usedDollars = Math.round((eu.used_credits || 0) / 100);
          const limitDollars = Math.round(eu.monthly_limit / 100);
          const pct = Math.min(Math.round((eu.used_credits || 0) / eu.monthly_limit * 100), 100);
          placeholder.style.display = '';
          placeholder.style.height = 'auto';
          placeholder.innerHTML = '<div style="text-align:center;padding:6px 0;color:var(--text-secondary);font-size:11px">'
            + '<div style="font-size:12px;font-weight:600;color:var(--accent);margin-bottom:2px">Enterprise Spending</div>'
            + '<div style="font-size:18px;font-weight:700;color:var(--text-primary)">$' + usedDollars + ' <span style="font-size:11px;color:var(--text-muted)">/ $' + limitDollars + '</span></div>'
            + '<div style="margin-top:2px;color:' + gaugeColor(pct) + ';font-weight:600;font-size:11px">' + pct + '% ' + t('chart_used') + '</div>'
            + '</div>';
        } else {
          placeholder.style.display = '';
          placeholder.style.height = 'auto';
          placeholder.innerHTML = '<div style="text-align:center;padding:6px 0;color:var(--text-secondary);font-size:11px">'
            + '<div style="font-size:12px;font-weight:600;color:var(--accent)">Enterprise</div>'
            + '<div style="margin-top:2px">' + t('enterprise_unlimited') + '</div></div>';
        }
      }
    }
    return;
  }

  // Regular/seat-based Enterprise: existing 5h/7d charts
  const paneSpendHide = document.getElementById('chart-pane-spend');
  if (paneSpendHide) paneSpendHide.style.display = 'none';
  if (tabsRow) tabsRow.style.display = '';
  // No-5h org (ChatGPT): hide the 5h tab button and pin the chart to 7d. Show the tab
  // again for 5h orgs so a prior no-5h org doesn't leave it hidden. Runs before the
  // early return below so the tab state is correct even without enough history to draw.
  const tab5hBtn = chartSection?.querySelector('.chart-tab[data-tab="5h"]');
  if (tab5hBtn) tab5hBtn.style.display = no5h ? 'none' : '';
  // Pin to 7d by reusing the tab-switch helper (handles active class + pane display
  // consistently). The `_switchChartTab('5h' && _no5hMode)` guard above blocks any
  // later roll back to the hidden 5h pane.
  if (no5h) _switchChartTab('7d');
  if (history.length < 2) return;

  const now = Date.now();
  // Provider determines the multiplier scale (ChatGPT/Gemini tiers differ from Claude)
  const provider = snapshot?.provider || 'claude';
  const currentMult = planToMultiplier(plan, provider);

  // Time-ordered but UNSCALED — this is what the gauges and the banner forecast from
  // (render.js passes _filteredHistory() straight through). The forecast MUST read the same
  // samples they do; feeding it the plan-normalized copy below would make the chart label
  // disagree with the gauge above it for anyone who changed plans inside the history window,
  // which is the exact bug this file was just changed to remove.
  const sortedRaw = history.slice().sort((a, b) => a.t - b.t);

  // Normalize past data to current plan scale, for DRAWING only
  // (e.g. Pro 80% -> Max 5x switch -> converted to 16%)
  const sorted = sortedRaw.map((pt) => {
    const entryMult = planToMultiplier(pt.p || plan, provider);
    if (entryMult === currentMult) return pt;
    const scale = entryMult / currentMult;
    return { t: pt.t, h5: pt.h5 != null ? pt.h5 * scale : null, d7: pt.d7 != null ? pt.d7 * scale : null, p: pt.p, r7: pt.r7 };
  });

  const reset5h = snapshot?.five_hour?.resets_at ? new Date(snapshot.five_hour.resets_at).getTime() : null;
  const reset7d = snapshot?.seven_day?.resets_at ? new Date(snapshot.seven_day.resets_at).getTime() : null;
  const last5h = sorted[sorted.length - 1].h5;
  const last7d = sorted[sorted.length - 1].d7;

  // THE forecast — tier, projected-at-reset and rate, all from ui/prediction.js. This file used
  // to run its OWN rate estimators here (a 2h flat window for 5h, a reset-boundary delta sum for
  // 7d) and draw the dotted future point from them, so the chart's projection, the chart's own
  // tier label and the gauge above could all disagree about the same window. Inputs come from the
  // snapshot and the UNSCALED history, exactly as the gauges use them: `sorted` below is
  // normalized to the current plan scale for DRAWING, and forecasting from that copy is what the
  // previous round had to undo.
  const fc5h = windowForecast(snapshot?.five_hour?.utilization ?? null, 'h5', snapshot?.five_hour?.resets_at, sortedRaw);
  const fc7d = windowForecast(snapshot?.seven_day?.utilization ?? null, 'd7', snapshot?.seven_day?.resets_at, sortedRaw);

  // Provider-aware guide lines shared by the 5h and 7d charts.
  const limitLines = buildPlanLimitLines(currentMult, provider);

  // Hide placeholder and show both panes (for correct canvas size calculation)
  const pane5h = document.getElementById('chart-pane-5h');
  const pane7d = document.getElementById('chart-pane-7d');
  const placeholder = document.getElementById('chart-placeholder');
  if (placeholder) { placeholder.style.display = 'none'; placeholder.style.height = ''; }
  if (pane5h) pane5h.style.display = '';
  if (pane7d) pane7d.style.display = '';
  // Force reflow — ensure canvas.clientWidth returns correctly after display change
  void chartSection.offsetHeight;

  // 5h chart (last 3 windows = 15 hours) — skipped for no-5h orgs (pane is hidden).
  if (!no5h) {
    const cutoff5h = now - 15 * 3600000;
    const sorted5h = sorted.filter((p) => p.t > cutoff5h);
    drawSingleChart({
      canvasId: 'chart-5h', infoId: 'chart-5h-info',
      sorted: sorted5h.length >= 2 ? sorted5h : sorted, key: 'h5', color: '#06b6d4',
      forecast: fc5h, lastVal: last5h, resetTime: reset5h,
      limitLines, now,
    });
  }

  // 7d chart (last 2 windows = 14 days)
  const cutoff7d = now - 14 * 86400000;
  const sorted7d = sorted.filter((p) => p.t > cutoff7d);
  drawSingleChart({
    canvasId: 'chart-7d', infoId: 'chart-7d-info',
    sorted: sorted7d.length >= 2 ? sorted7d : sorted, key: 'd7', color: '#7c3aed',
    forecast: fc7d, lastVal: last7d, resetTime: reset7d,
    limitLines, now,
  });

  // Hide inactive pane
  if (pane5h) pane5h.style.display = _activeChartTab === '5h' ? '' : 'none';
  if (pane7d) pane7d.style.display = _activeChartTab === '7d' ? '' : 'none';
  _syncChartInfo();
}

function _syncChartInfo() {
  const src = document.getElementById('chart-' + _activeChartTab + '-info');
  const dst = document.getElementById('chart-active-info');
  if (src && dst) dst.innerHTML = src.innerHTML;
}

function drawSingleChart(opts) {
  const { canvasId, infoId, sorted, key, color, forecast, lastVal, resetTime, limitLines, now } = opts;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const vals = sorted.map((p) => p[key]).filter((v) => v !== null);
  if (vals.length < 2) return;

  // Budget pace line fallback interval (used when no previous reset in first segment)
  const budgetInterval = key === 'h5' ? 5 * 3600000 : 7 * 86400000;

  const oldest = sorted[0].t;
  const spanMs = now - oldest;

  // Prediction
  const futureEnd = (resetTime && resetTime > now + 60000) ? resetTime : now;
  const hasFuture = futureEnd > now + 60000;
  const totalSpan = futureEnd - oldest;

  // The dotted future point IS the shared forecast \u2014 the same number the tier label beside it is
  // derived from. Drawn only when there is a forecast: with none, an invented point would be the
  // chart asserting something nobody computed.
  //
  // It is NOT always the number the GAUGE shows, and this comment used to claim it was. The gauge
  // renders only a MEASURED forecast and shows "collecting" when there is none, while
  // windowForecast() also returns the degraded window-average. On a thin-history account the
  // chart plots a point the gauge above is declining to state. Real gap, tracked separately.
  const predicted = forecast ? forecast.predicted : null;
  let predict = null;
  if (hasFuture && lastVal !== null && predicted != null) {
    predict = { x: (resetTime - oldest) / totalSpan, v: Math.min(Math.max(predicted, 0), 100) };
  }

  // Info label (stored in hidden span, copied to active tab via _syncChartInfo)
  // Show the tier (same ladder + forecast as the gauges and the banner) + rate side by side
  const infoEl = document.getElementById(infoId);
  const paceTier = forecast ? forecast.tier : null;
  const paceColors = { green: '#22c55e', yellow: '#f59e0b', orange: '#f97316', red: '#ef4444', darkred: '#dc2626' };
  const paceCss = paceTier ? paceColors[paceTier.css] : '#9ca3af';
  const paceLabel = paceTier ? t('chart_pace_' + paceTier.id) : t('chart_stable');

  // Rate portion: rising/falling/stagnant. Null on the degraded path (no measured rate exists),
  // where showing a number would dress up an assumption as a measurement.
  const rate = forecast ? forecast.rate : null;
  let ratePart = '';
  if (rate != null && rate > 0.1) {
    const rateStr = rate >= 10 ? Math.round(rate) : rate.toFixed(1);
    ratePart = ` <span style="color:#9ca3af;font-size:0.85em">\u2191${rateStr}%/h</span>`;
  } else if (rate != null && rate < -0.1) {
    const rateStr = Math.abs(rate) >= 10 ? Math.round(Math.abs(rate)) : Math.abs(rate).toFixed(1);
    ratePart = ` <span style="color:#9ca3af;font-size:0.85em">\u2193${rateStr}%/h</span>`;
  }

  infoEl.innerHTML = `<span style="color:${paceCss}">${paceLabel}</span>${ratePart}`;

  // Data (normalized) — timestamps preserved for gap detection
  const data = sorted.map((p) => ({ x: (p.t - oldest) / totalSpan, v: p[key], t: p.t }));
  const nowX = (now - oldest) / totalSpan;

  // Y-axis — dynamic scale based on data (prevent budget/limit from inflating y-axis)
  const allVals = vals.slice();
  if (predict) allVals.push(predict.v);
  const dataMax = Math.max(...allVals, 10);
  // Always retain the nearest lower-plan boundary and the user's own 100% ceiling; other guides
  // stay opportunistic. The ceiling is still subject to the `value > maxY` skip in the badge loop
  // below, so on a low-usage chart it simply sits off-axis rather than flattening the data.
  const visibleLimits = limitLines.filter((l) =>
    l.isImmediateLower || l.isCurrentPlan || (l.value <= dataMax * 3 && l.value >= dataMax * 0.25)
  );
  // Auto mode normally follows the data, but includes the nearest lower-plan line.
  // Fixed mode pins the axis at 100% (over-100% data is clipped by the canvas clip);
  // auto mode scales to the data with 15% headroom (default, shows over-100% spikes).
  const maxY = chartMaxY(dataMax, _yFixed, limitLines);

  // Canvas
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad = { top: 4, bottom: 12, left: 0, right: 0 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;

  function toX(xN) { return pad.left + xN * cw; }
  function toY(v) { return pad.top + ch - (v / maxY) * ch; }

  // Future range background
  if (hasFuture) {
    ctx.fillStyle = _isDark() ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.03)';
    ctx.fillRect(toX(nowX), pad.top, toX(1) - toX(nowX), ch);
  }

  // Grid — dynamic interval (matched to y-axis scale)
  ctx.strokeStyle = _cGrid(); ctx.lineWidth = 0.5;
  const gridStep = maxY <= 15 ? 5 : maxY <= 30 ? 10 : maxY <= 60 ? 15 : 25;
  for (let gpct = gridStep; gpct < maxY; gpct += gridStep) {
    const gy = toY(gpct);
    ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(w - pad.right, gy); ctx.stroke();
    ctx.fillStyle = _cLabel(); ctx.font = '7px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(gpct + '%', w - pad.right - 2, gy - 2);
  }

  // Chart area clipping (budget/limit may exceed y-axis bounds)
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.left, pad.top, cw, ch);
  ctx.clip();

  // Reset vertical lines + Budget pace line (based on even consumption)
  // Detect actual reset points: where utilization drops sharply (same as dashboard findObservedResets)
  const observedResets = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1][key], cur = sorted[i][key];
    if (prev !== null && cur !== null && prev > 3 && cur <= 1) {
      observedResets.push(sorted[i].t);
    }
  }
  // All reset points (for vertical line display)
  const allResetPoints = [...observedResets];
  if (resetTime && resetTime > now) allResetPoints.push(resetTime);

  if (allResetPoints.length > 0) {
    // Draw reset vertical lines (gray — both past and future)
    ctx.strokeStyle = _cLabel(); ctx.lineWidth = 0.5; ctx.setLineDash([3, 3]);
    for (const rpt of allResetPoints) {
      if (rpt >= oldest && rpt <= futureEnd) {
        const rx = (rpt - oldest) / totalSpan;
        ctx.beginPath(); ctx.moveTo(toX(rx), pad.top); ctx.lineTo(toX(rx), pad.top + ch); ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    // Budget pace line — only show current window (last reset to next reset)
    if (resetTime && resetTime > now) {
      const lastObserved = observedResets.length > 0 ? observedResets[observedResets.length - 1] : null;
      const wEnd = resetTime;
      const wStart = lastObserved || wEnd - budgetInterval;
      const windowLen = wEnd - wStart;
      if (windowLen > 0) {
        const segStart = Math.max(wStart, oldest);
        const segEnd = Math.min(wEnd, futureEnd);
        if (segEnd > segStart) {
          ctx.strokeStyle = '#c4b5fd'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
          const sx0 = (segStart - oldest) / totalSpan;
          const sx1 = (segEnd - oldest) / totalSpan;
          const sv0 = ((segStart - wStart) / windowLen) * 100;
          const sv1 = ((segEnd - wStart) / windowLen) * 100;
          ctx.beginPath(); ctx.moveTo(toX(sx0), toY(sv0)); ctx.lineTo(toX(sx1), toY(sv1)); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  }

  // Release clipping
  ctx.restore();

  // Clip the past-data pass to the chart box: when the y-axis is pinned to 100%
  // (fixed mode) an over-100% value maps above pad.top, so without this clip the
  // line/area/dot would draw outside the plot area. (The earlier reset/budget clip
  // was already released above.) Prediction is drawn AFTER the matching restore
  // below because predict.v is capped at 100, so its dot/label never escape.
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.left, pad.top, cw, ch);
  ctx.clip();

  // Solid line (past data) — break line at collection gap intervals
  const valid = data.filter((d) => d.v !== null);
  const GAP_MS = 25 * 60000; // Gap if interval >= 25 min (collection cycle 10min x 2.5)
  if (valid.length >= 2) {
    // Split into continuous segments
    const segments = [];
    let seg = [valid[0]];
    for (let i = 1; i < valid.length; i++) {
      if (valid[i].t - valid[i - 1].t > GAP_MS) {
        segments.push(seg);
        seg = [];
      }
      seg.push(valid[i]);
    }
    segments.push(seg);

    const dk = _isDark();
    const alphaColor = color === '#06b6d4'
      ? (dk ? 'rgba(6,182,212,.15)' : 'rgba(6,182,212,.08)')
      : (dk ? 'rgba(124,58,237,.15)' : 'rgba(124,58,237,.08)');

    // Draw line + area for each segment
    for (const seg of segments) {
      if (seg.length < 2) continue;
      // Line
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
      seg.forEach((d, i) => { i === 0 ? ctx.moveTo(toX(d.x), toY(d.v)) : ctx.lineTo(toX(d.x), toY(d.v)); });
      ctx.stroke();
      // Area
      ctx.lineTo(toX(seg[seg.length - 1].x), pad.top + ch);
      ctx.lineTo(toX(seg[0].x), pad.top + ch);
      ctx.closePath(); ctx.fillStyle = alphaColor; ctx.fill();
    }

    // Show gap intervals (dashed line)
    if (segments.length > 1) {
      ctx.strokeStyle = _cLabel(); ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      for (let i = 0; i < segments.length - 1; i++) {
        const endPt = segments[i][segments[i].length - 1];
        const startPt = segments[i + 1][0];
        ctx.beginPath();
        ctx.moveTo(toX(endPt.x), toY(endPt.v));
        ctx.lineTo(toX(startPt.x), toY(startPt.v));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Current dot
    const lastV = valid[valid.length - 1];
    ctx.beginPath(); ctx.arc(toX(lastV.x), toY(lastV.v), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
  }

  // Release the past-data clip (prediction below stays unclipped: predict.v ≤ 100).
  ctx.restore();

  // Prediction dashed line
  if (predict && lastVal !== null) {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.moveTo(toX(nowX), toY(lastVal)); ctx.lineTo(toX(predict.x), toY(predict.v));
    ctx.stroke(); ctx.setLineDash([]);
    // Prediction end dot + filled badge — a solid pill keeps the % legible over the
    // dashed line and gridlines (plain text got lost in the busy top-right corner).
    const pColor = predict.v >= 80 ? '#ef4444' : color;
    const _pdX = toX(predict.x), _pdY = toY(predict.v);
    ctx.beginPath(); ctx.arc(_pdX, _pdY, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = pColor; ctx.fill();

    const _pLabel = `${Math.round(predict.v)}%`;
    ctx.font = 'bold 8px sans-serif';
    const _bPadX = 3.5, _bH = 13, _bR = 3;
    const _bW = ctx.measureText(_pLabel).width + _bPadX * 2;
    // Center over the dot, then clamp inside the plot so it never clips the edge.
    let _bx = Math.max(pad.left, Math.min(_pdX - _bW / 2, w - pad.right - _bW));
    // Above the dot by default; flip below if it would collide with the top.
    let _by = _pdY - _bH - 5;
    if (_by < pad.top) _by = _pdY + 5;
    ctx.beginPath();
    ctx.moveTo(_bx + _bR, _by);
    ctx.arcTo(_bx + _bW, _by, _bx + _bW, _by + _bR, _bR);
    ctx.arcTo(_bx + _bW, _by + _bH, _bx + _bW - _bR, _by + _bH, _bR);
    ctx.arcTo(_bx, _by + _bH, _bx, _by + _bH - _bR, _bR);
    ctx.arcTo(_bx, _by, _bx + _bR, _by, _bR);
    ctx.closePath();
    ctx.fillStyle = pColor; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(_pLabel, _bx + _bW / 2, _by + _bH / 2 + 0.5);
    ctx.textBaseline = 'alphabetic';
  }

  // "Now" vertical line
  if (hasFuture) {
    ctx.beginPath(); ctx.strokeStyle = _cLabel(); ctx.lineWidth = 0.5; ctx.setLineDash([2, 2]);
    ctx.moveTo(toX(nowX), pad.top); ctx.lineTo(toX(nowX), pad.top + ch);
    ctx.stroke(); ctx.setLineDash([]);
  }

  // X-axis labels (absolute time + intermediate ticks)
  ctx.font = '7px sans-serif';
  var fmtTime = function(ts) {
    var d = new Date(ts);
    var hh = d.getHours(), mm = d.getMinutes();
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  };
  var fmtDate = function(ts) { var d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate(); };
  // 7d spans multiple days → label edges/resets by date (time is noise); 5h → by time.
  var totalH = totalSpan / 3600000;
  var is7d = totalH > 24;
  var fmtEdge = is7d ? fmtDate : fmtTime;

  // Collect label candidates: { xN, label, priority, color }
  // priority: 0=reset, 1=now, 2=start/end, 3=intermediate tick
  var xLabels = [];

  // Start point
  xLabels.push({ xN: 0, label: fmtEdge(oldest), priority: 2, color: _cTick() });

  // now
  if (hasFuture) {
    xLabels.push({ xN: nowX, label: t('chart_now'), priority: 1, color: '#6b7280' });
  }

  // Reset point labels (using actually detected reset points)
  for (var _ri = 0; _ri < allResetPoints.length; _ri++) {
    var _rp = allResetPoints[_ri];
    if (_rp >= oldest && _rp <= futureEnd) {
      var _rx = (_rp - oldest) / totalSpan;
      xLabels.push({ xN: _rx, label: fmtEdge(_rp), priority: 0, color: _cTick() });
    }
  }

  // End point (reset time if prediction exists, otherwise now)
  if (hasFuture) {
    xLabels.push({ xN: 1, label: fmtEdge(futureEnd), priority: 2, color: color });
  } else {
    xLabels.push({ xN: 1, label: t('chart_now'), priority: 2, color: _cTick() });
  }

  // Intermediate ticks: date-based for 7d, hour-based for 5h
  if (is7d) {
    // 7d: date (M/D) ticks — based on daily midnight
    var dayStart = new Date(oldest);
    dayStart.setHours(0, 0, 0, 0);
    dayStart = dayStart.getTime() + 86400000;
    for (var dk = dayStart; dk < oldest + totalSpan; dk += 86400000) {
      if (dk <= oldest || dk >= oldest + totalSpan) continue;
      var dkX = (dk - oldest) / totalSpan;
      xLabels.push({ xN: dkX, label: fmtDate(dk), priority: 3, color: _cTick() });
    }
  } else {
    // 5h: time (HH:MM) ticks
    var tickInterval = totalH <= 6 ? 1 : totalH <= 12 ? 2 : 3;
    var firstTick = new Date(oldest);
    firstTick.setMinutes(0, 0, 0);
    firstTick = firstTick.getTime() + tickInterval * 3600000;
    for (var tk = firstTick; tk < oldest + totalSpan; tk += tickInterval * 3600000) {
      if (tk <= oldest || tk >= oldest + totalSpan) continue;
      var tkX = (tk - oldest) / totalSpan;
      xLabels.push({ xN: tkX, label: fmtTime(tk), priority: 3, color: _cTick() });
    }
  }

  // Remove overlaps: lower priority first, remove higher priority if pixel distance <= 20px
  xLabels.sort(function(a, b) { return a.priority - b.priority || a.xN - b.xN; });
  var placed = [];
  for (var li = 0; li < xLabels.length; li++) {
    var lbl = xLabels[li];
    var px = toX(lbl.xN);
    var overlaps = false;
    for (var pi = 0; pi < placed.length; pi++) {
      if (Math.abs(px - placed[pi]) < 22) { overlaps = true; break; }
    }
    if (!overlaps) {
      placed.push(px);
      ctx.fillStyle = lbl.color;
      ctx.textAlign = lbl.xN < 0.05 ? 'left' : lbl.xN > 0.95 ? 'right' : 'center';
      ctx.fillText(lbl.label, px, h - 2);
    }
  }

  // Plan limit lines + badges (on top — above chart lines)
  const badgeFont = 'bold 9px sans-serif';
  const badgeH = 13, badgePadX = 4, badgeR = 2, arrowW = 4;
  const badgePositions = [];
  for (const line of visibleLimits) {
    if (line.value > maxY) continue;
    const ly = toY(line.value);
    ctx.font = badgeFont;
    const tw = ctx.measureText(line.label).width;
    const bw = tw + badgePadX * 2;
    const bx = pad.left;
    let by = ly - badgeH / 2;
    by = Math.max(pad.top, Math.min(by, pad.top + ch - badgeH));
    for (const prev of badgePositions) {
      if (Math.abs(by - prev) < badgeH + 2) by = prev - badgeH - 2;
    }
    by = Math.max(pad.top, by);
    badgePositions.push(by);
    // Dashed line (from badge right edge)
    ctx.beginPath(); ctx.strokeStyle = line.color; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.moveTo(bx + bw + arrowW + 1, ly); ctx.lineTo(w - pad.right, ly);
    ctx.stroke(); ctx.setLineDash([]);
    // Badge + right arrow
    ctx.fillStyle = line.color;
    ctx.beginPath();
    ctx.moveTo(bx + badgeR, by);
    ctx.arcTo(bx, by, bx, by + badgeR, badgeR);
    ctx.lineTo(bx, by + badgeH - badgeR);
    ctx.arcTo(bx, by + badgeH, bx + badgeR, by + badgeH, badgeR);
    ctx.lineTo(bx + bw, by + badgeH);
    ctx.lineTo(bx + bw, by + badgeH / 2 + 3);
    ctx.lineTo(bx + bw + arrowW, ly);
    ctx.lineTo(bx + bw, by + badgeH / 2 - 3);
    ctx.lineTo(bx + bw, by);
    ctx.closePath();
    ctx.fill();
    // White text
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
    ctx.fillText(line.label, bx + bw / 2, by + badgeH - 3.5);
  }
}

// === Enterprise Spending Chart ===
function drawSpendingChart(opts) {
  const { canvasId, infoId, sorted, now, monthStart, monthEnd } = opts;
  const canvas = document.getElementById(canvasId);
  if (!canvas || sorted.length < 2) return;

  // Dollar conversion + normalization
  const totalSpan = monthEnd - monthStart;
  const data = sorted.map(p => ({
    x: (p.t - monthStart) / totalSpan,
    v: (p.eu || 0) / 100,   // cents → dollars
    cap: (p.el || 0) / 100, // cents → dollars
    t: p.t,
  }));
  const nowX = (now - monthStart) / totalSpan;
  const currentSpend = data[data.length - 1].v;
  const currentCap = data[data.length - 1].cap;

  // Detect cap changes (for step function)
  const capChanges = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i].cap !== data[i - 1].cap && data[i - 1].cap > 0) {
      capChanges.push({ x: data[i].x, t: data[i].t, oldCap: data[i - 1].cap, newCap: data[i].cap });
    }
  }

  // Prediction: spending rate over last 24h
  const recent24h = sorted.filter(p => p.t > now - 24 * 3600000 && p.eu != null);
  let spendRate = 0; // dollars per hour
  if (recent24h.length >= 2) {
    const first = recent24h[0], last = recent24h[recent24h.length - 1];
    const hours = (last.t - first.t) / 3600000;
    if (hours > 0.5) {
      spendRate = ((last.eu - first.eu) / 100) / hours;
    }
  }
  const hoursToEnd = Math.max((monthEnd - now) / 3600000, 0);
  const predictedSpend = currentSpend + spendRate * hoursToEnd;
  const hasFuture = monthEnd > now + 60000;

  // Info label
  const infoEl = document.getElementById(infoId);
  if (infoEl) {
    if (spendRate > 0.01 && hasFuture) {
      const pColor = currentCap > 0 && predictedSpend >= currentCap * 0.8 ? '#ef4444' : '#f59e0b';
      infoEl.innerHTML = `<span style="color:${pColor}">$${Math.round(predictedSpend)} est.</span>`;
    } else {
      infoEl.innerHTML = `<span style="color:#9ca3af">\u2014 ${t('chart_stable')}</span>`;
    }
  }

  // Y-axis range — data-based (cap excluded, shown as label if out of view)
  const allVals = data.map(d => d.v);
  if (predictedSpend > 0) allVals.push(predictedSpend);
  const dataMax = Math.max(...allVals, 10);
  const maxY = dataMax * 1.15;
  const capOutOfView = currentCap > 0 && currentCap > maxY;

  // Canvas setup
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad = { top: 4, bottom: 12, left: 0, right: 0 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;

  function toX(xN) { return pad.left + xN * cw; }
  function toY(v) { return pad.top + ch - (v / maxY) * ch; }

  // Future range background
  if (hasFuture) {
    ctx.fillStyle = _isDark() ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.03)';
    ctx.fillRect(toX(nowX), pad.top, toX(1) - toX(nowX), ch);
  }

  // Grid — dollar units
  ctx.strokeStyle = _cGrid(); ctx.lineWidth = 0.5;
  const gridStep = maxY <= 20 ? 5 : maxY <= 50 ? 10 : maxY <= 100 ? 25 : maxY <= 250 ? 50 : maxY <= 600 ? 100 : 250;
  for (let gv = gridStep; gv < maxY; gv += gridStep) {
    const gy = toY(gv);
    ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(w - pad.right, gy); ctx.stroke();
    ctx.fillStyle = _cLabel(); ctx.font = '7px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('$' + gv, w - pad.right - 2, gy - 2);
  }

  // Clipping
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.left, pad.top, cw, ch);
  ctx.clip();

  // Cap line (red dashed, step function)
  if (currentCap > 0) {
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    if (capChanges.length === 0) {
      // Single cap — full horizontal line
      const cy = toY(currentCap);
      ctx.beginPath(); ctx.moveTo(pad.left, cy); ctx.lineTo(w - pad.right, cy); ctx.stroke();
    } else {
      // Step function: horizontal line per segment
      ctx.beginPath();
      let prevCap = data[0].cap;
      let prevX = 0;
      for (const change of capChanges) {
        if (prevCap > 0) {
          ctx.moveTo(toX(prevX), toY(prevCap));
          ctx.lineTo(toX(change.x), toY(prevCap));
          // Vertical connection
          ctx.lineTo(toX(change.x), toY(change.newCap));
        }
        prevCap = change.newCap;
        prevX = change.x;
      }
      // Last segment
      ctx.moveTo(toX(prevX), toY(currentCap));
      ctx.lineTo(w - pad.right, toY(currentCap));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Budget Pace line (purple dashed: $0 at month start -> $cap at month end)
  if (currentCap > 0 && hasFuture) {
    ctx.strokeStyle = '#c4b5fd'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
    // If cap changed, calculate from the last change point
    if (capChanges.length > 0) {
      const lastChange = capChanges[capChanges.length - 1];
      // Find actual usage at the change point
      const changeIdx = data.findIndex(d => d.t >= lastChange.t);
      const changeSpend = changeIdx >= 0 ? data[changeIdx].v : 0;
      ctx.beginPath();
      ctx.moveTo(toX(lastChange.x), toY(changeSpend));
      ctx.lineTo(toX(1), toY(currentCap));
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(toX(0), toY(0));
      ctx.lineTo(toX(1), toY(currentCap));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Release clipping
  ctx.restore();

  // Show triangle label at top if cap is outside Y-axis
  if (capOutOfView) {
    ctx.font = 'bold 7px sans-serif'; ctx.textAlign = 'right';
    ctx.fillStyle = '#ef4444';
    ctx.fillText('▲ Cap $' + Math.round(currentCap), w - pad.right - 2, pad.top + 8);
  }

  // Solid line (spending data) — includes gap detection
  const valid = data.filter(d => d.v !== null && d.v !== undefined);
  const GAP_MS = 25 * 60000;
  if (valid.length >= 2) {
    const segments = [];
    let seg = [valid[0]];
    for (let i = 1; i < valid.length; i++) {
      if (valid[i].t - valid[i - 1].t > GAP_MS) {
        segments.push(seg);
        seg = [];
      }
      seg.push(valid[i]);
    }
    segments.push(seg);

    const spendColor = '#f59e0b';
    const alphaColor = 'rgba(249,115,22,.08)';

    for (const seg of segments) {
      if (seg.length < 2) continue;
      ctx.beginPath(); ctx.strokeStyle = spendColor; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
      seg.forEach((d, i) => { i === 0 ? ctx.moveTo(toX(d.x), toY(d.v)) : ctx.lineTo(toX(d.x), toY(d.v)); });
      ctx.stroke();
      ctx.lineTo(toX(seg[seg.length - 1].x), pad.top + ch);
      ctx.lineTo(toX(seg[0].x), pad.top + ch);
      ctx.closePath(); ctx.fillStyle = alphaColor; ctx.fill();
    }

    // Show gaps
    if (segments.length > 1) {
      ctx.strokeStyle = _cLabel(); ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      for (let i = 0; i < segments.length - 1; i++) {
        const endPt = segments[i][segments[i].length - 1];
        const startPt = segments[i + 1][0];
        ctx.beginPath();
        ctx.moveTo(toX(endPt.x), toY(endPt.v));
        ctx.lineTo(toX(startPt.x), toY(startPt.v));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Current dot
    const lastV = valid[valid.length - 1];
    ctx.beginPath(); ctx.arc(toX(lastV.x), toY(lastV.v), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = spendColor; ctx.fill();
  }

  // Prediction dashed line
  if (hasFuture && spendRate > 0.01 && currentSpend > 0) {
    const predX = 1; // End of month
    const predV = Math.min(predictedSpend, maxY);
    const pColor = currentCap > 0 && predictedSpend >= currentCap * 0.8 ? '#ef4444' : '#f59e0b';
    ctx.beginPath(); ctx.strokeStyle = pColor; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.moveTo(toX(nowX), toY(currentSpend));
    ctx.lineTo(toX(predX), toY(predV));
    ctx.stroke(); ctx.setLineDash([]);
    // Prediction end dot + label
    ctx.beginPath(); ctx.arc(toX(predX), toY(predV), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = pColor; ctx.fill();
    ctx.font = 'bold 7px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('$' + Math.round(predictedSpend), toX(predX), toY(predV) - 4);
  }

  // "Now" vertical line
  if (hasFuture) {
    ctx.beginPath(); ctx.strokeStyle = _cLabel(); ctx.lineWidth = 0.5; ctx.setLineDash([2, 2]);
    ctx.moveTo(toX(nowX), pad.top); ctx.lineTo(toX(nowX), pad.top + ch);
    ctx.stroke(); ctx.setLineDash([]);
  }

  // X-axis labels: month start, now, month end
  ctx.font = '7px sans-serif';
  const fmtDate = (ts) => { const d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate(); };
  const xLabels = [];
  xLabels.push({ xN: 0, label: fmtDate(monthStart), priority: 2, color: '#9ca3af' });
  if (hasFuture) {
    xLabels.push({ xN: nowX, label: t('chart_now'), priority: 1, color: '#6b7280' });
  }
  xLabels.push({ xN: 1, label: fmtDate(monthEnd), priority: 0, color: '#f59e0b' });
  // Intermediate date ticks
  let dayStart = new Date(monthStart);
  dayStart.setHours(0, 0, 0, 0);
  dayStart = dayStart.getTime() + 86400000;
  const dayInterval = totalSpan > 20 * 86400000 ? 5 : totalSpan > 10 * 86400000 ? 3 : 2;
  for (let dk = dayStart, dayCount = 1; dk < monthEnd; dk += 86400000, dayCount++) {
    if (dk <= monthStart || dk >= monthEnd) continue;
    if (dayCount % dayInterval !== 0) continue;
    const dkX = (dk - monthStart) / totalSpan;
    xLabels.push({ xN: dkX, label: fmtDate(dk), priority: 3, color: _cTick() });
  }

  // Remove overlaps
  xLabels.sort((a, b) => a.priority - b.priority || a.xN - b.xN);
  const placed = [];
  for (const lbl of xLabels) {
    const px = toX(lbl.xN);
    if (placed.some(p => Math.abs(px - p) < 22)) continue;
    placed.push(px);
    ctx.fillStyle = lbl.color;
    ctx.textAlign = lbl.xN < 0.05 ? 'left' : lbl.xN > 0.95 ? 'right' : 'center';
    ctx.fillText(lbl.label, px, h - 2);
  }

  // Cap badge (left side)
  if (currentCap > 0) {
    const badgeFont = 'bold 9px sans-serif';
    const badgeH = 13, badgePadX = 4, badgeR = 2, arrowW = 4;
    const capLabel = '$' + Math.round(currentCap);
    ctx.font = badgeFont;
    const tw = ctx.measureText(capLabel).width;
    const bw = tw + badgePadX * 2;
    const bx = pad.left;
    const ly = toY(currentCap);
    let by = Math.max(pad.top, Math.min(ly - badgeH / 2, pad.top + ch - badgeH));
    // Badge background
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.moveTo(bx + badgeR, by);
    ctx.arcTo(bx, by, bx, by + badgeR, badgeR);
    ctx.lineTo(bx, by + badgeH - badgeR);
    ctx.arcTo(bx, by + badgeH, bx + badgeR, by + badgeH, badgeR);
    ctx.lineTo(bx + bw, by + badgeH);
    ctx.lineTo(bx + bw, by + badgeH / 2 + 3);
    ctx.lineTo(bx + bw + arrowW, ly);
    ctx.lineTo(bx + bw, by + badgeH / 2 - 3);
    ctx.lineTo(bx + bw, by);
    ctx.closePath();
    ctx.fill();
    // White text
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
    ctx.fillText(capLabel, bx + bw / 2, by + badgeH - 3.5);
  }
}
