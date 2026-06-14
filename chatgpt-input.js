// Claude Tuner — ChatGPT Input Usage Strip
// Injects a single compact usage line as a full-width row directly BELOW the
// composer box (a sibling of the composer form, like claude.ai's usage row).
// This avoids fighting the composer's internal CSS grid (which moves/auto-places
// items between its default and expanded templates). Falls back to a line above
// the bottom disclaimer ("ChatGPT can make mistakes...") if the form isn't found.

(() => {
  'use strict';

  const CORE = globalThis.__ctUsageCore;
  if (!CORE) return; // usage-shared.js must load first

  // Generation token: each (re)injection bumps it; only the newest instance is
  // current. Stale instances (after extension update / dev reload) detect the
  // mismatch and tear down, so re-injection always takes over cleanly.
  const _gen = (globalThis.__ctCgInputGen = (globalThis.__ctCgInputGen || 0) + 1);
  const isCurrent = () => _gen === globalThis.__ctCgInputGen && CORE.isContextValid();

  const STRIP_ID = 'ct-cg-strip';
  const SITE_URL = 'https://claudetuner.com';
  const CONTACT_URL = 'https://tally.so/r/q4dyQk'; // shared feedback/inquiry form (same as popup)
  const MOUNT_INTERVAL_MS = 1000;
  const COUNTDOWN_INTERVAL_MS = 1000;
  const REFRESH_INTERVAL_MS = 60000;
  const PROVIDER = 'chatgpt';

  // ── State ──
  let _enabled = null;
  let _mounted = false;
  let _data = null;
  let _lang = 'en';
  let _intervals = [];
  let _name = '';  // account name/email for prefilling the inquiry form
  let _email = '';

  // Tally inquiry form prefill (same field keys as the dashboard error-report).
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

  const I18N = {
    ko: { session: '5h', no_data: '수집 중...', reset_soon: '곧 리셋', est_reset: '리셋 시 예상', settings: '설정', contact: '문의하기' },
    en: { session: '5h', no_data: 'Collecting...', reset_soon: 'Resetting soon', est_reset: 'est. at reset', settings: 'Settings', contact: 'Feedback' },
  };
  function t(key) { return (I18N[_lang] || I18N.en)[key] || I18N.en[key] || key; }

  // Clear reset wording (with a clock icon), mirroring claude.ai: "⏱ 1h 54m 뒤 리셋"
  // (ko) / "⏱ resets in 1h 54m" (en).
  function resetLabel(resetAt) {
    const diff = new Date(resetAt).getTime() - Date.now();
    if (diff <= 0) return `⏱ ${t('reset_soon')}`;
    const time = CORE.formatCountdown(resetAt, _lang).replace(/^⏱\s*/, '');
    return _lang === 'ko' ? `⏱ ${time} 뒤 리셋` : `⏱ resets in ${time}`;
  }

  // ── Anchor ──
  // Preferred: a full-width row directly below the composer box (sibling of the
  // composer form). Fallback: just above the bottom disclaimer line.
  function findAnchor() {
    const form = document.querySelector('form[data-type="unified-composer"]');
    if (form && form.parentNode) return { type: 'belowbox', el: form };
    const disclaimer = findDisclaimer();
    if (disclaimer && disclaimer.parentNode) return { type: 'disclaimer', el: disclaimer };
    return null;
  }

  function findDisclaimer() {
    const candidates = document.querySelectorAll('div[class*="min-h-8"][class*="text-xs"]');
    for (const el of candidates) {
      const cls = el.className || '';
      if (cls.includes('w-full') && cls.includes('justify-center') &&
          !el.closest('nav') && !el.closest('#stage-sidebar-tiny-bar')) {
        return el;
      }
    }
    return null;
  }

  // ── Build ──
  function buildStrip() {
    const strip = document.createElement('div');
    strip.id = STRIP_ID;
    strip.className = 'ct-cg-strip';
    renderStripInto(strip);
    return strip;
  }

  function seg(text, color) {
    const s = `<span class="ct-cg-strip-seg"${color ? ` style="color:${color}"` : ''}>${CORE.escapeHtml(text)}</span>`;
    return s;
  }

  // A label + percent followed by a compact inline gauge bar (current fill +
  // optional prediction marker), mirroring the claude.ai input strip.
  function metric(label, util, predUtil) {
    const color = CORE.gaugeColor(util);
    const clamped = Math.min(util, 100);
    const showPred = predUtil != null && predUtil - util >= CORE.PRED_MIN_DELTA;
    let bar = `<span class="ct-cg-strip-bar"><span class="ct-cg-strip-bar-track"><span class="ct-cg-strip-bar-fill" style="width:${clamped}%;background:${color}"></span></span>`;
    if (showPred) {
      const clampedPred = Math.min(predUtil, 100);
      bar += `<span class="ct-cg-strip-bar-marker" style="left:${clampedPred}%;background:${CORE.gaugeColor(predUtil)}"></span>`;
    }
    bar += `</span>`;
    return seg(`${label} ${Math.round(util)}%`, color) + bar;
  }

  const GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>';
  // Chat-bubble icon (matches the popup's Feedback button).
  const CONTACT_SVG = '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zm-4 0H9v2h2V9z" clip-rule="evenodd"/></svg>';

  function renderStripInto(strip) {
    if (!_data || _data.h5 == null) {
      strip.innerHTML = `<span class="ct-cg-strip-seg ct-cg-strip-muted">${CORE.escapeHtml(t('no_data'))}</span>`;
      return;
    }
    const logoUrl = chrome.runtime.getURL('icons/icon16.png');
    const dot = '<span class="ct-cg-strip-dot">·</span>';
    let main = `<img src="${logoUrl}" class="ct-cg-strip-logo" alt="CT">`;
    // 5h current usage % + gauge bar (with prediction marker).
    main += metric(t('session'), _data.h5, _data.pred5h);
    // ⏱ N 뒤 리셋
    if (_data.r5) {
      main += `${dot}<span class="ct-cg-strip-seg ct-cg-strip-reset" data-reset="${_data.r5}" title="${CORE.escapeHtml(CORE.formatResetAbsolute(_data.r5, _lang))}">${CORE.escapeHtml(resetLabel(_data.r5))}</span>`;
    }
    // 리셋 시 예상 N% — predicted util at reset, percent colored by status.
    if (_data.pred5h != null) {
      const predColor = CORE.gaugeColor(_data.pred5h);
      const predText = _data.pred5h >= 100 ? '100%+' : `${Math.round(_data.pred5h)}%`;
      main += `${dot}<span class="ct-cg-strip-seg"><span class="ct-cg-strip-muted">${CORE.escapeHtml(t('est_reset'))}</span> <span style="color:${predColor}">${predText}</span></span>`;
    }
    if (_data.plan) {
      main += `${dot}<span class="ct-cg-strip-seg ct-cg-strip-muted">${CORE.escapeHtml(_data.plan)}</span>`;
    }
    strip.innerHTML =
      `<div class="ct-cg-strip-inner">` +
        `<a class="ct-cg-strip-main" href="${SITE_URL}/dashboard/?utm_source=chatgpt_input" target="_blank" rel="noopener">${main}</a>` +
        `<button class="ct-cg-strip-gear" title="${CORE.escapeHtml(t('settings'))}" aria-label="${CORE.escapeHtml(t('settings'))}">${GEAR_SVG}</button>` +
        `<a class="ct-cg-strip-gear ct-cg-strip-contact" href="${contactUrl()}" target="_blank" rel="noopener" title="${CORE.escapeHtml(t('contact'))}" aria-label="${CORE.escapeHtml(t('contact'))}">${CONTACT_SVG}</a>` +
      `</div>`;
    const gear = strip.querySelector('.ct-cg-strip-gear');
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
    document.querySelectorAll(`#${STRIP_ID} .ct-cg-strip-reset[data-reset]`).forEach(el => {
      const r = el.dataset.reset;
      if (r) el.textContent = resetLabel(r);
    });
  }

  // ── Mount / unmount ──
  function mount() {
    if (document.getElementById(STRIP_ID)) { _mounted = true; return; }
    const anchor = findAnchor();
    if (!anchor) { _mounted = false; return; }
    const strip = buildStrip();
    if (anchor.type === 'belowbox') {
      strip.classList.add('ct-cg-strip-belowbox'); // full-width row under the box
      anchor.el.parentNode.insertBefore(strip, anchor.el.nextSibling);
    } else {
      anchor.el.parentNode.insertBefore(strip, anchor.el);
    }
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
    if (!document.getElementById(STRIP_ID)) _mounted = false;
    if (!_mounted) mount();
  }

  // Fully stop this instance (superseded by a newer injection, or ChatGPT
  // host permission revoked): remove DOM, clear timers, disconnect observers,
  // and unregister runtime/storage listeners (else reinjection accumulates them).
  function teardown() {
    _enabled = false;
    unmount();
    _intervals.forEach(clearInterval);
    _intervals = [];
    if (_observer) { _observer.disconnect(); _observer = null; }
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* context dead */ }
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { /* context dead */ }
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
          if (_data !== null) { _data = null; renderStrip(); }
          return;
        }
        if (_data && _data.h5 === res.h5 && _data.d7 === res.d7 && _data.r5 === res.r5 &&
            _data.r7 === res.r7 && _data.pred5h === res.pred5h && _data.pred7d === res.pred7d &&
            _data.plan === res.plan) return;
        _data = res;
        // _lang follows the user's extension language setting, not res.lang
        // (a Claude-snapshot field that defaults to 'en' for ChatGPT).
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
      if (changes.accountCache || changes.independentAccount) loadAccount();
      return;
    }
    if (area !== 'sync') return;
    if (changes.chatgptInputUsageEnabled) {
      _enabled = changes.chatgptInputUsageEnabled.newValue !== false;
      if (!_enabled) unmount(); else requestUsageData();
    }
    if (changes.lang) {
      _lang = changes.lang.newValue === 'auto' ? CORE.detectLang() : changes.lang.newValue;
      renderStrip();
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
      if (!document.getElementById(STRIP_ID)) { _mounted = false; mount(); }
    });
    _observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Init ──
  function init() {
    chrome.storage.sync.get({ lang: 'auto', chatgptInputUsageEnabled: true }, (cfg) => {
      _lang = cfg.lang === 'auto' ? CORE.detectLang() : cfg.lang;
      _enabled = cfg.chatgptInputUsageEnabled !== false;
      if (_enabled) requestUsageData();
    });
    loadAccount(); // prefill name/email into the inquiry link

    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    chrome.storage.onChanged.addListener(onStorageChanged);

    requestAnimationFrame(tick);
    startObserver();
    _intervals.push(setInterval(updateCountdowns, COUNTDOWN_INTERVAL_MS));
    _intervals.push(setInterval(requestUsageData, REFRESH_INTERVAL_MS));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
