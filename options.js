let _prevSelectedOrgIds = [];
let _saveTimer = null;
let _lastInteractedCard = null;

// Check + display permission hints for optional providers
async function _updateProviderPermHints() {
  const providers = [
    { id: 'collect-chatgpt', origins: ['https://chatgpt.com/*'] },
    { id: 'collect-gemini', origins: ['https://gemini.google.com/*'] },
  ];
  for (const p of providers) {
    const cb = document.getElementById(p.id);
    if (!cb) continue;
    const hint = cb.closest('label')?.querySelector('.perm-hint');
    const granted = await chrome.permissions.contains({ origins: p.origins });
    if (hint) {
      hint.style.display = (cb.checked && !granted) ? '' : 'none';
    }
  }
}

// === Theme ===
function initOptionsTheme() {
  chrome.storage.local.get({ 'ct-theme': 'system' }, (r) => {
    const pref = r['ct-theme'];
    const resolved = pref === 'system'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : pref;
    document.documentElement.setAttribute('data-theme', resolved);
    updateThemeButtons(pref);
  });
  // Bind theme buttons (inline onclick blocked by MV3 CSP)
  document.getElementById('opt-theme-light')?.addEventListener('click', () => setOptTheme('light'));
  document.getElementById('opt-theme-dark')?.addEventListener('click', () => setOptTheme('dark'));
  document.getElementById('opt-theme-system')?.addEventListener('click', () => setOptTheme('system'));
}
function setOptTheme(mode) {
  const resolved = mode === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode;
  chrome.storage.local.set({ 'ct-theme': mode });
  document.documentElement.setAttribute('data-theme', resolved);
  updateThemeButtons(mode);
}
function updateThemeButtons(mode) {
  ['light', 'dark', 'system'].forEach(m => {
    const btn = document.getElementById('opt-theme-' + m);
    if (btn) btn.classList.toggle('active', m === mode);
  });
}

// Build auth headers for server requests (ext_token > API key fallback).
// Keep in sync with bg/storage.js#getAuthHeaders.
async function _getAuthHeaders(cfg) {
  const { extToken } = await chrome.storage.local.get('extToken');
  if (extToken) return { 'Authorization': `Bearer ${extToken}` };
  return { 'X-API-Key': cfg.apiKey || (typeof CT_CONFIG !== 'undefined' ? CT_CONFIG.DEFAULT_API_KEY : '') };
}

// fetch wrapper that injects auth headers and clears stale ext_token on 401.
// Race-safe: only clears if stored token still matches the one we sent.
// Keep in sync with bg/storage.js#authedFetch.
async function _authedFetch(cfg, url, options = {}) {
  const auth = await _getAuthHeaders(cfg);
  const sentToken = auth.Authorization?.startsWith('Bearer ')
    ? auth.Authorization.slice(7)
    : null;
  const headers = { ...(options.headers || {}), ...auth };
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && sentToken) {
    const { extToken: currentToken } = await chrome.storage.local.get('extToken');
    if (currentToken === sentToken) {
      await chrome.storage.local.remove('extToken');
      try {
        const path = new URL(url).pathname;
        console.log(`[Claude Tuner] ext_token cleared (401) at ${path}`);
      } catch { /* ignore */ }
    }
  }
  return response;
}

// === Radio group helper ===
function initRadioGroup(groupId, value, onChange) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('.radio-item').forEach(item => {
    const radio = item.querySelector('input[type="radio"]');
    if (radio.value === value) {
      radio.checked = true;
      item.classList.add('active');
    }
    item.addEventListener('click', () => {
      group.querySelectorAll('.radio-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      radio.checked = true;
      if (onChange) onChange(radio.value);
    });
  });
}

function getRadioValue(groupId) {
  const checked = document.querySelector(`#${groupId} input[type="radio"]:checked`);
  return checked ? checked.value : null;
}

// === Update notification example text with current thresholds ===
function updateNotifyExamples() {
  const warn = document.getElementById('threshold-warn').value;
  const danger = document.getElementById('threshold-danger').value;
  const warnEl = document.querySelector('[data-i18n="notify_usage_warn_ex"]');
  const dangerEl = document.querySelector('[data-i18n="notify_usage_danger_ex"]');
  if (warnEl) warnEl.textContent = t('notify_usage_warn_ex', warn);
  if (dangerEl) dangerEl.textContent = t('notify_usage_danger_ex', danger);
}

// === Auto-save (debounced 800ms) ===
function autoSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(doSave, 800);
}

function doSave() {
  const serverUrl = document.getElementById('server-url').value.replace(/\/+$/, '');
  const apiKey = document.getElementById('api-key').value.trim();
  const intervalMinutes = parseInt(document.getElementById('interval').value, 10);
  const optimizationMode = getRadioValue('optimization-group') || 'notify_only';
  const intervalExplicitlySet = !document.getElementById('interval-server-default').checked;
  const usageDisplayMode = getRadioValue('usage-display-group') || '7d';
  const thresholdWarn = parseInt(document.getElementById('threshold-warn').value, 10) || 80;
  const thresholdDanger = parseInt(document.getElementById('threshold-danger').value, 10) || 95;

  if (thresholdDanger <= thresholdWarn) return; // Skip save on validation failure

  // Active org selection moved to dashboard settings — no longer persisted client-side
  const collectClaude = document.getElementById('collect-claude').checked;
  const collectChatGPT = document.getElementById('collect-chatgpt').checked;
  const collectGemini = document.getElementById('collect-gemini').checked;

  const sidebarUsageEnabled = document.getElementById('sidebar-usage-enabled').checked;
  const inputUsageEnabled = document.getElementById('input-usage-enabled').checked;
  const chatgptSidebarUsageEnabled = document.getElementById('chatgpt-sidebar-usage-enabled').checked;
  const chatgptInputUsageEnabled = document.getElementById('chatgpt-input-usage-enabled').checked;

  const notifyResetSoon = document.getElementById('notify-reset-soon').checked;
  const notifyResetDone = document.getElementById('notify-reset-done').checked;
  const notifyUsageWarn = document.getElementById('notify-usage-warn').checked;
  const notifyUsageDanger = document.getElementById('notify-usage-danger').checked;
  const notifyWeeklyReport = document.getElementById('notify-weekly-report').checked;
  const notifyPlanChange = document.getElementById('notify-plan-change').checked;
  const notifyCollectFail = document.getElementById('notify-collect-fail').checked;

  const config = { serverUrl, apiKey: apiKey || CT_CONFIG.DEFAULT_API_KEY, intervalMinutes, intervalExplicitlySet, optimizationMode, collectClaude, collectChatGPT, collectGemini, usageDisplayMode, thresholdWarn, thresholdDanger, sidebarUsageEnabled, inputUsageEnabled, chatgptSidebarUsageEnabled, chatgptInputUsageEnabled, notifyResetSoon, notifyResetDone, notifyUsageWarn, notifyUsageDanger, notifyWeeklyReport, notifyPlanChange, notifyCollectFail };

  // Sync plan change request settings to server
  const autoApproveVal = optimizationMode === 'auto';
  chrome.storage.local.get({ lastStatus: null }, (status) => {
    const email = status.lastStatus?.snapshot?.user_email;
    if (email) {
      _authedFetch(config, `${serverUrl}/api/snapshots/admin-order-setting`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: email, auto_approve: autoApproveVal }),
      }).then(res => {
        if (res.ok) chrome.storage.local.set({ ct_admin_order_auto_approve: autoApproveVal });
      }).catch(() => {});
    }
  });

  chrome.storage.sync.set(config, () => {
    chrome.alarms.clear('claude-usage-poll', () => {
      chrome.alarms.create('claude-usage-poll', {
        delayInMinutes: 1,
        periodInMinutes: intervalMinutes,
      });
    });

    chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });

    // Sync settings to server for analytics (fire-and-forget)
    chrome.storage.local.get({ lastStatus: null }, (st) => {
      const userEmail = st.lastStatus?.snapshot?.user_email;
      if (userEmail) {
        const extSettings = {
          intervalMinutes, usageDisplayMode, thresholdWarn, thresholdDanger,
          sidebarUsageEnabled, inputUsageEnabled, chatgptSidebarUsageEnabled, chatgptInputUsageEnabled, optimizationMode,
          collectClaude, collectChatGPT, collectGemini,
          notifyResetSoon, notifyResetDone, notifyUsageWarn, notifyUsageDanger,
          notifyWeeklyReport, notifyPlanChange, notifyCollectFail,
        };
        _authedFetch(config, `${serverUrl}/api/snapshots/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_email: userEmail, ext_settings: extSettings }),
        }).catch(() => {});
      }
    });

    showToast(_lastInteractedCard ? `${_lastInteractedCard} ${t('auto_saved')}` : t('auto_saved'));
  });
}

// === Initialization ===
document.addEventListener('DOMContentLoaded', async () => {
  initOptionsTheme();
  const manifest = chrome.runtime.getManifest();
  document.getElementById('version').textContent = `v${manifest.version}`;

  // Initialize i18n
  const { lang } = await chrome.storage.sync.get({ lang: 'auto' });
  initRadioGroup('lang-group', lang, (newLang) => {
    chrome.storage.sync.set({ lang: newLang });
    setLang(newLang);
    // Re-translate radio descriptions etc. after i18n change
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });
    updateBadgePreview();
    loadStatus();
  });
  await initI18n();

  // Load organization list
  loadOrgOptions();

  // Display mode (hide if sidePanel API not available)
  const hasSidePanel = !!(chrome.sidePanel && chrome.sidePanel.setPanelBehavior);
  if (!hasSidePanel) {
    document.getElementById('display-mode-card')?.style.setProperty('display', 'none');
  } else {
    const { preferSidePanel } = await chrome.storage.local.get({ preferSidePanel: true });
    initRadioGroup('display-mode-group', preferSidePanel ? 'sidepanel' : 'popup', (val) => {
      const isSidePanel = val === 'sidepanel';
      chrome.storage.local.set({ preferSidePanel: isSidePanel });
      chrome.runtime.sendMessage({ type: 'SET_SIDE_PANEL_MODE', enabled: isSidePanel });
      showToast(`${t('display_mode')} ${t('auto_saved')}`);
    });
  }

  // Extra usage card visibility (popup) — synced with the popup's × button.
  // Standalone storage.local key (popup-only pref, not part of synced config).
  const showExtraCb = document.getElementById('show-extra-usage');
  if (showExtraCb) {
    const { hiddenExtraUsage } = await chrome.storage.local.get({ hiddenExtraUsage: false });
    showExtraCb.checked = !hiddenExtraUsage;
    showExtraCb.addEventListener('change', () => {
      chrome.storage.local.set({ hiddenExtraUsage: !showExtraCb.checked });
      showToast(`${t('popup_display_title')} ${t('auto_saved')}`);
    });
  }

  // Load saved settings
  chrome.storage.sync.get(
    { serverUrl: CT_CONFIG.DEFAULT_SERVER_URL, apiKey: CT_CONFIG.DEFAULT_API_KEY, intervalMinutes: 10, intervalExplicitlySet: false, optimizationMode: 'notify_only', collectClaude: true, collectChatGPT: true, collectGemini: true, usageDisplayMode: '7d', thresholdWarn: 80, thresholdDanger: 95, sidebarUsageEnabled: true, inputUsageEnabled: true, chatgptSidebarUsageEnabled: true, chatgptInputUsageEnabled: true, notifyResetSoon: true, notifyResetDone: true, notifyUsageWarn: false, notifyUsageDanger: true, notifyWeeklyReport: true, notifyPlanChange: true, notifyCollectFail: true },
    (config) => {
      document.getElementById('server-url').value = config.serverUrl;
      document.getElementById('api-key').value = config.apiKey;
      ensureIntervalOption(config.intervalMinutes);
      document.getElementById('interval').value = String(config.intervalMinutes);

      // Optimization mode
      chrome.storage.local.get({ ct_admin_order_auto_approve: false }, (local) => {
        let optMode;
        if (local.ct_admin_order_auto_approve) optMode = 'auto';
        else if (config.optimizationMode === 'approval') optMode = 'approval';
        else optMode = 'notify_only';
        initRadioGroup('optimization-group', optMode, () => autoSave());
      });

      const useServerDefault = !config.intervalExplicitlySet;
      document.getElementById('interval-server-default').checked = useServerDefault;
      document.getElementById('interval').disabled = useServerDefault;

      // Badge display mode
      initRadioGroup('usage-display-group', config.usageDisplayMode || '7d', () => {
        updateBadgePreview();
        autoSave();
      });

      document.getElementById('threshold-warn').value = String(config.thresholdWarn || 80);
      document.getElementById('threshold-danger').value = String(config.thresholdDanger || 95);
      document.getElementById('collect-claude').checked = config.collectClaude !== false;
      document.getElementById('collect-chatgpt').checked = config.collectChatGPT !== false;
      document.getElementById('collect-gemini').checked = config.collectGemini !== false;
      // Show permission hint if toggle ON but permission not granted
      _updateProviderPermHints();
      document.getElementById('sidebar-usage-enabled').checked = config.sidebarUsageEnabled !== false;
      document.getElementById('input-usage-enabled').checked = config.inputUsageEnabled !== false;
      document.getElementById('chatgpt-sidebar-usage-enabled').checked = config.chatgptSidebarUsageEnabled !== false;
      document.getElementById('chatgpt-input-usage-enabled').checked = config.chatgptInputUsageEnabled !== false;
      document.getElementById('notify-reset-soon').checked = config.notifyResetSoon !== false;
      document.getElementById('notify-reset-done').checked = config.notifyResetDone !== false;
      document.getElementById('notify-usage-warn').checked = config.notifyUsageWarn !== false;
      document.getElementById('notify-usage-danger').checked = config.notifyUsageDanger !== false;
      document.getElementById('notify-weekly-report').checked = config.notifyWeeklyReport !== false;
      document.getElementById('notify-plan-change').checked = config.notifyPlanChange !== false;
      document.getElementById('notify-collect-fail').checked = config.notifyCollectFail !== false;
      updateBadgePreview();
      updateNotifyExamples();
    }
  );

  // Display server default interval
  chrome.storage.local.get({ serverPollInterval: null }, (data) => {
    const el = document.getElementById('interval-server-value');
    if (data.serverPollInterval) {
      el.textContent = `(${t('interval_current_server', data.serverPollInterval)})`;
    }
  });

  // === Auto-save event bindings ===
  // Collection interval
  document.getElementById('interval-server-default').addEventListener('change', (e) => {
    document.getElementById('interval').disabled = e.target.checked;
    autoSave();
  });
  document.getElementById('interval').addEventListener('change', autoSave);

  // Thresholds
  document.getElementById('threshold-warn').addEventListener('change', () => { validateThresholds(); updateBadgePreview(); updateNotifyExamples(); autoSave(); });
  document.getElementById('threshold-danger').addEventListener('change', () => { validateThresholds(); updateBadgePreview(); updateNotifyExamples(); autoSave(); });

  // Provider collection toggles
  document.getElementById('collect-claude').addEventListener('change', autoSave);
  // ChatGPT/Gemini: request optional permission when toggled ON
  document.getElementById('collect-chatgpt').addEventListener('change', async (e) => {
    if (e.target.checked) {
      try {
        const granted = await chrome.permissions.request({ origins: ['https://chatgpt.com/*'] });
        if (!granted) { e.target.checked = false; _updateProviderPermHints(); return; }
      } catch { e.target.checked = false; _updateProviderPermHints(); return; }
    }
    _updateProviderPermHints();
    autoSave();
  });
  document.getElementById('collect-gemini').addEventListener('change', async (e) => {
    if (e.target.checked) {
      try {
        const granted = await chrome.permissions.request({ origins: ['https://gemini.google.com/*'] });
        if (!granted) { e.target.checked = false; _updateProviderPermHints(); return; }
      } catch { e.target.checked = false; _updateProviderPermHints(); return; }
    }
    autoSave();
  });

  // Page usage toggles (sidebar + input area)
  document.getElementById('sidebar-usage-enabled').addEventListener('change', autoSave);
  document.getElementById('input-usage-enabled').addEventListener('change', autoSave);
  document.getElementById('chatgpt-sidebar-usage-enabled').addEventListener('change', autoSave);
  document.getElementById('chatgpt-input-usage-enabled').addEventListener('change', autoSave);

  // Notification checkboxes
  document.querySelectorAll('#notify-list input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', autoSave);
  });

  // Track last interacted card for contextual save toast
  document.addEventListener('change', (e) => {
    const card = e.target.closest('.card');
    if (card) {
      const title = card.querySelector('.card-title');
      if (title) _lastInteractedCard = title.textContent;
    }
  });

  // Show current status
  loadStatus();

  // Review banner
  chrome.storage.local.get({ ct_review_nudge: null }, (store) => {
    const rn = store.ct_review_nudge;
    if (!rn) return;
    if (rn.clicked) return;
    if ((rn.dismiss_count || 0) >= 5) return;
    if (rn.last_dismissed && Date.now() - new Date(rn.last_dismissed + 'Z').getTime() < 14 * 86400000) return;
    if (rn.first_seen_at) {
      const age = (Date.now() - new Date(rn.first_seen_at + 'Z').getTime()) / 86400000;
      if (age < 3) return;
    }
    document.getElementById('review-banner').style.display = 'flex';
  });
  document.querySelector('.review-banner-btn').addEventListener('click', () => {
    sendReviewNudgeAction('clicked');
    if (typeof sendGAEvent === 'function') sendGAEvent('review_nudge_clicked', { source: 'options' });
  });
  document.getElementById('review-dismiss').addEventListener('click', () => {
    document.getElementById('review-banner').style.display = 'none';
    sendReviewNudgeAction('dismissed');
    if (typeof sendGAEvent === 'function') sendGAEvent('review_nudge_dismissed', { source: 'options' });
  });

  // Data reset button
  document.getElementById('reset-btn').addEventListener('click', () => {
    if (!confirm(t('reset_confirm'))) return;
    // Also clear historyEmptyUntil so the next collect can immediately backfill the
    // wiped sparkline — otherwise an active need_history cooldown would suppress the
    // bootstrap for up to 6h, leaving the chart empty (see HISTORY_BACKFILL_COOLDOWN_MS).
    chrome.storage.local.remove(['usageHistory', 'optimizationState', 'lastStatus', 'alertState', 'historyEmptyUntil'], () => {
      showToast(t('reset_done'));
      document.getElementById('history-count').textContent = '0';
      document.getElementById('last-collected').textContent = '-';
    });
  });

  // Check system notification permission
  chrome.notifications.getPermissionLevel((level) => {
    if (level === 'denied') {
      document.getElementById('notify-blocked-banner').style.display = 'block';
    }
  });

  // Scroll to section and highlight if hash is present (e.g. #notifications, #page-usage)
  if (location.hash) {
    setTimeout(() => {
      const el = document.querySelector(location.hash);
      if (el) {
        const card = el.closest('.card') || el;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('card--highlight');
      }
    }, 300);
  }
});

async function sendReviewNudgeAction(action) {
  try {
    const status = await new Promise(r => chrome.storage.local.get({ lastStatus: null }, r));
    const email = status.lastStatus?.snapshot?.user_email;
    if (!email) return;
    const cfg = await new Promise(r =>
      chrome.storage.sync.get({ serverUrl: CT_CONFIG.DEFAULT_SERVER_URL, apiKey: CT_CONFIG.DEFAULT_API_KEY }, r)
    );
    if (!cfg.serverUrl) return;
    _authedFetch(cfg, cfg.serverUrl + '/api/snapshots/review-nudge', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_email: email, action }),
    });
  } catch (e) { /* silent */ }
}

function loadStatus() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (status) => {
    if (chrome.runtime.lastError || !status) return;
    if (status.timestamp) {
      document.getElementById('last-collected').textContent = formatTimeAgo(status.timestamp);
    }
    if (status.snapshot) {
      document.getElementById('account-email').textContent = status.snapshot.user_email || '-';
      document.getElementById('current-plan').textContent = status.snapshot.plan || '-';
    }
  });

  chrome.runtime.sendMessage({ type: 'GET_USAGE_HISTORY' }, (history) => {
    if (chrome.runtime.lastError || !history) return;
    const count = history.length;
    if (count > 0) {
      const oldest = Math.min(...history.map((p) => p.t));
      const spanH = (Date.now() - oldest) / 3600000;
      const spanLabel = spanH < 1 ? `${Math.round(spanH * 60)}m` : spanH < 24 ? `${Math.round(spanH)}h` : `${(spanH / 24).toFixed(1)}d`;
      document.getElementById('history-count').textContent = `${count} ${t('status_items')} (${spanLabel})`;
    }
  });
}

function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t('ago_just_now');
  if (minutes < 60) return `${minutes}${t('ago_min')}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${t('ago_hour')}`;
  return `${Math.floor(hours / 24)}${t('ago_day')}`;
}

function ensureIntervalOption(minutes) {
  const select = document.getElementById('interval');
  const val = String(minutes);
  for (const opt of select.options) {
    if (opt.value === val) return;
  }
  const opt = document.createElement('option');
  opt.value = val;
  opt.textContent = `${minutes} min`;
  let inserted = false;
  for (const existing of select.options) {
    if (parseInt(existing.value, 10) > minutes) {
      select.insertBefore(opt, existing);
      inserted = true;
      break;
    }
  }
  if (!inserted) select.appendChild(opt);
}

function showToast(message, isError) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = isError ? 'toast show error' : 'toast show success';
  if (toast._timer) clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.className = 'toast'; }, 2000);
}

// === Org checklist ===
const MAX_ORGS = 3;
let _selectedOrgIds = [];

function loadOrgOptions() {
  const container = document.getElementById('org-checklist');
  if (!container) return;

  const refreshBtn = document.getElementById('org-refresh');
  if (refreshBtn && !refreshBtn._bound) {
    refreshBtn._bound = true;
    refreshBtn.addEventListener('click', () => {
      refreshBtn.disabled = true;
      // Clear cache and reload
      chrome.storage.local.remove(['accountCache', 'autoSelectedOrg', 'collectedOrgs'], () => {
        loadOrgOptions();
        // Also trigger a forced re-collection
        chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' });
        showToast(t('org_refreshed'));
        setTimeout(() => { refreshBtn.disabled = false; }, 3000);
      });
    });
  }

  chrome.runtime.sendMessage({ type: 'GET_ORGANIZATIONS' }, (res) => {
    if (chrome.runtime.lastError || !res?.success) return;
    const orgs = res.orgs.filter(o => o.plan !== 'API');
    if (orgs.length < 2) return;

    chrome.storage.sync.get({ selectedOrgIds: null, selectedOrgId: null, orgAutoAll: true }, (config) => {
      const autoAllCb = document.getElementById('org-auto-all');
      const isAutoAll = config.orgAutoAll !== false; // Default true

      if (isAutoAll) {
        _selectedOrgIds = orgs.map(o => o.uuid);
      } else if (config.selectedOrgIds && Array.isArray(config.selectedOrgIds)) {
        _selectedOrgIds = config.selectedOrgIds;
      } else if (config.selectedOrgId && orgs.length > MAX_ORGS) {
        _selectedOrgIds = [config.selectedOrgId];
      } else {
        _selectedOrgIds = orgs.map(o => o.uuid);
      }

      autoAllCb.checked = isAutoAll;
      _prevSelectedOrgIds = [..._selectedOrgIds];
      renderOrgChecklist(container, orgs);
      updateOrgHint();

      // "Collect all organizations automatically" checkbox (prevent duplicate listeners)
      if (!autoAllCb._bound) {
      autoAllCb._bound = true;
      autoAllCb.addEventListener('change', () => {
        if (autoAllCb.checked) {
          _selectedOrgIds = orgs.map(o => o.uuid);
        }
        renderOrgChecklist(container, orgs);
        updateOrgHint();
        autoSave();
      });
      }
    });
  });
}

function renderOrgChecklist(container, orgs) {
  container.innerHTML = '';
  const isAutoAll = document.getElementById('org-auto-all')?.checked;

  for (const org of orgs) {
    const item = document.createElement('label');
    item.className = 'org-check-item' + (_selectedOrgIds.includes(org.uuid) ? ' checked' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = org.uuid;
    cb.checked = _selectedOrgIds.includes(org.uuid);

    if (isAutoAll) {
      // Auto-all mode: check all items + disable
      cb.checked = true;
      cb.disabled = true;
      item.classList.add('checked');
      item.style.opacity = '0.6';
    } else if (!cb.checked && _selectedOrgIds.length >= MAX_ORGS) {
      item.classList.add('disabled');
      cb.disabled = true;
    }

    const name = document.createElement('span');
    name.className = 'org-name';
    name.textContent = org.name;

    const plan = document.createElement('span');
    plan.className = 'org-plan';
    plan.textContent = org.plan;

    item.appendChild(cb);
    item.appendChild(name);
    item.appendChild(plan);
    container.appendChild(item);

    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (_selectedOrgIds.length >= MAX_ORGS) { cb.checked = false; return; }
        _selectedOrgIds.push(org.uuid);
      } else {
        _selectedOrgIds = _selectedOrgIds.filter(id => id !== org.uuid);
      }
      renderOrgChecklist(container, orgs);
      updateOrgHint();
      autoSave();
    });
  }

  let countEl = container.parentElement.querySelector('.org-check-count');
  if (!countEl) {
    countEl = document.createElement('div');
    countEl.className = 'org-check-count';
    container.after(countEl);
  }
  // Hide count if auto-all or all selected
  if (isAutoAll || _selectedOrgIds.length === orgs.length) {
    countEl.textContent = '';
  } else {
    const limit = Math.min(MAX_ORGS, orgs.length);
    countEl.textContent = t('org_check_count', String(_selectedOrgIds.length), String(limit));
  }
}

function updateOrgHint() {
  const hint = document.getElementById('org-hint');
  if (!hint) return;
  if (_selectedOrgIds.length === 0) {
    chrome.storage.local.get({ autoSelectedOrg: null }, (data) => {
      const org = data.autoSelectedOrg;
      if (org) {
        hint.textContent = t('org_auto_current', org.name, org.plan);
      } else {
        hint.textContent = t('org_select_hint');
      }
    });
  } else {
    hint.textContent = t('org_select_hint');
  }
}

function updateBadgePreview() {
  const mode = getRadioValue('usage-display-group') || '7d';
  const warn = parseInt(document.getElementById('threshold-warn').value, 10) || 80;
  const danger = parseInt(document.getElementById('threshold-danger').value, 10) || 95;

  const container = document.getElementById('badge-preview');
  container.innerHTML = '';

  function badgeTextColor(bg) {
    const r = parseInt(bg.slice(1, 3), 16), g = parseInt(bg.slice(3, 5), 16), b = parseInt(bg.slice(5, 7), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.5 ? '#000' : '#fff';
  }
  function addBadge(pct, color, label, range) {
    const div = document.createElement('div');
    div.className = 'badge-demo';
    div.innerHTML = `<span class="badge-pill" style="background:${color};color:${badgeTextColor(color)}">${pct}%</span><span class="badge-label">${label}</span><span class="badge-range">${range}</span>`;
    container.appendChild(div);
  }
  function addArrow() {
    const span = document.createElement('span');
    span.className = 'badge-arrow';
    span.textContent = '\u203A';
    container.appendChild(span);
  }

  const normalPct = Math.max(10, warn - 20);
  const normalRange = `0 ~ ${warn - 1}%`;
  const warnRange = `${warn} ~ ${danger - 1}%`;
  const dangerRange = `${danger}% ~`;

  if (mode === 'both') {
    addBadge(normalPct, '#06b6d4', t('badge_state_normal') + ' (5h)', normalRange);
    addBadge(normalPct, '#7c3aed', t('badge_state_normal') + ' (7d)', normalRange);
  } else {
    const normalColor = mode === '5h' ? '#06b6d4' : '#7c3aed';
    addBadge(normalPct, normalColor, t('badge_state_normal'), normalRange);
  }
  addArrow();
  addBadge(warn, '#f59e0b', t('badge_state_warn'), warnRange);
  addArrow();
  addBadge(danger, '#ef4444', t('badge_state_danger'), dangerRange);
}

function validateThresholds() {
  const warn = parseInt(document.getElementById('threshold-warn').value, 10) || 80;
  const danger = parseInt(document.getElementById('threshold-danger').value, 10) || 95;
  const errEl = document.getElementById('threshold-error');
  if (danger <= warn) {
    errEl.textContent = t('threshold_error');
    errEl.style.display = 'block';
  } else {
    errEl.style.display = 'none';
  }
}
