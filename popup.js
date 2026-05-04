let _currentPlan = null;
let _usageHistory = [];
let _currentSnapshot = null;
let _orgList = null; // cached org list
let _selectedOrgId = null; // selected org UUID (multi-org view)
let _collectedOrgs = []; // cached collectedOrgs (for _filteredHistory, selectOrg, etc.)
let _isAutoOrg = true; // auto mode (auto when selectedOrgId is null)
let _autoFollowing = true; // whether view follows cookie changes in auto mode (false when another chip is clicked)
let _lastRecommendation = null; // cached recommendation (restored when returning to primary org)

// Build auth headers for server requests (ext_token > API key fallback).
// Keep in sync with bg/storage.js#getAuthHeaders.
async function _getAuthHeaders(cfg) {
  const { extToken } = await chrome.storage.local.get('extToken');
  if (extToken) return { 'Authorization': `Bearer ${extToken}` };
  return { 'X-API-Key': cfg.apiKey || CT_CONFIG.DEFAULT_API_KEY };
}

// fetch wrapper that injects auth headers and clears stale ext_token on 401.
// Guarded against late-401 race (only clears if stored token still matches the
// one we sent) and API_KEY fallback (no Bearer → never clear).
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

// Return only history matching the selected org
function _filteredHistory() {
  if (!_selectedOrgId) return _usageHistory;
  // Include legacy history (without org field) when primary org is selected
  const isPrimarySelected = _collectedOrgs.find(o => o.uuid === _selectedOrgId)?.isPrimary;
  return _usageHistory.filter(p =>
    p.org === _selectedOrgId || (!p.org && isPrimarySelected)
  );
}

// === Announcements ===
const ANNOUNCEMENT_URL = CT_CONFIG.DEFAULT_SERVER_URL + '/api/announcements';

function _compareVersions(a, b) {
  // a >= b → true (semver: "1.7.2" >= "1.7.0")
  const pa = (a || '0').split('.').map(Number);
  const pb = (b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0, vb = pb[i] || 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return true; // equal
}

function _sanitizeNoticeHtml(html) {
  if (!html) return '';
  const SITE = 'https://claudetuner.com';
  // DOM-based sanitizer: allow only a, br tags, remove the rest
  const doc = new DOMParser().parseFromString(html, 'text/html');
  function walk(node) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += escHtml(child.textContent);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (tag === 'br') {
          out += '<br>';
        } else if (tag === 'a') {
          let href = child.getAttribute('href') || '#';
          if (href.toLowerCase().startsWith('javascript:')) href = '#';
          if (href.startsWith('/')) href = SITE + href;
          out += '<a href="' + escHtml(href) + '" target="_blank" rel="noopener">' + walk(child) + '</a>';
        } else {
          out += walk(child);
        }
      }
    }
    return out;
  }
  return walk(doc.body);
}

function _formatNoticeDate(dateStr) {
  if (!dateStr) return '';
  try { const d = new Date(dateStr); return (d.getMonth()+1) + '/' + d.getDate(); } catch(e) { return ''; }
}

const _noticeTypeMap = {
  info:     { cls: 'nb-info', icon: '\u2139\uFE0F', color: '#1E40AF' },
  warning:  { cls: 'nb-warning', icon: '\u26A0\uFE0F', color: '#92400E' },
  critical: { cls: 'nb-critical', icon: '\uD83D\uDEA8', color: '#991B1B' }
};

let _popupNoticeList = [];

async function loadPopupAnnouncements() {
  try {
    const cacheBuster = Math.floor(Date.now() / 3600000);
    const res = await fetch(ANNOUNCEMENT_URL + '?t=' + cacheBuster);
    const list = await res.json();
    if (!Array.isArray(list)) return;
    const extVer = chrome.runtime.getManifest().version;
    const userLang = getLang(); // 'ko' or 'en'
    _popupNoticeList = list.filter(n => {
      // Only show if current extension version meets min_version requirement
      if (n.min_version && !_compareVersions(extVer, n.min_version)) return false;
      // Only show lang-specific announcements to matching language users
      if (n.lang && n.lang !== userLang) return false;
      return true;
    });
    renderPopupNotices();
  } catch(e) {} // Silently ignore announcement fetch failures
}

function renderPopupNotices() {
  const container = document.getElementById('ct-popup-notices');
  const toggleBtn = document.getElementById('notice-toggle-btn');
  const badge = document.getElementById('notice-badge');
  if (!container) return;

  chrome.storage.local.get({ ct_dismissed_notices: [] }, (result) => {
    const dismissed = result.ct_dismissed_notices || [];
    const active = _popupNoticeList.filter(n => !dismissed.includes(n.id));

    // Header icon + badge
    if (toggleBtn) {
      if (_popupNoticeList.length > 0) {
        toggleBtn.style.display = '';
        if (badge) {
          badge.textContent = active.length;
          badge.style.display = active.length > 0 ? 'flex' : 'none';
        }
      } else {
        toggleBtn.style.display = 'none';
      }
    }

    // Sort by newest first
    active.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    let html = '';
    for (const n of active) {
      const t = _noticeTypeMap[n.type] || _noticeTypeMap.info;
      const dateStr = _formatNoticeDate(n.date);
      const hasBody = !!n.body;
      const safeId = escHtml(n.id || '');
      html += '<div class="notice-banner ' + t.cls + '">';
      html += '<div class="notice-header" data-nid="' + safeId + '"' + (n.url ? ' data-url="' + escHtml(n.url) + '"' : '') + '>';
      html += '<span class="notice-icon">' + t.icon + '</span>';
      if (!n.url && hasBody) html += '<span class="notice-chevron" id="chevron-' + safeId + '">\u25B6</span>';
      html += '<span class="notice-title" style="color:' + t.color + (n.url ? ';cursor:pointer' : '') + '">' + escHtml(n.title || '') + (n.url ? ' <span style="font-size:9px;opacity:0.5">\u2192</span>' : '') + '</span>';
      if (dateStr) html += '<span style="font-size:10px;color:#9ca3af;margin-right:2px">' + dateStr + '</span>';
      html += '<button class="notice-close" data-nid="' + safeId + '">\u00D7</button>';
      html += '</div>';
      if (!n.url && hasBody) html += '<div class="notice-body" id="nbody-' + safeId + '">' + _sanitizeNoticeHtml(n.body) + '</div>';
      html += '</div>';
    }
    container.innerHTML = html;

    // Header click: open Notion page if URL exists, otherwise toggle body
    container.querySelectorAll('.notice-header').forEach(hdr => {
      hdr.addEventListener('click', (e) => {
        if (e.target.closest('.notice-close')) return;
        const url = hdr.dataset.url;
        if (url) {
          const sep = url.includes('?') ? '&' : '?';
          chrome.tabs.create({ url: url + sep + 'utm_source=extension' });
          return;
        }
        const nid = hdr.dataset.nid;
        const body = document.getElementById('nbody-' + nid);
        const chevron = document.getElementById('chevron-' + nid);
        if (!body) return;
        const isOpen = body.style.display === 'block';
        body.style.display = isOpen ? 'none' : 'block';
        if (chevron) chevron.classList.toggle('open', !isOpen);
      });
    });

    // Close button event
    container.querySelectorAll('.notice-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nid = btn.dataset.nid;
        chrome.storage.local.get({ ct_dismissed_notices: [] }, (r) => {
          const arr = r.ct_dismissed_notices || [];
          if (!arr.includes(nid)) arr.push(nid);
          chrome.storage.local.set({ ct_dismissed_notices: arr }, () => renderPopupNotices());
        });
      });
    });

    // Auto-close panel if no active announcements
    if (active.length === 0) {
      container.style.display = 'none';
    }
  });
}

// === Organization Selection ===
function loadOrgSelector() {
  chrome.runtime.sendMessage({ type: 'GET_ORGANIZATIONS' }, (res) => {
    if (chrome.runtime.lastError || !res?.success) return;
    const orgs = res.orgs;
    _orgList = orgs;
    if (orgs.length < 2) return; // No selector needed for single org

    const container = document.getElementById('org-selector');
    if (!container) return;

    // Multi-org: show collected org badges if collectedOrgs exists
    chrome.storage.local.get({ collectedOrgs: null }, (local) => {
      _collectedOrgs = local.collectedOrgs || [];
      if (local.collectedOrgs && local.collectedOrgs.length > 0) {
        showMultiOrgBadges(local.collectedOrgs);
        return;
      }

      // Backward compatibility: handle existing selectedOrgId
      chrome.storage.sync.get({ selectedOrgId: null }, (config) => {
        if (config.selectedOrgId) {
          showOrgBadge(orgs, config.selectedOrgId);
        }
      });
    });
  });
}

function renderOrgSelector(container, orgs) {
  let html = '<div class="org-selector-title">' + t('org_selector_title') + '</div>';
  html += '<div class="org-selector-desc">' + t('org_selector_desc') + '</div>';

  for (const org of orgs) {
    html += '<div class="org-option" data-org-id="' + org.uuid + '">';
    html += '<div class="org-check"></div>';
    html += '<span class="org-name">' + escHtml(org.name) + '</span>';
    html += '<span class="org-plan">' + escHtml(org.plan) + '</span>';
    html += '</div>';
  }

  container.innerHTML = html;
  container.classList.remove('hidden');

  container.querySelectorAll('.org-option').forEach(el => {
    el.addEventListener('click', () => {
      const orgId = el.dataset.orgId;
      selectOrg(orgId, container);
    });
  });
}

function selectOrg(orgId, container) {
  if (container) {
    container.querySelectorAll('.org-option').forEach(el => {
      el.classList.toggle('selected', el.dataset.orgId === orgId);
    });
  }

  _selectedOrgId = orgId;

  // Look up selected org data from collectedOrgs
  chrome.storage.local.get({ collectedOrgs: [] }, (local) => {
    _collectedOrgs = local.collectedOrgs || [];
    const orgData = _collectedOrgs.find(o => o.uuid === orgId);
    if (!orgData) return;
    const hist = _filteredHistory();
    const isPrimary = orgData.isPrimary;
    const isEnterprise = /Enterprise/i.test(orgData.plan);
    const isUsageBased = isEnterprise && orgData.h5 == null && orgData.d7 == null;

    // resets_at: prefer collectedOrgs, fallback to primary
    const resetsAt5h = orgData.resetsAt5h || (isPrimary ? _currentSnapshot?.five_hour?.resets_at : null);
    const resetsAt7d = orgData.resetsAt7d || (isPrimary ? _currentSnapshot?.seven_day?.resets_at : null);

    // === 1. Display plan ===
    const planEl = document.getElementById('plan');
    if (planEl) planEl.textContent = orgData.plan || '';

    // === 2. Update gauges ===
    const gaugeSection = document.getElementById('gauge-section');
    const renewalGroup = document.getElementById('renewal-group');

    if (isUsageBased) {
      // Usage-based Enterprise: spending cap gauge
      if (renewalGroup) renewalGroup.style.display = 'none';
      if (orgData.spendLimit) {
        const usedDollars = Math.round((orgData.spendUsed || 0) / 100);
        const limitDollars = Math.round(orgData.spendLimit / 100);
        const spendPct = Math.min(Math.round((orgData.spendUsed || 0) / orgData.spendLimit * 100), 100);
        const spendColor = gaugeColor(spendPct);
        gaugeSection.innerHTML =
          '<div class="gauge-row"><div class="gauge-header">' +
          '<span class="gauge-label">Enterprise Spending</span>' +
          '<span class="gauge-value" style="color:' + spendColor + '">' + spendPct + '%</span></div>' +
          '<div class="gauge-bar"><div class="gauge-fill" style="width:' + Math.min(spendPct, 100) + '%;background:' + spendColor + '"></div></div>' +
          '<div class="gauge-sub" style="color:#6b7280;font-size:10px">$' + usedDollars + ' / $' + limitDollars + '</div></div>';
      } else {
        gaugeSection.innerHTML = '<div style="text-align:center;padding:6px 0">'
          + '<div style="font-size:13px;font-weight:600;color:#4f46e5">Enterprise</div>'
          + '<div style="font-size:11px;color:#6b7280;margin-top:2px">' + t('enterprise_unlimited') + '</div>'
          + '</div>';
      }
    } else {
      // 5h/7d gauge (common for Pro/Max/Team/Enterprise seat-based)
      if (isEnterprise || !isPrimary) {
        if (renewalGroup) renewalGroup.style.display = 'none';
      } else if (isPrimary && _currentSnapshot?.subscription?.renewal_date && renewalGroup) {
        renewalGroup.style.display = 'flex';
      }
      _restoreGaugeHTML(gaugeSection);
      const util5h = orgData.h5;
      const util7d = orgData.d7;
      if (util5h !== null && util5h !== undefined) {
        document.getElementById('gauge-5h-value').textContent = `${Math.round(util5h)}%`;
        document.getElementById('gauge-5h-fill').style.width = `${Math.min(util5h, 100)}%`;
        document.getElementById('gauge-5h-fill').style.background = gaugeColor(util5h);
        document.getElementById('gauge-5h-value').style.color = gaugeColor(util5h);
        renderGaugePrediction('5h', hist, 'h5', util5h, resetsAt5h);
      }
      if (util7d !== null && util7d !== undefined) {
        document.getElementById('gauge-7d-value').textContent = `${Math.round(util7d)}%`;
        document.getElementById('gauge-7d-fill').style.width = `${Math.min(util7d, 100)}%`;
        document.getElementById('gauge-7d-fill').style.background = gaugeColor(util7d);
        document.getElementById('gauge-7d-value').style.color = gaugeColor(util7d);
        renderGaugePrediction('7d', hist, 'd7', util7d, resetsAt7d);
      } else {
        // Plan without 7d data
        const g7dVal = document.getElementById('gauge-7d-value');
        if (g7dVal) {
          g7dVal.textContent = 'N/A';
          g7dVal.style.color = '#9ca3af';
        }
        const g7dFill = document.getElementById('gauge-7d-fill');
        if (g7dFill) g7dFill.style.width = '0';
      }
      // Display reset time
      if (resetsAt5h) {
        const r5h = document.getElementById('gauge-5h-reset');
        if (r5h) r5h.innerHTML = `<div>\u23f1 ${formatCountdown(resetsAt5h)}</div><div style="font-size:11px;color:#6b7280;font-weight:600;margin-top:1px">\u21bb ${formatResetAbsolute(resetsAt5h)}</div>`;
      }
      if (resetsAt7d) {
        const r7d = document.getElementById('gauge-7d-reset');
        if (r7d) r7d.innerHTML = `<div>\u23f1 ${formatCountdown(resetsAt7d)}</div><div style="font-size:11px;color:#6b7280;font-weight:600;margin-top:1px">\u21bb ${formatResetAbsolute(resetsAt7d)}</div>`;
      }
    }

    // === 3. Extra usage section ===
    const extraSection = document.getElementById('extra-usage-section');
    if (extraSection) {
      const eu = orgData.extraUsage;
      if (eu && eu.is_enabled && (eu.used_credits || 0) > 0) {
        extraSection.style.display = '';
        const usedCents = eu.used_credits || 0;
        const limitCents = eu.monthly_limit || 1;
        const util = Math.round((usedCents / limitCents) * 100);
        const used = (usedCents / 100).toFixed(2);
        const limit = (limitCents / 100).toFixed(0);
        const color = util >= 90 ? '#ef4444' : util >= 70 ? '#f59e0b' : '#22c55e';
        const summaryText = document.getElementById('extra-usage-summary-text');
        if (summaryText) summaryText.innerHTML = `${t('extra_usage_label')} <span id="extra-usage-help" style="cursor:pointer;color:#9ca3af;font-size:10px">(?)</span> <b style="color:${color}">$${used}/$${limit} (${util}%)</b>`;
        const fillEl = document.getElementById('extra-usage-fill');
        if (fillEl) { fillEl.style.width = `${Math.min(util, 100)}%`; fillEl.style.background = color; }
        const detailEl = document.getElementById('extra-usage-detail');
        if (detailEl) {
          const now = new Date();
          const nextMonth1st = new Date(now.getFullYear(), now.getMonth() + 1, 1);
          const dayNames = _currentLang === 'ko' ? ['일','월','화','수','목','금','토'] : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
          detailEl.textContent = `$${used} / $${limit} · ${nextMonth1st.getMonth() + 1}/1(${dayNames[nextMonth1st.getDay()]}) ${_currentLang === 'ko' ? '리셋' : 'reset'}`;
        }
      } else {
        extraSection.style.display = 'none';
      }
    }

    // === 4. Subscription / Pending plan ===
    const pendingRow = document.getElementById('pending-row');
    const cancelDowngradeBtn = document.getElementById('cancel-downgrade-btn');
    if (isPrimary) {
      // primary: restore subscription from _currentSnapshot
      if (_currentSnapshot?.subscription?.pending_plan) {
        if (pendingRow) {
          pendingRow.classList.remove('hidden');
          const planLabels = { pro_monthly: 'Pro', max_5x_monthly: 'Max 5x', max_20x_monthly: 'Max 20x', cancel: t('pending_cancel') };
          const pendingEl = document.getElementById('pending-plan');
          if (pendingEl) pendingEl.textContent = planLabels[_currentSnapshot.subscription.pending_plan] || _currentSnapshot.subscription.pending_plan;
          if (cancelDowngradeBtn && _currentSnapshot.subscription.pending_plan !== 'cancel') cancelDowngradeBtn.classList.remove('hidden');
        }
      } else {
        if (pendingRow) pendingRow.classList.add('hidden');
        if (cancelDowngradeBtn) cancelDowngradeBtn.classList.add('hidden');
      }
    } else {
      // non-primary: no subscription info available
      if (renewalGroup) renewalGroup.style.display = 'none';
      if (pendingRow) pendingRow.classList.add('hidden');
      if (cancelDowngradeBtn) cancelDowngradeBtn.classList.add('hidden');
    }

    // === 5. Recommendation ===
    const recRow = document.getElementById('recommendation-row');
    const recDetail = document.getElementById('smart-rec-detail');
    if (isPrimary && _lastRecommendation) {
      // primary: restore cached recommendation
      if (recRow) recRow.classList.remove('hidden');
      _renderRecommendation(_lastRecommendation);
    } else {
      // non-primary: no recommendation available
      if (recRow) recRow.classList.add('hidden');
      if (recDetail) recDetail.classList.add('hidden');
    }

    // === 6. Privacy row ===
    const privacyRow = document.getElementById('privacy-row');
    if (isPrimary && _currentSnapshot?.grove_enabled === true) {
      if (privacyRow) privacyRow.classList.remove('hidden');
    } else {
      if (privacyRow) privacyRow.classList.add('hidden');
    }

    // === 7. Fitness matrix ===
    const fitnessSection = document.getElementById('fitness-section');
    if (!isPrimary || isEnterprise) {
      if (fitnessSection) fitnessSection.classList.add('hidden');
    } else {
      // primary + non-Enterprise: show if cached data exists (managed by loadFitnessMatrix)
      // Try to re-show if it was hidden
      chrome.storage.local.get({ fitnessCache: null }, (fc) => {
        if (fc.fitnessCache?.data && fitnessSection) {
          fitnessSection.classList.remove('hidden');
        }
      });
    }

    // === 8. Update charts — clean snapshot ===
    const orgPlan = orgData.plan || _currentPlan;
    const orgSnapshot = {
      plan: orgPlan,
      five_hour: { utilization: orgData.h5, resets_at: resetsAt5h },
      seven_day: { utilization: orgData.d7, resets_at: resetsAt7d },
      extra_usage: orgData.extraUsage || (orgData.spendLimit ? { used_credits: orgData.spendUsed, monthly_limit: orgData.spendLimit } : null),
    };
    // Enterprise usage-based: no 5h/7d tab rolling needed, stop it. Restored on org switch
    if (isUsageBased) {
      _stopChartAutoRoll();
    } else if (_chartAutoRoll && !_chartRollIntervalId) {
      _startChartAutoRoll();
    }
    if (hist.length >= 2 || isUsageBased) {
      drawCharts(hist, orgPlan, orgSnapshot);
    }

    // === 9. Status banner ===
    if (isUsageBased) {
      // Enterprise usage-based: hide banner since no 5h/7d data
      const banner = document.getElementById('status-banner');
      if (banner) banner.classList.add('hidden');
    } else if (hist.length >= 3) {
      renderStatusBanner(orgData.h5 ?? null, orgData.d7 ?? null, hist, resetsAt5h, resetsAt7d);
    }

    // Peak hours banner
    renderPeakBanner();
  });

  if (container) {
    setTimeout(() => container.classList.add('hidden'), 300);
  }

  // Update org chip active state
  document.querySelectorAll('.org-chip').forEach(chip => {
    chip.classList.toggle('selected', chip.dataset?.orgId === orgId);
  });
}

function showMultiOrgBadges(collectedOrgs) {
  if (collectedOrgs.length < 2) return; // Only show when 2 or more orgs

  const userInfo = document.getElementById('user-info');
  if (!userInfo) return;

  // Remove existing display
  const existing = document.getElementById('org-chips');
  if (existing) existing.remove();
  const existingBadge = document.getElementById('org-badge');
  if (existingBadge) existingBadge.remove();

  const wrapper = document.createElement('div');
  wrapper.id = 'org-chips';
  wrapper.className = 'org-chips';

  // Auto toggle row + description
  const autoRow = document.createElement('div');
  autoRow.className = 'org-auto-row';
  const autoLabel = document.createElement('label');
  autoLabel.className = 'org-auto-toggle';
  const autoCheckbox = document.createElement('input');
  autoCheckbox.type = 'checkbox';
  autoCheckbox.checked = _isAutoOrg;
  autoCheckbox.className = 'org-auto-cb';
  autoLabel.appendChild(autoCheckbox);
  autoLabel.appendChild(document.createTextNode(' Auto'));
  autoRow.appendChild(autoLabel);
  const autoDesc = document.createElement('span');
  autoDesc.className = 'org-auto-desc';
  autoDesc.textContent = _isAutoOrg ? t('org_auto_on') : t('org_auto_off');
  autoRow.appendChild(autoDesc);
  wrapper.appendChild(autoRow);

  autoCheckbox.addEventListener('change', () => {
    _isAutoOrg = autoCheckbox.checked;
    _autoFollowing = _isAutoOrg; // Auto ON: resume following
    autoDesc.textContent = _isAutoOrg ? t('org_auto_on') : t('org_auto_off');
    if (_isAutoOrg) {
      // Auto ON: reset selectedOrgId, read current active org from cookie and switch immediately
      chrome.storage.sync.set({ selectedOrgId: null });
      // Read directly from cookie (instead of background message — side panel compatible)
      chrome.cookies.get({ name: 'lastActiveOrg', url: 'https://claude.ai' }, (cookie) => {
        const cookieOrgId = cookie?.value || null;
        const target = (cookieOrgId && _collectedOrgs.find(o => o.uuid === cookieOrgId))
          || _collectedOrgs.find(o => o.isPrimary);
        if (target) {
          _collectedOrgs.forEach(o => { o.isPrimary = (o.uuid === target.uuid); });
          chrome.storage.local.set({ collectedOrgs: _collectedOrgs });
          _selectedOrgId = target.uuid;
          selectOrg(target.uuid, null);
        }
        showMultiOrgBadges(_collectedOrgs);
      });
    } else {
      showMultiOrgBadges(_collectedOrgs);
    }
  });

  // Sort: Personal > Team > Enterprise
  const planOrder = (plan) => {
    if (/Enterprise/i.test(plan)) return 3;
    if (/Team/i.test(plan)) return 2;
    return 1;
  };
  const sorted = [...collectedOrgs].sort((a, b) => planOrder(a.plan) - planOrder(b.plan));

  // Pin SVGs
  const pinSvgFilled = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5a.5.5 0 0 1-1 0V10h-4A.5.5 0 0 1 3 9.5c0-.973.64-1.725 1.17-2.189A6 6 0 0 1 5 6.708V2.277a3 3 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354"/></svg>';
  const pinSvgOutline = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5a.5.5 0 0 1-1 0V10h-4A.5.5 0 0 1 3 9.5c0-.973.64-1.725 1.17-2.189A6 6 0 0 1 5 6.708V2.277a3 3 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354m1.58 1.408l-.002-.001zm-.002-.001.002.001A.5.5 0 0 0 6 2v5a.5.5 0 0 1-.276.447h-.002l-.012.007-.054.03a5 5 0 0 0-.827.58c-.318.278-.585.596-.725.936h7.792c-.14-.34-.407-.658-.725-.936a5 5 0 0 0-.881-.61l-.012-.006h-.002A.5.5 0 0 1 10 7V2a.5.5 0 0 0 .295-.458 1.8 1.8 0 0 0 .351-.271q.088-.088.143-.173H5.211q.055.085.143.173c.12.12.27.227.35.271"/></svg>';

  for (const org of sorted) {
    const chip = document.createElement('div');
    const isSelected = org.uuid === _selectedOrgId || (!_selectedOrgId && org.isPrimary);
    chip.className = 'org-chip' + (org.isPrimary ? ' primary' : '') + (isSelected ? ' selected' : '');
    chip.title = org.name;
    chip.dataset.orgId = org.uuid;

    const isEnterprise = /Enterprise/i.test(org.plan);
    let usageText;
    if (isEnterprise && org.spendLimit != null) {
      const used = Math.round((org.spendUsed || 0) / 100);
      const limit = Math.round(org.spendLimit / 100);
      const pct = org.spendLimit > 0 ? Math.round((org.spendUsed || 0) / org.spendLimit * 100) : 0;
      usageText = `$${used}/$${limit} (${pct}%)`;
    } else {
      usageText = org.d7 != null ? Math.round(org.d7) + '%' : '-';
    }

    // Auto mode: show lightning badge on primary org (indicates active org, separate from view selection)
    var activeBadge = (_isAutoOrg && org.isPrimary) ? '<span class="org-chip-active" title="Active org">\u26A1</span>' : '';

    chip.innerHTML =
      '<span class="org-chip-plan">' + escHtml(org.plan) + '</span>' +
      '<span class="org-chip-name">' + escHtml(org.name) + '</span>' +
      activeBadge +
      '<span class="org-chip-usage">' + usageText + '</span>';

    // Pin icon: always visible. Click to turn Auto OFF and pin to this org
    const pin = document.createElement('span');
    const isPinned = !_isAutoOrg && org.isPrimary;
    pin.className = 'org-chip-pin' + (isPinned ? ' active' : '');
    pin.innerHTML = isPinned ? pinSvgFilled : pinSvgOutline;
    pin.title = t('org_set_primary');
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isPinned) return; // Already pinned to this org
      // Auto OFF + pin to this org
      _isAutoOrg = false;
      _collectedOrgs.forEach(o => { o.isPrimary = (o.uuid === org.uuid); });
      chrome.storage.local.set({ collectedOrgs: _collectedOrgs });
      chrome.storage.sync.set({ selectedOrgId: org.uuid });
      // Sync to server immediately
      chrome.storage.sync.get({ serverUrl: '', apiKey: '' }, (cfg) => {
        if (!cfg.serverUrl) return;
        chrome.storage.local.get({ lastStatus: null }, async (local) => {
          const email = local.lastStatus?.snapshot?.user_email;
          if (!email) return;
          _authedFetch(cfg, `${cfg.serverUrl}/api/snapshots/primary-org`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_email: email, primary_org_uuid: org.uuid }),
          }).catch(() => {});
        });
      });
      _selectedOrgId = org.uuid;
      selectOrg(org.uuid, null);
      showMultiOrgBadges(_collectedOrgs);
      // Toast notification
      const toast = document.createElement('div');
      toast.textContent = t('org_primary_changed');
      toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1e1b4b;color:white;padding:8px 16px;border-radius:8px;font-size:11px;font-weight:600;z-index:9999;transition:opacity 0.5s;white-space:nowrap;';
      document.body.appendChild(toast);
      setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 500); }, 1500);
    });
    chip.appendChild(pin);

    chip.addEventListener('click', () => {
      // Auto mode: clicking primary chip resumes following, other chips stop following
      if (_isAutoOrg) _autoFollowing = org.isPrimary;
      selectOrg(org.uuid, null);
    });
    wrapper.appendChild(chip);
  }

  userInfo.parentNode.insertBefore(wrapper, userInfo);
}

function showOrgBadge(orgs, selectedId) {
  const org = orgs.find(o => o.uuid === selectedId);
  if (!org) return;

  const userInfo = document.getElementById('user-info');
  if (!userInfo) return;

  const existing = document.getElementById('org-badge');
  if (existing) existing.remove();

  const badge = document.createElement('span');
  badge.id = 'org-badge';
  badge.className = 'org-badge';
  badge.title = t('org_select');
  badge.textContent = org.name + ' (' + org.plan + ')';
  badge.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#collect-settings') }));
  userInfo.parentNode.insertBefore(badge, userInfo);
}

// === Chart tab state ===
let _activeChartTab = '5h';
let _chartRollIntervalId = null;
let _chartAutoRoll = true; // Default: auto-rolling enabled

function _switchChartTab(target) {
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

function _startChartAutoRoll() {
  if (_chartRollIntervalId) return;
  _chartRollIntervalId = setInterval(() => {
    _switchChartTab(_activeChartTab === '5h' ? '7d' : '5h');
  }, 5000);
}

function _stopChartAutoRoll() {
  if (_chartRollIntervalId) { clearInterval(_chartRollIntervalId); _chartRollIntervalId = null; }
}

function _toggleChartAutoRoll() {
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

// === Plan Fitness Matrix ===
const FM_CACHE_TTL = 8 * 3600000; // 8h
const FM_WINDOWS = ['24h', '7d', '14d'];

function _fmIcon(level) {
  const map = {
    exceeded:     { cls: 'fm-exceeded', label: 'fm_lv_exceeded', icon: '\u2715' },
    tight:        { cls: 'fm-tight',    label: 'fm_lv_tight',    icon: '\u2713' },
    fit:          { cls: 'fm-fit',      label: 'fm_lv_fit',      icon: '\u2713' },
    overspend:    { cls: 'fm-overspend',label: 'fm_lv_overspend',icon: '\u2193' },
    nodata:       { cls: 'fm-unknown',  label: 'fm_nodata',      icon: '\u2014' },
    collecting:   { cls: 'fm-unknown',  label: 'fm_collecting',  icon: '\u2026' },
    insufficient: { cls: 'fm-unknown',  label: 'fm_insufficient',icon: '\u2014' },
  };
  return map[level] || map.nodata;
}

function renderFitnessMatrix(data) {
  const section = document.getElementById('fitness-section');
  const content = document.getElementById('fm-content');
  if (!section || !content || !data || !data.plans || !data.plans.length) {
    if (section) section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  let html = '<table class="fm-table"><thead><tr>';
  html += '<th>' + t('fm_col_plan') + '</th>';
  for (const w of FM_WINDOWS) html += '<th>' + t('fm_window_' + w).replace('\n', '<br>') + '</th>';
  html += '</tr></thead><tbody>';

  for (const plan of data.plans) {
    const isRef = plan.ref;
    html += '<tr' + (isRef ? ' class="fm-ref"' : '') + '>';
    // Plan name + badges
    html += '<td>' + escHtml(plan.name);
    if (!isRef && plan.name === data.current_plan) {
      html += '<span class="fm-badge fm-badge-current">' + t('fm_badge_current') + '</span>';
    }
    if (!isRef && plan.name === data.rec_plan && plan.name !== data.current_plan) {
      html += '<span class="fm-badge fm-badge-rec">' + t('fm_badge_rec') + '</span>';
    }
    if (isRef) {
      html += '<span class="fm-badge" style="background:#f3f4f6;color:#9ca3af">' + t('fm_ref') + '</span>';
    }
    html += '</td>';
    // Windows
    for (const w of FM_WINDOWS) {
      const cell = plan.windows && plan.windows[w];
      if (!cell) {
        html += '<td><span class="fm-icon fm-unknown">\u2014</span></td>';
        continue;
      }
      const m = _fmIcon(cell.level);
      let title = t(m.label);
      if (cell.projected != null) title += ' (' + Math.round(cell.projected) + '%)';
      if (cell.partial) title += ' *';
      // Show wait time for exceeded/tight cells on current plan
      if (plan.name === data.current_plan && data.wait_total && data.wait_total.total > 0 && (cell.level === 'exceeded' || cell.level === 'tight')) {
        const wt = data.wait_total;
        const _fmW = (m) => { const h = Math.floor(m/60); const mm = m%60; return h > 0 ? h + 'h ' + mm + 'm' : mm + 'm'; };
        title += '\n' + t('fm_wait_time') + ': ' + _fmW(wt.total);
      }
      html += '<td><span class="fm-icon ' + m.cls + '" title="' + escHtml(title) + '">' + m.icon + '</span></td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  // Legend + view reasons
  const legend = [
    { cls: 'fm-exceeded', icon: '\u2715', label: t('fm_lv_exceeded') },
    { cls: 'fm-tight',    icon: '\u2713', label: t('fm_lv_tight') },
    { cls: 'fm-fit',      icon: '\u2713', label: t('fm_lv_fit') },
    { cls: 'fm-overspend',icon: '\u2193', label: t('fm_lv_overspend') },
    { cls: 'fm-unknown',  icon: '\u2014', label: t('fm_nodata') },
  ];
  html += '<div class="fm-legend"><div class="fm-legend-items">';
  for (const l of legend) {
    html += '<span class="fm-legend-item"><span class="fm-icon ' + l.cls + '">' + l.icon + '</span>' + l.label + '</span>';
  }
  html += '</div><a href="https://claudetuner.com/dashboard" target="_blank">' + t('fm_reason') + ' →</a></div>';
  content.innerHTML = html;
}

async function loadFitnessMatrix() {
  const section = document.getElementById('fitness-section');
  if (!section) return;

  // Need user email from lastStatus
  const { lastStatus, fitnessCache } = await new Promise(r =>
    chrome.storage.local.get({ lastStatus: null, fitnessCache: null }, r)
  );
  const email = lastStatus?.snapshot?.user_email;
  const plan = lastStatus?.snapshot?.plan || '';
  // Enterprise users don't need fitness matrix
  if (!email || plan.toLowerCase().includes('enterprise')) {
    return;
  }

  // Show cached data immediately
  if (fitnessCache && fitnessCache.data) {
    section.classList.remove('hidden');
    renderFitnessMatrix(fitnessCache.data);
  }

  // Check if cache is fresh
  if (fitnessCache && fitnessCache.fetched_at && (Date.now() - fitnessCache.fetched_at < FM_CACHE_TTL)) {
    return; // Cache is fresh, no need to fetch
  }

  // Fetch from server
  try {
    const cfg = await new Promise(r =>
      chrome.storage.sync.get({ serverUrl: CT_CONFIG.DEFAULT_SERVER_URL, apiKey: CT_CONFIG.DEFAULT_API_KEY }, r)
    );
    if (!cfg.serverUrl) return;

    const res = await _authedFetch(cfg, cfg.serverUrl + '/api/snapshots/fitness?user_email=' + encodeURIComponent(email));
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.plans) return;

    chrome.storage.local.set({ fitnessCache: { data, fetched_at: Date.now() } });
    renderFitnessMatrix(data);
    section.classList.remove('hidden');
  } catch (e) {
    // Silently fail — cached data (if any) is already shown
  }
}


function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', async () => {
  await initI18n();
  sendGAEvent('popup_open');

  // Request immediate local-only refresh if data is stale (>1 min)
  chrome.runtime.sendMessage({ type: 'POPUP_OPENED' }).catch(() => {});

  // Check for deleted account
  const { account_deleted } = await chrome.storage.local.get({ account_deleted: false });
  if (account_deleted) {
    document.getElementById('status-indicator').className = 'status-dot red';
    document.getElementById('status-text').textContent = t('account_deleted_msg') || 'Account deleted';
    const errorBanner = document.getElementById('error-banner');
    const errorMsg = document.getElementById('error-msg');
    errorMsg.innerHTML = (t('account_deleted_detail') || 'This account has been deleted. Data collection has stopped.')
      + '<br><a id="recover-link" href="#" style="display:inline-block;margin-top:8px;padding:6px 14px;background:#7c3aed;color:#fff;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none">'
      + (t('account_recover_btn') || 'Recover Account') + '</a>';
    errorBanner.classList.remove('hidden');
    // Hide hint area
    const hintEl = errorBanner.querySelector('.error-hint');
    if (hintEl) hintEl.style.display = 'none';
    document.getElementById('recover-link').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.storage.local.remove('account_deleted');
      chrome.tabs.create({ url: 'https://claudetuner.com/dashboard/settings/' });
    });
    return;
  }

  loadPopupAnnouncements();
  loadOrgSelector();
  loadFitnessMatrix();

  // Fitness table click opens dashboard (except link clicks)
  const fmSection = document.getElementById('fitness-section');
  if (fmSection) {
    fmSection.title = 'Dashboard';
    fmSection.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      chrome.tabs.create({ url: 'https://claudetuner.com/dashboard' });
    });
  }

  // Announcement toggle button
  const noticeToggle = document.getElementById('notice-toggle-btn');
  const noticePanel = document.getElementById('ct-popup-notices');
  if (noticeToggle && noticePanel) {
    noticeToggle.addEventListener('click', () => {
      const visible = noticePanel.style.display !== 'none';
      noticePanel.style.display = visible ? 'none' : '';
    });
  }
  let _statusReady = false, _historyReady = false;

  function tryDrawCharts() {
    if (!_statusReady || !_historyReady) return;
    const hist = _filteredHistory();
    const isUsageBasedEnt = (_currentPlan || '').includes('Enterprise') && _currentSnapshot?.five_hour?.utilization == null && _currentSnapshot?.seven_day?.utilization == null;
    if (hist.length >= 2 || isUsageBasedEnt) {
      drawCharts(hist, _currentPlan, _currentSnapshot);
      if (_chartAutoRoll && !isUsageBasedEnt) _startChartAutoRoll();
    }
    // Refresh banner after history load (reflects rate-based prediction)
    if (hist.length >= 3 && _currentSnapshot) {
      const s = _currentSnapshot;
      renderStatusBanner(s.five_hour?.utilization ?? null, s.seven_day?.utilization ?? null, hist, s.five_hour?.resets_at, s.seven_day?.resets_at);
    }
  }

  // Load current status + history directly from chrome.storage
  // Restore Auto/Manual + selected org from selectedOrgId (sync)
  chrome.storage.sync.get({ selectedOrgId: null }, (syncCfg) => {
    _isAutoOrg = !syncCfg.selectedOrgId;

    chrome.storage.local.get({ lastStatus: null, usageHistory: [], collectedOrgs: [] }, (result) => {
      _usageHistory = result.usageHistory || [];
      _historyReady = true;

      // Multi-org: initialize with saved org for Manual, primary org for Auto
      const cOrgs = result.collectedOrgs || [];
      if (cOrgs.length >= 1) {
        _collectedOrgs = cOrgs;
        if (!_isAutoOrg && syncCfg.selectedOrgId) {
          // Manual mode: restore user-pinned org
          const manualOrg = cOrgs.find(o => o.uuid === syncCfg.selectedOrgId);
          if (manualOrg) _selectedOrgId = manualOrg.uuid;
          else _selectedOrgId = cOrgs.find(o => o.isPrimary)?.uuid || cOrgs[0]?.uuid || null;
        } else {
          // Auto mode: primary org (fallback to first org if no primary)
          const primary = cOrgs.find(o => o.isPrimary) || cOrgs[0];
          if (primary) _selectedOrgId = primary.uuid;
        }
      }

      const status = result.lastStatus;
      updateUI(status);
      if (status) {
        _currentPlan = status?.snapshot?.plan || null;
        _currentSnapshot = status?.snapshot || null;
        loadFitnessMatrix();
      }
      _statusReady = true;

      tryDrawCharts();
      initRunner();
    });
  });

  // Re-render popup immediately when language is changed in options
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.lang) {
      setLang(changes.lang.newValue);
      // Full UI re-render including dynamically generated text
      chrome.storage.local.get({ lastStatus: null, usageHistory: [], collectedOrgs: [] }, (r) => {
        _usageHistory = r.usageHistory || [];
        if (r.lastStatus) {
          // Reset to primary org uuid (null would mix multi-org histories)
          const cOrgs = r.collectedOrgs || [];
          if (cOrgs.length >= 1) _collectedOrgs = cOrgs;
          const primary = _collectedOrgs.find(o => o.isPrimary) || _collectedOrgs[0];
          _selectedOrgId = primary ? primary.uuid : null;
          updateUI(r.lastStatus);
          _currentPlan = r.lastStatus?.snapshot?.plan || null;
          _currentSnapshot = r.lastStatus?.snapshot || null;
          const hist = _filteredHistory();
          if (hist.length >= 2) drawCharts(hist, _currentPlan, _currentSnapshot);
          if (hist.length >= 3 && _currentSnapshot) {
            renderStatusBanner(_currentSnapshot.five_hour?.utilization ?? null, _currentSnapshot.seven_day?.utilization ?? null, hist, _currentSnapshot.five_hour?.resets_at, _currentSnapshot.seven_day?.resets_at);
          }
        }
        // Re-render org chips too (reflects plan name translations, etc.)
        if (_collectedOrgs.length >= 2) showMultiOrgBadges(_collectedOrgs);
        loadFitnessMatrix();
      });
    }
  });

  // Immediately reflect cookie org changes
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'ORG_COOKIE_CHANGED' || !_isAutoOrg || !msg.orgId) return;
    // Move lightning badge
    document.querySelectorAll('#org-chips .org-chip-active').forEach(el => el.remove());
    const targetChip = document.querySelector('#org-chips .org-chip[data-org-id="' + msg.orgId + '"]');
    if (targetChip) {
      const badge = document.createElement('span');
      badge.className = 'org-chip-active';
      badge.title = 'Active org';
      badge.textContent = '\u26A1';
      const usageEl = targetChip.querySelector('.org-chip-usage');
      if (usageEl) targetChip.insertBefore(badge, usageEl);
      else targetChip.appendChild(badge);
    }
    // Switch view if in following mode
    if (_autoFollowing && _selectedOrgId !== msg.orgId) {
      _selectedOrgId = msg.orgId;
      document.querySelectorAll('#org-chips .org-chip').forEach(c => {
        c.classList.toggle('selected', c.dataset.orgId === msg.orgId);
      });
      selectOrg(msg.orgId, null);
    }
  });

  // Auto-refresh on background collection success (while side panel/popup is open)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    // Immediately refresh org chips when collectedOrgs changes
    if (changes.collectedOrgs) {
      _collectedOrgs = changes.collectedOrgs.newValue || [];
      if (_collectedOrgs.length >= 2) {
        showMultiOrgBadges(_collectedOrgs);
        // Refresh selected org data (without switching view)
        if (_selectedOrgId) {
          selectOrg(_selectedOrgId, null);
        }
      }
    }

    if (!changes.lastStatus) return;
    const status = changes.lastStatus.newValue;
    if (status) {
      _usageHistory = []; // History is refreshed separately
      chrome.storage.local.get({ usageHistory: [] }, (r) => {
        _usageHistory = r.usageHistory || [];
        updateUI(status);
        // Since updateUI early returns when non-primary org is selected,
        // charts/banners below only execute when primary is displayed
        const selOrg = _collectedOrgs.find(o => o.uuid === _selectedOrgId);
        if (_selectedOrgId && selOrg && !selOrg.isPrimary) return;
        _currentPlan = status?.snapshot?.plan || null;
        _currentSnapshot = status?.snapshot || null;
        const hist = _filteredHistory();
        if (hist.length >= 2) drawCharts(hist, _currentPlan, _currentSnapshot);
        if (hist.length >= 3 && _currentSnapshot) {
          renderStatusBanner(_currentSnapshot.five_hour?.utilization ?? null, _currentSnapshot.seven_day?.utilization ?? null, hist, _currentSnapshot.five_hour?.resets_at, _currentSnapshot.seven_day?.resets_at);
        }
      });
    }
  });

  // Manual collection button
  document.getElementById('collect-btn').addEventListener('click', () => {
    const btn = document.getElementById('collect-btn');
    btn.disabled = true;
    btn.classList.add('loading');
    btn.textContent = t('collecting');

    chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' }, (result) => {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.textContent = t('btn_collect');
      // Reset onboarding CTA
      const obBtn = document.getElementById('ob-collect-btn');
      if (obBtn) { obBtn.disabled = false; obBtn.textContent = t('ob_cta'); }

      if (chrome.runtime.lastError) {
        showError(t('cancel_fail'));
        return;
      }

      // Update UI with saved lastStatus for both success/failure (including error banner)
      chrome.storage.local.get({ lastStatus: null, usageHistory: [] }, (r) => {
        // Must assign history first so updateUI -> renderGaugePrediction can reference it
        _usageHistory = r.usageHistory || [];
        const s = r.lastStatus;
        if (s) {
          updateUI(s);
          _currentPlan = s?.snapshot?.plan || null;
          _currentSnapshot = s?.snapshot || null;
        }
        // If non-primary org is selected, charts/banners are handled by selectOrg
        const selOrg = _collectedOrgs.find(o => o.uuid === _selectedOrgId);
        if (_selectedOrgId && selOrg && !selOrg.isPrimary) return;
        const hist2 = _filteredHistory();
        if (hist2.length >= 2) drawCharts(hist2, _currentPlan, _currentSnapshot);
        if (hist2.length >= 3 && _currentSnapshot) {
          renderStatusBanner(_currentSnapshot.five_hour?.utilization ?? null, _currentSnapshot.seven_day?.utilization ?? null, hist2, _currentSnapshot.five_hour?.resets_at, _currentSnapshot.seven_day?.resets_at);
        }
      });
      if (result && result.success) {
        // Re-check org selector after first successful collection (show if previously hidden)
        if (!_orgList) loadOrgSelector();
        // Refresh org chip usage rates
        chrome.storage.local.get({ collectedOrgs: null }, (local) => {
          _collectedOrgs = local.collectedOrgs || [];
          if (local.collectedOrgs && local.collectedOrgs.length >= 2) {
            showMultiOrgBadges(local.collectedOrgs);
          }
        });
        // Invalidate fitness cache and reload
        chrome.storage.local.remove('fitnessCache', () => loadFitnessMatrix());
      }
    });
  });

  // Onboarding CTA button -> start collection
  document.getElementById('ob-collect-btn').addEventListener('click', () => {
    document.getElementById('collect-btn').click();
    const obBtn = document.getElementById('ob-collect-btn');
    obBtn.disabled = true;
    obBtn.textContent = t('ob_collecting');
  });

  // Side panel / popup mode switch
  const openTabBtn = document.getElementById('open-tab-btn');

  // Side panel pin hint (one-time)
  chrome.storage.local.get({ pinHintDismissed: false, preferSidePanel: true, lastStatus: null }, (ph) => {
    if (ph.preferSidePanel && !ph.pinHintDismissed) {
      const pinHint = document.getElementById('pin-hint');
      const pinText = document.getElementById('pin-hint-text');
      if (pinHint && pinText) {
        const pinSvg = '<svg width="14" height="14" viewBox="0 0 24 24" style="vertical-align:-3px"><path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" fill="none" stroke="#5b21b6" stroke-width="1.5"/></svg>';
        pinText.innerHTML = t('pin_hint_text_html').replace('{pin}', pinSvg);
        // Show badge with actual utilization
        const snap = ph.lastStatus?.snapshot;
        const badgeEl = document.getElementById('pin-hint-badge');
        if (badgeEl && snap) {
          const util = Math.round(Math.max(snap.five_hour?.utilization || 0, snap.seven_day?.utilization || 0));
          badgeEl.textContent = util + '%';
        }
        const beforeEl = document.getElementById('pin-hint-before');
        const afterEl = document.getElementById('pin-hint-after');
        if (beforeEl) beforeEl.textContent = t('pin_hint_before');
        if (afterEl) afterEl.textContent = t('pin_hint_after');
        pinHint.style.display = 'block';
        document.getElementById('pin-hint-close').addEventListener('click', () => {
          pinHint.style.display = 'none';
          chrome.storage.local.set({ pinHintDismissed: true });
        });
      }
    }
  });

  // Determine mode based on preferSidePanel
  chrome.storage.local.get({ preferSidePanel: true }, (r) => {
    if (r.preferSidePanel) {
      // Side panel mode: "Switch to popup" button
      openTabBtn.title = t('btn_back_popup') || 'Switch to popup';
      openTabBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm10 0v12h3V4h-3zM4 4v12h7V4H4z" clip-rule="evenodd"/></svg>';
      openTabBtn.addEventListener('click', async () => {
        await chrome.storage.local.set({ preferSidePanel: false });
        chrome.runtime.sendMessage({ type: 'SET_SIDE_PANEL_MODE', enabled: false });
        // Show toast, fade out, then close
        const toast = document.createElement('div');
        toast.textContent = t('toast_popup_next') || 'Next time it will open as a popup';
        toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1e1b4b;color:white;padding:10px 20px;border-radius:8px;font-size:12px;font-weight:600;z-index:9999;transition:opacity 0.5s;white-space:nowrap;';
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; }, 1200);
        setTimeout(() => { window.close(); }, 1800);
      });
    } else {
      // Popup mode: hide switch button if sidePanel API is unavailable (e.g. Arc)
      if (!(chrome.sidePanel && chrome.sidePanel.open)) {
        openTabBtn.style.display = 'none';
      } else {
        openTabBtn.addEventListener('click', async () => {
          try {
            const win = await chrome.windows.getCurrent();
            await chrome.sidePanel.open({ windowId: win.id });
            await chrome.storage.local.set({ preferSidePanel: true });
            chrome.runtime.sendMessage({ type: 'SET_SIDE_PANEL_MODE', enabled: true });
            window.close();
          } catch (e) {
            chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
          }
        });
      }
    }
  });

  // Open settings page
  document.getElementById('options-btn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Chart tab switching
  document.querySelectorAll('.chart-tab').forEach(tab => {
    if (tab.id === 'chart-autoroll-btn') {
      // Play/Pause toggle button
      tab.addEventListener('click', (e) => {
        e.stopPropagation();
        _toggleChartAutoRoll();
      });
    } else {
      // 5h/7d tab manual click
      tab.addEventListener('click', (e) => {
        e.stopPropagation();
        _switchChartTab(tab.dataset.tab);
        // Reset timer if auto-rolling on manual click
        if (_chartAutoRoll && _chartRollIntervalId) {
          _stopChartAutoRoll();
          _startChartAutoRoll();
        }
      });
    }
  });
  // Chart card click opens dashboard
  document.getElementById('chart-section').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://claudetuner.com/dashboard' });
  });

  // Smart recommendation dismiss button
  document.getElementById('smart-rec-dismiss').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'DISMISS_RECOMMENDATION' }, () => {
      document.getElementById('smart-rec-detail').classList.add('hidden');
      document.getElementById('smart-rec-mute').classList.add('hidden');
      document.getElementById('recommendation').textContent = t('current_plan_ok');
      document.getElementById('recommendation').style.color = '#166534';
      chrome.storage.local.get({ lastStatus: {} }, (r) => {
        const rt = r.lastStatus?.recommendation?.type;
        if (rt) showRecFeedback(rt);
      });
    });
  });

  // Smart recommendation permanent mute button
  document.getElementById('smart-rec-mute').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'MUTE_RECOMMENDATION' }, () => {
      document.getElementById('smart-rec-detail').classList.add('hidden');
      document.getElementById('smart-rec-mute').classList.add('hidden');
      document.getElementById('recommendation').textContent = t('current_plan_ok');
      document.getElementById('recommendation').style.color = '#166534';
    });
  });

  // Smart recommendation execute button
  document.getElementById('smart-rec-btn').addEventListener('click', () => {
    const btn = document.getElementById('smart-rec-btn');
    btn.disabled = true;
    btn.textContent = t('changing');

    chrome.storage.local.get({ lastStatus: {} }, (result) => {
      const recommendation = result.lastStatus?.recommendation;
      if (!recommendation?.type) { btn.textContent = t('no_recommend'); return; }

      chrome.runtime.sendMessage({ type: 'EXECUTE_PLAN_CHANGE', recommendation }, (res) => {
        btn.disabled = false;
        if (res?.success) {
          document.getElementById('smart-rec-detail').classList.add('hidden');
          document.getElementById('recommendation').textContent = t('change_done');
          document.getElementById('recommendation').style.color = '#059669';
          showRecFeedback(recommendation.type);
        } else {
          btn.textContent = t('opt_execute');
          showError(res?.error || t('collect_fail'));
        }
      });
    });
  });

  // Render plan change order banner
  chrome.storage.local.get({ pendingPlanOrder: null, completedPlanOrder: null }, (store) => {
    const po = store.pendingPlanOrder;
    const completed = store.completedPlanOrder;
    if (po) {
      const banner = document.getElementById('plan-order-banner');
      banner.classList.remove('hidden');
      banner.dataset.po = JSON.stringify(po);
      const COSTS = { 'Pro': 20, 'Max 5x': 100, 'Max 20x': 200 };
      document.getElementById('plan-order-body').innerHTML =
        `<strong>${po.org_name}</strong> ${t('plan_order_admin')}(${po.requested_by_name})<br>` +
        `<strong>${po.from_plan} → ${po.to_plan}</strong> ${t('plan_order_request')}`;
      if (po.reason) {
        const reasonEl = document.getElementById('plan-order-reason');
        reasonEl.classList.remove('hidden');
        reasonEl.textContent = '💬 ' + po.reason;
      }
      const fromCost = COSTS[po.from_plan] || 0;
      const toCost = COSTS[po.to_plan] || 0;
      const diff = toCost - fromCost;
      const diffStr = diff > 0 ? `+$${diff}` : `-$${Math.abs(diff)}`;
      document.getElementById('plan-order-cost').textContent = `$${fromCost}/${t('month_short')} → $${toCost}/${t('month_short')} (${diffStr})`;
    } else if (completed && Date.now() - completed.completedAt < 3600000) {
      // Order completed within the last hour — success notice
      const HIERARCHY = ['Pro', 'Max 5x', 'Max 20x'];
      const isUp = HIERARCHY.indexOf(completed.to_plan) > HIERARCHY.indexOf(completed.from_plan);
      let dDesc = t('plan_downgrade_desc');
      if (!isUp && _currentSnapshot?.subscription?.renewal_date) {
        const rd = new Date(_currentSnapshot.subscription.renewal_date);
        dDesc = t('plan_downgrade_desc_date', `${rd.getMonth() + 1}/${rd.getDate()}`);
      }
      const el = document.getElementById('plan-order-completed');
      el.classList.remove('hidden');
      el.style.background = '#f0fdf4';
      el.style.borderColor = '#bbf7d0';
      document.getElementById('plan-order-completed-body').innerHTML =
        `<div style="font-size:13px;font-weight:600;color:#166534;margin-bottom:4px">✅ ${completed.to_plan}${isUp ? t('plan_changed_now') : t('plan_changed_scheduled')}</div>` +
        `<div style="font-size:11px;color:#374151;margin-bottom:6px">${isUp ? t('plan_upgrade_desc') : dDesc}</div>` +
        `<a href="https://claude.ai/settings/billing" target="_blank" style="font-size:11px;color:#7c3aed;text-decoration:none;font-weight:500">${t('plan_check_settings')} →</a>`;
    }
  });

  // Plan change order accept/reject buttons
  document.getElementById('plan-order-accept').addEventListener('click', () => {
    const btn = document.getElementById('plan-order-accept');
    btn.disabled = true;
    btn.textContent = t('changing') || '변경 중...';
    // Save order info (referenced after response)
    const _po = (() => { try { return JSON.parse(document.getElementById('plan-order-banner').dataset.po || '{}'); } catch { return {}; } })();
    chrome.runtime.sendMessage({ type: 'RESPOND_PLAN_ORDER', action: 'accept' }, (res) => {
      if (res?.success) {
        const HIERARCHY = ['Pro', 'Max 5x', 'Max 20x'];
        const isUpgrade = HIERARCHY.indexOf(_po.to_plan) > HIERARCHY.indexOf(_po.from_plan);
        const banner = document.getElementById('plan-order-banner');
        // Switch banner to success notice
        banner.style.background = '#f0fdf4';
        banner.style.borderColor = '#bbf7d0';
        const body = document.getElementById('plan-order-body');
        let downgradeDesc = t('plan_downgrade_desc');
        if (!isUpgrade && _currentSnapshot?.subscription?.renewal_date) {
          const rd = new Date(_currentSnapshot.subscription.renewal_date);
          downgradeDesc = t('plan_downgrade_desc_date', `${rd.getMonth() + 1}/${rd.getDate()}`);
        }
        body.innerHTML = `<div style="font-size:13px;font-weight:600;color:#166534;margin-bottom:4px">✅ ${_po.to_plan || ''}${isUpgrade ? t('plan_changed_now') : t('plan_changed_scheduled')}</div>` +
          `<div style="font-size:11px;color:#374151;margin-bottom:6px">${isUpgrade ? t('plan_upgrade_desc') : downgradeDesc}</div>` +
          `<a href="https://claude.ai/settings/billing" target="_blank" style="font-size:11px;color:#7c3aed;text-decoration:none;font-weight:500">${t('plan_check_settings')} →</a>`;
        // Hide buttons
        document.getElementById('plan-order-accept').style.display = 'none';
        document.getElementById('plan-order-reject').style.display = 'none';
        const reasonEl = document.getElementById('plan-order-reason');
        if (reasonEl) reasonEl.style.display = 'none';
        const costEl = document.getElementById('plan-order-cost');
        if (costEl) costEl.style.display = 'none';
        // Close banner after 10 seconds
        setTimeout(() => banner.classList.add('hidden'), 10000);
      } else {
        btn.disabled = false;
        btn.textContent = t('plan_order_accept');
        showError(res?.error || t('collect_fail'));
      }
    });
  });
  document.getElementById('plan-order-reject').addEventListener('click', () => {
    document.getElementById('plan-order-banner').classList.add('hidden');
    chrome.runtime.sendMessage({ type: 'RESPOND_PLAN_ORDER', action: 'reject' });
  });

  // Cancel downgrade button
  document.getElementById('cancel-downgrade-btn').addEventListener('click', () => {
    const btn = document.getElementById('cancel-downgrade-btn');
    btn.disabled = true;
    btn.textContent = t('cancelling');

    chrome.runtime.sendMessage({ type: 'CANCEL_DOWNGRADE' }, (res) => {
      if (chrome.runtime.lastError) {
        btn.disabled = false;
        btn.textContent = t('cancel_downgrade');
        showError(t('cancel_fail') + ': ' + chrome.runtime.lastError.message);
        return;
      }
      btn.disabled = false;
      if (res?.success) {
        btn.classList.add('hidden');
        document.getElementById('pending-row').classList.add('hidden');
        showSuccess(t('downgrade_cancelled'));
        chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' });
      } else {
        btn.textContent = t('cancel_downgrade');
        showError(res?.error || t('collect_fail'));
      }
    });
  });

  // Downgrade test button
  function setupDowngradeBtn(btnId, targetPlan) {
    document.getElementById(btnId).addEventListener('click', () => {
      const btn = document.getElementById(btnId);
      const statusEl = document.getElementById('plan-action-status');
      btn.disabled = true;
      statusEl.textContent = t('changing');
      statusEl.style.color = '#9a3412';

      chrome.runtime.sendMessage({ type: 'DOWNGRADE_TO', targetPlan }, (res) => {
        btn.disabled = false;
        if (chrome.runtime.lastError) {
          statusEl.textContent = t('cancel_fail');
          statusEl.style.color = '#dc2626';
          return;
        }
        if (res?.success) {
          statusEl.textContent = `${res.from} → ${res.to}`;
          statusEl.style.color = '#059669';
          setTimeout(() => {
            chrome.runtime.sendMessage({ type: 'GET_STATUS' }, updateUI);
          }, 2000);
        } else {
          statusEl.textContent = res?.error || t('collect_fail');
          statusEl.style.color = '#dc2626';
        }
      });
    });
  }
  setupDowngradeBtn('downgrade-5x-btn', 'max_5x_monthly');
  setupDowngradeBtn('downgrade-pro-btn', 'pro_monthly');

  // Review nudge check
  checkReviewNudge();
});

// === Review Nudge (server-based) ===
function checkReviewNudge() {
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

    // Don't show review nudge when utilization >= 80%
    if (_currentSnapshot) {
      const maxUtil = Math.max(
        _currentSnapshot.five_hour?.utilization ?? 0,
        _currentSnapshot.seven_day?.utilization ?? 0
      );
      if (maxUtil >= 80) return;
    }

    const el = document.getElementById('review-nudge');
    el.style.display = 'flex';
    document.getElementById('review-nudge-text').textContent = t('review_nudge_text');
    document.getElementById('review-nudge-link').textContent = t('review_nudge_cta');
    sendGAEvent('review_nudge_shown', { source: 'popup' });

    document.getElementById('review-nudge-link').addEventListener('click', () => {
      sendReviewNudgeAction('clicked');
      sendGAEvent('review_nudge_clicked', { source: 'popup' });
    });
    document.getElementById('review-nudge-close').addEventListener('click', () => {
      el.style.display = 'none';
      sendReviewNudgeAction('dismissed');
      sendGAEvent('review_nudge_dismissed', { source: 'popup' });
    });
  });
}

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

// === Recommendation Feedback Toast ===
function showRecFeedback(recType) {
  if (!recType) return;
  chrome.storage.local.get({ ['ct_rec_fb_' + recType]: false }, (r) => {
    if (r['ct_rec_fb_' + recType]) return;
    const toast = document.getElementById('rec-feedback-toast');
    const actions = document.getElementById('rft-actions');
    const question = document.getElementById('rft-question');
    const share = document.getElementById('rft-share');
    toast.style.display = 'block';
    toast.style.position = 'relative';
    actions.style.display = 'flex';
    question.style.display = 'block';
    share.style.display = 'none';
    document.getElementById('rft-close').onclick = () => {
      toast.style.display = 'none';
      sendGAEvent('rec_toast_close');
    };
    question.textContent = t('rec_fb_question');
    document.getElementById('rft-yes').textContent = '👍 ' + t('rec_fb_yes');
    document.getElementById('rft-no').textContent = t('rec_fb_no');

    const autoHide = setTimeout(() => { toast.style.display = 'none'; }, 10000);

    document.getElementById('rft-yes').onclick = () => {
      clearTimeout(autoHide);
      sendGAEvent('rec_feedback_yes');
      chrome.storage.local.set({ ['ct_rec_fb_' + recType]: true });
      actions.style.display = 'none';
      question.style.display = 'none';
      share.style.display = 'block';
      document.getElementById('rft-share-text').textContent = t('rec_fb_share');
      document.getElementById('rft-review').textContent = t('rec_fb_review');
      document.getElementById('rft-review').onclick = () => { sendGAEvent('rec_share_review'); };
      document.getElementById('rft-twitter').href = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent('ClaudeTuner helped me optimize my Claude AI plan! Try it free: https://claudetuner.com #Claude #ClaudeTuner');
      document.getElementById('rft-copy').textContent = t('rec_fb_copy');
      document.getElementById('rft-copy').onclick = () => {
        navigator.clipboard.writeText('https://claudetuner.com');
        document.getElementById('rft-copy').textContent = 'Copied!';
      };
      setTimeout(() => { toast.style.display = 'none'; }, 15000);
    };

    document.getElementById('rft-no').onclick = () => {
      clearTimeout(autoHide);
      sendGAEvent('rec_feedback_no');
      chrome.storage.local.set({ ['ct_rec_fb_' + recType]: true });
      toast.style.display = 'none';
    };
  });
}

// === Recommendation rendering helper (shared by updateUI + selectOrg) ===
function _renderRecommendation(rec) {
  if (!rec) return;
  const recEl = document.getElementById('recommendation');
  if (!recEl) return;

  const isActionable = (rec.type === 'upgrade' || rec.type === 'downgrade') && rec.to_plan;
  if (isActionable) {
    const isUpgrade = rec.type === 'upgrade';
    const titleText = t(isUpgrade ? 'opt_upgrade' : 'opt_downgrade');
    recEl.textContent = titleText;
    recEl.style.color = isUpgrade
      ? (rec.urgency === 'urgent' ? '#dc2626' : '#d97706')
      : '#059669';

    const detail = document.getElementById('smart-rec-detail');
    if (detail) detail.classList.remove('hidden');

    const reasonEl = document.getElementById('smart-rec-reason');
    if (reasonEl) {
      if (rec.reason_key && rec.reason_args) {
        reasonEl.textContent = t(rec.reason_key, ...(rec.reason_args || []));
      } else if (rec.text_key) {
        const translated = t(rec.text_key);
        reasonEl.textContent = translated !== rec.text_key ? translated : (rec.text || '');
      } else {
        reasonEl.textContent = rec.text || '';
      }
    }

    const costEl = document.getElementById('smart-rec-cost');
    if (costEl) {
      if (rec.from_cost != null && rec.to_cost != null) {
        costEl.textContent = isUpgrade
          ? t('opt_cost_up', rec.from_cost, rec.to_cost, rec.cost_diff)
          : t('opt_cost_down', rec.from_cost, rec.to_cost, rec.cost_diff);
      } else {
        costEl.textContent = '';
      }
    }

    const btn = document.getElementById('smart-rec-btn');
    if (btn) {
      btn.classList.remove('hidden');
      btn.textContent = t(isUpgrade ? 'opt_upgrade_btn' : 'opt_downgrade_btn', rec.to_plan);
      btn.style.background = isUpgrade ? '#d97706' : '#059669';
    }

    const dismissBtn = document.getElementById('smart-rec-dismiss');
    if (dismissBtn) { dismissBtn.classList.remove('hidden'); dismissBtn.textContent = t('opt_dismiss'); }
    const muteBtn = document.getElementById('smart-rec-mute');
    if (muteBtn) { muteBtn.classList.remove('hidden'); muteBtn.textContent = t('rec_mute'); }
  } else {
    let displayText = rec.text || '';
    if (rec.text_key) {
      const translated = t(rec.text_key);
      if (translated !== rec.text_key) displayText = translated;
    }
    if (rec.data_days != null && rec.min_days != null && rec.data_days < rec.min_days) {
      displayText = t('opt_data_collecting', rec.data_days, rec.min_days);
    }
    recEl.textContent = displayText;

    const recType = rec.rec_type || rec.type;
    const typeColors = { upgrade: '#d97706', downgrade: '#059669', high: '#ef4444', adequate: '#854d0e', good: '#166534', collecting: '#6b7280', nodata: '#6b7280' };
    recEl.style.color = typeColors[recType] || '#166534';
    const detail = document.getElementById('smart-rec-detail');
    if (detail) detail.classList.add('hidden');
  }
}

// === UI Update ===
function updateUI(status) {
  // Always show version
  const userInfoEl = document.getElementById('user-info');
  if (userInfoEl && !userInfoEl.textContent.includes('v')) {
    userInfoEl.textContent = 'v' + chrome.runtime.getManifest().version;
  }
  const indicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const errorBanner = document.getElementById('error-banner');
  const errorMsg = document.getElementById('error-msg');

  // Hide error banner by default
  errorBanner.classList.add('hidden');

  const onboarding = document.getElementById('onboarding');

  if (!status) {
    indicator.className = 'status-dot gray';
    statusText.textContent = t('no_data');
    if (onboarding) onboarding.classList.remove('hidden');
    return;
  }

  if (status.error) {
    indicator.className = 'status-dot red';
    statusText.textContent = t('collect_fail');
    // Translate i18n key: "err_auth_failed:401" -> t('err_auth_failed', '401')
    const errKey = status.error;
    const colonIdx = errKey.indexOf(':');
    const translated = colonIdx > 0 && errKey.startsWith('err_')
      ? t(errKey.slice(0, colonIdx), errKey.slice(colonIdx + 1))
      : t(errKey);
    errorMsg.textContent = translated;
    errorBanner.classList.remove('hidden');
    // Hide "Open Claude.ai" hint for Rate Limit/retry errors (not a login issue)
    const errorHint = errorBanner.querySelector('.error-hint');
    const hideHint = errKey === 'err_rate_limit' || errKey.includes('Rate Limit');
    if (errorHint) {
      errorHint.style.display = hideHint ? 'none' : '';
    }
    // Display timing info
    const timingEl = document.getElementById('error-timing');
    if (timingEl) {
      const lines = [];
      if (status.lastSuccessTimestamp) {
        lines.push(t('err_last_success') + ': ' + formatTimeAgo(status.lastSuccessTimestamp));
      }
      lines.push(t('err_last_attempt') + ': ' + formatTimeAgo(status.timestamp));
      chrome.alarms.get('claude-usage-poll', (alarm) => {
        if (alarm) {
          const remainMs = alarm.scheduledTime - Date.now();
          if (remainMs > 60000) {
            const mins = Math.ceil(remainMs / 60000);
            lines.push(t('err_next_attempt') + ': ' + mins + t('in_min'));
          } else {
            lines.push(t('err_next_attempt') + ': ' + t('ago_just_now'));
          }
        }
        timingEl.innerHTML = lines.join('<br>');
      });
    }
    // Keep onboarding visible on error (first collection attempt failure case)
    return;
  }

  // Collection success: reset timing area, hide onboarding
  const timingEl = document.getElementById('error-timing');
  if (timingEl) timingEl.innerHTML = '';
  if (onboarding) onboarding.classList.add('hidden');

  if (status.success && status.snapshot) {
    indicator.className = 'status-dot green';
    const modeLabel = status.fetchMode === 'cookie' ? ` (${t('cookie_mode')})` : '';
    statusText.textContent = `✓ ${formatTimeAgo(status.timestamp)}${modeLabel}`;
    // Show next collection schedule + boost status
    chrome.alarms.get('claude-usage-poll', (alarm) => {
      if (alarm && alarm.scheduledTime) {
        const mins = Math.max(1, Math.round((alarm.scheduledTime - Date.now()) / 60000));
        chrome.alarms.get('claude-usage-boost', (boost) => {
          const boostIcon = boost ? ' ⚡' : '';
          statusText.textContent += ` / ⏳ ${mins}${t('min_later_check')}${boostIcon}`;
        });
      }
    });

    const s = status.snapshot;

    // Always refresh latest primary snapshot/recommendation cache
    _currentPlan = s.plan || null;
    _currentSnapshot = s;
    if (status.recommendation) _lastRecommendation = status.recommendation;

    // If non-primary org is selected, only update status indicator; delegate rest to selectOrg
    if (_selectedOrgId) {
      const selOrg = _collectedOrgs.find(o => o.uuid === _selectedOrgId);
      if (selOrg && !selOrg.isPrimary) {
        // Re-apply selected org view after refreshing org chips
        chrome.storage.local.get({ collectedOrgs: [] }, (local) => {
          _collectedOrgs = local.collectedOrgs || [];
          if (_collectedOrgs.length >= 2) showMultiOrgBadges(_collectedOrgs);
          selectOrg(_selectedOrgId, null);
        });
        return;
      }
      // If primary is selected, fall through below (normal updateUI execution)
    }

    const isEnterprise = (s.plan || '').includes('Enterprise');



    // === Gauge bars ===
    const gaugeSection = document.getElementById('gauge-section');
    gaugeSection.classList.remove('hidden');

    let util5h = null, util7d = null;

    if (isEnterprise && s.five_hour?.utilization == null && s.seven_day?.utilization == null) {
      // Usage-based Enterprise: show spending cap gauge
      const eu = s.extra_usage;
      if (eu && eu.monthly_limit) {
        const usedDollars = Math.round((eu.used_credits || 0) / 100);
        const limitDollars = Math.round(eu.monthly_limit / 100);
        const spendPct = Math.min(Math.round((eu.used_credits || 0) / eu.monthly_limit * 100), 100);
        const spendColor = gaugeColor(spendPct);
        gaugeSection.innerHTML =
          '<div class="gauge-row"><div class="gauge-header">' +
          '<span class="gauge-label">Enterprise Spending</span>' +
          '<span class="gauge-value" style="color:' + spendColor + '">' + spendPct + '%</span></div>' +
          '<div class="gauge-bar"><div class="gauge-fill" style="width:' + Math.min(spendPct, 100) + '%;background:' + spendColor + '"></div></div>' +
          '<div class="gauge-sub" style="color:#6b7280;font-size:10px">$' + usedDollars + ' / $' + limitDollars + '</div></div>';
      } else {
        gaugeSection.innerHTML = '<div style="text-align:center;padding:6px 0">'
          + '<div style="font-size:13px;font-weight:600;color:#4f46e5">Enterprise</div>'
          + '<div style="font-size:11px;color:#6b7280;margin-top:2px">' + t('enterprise_unlimited') + '</div>'
          + '</div>';
      }
    } else if (isEnterprise) {
      // Seat-based Enterprise: show 5h/7d gauge (same handling as else below)
      util5h = s.five_hour?.utilization ?? null;
      util7d = s.seven_day?.utilization ?? null;
      _restoreGaugeHTML(gaugeSection);
      if (util5h !== null) {
        document.getElementById('gauge-5h-value').textContent = `${Math.round(util5h)}%`;
        document.getElementById('gauge-5h-fill').style.width = `${Math.min(util5h, 100)}%`;
        document.getElementById('gauge-5h-fill').style.background = gaugeColor(util5h);
        document.getElementById('gauge-5h-value').style.color = gaugeColor(util5h);
      }
      if (s.five_hour?.resets_at) {
        document.getElementById('gauge-5h-reset').innerHTML = `<div>\u23f1 ${formatCountdown(s.five_hour.resets_at)}</div><div style="font-size:11px;color:#6b7280;font-weight:600;margin-top:1px">\u21bb ${formatResetAbsolute(s.five_hour.resets_at)}</div>`;
      }
      renderGaugePrediction('5h', _filteredHistory(), 'h5', util5h, s.five_hour?.resets_at);
      if (util7d !== null) {
        document.getElementById('gauge-7d-value').textContent = `${Math.round(util7d)}%`;
        document.getElementById('gauge-7d-fill').style.width = `${Math.min(util7d, 100)}%`;
        document.getElementById('gauge-7d-fill').style.background = gaugeColor(util7d);
        document.getElementById('gauge-7d-value').style.color = gaugeColor(util7d);
        if (s.seven_day?.resets_at) {
          document.getElementById('gauge-7d-reset').innerHTML = `<div>\u23f1 ${formatCountdown(s.seven_day.resets_at)}</div><div style="font-size:11px;color:#6b7280;font-weight:600;margin-top:1px">\u21bb ${formatResetAbsolute(s.seven_day.resets_at)}</div>`;
        }
        renderGaugePrediction('7d', _filteredHistory(), 'd7', util7d, s.seven_day?.resets_at);
      }
    } else {
      // Restore gauge DOM that may have been destroyed by org switching
      _restoreGaugeHTML(gaugeSection);
      // 5h gauge
      util5h = s.five_hour?.utilization ?? null;
      if (util5h !== null) {
        document.getElementById('gauge-5h-value').textContent = `${Math.round(util5h)}%`;
        document.getElementById('gauge-5h-fill').style.width = `${Math.min(util5h, 100)}%`;
        document.getElementById('gauge-5h-fill').style.background = gaugeColor(util5h);
        document.getElementById('gauge-5h-value').style.color = gaugeColor(util5h);
      }
      if (s.five_hour?.resets_at) {
        document.getElementById('gauge-5h-reset').innerHTML = `<div>\u23f1 ${formatCountdown(s.five_hour.resets_at)}</div><div style="font-size:11px;color:#6b7280;font-weight:600;margin-top:1px">\u21bb ${formatResetAbsolute(s.five_hour.resets_at)}</div>`;
      }
      renderGaugePrediction('5h', _filteredHistory(), 'h5', util5h, s.five_hour?.resets_at);

      // 7d gauge
      util7d = s.seven_day?.utilization ?? null;
      if (util7d !== null) {
        document.getElementById('gauge-7d-value').textContent = `${Math.round(util7d)}%`;
        document.getElementById('gauge-7d-fill').style.width = `${Math.min(util7d, 100)}%`;
        document.getElementById('gauge-7d-fill').style.background = gaugeColor(util7d);
        document.getElementById('gauge-7d-value').style.color = gaugeColor(util7d);
        if (s.seven_day?.resets_at) {
          document.getElementById('gauge-7d-reset').innerHTML = `<div>\u23f1 ${formatCountdown(s.seven_day.resets_at)}</div><div style="font-size:11px;color:#6b7280;font-weight:600;margin-top:1px">\u21bb ${formatResetAbsolute(s.seven_day.resets_at)}</div>`;
        }
        renderGaugePrediction('7d', _filteredHistory(), 'd7', util7d, s.seven_day?.resets_at);
      } else {
        // Plan without 7d data (Free, Team, etc.)
        document.getElementById('gauge-7d-value').textContent = 'N/A';
        document.getElementById('gauge-7d-value').style.color = '#9ca3af';
        document.getElementById('gauge-7d-fill').style.width = '0';
        const plan = (s.plan || '').toLowerCase();
        document.getElementById('gauge-7d-reset').textContent = plan.includes('free') ? t('free_no_7d') : t('team_no_7d');
      }
    }

    // === Extra usage (collapsible) ===
    const extraSection = document.getElementById('extra-usage-section');
    const extraTooltip = document.getElementById('extra-usage-tooltip');
    const extraSummary = document.getElementById('extra-usage-summary');
    const extraPanel = document.getElementById('extra-usage-detail-panel');
    const extraToggle = document.getElementById('extra-usage-toggle');
    // Click event delegation (bound once) — ? click shows help, others toggle gauge
    if (extraSummary && !extraSummary._bound) {
      extraSummary._bound = true;
      extraSummary.addEventListener('click', (e) => {
        if (e.target.id === 'extra-usage-help') {
          e.stopPropagation();
          const visible = extraTooltip.style.display !== 'none';
          extraTooltip.style.display = visible ? 'none' : 'block';
          if (!visible) {
            extraTooltip.innerHTML = _currentLang === 'ko'
              ? '기본 요금제(Max 20x 등)에 포함된 사용량을 다 쓰면, 충전한 크레딧에서 종량제로 차감됩니다. 추가 과금이 될 수 있으니, 필요하지 않은 경우 추가 사용량 기능을 꺼두세요.<br><a href="https://claude.ai/settings/usage" target="_blank" style="color:#7c3aed">Claude.ai에서 설정 →</a>'
              : 'When you use up your plan\'s included usage (e.g. Max 20x), extra credits are charged pay-as-you-go. Turn off extra usage if you don\'t need it to avoid unexpected charges.<br><a href="https://claude.ai/settings/usage" target="_blank" style="color:#7c3aed">Manage in Claude.ai →</a>';
          }
          return;
        }
        const open = extraPanel.style.display !== 'none';
        extraPanel.style.display = open ? 'none' : 'block';
        extraToggle.style.transform = open ? '' : 'rotate(90deg)';
      });
    }
    if (s.extra_usage && s.extra_usage.is_enabled && (s.extra_usage.used_credits || 0) > 0) {
      extraSection.style.display = '';
      const usedCents = s.extra_usage.used_credits || 0;
      const limitCents = s.extra_usage.monthly_limit || 1;
      const util = Math.round((usedCents / limitCents) * 100);
      const used = (usedCents / 100).toFixed(2);
      const limit = (limitCents / 100).toFixed(0);
      const color = util >= 90 ? '#ef4444' : util >= 70 ? '#f59e0b' : '#22c55e';
      // One-line summary
      const summaryText = document.getElementById('extra-usage-summary-text');
      summaryText.innerHTML = `${t('extra_usage_label')} <span id="extra-usage-help" style="cursor:pointer;color:#9ca3af;font-size:10px">(?)</span> <b style="color:${color}">$${used}/$${limit} (${util}%)</b>`;
      // Gauge detail
      document.getElementById('extra-usage-fill').style.width = `${Math.min(util, 100)}%`;
      document.getElementById('extra-usage-fill').style.background = color;
      const now = new Date();
      const nextMonth1st = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const dayNames = _currentLang === 'ko' ? ['일','월','화','수','목','금','토'] : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      document.getElementById('extra-usage-detail').textContent = `$${used} / $${limit} · ${nextMonth1st.getMonth() + 1}/1(${dayNames[nextMonth1st.getDay()]}) ${_currentLang === 'ko' ? '리셋' : 'reset'}`;
      // Auto-expand if usage is increasing
      chrome.storage.local.get({ ct_prev_extra_used: 0 }, (prev) => {
        const increasing = usedCents > (prev.ct_prev_extra_used || 0);
        if (increasing && extraPanel.style.display === 'none') {
          extraPanel.style.display = 'block';
          extraToggle.style.transform = 'rotate(90deg)';
        }
        chrome.storage.local.set({ ct_prev_extra_used: usedCents });
      });
    } else {
      extraSection.style.display = 'none';
    }

    // === Plan & subscription info ===
    const infoSection = document.getElementById('info-section');
    infoSection.classList.remove('hidden');
    document.getElementById('plan').textContent = s.plan || 'unknown';

    // Display Privacy (grove_enabled)
    const privacyRow = document.getElementById('privacy-row');
    const privacyVal = document.getElementById('privacy-value');
    if (s.grove_enabled === true) {
      privacyRow.classList.remove('hidden');
      privacyVal.textContent = t('privacy_on');
      privacyVal.href = '#';
      privacyVal.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: 'https://claude.ai/settings/data-privacy-controls' }); };
      privacyVal.title = t('privacy_link_title');
    } else {
      privacyRow.classList.add('hidden');
    }

    if (s.subscription?.renewal_date) {
      const renewalGroup = document.getElementById('renewal-group');
      const renewalEl = document.getElementById('renewal-date');
      renewalGroup.style.display = 'flex';
      const d = new Date(s.subscription.renewal_date);
      const daysLeft = Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      renewalEl.textContent = `${d.getMonth() + 1}/${d.getDate()} (${daysLeft}${t('renewal_days_later')})`;
      if (daysLeft <= 3) renewalEl.style.color = '#ef4444';
      else if (daysLeft <= 7) renewalEl.style.color = '#eab308';
    }

    if (s.subscription?.pending_plan) {
      const pendingRow = document.getElementById('pending-row');
      const pendingEl = document.getElementById('pending-plan');
      pendingRow.classList.remove('hidden');
      const planLabels = { pro_monthly: 'Pro', max_5x_monthly: 'Max 5x', max_20x_monthly: 'Max 20x', cancel: t('pending_cancel') };
      pendingEl.textContent = planLabels[s.subscription.pending_plan] || s.subscription.pending_plan;
      if (s.subscription.pending_plan !== 'cancel') {
        document.getElementById('cancel-downgrade-btn').classList.remove('hidden');
      }
    }

    // Server recommendation (unified recommendation system)
    if (status.recommendation) {
      _lastRecommendation = status.recommendation;
      const recRow = document.getElementById('recommendation-row');
      if (recRow) recRow.classList.remove('hidden');
      _renderRecommendation(status.recommendation);
    }

    // === "Is it OK to use now?" status (excluding Enterprise) ===
    if (!isEnterprise) {
      renderStatusBanner(util5h, util7d, _filteredHistory(), s.five_hour?.resets_at, s.seven_day?.resets_at);
    }

    // Peak hours banner
    renderPeakBanner();

    // User info + version (last collection time removed to save footer space)
    const parts = [];
    if (s.user_email !== 'unknown') parts.push(s.user_email);
    parts.push('v' + chrome.runtime.getManifest().version);
    document.getElementById('user-info').textContent = parts.join(' | ');
  }
}

// === Gauge prediction markers ===
// === Common prediction function: projected utilization at reset ===
// Used by both gauge prediction and banner evaluation
function calcPredictedAtReset(history, key, currentUtil, resetsAt) {
  if (!resetsAt || currentUtil === null || !history || history.length < 3) return null;

  const now = Date.now();
  const resetTime = new Date(resetsAt).getTime();
  const hoursToReset = Math.max((resetTime - now) / 3600000, 0);
  if (hoursToReset < 0.05) return null;

  let rate, hoursDiff;

  if (key === 'd7') {
    // 7d: based on local history r7(resets_at) — same logic as dashboard
    // Sum only positive increments within the same resets_at window
    const sixHoursAgo = now - 6 * 3600000;
    const recent = history.filter(p => p.d7 != null && p.r7 && p.t > sixHoursAgo);
    if (recent.length >= 2) {
      let totalDelta = 0;
      for (let i = 1; i < recent.length; i++) {
        if (recent[i - 1].r7 === recent[i].r7) {
          totalDelta += Math.max(0, recent[i].d7 - recent[i - 1].d7);
        }
      }
      const timeDiffH = (recent[recent.length - 1].t - recent[0].t) / 3600000;
      if (timeDiffH > 0) {
        rate = totalDelta / timeDiffH;
        hoursDiff = timeDiffH;
      }
    }
    // Fallback when r7 data is insufficient: elapsed time based on resets_at window
    if (rate == null) {
      const windowH = 7 * 24;
      const elapsed = windowH - hoursToReset;
      if (elapsed < 1) return null;
      rate = currentUtil / elapsed;
      hoursDiff = elapsed;
    }
  } else {
    // 5h: rate based on local history
    const lookbacks = [2 * 3600000, 6 * 3600000, Infinity];
    let valid = [];
    for (const lb of lookbacks) {
      valid = history.filter((p) => p[key] !== null && (lb === Infinity || p.t > now - lb));
      if (valid.length >= 2) break;
    }
    if (valid.length < 2) return null;
    const first = valid[0];
    const last = valid[valid.length - 1];
    hoursDiff = (last.t - first.t) / 3600000;
    if (hoursDiff < 0.5) return null;
    rate = (last[key] - first[key]) / hoursDiff;
  }

  const predicted = currentUtil + (rate * hoursToReset);

  return { rate, predicted, hoursToReset, hoursDiff };
}

function renderGaugePrediction(id, history, key, currentUtil, resetsAt) {
  const marker = document.getElementById(`gauge-${id}-predict`);
  const label = document.getElementById(`gauge-${id}-predict-label`);
  const inlineEl = document.getElementById(`gauge-${id}-predict-inline`);
  const fillEl = document.getElementById(`gauge-${id}-predict-fill`);
  const hide = () => {
    if (marker) marker.style.display = 'none';
    if (label) label.style.display = 'none';
    if (inlineEl) inlineEl.style.display = 'none';
    if (fillEl) fillEl.style.display = 'none';
  };

  const showCollecting = () => {
    hide();
    if (inlineEl) {
      inlineEl.style.display = 'inline';
      inlineEl.style.color = '#9ca3af';
      inlineEl.textContent = '\u25b8\u23f3';
      inlineEl.title = t('predict_tip_collecting');
      inlineEl.style.cursor = 'help';
    }
  };

  // Fully hide if no reset time or utilization is null
  if (!resetsAt || currentUtil === null) { hide(); return; }

  // Insufficient history: show collecting indicator
  if (!history || history.length < 3) {
    showCollecting();
    return;
  }

  // Use common prediction function
  const pred = calcPredictedAtReset(history, key, currentUtil, resetsAt);
  if (!pred) {
    showCollecting();
    return;
  }

  const { rate, predicted, hoursToReset, hoursDiff } = pred;
  const clampedPos = Math.min(predicted, 100);
  console.log(`[GaugePred:${id}] rate=${rate.toFixed(3)}/h, hoursDiff=${hoursDiff.toFixed(2)}h, predicted=${predicted.toFixed(1)}%`);

  // Minimal change or decreasing trend: show "stable"
  if (rate <= 0 || predicted - currentUtil < 3) {
    hide();
    if (inlineEl) {
      inlineEl.style.display = 'inline';
      inlineEl.style.color = '#22c55e';
      inlineEl.style.background = '#22c55e18';
      inlineEl.textContent = '\u25b8 \u2014';
      inlineEl.title = t('predict_tip_stable');
      inlineEl.style.cursor = 'help';
    }
    return;
  }

  // Colors
  const color = predicted >= 80 ? '#ef4444' : predicted >= 50 ? '#f59e0b' : '#9ca3af';
  const predictText = predicted >= 100 ? '100%+' : `${Math.round(predicted)}%`;

  // Calculate estimated time to reach 100%
  let limitTimeStr = '';
  if (predicted >= 100 && rate > 0 && currentUtil < 100) {
    const hoursTo100 = (100 - currentUtil) / rate;
    const limitDate = new Date(Date.now() + hoursTo100 * 3600000);
    const mo = limitDate.getMonth() + 1, da = limitDate.getDate();
    const dayNames = _currentLang === 'ko' ? ['일','월','화','수','목','금','토'] : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dayStr = dayNames[limitDate.getDay()];
    const hh = limitDate.getHours();
    limitTimeStr = _currentLang === 'ko'
      ? `${mo}/${da}(${dayStr}) ${hh >= 12 ? '오후' : '오전'} ${hh % 12 || 12}시`
      : `${mo}/${da}(${dayStr}) ${hh % 12 || 12}${hh >= 12 ? 'PM' : 'AM'}`;
  }

  // (A) Header inline prediction: "▸ 78%" or "▸ 4/12 2PM" badge
  if (inlineEl) {
    inlineEl.style.display = 'inline';
    inlineEl.style.color = predicted >= 80 ? '#fff' : color;
    inlineEl.style.background = predicted >= 80 ? color : `${color}18`;
    inlineEl.textContent = `\u25b8 ${predictText}`;
    const obsTime = hoursDiff < 1 ? `${Math.round(hoursDiff * 60)}${t('min')}` : `${hoursDiff.toFixed(1)}${t('hours_short')}`;
    const resetTime2 = hoursToReset < 1 ? `${Math.round(hoursToReset * 60)}${t('min')}` : `${hoursToReset.toFixed(1)}${t('hours_short')}`;
    const tipLine3 = limitTimeStr ? t('predict_limit_at', limitTimeStr) : t('predict_tip_line3', predictText);
    inlineEl.title = t('predict_tip_line1', obsTime, rate.toFixed(1)) + '\n' + t('predict_tip_line2', resetTime2) + '\n→ ' + tipLine3;
    inlineEl.style.cursor = 'help';
  }

  // (B) Fill predicted range on gauge bar
  if (fillEl) {
    const barColor = id === '5h' ? '#06b6d4' : '#7c3aed';
    fillEl.style.display = 'block';
    fillEl.style.left = `${Math.min(currentUtil, 100)}%`;
    fillEl.style.width = `${Math.min(clampedPos - Math.min(currentUtil, 100), 100)}%`;
    fillEl.style.color = barColor;
  }

  // Marker + label (existing)
  if (marker) {
    marker.style.display = 'block';
    marker.style.left = `${clampedPos}%`;
    marker.style.background = color;
  }
  // Label (number) omitted to avoid text overlap — marker+bar+inline badge is sufficient
  if (label) {
    label.style.display = 'none';
  }
}

// === Status banner (6-tier pace) ===
function calcPaceTier(currentUtil, resetsAt, windowSeconds) {
  if (currentUtil == null || !resetsAt || !windowSeconds) return null;
  if (currentUtil === 0) return { id: 'comfortable', css: 'green' };
  const remaining = Math.max((new Date(resetsAt).getTime() - Date.now()) / 1000, 0);
  const elapsed = windowSeconds - remaining;
  const fraction = elapsed / windowSeconds;
  if (fraction < 0.10 || fraction >= 1.0) return null;
  const projected = (currentUtil / 100) / fraction;
  if (projected < 0.50) return { id: 'comfortable', css: 'green' };
  if (projected < 0.75) return { id: 'ontrack',     css: 'green' };
  if (projected < 0.90) return { id: 'warming',     css: 'yellow' };
  if (projected < 1.00) return { id: 'pressing',    css: 'orange' };
  if (projected < 1.20) return { id: 'critical',    css: 'red' };
  return                        { id: 'runaway',     css: 'darkred' };
}

function renderStatusBanner(util5h, util7d, history, resets5h, resets7d) {
  const banner = document.getElementById('status-banner');
  if (!banner) return;
  if (util5h === null && util7d === null) { banner.classList.add('hidden'); return; }

  const pace5h = calcPaceTier(util5h, resets5h, 5 * 3600);
  const pace7d = calcPaceTier(util7d, resets7d, 7 * 24 * 3600);

  const severity = { comfortable: 0, ontrack: 1, warming: 2, pressing: 3, critical: 4, runaway: 5 };
  let tier, worstWindow;
  if (pace5h && pace7d) {
    if (severity[pace5h.id] >= severity[pace7d.id]) {
      tier = pace5h; worstWindow = t('win_5h');
    } else {
      tier = pace7d; worstWindow = t('win_7d');
    }
  } else if (pace5h) {
    tier = pace5h; worstWindow = t('win_5h');
  } else if (pace7d) {
    tier = pace7d; worstWindow = t('win_7d');
  }

  let text;
  if (tier) {
    text = t('pace_' + tier.id, worstWindow);
  } else {
    const maxUtil = Math.max(util5h || 0, util7d || 0);
    if (maxUtil >= 95) {
      tier = { id: 'critical', css: 'red' };
      const which = (util5h || 0) >= 95 ? t('win_5h') : t('win_7d');
      text = t('pace_near_static', which);
    } else if (maxUtil >= 80) {
      tier = { id: 'warming', css: 'yellow' };
      text = t('pace_high_static', Math.round(maxUtil));
    } else {
      tier = { id: 'comfortable', css: 'green' };
      text = t('pace_comfortable');
    }
  }

  banner.className = 'status-banner sb-' + tier.css;
  banner.textContent = text;
  banner.classList.remove('hidden');
}

// === Peak hours banner (Anthropic official: weekdays 12:00-18:00 UTC, shown only during peak) ===
function renderPeakBanner() {
  const el = document.getElementById('offpeak-banner');
  if (!el) return;
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay(); // 0=Sun, 6=Sat
  const isWeekday = utcDay >= 1 && utcDay <= 5;
  const isPeak = isWeekday && utcHour >= 12 && utcHour < 18;

  if (!isPeak) {
    el.classList.add('hidden');
    return;
  }

  const remaining = 18 - utcHour;
  // Convert UTC 12:00-18:00 to user's local time
  const today = new Date();
  const peakStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12));
  const peakEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 18));
  const locale = getLang() === 'ko' ? 'ko-KR' : 'en-US';
  const fmt = (d) => d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', hour12: true });
  const localRange = `${fmt(peakStart)}–${fmt(peakEnd)}`;
  el.className = 'offpeak-banner is-peak';
  const detailText = t('promo_peak_detail', localRange);
  el.innerHTML = `<span class="op-icon">🔥</span><span class="op-text">${t('promo_peak')}<br><span class="op-sub">${t('promo_peak_sub', localRange)} · ${t('promo_peak_remaining', remaining)}</span></span><span class="op-help" title="${detailText}">?</span>`;
  el.classList.remove('hidden');

  // Toggle detail description on ? click
  const helpBtn = el.querySelector('.op-help');
  if (helpBtn) {
    helpBtn.onclick = (e) => {
      e.stopPropagation();
      let tooltip = el.querySelector('.op-tooltip');
      if (tooltip) {
        tooltip.remove();
      } else {
        tooltip = document.createElement('div');
        tooltip.className = 'op-tooltip';
        tooltip.textContent = detailText;
        el.appendChild(tooltip);
      }
    };
  }
}

// === Helper functions ===
// Restore gauge HTML when switching from Enterprise to regular plan
function _restoreGaugeHTML(gaugeSection) {
  // If gauge-5h-value is missing, innerHTML was replaced with Enterprise layout
  if (document.getElementById('gauge-5h-value')) return;
  gaugeSection.innerHTML =
    '<div class="gauge-row" id="gauge-row-5h"><div class="gauge-header">' +
    '<span class="gauge-label">' + t('usage_5h') + '</span>' +
    '<span class="gauge-value" id="gauge-5h-value" style="color:#06b6d4">-</span>' +
    '<span class="gauge-predict-inline" id="gauge-5h-predict-inline" style="display:none"></span></div>' +
    '<div class="gauge-bar"><div id="gauge-5h-fill" class="gauge-fill" style="width:0;background:#06b6d4"></div>' +
    '<div id="gauge-5h-predict-fill" class="gauge-predict-fill" style="display:none"></div>' +
    '<div id="gauge-5h-predict" class="gauge-predict" style="display:none"></div>' +
    '<span id="gauge-5h-predict-label" class="gauge-predict-label" style="display:none"></span></div>' +
    '<div class="gauge-sub" id="gauge-5h-reset"></div></div>' +
    '<div class="gauge-row" id="gauge-row-7d"><div class="gauge-header">' +
    '<span class="gauge-label">' + t('usage_7d') + '</span>' +
    '<span class="gauge-value" id="gauge-7d-value" style="color:#7c3aed">-</span>' +
    '<span class="gauge-predict-inline" id="gauge-7d-predict-inline" style="display:none"></span></div>' +
    '<div class="gauge-bar"><div id="gauge-7d-fill" class="gauge-fill" style="width:0;background:#7c3aed"></div>' +
    '<div id="gauge-7d-predict-fill" class="gauge-predict-fill" style="display:none"></div>' +
    '<div id="gauge-7d-predict" class="gauge-predict" style="display:none"></div>' +
    '<span id="gauge-7d-predict-label" class="gauge-predict-label" style="display:none"></span></div>' +
    '<div class="gauge-sub" id="gauge-7d-reset"></div></div>';
}

function gaugeColor(util) {
  if (util >= 80) return '#ef4444';
  if (util >= 50) return '#f59e0b';
  return '#06b6d4';
}

function formatCountdown(resetAt) {
  const diff = new Date(resetAt).getTime() - Date.now();
  if (diff <= 0) return t('countdown_soon');
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return t('countdown_dhm', days, remHours);
  }
  return t('countdown_hm', hours, mins);
}

// === Runner Animation ===
const _runnerStates = [
  { min: 0,  max: 5,  emoji: '😴', rest: true },
  { min: 5,  max: 15, emoji: '🧘', rest: true },
  { min: 15, max: 25, emoji: '😮‍💨', rest: true },
  { min: 25, max: 40, emoji: '🚶' },
  { min: 40, max: 60, emoji: '🏃' },
  { min: 60, max: 80, emoji: '🏃💨' },
  { min: 80, max: 90, emoji: '🏇💨💨' },
  { min: 90, max: 101, emoji: '🏍️💨💨💨' },
];
const _pausedEmojis = {
  high: ['🏃', '😤', '💪', '🔥'],
  mid: ['🚶', '🙂', '☕', '🎵'],
  low: ['😴', '💤', '🧘', '😌', '🍵'],
};

function _getRunnerState(speed) {
  return _runnerStates.find(s => speed >= s.min && speed < s.max) || _runnerStates[0];
}

function initRunner() {
  const track = document.getElementById('runner-track');
  const char = document.getElementById('runner-char');
  const pauseBtn = document.getElementById('runner-pause');
  if (!track || !char || !pauseBtn) return;

  let pos = 0, dir = 1, paused = false, pausedTimer = 0, speed = 0;

  // Speed calculation: 5h change rate based on usageHistory
  function calcSpeed() {
    const recent = (_filteredHistory() || []).filter(p => p.h5 != null).slice(-3);
    if (recent.length < 2) return 0;
    const first = recent[0], last = recent[recent.length - 1];
    const hoursDiff = (last.t - first.t) / 3600000;
    if (hoursDiff < 0.05) return 0;
    const rate = (last.h5 - first.h5) / hoursDiff; // %/hour
    // Map rate to 0-100 speed: 0%/h=0, 20%/h+=100
    const util5h = last.h5 || 0;
    if (rate <= 0) return Math.min(util5h * 0.3, 20); // Declining/stagnant: low speed
    return Math.min(rate * 5 + util5h * 0.3, 100);
  }

  // Load paused state
  chrome.storage.local.get({ runnerPaused: false }, (r) => {
    paused = r.runnerPaused;
    pauseBtn.textContent = paused ? '▶' : '⏸';
  });

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pausedTimer = 0;
    pauseBtn.textContent = paused ? '▶' : '⏸';
    chrome.storage.local.set({ runnerPaused: paused });
  });

  function animate() {
    speed = calcSpeed();
    const state = _getRunnerState(speed);
    const trackWidth = track.offsetWidth - 24;
    if (trackWidth <= 0) { requestAnimationFrame(animate); return; }

    if (paused) {
      char.textContent = state.emoji;
      char.style.left = '0px';
      char.style.top = '0px';
      char.style.transform = 'scaleX(1)';
      requestAnimationFrame(animate);
      return;
    }

    if (state.rest) {
      // Resting state: fixed at center + breathing animation
      char.textContent = state.emoji;
      char.style.left = (trackWidth / 2 - 8) + 'px';
      char.style.top = '0px';
      const breathe = 1 + Math.sin(Date.now() / 600) * 0.04;
      char.style.transform = `scale(${breathe})`;
    } else {
      // Moving state
      const moveSpeed = 0.3 + (speed / 100) * 2.5;
      pos += moveSpeed * dir;
      if (pos >= trackWidth) { pos = trackWidth; dir = -1; }
      else if (pos <= 0) { pos = 0; dir = 1; }

      char.textContent = state.emoji;
      char.style.left = pos + 'px';
      char.style.transform = dir === 1 ? 'scaleX(-1)' : 'scaleX(1)';

      // High speed: vertical bounce
      if (speed > 70) {
        char.style.top = (Math.sin(Date.now() / 80) * 2) + 'px';
      } else {
        char.style.top = '0px';
      }
    }

    requestAnimationFrame(animate);
  }

  // Show + start
  track.style.display = '';
  pauseBtn.style.display = '';
  animate();
}

function formatResetAbsolute(resetAt) {
  const d = new Date(resetAt);
  const lang = (typeof getLang === 'function' ? getLang() : 'ko');
  const dayNames = lang === 'ko'
    ? ['일','월','화','수','목','금','토']
    : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dayName = dayNames[d.getDay()];
  const month = d.getMonth() + 1;
  const date = d.getDate();
  const h = d.getHours();
  if (lang === 'ko') {
    const ampm = h < 12 ? '오전' : '오후';
    const h12 = h % 12 || 12;
    return `${month}/${date}(${dayName}) ${ampm} ${h12}시`;
  }
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 || 12;
  return `${month}/${date}(${dayName}) ${h12}${ampm}`;
}

function planToMultiplier(plan) {
  if (!plan) return 1;
  const p = plan.toLowerCase();
  if (p.includes('20')) return 20;
  if (p.includes('5x') || (p.includes('max') && p.includes('5'))) return 5;
  if (p.includes('max')) return 5; // "Max" alone defaults to 5x
  if (p.includes('team') && p.includes('premium')) return 6.25;
  if (p.includes('team')) return 1.25; // Team Standard
  if (p.includes('enterprise')) return 1; // Enterprise: usage-based, no multiplier
  return 1; // Pro, Free, unknown
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

function showError(msg) {
  document.getElementById('status-indicator').className = 'status-dot red';
  // Translate if i18n key, otherwise display as-is
  const translated = msg && msg.startsWith('err_') ? t(msg) : msg;
  document.getElementById('status-text').textContent = translated;
}

function showSuccess(msg) {
  document.getElementById('status-indicator').className = 'status-dot green';
  document.getElementById('status-text').textContent = msg;
}

// === Charts (5h / 7d split + prediction line) ===
function drawCharts(history, plan, snapshot) {
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
          placeholder.innerHTML = '<div style="text-align:center;padding:6px 0;color:#6b7280;font-size:11px">'
            + '<div style="font-size:12px;font-weight:600;color:#4f46e5;margin-bottom:2px">Enterprise Spending</div>'
            + '<div style="font-size:18px;font-weight:700;color:#1e1b4b">$' + usedDollars + ' <span style="font-size:11px;color:#9ca3af">/ $' + limitDollars + '</span></div>'
            + '<div style="margin-top:2px;color:' + gaugeColor(pct) + ';font-weight:600;font-size:11px">' + pct + '% ' + t('chart_used') + '</div>'
            + '</div>';
        } else {
          placeholder.style.display = '';
          placeholder.style.height = 'auto';
          placeholder.innerHTML = '<div style="text-align:center;padding:6px 0;color:#6b7280;font-size:11px">'
            + '<div style="font-size:12px;font-weight:600;color:#4f46e5">Enterprise</div>'
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
    ctx.fillStyle = 'rgba(0,0,0,.03)';
    ctx.fillRect(toX(nowX), pad.top, toX(1) - toX(nowX), ch);
  }

  // Grid — dynamic interval (matched to y-axis scale)
  ctx.strokeStyle = '#f0f0f0'; ctx.lineWidth = 0.5;
  const gridStep = maxY <= 15 ? 5 : maxY <= 30 ? 10 : maxY <= 60 ? 15 : 25;
  for (let gpct = gridStep; gpct < maxY; gpct += gridStep) {
    const gy = toY(gpct);
    ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(w - pad.right, gy); ctx.stroke();
    ctx.fillStyle = '#d1d5db'; ctx.font = '7px sans-serif'; ctx.textAlign = 'right';
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
    ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 0.5; ctx.setLineDash([3, 3]);
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

    const alphaColor = color === '#06b6d4' ? 'rgba(6,182,212,.08)' : 'rgba(124,58,237,.08)';

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
      ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
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
    ctx.beginPath(); ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 0.5; ctx.setLineDash([2, 2]);
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
    ctx.fillStyle = 'rgba(0,0,0,.03)';
    ctx.fillRect(toX(nowX), pad.top, toX(1) - toX(nowX), ch);
  }

  // Grid — dollar units
  ctx.strokeStyle = '#f0f0f0'; ctx.lineWidth = 0.5;
  const gridStep = maxY <= 20 ? 5 : maxY <= 50 ? 10 : maxY <= 100 ? 25 : maxY <= 250 ? 50 : maxY <= 600 ? 100 : 250;
  for (let gv = gridStep; gv < maxY; gv += gridStep) {
    const gy = toY(gv);
    ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(w - pad.right, gy); ctx.stroke();
    ctx.fillStyle = '#d1d5db'; ctx.font = '7px sans-serif'; ctx.textAlign = 'right';
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
      ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
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
    ctx.beginPath(); ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 0.5; ctx.setLineDash([2, 2]);
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

