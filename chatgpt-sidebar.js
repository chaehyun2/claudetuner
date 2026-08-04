// Claude Tuner — ChatGPT Sidebar Usage Panel
// Injects a compact usage display into ChatGPT's left sidebar, just above the
// account/profile footer. Self-contained styling (chatgpt-usage.css) with
// ChatGPT dark-mode (html.dark) support. Shares pure helpers via __ctUsageCore.

(() => {
  'use strict';

  const CORE = globalThis.__ctUsageCore;
  if (!CORE) return; // usage-shared.js must load first

  // Zombie-instance guard (shared implementation — see usage-shared.js). Each
  // (re)injection claims a new generation token; the superseded instance tears
  // itself down (clearing its intervals) instead of keeping the ad rotation alive.
  const _guard = CORE.createInstanceGuard('__ctCgSidebarGen', releaseInstance);
  const isCurrent = () => _guard.isCurrent();
  const ctSetInterval = (fn, ms) => _guard.setInterval(fn, ms);
  function teardown() { _guard.teardown(); }

  const PANEL_ID = 'ct-cg-sidebar';
  const SITE_URL = 'https://claudetuner.com';
  const MOUNT_INTERVAL_MS = 1000;
  const COUNTDOWN_INTERVAL_MS = 1000;
  const REFRESH_INTERVAL_MS = 60000;
  const PROVIDER = 'chatgpt';

  const NOTICE_REFRESH_MS = 30 * 60 * 1000;
  // Ads rotate/retry on their own short cadence (not the 30-min notice refresh) so the
  // 1-slot selection changes and recovers quickly if the first pick was empty.

  // ── State ──
  let _enabled = null;
  let _mounted = false;
  let _data = null; // { plan, h5, d7, r5, r7, pred5h, pred7d, lang }
  let _lang = 'en';
  let _notices = [];      // active announcements (shared source as claude.ai)
  let _lastSeenId = null; // last seen notice id (persisted)
  let _ads = [];          // selected in-house ad banners for this placement

  // ── i18n (minimal) ──
  const I18N = {
    ko: {
      title: '사용량', session: '세션 (5h)', weekly: '주간', no_data: '데이터 수집 중...',
      dashboard: '대시보드 열기', settings: '설정', notices: '공지사항',
      tip_5h: '최근 5시간 사용량.\n리셋 후 초기화됩니다.',
      tip_7d: '7일 주간 사용량.\n리셋 주기가 더 깁니다.',
      tip_pred: '현재 속도 기준,\n리셋 시점 예상 사용률.', tip_brand: 'Claude Tuner',
    },
    en: {
      title: 'Usage', session: 'Session (5h)', weekly: 'Weekly', no_data: 'Collecting data...',
      dashboard: 'Open dashboard', settings: 'Settings', notices: 'Notices',
      tip_5h: 'Usage in the last 5-hour window.\nResets periodically.',
      tip_7d: 'Usage in the 7-day window.\nLonger reset cycle.',
      tip_pred: 'Estimated usage at reset\nbased on current pace.', tip_brand: 'Claude Tuner',
    },
  };
  function t(key) { return (I18N[_lang] || I18N.en)[key] || I18N.en[key] || key; }

  // ── Styled hover tooltip (mirrors claude.ai's sidebar): a single fixed element
  // appended to <body>, repositioned under whatever row/span is hovered, with a
  // brand footer. Replaces native title= so it renders instantly and on-brand. ──
  let _tooltipEl = null;
  function ensureTooltip() {
    if (_tooltipEl && document.body.contains(_tooltipEl)) return _tooltipEl;
    _tooltipEl = document.createElement('div');
    _tooltipEl.className = 'ct-cg-tooltip';
    _tooltipEl.id = 'ct-cg-tooltip';
    document.body.appendChild(_tooltipEl);
    return _tooltipEl;
  }
  function showTooltip(target, textOrKey, raw) {
    const tip = ensureTooltip();
    const text = raw ? textOrKey : t(textOrKey);
    tip.textContent = text;
    tip.appendChild(Object.assign(document.createElement('span'), {
      className: 'ct-cg-tip-brand', textContent: t('tip_brand'),
    }));
    const rect = target.getBoundingClientRect();
    tip.style.left = `${rect.left}px`;
    tip.style.top = `${rect.bottom + 6}px`;
    tip.classList.add('visible');
  }
  function hideTooltip() { if (_tooltipEl) _tooltipEl.classList.remove('visible'); }
  function removeTooltip() { if (_tooltipEl) { _tooltipEl.remove(); _tooltipEl = null; } }
  function attachTip(el, tipKey, stopProp, raw) {
    if (!el) return;
    el.addEventListener('mouseenter', (e) => {
      if (stopProp) e.stopPropagation();
      showTooltip(el, typeof tipKey === 'function' ? tipKey() : tipKey, raw);
    });
    el.addEventListener('mouseleave', hideTooltip);
  }

  // ── Sidebar anchor: just below the "More" menu group ──
  // Preferred placement is inside the scrollable nav, right after the top-level
  // menu items (Library/Projects/Apps/More) and before the pinned/recent
  // sections. Falls back to the account/profile footer if that nav isn't found.
  function findSidebarAnchor() {
    // There can be two profile buttons (collapsed tiny-bar + expanded sidebar).
    // Pick the one that is NOT inside the collapsed rail; use it to locate the
    // expanded sidebar column (the wrapper with a direct <nav> child).
    const btns = Array.from(document.querySelectorAll('[data-testid="accounts-profile-button"]'));
    const acct = btns.find(b => !b.closest('#stage-sidebar-tiny-bar'));
    if (!acct) return null;

    let column = null, footer = acct;
    while (footer.parentElement && footer.parentElement !== document.body) {
      if (footer.parentElement.querySelector(':scope > nav')) { column = footer.parentElement; break; }
      footer = footer.parentElement;
    }
    if (!column) return null;

    const nav = column.querySelector(':scope > nav');
    if (nav) {
      // Right after the "More" group = before the first pinned/recent expando section.
      const expando = Array.from(nav.children)
        .find(c => (c.className || '').includes('sidebar-expando-section'));
      if (expando) return { parent: nav, ref: expando };

      // No pinned/recent sections: place after the last top-level menu link.
      const items = nav.querySelectorAll(':scope > a[data-testid]');
      if (items.length) {
        const last = items[items.length - 1];
        // The "More" group (if present) is the link's next sibling.
        const more = last.nextElementSibling;
        return { parent: nav, ref: more ? more.nextElementSibling : null };
      }
    }

    // Fallback: above the account/profile footer.
    return { parent: column, ref: footer };
  }

  // Single canonical ChatGPT sidebar-anchor finder — also consumed by the folders
  // panel (chatgpt-folders.js CHATGPT_ADAPTER) so this DOM logic lives in ONE place
  // (no copy). This file is injected before chatgpt-folders.js, so the reference is
  // set in time. Pure DOM read (no closure state), safe to share across instances.
  globalThis.__ctCgFindSidebarAnchor = findSidebarAnchor;

  // ── Build ──
  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'ct-cg-panel';

    // Header mirrors ChatGPT's own menu rows (icon + label via __menu-item) so it
    // reads as a native sidebar entry.
    const logoUrl = chrome.runtime.getURL('icons/icon16.png');
    const header = document.createElement('div');
    header.className = 'ct-cg-head __menu-item gap-1.5';
    header.innerHTML = `
      <div class="flex items-center justify-center icon"><img src="${logoUrl}" class="ct-cg-logo" alt=""></div>
      <div class="flex min-w-0 grow items-center gap-2.5"><div class="truncate ct-cg-title text-token-text-primary">${CORE.escapeHtml(t('title'))}</div></div>
    `;
    panel.appendChild(header);

    const content = document.createElement('div');
    content.className = 'ct-cg-content';
    content.id = 'ct-cg-content';
    panel.appendChild(content);

    // Inline announcement banner (below content), same source as claude.ai.
    const notice = document.createElement('div');
    notice.className = 'ct-cg-notice';
    notice.id = 'ct-cg-notice';
    notice.style.display = 'none';
    panel.appendChild(notice);

    // In-house ad banner container (below notice); non-dismissible (design §6).
    const ad = document.createElement('div');
    ad.className = 'ct-cg-ad';
    ad.id = 'ct-cg-ad';
    ad.style.display = 'none';
    panel.appendChild(ad);

    return panel;
  }

  function buildLimitRow(id, label, util, resetAt, predUtil) {
    const row = document.createElement('div');
    row.className = 'ct-cg-limit';
    row.dataset.limitId = id;

    const color = CORE.gaugeColor(util);
    const pctText = `${Math.round(util)}%`;
    const showPred = predUtil != null && predUtil - util >= CORE.PRED_MIN_DELTA;

    let predHtml = '';
    if (showPred) {
      const predColor = CORE.gaugeColor(predUtil);
      const predText = predUtil >= 100 ? '100%+' : `${Math.round(predUtil)}%`;
      predHtml = `<span class="ct-cg-arrow text-token-text-tertiary">→</span><span class="ct-cg-pred" style="color:${predColor}">${predText}</span>`;
    }

    // Reset cell — single-sourced across all three sidebars (CORE.buildResetCellInner):
    // countdown + compact absolute two lines, or an idle hint when the window has no reset.
    // Capability-guarded: a stale __ctUsageCore without the builder falls back to the
    // plain countdown line instead of throwing.
    const resetInner = CORE.buildResetCellInner
      ? CORE.buildResetCellInner(resetAt, _lang)
      : (resetAt ? `<span class="ct-reset-count">${CORE.formatCountdown(resetAt, _lang)}</span>` : '');

    const labelRow = document.createElement('div');
    labelRow.className = 'ct-cg-label-row';
    labelRow.innerHTML = `
      <span class="ct-cg-label-left">
        <span class="ct-cg-name text-token-text-secondary">${CORE.escapeHtml(label)}</span>
        <span class="ct-cg-pct" style="color:${color}">${pctText}</span>${predHtml}
      </span>
      <span class="ct-cg-reset text-token-text-tertiary" data-reset="${resetAt || ''}">${resetInner}</span>
    `;
    row.appendChild(labelRow);

    const clampedUtil = Math.min(util, 100);
    const barColor = id === '5h' ? '#06b6d4' : '#7c3aed';
    let barHtml = `<div class="ct-cg-bar-track"><div class="ct-cg-bar-fill" style="width:${clampedUtil}%;background:${barColor}"></div></div>`;
    if (showPred) {
      const clampedPred = Math.min(predUtil, 100);
      const predColor = CORE.gaugeColor(predUtil);
      barHtml += `<div class="ct-cg-bar-pred-fill" style="left:${clampedUtil}%;width:${clampedPred - clampedUtil}%;color:${predColor}"></div>`;
      barHtml += `<div class="ct-cg-bar-marker" style="left:${clampedPred}%;background:${predColor}"></div>`;
    }
    const bar = document.createElement('div');
    bar.className = 'ct-cg-bar';
    bar.innerHTML = barHtml;
    row.appendChild(bar);

    // Styled tooltips (mirror claude.ai): row → what the limit means, pred span →
    // how the estimate is derived, reset span → absolute reset time (recalculated
    // on each hover so it never goes stale between the 1s countdown ticks).
    attachTip(row, id === '5h' ? 'tip_5h' : 'tip_7d');
    attachTip(row.querySelector('.ct-cg-pred'), 'tip_pred', true);
    if (resetAt) attachTip(row.querySelector('.ct-cg-reset'), () => CORE.formatResetAbsolute(resetAt, _lang), true, true);

    return row;
  }

  // The notice and ad containers are children of the PANEL, not of #ct-cg-content, so a
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
    const content = document.getElementById('ct-cg-content');
    if (!content) return;

    if (!_data || (_data.h5 == null && _data.d7 == null)) {
      content.innerHTML = `<div class="ct-cg-message text-token-text-tertiary">${CORE.escapeHtml(t('no_data'))}</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    if (_data.h5 != null) frag.appendChild(buildLimitRow('5h', t('session'), _data.h5, _data.r5, _data.pred5h));
    if (_data.d7 != null) frag.appendChild(buildLimitRow('7d', t('weekly'), _data.d7, _data.r7, _data.pred7d));

    const footer = document.createElement('div');
    footer.className = 'ct-cg-footer text-token-text-tertiary';
    const planText = _data.plan ? `<span class="ct-cg-plan text-token-text-secondary">${CORE.escapeHtml(CORE.planDisplayName(_data.plan, 'chatgpt'))}</span>` : '<span></span>';
    footer.innerHTML = `
      ${planText}
      <span class="ct-cg-actions">
        <button class="ct-cg-bell-btn" title="${CORE.escapeHtml(t('notices'))}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
          <span class="ct-cg-bell-badge" id="ct-cg-bell-badge" style="display:none"></span>
        </button>
        <a class="ct-cg-link" href="${SITE_URL}/dashboard/?utm_source=chatgpt_sidebar" target="_blank" rel="noopener" title="${CORE.escapeHtml(t('dashboard'))}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </a>
        <button class="ct-cg-settings-btn" title="${CORE.escapeHtml(t('settings'))}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
        </button>
      </span>
    `;
    footer.querySelector('.ct-cg-bell-btn').addEventListener('click', () => {
      try { window.open(CORE.NOTICE_BASE + _lang + '?utm_source=chatgpt_sidebar', '_blank'); } catch { /* */ }
      if (_notices.length > 0) {
        _lastSeenId = _notices[0].id;
        try { chrome.storage.local.set({ ct_last_seen_notice_id: _lastSeenId }); } catch { /* */ }
        updateBellBadge();
      }
    });
    footer.querySelector('.ct-cg-settings-btn').addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS', hash: 'page-usage' }); } catch { /* context dead */ }
    });
    frag.appendChild(footer);

    hideTooltip(); // the old rows (tooltip owners) are about to be replaced
    content.innerHTML = '';
    content.appendChild(frag);
    updateBellBadge();
  }

  // ── Announcements (shared source/logic with claude.ai) ──
  async function fetchNotices() {
    if (!isCurrent() || !CORE.fetchAnnouncements) return;
    try {
      const fresh = await CORE.fetchAnnouncements(_lang, chrome.runtime.getManifest().version);
      if (!isCurrent()) return; // superseded mid-flight — don't mutate shared DOM
      _notices = fresh;
      updateBellBadge();
      renderInlineNotice();
    } catch { /* silent — keep last-known notices */ }
  }

  // ── In-house ad banner (design §2.2/§3.2/§4) ──
  async function fetchAds() {
    if (!isCurrent() || !CORE.selectAds) return;
    try {
      const fresh = await CORE.selectAds({ placement: CORE.PLACEMENTS.CHATGPT_SIDEBAR, lang: _lang });
      if (!isCurrent()) return; // superseded mid-flight — don't mutate shared DOM
      _ads = fresh;
      renderInlineAd();
    } catch { /* silent — no ads this round */ }
  }

  function renderInlineAd() {
    const container = document.getElementById('ct-cg-ad');
    if (!container || !CORE.buildAdBannerHtml) return;
    if (!_ads.length) { container.innerHTML = ''; container.style.display = 'none'; return; }
    container.style.display = '';
    container.innerHTML = _ads.map(ad => CORE.buildAdBannerHtml(ad, _lang)).join('');
    container.querySelectorAll('.ct-ad-banner').forEach((el, i) => {
      const ad = _ads[i];
      CORE.noteAdServed(ad.campaign.campaign_id, ad.placement); // daily frequency cap (serving-side)
      CORE.trackAdViewability(el, ad, _guard); // measurement seam: viewability-gated impression → SW counter owner
      const url = el.getAttribute('data-ad-url');
      if (url) el.addEventListener('click', (e) => {
        // Label chip is an advertiser-inquiry link (its own target=_blank nav) — not an ad click.
        if (e.target.closest && e.target.closest('.ct-ad-label')) return;
        CORE.trackAdClick(ad, e); // measurement seam: click → SW counter owner
        window.open(url + (url.includes('?') ? '&' : '?') + 'utm_source=chatgpt_sidebar', '_blank');
      });
    });
  }

  function updateBellBadge() {
    const badge = document.getElementById('ct-cg-bell-badge');
    if (!badge) return;
    const unseen = CORE.getUnseenCount(_notices, _lastSeenId);
    if (unseen > 0) { badge.textContent = unseen; badge.style.display = ''; }
    else { badge.style.display = 'none'; }
  }

  function renderInlineNotice() {
    const container = document.getElementById('ct-cg-notice');
    if (!container) return;
    chrome.storage.local.get({ ct_dismissed_notices: [] }, (result) => {
      const dismissed = result.ct_dismissed_notices || [];
      const active = _notices.filter(n => !dismissed.includes(n.id));
      if (active.length === 0) { container.innerHTML = ''; container.style.display = 'none'; return; }
      const latest = active[0];
      container.style.display = '';
      container.innerHTML = `
        <span class="ct-cg-notice-icon">📢</span>
        <span class="ct-cg-notice-text text-token-text-secondary">${CORE.escapeHtml(latest.title || '')}</span>
        <button class="ct-cg-notice-close text-token-text-tertiary">×</button>
      `;
      container.querySelector('.ct-cg-notice-text').addEventListener('click', () => {
        let url = latest.url || '';
        try { const u = new URL(url); if (u.protocol !== 'http:' && u.protocol !== 'https:') url = ''; } catch { url = ''; }
        if (!url) url = CORE.NOTICE_BASE + _lang;
        window.open(url + (url.includes('?') ? '&' : '?') + 'utm_source=chatgpt_sidebar', '_blank');
      });
      container.querySelector('.ct-cg-notice-close').addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.storage.local.get({ ct_dismissed_notices: [] }, (r) => {
          const arr = r.ct_dismissed_notices || [];
          if (!arr.includes(latest.id)) arr.push(latest.id);
          chrome.storage.local.set({ ct_dismissed_notices: arr }, () => renderInlineNotice());
        });
      });
    });
  }

  function updateCountdowns() {
    // Update only the countdown sub-span; the static absolute-time line must survive.
    document.querySelectorAll(`#${PANEL_ID} .ct-cg-reset[data-reset]`).forEach(el => {
      const r = el.dataset.reset;
      if (!r) return;
      const countEl = el.querySelector('.ct-reset-count');
      if (countEl) countEl.textContent = CORE.formatCountdown(r, _lang);
    });
  }

  // ── Mount / unmount ──
  function mount() {
    if (document.getElementById(PANEL_ID)) { _mounted = true; return; }
    const anchor = findSidebarAnchor();
    if (!anchor) { _mounted = false; return; }
    const panel = buildPanel();
    renderContent();
    anchor.parent.insertBefore(panel, anchor.ref);
    _mounted = true;
  }

  function unmount() {
    const el = document.getElementById(PANEL_ID);
    if (el) el.remove();
    hideTooltip(); // rows that owned the tooltip are gone — don't leave it hanging
    _mounted = false;
  }

  function ensureMounted() {
    if (!_enabled) { unmount(); return; }
    if (!isCurrent()) return;
    if (!document.getElementById(PANEL_ID)) _mounted = false;
    if (!_mounted) { mount(); if (_mounted) renderContent(); }
  }

  // Release everything this instance owns beyond its timers/observers (those are
  // cleared by the guard, which calls this exactly once): DOM, tooltip, and the
  // runtime/storage listeners — else re-injection accumulates them. Reached both
  // when a newer injection supersedes us and when the ChatGPT host permission is
  // revoked (teardown() is called directly there).
  function releaseInstance() {
    _enabled = false;
    unmount();
    removeTooltip();
    _observer = null;
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* context dead */ }
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { /* context dead */ }
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  // ── Data ──
  let _reqSeq = 0;
  function requestUsageData() {
    if (!isCurrent()) return;
    const seq = ++_reqSeq;
    try {
      chrome.runtime.sendMessage({ type: 'GET_SIDEBAR_USAGE', provider: PROVIDER, orgId: null }, (res) => {
        if (!isCurrent()) return; // a newer instance superseded this one mid-flight
        if (seq !== _reqSeq) return;
        if (chrome.runtime.lastError) return;
        if (res && res.revoked) { teardown(); return; } // ChatGPT permission gone
        if (!res) { // explicit empty (no ChatGPT data) — clear stale display
          if (_data !== null) { _data = null; renderContent(); }
          return;
        }
        if (_data && _data.h5 === res.h5 && _data.d7 === res.d7 && _data.r5 === res.r5 &&
            _data.r7 === res.r7 && _data.pred5h === res.pred5h && _data.pred7d === res.pred7d &&
            _data.plan === res.plan) return;
        _data = res;
        // Note: _lang is driven by the user's extension language setting
        // (chrome.storage.sync `lang`, navigator fallback), not res.lang — the
        // latter is a Claude-snapshot field that defaults to 'en' for ChatGPT.
        renderContent();
      });
    } catch { /* context dead */ }
  }

  function onRuntimeMessage(message) {
    if (!isCurrent()) return;
    if (message.type === 'SIDEBAR_USAGE_REFRESH') requestUsageData();
  }

  function onStorageChanged(changes, area) {
    if (!isCurrent()) return;
    if (area !== 'sync') return;
    if (changes.chatgptSidebarUsageEnabled) {
      _enabled = changes.chatgptSidebarUsageEnabled.newValue !== false;
      if (!_enabled) unmount(); else requestUsageData();
    }
    if (changes.lang) {
      _lang = changes.lang.newValue === 'auto' ? CORE.detectLang() : changes.lang.newValue;
      renderContent();
      fetchNotices();
      fetchAds(); // re-run targeting so ads re-filter by the new language (fetch is cached)
    }
  }

  // ── Loop + observer ──
  let _lastMountCheck = 0;
  function tick() {
    if (!isCurrent()) { teardown(); return; } // superseded → stop the RAF loop
    try {
      const now = Date.now();
      if (now - _lastMountCheck >= MOUNT_INTERVAL_MS) {
        _lastMountCheck = now;
        ensureMounted();
      }
    } catch { /* never kill the loop */ }
    requestAnimationFrame(tick);
  }

  let _observer = null;
  function startObserver() {
    if (_observer) return;
    _observer = new MutationObserver(() => {
      if (!isCurrent()) { teardown(); return; }
      if (!_enabled) return;
      if (!document.getElementById(PANEL_ID)) { _mounted = false; mount(); if (_mounted) renderContent(); }
    });
    _guard.addObserver(_observer);
    _observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Init ──
  function init() {
    chrome.storage.local.get({ ct_last_seen_notice_id: null }, (local) => {
      _lastSeenId = local.ct_last_seen_notice_id;
    });
    chrome.storage.sync.get({ lang: 'auto', chatgptSidebarUsageEnabled: true }, (cfg) => {
      _lang = cfg.lang === 'auto' ? CORE.detectLang() : cfg.lang;
      _enabled = cfg.chatgptSidebarUsageEnabled !== false;
      if (_enabled) { requestUsageData(); fetchNotices(); fetchAds(); }
    });

    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    chrome.storage.onChanged.addListener(onStorageChanged);

    requestAnimationFrame(tick);
    startObserver();
    ctSetInterval(updateCountdowns, COUNTDOWN_INTERVAL_MS);
    ctSetInterval(requestUsageData, REFRESH_INTERVAL_MS);
    ctSetInterval(fetchNotices, NOTICE_REFRESH_MS);
    // Rotation period is server-tunable (CORE.getAdRefreshMs) — no CWS release to change it.
    CORE.startAdRotation(ctSetInterval, fetchAds);
  }

  function onVisibilityChange() {
    if (!isCurrent()) return;
    try {
      chrome.runtime.sendMessage({
        type: document.visibilityState === 'visible' ? 'TAB_VISIBLE' : 'TAB_HIDDEN',
      }).catch(() => {});
    } catch { /* context invalidated */ }
    // Best-effort tail flush of ad counters when the tab hides (design §5.4).
    if (document.visibilityState === 'hidden' && CORE.sendAdFlushHint) CORE.sendAdFlushHint();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', () => { if (CORE.sendAdFlushHint) CORE.sendAdFlushHint(); });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
