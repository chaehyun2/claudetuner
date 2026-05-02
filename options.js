let _prevSelectedOrgIds = [];
let _saveTimer = null;

// === 라디오 그룹 헬퍼 ===
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

// === 자동 저장 (디바운스 800ms) ===
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

  if (thresholdDanger <= thresholdWarn) return; // 유효성 실패 시 저장 안 함

  const selectedOrgIds = _selectedOrgIds.length > 0 ? [..._selectedOrgIds] : null;
  const selectedOrgId = selectedOrgIds ? selectedOrgIds[0] : null;
  const prevIds = JSON.stringify(_prevSelectedOrgIds || []);
  const orgChanged = JSON.stringify(selectedOrgIds || []) !== prevIds;

  const notifyResetSoon = document.getElementById('notify-reset-soon').checked;
  const notifyResetDone = document.getElementById('notify-reset-done').checked;
  const notifyUsageAlert = document.getElementById('notify-usage-alert').checked;
  const notifyWeeklyReport = document.getElementById('notify-weekly-report').checked;
  const notifyPlanChange = document.getElementById('notify-plan-change').checked;
  const notifyCollectFail = document.getElementById('notify-collect-fail').checked;

  const orgAutoAll = document.getElementById('org-auto-all')?.checked ?? true;
  const config = { serverUrl, apiKey: apiKey || CT_CONFIG.DEFAULT_API_KEY, intervalMinutes, intervalExplicitlySet, optimizationMode, selectedOrgId, selectedOrgIds, orgAutoAll, usageDisplayMode, thresholdWarn, thresholdDanger, notifyResetSoon, notifyResetDone, notifyUsageAlert, notifyWeeklyReport, notifyPlanChange, notifyCollectFail };

  // 플랜 변경 요청 설정을 서버에 동기화
  const autoApproveVal = optimizationMode === 'auto';
  chrome.storage.local.get({ lastStatus: null }, (status) => {
    const email = status.lastStatus?.snapshot?.user_email;
    if (email) {
      fetch(`${serverUrl}/api/snapshots/admin-order-setting`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
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

    if (orgChanged) {
      chrome.storage.local.remove(['usageHistory', 'optimizationState', 'lastStatus', 'usageAlertState', 'accountCache', 'needsOrgSelection'], () => {
        _prevSelectedOrgIds = selectedOrgIds ? [...selectedOrgIds] : [];
        showToast(t('org_changed'));
      });
    } else {
      showToast(t('auto_saved'));
    }
  });
}

// === 초기화 ===
document.addEventListener('DOMContentLoaded', async () => {
  const manifest = chrome.runtime.getManifest();
  document.getElementById('version').textContent = `v${manifest.version}`;

  // i18n 초기화
  const { lang } = await chrome.storage.sync.get({ lang: 'auto' });
  initRadioGroup('lang-group', lang, (newLang) => {
    chrome.storage.sync.set({ lang: newLang });
    setLang(newLang);
    // i18n 변경 후 라디오 desc 등 재번역
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });
    updateBadgePreview();
    loadStatus();
  });
  await initI18n();

  // 조직 목록 로드
  loadOrgOptions();

  // 표시 방식 (sidePanel API 없으면 숨김)
  const hasSidePanel = !!(chrome.sidePanel && chrome.sidePanel.setPanelBehavior);
  if (!hasSidePanel) {
    document.getElementById('display-mode-card')?.style.setProperty('display', 'none');
  } else {
    const { preferSidePanel } = await chrome.storage.local.get({ preferSidePanel: true });
    initRadioGroup('display-mode-group', preferSidePanel ? 'sidepanel' : 'popup', (val) => {
      const isSidePanel = val === 'sidepanel';
      chrome.storage.local.set({ preferSidePanel: isSidePanel });
      chrome.runtime.sendMessage({ type: 'SET_SIDE_PANEL_MODE', enabled: isSidePanel });
      showToast(t('auto_saved'));
    });
  }

  // 저장된 설정 로드
  chrome.storage.sync.get(
    { serverUrl: CT_CONFIG.DEFAULT_SERVER_URL, apiKey: CT_CONFIG.DEFAULT_API_KEY, intervalMinutes: 5, intervalExplicitlySet: false, optimizationMode: 'notify_only', usageDisplayMode: '7d', thresholdWarn: 80, thresholdDanger: 95, notifyResetSoon: true, notifyResetDone: true, notifyUsageAlert: true, notifyWeeklyReport: true, notifyPlanChange: true, notifyCollectFail: true },
    (config) => {
      document.getElementById('server-url').value = config.serverUrl;
      document.getElementById('api-key').value = config.apiKey;
      ensureIntervalOption(config.intervalMinutes);
      document.getElementById('interval').value = String(config.intervalMinutes);

      // 최적화 모드
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

      // 배지 표시 모드
      initRadioGroup('usage-display-group', config.usageDisplayMode || '7d', () => {
        updateBadgePreview();
        autoSave();
      });

      document.getElementById('threshold-warn').value = String(config.thresholdWarn || 80);
      document.getElementById('threshold-danger').value = String(config.thresholdDanger || 95);
      document.getElementById('notify-reset-soon').checked = config.notifyResetSoon !== false;
      document.getElementById('notify-reset-done').checked = config.notifyResetDone !== false;
      document.getElementById('notify-usage-alert').checked = config.notifyUsageAlert !== false;
      document.getElementById('notify-weekly-report').checked = config.notifyWeeklyReport !== false;
      document.getElementById('notify-plan-change').checked = config.notifyPlanChange !== false;
      document.getElementById('notify-collect-fail').checked = config.notifyCollectFail !== false;
      updateBadgePreview();
    }
  );

  // 서버 기본 주기 표시
  chrome.storage.local.get({ serverPollInterval: null }, (data) => {
    const el = document.getElementById('interval-server-value');
    if (data.serverPollInterval) {
      el.textContent = `(${t('interval_current_server', data.serverPollInterval)})`;
    }
  });

  // === 자동 저장 이벤트 바인딩 ===
  // 수집 주기
  document.getElementById('interval-server-default').addEventListener('change', (e) => {
    document.getElementById('interval').disabled = e.target.checked;
    autoSave();
  });
  document.getElementById('interval').addEventListener('change', autoSave);

  // 임계값
  document.getElementById('threshold-warn').addEventListener('change', () => { validateThresholds(); updateBadgePreview(); autoSave(); });
  document.getElementById('threshold-danger').addEventListener('change', () => { validateThresholds(); updateBadgePreview(); autoSave(); });

  // 알림 체크박스
  document.querySelectorAll('#notify-list input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', autoSave);
  });

  // 현재 상태 표시
  loadStatus();

  // 리뷰 배너
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

  // 데이터 초기화 버튼
  document.getElementById('reset-btn').addEventListener('click', () => {
    if (!confirm(t('reset_confirm'))) return;
    chrome.storage.local.remove(['usageHistory', 'optimizationState', 'lastStatus', 'alertState'], () => {
      showToast(t('reset_done'));
      document.getElementById('history-count').textContent = '0';
      document.getElementById('last-collected').textContent = '-';
    });
  });
});

async function sendReviewNudgeAction(action) {
  try {
    const status = await new Promise(r => chrome.storage.local.get({ lastStatus: null }, r));
    const email = status.lastStatus?.snapshot?.user_email;
    if (!email) return;
    const { serverUrl, apiKey } = await new Promise(r =>
      chrome.storage.sync.get({ serverUrl: CT_CONFIG.DEFAULT_SERVER_URL, apiKey: CT_CONFIG.DEFAULT_API_KEY }, r)
    );
    if (!serverUrl || !apiKey) return;
    fetch(serverUrl + '/api/snapshots/review-nudge', {
      method: 'PATCH',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
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

// === Org 체크리스트 ===
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
      // 캐시 클리어 후 재로드
      chrome.storage.local.remove(['accountCache', 'autoSelectedOrg', 'collectedOrgs'], () => {
        loadOrgOptions();
        // 강제 재수집도 트리거
        chrome.runtime.sendMessage({ type: 'COLLECT_NOW', force: true });
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
      const isAutoAll = config.orgAutoAll !== false; // 기본 true

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

      // "전체 조직 자동 수집" 체크박스 (중복 등록 방지)
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
      // 전체 자동 모드: 모든 항목 체크 + 비활성화
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
  // 전체 자동 또는 전체 선택이면 카운트 숨김
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
