// popup.js is the ES-module orchestrator (see popup.html). Domains live in ui/*.js.
import { drawCharts, _switchChartTab, _startChartAutoRoll, _stopChartAutoRoll, _toggleChartAutoRoll, isChartAutoRoll, isChartRolling } from './ui/charts.js';
import { renderStatusBanner, initRunner } from './ui/prediction.js';
import { state, _filteredHistory } from './ui/state.js';
import { loadFitnessMatrix, checkReviewNudge, showRecFeedback } from './ui/recommend.js';
import { loadOrgSelector, selectOrg, showMultiOrgBadges } from './ui/org-selector.js';
import { _updateUICore } from './ui/render.js';
import { loadPopupAnnouncements } from './ui/notices.js';



// Check optional provider permissions and show banner if needed
async function checkProviderPermissions() {
  const banner = document.getElementById('perm-banner');
  if (!banner) return;
  const { collectChatGPT = true, collectGemini = true } = await chrome.storage.sync.get({ collectChatGPT: true, collectGemini: true });
  const missing = [];
  if (collectChatGPT) {
    const ok = await chrome.permissions.contains({ origins: ['https://chatgpt.com/*'] });
    if (!ok) missing.push({ label: 'ChatGPT', origins: ['https://chatgpt.com/*'] });
  }
  if (collectGemini) {
    const ok = await chrome.permissions.contains({ origins: ['https://gemini.google.com/*'] });
    if (!ok) missing.push({ label: 'Gemini', origins: ['https://gemini.google.com/*'] });
  }
  if (missing.length === 0) { banner.classList.add('hidden'); return; }
  const names = missing.map(m => m.label).join(', ');
  banner.innerHTML = '';
  banner.appendChild(document.createTextNode(t('perm_banner_text', names) || names + ' collection requires permission.'));
  const btn = document.createElement('button');
  btn.textContent = t('perm_banner_btn') || 'Grant';
  btn.addEventListener('click', async () => {
    try {
      const allOrigins = missing.flatMap(m => m.origins);
      const granted = await chrome.permissions.request({ origins: allOrigins });
      if (granted) {
        banner.classList.add('hidden');
        chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' }).catch(() => {});
      }
    } catch (e) {
      console.warn('[Claude Tuner] Permission request failed:', e.message);
    }
  });
  banner.appendChild(btn);
  banner.classList.remove('hidden');
}


// Auto org mode removed in v1.24.3 — see memory/auto-org-feature-archive.md for restoration

// Check if selected org is NOT the Claude primary org (used to skip Claude-only rendering)

// Hide all Claude-only UI elements (recommendation, fitness, privacy, pending plan, renewal)
function _hideClaudeOnlyUI() {
  const ids = ['recommendation-row', 'smart-rec-detail', 'fitness-section', 'privacy-row', 'pending-row'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  }
  const cancelWrap = document.getElementById('cancel-downgrade-wrap');
  if (cancelWrap) cancelWrap.style.display = 'none';
  const renewalGroup = document.getElementById('renewal-group');
  if (renewalGroup) renewalGroup.style.display = 'none';
}

// === Theme ===
const THEME_ICONS = { light: '\u2600\uFE0F', dark: '\uD83C\uDF19', system: '\uD83D\uDCBB' };
function initPopupTheme() {
  chrome.storage.local.get({ 'ct-theme': 'system' }, (r) => {
    const pref = r['ct-theme'];
    const resolved = pref === 'system'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : pref;
    document.documentElement.setAttribute('data-theme', resolved);
    updateThemeBtn(pref);
  });
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      chrome.storage.local.get({ 'ct-theme': 'system' }, (r) => {
        const order = ['system', 'light', 'dark'];
        const cur = r['ct-theme'] || 'system';
        const next = order[(order.indexOf(cur) + 1) % order.length];
        const resolved = next === 'system'
          ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : next;
        chrome.storage.local.set({ 'ct-theme': next });
        document.documentElement.setAttribute('data-theme', resolved);
        updateThemeBtn(next);
      });
    });
  }
}
function updateThemeBtn(mode) {
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    const svg = btn.querySelector('svg');
    if (svg) svg.style.display = 'none';
    btn.textContent = THEME_ICONS[mode] || THEME_ICONS.system;
    btn.style.fontSize = '14px';
  }
}

// Build auth headers for server requests (ext_token > API key fallback).
// Keep in sync with bg/storage.js#getAuthHeaders.


// Return only history matching the selected org

// === Announcements ===








// === Organization Selection ===

// === Plan Fitness Matrix ===



document.addEventListener('DOMContentLoaded', async () => {
  await initI18n();
  initPopupTheme();
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

  // === Independent Account: show email auth / re-auth / signed-in state ===
  const { accountCache: _ac, independentAccount: _ia, collectedOrgs: _co } =
    await chrome.storage.local.get({
      accountCache: null, independentAccount: null, collectedOrgs: [],
    });
  // Genuine independent = email account, no Claude session, AND no Claude org
  // data. The Claude-org check avoids a false positive (showing the independent
  // row + footer Claude email at once) while accountCache is still being
  // populated on a Claude user's first collection of the session.
  const _hasClaudeOrg = (_co || []).some(o => (o.provider || 'claude') === 'claude');
  const isIndependent = !_ac?.email && !!_ia?.email && !_hasClaudeOrg;
  state.isIndependent = isIndependent; // expose to _updateUICore (suppress Claude-centric UI)
  state.independentEmail = isIndependent ? (_ia.email || '') : ''; // shown in the footer
  // The in-popup email signup form was removed: with TOFU symmetric identity,
  // simply signing in to Claude/ChatGPT/Gemini auto-syncs usage — no signup
  // needed. The magic-link flow now only exists as a dashboard login fallback.
  // Existing independent (email) accounts still get the footer sign-out link.
  if (isIndependent) {
    const signOut = document.getElementById('independent-signout');
    if (signOut) {
      signOut.classList.remove('hidden');
      signOut.addEventListener('click', async (e) => {
        e.preventDefault();
        await chrome.storage.local.remove(['independentAccount', 'extToken', 'needsReauth']);
        location.reload();
      });
    }
  }

  loadPopupAnnouncements();
  // Side panel persists across hide/show: if the initial fetch never populated
  // the list, re-try when the panel becomes visible again (matches the "reopen
  // makes the bell appear" behavior, without a manual close/reopen).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.popupNoticeList.length === 0) loadPopupAnnouncements();
  });
  loadOrgSelector();
  checkProviderPermissions();
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
    const isUsageBasedEnt = (state.currentPlan || '').includes('Enterprise') && state.currentSnapshot?.five_hour?.utilization == null && state.currentSnapshot?.seven_day?.utilization == null;
    if (hist.length >= 2 || isUsageBasedEnt) {
      drawCharts(hist, state.currentPlan, state.currentSnapshot);
      if (isChartAutoRoll() && !isUsageBasedEnt) _startChartAutoRoll();
    }
    // Refresh banner after history load (reflects rate-based prediction)
    if (hist.length >= 3 && state.currentSnapshot) {
      const s = state.currentSnapshot;
      renderStatusBanner(s.five_hour?.utilization ?? null, s.seven_day?.utilization ?? null, hist, s.five_hour?.resets_at, s.seven_day?.resets_at);
    }
  }

  // Load current status + history directly from chrome.storage
  // Restore pinned org from selectedOrgId (sync)
  chrome.storage.sync.get({ selectedOrgId: null }, (syncCfg) => {
    chrome.storage.local.get({ lastStatus: null, usageHistory: [], collectedOrgs: [], claudeNoticeDismissed: false, onboardOrgName: null }, (result) => {
      state.onboardOrgName = result.onboardOrgName || null;
      state.usageHistory = result.usageHistory || [];
      state.historyLoaded = true;
      state.claudeNoticeDismissed = result.claudeNoticeDismissed || false;
      _historyReady = true;

      // Multi-org: restore pinned org or fall back to primary
      const cOrgs = result.collectedOrgs || [];
      if (cOrgs.length >= 1) {
        state.collectedOrgs = cOrgs;
        if (syncCfg.selectedOrgId) {
          const pinned = cOrgs.find(o => o.uuid === syncCfg.selectedOrgId);
          state.selectedOrgId = pinned ? pinned.uuid : (cOrgs.find(o => o.isPrimary)?.uuid || cOrgs[0]?.uuid || null);
        } else {
          const primary = cOrgs.find(o => o.isPrimary) || cOrgs[0];
          if (primary) state.selectedOrgId = primary.uuid;
        }
      }

      const status = result.lastStatus;
      updateUI(status);
      if (status) {
        state.currentPlan = status?.snapshot?.plan || null;
        state.currentSnapshot = status?.snapshot || null;
        loadFitnessMatrix();
      }
      // Render the selected provider org via selectOrg whenever a non-Claude org
      // is selected. This must run even when status is null/absent — independent
      // (email) users have no Claude lastStatus, so their gauge/charts would
      // otherwise never render.
      if (state.selectedOrgId && state.selectedOrgId !== status?.snapshot?.claude_org_uuid) {
        selectOrg(state.selectedOrgId, null);
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
        state.usageHistory = r.usageHistory || [];
        state.historyLoaded = true;
        if (r.lastStatus) {
          // Reset to primary org uuid (null would mix multi-org histories)
          const cOrgs = r.collectedOrgs || [];
          if (cOrgs.length >= 1) state.collectedOrgs = cOrgs;
          const primary = state.collectedOrgs.find(o => o.isPrimary) || state.collectedOrgs[0];
          state.selectedOrgId = primary ? primary.uuid : null;
          updateUI(r.lastStatus);
          state.currentPlan = r.lastStatus?.snapshot?.plan || null;
          state.currentSnapshot = r.lastStatus?.snapshot || null;
          const hist = _filteredHistory();
          if (hist.length >= 2) drawCharts(hist, state.currentPlan, state.currentSnapshot);
          if (hist.length >= 3 && state.currentSnapshot) {
            renderStatusBanner(state.currentSnapshot.five_hour?.utilization ?? null, state.currentSnapshot.seven_day?.utilization ?? null, hist, state.currentSnapshot.five_hour?.resets_at, state.currentSnapshot.seven_day?.resets_at);
          }
        }
        // Re-render org chips too (reflects plan name translations, etc.)
        if (state.collectedOrgs.length >= 2) showMultiOrgBadges(state.collectedOrgs);
        loadFitnessMatrix();
      });
    }
  });

  // Auto-refresh on background collection success (while side panel/popup is open)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    // Sync theme when changed from options page
    if (changes['ct-theme']) {
      const pref = changes['ct-theme'].newValue || 'system';
      const resolved = pref === 'system'
        ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : pref;
      document.documentElement.setAttribute('data-theme', resolved);
      updateThemeBtn(pref);
    }

    // Team onboarding context updated from welcome page
    if (changes.onboardOrgName) {
      state.onboardOrgName = changes.onboardOrgName.newValue || null;
      updateUI(state.lastUpdateUIStatus);
    }

    // Immediately refresh org chips when collectedOrgs changes
    if (changes.collectedOrgs) {
      state.collectedOrgs = changes.collectedOrgs.newValue || [];
      if (state.collectedOrgs.length >= 2) {
        showMultiOrgBadges(state.collectedOrgs);
        // Refresh selected org data (without switching view)
        if (state.selectedOrgId) {
          selectOrg(state.selectedOrgId, null);
        }
      } else {
        // Orgs dropped to single — remove stale chip DOM and reset to primary
        const existingChips = document.getElementById('org-chips');
        if (existingChips) existingChips.remove();
        const existingBadge = document.getElementById('org-badge');
        if (existingBadge) existingBadge.remove();
        const primary = state.collectedOrgs[0];
        if (primary && state.selectedOrgId !== primary.uuid) {
          state.selectedOrgId = primary.uuid;
          selectOrg(primary.uuid, null);
        }
      }
      // Re-render the status UI with the newly-arrived org data. Without this,
      // a provider-only (e.g. Gemini) collection that completes while the panel
      // is open never re-runs the provider-only / demote / onboarding / footer-
      // email decisions in _updateUICore — they were evaluated on the first
      // paint when state.collectedOrgs was still empty, leaving a stale "Claude
      // collection failed" banner + onboarding + missing footer email until the
      // panel is reopened. The lastStatus handler below returns early when only
      // collectedOrgs changed, so this is the sole re-render trigger then.
      updateUI(state.lastUpdateUIStatus);
    }

    if (!changes.lastStatus) return;
    const status = changes.lastStatus.newValue;
    if (status) {
      chrome.storage.local.get({ usageHistory: [], collectedOrgs: [] }, (r) => {
        state.usageHistory = r.usageHistory || [];
        state.historyLoaded = true;
        state.collectedOrgs = r.collectedOrgs || [];
        updateUI(status);
        state.currentPlan = status?.snapshot?.plan || null;
        state.currentSnapshot = status?.snapshot || null;
        // updateUI handles early return for non-Claude orgs; only draw charts for Claude primary
        if (!state.selectedOrgId || state.selectedOrgId === status?.snapshot?.claude_org_uuid) {
          const hist = _filteredHistory();
          if (hist.length >= 2) drawCharts(hist, state.currentPlan, state.currentSnapshot);
          if (hist.length >= 3 && state.currentSnapshot) {
            renderStatusBanner(state.currentSnapshot.five_hour?.utilization ?? null, state.currentSnapshot.seven_day?.utilization ?? null, hist, state.currentSnapshot.five_hour?.resets_at, state.currentSnapshot.seven_day?.resets_at);
          }
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

      // Update UI with saved lastStatus — single callback to avoid race conditions
      chrome.storage.local.get({ lastStatus: null, usageHistory: [], collectedOrgs: [] }, (r) => {
        state.usageHistory = r.usageHistory || [];
        state.historyLoaded = true;
        state.collectedOrgs = r.collectedOrgs || [];
        const s = r.lastStatus;
        if (s) {
          updateUI(s);
          state.currentPlan = s?.snapshot?.plan || null;
          state.currentSnapshot = s?.snapshot || null;
        }

        // Refresh org chips
        if (result && result.success) {
          if (!state.orgList) loadOrgSelector();
          if (state.collectedOrgs.length >= 2) {
            showMultiOrgBadges(state.collectedOrgs);
          }
          chrome.storage.local.remove('fitnessCache', () => loadFitnessMatrix());
        }

        // Non-Claude org: selectOrg is called from collectedOrgs onChange; skip chart/banner
        if (!state.selectedOrgId || state.selectedOrgId === s?.snapshot?.claude_org_uuid) {
          const hist2 = _filteredHistory();
          if (hist2.length >= 2) drawCharts(hist2, state.currentPlan, state.currentSnapshot);
          if (hist2.length >= 3 && state.currentSnapshot) {
            renderStatusBanner(state.currentSnapshot.five_hour?.utilization ?? null, state.currentSnapshot.seven_day?.utilization ?? null, hist2, state.currentSnapshot.five_hour?.resets_at, state.currentSnapshot.seven_day?.resets_at);
          }
        }
      });
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
        toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#312e81;color:white;padding:10px 20px;border-radius:8px;font-size:12px;font-weight:600;z-index:9999;transition:opacity 0.5s;white-space:nowrap;';
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
        if (isChartAutoRoll() && isChartRolling()) {
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
      document.getElementById('recommendation').style.color = 'var(--text-primary)';
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
      document.getElementById('recommendation').style.color = 'var(--text-primary)';
    });
  });

  // Smart recommendation execute button — show confirmation modal
  document.getElementById('smart-rec-btn').addEventListener('click', () => {
    chrome.storage.local.get({ lastStatus: {} }, (result) => {
      const recommendation = result.lastStatus?.recommendation;
      if (!recommendation?.type) return;

      const isUpgrade = recommendation.type === 'upgrade';
      const modal = document.getElementById('smart-rec-confirm-modal');

      document.getElementById('src-modal-title').textContent = t(isUpgrade ? 'confirm_upgrade_title' : 'confirm_downgrade_title');
      document.getElementById('src-modal-plan').textContent = t('confirm_plan_change', recommendation.from_plan || '', recommendation.to_plan || '');

      const costEl = document.getElementById('src-modal-cost');
      if (recommendation.from_cost != null && recommendation.to_cost != null) {
        costEl.textContent = isUpgrade
          ? t('opt_cost_up', recommendation.from_cost, recommendation.to_cost, recommendation.cost_diff)
          : t('opt_cost_down', recommendation.from_cost, recommendation.to_cost, recommendation.cost_diff);
      } else {
        costEl.textContent = '';
      }

      document.getElementById('src-modal-timing').textContent = t(isUpgrade ? 'confirm_timing_immediate' : 'confirm_timing_renewal');
      document.getElementById('src-modal-warning').textContent = t('confirm_warning');

      const confirmBtn = document.getElementById('src-modal-confirm');
      confirmBtn.textContent = t(isUpgrade ? 'confirm_upgrade_btn' : 'confirm_downgrade_btn');
      confirmBtn.style.background = isUpgrade ? '#059669' : '#d97706';
      confirmBtn.disabled = false;

      document.getElementById('src-modal-cancel').textContent = t('confirm_cancel');

      modal.style.display = 'flex';
    });
  });

  // Confirmation modal — confirm button
  document.getElementById('src-modal-confirm').addEventListener('click', () => {
    const modal = document.getElementById('smart-rec-confirm-modal');
    const confirmBtn = document.getElementById('src-modal-confirm');
    confirmBtn.disabled = true;
    confirmBtn.classList.add('loading');
    confirmBtn.textContent = t('changing');

    const btn = document.getElementById('smart-rec-btn');
    btn.disabled = true;

    chrome.storage.local.get({ lastStatus: {} }, (result) => {
      const recommendation = result.lastStatus?.recommendation;
      if (!recommendation?.type) { modal.style.display = 'none'; return; }

      chrome.runtime.sendMessage({ type: 'EXECUTE_PLAN_CHANGE', recommendation }, (res) => {
        modal.style.display = 'none';
        confirmBtn.disabled = false;
        confirmBtn.classList.remove('loading');
        btn.disabled = false;
        if (res?.success) {
          // Hide entire recommendation section after successful plan change
          state.lastRecommendation = null;
          state.planChangedTo = recommendation.to_plan || recommendation.toPlan;
          document.getElementById('smart-rec-detail').classList.add('hidden');
          document.getElementById('smart-rec-btn').classList.add('hidden');
          document.getElementById('smart-rec-dismiss').classList.add('hidden');
          document.getElementById('smart-rec-mute').classList.add('hidden');
          document.getElementById('recommendation').textContent = t('change_done');
          document.getElementById('recommendation').style.color = '#059669';
          // Clear recommendation from storage so it won't reappear on popup reopen
          chrome.storage.local.get({ lastStatus: {} }, (s) => {
            const ls = s.lastStatus || {};
            delete ls.recommendation;
            chrome.storage.local.set({ lastStatus: ls });
          });
          showRecFeedback(recommendation.type);
        } else {
          btn.textContent = t('opt_execute');
          showError(res?.error || t('collect_fail'));
        }
      });
    });
  });

  // Confirmation modal — cancel button
  document.getElementById('src-modal-cancel').addEventListener('click', () => {
    document.getElementById('smart-rec-confirm-modal').style.display = 'none';
  });

  // Confirmation modal — backdrop click to close
  document.getElementById('smart-rec-confirm-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  // Confirmation modal — ESC key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('smart-rec-confirm-modal');
      if (modal.style.display !== 'none') modal.style.display = 'none';
    }
  });

  // Render plan change order banner (Claude only)
  chrome.storage.local.get({ pendingPlanOrder: null, completedPlanOrder: null, collectedOrgs: [] }, (store) => {
    const primaryOrg = (store.collectedOrgs || []).find(o => o.isPrimary);
    const primaryProvider = primaryOrg?.provider || 'claude';
    if (primaryProvider !== 'claude') return; // plan orders are Claude-specific
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
      if (!isUp && state.currentSnapshot?.subscription?.renewal_date) {
        const rd = new Date(state.currentSnapshot.subscription.renewal_date);
        dDesc = t('plan_downgrade_desc_date', `${rd.getMonth() + 1}/${rd.getDate()}`);
      }
      const el = document.getElementById('plan-order-completed');
      el.classList.remove('hidden');
      el.style.background = '#f0fdf4';
      el.style.borderColor = '#bbf7d0';
      document.getElementById('plan-order-completed-body').innerHTML =
        `<div style="font-size:13px;font-weight:600;margin-bottom:4px">✅ ${completed.to_plan}${isUp ? t('plan_changed_now') : t('plan_changed_scheduled')}</div>` +
        `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">${isUp ? t('plan_upgrade_desc') : dDesc}</div>` +
        `<a href="https://claude.ai/settings/billing" target="_blank" style="font-size:11px;color:var(--accent);text-decoration:none;font-weight:500">${t('plan_check_settings')} →</a>`;
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
        const _isDk = document.documentElement.dataset.theme === 'dark';
        banner.style.background = _isDk ? '#052e16' : '#f0fdf4';
        banner.style.borderColor = _isDk ? '#166534' : '#bbf7d0';
        const body = document.getElementById('plan-order-body');
        let downgradeDesc = t('plan_downgrade_desc');
        if (!isUpgrade && state.currentSnapshot?.subscription?.renewal_date) {
          const rd = new Date(state.currentSnapshot.subscription.renewal_date);
          downgradeDesc = t('plan_downgrade_desc_date', `${rd.getMonth() + 1}/${rd.getDate()}`);
        }
        body.innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:4px">✅ ${_po.to_plan || ''}${isUpgrade ? t('plan_changed_now') : t('plan_changed_scheduled')}</div>` +
          `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">${isUpgrade ? t('plan_upgrade_desc') : downgradeDesc}</div>` +
          `<a href="https://claude.ai/settings/billing" target="_blank" style="font-size:11px;color:var(--accent);text-decoration:none;font-weight:500">${t('plan_check_settings')} →</a>`;
        // Hide buttons
        document.getElementById('plan-order-accept').style.display = 'none';
        document.getElementById('plan-order-reject').style.display = 'none';
        const reasonEl = document.getElementById('plan-order-reason');
        if (reasonEl) reasonEl.style.display = 'none';
        const costEl = document.getElementById('plan-order-cost');
        if (costEl) costEl.style.display = 'none';
        // Close banner after 10 seconds
        setTimeout(() => banner.classList.add('hidden'), 10000);
      } else if (res?.error === 'Plan already changed externally') {
        // Plan was already changed — hide the stale banner
        document.getElementById('plan-order-banner').classList.add('hidden');
        showError(t('plan_already_changed') || 'Plan already changed');
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
        document.getElementById('cancel-downgrade-wrap').style.display = 'none';
        document.getElementById('pending-row').classList.add('hidden');
        chrome.storage.local.remove('hiddenDowngradePlan');
        showSuccess(t('downgrade_cancelled'));
        chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' });
      } else {
        btn.textContent = t('cancel_downgrade');
        showError(res?.error || t('collect_fail'));
      }
    });
  });

  // Hide downgrade button (dismiss)
  document.getElementById('hide-downgrade-btn').addEventListener('click', (e) => {
    e.preventDefault();
    const pendingPlan = state.currentSnapshot?.subscription?.pending_plan;
    if (pendingPlan) {
      chrome.storage.local.set({ hiddenDowngradePlan: pendingPlan });
    }
    document.getElementById('cancel-downgrade-wrap').style.display = 'none';
  });

  // Privacy banner dismiss
  document.getElementById('privacy-dismiss').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.storage.local.set({ hiddenPrivacyBanner: true });
    document.getElementById('privacy-row').classList.add('hidden');
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


// === Recommendation Feedback Toast ===

// === Recommendation rendering helper (shared by updateUI + selectOrg) ===

// === UI Update ===

// One-time nudge toward the web dashboard, shown right after a successful
// collection. Dashboard reach is the strongest retention signal for new users
// (esp. overseas: reachers churn ~4.9% vs ~19% for non-reachers), but the popup
// hides its onboarding block on success, leaving no prominent path. Show this
// up to a few times, then stop; any interaction (open or dismiss) ends it.

// Debounced wrapper: collapses rapid-fire updateUI calls (e.g. lastStatus + collectedOrgs changes)
function updateUI(status) {
  state.lastUpdateUIStatus = status;
  if (state.updateUITimer) clearTimeout(state.updateUITimer);
  state.updateUITimer = setTimeout(() => { state.updateUITimer = null; _updateUICore(state.lastUpdateUIStatus); }, 50);
}


// === Gauge prediction markers ===
// === Common prediction function: projected utilization at reset ===

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


