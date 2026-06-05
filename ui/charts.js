// Chart rendering + 5h/7d tab state for the popup, extracted from popup.js (refactor/popup-charts).
// Self-contained: no shared popup mutable state. Pure helpers come from ui/util.js;
// i18n `t` is referenced as a global (i18n.js, a classic script that loads first).
import { _isDark, _cGrid, _cLabel, gaugeColor, planToMultiplier, calcPaceTier } from './util.js';

// === Chart tab state ===
let _activeChartTab = '5h';
let _chartRollIntervalId = null;
let _chartAutoRoll = true; // Default: auto-rolling enabled

export function _switchChartTab(target) {
  if (target === _activeChartTab) return;
  // Don't switch 5h/7d when Enterprise spending chart is displayed
  const spendPane = document.getElementById('chart-pane-spend');
  if (spendPane && spendPane.style.display !== 'none') return;
  _activeChartTab = target;
  document.querySelectorAll('.chart-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === target));
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

// Clean up timers on popup unload
window.addEventListener('unload', () => {
  _stopChartAutoRoll();
});

// Read-only accessors so popup.js can gate auto-roll without owning the state.
export function isChartAutoRoll() { return _chartAutoRoll; }
export function isChartRolling() { return _chartRollIntervalId != null; }

// === Charts (5h / 7d split + prediction line) ===
export function drawCharts(history, plan, snapshot) {
  // Enterprise usage-based: spending summary instead of 5h/7d charts
  const isEnterprise = (plan || '').includes('Enterprise');
  const isUsageBasedEnt = isEnterprise && snapshot?.five_hour?.utilization == null && snapshot?.seven_day?.utilization == null;
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
  if (history.length < 2) return;

  const now = Date.now();
  const currentMult = planToMultiplier(plan);

  // Normalize past data to current plan scale
  // (e.g. Pro 80% -> Max 5x switch -> converted to 16%)
  const sorted = history.slice().sort((a, b) => a.t - b.t).map((pt) => {
    const entryMult = planToMultiplier(pt.p || plan);
    if (entryMult === currentMult) return pt;
    const scale = entryMult / currentMult;
    return { t: pt.t, h5: pt.h5 != null ? pt.h5 * scale : null, d7: pt.d7 != null ? pt.d7 * scale : null, p: pt.p, r7: pt.r7 };
  });

  // Rate of change calculation (based on normalized values)
  // 5h: last 2 hours (changes quickly)
  let rate5h = 0;
  const recent2h = sorted.filter((p) => p.t > now - 2 * 3600000);
  if (recent2h.length >= 2) {
    const rf = recent2h[0], rl = recent2h[recent2h.length - 1];
    const hDiff = (rl.t - rf.t) / 3600000;
    if (hDiff > 0.05 && rf.h5 !== null && rl.h5 !== null) {
      rate5h = Math.max((rl.h5 - rf.h5) / hDiff, 0);
    }
  }
  // 7d: rate based on local history r7(resets_at) (same logic as dashboard)
  const reset5h = snapshot?.five_hour?.resets_at ? new Date(snapshot.five_hour.resets_at).getTime() : null;
  const reset7d = snapshot?.seven_day?.resets_at ? new Date(snapshot.seven_day.resets_at).getTime() : null;
  let rate7d = 0;
  {
    const sixHoursAgo = now - 6 * 3600000;
    const recent = sorted.filter(p => p.d7 != null && p.r7 && p.t > sixHoursAgo);
    if (recent.length >= 2) {
      let totalDelta = 0;
      for (let i = 1; i < recent.length; i++) {
        if (recent[i - 1].r7 === recent[i].r7) {
          totalDelta += Math.max(0, recent[i].d7 - recent[i - 1].d7);
        }
      }
      const timeDiffH = (recent[recent.length - 1].t - recent[0].t) / 3600000;
      if (timeDiffH > 0) rate7d = totalDelta / timeDiffH;
    }
  }
  if (rate7d === 0) {
    // fallback: elapsed time based on resets_at window
    const last7dVal = sorted[sorted.length - 1].d7;
    if (reset7d && last7dVal != null && last7dVal > 0) {
      const hoursToReset7d = Math.max((reset7d - now) / 3600000, 0);
      const elapsed = 7 * 24 - hoursToReset7d;
      if (elapsed > 1) rate7d = last7dVal / elapsed;
    }
  }
  const last5h = sorted[sorted.length - 1].h5;
  const last7d = sorted[sorted.length - 1].d7;

  // Plan limit lines (% relative to current plan, excluding 100% which overlaps current plan limit)
  const isTeamPlan = currentMult === 1.25 || currentMult === 6.25;
  const allLimits = isTeamPlan
    ? [
        { mult: 1.25, label: 'Std', color: '#06b6d4' },
        { mult: 6.25, label: 'Prem', color: '#14b8a6' },
      ]
    : [
        { mult: 1, label: 'Pro', color: '#22c55e' },
        { mult: 5, label: '5x', color: '#f97316' },
        { mult: 20, label: '20x', color: '#ef4444' },
      ];
  const limitLines = allLimits
    .map((l) => ({ value: (l.mult / currentMult) * 100, label: l.label, color: l.color }))
    .filter((l) => Math.abs(l.value - 100) > 1); // Exclude current plan overlapping with 100%

  // Hide placeholder and show both panes (for correct canvas size calculation)
  const pane5h = document.getElementById('chart-pane-5h');
  const pane7d = document.getElementById('chart-pane-7d');
  const placeholder = document.getElementById('chart-placeholder');
  if (placeholder) { placeholder.style.display = 'none'; placeholder.style.height = ''; }
  if (pane5h) pane5h.style.display = '';
  if (pane7d) pane7d.style.display = '';
  // Force reflow — ensure canvas.clientWidth returns correctly after display change
  void chartSection.offsetHeight;

  // Calculate pace tier (unified chart info using same logic as banner)
  const chartPace5h = calcPaceTier(last5h, reset5h, 5 * 3600);
  const chartPace7d = calcPaceTier(last7d, reset7d, 7 * 24 * 3600);

  // 5h chart (last 3 windows = 15 hours)
  const cutoff5h = now - 15 * 3600000;
  const sorted5h = sorted.filter((p) => p.t > cutoff5h);
  drawSingleChart({
    canvasId: 'chart-5h', infoId: 'chart-5h-info',
    sorted: sorted5h.length >= 2 ? sorted5h : sorted, key: 'h5', color: '#06b6d4',
    rate: rate5h, lastVal: last5h, resetTime: reset5h,
    limitLines, now, paceTier: chartPace5h,
  });

  // 7d chart
  drawSingleChart({
    canvasId: 'chart-7d', infoId: 'chart-7d-info',
    sorted, key: 'd7', color: '#7c3aed',
    rate: rate7d, lastVal: last7d, resetTime: reset7d,
    limitLines, now, paceTier: chartPace7d,
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
  const { canvasId, infoId, sorted, key, color, rate, lastVal, resetTime, limitLines, now, paceTier } = opts;
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

  let predict = null;
  if (hasFuture && lastVal !== null) {
    const hToReset = (resetTime - now) / 3600000;
    predict = { x: (resetTime - oldest) / totalSpan, v: Math.min(Math.max(lastVal + rate * hToReset, 0), 100) };
  }

  // Info label (stored in hidden span, copied to active tab via _syncChartInfo)
  // Show paceTier (same calcPaceTier as banner) + rate side by side
  const infoEl = document.getElementById(infoId);
  const paceColors = { green: '#22c55e', yellow: '#f59e0b', orange: '#f97316', red: '#ef4444', darkred: '#dc2626' };
  const paceCss = paceTier ? paceColors[paceTier.css] : '#9ca3af';
  const paceLabel = paceTier ? t('chart_pace_' + paceTier.id) : t('chart_stable');

  // Rate portion: rising/falling/stagnant
  let ratePart = '';
  if (rate > 0.1) {
    const rateStr = rate >= 10 ? Math.round(rate) : rate.toFixed(1);
    ratePart = ` <span style="color:#9ca3af;font-size:0.85em">\u2191${rateStr}%/h</span>`;
  } else if (rate < -0.1) {
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
  // Limit line filter: only show within maxY range (re-filtered at draw stage)
  const visibleLimits = limitLines.filter((l) => l.value <= dataMax * 3 && l.value >= dataMax * 0.25);
  // maxY based on data only — OK if budget/limit is clipped (uses canvas clip)
  const maxY = dataMax * 1.15;

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

  // Prediction dashed line
  if (predict && lastVal !== null) {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.moveTo(toX(nowX), toY(lastVal)); ctx.lineTo(toX(predict.x), toY(predict.v));
    ctx.stroke(); ctx.setLineDash([]);
    // Prediction end dot + label
    const pColor = predict.v >= 80 ? '#ef4444' : color;
    ctx.beginPath(); ctx.arc(toX(predict.x), toY(predict.v), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = pColor; ctx.fill();
    ctx.fillStyle = pColor; ctx.font = 'bold 7px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(predict.v)}%`, toX(predict.x), toY(predict.v) - 4);
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

  // Collect label candidates: { xN, label, priority, color }
  // priority: 0=reset, 1=now, 2=start/end, 3=intermediate tick
  var xLabels = [];

  // Start point
  xLabels.push({ xN: 0, label: fmtTime(oldest), priority: 2, color: '#9ca3af' });

  // now
  if (hasFuture) {
    xLabels.push({ xN: nowX, label: t('chart_now'), priority: 1, color: '#6b7280' });
  }

  // Reset point labels (using actually detected reset points)
  for (var _ri = 0; _ri < allResetPoints.length; _ri++) {
    var _rp = allResetPoints[_ri];
    if (_rp >= oldest && _rp <= futureEnd) {
      var _rx = (_rp - oldest) / totalSpan;
      xLabels.push({ xN: _rx, label: fmtTime(_rp), priority: 0, color: '#9ca3af' });
    }
  }

  // End point (reset time if prediction exists, otherwise now)
  if (hasFuture) {
    xLabels.push({ xN: 1, label: fmtTime(futureEnd), priority: 2, color: color });
  } else {
    xLabels.push({ xN: 1, label: t('chart_now'), priority: 2, color: '#9ca3af' });
  }

  // Intermediate ticks: date-based for 7d, hour-based for 5h
  var totalH = totalSpan / 3600000;
  if (totalH > 24) {
    // 7d: date (M/D) ticks — based on daily midnight
    var fmtDate = function(ts) { var d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate(); };
    var dayStart = new Date(oldest);
    dayStart.setHours(0, 0, 0, 0);
    dayStart = dayStart.getTime() + 86400000;
    for (var dk = dayStart; dk < oldest + totalSpan; dk += 86400000) {
      if (dk <= oldest || dk >= oldest + totalSpan) continue;
      var dkX = (dk - oldest) / totalSpan;
      xLabels.push({ xN: dkX, label: fmtDate(dk), priority: 3, color: '#c9c9c9' });
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
      xLabels.push({ xN: tkX, label: fmtTime(tk), priority: 3, color: '#c9c9c9' });
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
    xLabels.push({ xN: dkX, label: fmtDate(dk), priority: 3, color: '#c9c9c9' });
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
