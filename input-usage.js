// Claude Tuner — Input Area Usage Strip
// Compact 1-line usage display below Claude.ai's chat input area.
// Mount strategy adapted from Claude-Usage-Tracker (sshnox/Claude-Usage-Tracker):
//   Shadow DOM + insertBefore sibling + MutationObserver remount.

(() => {
  'use strict';

  const HOST_ID = 'ct-input-usage-host';

  // ── State ──
  let _enabled = null;    // null until storage read
  let _data = null;
  let _lang = 'en';

  // ── i18n ──
  const I18N = {
    ko: {
      usage_5h: '5시간 사용률',
      pred_label: '리셋 시 예상',
      extra_label: '추가 사용',
      peak: '🔥 PEAK',
      peak_title: '🔥 피크 시간대',
      peak_body_pre: '평일 ',
      peak_body_post: ' · 5h 한도가 더 빠르게 소진됩니다',
      peak_body_2: '7d 한도에는 영향 없음 · 주말은 오프피크',
      settings: '설정',
      soon: '곧 리셋',
      no_data: '데이터 수집 중...',
      brand: 'Claude Tuner',
    },
    en: {
      usage_5h: '5h usage',
      pred_label: 'est. at reset',
      extra_label: 'Extra',
      peak: '🔥 PEAK',
      peak_title: '🔥 Peak Hours',
      peak_body_pre: 'Weekdays ',
      peak_body_post: ' · The 5h limit drains faster',
      peak_body_2: '7d limit not affected · Weekends are off-peak',
      settings: 'Settings',
      soon: 'soon',
      no_data: 'Collecting data...',
      brand: 'Claude Tuner',
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

  function formatResetTime(resetAt) {
    if (!resetAt) return null;
    const diff = new Date(resetAt).getTime() - Date.now();
    if (diff <= 0) return t('soon');
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (h >= 24) {
      const d = Math.floor(h / 24);
      return `${d}d ${h % 24}h`;
    }
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  }

  function formatResetAbsolute(resetAt) {
    if (!resetAt) return '';
    const d = new Date(resetAt);
    if (_lang === 'ko') {
      const days = ['일', '월', '화', '수', '목', '금', '토'];
      return `${d.getMonth() + 1}/${d.getDate()}(${days[d.getDay()]}) ${d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit', hour12: true })} 리셋 예정`;
    }
    return `Resets ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}`;
  }

  function isPeakNow() {
    // Disabled: Anthropic removed peak hour limit reduction (2026-05-07)
    return false;
    // const now = new Date();
    // const day = now.getUTCDay();
    // const hour = now.getUTCHours();
    // return day >= 1 && day <= 5 && hour >= 12 && hour < 18;
  }

  function getPeakLocalRange() {
    const locale = _lang === 'ko' ? 'ko-KR' : 'en-US';
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
    const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 18));
    const fmt = d => d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', hour12: true });
    return fmt(start) + '\u2013' + fmt(end);
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function getActiveOrgId() {
    return document.cookie.split('; ')
      .find(r => r.startsWith('lastActiveOrg='))?.split('=')[1] || null;
  }

  function isDarkTheme() {
    const html = document.documentElement;
    if (html.classList.contains('dark')) return true;
    if (html.getAttribute('data-theme') === 'dark') return true;
    if (html.getAttribute('data-mode') === 'dark') return true;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // ── Shadow DOM CSS ──
  const STRIP_CSS = `
:host, .ct-strip { all: initial; }

.ct-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0;
  box-sizing: border-box;
  width: 100%;
  margin: -4px 0 0;
  padding: 0 2px;
  font-size: 11px;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", sans-serif;
  line-height: 1.4;
  user-select: none;
  overflow: visible;
  color: var(--text);
  background: transparent;
  border: none;
  border-radius: 0;
  -webkit-font-smoothing: antialiased;

  --surface: rgba(0, 0, 0, 0.025);
  --border: rgba(0, 0, 0, 0.08);
  --track: #d4d4d4;
  --text: #4a4a49;
  --muted: #7a7a79;
}

@media (prefers-color-scheme: dark) {
  .ct-strip {
    --surface: rgba(255, 255, 255, 0.035);
    --border: rgba(255, 255, 255, 0.09);
    --track: #404040;
    --text: #b0b0ae;
    --muted: #8a8a88;
  }
}
.ct-strip.theme-dark {
  --surface: rgba(255, 255, 255, 0.035);
  --border: rgba(255, 255, 255, 0.09);
  --track: rgba(255, 255, 255, 0.10);
  --text: #b0b0ae;
  --muted: #8a8a88;
}

* { box-sizing: border-box; }

.ct-logo-link {
  display: flex; align-items: center; flex-shrink: 0;
  margin-right: 6px; text-decoration: none;
}
.ct-logo {
  width: 14px; height: 14px; border-radius: 3px;
  opacity: 0.45; transition: opacity 0.15s;
}
.ct-logo-link:hover .ct-logo { opacity: 0.8; }

.ct-seg {
  display: flex; align-items: center; gap: 4px;
  flex-shrink: 0; font-size: 11px; min-width: 0;
}
.ct-seg-label { white-space: nowrap; color: var(--muted); }
.ct-seg-value { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }

.ct-dot {
  margin: 0 8px; opacity: 0.3; font-size: 8px;
  flex-shrink: 1; min-width: 4px; overflow: hidden;
}

.ct-bar {
  width: 100px; min-width: 40px; height: 4px; border-radius: 2px;
  position: relative; margin-left: 8px; flex-shrink: 1;
  overflow: visible; background: var(--track);
}
.ct-bar-fill {
  height: 100%; border-radius: 2px; transition: width 0.4s ease; min-width: 0;
}
.ct-bar-pred {
  position: absolute; top: 0; height: 100%; opacity: 0.25;
  background-image: repeating-linear-gradient(-45deg, transparent, transparent 2px, currentColor 2px, currentColor 4px);
  transition: left 0.4s ease, width 0.4s ease;
}
.ct-bar-marker {
  position: absolute; top: -2px; width: 2px; height: 8px;
  border-radius: 1px; transition: left 0.4s ease;
}

.ct-extra-bar {
  width: 40px; min-width: 20px; height: 4px; border-radius: 2px;
  position: relative; margin-left: 6px; flex-shrink: 1; background: var(--track);
}
.ct-extra-bar-fill { height: 100%; border-radius: 2px; transition: width 0.4s ease; }

.ct-right {
  display: flex; align-items: center; gap: 8px; margin-left: auto; flex-shrink: 0;
}
.ct-settings {
  display: flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border: none; background: none;
  cursor: pointer; opacity: 0.3; transition: opacity 0.15s;
  padding: 0; color: var(--muted);
}
.ct-settings:hover { opacity: 0.7; }
.ct-settings svg { width: 12px; height: 12px; }

.ct-peak {
  color: #ef4444; font-weight: 700; font-size: 10px;
  letter-spacing: 0.03em; cursor: default;
}
  `;

  // ── Composer detection ──
  // Find the inner content area (flex-col with gap) inside the visual input box.
  // This is where the editor and toolbar live — inserting here places the strip
  // right below the toolbar row, inside the visual box.
  function findComposerWrapper() {
    const editor = document.querySelector(
      'div[contenteditable="true"][role="textbox"], div.ProseMirror[contenteditable="true"]'
    );
    if (!editor) return null;

    // Find the inner content area (flex-col with gap-*)
    const contentArea = editor.closest('[class*="gap-"]');
    if (contentArea) return contentArea;

    // Fallback: find visual input box
    const bgBox = editor.closest('[class*="bg-bg-"]');
    if (bgBox) {
      const inner = bgBox.querySelector(':scope > [class*="flex-col"]');
      if (inner) return inner;
      return bgBox;
    }

    // Last resort: traverse up before FIELDSET/FORM
    let target = editor;
    let el = editor;
    for (let i = 0; i < 10 && el && el.parentElement; i++) {
      el = el.parentElement;
      if (el.tagName === 'FORM' || el.tagName === 'FIELDSET') return target;
      target = el;
    }
    return target;
  }

  // ── Shadow DOM build (matches CUT pattern exactly) ──
  function buildShadowRoot() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all: initial; display: block; width: 100%; contain: layout style;';

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STRIP_CSS;
    shadow.appendChild(style);

    const root = document.createElement('div');
    root.className = 'ct-strip' + (isDarkTheme() ? ' theme-dark' : '');
    shadow.appendChild(root);

    return { host, shadow, root };
  }

  function $shadow() {
    const host = document.getElementById(HOST_ID);
    return host ? host.shadowRoot : null;
  }

  // ── Theme sync ──
  function syncTheme() {
    const shadow = $shadow();
    if (!shadow) return;
    const strip = shadow.querySelector('.ct-strip');
    if (!strip) return;
    if (isDarkTheme()) strip.classList.add('theme-dark');
    else strip.classList.remove('theme-dark');
  }

  // ── Mount ──
  function mountWidget() {
    if (document.getElementById(HOST_ID)) return true;

    const wrapper = findComposerWrapper();
    if (!wrapper || !wrapper.parentElement) return false;

    const { host } = buildShadowRoot();
    wrapper.appendChild(host);

    renderStrip();
    requestUsageData();
    return true;
  }

  // ── ensureMounted ──
  // Never stop retrying — React may remove our host at any time during
  // reconciliation, and the MutationObserver alone isn't reliable enough
  // on initial page load when React is still hydrating.
  function ensureMounted() {
    if (!_enabled) return;

    const existing = document.getElementById(HOST_ID);
    if (existing && document.body.contains(existing)) return;
    if (existing) existing.remove();

    mountWidget();
  }

  // ── MutationObserver (matches CUT — no debounce) ──
  const observer = new MutationObserver(() => ensureMounted());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Theme observer
  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-mode'] });

  // ── Render ──
  function renderStrip() {
    const shadow = $shadow();
    if (!shadow) return;
    const strip = shadow.querySelector('.ct-strip');
    if (!strip) return;

    if (!_data || _data.h5 == null) {
      let iconUrl = '';
      try { iconUrl = chrome.runtime.getURL('icons/icon16.png'); } catch { /* ignore */ }
      strip.innerHTML = `
        ${iconUrl ? `<a href="https://claudetuner.com/dashboard/?utm_source=input" target="_blank" class="ct-logo-link"><img src="${iconUrl}" class="ct-logo" alt="CT"></a>` : ''}
        <div class="ct-seg">
          <span class="ct-seg-label">${escapeHtml(t('brand'))}</span>
          <span class="ct-seg-value">${escapeHtml(t('no_data'))}</span>
        </div>
      `;
      return;
    }

    const util5h = Math.round(_data.h5 || 0);
    const pred5h = _data.pred5h != null ? Math.round(_data.pred5h) : null;
    const resetTime = formatResetTime(_data.r5);
    const color5h = gaugeColor(util5h);

    let iconUrl = '';
    try { iconUrl = chrome.runtime.getURL('icons/icon16.png'); } catch { /* ignore */ }

    let html = '';
    if (iconUrl) html += `<a href="https://claudetuner.com/dashboard/?utm_source=input" target="_blank" class="ct-logo-link"><img src="${iconUrl}" class="ct-logo" alt="CT"></a>`;

    html += `<div class="ct-seg"><span class="ct-seg-label">${escapeHtml(t('usage_5h'))}</span><span class="ct-seg-value" style="color:${color5h}">${util5h}%</span></div>`;

    html += `<div class="ct-bar"><div class="ct-bar-fill" style="width:${Math.min(util5h, 100)}%;background:${color5h}"></div>`;
    if (pred5h != null && pred5h > util5h) {
      const pc = Math.min(pred5h, 100);
      html += `<div class="ct-bar-pred" style="left:${Math.min(util5h, 100)}%;width:${pc - Math.min(util5h, 100)}%;color:${gaugeColor(pred5h)}"></div>`;
      html += `<div class="ct-bar-marker" style="left:${pc}%;background:${gaugeColor(pred5h)}"></div>`;
    }
    html += `</div>`;

    if (resetTime) {
      const absTime = formatResetAbsolute(_data.r5);
      const titleAttr = absTime ? ` title="${escapeHtml(absTime)}"` : '';
      html += `<span class="ct-dot">\u00b7</span><span${titleAttr}><div class="ct-seg">`;
      if (_lang === 'ko') {
        html += `<span class="ct-seg-label">\u23f1</span><span class="ct-seg-value">${escapeHtml(resetTime)}</span><span class="ct-seg-label">\ub4a4 \ub9ac\uc14b</span>`;
      } else {
        html += `<span class="ct-seg-label">\u23f1 resets in</span><span class="ct-seg-value">${escapeHtml(resetTime)}</span>`;
      }
      html += `</div></span>`;
    }

    if (pred5h != null && pred5h > util5h) {
      const pd = pred5h >= 100 ? '100%+' : pred5h + '%';
      html += `<span class="ct-dot">\u00b7</span><div class="ct-seg"><span class="ct-seg-label">${escapeHtml(t('pred_label'))}</span><span class="ct-seg-value" style="color:${gaugeColor(pred5h)}">${pd}</span></div>`;
    }

    if (_data.euEnabled && _data.el && (_data.eu || 0) > 0) {
      const uc = _data.eu || 0, lc = _data.el || 0;
      const ep = lc > 0 ? Math.min((uc / lc) * 100, 100) : 0;
      const ec = ep >= 80 ? '#ef4444' : '#f59e0b';
      html += `<span class="ct-dot">\u00b7</span><div class="ct-seg"><span class="ct-seg-label">${escapeHtml(t('extra_label'))}</span><span class="ct-seg-value" style="${ep >= 80 ? 'color:#ef4444' : 'opacity:0.7'}">$${(uc / 100).toFixed(2)}/$${(lc / 100).toFixed(0)}</span></div>`;
      html += `<div class="ct-extra-bar"><div class="ct-extra-bar-fill" style="width:${ep}%;background:${ec}"></div></div>`;
    }

    html += `<div class="ct-right">`;
    if (isPeakNow()) {
      const range = getPeakLocalRange();
      const peakTip = t('peak_body_pre') + range + t('peak_body_post') + '\n' + t('peak_body_2');
      html += `<span class="ct-peak" title="${escapeHtml(peakTip)}">${t('peak')}</span>`;
    }
    html += `<button class="ct-settings" title="${escapeHtml(t('settings'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg></button>`;
    html += `</div>`;

    strip.innerHTML = html;

    const settingsBtn = strip.querySelector('.ct-settings');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        try { chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS', hash: 'page-usage' }); } catch { /* noop */ }
      });
    }
  }

  // ── Data communication ──
  let _dataRetryTimer = null;
  let _reqSeq = 0; // sequence number to discard stale responses from concurrent calls

  function requestUsageData() {
    try {
      if (!chrome.runtime?.id) return;
    } catch { return; } // extension context truly dead — nothing to do

    const orgId = getActiveOrgId();
    const seq = ++_reqSeq;
    const onFail = () => {
      // Only retry when no data at all (initial load)
      if (_data || _dataRetryTimer) return;
      let retries = 0;
      _dataRetryTimer = setInterval(() => {
        if (++retries > 10 || _data) { clearInterval(_dataRetryTimer); _dataRetryTimer = null; return; }
        requestUsageData();
      }, 2000);
    };
    try {
      chrome.runtime.sendMessage({ type: 'GET_SIDEBAR_USAGE', orgId }, (res) => {
        if (seq !== _reqSeq) return; // stale response from an older concurrent call — discard
        if (chrome.runtime.lastError) { onFail(); return; }
        if (!res) { onFail(); return; } // keep previous _data if available
        _data = res;
        renderStrip();
        if (_dataRetryTimer) { clearInterval(_dataRetryTimer); _dataRetryTimer = null; }
      });
    } catch { /* context dead */ }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SIDEBAR_USAGE_REFRESH') requestUsageData();
  });

  // ── Org change detection ──
  let _lastOrgId = getActiveOrgId();
  function checkOrgChange() {
    const cur = getActiveOrgId();
    if (cur && cur !== _lastOrgId) { _lastOrgId = cur; requestUsageData(); }
  }

  // ── URL change detection (Claude.ai SPA) ──
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      ensureMounted();
    }
  }, 1000);

  // ── Init ──
  function detectLang() {
    return (navigator.language || 'en').slice(0, 2).toLowerCase() === 'ko' ? 'ko' : 'en';
  }

  // Permanent mount check — React may remove our host at any time
  setInterval(ensureMounted, 800);

  try {
    chrome.storage.sync.get({ lang: 'auto', inputUsageEnabled: true }, (cfg) => {
      _lang = cfg.lang === 'auto' ? detectLang() : cfg.lang;
      _enabled = cfg.inputUsageEnabled !== false;
      if (_enabled) ensureMounted();
    });
  } catch {
    // Storage read failed (extension context dead) — stay disabled
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.inputUsageEnabled) {
        _enabled = changes.inputUsageEnabled.newValue !== false;
        if (!_enabled) { const el = document.getElementById(HOST_ID); if (el) el.remove(); }
        else ensureMounted();
      }
      if (changes.lang) {
        _lang = changes.lang.newValue === 'auto' ? detectLang() : changes.lang.newValue;
        renderStrip();
      }
    });
  } catch { /* context dead */ }

  // Periodic refresh (countdown timer + data)
  setInterval(() => { try { renderStrip(); checkOrgChange(); } catch { /* noop */ } }, 30000);
  setInterval(requestUsageData, 60000);

  // Visibility change → refresh
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestUsageData();
  });

  // ensureMounted() is called from the storage callback above —
  // do not call it here to avoid mounting before settings are read.
})();
