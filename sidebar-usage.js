// Claude Tuner — Sidebar Usage Panel
// Injects a compact usage display into Claude.ai's left sidebar.
// Uses Claude.ai's Tailwind CSS classes for automatic dark/light mode.

(() => {
  'use strict';

  const CT_PANEL_ID = 'ct-sidebar-usage';
  const SITE_URL = 'https://claudetuner.com';
  const MOUNT_INTERVAL_MS = 1000;
  const COUNTDOWN_INTERVAL_MS = 1000;

  // ── State ──
  let _enabled = true;    // controlled by options
  let _mounted = false;
  let _data = null;       // { plan, h5, d7, r5, r7, eu, el, euEnabled, pred5h, pred7d }
  let _lang = 'en';
  let _countdownTimer = null;

  // ── i18n (minimal, sidebar only) ──
  const I18N = {
    ko: {
      session: '세션 (5h)',
      weekly: '주간',
      extra: '추가 사용량',
      peak: 'PEAK',
      no_data: '데이터 수집 중...',
      soon: '곧 리셋',
      pred_tip: '리셋 시 예상 사용률',
      dashboard: '대시보드 열기',
      settings: '설정',
      tip_5h: '최근 5시간 사용량.\n리셋 후 초기화됩니다.',
      tip_7d: '7일 주간 사용량.\n리셋 주기가 더 깁니다.',
      tip_pred: '현재 속도 기준,\n리셋 시점 예상 사용률.',
      tip_extra: '기본 한도 초과 시\n추가 과금되는 사용량.',
      tip_peak: '피크 시간대 (평일 12-18 UTC).\n5h 한도가 빠르게 소진됩니다.',
      tip_plan: '현재 활성 플랜.',
      tip_brand: 'Claude Tuner',
    },
    en: {
      session: 'Session (5h)',
      weekly: 'Weekly',
      extra: 'Extra Usage',
      peak: 'PEAK',
      no_data: 'Collecting data...',
      soon: 'Resetting soon',
      pred_tip: 'Estimated usage at reset',
      dashboard: 'Open dashboard',
      settings: 'Settings',
      tip_5h: 'Usage in the last 5-hour window.\nResets periodically.',
      tip_7d: 'Usage in the 7-day window.\nLonger reset cycle.',
      tip_pred: 'Estimated usage at reset\nbased on current pace.',
      tip_extra: 'Additional usage billed beyond\nyour plan\'s included limit.',
      tip_peak: 'Peak hours (weekdays 12-18 UTC).\n5h limit drains faster.',
      tip_plan: 'Your current active plan.',
      tip_brand: 'Claude Tuner',
    },
  };

  function t(key) {
    return (I18N[_lang] || I18N.en)[key] || (I18N.en)[key] || key;
  }

  // ── Utility ──
  function gaugeColor(util) {
    if (util >= 80) return '#ef4444';
    if (util >= 50) return '#f59e0b';
    return '#06b6d4';
  }

  function formatCountdown(resetAt) {
    const diff = new Date(resetAt).getTime() - Date.now();
    if (diff <= 0) return `⏱ ${t('soon')}`;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (h >= 24) {
      const d = Math.floor(h / 24);
      return `⏱ ${d}d ${h % 24}h`;
    }
    return `⏱ ${h}h ${m}m`;
  }

  function isPeakNow() {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    return day >= 1 && day <= 5 && hour >= 12 && hour < 18;
  }

  // ── Tooltip ──
  let _tooltipEl = null;

  function ensureTooltip() {
    if (_tooltipEl && document.body.contains(_tooltipEl)) return _tooltipEl;
    _tooltipEl = document.createElement('div');
    _tooltipEl.className = 'ct-sb-tooltip bg-bg-300 text-text-100';
    _tooltipEl.id = 'ct-sb-tooltip';
    document.body.appendChild(_tooltipEl);
    return _tooltipEl;
  }

  function showTooltip(target, tipKey) {
    const tip = ensureTooltip();
    const text = t(tipKey);
    tip.innerHTML = text + `<span class="ct-sb-tip-brand">${t('tip_brand')}</span>`;
    // Position below the target element
    const rect = target.getBoundingClientRect();
    tip.style.left = `${rect.left}px`;
    tip.style.top = `${rect.bottom + 6}px`;
    tip.classList.add('visible');
  }

  function hideTooltip() {
    if (_tooltipEl) _tooltipEl.classList.remove('visible');
  }

  function attachTip(el, tipKey, stopProp) {
    el.addEventListener('mouseenter', (e) => {
      if (stopProp) e.stopPropagation();
      showTooltip(el, tipKey);
    });
    el.addEventListener('mouseleave', hideTooltip);
  }

  function getActiveOrgId() {
    return document.cookie.split('; ')
      .find(r => r.startsWith('lastActiveOrg='))?.split('=')[1] || null;
  }

  // ── Sidebar anchor detection (following competitor pattern) ──
  function findSidebarAnchor() {
    // Desktop app
    const dframeSidebar = document.querySelector('.dframe-sidebar-body');
    if (dframeSidebar) {
      const navScroll = dframeSidebar.querySelector('.dframe-nav-scroll');
      if (navScroll) return { parent: navScroll.parentElement, ref: navScroll, type: 'desktop' };
    }

    // Web — find the nav sidebar
    const sidebarNav = document.querySelector('nav.flex');
    if (!sidebarNav) return null;

    const containerWrapper = sidebarNav.querySelector('.flex.flex-grow.flex-col.overflow-y-auto');
    const containers = containerWrapper?.querySelectorAll('.flex-1.relative');
    if (!containers || containers.length === 0) return null;

    const lastContainer = containers[containers.length - 1];
    let mainContainer = lastContainer.querySelector('.px-2.mt-4')
      || lastContainer.querySelector('.px-2.pt-2');
    if (!mainContainer) return null;

    // Insert before starred section or first child
    const starredSection = mainContainer.querySelector('div.flex.flex-col.mb-4');
    const ref = starredSection || mainContainer.firstChild || null;

    return { parent: mainContainer, ref, type: 'web' };
  }

  // ── Build HTML ──
  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = CT_PANEL_ID;
    panel.className = 'ct-sidebar-usage';

    // Header
    const header = document.createElement('div');
    header.className = 'ct-sb-header';
    header.innerHTML = `
      <span class="ct-sb-title text-text-500">Usage</span>
      <span class="ct-sb-actions">
        <a href="${SITE_URL}/dashboard/" target="_blank" rel="noopener" title="${t('dashboard')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-500">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </a>
        <button class="ct-sb-settings-btn" title="${t('settings')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-500">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
        </button>
      </span>
    `;

    // Settings button opens extension options page
    header.querySelector('.ct-sb-settings-btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
    });
    panel.appendChild(header);

    // Content container
    const content = document.createElement('div');
    content.className = 'ct-sb-content';
    content.id = 'ct-sb-content';
    panel.appendChild(content);

    return panel;
  }

  function buildLimitRow(id, label, util, resetAt, predUtil) {
    const row = document.createElement('div');
    row.className = 'ct-sb-limit';
    row.dataset.limitId = id;

    const color = gaugeColor(util);
    const pctText = `${Math.round(util)}%`;

    // Label row
    const labelRow = document.createElement('div');
    labelRow.className = 'ct-sb-label-row text-text-300';

    let predHtml = '';
    if (predUtil != null && predUtil - util >= 3) {
      const predColor = gaugeColor(predUtil);
      const predText = predUtil >= 100 ? '100%+' : `${Math.round(predUtil)}%`;
      predHtml = `<span class="ct-sb-arrow">→</span><span class="ct-sb-pred" style="color:${predColor}" title="${t('pred_tip')}">${predText}</span>`;
    }

    const resetText = resetAt ? formatCountdown(resetAt) : '';

    labelRow.innerHTML = `
      <span class="ct-sb-label-left">
        <span class="ct-sb-name">${label}</span>
        <span class="ct-sb-pct" style="color:${color}">${pctText}</span>${predHtml}
      </span>
      <span class="ct-sb-reset" data-reset="${resetAt || ''}">${resetText}</span>
    `;
    row.appendChild(labelRow);

    // Progress bar
    const bar = document.createElement('div');
    bar.className = 'ct-sb-bar';

    const clampedUtil = Math.min(util, 100);
    const barColor = id === '5h' ? '#06b6d4' : id === '7d' ? '#7c3aed' : '#f59e0b';

    let barHtml = `<div class="ct-sb-bar-track bg-bg-500"><div class="ct-sb-bar-fill" style="width:${clampedUtil}%;background:${barColor}"></div></div>`;

    // Prediction fill + marker
    if (predUtil != null && predUtil - util >= 3) {
      const clampedPred = Math.min(predUtil, 100);
      const predColor = gaugeColor(predUtil);
      barHtml += `<div class="ct-sb-bar-pred-fill" style="left:${clampedUtil}%;width:${clampedPred - clampedUtil}%;color:${barColor}"></div>`;
      barHtml += `<div class="ct-sb-bar-marker" style="left:${clampedPred}%;background:${predColor}"></div>`;
    }

    bar.innerHTML = barHtml;
    row.appendChild(bar);

    // Tooltip on the whole row
    const tipKey = id === '5h' ? 'tip_5h' : 'tip_7d';
    attachTip(row, tipKey);

    // Prediction tooltip (on the pred span if exists)
    const predSpan = row.querySelector('.ct-sb-pred');
    if (predSpan) attachTip(predSpan, 'tip_pred', true);

    return row;
  }

  function buildExtraUsageRow(usedCents, limitCents) {
    const row = document.createElement('div');
    row.className = 'ct-sb-limit';
    row.dataset.limitId = 'extra';

    const util = Math.min(Math.round((usedCents / (limitCents || 1)) * 100), 100);
    const color = gaugeColor(util);
    const usedStr = `$${(usedCents / 100).toFixed(2)}`;
    const limitStr = `$${(limitCents / 100).toFixed(0)}`;

    const labelRow = document.createElement('div');
    labelRow.className = 'ct-sb-label-row text-text-300';
    labelRow.innerHTML = `
      <span class="ct-sb-label-left">
        <span class="ct-sb-name">${t('extra')}</span>
        <span class="ct-sb-pct" style="color:${color}">${usedStr}</span>
        <span class="ct-sb-arrow">/</span>
        <span class="ct-sb-pred" style="opacity:0.5">${limitStr}</span>
      </span>
    `;
    row.appendChild(labelRow);

    const bar = document.createElement('div');
    bar.className = 'ct-sb-bar';
    bar.innerHTML = `<div class="ct-sb-bar-track bg-bg-500"><div class="ct-sb-bar-fill" style="width:${util}%;background:#f59e0b"></div></div>`;
    row.appendChild(bar);

    attachTip(row, 'tip_extra');

    return row;
  }

  function renderContent() {
    const content = document.getElementById('ct-sb-content');
    if (!content) return;

    if (!_data) {
      content.innerHTML = `<div class="ct-sb-message text-text-500">${t('no_data')}</div>`;
      return;
    }

    const frag = document.createDocumentFragment();

    // 5h gauge
    if (_data.h5 != null) {
      frag.appendChild(buildLimitRow('5h', t('session'), _data.h5, _data.r5, _data.pred5h));
    }

    // 7d gauge
    if (_data.d7 != null) {
      frag.appendChild(buildLimitRow('7d', t('weekly'), _data.d7, _data.r7, _data.pred7d));
    }

    // Extra usage
    if (_data.euEnabled && _data.el && (_data.eu || 0) > 0) {
      frag.appendChild(buildExtraUsageRow(_data.eu, _data.el));
    }

    // Footer: plan + peak
    const footer = document.createElement('div');
    footer.className = 'ct-sb-footer text-text-500';
    if (_data.plan) {
      const planSpan = document.createElement('span');
      planSpan.className = 'ct-sb-plan';
      planSpan.textContent = _data.plan;
      attachTip(planSpan, 'tip_plan');
      footer.appendChild(planSpan);
    }
    if (isPeakNow()) {
      const peakSpan = document.createElement('span');
      peakSpan.className = 'ct-sb-peak';
      peakSpan.textContent = `🔥 ${t('peak')}`;
      attachTip(peakSpan, 'tip_peak');
      footer.appendChild(peakSpan);
    }
    if (footer.childNodes.length > 0) {
      frag.appendChild(footer);
    }

    content.innerHTML = '';
    content.appendChild(frag);
  }

  // ── Countdown update (every second) ──
  function updateCountdowns() {
    const resets = document.querySelectorAll(`#${CT_PANEL_ID} .ct-sb-reset[data-reset]`);
    resets.forEach(el => {
      const resetAt = el.dataset.reset;
      if (resetAt) el.textContent = formatCountdown(resetAt);
    });
  }

  // ── Mount / unmount ──
  function mount() {
    if (document.getElementById(CT_PANEL_ID)) {
      _mounted = true;
      return;
    }

    const anchor = findSidebarAnchor();
    if (!anchor) {
      _mounted = false;
      return;
    }

    const panel = buildPanel();
    renderContent();

    if (anchor.ref) {
      anchor.parent.insertBefore(panel, anchor.ref);
    } else {
      anchor.parent.prepend(panel);
    }

    _mounted = true;
  }

  function unmount() {
    const el = document.getElementById(CT_PANEL_ID);
    if (el) el.remove();
    _mounted = false;
  }

  function ensureMounted() {
    if (!_enabled) {
      unmount();
      return;
    }
    // Re-mount if panel was removed (SPA navigation, sidebar re-render)
    if (!document.getElementById(CT_PANEL_ID)) {
      _mounted = false;
    }
    if (!_mounted) {
      mount();
      if (_mounted) renderContent();
    }
  }

  // ── Data communication with background ──
  function requestUsageData() {
    chrome.runtime.sendMessage({ type: 'GET_SIDEBAR_USAGE', orgId: getActiveOrgId() }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      _data = res;
      _lang = res.lang || _lang;
      renderContent();
    });
  }

  // Listen for refresh signal from background (re-fetch with current orgId)
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SIDEBAR_USAGE_REFRESH') {
      requestUsageData();
    }
  });

  // ── Org change detection ──
  let _lastOrgId = getActiveOrgId();

  function checkOrgChange() {
    const current = getActiveOrgId();
    if (current && current !== _lastOrgId) {
      _lastOrgId = current;
      requestUsageData();
    }
  }

  // ── Main loop ──
  let _lastMountCheck = 0;

  function tick() {
    const now = Date.now();
    if (now - _lastMountCheck >= MOUNT_INTERVAL_MS) {
      _lastMountCheck = now;
      ensureMounted();
      checkOrgChange();
    }
    requestAnimationFrame(tick);
  }

  // ── Init ──
  function init() {
    // Detect language from page
    const htmlLang = document.documentElement.lang;
    _lang = htmlLang?.startsWith('ko') ? 'ko' : 'en';

    // Load enabled setting (default: true)
    chrome.storage.sync.get({ sidebarUsageEnabled: true }, (cfg) => {
      _enabled = cfg.sidebarUsageEnabled !== false;
      if (_enabled) requestUsageData();
    });

    // React to setting changes in real-time
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.sidebarUsageEnabled) {
        _enabled = changes.sidebarUsageEnabled.newValue !== false;
        if (!_enabled) unmount();
        else requestUsageData();
      }
    });

    requestAnimationFrame(tick);

    // Countdown timer
    _countdownTimer = setInterval(updateCountdowns, COUNTDOWN_INTERVAL_MS);

    // Refresh data periodically (every 60s)
    setInterval(requestUsageData, 60000);
  }

  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
