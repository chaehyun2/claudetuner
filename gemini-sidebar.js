// Claude Tuner — Gemini Sidebar Usage Panel
// Injects a compact usage display into gemini.google.com's left navigation.
// Self-contained styling (gemini-usage.css) with Gemini dark-mode support
// (body.dark-theme / html[dark] / prefers-color-scheme). Shares pure helpers
// via __ctUsageCore. Mirrors chatgpt-sidebar.js but does NOT rely on any host
// utility classes (Gemini exposes none equivalent to ChatGPT's token classes),
// so every visual is styled by our own ct-gm-* classes.

(() => {
  'use strict';

  const CORE = globalThis.__ctUsageCore;
  if (!CORE) return; // usage-shared.js must load first

  // Generation token: each (re)injection bumps it. Only the newest instance is
  // "current"; older instances (after an extension update / dev reload) detect
  // the mismatch and tear themselves down, freeing the new instance to take over.
  // Zombie-instance guard (shared implementation — see usage-shared.js). Each
  // (re)injection claims a new generation token; the superseded instance tears
  // itself down (clearing its intervals) instead of keeping the ad rotation alive.
  const _guard = CORE.createInstanceGuard('__ctGmSidebarGen', releaseInstance);
  const isCurrent = () => _guard.isCurrent();
  const ctSetInterval = (fn, ms) => _guard.setInterval(fn, ms);
  function teardown() { _guard.teardown(); }

  const PANEL_ID = 'ct-gm-sidebar';
  const SITE_URL = 'https://claudetuner.com';
  const MOUNT_INTERVAL_MS = 1000;
  const COUNTDOWN_INTERVAL_MS = 1000;
  const REFRESH_INTERVAL_MS = 60000;
  const PROVIDER = 'gemini';
  const UTM = 'gemini_sidebar';

  const NOTICE_REFRESH_MS = 30 * 60 * 1000;
  // Ads rotate/retry on their own short cadence (not the 30-min notice refresh) so the
  // 1-slot selection changes and recovers quickly if the first pick was empty.
  // Throttle the "mount anchor missing" warning so a persistently-changed DOM
  // doesn't flood the console on every observer/tick pass.
  const WARN_THROTTLE_MS = 30000;

  // ── State ──
  let _enabled = null;
  let _mounted = false;
  let _data = null; // { plan, h5, d7, r5, r7, pred5h, pred7d, lang }
  let _lang = 'en';
  let _notices = [];      // active announcements (shared source as claude.ai)
  let _lastSeenId = null; // last seen notice id (persisted)
  let _ads = [];          // selected in-house ad banners for this placement
  let _lastWarnAt = 0;

  // ── i18n (minimal) ──
  const I18N = {
    ko: {
      title: '사용량', session: '세션 (5h)', weekly: '주간', no_data: '데이터 수집 중...',
      no_limit: '현재는 5시간·7일 사용량 제한 없음',
      dashboard: '대시보드 열기', settings: '설정', notices: '공지사항',
      tip_5h: '최근 5시간 사용량.\n리셋 후 초기화됩니다.',
      tip_7d: '7일 주간 사용량.\n리셋 주기가 더 깁니다.',
      tip_pred: '현재 속도 기준,\n리셋 시점 예상 사용률.', tip_brand: 'Claude Tuner',
    },
    en: {
      title: 'Usage', session: 'Session (5h)', weekly: 'Weekly', no_data: 'Collecting data...',
      no_limit: 'Currently no 5h/7d usage limits',
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
    _tooltipEl.className = 'ct-gm-tooltip';
    _tooltipEl.id = 'ct-gm-tooltip';
    document.body.appendChild(_tooltipEl);
    return _tooltipEl;
  }
  function showTooltip(target, textOrKey, raw) {
    const tip = ensureTooltip();
    const text = raw ? textOrKey : t(textOrKey);
    tip.textContent = text;
    tip.appendChild(Object.assign(document.createElement('span'), {
      className: 'ct-gm-tip-brand', textContent: t('tip_brand'),
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

  // ── Sidebar anchor ──
  // Append the panel at the end of the main-menu <mat-nav-list> (New chat / Search
  // chats / Images / Library / Gems…), just above the "Recents" history list.
  //
  // Gemini's sidebar has several account/rollout variants: it keeps multiple nav
  // subtrees (icon-rail, expanded list, hover fly-out overlay) and swaps between
  // them. Geometry is unreliable across variants — on some, a visible <mat-nav-list>
  // reports getBoundingClientRect().width === 0 and every overflow ancestor is 0
  // too — so we must NOT gate on width. Instead:
  //   • collapsed/rail state is read from Gemini's own toggle button
  //     (visible "Open sidebar" = collapsed, visible "Close sidebar" = expanded);
  //     when collapsed we mount nothing (avoids the squished-rail render);
  //   • the anchor is the *visible* menu list (has a stable entry like library),
  //     which skips the hidden collapsed-duplicate list.
  // If no visible menu list is found we return null (do NOT fall back to the whole
  // sidenav — that dropped the panel on top of the logo on some variants).
  const MENU_ITEM_SELECTOR =
    '[href="library"], [href="gems"], [href$="/library"], [data-test-id="my-stuff-side-nav-entry-button"]';
  function isLaidOut(el) {
    return !!(el && el.getClientRects && el.getClientRects().length > 0);
  }
  function findSidebarAnchor() {
    // Mount at the end of the main-menu list. Gemini keeps several laid-out menu
    // lists at once (expanded, icon-rail, hover fly-out clones), so "first match"
    // can land in a narrow clone. Pick the WIDEST laid-out list containing a menu
    // entry — that's the one the user is actually looking at. Rail handling is left
    // to applyRailVisibility() (measures the panel's OWN width, which no clone can
    // spoof); we don't try to read collapsed/expanded from labels or container width.
    let best = null, bestW = -1;
    for (const l of document.querySelectorAll('mat-nav-list')) {
      if (isLaidOut(l) && l.querySelector(MENU_ITEM_SELECTOR)) {
        const w = l.getBoundingClientRect().width;
        if (w > bestW) { bestW = w; best = l; }
      }
    }
    return best ? { parent: best, ref: null } : null; // ref null → append at end
  }
  // The panel inherits the width of whatever nav container it sits in: ~254px when the
  // sidebar is expanded, ~40px in the icon rail. Hiding on the panel's own width is the
  // one signal immune to Gemini's hidden/duplicate elements. visibility+max-height:0
  // (see gemini-usage.css .ct-gm-collapsed) keeps the width measurable so we can detect
  // re-expansion, while collapsing the vertical space so the rail shows nothing.
  const RAIL_HIDE_WIDTH_PX = 120;
  function applyRailVisibility() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const w = panel.getBoundingClientRect().width;
    panel.classList.toggle('ct-gm-collapsed', w > 0 && w < RAIL_HIDE_WIDTH_PX);
  }

  function warnNoAnchor() {
    const now = Date.now();
    if (now - _lastWarnAt < WARN_THROTTLE_MS) return;
    _lastWarnAt = now;
    console.warn('[Claude Tuner] Gemini sidebar mount anchor not found — selectors may need hardening for the live page.');
  }

  // ── Build ──
  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'ct-gm-panel';

    // 48px source downscaled to 20px renders crisply (16px upscaled looked blurry).
    const logoUrl = chrome.runtime.getURL('icons/icon48.png');
    const header = document.createElement('div');
    header.className = 'ct-gm-head';
    // Behave like a native Gemini nav item: hover highlight + click opens dashboard.
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.title = t('dashboard');
    header.innerHTML = `
      <img src="${logoUrl}" class="ct-gm-logo" alt="">
      <span class="ct-gm-title">${CORE.escapeHtml(t('title'))}</span>
    `;
    const openDashboard = () => {
      try { window.open(`${SITE_URL}/dashboard/?utm_source=${UTM}`, '_blank'); } catch { /* context dead */ }
    };
    header.addEventListener('click', openDashboard);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDashboard(); }
    });
    panel.appendChild(header);

    const content = document.createElement('div');
    content.className = 'ct-gm-content';
    content.id = 'ct-gm-content';
    panel.appendChild(content);

    // Inline announcement banner (below content), same source as claude.ai.
    const notice = document.createElement('div');
    notice.className = 'ct-gm-notice';
    notice.id = 'ct-gm-notice';
    notice.style.display = 'none';
    panel.appendChild(notice);

    // In-house ad banner container (below notice); non-dismissible (design §6).
    const ad = document.createElement('div');
    ad.className = 'ct-gm-ad';
    ad.id = 'ct-gm-ad';
    ad.style.display = 'none';
    panel.appendChild(ad);

    return panel;
  }

  function buildLimitRow(id, label, util, resetAt, predUtil) {
    const row = document.createElement('div');
    row.className = 'ct-gm-limit';
    row.dataset.limitId = id;

    const color = CORE.gaugeColor(util);
    const pctText = `${Math.round(util)}%`;
    const showPred = predUtil != null && predUtil - util >= CORE.PRED_MIN_DELTA;

    let predHtml = '';
    if (showPred) {
      const predColor = CORE.gaugeColor(predUtil);
      const predText = predUtil >= 100 ? '100%+' : `${Math.round(predUtil)}%`;
      predHtml = `<span class="ct-gm-arrow">→</span><span class="ct-gm-pred" style="color:${predColor}">${predText}</span>`;
    }

    // Reset cell — single-sourced across all three sidebars (CORE.buildResetCellInner):
    // countdown + compact absolute two lines, or an idle hint when the window has no reset.
    // Capability-guarded: a stale __ctUsageCore without the builder falls back to the
    // plain countdown line instead of throwing.
    const resetInner = CORE.buildResetCellInner
      ? CORE.buildResetCellInner(resetAt, _lang)
      : (resetAt ? `<span class="ct-reset-count">${CORE.formatCountdown(resetAt, _lang)}</span>` : '');

    const labelRow = document.createElement('div');
    labelRow.className = 'ct-gm-label-row';
    labelRow.innerHTML = `
      <span class="ct-gm-label-left">
        <span class="ct-gm-name">${CORE.escapeHtml(label)}</span>
        <span class="ct-gm-pct" style="color:${color}">${pctText}</span>${predHtml}
      </span>
      <span class="ct-gm-reset" data-reset="${resetAt || ''}">${resetInner}</span>
    `;
    row.appendChild(labelRow);

    const clampedUtil = Math.min(util, 100);
    const barColor = id === '5h' ? '#06b6d4' : '#7c3aed';
    let barHtml = `<div class="ct-gm-bar-track"><div class="ct-gm-bar-fill" style="width:${clampedUtil}%;background:${barColor}"></div></div>`;
    if (showPred) {
      const clampedPred = Math.min(predUtil, 100);
      const predColor = CORE.gaugeColor(predUtil);
      barHtml += `<div class="ct-gm-bar-pred-fill" style="left:${clampedUtil}%;width:${clampedPred - clampedUtil}%;color:${predColor}"></div>`;
      barHtml += `<div class="ct-gm-bar-marker" style="left:${clampedPred}%;background:${predColor}"></div>`;
    }
    const bar = document.createElement('div');
    bar.className = 'ct-gm-bar';
    bar.innerHTML = barHtml;
    row.appendChild(bar);

    // Styled tooltips (mirror claude.ai): row → what the limit means, pred span →
    // how the estimate is derived, reset span → absolute reset time (recalculated
    // on each hover so it never goes stale between the 1s countdown ticks).
    attachTip(row, id === '5h' ? 'tip_5h' : 'tip_7d');
    attachTip(row.querySelector('.ct-gm-pred'), 'tip_pred', true);
    if (resetAt) attachTip(row.querySelector('.ct-gm-reset'), () => CORE.formatResetAbsolute(resetAt, _lang), true, true);

    return row;
  }

  // The notice and ad containers are children of the PANEL, not of #ct-gm-content, so a
  // body re-render never wipes them — but a re-MOUNT does: buildPanel() mints fresh empty
  // ones. Both banners therefore have to be re-hydrated after any (re)build, and on EVERY
  // exit of renderPanelBody(), including its early returns for the no-limit / no-data
  // states. (Gemini Workspace users sit in the no-limit branch permanently — miss this and
  // they never see an ad until the next 3-min fetchAds tick.)
  function syncBanners() {
    if (_notices.length > 0) renderInlineNotice();
    if (_ads.length > 0) renderInlineAd();
  }

  function renderContent() {
    renderPanelBody();
    syncBanners();
  }

  function renderPanelBody() {
    const content = document.getElementById('ct-gm-content');
    if (!content) return;

    // No-limit plan (Workspace/Business/Enterprise): show "no usage limits".
    // Checked BEFORE the both-null guard because these plans report 0% windows
    // (h5/d7 are 0, not null), so the collecting-guard would otherwise render "0%".
    if (_data && _data.noLimits) {
      content.innerHTML = `<div class="ct-gm-message">${CORE.escapeHtml(t('no_limit'))}</div>`;
      return;
    }
    if (!_data || (_data.h5 == null && _data.d7 == null)) {
      content.innerHTML = `<div class="ct-gm-message">${CORE.escapeHtml(t('no_data'))}</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    if (_data.h5 != null) frag.appendChild(buildLimitRow('5h', t('session'), _data.h5, _data.r5, _data.pred5h));
    if (_data.d7 != null) frag.appendChild(buildLimitRow('7d', t('weekly'), _data.d7, _data.r7, _data.pred7d));

    const footer = document.createElement('div');
    footer.className = 'ct-gm-footer';
    const planText = _data.plan ? `<span class="ct-gm-plan">${CORE.escapeHtml(CORE.planDisplayName(_data.plan, 'gemini'))}</span>` : '<span></span>';
    footer.innerHTML = `
      ${planText}
      <span class="ct-gm-actions">
        <button class="ct-gm-bell-btn" title="${CORE.escapeHtml(t('notices'))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
          <span class="ct-gm-bell-badge" id="ct-gm-bell-badge" style="display:none"></span>
        </button>
        <a href="${SITE_URL}/dashboard/?utm_source=${UTM}" target="_blank" rel="noopener" title="${CORE.escapeHtml(t('dashboard'))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </a>
        <button class="ct-gm-settings-btn" title="${CORE.escapeHtml(t('settings'))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
        </button>
      </span>
    `;
    footer.querySelector('.ct-gm-bell-btn').addEventListener('click', () => {
      try { window.open(CORE.NOTICE_BASE + _lang + '?utm_source=' + UTM, '_blank'); } catch { /* */ }
      if (_notices.length > 0) {
        _lastSeenId = _notices[0].id;
        try { chrome.storage.local.set({ ct_last_seen_notice_id: _lastSeenId }); } catch { /* */ }
        updateBellBadge();
      }
    });
    footer.querySelector('.ct-gm-settings-btn').addEventListener('click', () => {
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
    if (!isCurrent() || !_enabled || !CORE.fetchAnnouncements) return; // skip while disabled
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
    if (!isCurrent() || !_enabled || !CORE.selectAds) return; // skip while disabled
    try {
      const fresh = await CORE.selectAds({ placement: CORE.PLACEMENTS.GEMINI_SIDEBAR, lang: _lang });
      if (!isCurrent()) return; // superseded mid-flight — don't mutate shared DOM
      _ads = fresh;
      renderInlineAd();
    } catch { /* silent — no ads this round */ }
  }

  function renderInlineAd() {
    const container = document.getElementById('ct-gm-ad');
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
        window.open(url + (url.includes('?') ? '&' : '?') + 'utm_source=gemini_sidebar', '_blank');
      });
    });
  }

  function updateBellBadge() {
    const badge = document.getElementById('ct-gm-bell-badge');
    if (!badge) return;
    const unseen = CORE.getUnseenCount(_notices, _lastSeenId);
    if (unseen > 0) { badge.textContent = unseen; badge.style.display = ''; }
    else { badge.style.display = 'none'; }
  }

  function renderInlineNotice() {
    const container = document.getElementById('ct-gm-notice');
    if (!container) return;
    chrome.storage.local.get({ ct_dismissed_notices: [] }, (result) => {
      if (!isCurrent()) return; // superseded by a newer injection since the async read
      const dismissed = result.ct_dismissed_notices || [];
      const active = _notices.filter(n => !dismissed.includes(n.id));
      if (active.length === 0) { container.innerHTML = ''; container.style.display = 'none'; return; }
      const latest = active[0];
      container.style.display = '';
      container.innerHTML = `
        <span class="ct-gm-notice-icon">📢</span>
        <span class="ct-gm-notice-text">${CORE.escapeHtml(latest.title || '')}</span>
        <button class="ct-gm-notice-close">×</button>
      `;
      container.querySelector('.ct-gm-notice-text').addEventListener('click', () => {
        let url = latest.url || '';
        try { const u = new URL(url); if (u.protocol !== 'http:' && u.protocol !== 'https:') url = ''; } catch { url = ''; }
        if (!url) url = CORE.NOTICE_BASE + _lang;
        window.open(url + (url.includes('?') ? '&' : '?') + 'utm_source=' + UTM, '_blank');
      });
      container.querySelector('.ct-gm-notice-close').addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.storage.local.get({ ct_dismissed_notices: [] }, (r) => {
          if (!isCurrent()) return; // superseded since the click
          const arr = r.ct_dismissed_notices || [];
          if (!arr.includes(latest.id)) arr.push(latest.id);
          chrome.storage.local.set({ ct_dismissed_notices: arr }, () => { if (isCurrent()) renderInlineNotice(); });
        });
      });
    });
  }

  function updateCountdowns() {
    // Update only the countdown sub-span; the static absolute-time line must survive.
    document.querySelectorAll(`#${PANEL_ID} .ct-gm-reset[data-reset]`).forEach(el => {
      const r = el.dataset.reset;
      if (!r) return;
      const countEl = el.querySelector('.ct-reset-count');
      if (countEl) countEl.textContent = CORE.formatCountdown(r, _lang);
    });
  }

  // ── Mount / unmount ──
  // Self-healing: because Gemini swaps nav subtrees on collapse/expand, an existing
  // panel can end up inside a now-hidden subtree. So we don't just check "does the
  // panel exist?" — we ensure it lives inside the CURRENT valid anchor and is laid
  // out. If there is no usable (wide, visible) anchor — e.g. the icon-rail — we
  // remove the panel rather than leave it squished or stranded in a hidden tree.
  function place(el, anchor) {
    if (anchor.ref) anchor.parent.insertBefore(el, anchor.ref);
    else anchor.parent.appendChild(el);
  }
  function mount() {
    const anchor = findSidebarAnchor();
    const existing = document.getElementById(PANEL_ID);
    if (!anchor) { if (existing) existing.remove(); _mounted = false; warnNoAnchor(); return; }
    if (existing) {
      // Move it if it drifted into the wrong parent or became invisible (hidden subtree).
      if (existing.parentElement !== anchor.parent || existing.getClientRects().length === 0) {
        place(existing, anchor);
      }
      _mounted = true;
      return;
    }
    const panel = buildPanel();
    place(panel, anchor); // insert first so renderContent()'s getElementById('ct-gm-content') resolves
    renderContent();
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
    mount(); // idempotent + self-healing (creates, moves, or removes as needed)
    applyRailVisibility(); // hide when the panel sits in the narrow icon-rail
  }

  // Release everything this instance owns beyond its timers/observers (those are
  // cleared by the guard, which calls this exactly once): DOM, tooltip, the empty-
  // data retry, and the runtime/storage listeners — else re-injection accumulates
  // them. Reached both when a newer injection supersedes us and when the Gemini
  // host permission is revoked (teardown() is called directly there).
  function releaseInstance() {
    _enabled = false;
    unmount();
    removeTooltip();
    clearEmptyRetry();
    _observer = null;
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* context dead */ }
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { /* context dead */ }
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  // ── Data ──
  let _reqSeq = 0;
  // When there's no Gemini data yet (first load: collection hasn't finished, or its
  // post-collect SIDEBAR_USAGE_REFRESH landed before this panel mounted), poll fast
  // for a short while instead of waiting the full REFRESH_INTERVAL_MS — otherwise the
  // panel sits empty for up to a minute after opening the tab.
  const EMPTY_RETRY_MS = 4000;
  const EMPTY_RETRY_MAX = 15; // ~1 min of fast polling before falling back to normal
  let _emptyRetries = 0;
  let _emptyRetryTimer = null;
  function clearEmptyRetry() {
    if (_emptyRetryTimer) { clearTimeout(_emptyRetryTimer); _emptyRetryTimer = null; }
    _emptyRetries = 0;
  }
  function scheduleEmptyRetry() {
    if (_emptyRetryTimer || _emptyRetries >= EMPTY_RETRY_MAX) return;
    _emptyRetries++;
    _emptyRetryTimer = setTimeout(() => { _emptyRetryTimer = null; requestUsageData(); }, EMPTY_RETRY_MS);
  }
  function requestUsageData() {
    if (!isCurrent() || !_enabled) return; // don't poll while disabled
    const seq = ++_reqSeq;
    try {
      chrome.runtime.sendMessage({ type: 'GET_SIDEBAR_USAGE', provider: PROVIDER, orgId: null }, (res) => {
        if (!isCurrent()) return; // a newer instance superseded this one mid-flight
        if (seq !== _reqSeq) return;
        if (chrome.runtime.lastError) { scheduleEmptyRetry(); return; } // SW cold start — retry soon, don't wait 60s
        if (res && res.revoked) { teardown(); return; } // Gemini permission gone
        if (!res) { // explicit empty (no Gemini data yet) — keep display and retry soon
          if (_data !== null) { _data = null; renderContent(); }
          scheduleEmptyRetry();
          return;
        }
        clearEmptyRetry(); // got data — stop fast-polling
        if (_data && _data.h5 === res.h5 && _data.d7 === res.d7 && _data.r5 === res.r5 &&
            _data.r7 === res.r7 && _data.pred5h === res.pred5h && _data.pred7d === res.pred7d &&
            _data.plan === res.plan && _data.noLimits === res.noLimits) return;
        _data = res;
        // _lang is driven by the user's extension language setting
        // (chrome.storage.sync `lang`, navigator fallback), not res.lang.
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
    if (changes.geminiSidebarUsageEnabled) {
      _enabled = changes.geminiSidebarUsageEnabled.newValue !== false;
      if (!_enabled) { clearEmptyRetry(); unmount(); } else requestUsageData();
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
  let _lastObserverRun = 0;
  const OBSERVER_THROTTLE_MS = 200;
  function startObserver() {
    if (_observer) return;
    // DOM churns constantly (the Recents list alone is large), so throttle. On each
    // burst we run the self-healing mount() — this re-homes the panel when Gemini
    // swaps the rail/expanded/overlay nav subtrees, giving a sub-second response to
    // collapse/expand instead of waiting for the 1s RAF tick.
    _observer = new MutationObserver(() => {
      if (!isCurrent()) { teardown(); return; }
      if (!_enabled) return;
      const now = Date.now();
      if (now - _lastObserverRun < OBSERVER_THROTTLE_MS) return;
      _lastObserverRun = now;
      mount();
      applyRailVisibility();
    });
    _guard.addObserver(_observer);
    _observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Init ──
  function init() {
    chrome.storage.local.get({ ct_last_seen_notice_id: null }, (local) => {
      _lastSeenId = local.ct_last_seen_notice_id;
    });
    chrome.storage.sync.get({ lang: 'auto', geminiSidebarUsageEnabled: true }, (cfg) => {
      _lang = cfg.lang === 'auto' ? CORE.detectLang() : cfg.lang;
      _enabled = cfg.geminiSidebarUsageEnabled !== false;
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
