// Org selector + multi-org badges for the popup. Top of the UI dependency graph: a full view
// switch, so it imports charts/prediction/recommend. Imports are one-way (no ui/* module imports
// this); i18n `t` + CT_CONFIG are globals from classic scripts.
import { escHtml, gaugeColor, formatCountdown, formatResetAbsolute } from './util.js';
import { drawCharts, _startChartAutoRoll, _stopChartAutoRoll, isChartAutoRoll, isChartRolling } from './charts.js';
import { state, _filteredHistory } from './state.js';
import { setPredictHeadline, renderGaugePrediction, renderStatusBanner, renderPeakBanner, _restoreGaugeHTML } from './prediction.js';
import { _shouldSuppressRec, _renderRecommendation } from './recommend.js';
import { _authedFetch } from './auth.js';

// Human-readable label for a provider org (e.g. "Gemini Advanced", "ChatGPT Plus")
export function _providerOrgLabel(org) {
  if (!org) return '';
  const PROVIDER_LABELS = { chatgpt: 'ChatGPT', gemini: 'Gemini' };
  return [PROVIDER_LABELS[org.provider] || '', org.plan || ''].filter(Boolean).join(' ').trim();
}

export function loadOrgSelector() {
  chrome.runtime.sendMessage({ type: 'GET_ORGANIZATIONS' }, (res) => {
    if (chrome.runtime.lastError || !res?.success) return;
    const orgs = res.orgs;
    state.orgList = orgs;

    const container = document.getElementById('org-selector');
    if (!container) return;

    // Multi-org: show collected org badges if collectedOrgs exists
    // (includes both Claude orgs and ChatGPT accounts)
    chrome.storage.local.get({ collectedOrgs: null }, (local) => {
      state.collectedOrgs = local.collectedOrgs || [];
      if (local.collectedOrgs && local.collectedOrgs.length > 0) {
        showMultiOrgBadges(local.collectedOrgs);
        return;
      }

      // Single Claude org with no collectedOrgs — no selector needed
      if (orgs.length < 2) return;

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

export function selectOrg(orgId, container) {
  if (container) {
    container.querySelectorAll('.org-option').forEach(el => {
      el.classList.toggle('selected', el.dataset.orgId === orgId);
    });
  }

  state.selectedOrgId = orgId;

  // Look up selected org data from collectedOrgs (+ lastStatus for recommendation restore)
  chrome.storage.local.get({ collectedOrgs: [], lastStatus: null }, (local) => {
    state.collectedOrgs = local.collectedOrgs || [];
    const orgData = state.collectedOrgs.find(o => o.uuid === orgId);
    if (!orgData) return;
    // Clear the prediction headline up front; the 5h-gauge branch below re-shows
    // it. Usage-based Enterprise / no-5h orgs never call renderGaugePrediction,
    // so without this a headline from a previous org would linger.
    setPredictHeadline(null);
    const hist = _filteredHistory();
    const isPrimary = orgData.isPrimary;
    const providerKey = orgData.provider || 'claude';
    const isClaudeOrg = providerKey === 'claude';
    const isEnterprise = /Enterprise/i.test(orgData.plan);
    const isUsageBased = isEnterprise && orgData.h5 == null && orgData.d7 == null;

    // resets_at: prefer collectedOrgs, fallback to primary
    const resetsAt5h = orgData.resetsAt5h || (isPrimary ? state.currentSnapshot?.five_hour?.resets_at : null);
    const resetsAt7d = orgData.resetsAt7d || (isPrimary ? state.currentSnapshot?.seven_day?.resets_at : null);

    // === 1. Display plan ===
    const planEl = document.getElementById('plan');
    // Qualify non-Claude plans with the provider name (e.g. "Gemini Advanced")
    // so the provider is identifiable even when no org chips are shown.
    if (planEl) planEl.textContent = _providerOrgLabel(orgData) || orgData.plan || '';

    // === 2. Update gauges ===
    const gaugeSection = document.getElementById('gauge-section');
    gaugeSection.classList.remove('hidden');
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
          '<div class="gauge-sub" style="color:var(--text-secondary);font-size:10px">$' + usedDollars + ' / $' + limitDollars + '</div></div>';
      } else {
        gaugeSection.innerHTML = '<div style="text-align:center;padding:6px 0">'
          + '<div style="font-size:13px;font-weight:600;color:var(--accent)">Enterprise</div>'
          + '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px">' + t('enterprise_unlimited') + '</div>'
          + '</div>';
      }
    } else {
      // 5h/7d gauge (common for Pro/Max/Team/Enterprise seat-based)
      if (isEnterprise || !isClaudeOrg || !isPrimary) {
        if (renewalGroup) renewalGroup.style.display = 'none';
      } else if (state.currentSnapshot?.subscription?.renewal_date && renewalGroup) {
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
        if (r5h) r5h.innerHTML = `<div>\u23f1 ${formatCountdown(resetsAt5h)}</div><div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-top:1px">\u21bb ${formatResetAbsolute(resetsAt5h)}</div>`;
      }
      if (resetsAt7d) {
        const r7d = document.getElementById('gauge-7d-reset');
        if (r7d) r7d.innerHTML = `<div>\u23f1 ${formatCountdown(resetsAt7d)}</div><div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-top:1px">\u21bb ${formatResetAbsolute(resetsAt7d)}</div>`;
      }
    }

    // === 3. Extra usage section (Claude Enterprise only) ===
    const extraSection = document.getElementById('extra-usage-section');
    if (extraSection) {
      const eu = isClaudeOrg ? orgData.extraUsage : null;
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
          const dayNames = getLang() === 'ko' ? ['일','월','화','수','목','금','토'] : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
          detailEl.textContent = `$${used} / $${limit} · ${nextMonth1st.getMonth() + 1}/1(${dayNames[nextMonth1st.getDay()]}) ${getLang() === 'ko' ? '리셋' : 'reset'}`;
        }
      } else {
        extraSection.style.display = 'none';
      }
    }

    // === 4. Subscription / Pending plan (Claude only) ===
    const pendingRow = document.getElementById('pending-row');
    const cancelDowngradeWrap = document.getElementById('cancel-downgrade-wrap');
    if (isClaudeOrg && isPrimary) {
      // primary: restore subscription from state.currentSnapshot
      if (state.currentSnapshot?.subscription?.pending_plan) {
        if (pendingRow) {
          pendingRow.classList.remove('hidden');
          const planLabels = { pro_monthly: 'Pro', max_5x_monthly: 'Max 5x', max_20x_monthly: 'Max 20x', cancel: t('pending_cancel') };
          const pendingEl = document.getElementById('pending-plan');
          if (pendingEl) pendingEl.textContent = planLabels[state.currentSnapshot.subscription.pending_plan] || state.currentSnapshot.subscription.pending_plan;
          if (cancelDowngradeWrap && state.currentSnapshot.subscription.pending_plan !== 'cancel') {
            // Check if user dismissed this specific pending plan
            chrome.storage.local.get({ hiddenDowngradePlan: null }, (s) => {
              if (s.hiddenDowngradePlan === state.currentSnapshot.subscription.pending_plan) {
                cancelDowngradeWrap.style.display = 'none';
              } else {
                cancelDowngradeWrap.style.display = 'flex';
              }
            });
          }
        }
      } else {
        if (pendingRow) pendingRow.classList.add('hidden');
        if (cancelDowngradeWrap) cancelDowngradeWrap.style.display = 'none';
      }
    } else {
      // non-primary: no subscription info available
      if (renewalGroup) renewalGroup.style.display = 'none';
      if (pendingRow) pendingRow.classList.add('hidden');
      if (cancelDowngradeWrap) cancelDowngradeWrap.style.display = 'none';
    }

    // === 5. Recommendation & 6. Privacy — Claude only (no logic for external providers yet) ===
    const recRow = document.getElementById('recommendation-row');
    const recDetail = document.getElementById('smart-rec-detail');
    if (isClaudeOrg) {
      // Restore recommendation from cache or from lastStatus
      const rec = state.lastRecommendation || local.lastStatus?.recommendation;
      if (rec && !_shouldSuppressRec(rec, state.currentSnapshot?.subscription?.pending_plan)) {
        state.lastRecommendation = rec;
        if (recRow) recRow.classList.remove('hidden');
        _renderRecommendation(rec);
      } else {
        if (recRow) recRow.classList.add('hidden');
        if (recDetail) recDetail.classList.add('hidden');
      }
    } else {
      if (recRow) recRow.classList.add('hidden');
      if (recDetail) recDetail.classList.add('hidden');
    }

    const privacyRow = document.getElementById('privacy-row');
    if (isClaudeOrg && state.currentSnapshot?.grove_enabled === true) {
      chrome.storage.local.get({ hiddenPrivacyBanner: false }, (s) => {
        if (privacyRow) privacyRow.classList.toggle('hidden', !!s.hiddenPrivacyBanner);
      });
    } else {
      if (privacyRow) privacyRow.classList.add('hidden');
    }

    // === 7. Fitness matrix (Claude only — no plan comparison for external providers) ===
    const fitnessSection = document.getElementById('fitness-section');
    if (!isClaudeOrg || isEnterprise) {
      if (fitnessSection) fitnessSection.classList.add('hidden');
    } else {
      // Claude non-Enterprise: show if cached data exists (managed by loadFitnessMatrix)
      chrome.storage.local.get({ fitnessCache: null }, (fc) => {
        if (fc.fitnessCache?.data && fitnessSection) {
          fitnessSection.classList.remove('hidden');
        }
      });
    }

    // === 8. Update charts — clean snapshot ===
    const isChatGPT = (orgData.provider || 'claude') === 'chatgpt';
    const isGemini = (orgData.provider || 'claude') === 'gemini';
    const isExternalProvider = isChatGPT || isGemini;
    const orgPlan = orgData.plan || state.currentPlan;
    const orgSnapshot = {
      plan: orgPlan,
      five_hour: { utilization: orgData.h5, resets_at: resetsAt5h },
      seven_day: { utilization: orgData.d7, resets_at: resetsAt7d },
      extra_usage: orgData.extraUsage || (orgData.spendLimit ? { used_credits: orgData.spendUsed, monthly_limit: orgData.spendLimit } : null),
    };
    // Enterprise usage-based: no 5h/7d tab rolling needed, stop it. Restored on org switch
    if (isUsageBased) {
      _stopChartAutoRoll();
    } else if (isChartAutoRoll() && !isChartRolling()) {
      _startChartAutoRoll();
    }
    const chartSection = document.getElementById('chart-section');
    if (hist.length >= 2 || isUsageBased) {
      if (chartSection) chartSection.style.display = '';
      drawCharts(hist, orgPlan, orgSnapshot);
    } else {
      // Not enough data: hide chart to avoid showing stale data from another org
      if (chartSection) chartSection.style.display = 'none';
    }

    // === 9. Status banner ===
    if (isUsageBased) {
      // Enterprise usage-based: hide banner since no 5h/7d data
      const banner = document.getElementById('status-banner');
      if (banner) banner.classList.add('hidden');
    } else if (isExternalProvider && hist.length < 3) {
      // ChatGPT/Gemini with insufficient history: hide banner
      const banner = document.getElementById('status-banner');
      if (banner) banner.classList.add('hidden');
    } else if (hist.length >= 3) {
      renderStatusBanner(orgData.h5 ?? null, orgData.d7 ?? null, hist, resetsAt5h, resetsAt7d);
    }

    // Peak hours banner (Claude only — not applicable to ChatGPT/Gemini)
    if (!isExternalProvider) {
      renderPeakBanner();
    } else {
      const peakEl = document.getElementById('offpeak-banner');
      if (peakEl) peakEl.classList.add('hidden');
    }
  });

  if (container) {
    setTimeout(() => container.classList.add('hidden'), 300);
  }

  // Update org chip active state
  document.querySelectorAll('.org-chip').forEach(chip => {
    chip.classList.toggle('selected', chip.dataset?.orgId === orgId);
  });
}

export function showMultiOrgBadges(collectedOrgs) {
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

  // Hint row showing pin status
  const hintRow = document.createElement('div');
  hintRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 10px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text-secondary)';
  hintRow.textContent = t('org_pin_hint');
  wrapper.appendChild(hintRow);

  // Sort: Claude (Personal > Team > Enterprise) > ChatGPT > Gemini
  const planOrder = (org) => {
    const p = org.provider || 'claude';
    const base = p === 'gemini' ? 200 : p === 'chatgpt' ? 100 : 0;
    if (/Enterprise/i.test(org.plan)) return base + 3;
    if (/Team/i.test(org.plan)) return base + 2;
    return base + 1;
  };
  const sorted = [...collectedOrgs].sort((a, b) => planOrder(a) - planOrder(b));

  // Pin SVGs
  const pinSvgFilled = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5a.5.5 0 0 1-1 0V10h-4A.5.5 0 0 1 3 9.5c0-.973.64-1.725 1.17-2.189A6 6 0 0 1 5 6.708V2.277a3 3 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354"/></svg>';
  const pinSvgOutline = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5a.5.5 0 0 1-1 0V10h-4A.5.5 0 0 1 3 9.5c0-.973.64-1.725 1.17-2.189A6 6 0 0 1 5 6.708V2.277a3 3 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354m1.58 1.408l-.002-.001zm-.002-.001.002.001A.5.5 0 0 0 6 2v5a.5.5 0 0 1-.276.447h-.002l-.012.007-.054.03a5 5 0 0 0-.827.58c-.318.278-.585.596-.725.936h7.792c-.14-.34-.407-.658-.725-.936a5 5 0 0 0-.881-.61l-.012-.006h-.002A.5.5 0 0 1 10 7V2a.5.5 0 0 0 .295-.458 1.8 1.8 0 0 0 .351-.271q.088-.088.143-.173H5.211q.055.085.143.173c.12.12.27.227.35.271"/></svg>';

  for (const org of sorted) {
    const chip = document.createElement('div');
    const isSelected = org.uuid === state.selectedOrgId || (!state.selectedOrgId && org.isPrimary);
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

    const pv = org.provider || 'claude';
    const providerLabel = pv === 'gemini' ? 'Gemini ' : pv === 'chatgpt' ? 'GPT ' : '';
    const betaBadge = (pv === 'chatgpt' || pv === 'gemini') ? '<span class="org-chip-beta">Beta</span>' : '';
    chip.innerHTML =
      '<span class="org-chip-plan">' + providerLabel + escHtml(org.plan) + '</span>' +
      betaBadge +
      '<span class="org-chip-name">' + escHtml(org.name) + '</span>' +
      '<span class="org-chip-usage">' + usageText + '</span>';

    // Pin icon: always visible. Click to turn Auto OFF and pin to this org
    const pin = document.createElement('span');
    const isPinned = org.isPrimary;
    pin.className = 'org-chip-pin' + (isPinned ? ' active' : '');
    pin.innerHTML = isPinned ? pinSvgFilled : pinSvgOutline;
    pin.title = t('org_set_primary');
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isPinned) return;
      state.collectedOrgs.forEach(o => { o.isPrimary = (o.uuid === org.uuid); });
      chrome.storage.local.set({ collectedOrgs: state.collectedOrgs });
      chrome.storage.sync.set({ selectedOrgId: org.uuid });
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
      state.selectedOrgId = org.uuid;
      selectOrg(org.uuid, null);
      showMultiOrgBadges(state.collectedOrgs);
      chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' }).catch(() => {});
      const toast = document.createElement('div');
      toast.textContent = t('org_primary_changed');
      toast.style.cssText = 'position:fixed;top:50px;left:50%;transform:translateX(-50%);background:#312e81;color:white;padding:8px 16px;border-radius:8px;font-size:11px;font-weight:600;z-index:9999;transition:opacity 0.5s;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.2);';
      document.body.appendChild(toast);
      setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 500); }, 1500);
    });
    chip.appendChild(pin);

    chip.addEventListener('click', () => {
      // Selecting a chip only changes the popup view — it does NOT change the
      // toolbar badge or the pinned org. The badge follows the pinned (📌) org;
      // use the pin to make an org primary.
      state.selectedOrgId = org.uuid;
      selectOrg(org.uuid, null);
    });
    wrapper.appendChild(chip);
  }

  // 3-org cap hint: when the user has more orgs than the server-side cap,
  // surface a link to the dashboard settings where the active 3 are chosen.
  // Cap enforcement is server-side; this is just a discoverability nudge.
  if (collectedOrgs.length > 3) {
    const capRow = document.createElement('a');
    capRow.href = 'https://claudetuner.com/dashboard/settings/';
    capRow.target = '_blank';
    capRow.rel = 'noopener';
    capRow.style.cssText = 'display:block;padding:6px 10px;border-top:1px solid var(--border);font-size:10px;color:var(--accent);text-decoration:none;text-align:center;background:var(--bg-hover)';
    capRow.textContent = t('org_cap_hint');
    wrapper.appendChild(capRow);
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
