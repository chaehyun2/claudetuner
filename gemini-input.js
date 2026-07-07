// Claude Tuner — Gemini Input Usage Strip
// Injects a single compact usage line as a full-width row directly BELOW the
// Gemini composer (a sibling of the composer's input-area wrapper), mirroring the
// claude.ai / ChatGPT input strips.
//
// Gemini's live DOM is not known in this repo, so composer detection is
// deliberately resilient: multiple candidate selectors + a MutationObserver
// remount + a timed fallback loop. When no mount anchor is found we log a
// throttled console.warn('[Claude Tuner]') so the selectors can be hardened
// against the real page.

(() => {
  'use strict';

  const CORE = globalThis.__ctUsageCore;
  if (!CORE) return; // usage-shared.js must load first

  // Generation token: each (re)injection bumps it; only the newest instance is
  // current. Stale instances (after extension update / dev reload) detect the
  // mismatch and tear down, so re-injection always takes over cleanly.
  const _gen = (globalThis.__ctGmInputGen = (globalThis.__ctGmInputGen || 0) + 1);
  const isCurrent = () => _gen === globalThis.__ctGmInputGen && CORE.isContextValid();

  const STRIP_ID = 'ct-gm-strip';
  const SITE_URL = 'https://claudetuner.com';
  const CONTACT_URL = 'https://tally.so/r/q4dyQk'; // shared feedback/inquiry form (same as popup / other providers)
  const MOUNT_INTERVAL_MS = 1000;
  const COUNTDOWN_INTERVAL_MS = 1000;
  const REFRESH_INTERVAL_MS = 60000;
  const WARN_THROTTLE_MS = 15000;
  const PROVIDER = 'gemini';

  // Composer candidates (ASSUMED — verify against live Gemini DOM).
  const COMPOSER_SELECTORS = [
    'rich-textarea .ql-editor[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    '.ql-editor[contenteditable="true"]',
    'textarea',
  ];
  // Wrapper candidates to hang the strip below (ASSUMED — verify).
  const WRAPPER_SELECTORS = ['input-area-v2', '.input-area', '[class*="input-area"]'];

  // ── State ──
  let _enabled = null;
  let _mounted = false;
  let _data = null;
  let _lang = 'en';
  let _intervals = [];
  let _lastWarn = 0;
  let _name = '';  // account name/email for prefilling the inquiry form
  let _email = '';

  const I18N = {
    ko: { session: '5시간 사용률', no_data: '수집 중...', no_limit: '현재는 5시간·7일 사용량 제한 없음', reset_soon: '곧 리셋', est_reset: '리셋 시 예상', settings: '설정', contact: '문의하기' },
    en: { session: '5-hour usage', no_data: 'Collecting...', no_limit: 'Currently no 5h/7d usage limits', reset_soon: 'Resetting soon', est_reset: 'est. at reset', settings: 'Settings', contact: 'Feedback' },
  };
  function t(key) { return (I18N[_lang] || I18N.en)[key] || I18N.en[key] || key; }

  // Tally inquiry form prefill (same field keys as the other providers' strips).
  function contactUrl() {
    if (!_name && !_email) return CONTACT_URL;
    const p = new URLSearchParams();
    if (_name) p.set('user_name', _name);
    if (_email) p.set('user_email', _email);
    return `${CONTACT_URL}?${p.toString()}`;
  }

  function loadAccount() {
    try {
      chrome.storage.local.get(['accountCache', 'independentAccount'], (r) => {
        if (!isCurrent()) return;
        const a = r.accountCache || {};
        const ia = r.independentAccount || {};
        _name = a.name || ia.name || '';
        _email = a.email || ia.email || '';
        renderStrip(); // refresh the prefilled href
      });
    } catch { /* context dead */ }
  }

  // Clear reset wording (with a clock icon), mirroring claude.ai / ChatGPT.
  function resetLabel(resetAt) {
    const diff = new Date(resetAt).getTime() - Date.now();
    if (diff <= 0) return `⏱ ${t('reset_soon')}`;
    const time = CORE.formatCountdown(resetAt, _lang).replace(/^⏱\s*/, '');
    return _lang === 'ko' ? `⏱ ${time} 뒤 리셋` : `⏱ resets in ${time}`;
  }

  // ── Theme ──
  // Gemini uses <body class="dark-theme"> / <html dark>; fall back to the OS
  // preference. Detect all three so the strip tracks whichever the page uses.
  function isDarkTheme() {
    const b = document.body, h = document.documentElement;
    // An explicit Gemini light theme always wins over the OS preference, so the
    // strip never renders dark while the page is light (mirrors gemini-usage.css's
    // `body:not(.light-theme)` guard on the prefers-color-scheme fallback).
    if ((b && b.classList.contains('light-theme')) ||
        (h && (h.classList.contains('light-theme') || h.getAttribute('data-theme') === 'light'))) return false;
    if (b && b.classList.contains('dark-theme')) return true;
    if (h && (h.hasAttribute('dark') || h.classList.contains('dark-theme') ||
              h.getAttribute('data-theme') === 'dark')) return true;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function syncTheme() {
    const strip = document.getElementById(STRIP_ID);
    if (!strip) return;
    const dark = isDarkTheme();
    strip.classList.toggle('theme-dark', dark);
    // theme-light disables the prefers-color-scheme:dark CSS fallback when the page
    // is explicitly light on an OS-dark system.
    strip.classList.toggle('theme-light', !dark);
  }

  // ── Anchor ──
  function findEditor() {
    for (const sel of COMPOSER_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findAnchor() {
    const editor = findEditor();
    if (!editor) return null;
    // Prefer a recognizable input-area wrapper ancestor as the sibling target.
    for (const sel of WRAPPER_SELECTORS) {
      const wrap = editor.closest(sel);
      if (wrap && wrap.parentNode) return wrap;
    }
    // Fallback: climb a few levels to a stable block container (stop at FORM).
    let el = editor;
    for (let i = 0; i < 6 && el.parentElement; i++) {
      el = el.parentElement;
      if (el.tagName === 'FORM') break;
    }
    return el && el.parentNode ? el : null;
  }

  function warnNoAnchor() {
    const now = Date.now();
    if (now - _lastWarn < WARN_THROTTLE_MS) return;
    _lastWarn = now;
    console.warn('[Claude Tuner] Gemini composer anchor not found — input strip not mounted. Selectors may need hardening against the live page.');
  }

  // ── Build / render ──
  function buildStrip() {
    const strip = document.createElement('div');
    strip.id = STRIP_ID;
    strip.className = 'ct-gm-strip ' + (isDarkTheme() ? 'theme-dark' : 'theme-light');
    renderStripInto(strip);
    return strip;
  }

  function seg(text, color) {
    return `<span class="ct-gm-strip-seg"${color ? ` style="color:${color}"` : ''}>${CORE.escapeHtml(text)}</span>`;
  }

  // A label + percent followed by a compact inline gauge bar (current fill +
  // optional prediction marker), mirroring the other providers' input strips.
  function metric(label, util, predUtil) {
    const color = CORE.gaugeColor(util);
    const clamped = Math.min(util, 100);
    const showPred = predUtil != null && predUtil - util >= CORE.PRED_MIN_DELTA;
    const predColor = showPred ? CORE.gaugeColor(predUtil) : null;
    const clampedPred = showPred ? Math.min(predUtil, 100) : 0;
    // Prediction fill (diagonal stripe) lives inside the clipped track between the
    // current fill and the predicted level; the marker sits on top of the bar.
    let bar = `<span class="ct-gm-strip-bar"><span class="ct-gm-strip-bar-track"><span class="ct-gm-strip-bar-fill" style="width:${clamped}%;background:${color}"></span>`;
    if (showPred) {
      bar += `<span class="ct-gm-strip-bar-pred-fill" style="left:${clamped}%;width:${clampedPred - clamped}%;color:${predColor}"></span>`;
    }
    bar += `</span>`;
    if (showPred) {
      bar += `<span class="ct-gm-strip-bar-marker" style="left:${clampedPred}%;background:${predColor}"></span>`;
    }
    bar += `</span>`;
    return seg(`${label} ${Math.round(util)}%`, color) + bar;
  }

  const GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>';
  // Chat-bubble icon for 문의하기 (matches the popup's Feedback button / other strips).
  const CONTACT_SVG = '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zm-4 0H9v2h2V9z" clip-rule="evenodd"/></svg>';

  function renderStripInto(strip) {
    // Collecting guard: no data yet. Transient state, so no gear/contact —
    // just the muted placeholder. Checked AFTER noLimits below because no-limit
    // plans report a 0% window (h5 is 0, not null) and must not fall in here.
    if (!(_data && _data.noLimits) && (!_data || _data.h5 == null)) {
      strip.innerHTML = `<div class="ct-gm-strip-inner"><span class="ct-gm-strip-seg ct-gm-strip-muted">${CORE.escapeHtml(t('no_data'))}</span></div>`;
      return;
    }
    let logoUrl = '';
    try { logoUrl = chrome.runtime.getURL('icons/icon16.png'); } catch { /* context dead */ }
    const dot = '<span class="ct-gm-strip-dot">·</span>';
    let main = logoUrl ? `<img src="${logoUrl}" class="ct-gm-strip-logo" alt="CT">` : '';
    if (_data && _data.noLimits) {
      // No-limit plan (Workspace/Business/Enterprise 'Work' seat): these report a
      // pinned 0% window and aren't consumer-metered, so show "no usage limits ·
      // <plan>" instead of a gauge. Still falls through to the shared markup below
      // so the settings + contact buttons stay available.
      const msg = t('no_limit') + (_data.plan ? ` · ${CORE.planDisplayName(_data.plan, 'gemini')}` : '');
      main += `<span class="ct-gm-strip-seg ct-gm-strip-muted">${CORE.escapeHtml(msg)}</span>`;
    } else {
      // 5h current usage % + gauge bar (with prediction marker).
      main += metric(t('session'), _data.h5, _data.pred5h);
      // ⏱ N 뒤 리셋
      if (_data.r5) {
        main += `${dot}<span class="ct-gm-strip-seg ct-gm-strip-reset" data-reset="${_data.r5}" title="${CORE.escapeHtml(CORE.formatResetAbsolute(_data.r5, _lang))}">${CORE.escapeHtml(resetLabel(_data.r5))}</span>`;
      }
      // 리셋 시 예상 N% — predicted util at reset, percent colored by status.
      if (_data.pred5h != null) {
        const predColor = CORE.gaugeColor(_data.pred5h);
        const predText = _data.pred5h >= 100 ? '100%+' : `${Math.round(_data.pred5h)}%`;
        main += `${dot}<span class="ct-gm-strip-seg"><span class="ct-gm-strip-muted">${CORE.escapeHtml(t('est_reset'))}</span> <span style="color:${predColor}">${predText}</span></span>`;
      }
      if (_data.plan) {
        main += `${dot}<span class="ct-gm-strip-seg ct-gm-strip-muted">${CORE.escapeHtml(CORE.planDisplayName(_data.plan, 'gemini'))}</span>`;
      }
    }
    strip.innerHTML =
      `<div class="ct-gm-strip-inner">` +
        `<a class="ct-gm-strip-main" href="${SITE_URL}/dashboard/?utm_source=gemini_input" target="_blank" rel="noopener">${main}</a>` +
        `<button class="ct-gm-strip-gear" title="${CORE.escapeHtml(t('settings'))}" aria-label="${CORE.escapeHtml(t('settings'))}">${GEAR_SVG}</button>` +
        `<a class="ct-gm-strip-gear ct-gm-strip-contact" href="${contactUrl()}" target="_blank" rel="noopener" title="${CORE.escapeHtml(t('contact'))}" aria-label="${CORE.escapeHtml(t('contact'))}">${CONTACT_SVG}</a>` +
      `</div>`;
    const gear = strip.querySelector('.ct-gm-strip-gear');
    if (gear) gear.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS', hash: 'page-usage' }); } catch { /* context dead */ }
    });
  }

  function renderStrip() {
    const strip = document.getElementById(STRIP_ID);
    if (strip) renderStripInto(strip);
  }

  function updateCountdowns() {
    document.querySelectorAll(`#${STRIP_ID} .ct-gm-strip-reset[data-reset]`).forEach(el => {
      const r = el.dataset.reset;
      if (r) el.textContent = resetLabel(r);
    });
  }

  // ── Mount / unmount ──
  // Self-healing (like gemini-sidebar.js): Gemini swaps/duplicates composer
  // subtrees, so an existing strip can end up detached or stranded in a hidden
  // subtree. Re-home it to the current composer instead of assuming "exists = ok".
  function mount() {
    const anchor = findAnchor();
    const existing = document.getElementById(STRIP_ID);
    if (!anchor) { if (existing) existing.remove(); _mounted = false; warnNoAnchor(); return; }
    if (existing) {
      // Move it if it drifted from the current composer or became invisible.
      if (existing.previousSibling !== anchor || existing.getClientRects().length === 0) {
        anchor.parentNode.insertBefore(existing, anchor.nextSibling);
      }
      _mounted = true;
      return;
    }
    // Full-width row directly below the composer wrapper.
    const strip = buildStrip();
    anchor.parentNode.insertBefore(strip, anchor.nextSibling);
    _mounted = true;
  }

  function unmount() {
    const el = document.getElementById(STRIP_ID);
    if (el) el.remove();
    _mounted = false;
  }

  function ensureMounted() {
    if (!_enabled) { unmount(); return; }
    if (!isCurrent()) return;
    mount(); // idempotent + self-healing (creates, re-homes, or removes as needed)
  }

  // Fully stop this instance (superseded by a newer injection, or Gemini host
  // permission revoked): remove DOM, clear timers, disconnect observers, and
  // unregister runtime/storage listeners (else reinjection accumulates them).
  function teardown() {
    _enabled = false;
    unmount();
    clearEmptyRetry();
    _intervals.forEach(clearInterval);
    _intervals = [];
    if (_observer) { _observer.disconnect(); _observer = null; }
    if (_themeObserver) { _themeObserver.disconnect(); _themeObserver = null; }
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* context dead */ }
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { /* context dead */ }
  }

  // ── Data ──
  let _reqSeq = 0;
  // Same bounded fast-retry as the sidebar: fill within seconds when the first
  // request hits no-data or a service-worker cold-start error, instead of waiting
  // the full REFRESH_INTERVAL_MS.
  const EMPTY_RETRY_MS = 4000;
  const EMPTY_RETRY_MAX = 15;
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
        if (chrome.runtime.lastError) { scheduleEmptyRetry(); return; } // SW cold start — retry soon
        if (res && res.revoked) { teardown(); return; } // Gemini permission gone
        if (!res) { // explicit empty (no Gemini data yet) — clear stale display + retry soon
          if (_data !== null) { _data = null; renderStrip(); }
          scheduleEmptyRetry();
          return;
        }
        clearEmptyRetry(); // got data — stop fast-polling
        if (_data && _data.h5 === res.h5 && _data.d7 === res.d7 && _data.r5 === res.r5 &&
            _data.r7 === res.r7 && _data.pred5h === res.pred5h && _data.pred7d === res.pred7d &&
            _data.plan === res.plan && _data.noLimits === res.noLimits) return;
        _data = res;
        // _lang follows the user's extension language setting, not res.lang.
        renderStrip();
      });
    } catch { /* context dead */ }
  }

  function onRuntimeMessage(message) {
    if (!isCurrent()) return;
    if (message.type === 'SIDEBAR_USAGE_REFRESH') requestUsageData();
  }

  function onStorageChanged(changes, area) {
    if (!isCurrent()) return;
    if (area === 'local') {
      // Account name/email changed → refresh the 문의하기 prefill (mirrors ChatGPT).
      if (changes.accountCache || changes.independentAccount) loadAccount();
      return;
    }
    if (area !== 'sync') return;
    if (changes.geminiInputUsageEnabled) {
      _enabled = changes.geminiInputUsageEnabled.newValue !== false;
      if (!_enabled) { clearEmptyRetry(); unmount(); } else requestUsageData();
    }
    if (changes.lang) {
      _lang = changes.lang.newValue === 'auto' ? CORE.detectLang() : changes.lang.newValue;
      renderStrip();
    }
  }

  // ── Loop + observers ──
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

  // The composer subtree mutates constantly; coalesce remount checks into one
  // rAF tick per burst. The 1s tick above still guarantees remount if missed.
  let _observer = null;
  let _remountScheduled = false;
  function startObserver() {
    if (_observer) return;
    _observer = new MutationObserver(() => {
      if (!isCurrent()) { teardown(); return; }
      if (!_enabled) return;
      if (_remountScheduled) return;
      _remountScheduled = true;
      requestAnimationFrame(() => {
        _remountScheduled = false;
        if (!isCurrent()) return; // a re-injection may have superseded us since scheduling
        mount(); // self-healing: creates if missing, re-homes if the composer swapped, else no-op
      });
    });
    _observer.observe(document.body, { childList: true, subtree: true });
  }

  // Theme observer — Gemini toggles dark mode via body/html class/attribute.
  let _themeObserver = null;
  function startThemeObserver() {
    if (_themeObserver) return;
    _themeObserver = new MutationObserver(() => { if (isCurrent()) syncTheme(); });
    _themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'dark', 'data-theme'] });
    if (document.body) {
      _themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    }
  }

  // ── Init ──
  function init() {
    chrome.storage.sync.get({ lang: 'auto', geminiInputUsageEnabled: true }, (cfg) => {
      _lang = cfg.lang === 'auto' ? CORE.detectLang() : cfg.lang;
      _enabled = cfg.geminiInputUsageEnabled !== false;
      if (_enabled) requestUsageData();
    });
    loadAccount(); // prefill 문의하기 form with the user's name/email

    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    chrome.storage.onChanged.addListener(onStorageChanged);

    requestAnimationFrame(tick);
    startObserver();
    startThemeObserver();
    _intervals.push(setInterval(updateCountdowns, COUNTDOWN_INTERVAL_MS));
    _intervals.push(setInterval(requestUsageData, REFRESH_INTERVAL_MS));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
