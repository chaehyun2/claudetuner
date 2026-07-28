// Claude Tuner — Sidebar Usage Panel
// Injects a compact usage display into Claude.ai's left sidebar.
// Uses Claude.ai's Tailwind CSS classes for automatic dark/light mode.

(() => {
  'use strict';

  const CT_PANEL_ID = 'ct-sidebar-usage';
  const SITE_URL = 'https://claudetuner.com';
  const MOUNT_INTERVAL_MS = 1000;
  const COUNTDOWN_INTERVAL_MS = 1000;
  const NOTICE_BASE = 'https://notice.claudetuner.com/';
  const CORE = globalThis.__ctUsageCore;

  // Zombie-instance guard (shared implementation — see usage-shared.js). Each
  // (re)injection claims a new generation token; the superseded instance tears
  // itself down instead of leaving its intervals firing (duplicate ad
  // fetch/rotation and doubled impression counts). CORE is a soft dependency
  // everywhere else in this file (the usage panel still works without it, just
  // without notices/ads), so keep it soft here too rather than blanking the panel.
  const _guard = CORE && CORE.createInstanceGuard
    ? CORE.createInstanceGuard('__ctSbSidebarGen', releaseInstance)
    : null;
  const isCurrent = () => (_guard ? _guard.isCurrent() : isContextValid());
  const ctSetInterval = (fn, ms) => (_guard ? _guard.setInterval(fn, ms) : setInterval(fn, ms));
  function teardown() { if (_guard) _guard.teardown(); }

  // ── State ──
  let _enabled = null;    // null until storage read; controlled by options
  let _mounted = false;
  let _data = null;       // { plan, h5, d7, r5, r7, eu, el, euEnabled, pred5h, pred7d }
  let _lang = 'en';
  let _countdownTimer = null;
  let _notices = [];      // active announcements from server
  let _lastSeenId = null; // last seen notice ID (persisted)
  let _ads = [];          // selected in-house ad banners for this placement

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
      notices: '공지사항',
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
      notices: 'Notices',
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

  // Countdown / absolute-reset formatting is single-sourced in usage-shared.js
  // (CORE.formatCountdown / CORE.formatResetAbsolute) — the same helpers the
  // ChatGPT and Gemini sidebars use. Claude no longer keeps private copies.

  function isPeakNow() {
    // Disabled: Anthropic removed peak hour limit reduction (2026-05-07)
    return false;
    // const now = new Date();
    // const day = now.getUTCDay();
    // const hour = now.getUTCHours();
    // return day >= 1 && day <= 5 && hour >= 12 && hour < 18;
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

  function showTooltip(target, tipKeyOrText, raw) {
    const tip = ensureTooltip();
    const text = raw ? tipKeyOrText : t(tipKeyOrText);
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

  function attachTip(el, tipKey, stopProp, raw) {
    el.addEventListener('mouseenter', (e) => {
      if (stopProp) e.stopPropagation();
      showTooltip(el, typeof tipKey === 'function' ? tipKey() : tipKey, raw);
    });
    el.addEventListener('mouseleave', hideTooltip);
  }

  // ── Announcements ──
  async function fetchNotices() {
    // Defensive: notices depend on the shared core. If it's missing (e.g. a stale
    // cached sidebar-usage.js after an update where usage-shared.js wasn't
    // injected), skip notices entirely — the rest of the sidebar still works.
    if (!CORE || !CORE.fetchAnnouncements) return;
    try {
      // Shared fetch/filter (drops promos, applies min_version + lang). Throws on
      // transient error → keep last-known notices.
      _notices = await CORE.fetchAnnouncements(_lang, chrome.runtime.getManifest().version);
      updateBellBadge();
      renderInlineNotice();
    } catch (e) { /* silent — keep last-known notices */ }
  }

  function updateBellBadge() {
    const badge = document.getElementById('ct-sb-bell-badge');
    if (!badge || !CORE || !CORE.getUnseenCount) return;
    const unseen = CORE.getUnseenCount(_notices, _lastSeenId);
    if (unseen > 0) {
      badge.textContent = unseen;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  function renderInlineNotice() {
    const container = document.getElementById('ct-sb-notice');
    if (!container) return;

    chrome.storage.local.get({ ct_dismissed_notices: [] }, (result) => {
      const dismissed = result.ct_dismissed_notices || [];
      const active = _notices.filter(n => !dismissed.includes(n.id));

      if (active.length === 0) {
        container.innerHTML = '';
        container.style.display = 'none';
        return;
      }

      // Show only the latest one
      const latest = active[0];
      container.style.display = '';
      container.innerHTML = `
        <span class="ct-sb-notice-icon">\uD83D\uDCE2</span>
        <span class="ct-sb-notice-text text-text-300" data-url="${escapeHtml(latest.url || '')}">${escapeHtml(latest.title || '')}</span>
        <button class="ct-sb-notice-close text-text-500" data-nid="${escapeHtml(latest.id || '')}">\u00D7</button>
      `;

      // Click notice text → open URL or dashboard
      container.querySelector('.ct-sb-notice-text').addEventListener('click', () => {
        // Reject non-http(s) schemes (e.g. javascript:) before navigating.
        let url = latest.url || '';
        try {
          const u = new URL(url);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') url = '';
        } catch { url = ''; }
        if (!url) url = NOTICE_BASE + _lang;
        window.open(url + (url.includes('?') ? '&' : '?') + 'utm_source=sidebar', '_blank');
      });

      // Dismiss button
      container.querySelector('.ct-sb-notice-close').addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.storage.local.get({ ct_dismissed_notices: [] }, (r) => {
          const arr = r.ct_dismissed_notices || [];
          if (!arr.includes(latest.id)) arr.push(latest.id);
          chrome.storage.local.set({ ct_dismissed_notices: arr }, () => renderInlineNotice());
        });
      });
    });
  }

  // ── In-house ad banner (design §2.2/§3.2/§4) ──
  async function fetchAds() {
    if (!isCurrent()) return; // superseded instance — don't fetch or rotate
    if (!CORE || !CORE.selectAds) return; // stale core without the ad module — skip
    try {
      const fresh = await CORE.selectAds({ placement: CORE.PLACEMENTS.CLAUDE_SIDEBAR, lang: _lang });
      if (!isCurrent()) return; // superseded mid-flight — don't mutate shared DOM
      _ads = fresh;
      renderInlineAd();
    } catch (e) { /* silent — no ads this round */ }
  }

  function renderInlineAd() {
    const container = document.getElementById('ct-sb-ad');
    if (!container || !CORE || !CORE.buildAdBannerHtml) return;
    if (!_ads.length) { container.innerHTML = ''; container.style.display = 'none'; return; }
    container.style.display = '';
    container.innerHTML = _ads.map(ad => CORE.buildAdBannerHtml(ad, _lang)).join('');
    const banners = container.querySelectorAll('.ct-ad-banner');
    banners.forEach((el, i) => {
      const ad = _ads[i];
      // Count the serve toward the daily frequency cap (serving-side, not measurement).
      CORE.noteAdServed(ad.campaign.campaign_id, ad.placement);
      // Measurement seam: viewability-gated impression → message to the SW counter owner.
      CORE.trackAdViewability(el, ad, _guard);
      const url = el.getAttribute('data-ad-url');
      if (url) el.addEventListener('click', (e) => {
        // Label chip is an advertiser-inquiry link (its own target=_blank nav) — not an ad click.
        if (e.target.closest && e.target.closest('.ct-ad-label')) return;
        CORE.trackAdClick(ad, e); // measurement seam: click → SW counter owner
        const sep = url.includes('?') ? '&' : '?';
        window.open(url + sep + 'utm_source=claude_sidebar', '_blank');
      });
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    const logoUrl = chrome.runtime.getURL('icons/icon16.png');
    header.innerHTML = `
      <a href="${SITE_URL}/dashboard/?utm_source=sidebar" target="_blank" rel="noopener" class="ct-sb-logo-link" title="Claude Tuner Dashboard">
        <img src="${logoUrl}" class="ct-sb-logo" alt="CT">
      </a>
      <span class="ct-sb-title text-text-500">Usage</span>
    `;
    panel.appendChild(header);

    // Content container
    const content = document.createElement('div');
    content.className = 'ct-sb-content';
    content.id = 'ct-sb-content';
    panel.appendChild(content);

    // Inline notice container (below content)
    const notice = document.createElement('div');
    notice.className = 'ct-sb-notice';
    notice.id = 'ct-sb-notice';
    notice.style.display = 'none';
    panel.appendChild(notice);

    // In-house ad banner container (below notice). Separate container so ads and
    // dismissible notices don't interfere; ads are non-dismissible (design §6).
    const ad = document.createElement('div');
    ad.className = 'ct-sb-ad';
    ad.id = 'ct-sb-ad';
    ad.style.display = 'none';
    panel.appendChild(ad);

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

    // Reset cell — single-sourced across all three sidebars (CORE.buildResetCellInner):
    // countdown + compact absolute two lines, or an idle hint when the window has no reset.
    // CORE is a soft dependency in this file (see the `CORE &&` guards at init), and this
    // row used to be CORE-free — so guard the whole chain: an absent core / a stale core
    // without the builder degrades (plain countdown, else nothing) rather than throwing.
    const resetInner = (CORE && CORE.buildResetCellInner)
      ? CORE.buildResetCellInner(resetAt, _lang)
      : (resetAt && CORE && CORE.formatCountdown
          ? `<span class="ct-reset-count">${CORE.formatCountdown(resetAt, _lang)}</span>`
          : '');

    labelRow.innerHTML = `
      <span class="ct-sb-label-left">
        <span class="ct-sb-name">${label}</span>
        <span class="ct-sb-pct" style="color:${color}">${pctText}</span>${predHtml}
      </span>
      <span class="ct-sb-reset" data-reset="${resetAt || ''}">${resetInner}</span>
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

    // Reset time tooltip (dynamic — recalculated on hover; verbose form with timezone)
    const resetSpan = row.querySelector('.ct-sb-reset');
    if (resetAt && resetSpan) {
      attachTip(resetSpan, () => CORE.formatResetAbsolute(resetAt, _lang), true, true);
    }

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

  // The notice and ad containers are children of the PANEL, not of #ct-sb-content, so a
  // body re-render never wipes them — but a re-MOUNT does: buildPanel() mints fresh empty
  // ones. Both banners therefore have to be re-hydrated after any (re)build, and on EVERY
  // exit of renderPanelBody(), including its early return for the no-data state.
  function syncBanners() {
    if (_notices.length > 0) renderInlineNotice();
    if (_ads.length > 0) renderInlineAd();
  }

  function renderContent() {
    renderPanelBody();
    syncBanners();
  }

  function renderPanelBody() {
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

    // Footer: plan + peak + action buttons
    const footer = document.createElement('div');
    footer.className = 'ct-sb-footer text-text-500';

    const footerLeft = document.createElement('span');
    footerLeft.className = 'ct-sb-footer-left';
    if (_data.plan) {
      const planSpan = document.createElement('span');
      planSpan.className = 'ct-sb-plan';
      planSpan.textContent = _data.plan;
      attachTip(planSpan, 'tip_plan');
      footerLeft.appendChild(planSpan);
    }
    if (isPeakNow()) {
      const peakSpan = document.createElement('span');
      peakSpan.className = 'ct-sb-peak';
      peakSpan.textContent = `🔥 ${t('peak')}`;
      attachTip(peakSpan, 'tip_peak');
      footerLeft.appendChild(peakSpan);
    }
    footer.appendChild(footerLeft);

    // Action buttons (bell, dashboard, settings)
    const actions = document.createElement('span');
    actions.className = 'ct-sb-actions';
    actions.innerHTML = `
      <button class="ct-sb-bell-btn" title="${t('notices')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-text-500">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 01-3.46 0"/>
        </svg>
        <span class="ct-sb-bell-badge" id="ct-sb-bell-badge" style="display:none"></span>
      </button>
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
    `;

    // Bell click → open notice page + save last seen ID
    actions.querySelector('.ct-sb-bell-btn').addEventListener('click', () => {
      window.open(NOTICE_BASE + _lang + '?utm_source=sidebar', '_blank');
      if (_notices.length > 0) {
        _lastSeenId = _notices[0].id;
        chrome.storage.local.set({ ct_last_seen_notice_id: _lastSeenId });
        updateBellBadge();
      }
    });

    // Settings button opens extension options page
    actions.querySelector('.ct-sb-settings-btn').addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS', hash: 'page-usage' }); } catch { /* context dead */ }
    });

    footer.appendChild(actions);
    frag.appendChild(footer);

    content.innerHTML = '';
    content.appendChild(frag);
    updateBellBadge();
  }

  // ── Countdown update (every second) ──
  // Rewrite only the countdown sub-span, not the whole reset cell — the cell also
  // holds the static absolute-time line, which a full textContent overwrite would wipe.
  function updateCountdowns() {
    const resets = document.querySelectorAll(`#${CT_PANEL_ID} .ct-sb-reset[data-reset]`);
    resets.forEach(el => {
      const resetAt = el.dataset.reset;
      if (!resetAt) return;
      const countEl = el.querySelector('.ct-reset-count');
      if (countEl) countEl.textContent = CORE.formatCountdown(resetAt, _lang);
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
    // Stale instance (extension reloaded) — don't touch DOM, let new instance handle it
    if (!isContextValid()) return;

    if (!document.getElementById(CT_PANEL_ID)) {
      _mounted = false;
    }
    if (!_mounted) {
      mount();
      if (_mounted) renderContent();
    }
  }

  // ── Data communication with background ──
  let _reqSeq = 0; // sequence number to discard stale responses from concurrent calls
  function requestUsageData() {
    // isCurrent(), not just isContextValid(): a superseded instance must not keep
    // querying the background or render into the live instance's panel.
    if (!isCurrent()) return; // skip silently, panel stays with last data
    const seq = ++_reqSeq;
    try {
      chrome.runtime.sendMessage({ type: 'GET_SIDEBAR_USAGE', orgId: getActiveOrgId() }, (res) => {
        if (seq !== _reqSeq || !isCurrent()) return; // stale response or superseded instance — discard
        if (chrome.runtime.lastError || !res) return;
        // Skip re-render if data hasn't changed (prevents flicker from non-Claude merges)
        if (_data && _data.h5 === res.h5 && _data.d7 === res.d7 && _data.r5 === res.r5 &&
            _data.r7 === res.r7 && _data.pred5h === res.pred5h && _data.pred7d === res.pred7d &&
            _data.eu === res.eu && _data.plan === res.plan) return;
        _data = res;
        renderContent();
      });
    } catch { /* context dead, skip silently */ }
  }

  // Listen for refresh signal from background (re-fetch with current orgId).
  // Named so releaseInstance() can remove it — an anonymous listener would survive
  // re-injection and keep waking a superseded instance.
  function onRuntimeMessage(message) {
    if (message.type === 'SIDEBAR_USAGE_REFRESH') {
      requestUsageData();
    }
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  // ── Org change detection ──
  let _lastOrgId = getActiveOrgId();

  function checkOrgChange() {
    const current = getActiveOrgId();
    if (current && current !== _lastOrgId) {
      _lastOrgId = current;
      requestUsageData();
    }
  }

  // ── Context guard ──
  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  // Release everything this instance owns beyond its timers/observers (those are
  // cleared by the guard, which calls this exactly once): DOM, tooltip, listeners —
  // otherwise re-injection accumulates them.
  function releaseInstance() {
    _enabled = false;
    unmount();
    hideTooltip();
    _countdownTimer = null;
    _observer = null;
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { /* context dead */ }
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* context dead */ }
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  // ── Main loop ──
  let _lastMountCheck = 0;

  function tick() {
    if (!isCurrent()) { teardown(); return; } // superseded → stop the rAF loop
    try {
      const now = Date.now();
      if (now - _lastMountCheck >= MOUNT_INTERVAL_MS) {
        _lastMountCheck = now;
        ensureMounted();
        checkOrgChange();
      }
    } catch { /* never kill the loop */ }
    requestAnimationFrame(tick);
  }

  // ── MutationObserver: re-mount immediately when sidebar DOM changes ──
  let _observer = null;

  function startObserver() {
    if (_observer) return;
    _observer = new MutationObserver(() => {
      if (!isCurrent()) { teardown(); return; } // superseded → stop observing
      if (!_enabled) return;
      if (!document.getElementById(CT_PANEL_ID)) {
        _mounted = false;
        mount();
        if (_mounted) renderContent();
      }
    });
    if (_guard) _guard.addObserver(_observer);
    _observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Init ──
  function detectLang() {
    const browserLang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return browserLang === 'ko' ? 'ko' : 'en';
  }

  function init() {
    // Load language + enabled setting + last seen notice ID
    chrome.storage.local.get({ ct_last_seen_notice_id: null }, (local) => {
      _lastSeenId = local.ct_last_seen_notice_id;
    });
    chrome.storage.sync.get({ lang: 'auto', sidebarUsageEnabled: true }, (cfg) => {
      _lang = cfg.lang === 'auto' ? detectLang() : cfg.lang;
      _enabled = cfg.sidebarUsageEnabled !== false;
      if (_enabled) {
        requestUsageData();
        fetchNotices();
        fetchAds();
      }
    });

    // React to setting changes in real-time
    chrome.storage.onChanged.addListener(onStorageChanged);

    requestAnimationFrame(tick);
    startObserver();

    // Countdown timer
    _countdownTimer = ctSetInterval(updateCountdowns, COUNTDOWN_INTERVAL_MS);

    // Refresh data periodically (every 60s)
    ctSetInterval(requestUsageData, 60000);

    // Refresh notices periodically (every 30min)
    ctSetInterval(fetchNotices, 30 * 60 * 1000);

    // Re-run the 1-slot ad selection periodically so it rotates across advertisers and
    // recovers if the first pick was empty (e.g. _ct_country not cached yet). The period
    // is SERVER-TUNABLE (CORE.startAdRotation → getAdRefreshMs) — changing it needs no
    // CWS release. Decoupled from the 30-min notice refresh.
    CORE.startAdRotation(ctSetInterval, fetchAds);
  }

  function onStorageChanged(changes, area) {
    if (!isCurrent()) return;
    if (area !== 'sync') return;
    if (changes.sidebarUsageEnabled) {
      _enabled = changes.sidebarUsageEnabled.newValue !== false;
      if (!_enabled) unmount();
      else requestUsageData();
    }
    if (changes.lang) {
      const v = changes.lang.newValue;
      _lang = v === 'auto' ? detectLang() : v;
      renderContent();
      fetchNotices();
      fetchAds(); // re-run targeting so ads re-filter by the new language (fetch is cached)
    }
  }

  // Report tab visibility changes to background for activity-aware polling
  function onVisibilityChange() {
    if (!isCurrent()) return;
    try {
      chrome.runtime.sendMessage({
        type: document.visibilityState === 'visible' ? 'TAB_VISIBLE' : 'TAB_HIDDEN',
      }).catch(() => {});
    } catch { /* context invalidated */ }
    // Best-effort tail flush of ad counters when the tab hides (design §5.4).
    if (document.visibilityState === 'hidden' && CORE && CORE.sendAdFlushHint) CORE.sendAdFlushHint();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  // Flush ad counters on pagehide too (SPA teardown / navigation away).
  window.addEventListener('pagehide', () => { if (CORE && CORE.sendAdFlushHint) CORE.sendAdFlushHint(); });

  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
