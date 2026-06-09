// The popup's central render pass (_updateUICore), extracted from popup.js (refactor/popup-render).
// Pure view rendering driven by shared state; calls into every leaf/domain module. One-way imports
// (nothing imports this). i18n `t` is a global from i18n.js (classic script).
import { gaugeColor, formatCountdown, formatResetAbsolute, formatTimeAgo } from './util.js';
import { state, _filteredHistory } from './state.js';
import { setPredictHeadline, renderGaugePrediction, renderStatusBanner, renderPeakBanner, _restoreGaugeHTML } from './prediction.js';
import { _shouldSuppressRec, _renderRecommendation, maybeShowDashNudge } from './recommend.js';
import { _providerOrgLabel } from './org-selector.js';

function _applyTeamOnboarding(onboarding) {
  if (!state.onboardOrgName || !onboarding) return;
  const obTitle = onboarding.querySelector('#ob-title');
  if (obTitle) obTitle.textContent = t('ob_title_team', state.onboardOrgName);
}

export function _updateUICore(status) {
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

  // Provider-only users (no Claude org): status reflects the provider org,
  // never Claude. This covers both independent (email) accounts AND signed-out
  // users who only collect Gemini/ChatGPT locally — a Claude collection failure
  // is irrelevant noise to them, so never show the Claude failure UI.
  const _hasClaudeOrg = (state.collectedOrgs || []).some(o => (o.provider || 'claude') === 'claude');
  const _hasProviderOrg = (state.collectedOrgs || []).some(o => (o.provider || 'claude') !== 'claude');
  const _providerOnly = !_hasClaudeOrg && _hasProviderOrg;
  if (state.isIndependent || _providerOnly) {
    const dismissBtnI = document.getElementById('error-dismiss');
    if (dismissBtnI) dismissBtnI.style.display = 'none';
    const provOrg = (state.collectedOrgs || []).find(o => o.isPrimary) || (state.collectedOrgs || [])[0];
    if (provOrg) {
      const label = _providerOrgLabel(provOrg);
      indicator.className = 'status-dot green';
      // Top status shows collection freshness ("✓ 3m ago / ⏳ Nm") like the Claude
      // path; the provider name/plan goes in the "current plan" row below. Derive
      // last-collected from this org's latest usage-history point (providers don't
      // write lastStatus).
      const orgPoints = (state.usageHistory || []).filter(p => p.org === provOrg.uuid);
      const lastT = orgPoints.reduce((m, p) => Math.max(m, p.t || 0), 0);
      if (lastT) {
        statusText.textContent = `✓ ${formatTimeAgo(lastT)}`;
        chrome.alarms.get('claude-usage-poll', (alarm) => {
          if (alarm && alarm.scheduledTime) {
            const mins = Math.max(1, Math.round((alarm.scheduledTime - Date.now()) / 60000));
            statusText.textContent += ` / ⏳ ${mins}${t('min_later_check')}`;
          }
        });
      } else {
        statusText.textContent = label ? `✓ ${label}` : '✓';
      }
      // Surface which provider account is being tracked in the "current plan"
      // row (independent users have no Claude render to reveal it otherwise).
      const infoSection = document.getElementById('info-section');
      if (infoSection) infoSection.classList.remove('hidden');
      const planEl = document.getElementById('plan');
      if (planEl) planEl.textContent = label || provOrg.plan || '';
      if (onboarding) onboarding.classList.add('hidden');
    } else {
      indicator.className = 'status-dot gray';
      statusText.textContent = t('no_data');
      if (onboarding) { onboarding.classList.remove('hidden'); _applyTeamOnboarding(onboarding); }
    }
    // Footer: show the account email (next to the sign-out link), consolidating
    // account display in one place like Claude accounts. Independent (magic-link)
    // accounts use state.independentEmail; provider-only TOFU users (Gemini/ChatGPT,
    // no magic-link signup) fall back to the provider org's own email. The name
    // check keeps it backward-compatible with orgs collected before the `email`
    // field existed (name held the email, or 'Gemini'/'ChatGPT' when unknown).
    const userInfoEl = document.getElementById('user-info');
    if (userInfoEl) {
      const ver = 'v' + chrome.runtime.getManifest().version;
      const provEmail = provOrg
        && (provOrg.email || (/@/.test(provOrg.name || '') ? provOrg.name : ''));
      const footerEmail = state.independentEmail || provEmail || '';
      userInfoEl.textContent = footerEmail ? `${footerEmail} | ${ver}` : ver;
    }
    return;
  }

  if (!status) {
    indicator.className = 'status-dot gray';
    statusText.textContent = t('no_data');
    if (onboarding) { onboarding.classList.remove('hidden'); _applyTeamOnboarding(onboarding); }
    return;
  }

  if (status.error) {
    const errorTitle = errorBanner.querySelector('.error-title');
    // lastStatus errors always originate from Claude collection. A Claude-only
    // failure is not a global failure when the user is actively tracking a
    // provider — demote it to a small, non-red notice and show the provider as
    // healthy. Gate on provider data presence (not accountCache.email, which
    // persists after a session expires and so can't tell "active" from "former"
    // Claude users). Prefer the pinned primary if it's a non-Claude org.
    const primaryOrg = (state.collectedOrgs || []).find(o => o.isPrimary);
    const primaryIsNonClaude = !!(primaryOrg && (primaryOrg.provider || 'claude') !== 'claude');
    const providerWithData = (state.collectedOrgs || []).find(o =>
      (o.provider || 'claude') !== 'claude' && (o.h5 != null || o.d7 != null));
    const demoteOrg = (primaryIsNonClaude ? primaryOrg : null) || providerWithData || null;

    if (demoteOrg) {
      const label = _providerOrgLabel(demoteOrg);
      indicator.className = 'status-dot green';
      statusText.textContent = label ? `✓ ${label}` : '✓';
      if (onboarding) onboarding.classList.add('hidden');

      const dismissBtn = document.getElementById('error-dismiss');
      // If the user already dismissed this notice, keep the healthy status but
      // hide the notice (stays dismissed until Claude recovers — see success path).
      if (state.claudeNoticeDismissed) {
        errorBanner.classList.add('hidden');
        return;
      }

      errorBanner.classList.add('soft');
      errorBanner.classList.remove('hidden');
      if (errorTitle) errorTitle.textContent = t('claude_disconnected_title');
      errorMsg.textContent = t('claude_disconnected_secondary');
      // Keep the "Open Claude.ai" hint (still useful to reconnect), drop timing noise.
      const errorHint = errorBanner.querySelector('.error-hint');
      if (errorHint) errorHint.style.display = '';
      const timingElSoft = document.getElementById('error-timing');
      if (timingElSoft) timingElSoft.innerHTML = '';
      // Show + bind the dismiss (×) button (only for this soft, non-critical notice).
      if (dismissBtn) {
        dismissBtn.style.display = '';
        if (!dismissBtn.dataset.bound) {
          dismissBtn.dataset.bound = '1';
          dismissBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.claudeNoticeDismissed = true;
            chrome.storage.local.set({ claudeNoticeDismissed: true });
            errorBanner.classList.add('hidden');
          });
        }
      }
      return;
    }

    // Hard failure (Claude is primary, or no non-Claude primary pinned): red banner
    errorBanner.classList.remove('soft');
    if (errorTitle) errorTitle.textContent = t('error_banner_title');
    const dismissBtnHard = document.getElementById('error-dismiss');
    if (dismissBtnHard) dismissBtnHard.style.display = 'none';
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
  if (state.onboardOrgName) { state.onboardOrgName = null; chrome.storage.local.remove('onboardOrgName'); }
  maybeShowDashNudge();

  // Claude recovered — reset the dismissed-notice flag so a future disconnection
  // surfaces the notice again.
  if (state.claudeNoticeDismissed) {
    state.claudeNoticeDismissed = false;
    chrome.storage.local.remove('claudeNoticeDismissed');
  }
  const dismissBtnOk = document.getElementById('error-dismiss');
  if (dismissBtnOk) dismissBtnOk.style.display = 'none';

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
    state.currentPlan = s.plan || null;
    state.currentSnapshot = s;
    if (status.recommendation && !_shouldSuppressRec(status.recommendation, s.subscription?.pending_plan)) state.lastRecommendation = status.recommendation;

    // If selected org differs from Claude primary, skip all rendering.
    // Status indicator and caches are already updated above.
    // selectOrg handles non-Claude rendering (called from chip click or collectedOrgs onChange).
    // (Reset the prediction headline only past this point — when this render owns
    // the gauges. The selected-org path leaves it to selectOrg() so a debounced
    // status render doesn't wipe a headline selectOrg set.)
    if (state.selectedOrgId && state.selectedOrgId !== s.claude_org_uuid) {
      return;
    }

    // Reset the headline; the gauge branches below re-show it via
    // renderGaugePrediction('5h'), or leave it hidden (usage-based Enterprise).
    setPredictHeadline(null);

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
          '<div class="gauge-sub" style="color:var(--text-secondary);font-size:10px">$' + usedDollars + ' / $' + limitDollars + '</div></div>';
      } else {
        gaugeSection.innerHTML = '<div style="text-align:center;padding:6px 0">'
          + '<div style="font-size:13px;font-weight:600;color:var(--accent)">Enterprise</div>'
          + '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px">' + t('enterprise_unlimited') + '</div>'
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
        document.getElementById('gauge-5h-reset').innerHTML = `<div>\u23f1 ${formatCountdown(s.five_hour.resets_at)}</div><div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-top:1px">\u21bb ${formatResetAbsolute(s.five_hour.resets_at)}</div>`;
      }
      renderGaugePrediction('5h', _filteredHistory(), 'h5', util5h, s.five_hour?.resets_at);
      if (util7d !== null) {
        document.getElementById('gauge-7d-value').textContent = `${Math.round(util7d)}%`;
        document.getElementById('gauge-7d-fill').style.width = `${Math.min(util7d, 100)}%`;
        document.getElementById('gauge-7d-fill').style.background = gaugeColor(util7d);
        document.getElementById('gauge-7d-value').style.color = gaugeColor(util7d);
        if (s.seven_day?.resets_at) {
          document.getElementById('gauge-7d-reset').innerHTML = `<div>\u23f1 ${formatCountdown(s.seven_day.resets_at)}</div><div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-top:1px">\u21bb ${formatResetAbsolute(s.seven_day.resets_at)}</div>`;
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
        document.getElementById('gauge-5h-reset').innerHTML = `<div>\u23f1 ${formatCountdown(s.five_hour.resets_at)}</div><div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-top:1px">\u21bb ${formatResetAbsolute(s.five_hour.resets_at)}</div>`;
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
          document.getElementById('gauge-7d-reset').innerHTML = `<div>\u23f1 ${formatCountdown(s.seven_day.resets_at)}</div><div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-top:1px">\u21bb ${formatResetAbsolute(s.seven_day.resets_at)}</div>`;
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
            extraTooltip.innerHTML = getLang() === 'ko'
              ? '기본 요금제(Max 20x 등)에 포함된 사용량을 다 쓰면, 충전한 크레딧에서 종량제로 차감됩니다. 추가 과금이 될 수 있으니, 필요하지 않은 경우 추가 사용량 기능을 꺼두세요.<br><a href="https://claude.ai/settings/usage" target="_blank" style="color:var(--accent)">Claude.ai에서 설정 →</a>'
              : 'When you use up your plan\'s included usage (e.g. Max 20x), extra credits are charged pay-as-you-go. Turn off extra usage if you don\'t need it to avoid unexpected charges.<br><a href="https://claude.ai/settings/usage" target="_blank" style="color:var(--accent)">Manage in Claude.ai →</a>';
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
      const dayNames = getLang() === 'ko' ? ['일','월','화','수','목','금','토'] : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      document.getElementById('extra-usage-detail').textContent = `$${used} / $${limit} · ${nextMonth1st.getMonth() + 1}/1(${dayNames[nextMonth1st.getDay()]}) ${getLang() === 'ko' ? '리셋' : 'reset'}`;
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
      privacyVal.textContent = t('privacy_on');
      privacyVal.href = '#';
      privacyVal.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: 'https://claude.ai/settings/data-privacy-controls' }); };
      privacyVal.title = t('privacy_link_title');
      chrome.storage.local.get({ hiddenPrivacyBanner: false }, (st) => {
        privacyRow.classList.toggle('hidden', !!st.hiddenPrivacyBanner);
      });
    } else {
      privacyRow.classList.add('hidden');
      // grove turned off — clear dismiss so it re-appears if turned on again
      chrome.storage.local.remove('hiddenPrivacyBanner');
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
        chrome.storage.local.get({ hiddenDowngradePlan: null }, (st) => {
          const wrap = document.getElementById('cancel-downgrade-wrap');
          if (wrap) {
            if (st.hiddenDowngradePlan === s.subscription.pending_plan) {
              wrap.style.display = 'none';
            } else {
              wrap.style.display = 'flex';
            }
          }
        });
      }
    }

    // Server recommendation (unified recommendation system)
    if (status.recommendation && !_shouldSuppressRec(status.recommendation, s.subscription?.pending_plan)) {
      state.lastRecommendation = status.recommendation;
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
