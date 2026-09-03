// The popup's central render pass (_updateUICore), extracted from popup.js (refactor/popup-render).
// Pure view rendering driven by shared state; calls into every leaf/domain module. One-way imports
// (nothing imports this). i18n `t` is a global from i18n.js (classic script).
import { gaugeColor, formatTimeAgo, setRenewalDisplay, applyGaugeWindowLabels } from './util.js';
import { noteSurface } from '../bg/block-state.js';
import { renderGaugeReset } from './gauge-facts.js';
import { state, _filteredHistory, isDetailHidden } from './state.js';
import { setPredictHeadline, renderGaugePrediction, renderLimitReachedHeadline, renderStatusBanner, renderPeakBanner, _restoreGaugeHTML } from './prediction.js';
import { _shouldSuppressRec, _renderRecommendation, maybeShowDashNudge } from './recommend.js';
import { _providerOrgLabel } from './org-selector.js';
import { _authedFetch } from './auth.js';
import { getUpgradeBlock } from '../bg/upgrade-gate.js';

function _applyTeamOnboarding(onboarding) {
  if (!state.onboardOrgName || !onboarding) return;
  const obTitle = onboarding.querySelector('#ob-title');
  if (obTitle) obTitle.textContent = t('ob_title_team', state.onboardOrgName);
}

// Set a gauge's value + bar fill from its utilization, or blank both to N/A when
// the window has no value. Writing the null case (not skipping it) is what keeps a
// window that lost its utilization from showing a previous render's stale % / fill.
// `util` of 0 is a real value — the guard is `!== null`, never truthiness.
function _setGaugeValue(id, util) {
  const valEl = document.getElementById(`gauge-${id}-value`);
  const fillEl = document.getElementById(`gauge-${id}-fill`);
  if (!valEl || !fillEl) return;
  if (util !== null) {
    valEl.textContent = `${Math.round(util)}%`;
    valEl.style.color = gaugeColor(util);
    fillEl.style.width = `${Math.min(util, 100)}%`;
    fillEl.style.background = gaugeColor(util);
  } else {
    valEl.textContent = 'N/A';
    valEl.style.color = '#9ca3af';
    fillEl.style.width = '0';
  }
}

// "수집이 됐다"와 "서버가 받았다"는 다른 사실이다. 세 군데가 각자 초록을 칠하고 있었고
// (provider-only / Claude 실패 후 provider 강등 / Claude 성공), 그 중 서버 전송 여부를 보는
// 곳은 하나도 없었다 — 그래서 로그인 게이트에 걸린 설치가 "✓ 방금"으로 보였다.
// A healthy-looking status is painted HERE and nowhere else, so a future fourth site cannot
// reintroduce the lie by copying one of the other three. The guard pins that the literal
// 'status-dot green' appears only in this function.
// `paused` (#1119) is a FOURTH state and a separate parameter, not a fifth value of `withheld`:
// `withheld` means "no usable credential, log in" and every caller of serverSyncWithheldReason()
// acts on it that way, while a paused install holds a valid token and its remedy is one click in
// this same popup. Both paint amber — nothing is reaching the server either way, and that is the
// fact the dot exists to tell — but the words differ, because the words are the actionable part.
function paintHealthy(indicator, statusText, withheld, body, paused = false) {
  indicator.className = withheld || paused ? 'status-dot amber' : 'status-dot green';
  // 🔴 The label must stay SHORT. The status bar also appends the collection time and the next
  // poll ("· 방금 / ⏳ 59분 후"), so a sentence here gets ellipsised — and the first version lost
  // exactly the actionable half ("⚠ 로컬 전용 · 로그인해야 …"), which defeats the point of
  // saying anything. The consequence lives in the tooltip and in the login card right below.
  // Withheld outranks paused when both hold: a paused user whose token also went missing needs to
  // know a login is required, because resuming alone will not start the sync back up.
  const holdLabel = withheld ? t('status_local_only') : paused ? t('status_sync_paused') : '';
  statusText.textContent = holdLabel ? `⚠ ${holdLabel}${body ? ` · ${body}` : ''}` : `✓ ${body}`;
  // Cleared on the healthy path: a stale tooltip would outlive its cause, which is the same
  // latch-shaped bug this whole area exists to remove.
  statusText.title = withheld ? t('status_local_only_tip') : '';
  // Fills the ELSE of the line above rather than rewriting it: that assignment's set-and-cleared
  // shape is what test/local-only-status-guard.mjs pins (a tooltip that outlives its cause is the
  // bug this area exists to remove), and the pause tooltip has to obey the same rule — so it is
  // only ever written where that line has just cleared the slot.
  if (!withheld && paused) statusText.title = t('status_sync_paused_tip');
  if (withheld) noteSurface('local_only_status');
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

  // 🔴 Clear the status tooltip HERE, not only where it is set. paintHealthy() cleared it on its
  // own healthy path, but every other branch overwrites `statusText.textContent` directly
  // (no_data, collect_fail, the provider demotion) and left the local-only tooltip attached to a
  // completely different sentence — "수집 실패" with a hover saying "로컬 전용". That is the
  // outlives-its-cause shape this whole area exists to remove, so the reset belongs at the ONE
  // place every render passes through. (Codex, PR #948.)
  statusText.title = '';

  // Hide error banner by default
  errorBanner.classList.add('hidden');

  // Claude account email mismatch warning (independent of the Claude error path —
  // it must show even for "provider-only" looking users, since the whole point is
  // that their Claude account never collected). Fire-and-forget; reads storage.
  renderEmailMismatchWarning();
  renderPinMoveNotice();
  renderClaudeLinkStatus();
  // Extension-too-old block (server 426). Same fire-and-forget shape, and equally independent of
  // the Claude error path: a version-blocked install collects and renders locally exactly as
  // before, so nothing else in this pass would ever look wrong.
  renderUpgradeWarning();

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
      // Provider-only installs are withheld by exactly the same gate — Gemini/ChatGPT usage does
      // not reach the server either. Claude-specific FAILURES stay hidden here (irrelevant to
      // them, #944), but "nothing is reaching the server" is not Claude-specific.
      const _w = status.serverWithheld || null;
      // #1119 — provider-only installs pause through the same control, and nothing they collect
      // reaches the server while it stands either.
      const _p = status.syncPaused === true;
      // Top status shows collection freshness ("✓ 3m ago / ⏳ Nm") like the Claude
      // path; the provider name/plan goes in the "current plan" row below. Derive
      // last-collected from this org's latest usage-history point (providers don't
      // write lastStatus).
      const orgPoints = (state.usageHistory || []).filter(p => p.org === provOrg.uuid);
      const lastT = orgPoints.reduce((m, p) => Math.max(m, p.t || 0), 0);
      if (lastT) {
        paintHealthy(indicator, statusText, _w, formatTimeAgo(lastT), _p);
        // Countdown suppressed while withheld — see appendNextPoll's contract.
        if (!_w && !_p) {
          chrome.alarms.get('claude-usage-poll', (alarm) => {
            if (alarm && alarm.scheduledTime) {
              const mins = Math.max(1, Math.round((alarm.scheduledTime - Date.now()) / 60000));
              statusText.textContent += ` / ⏳ ${mins}${t('min_later_check')}`;
            }
          });
        }
      } else {
        paintHealthy(indicator, statusText, _w, label || '', _p);
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
    const provEmail = provOrg
      && (provOrg.email || (/@/.test(provOrg.name || '') ? provOrg.name : ''));
    const footerEmail = state.independentEmail || provEmail || '';
    const userInfoEl = document.getElementById('user-info');
    if (userInfoEl) _setFooterText(userInfoEl, footerEmail, 'v' + chrome.runtime.getManifest().version);
    return;
  }

  // `!status.snapshot && !status.error` is not defensive padding: bg/storage.js now SEEDS a bare
  // lastStatus ({recommendations_by_provider} only) for ChatGPT-only users, so their rec has a
  // container even though no Claude collection ever ran. The code below dereferences
  // status.snapshot.plan unconditionally, so a seeded status must render exactly like no status
  // at all rather than throw. Error statuses still fall through to the error branch below.
  if (!status || (!status.snapshot && !status.error)) {
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
      paintHealthy(indicator, statusText, status.serverWithheld || null, label || '', status.syncPaused === true);
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
      noteSurface('error_banner_soft');
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
    noteSurface('error_banner');
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
  // async now (it consults isServerSyncStalled); nothing awaits it, so catch here or a storage
  // hiccup becomes an unhandled rejection with the evaluation already claimed.
  maybeShowDashNudge().catch(() => {});

  // Claude recovered — reset the dismissed-notice flag so a future disconnection
  // surfaces the notice again.
  if (state.claudeNoticeDismissed) {
    state.claudeNoticeDismissed = false;
    chrome.storage.local.remove('claudeNoticeDismissed');
  }
  const dismissBtnOk = document.getElementById('error-dismiss');
  if (dismissBtnOk) dismissBtnOk.style.display = 'none';

  if (status.success && status.snapshot) {
    // Collection succeeded — but if the server sync was withheld (login-first gate / token lost)
    // nothing reached the dashboard. Same green ✓ for both states is the lie this branch used to
    // tell: the extension reads healthy while the dashboard is empty, and "reinstall" becomes the
    // user's only theory. Usage still renders below — flipping `status.success` instead would
    // skip this whole block and blank the popup for exactly the people who need it.
    const withheld = status.serverWithheld || null;
    const paused = status.syncPaused === true;
    const modeLabel = status.fetchMode === 'cookie' ? ` (${t('cookie_mode')})` : '';
    paintHealthy(indicator, statusText, withheld, `${formatTimeAgo(status.timestamp)}${withheld || paused ? '' : modeLabel}`, paused);
    // Show next collection schedule + boost status — but NOT while withheld: the countdown is a
    // promise that something will be sent, and nothing will be. "⏳ 59분 후" on a gated install
    // reads as "it will fix itself shortly", which is the opposite of what we need the user to
    // understand. Suppressing it also frees the width that was ellipsising the local-only label.
    if (!withheld && !paused) chrome.alarms.get('claude-usage-poll', (alarm) => {
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
      applyGaugeWindowLabels(s?.five_hour?.window_seconds, s?.seven_day?.window_seconds);
      // Render the reset line for each window BEFORE prediction (which may overwrite
      // it with the wait block). Pass hasWindow = util !== null: with a window and no
      // reset it shows the idle hint, and it clears a stale wait block; a valueless
      // gauge (util null) shows nothing.
      renderGaugeReset('5h', s.five_hour?.resets_at, util5h !== null);
      renderGaugeReset('7d', s.seven_day?.resets_at, util7d !== null);
      // Set-or-blank each value/fill unconditionally so a window that lost its
      // utilization (a seat can carry resets_at with util === null) drops its stale
      // %/bar too, not just the reset line. renderGaugePrediction self-hides on null.
      _setGaugeValue('5h', util5h);
      renderGaugePrediction('5h', _filteredHistory(), 'h5', util5h, s.five_hour?.resets_at, s.five_hour?.window_seconds);
      _setGaugeValue('7d', util7d);
      renderGaugePrediction('7d', _filteredHistory(), 'd7', util7d, s.seven_day?.resets_at, s.seven_day?.window_seconds);
    } else {
      // Restore gauge DOM that may have been destroyed by org switching
      _restoreGaugeHTML(gaugeSection);
      applyGaugeWindowLabels(s?.five_hour?.window_seconds, s?.seven_day?.window_seconds);
      util5h = s.five_hour?.utilization ?? null;
      util7d = s.seven_day?.utilization ?? null;
      // Base reset lines first (see the seat-based branch above): hasWindow = util
      // !== null drives the idle hint and clears a stale wait block; a valueless
      // gauge shows nothing. The 7d-null else below overwrites 7d with the no-7d
      // message.
      renderGaugeReset('5h', s.five_hour?.resets_at, util5h !== null);
      renderGaugeReset('7d', s.seven_day?.resets_at, util7d !== null);
      // 5h gauge
      _setGaugeValue('5h', util5h);
      renderGaugePrediction('5h', _filteredHistory(), 'h5', util5h, s.five_hour?.resets_at, s.five_hour?.window_seconds);

      // 7d gauge
      _setGaugeValue('7d', util7d);
      // Call prediction unconditionally (it self-hides on null util) so a stale 7d
      // prediction badge from a prior render is cleared, not just the value/reset.
      renderGaugePrediction('7d', _filteredHistory(), 'd7', util7d, s.seven_day?.resets_at, s.seven_day?.window_seconds);
      if (util7d === null) {
        // Plan without 7d data (Free, Team, etc.): replace the cleared reset line
        // with the plan-specific no-7d message (_setGaugeValue already blanked the %).
        const plan = (s.plan || '').toLowerCase();
        document.getElementById('gauge-7d-reset').textContent = plan.includes('free') ? t('free_no_7d') : t('team_no_7d');
      }
    }

    // If a window is already maxed out, overwrite the strip with a plain "limit reached — wait
    // until {reset}" message (overrides the collecting teaser renderGaugePrediction may have set).
    renderLimitReachedHeadline(util5h, s.five_hour?.resets_at, util7d, s.seven_day?.resets_at, s.five_hour?.window_seconds, s.seven_day?.window_seconds);

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
        // Hide (×) is handled in popup.js (stops propagation); guard defensively.
        if (e.target.id === 'extra-usage-hide') return;
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
      // hiddenExtraUsage: user-dismissed via the × button (restorable in Options).
      chrome.storage.local.get({ hiddenExtraUsage: false, ct_prev_extra_used: 0 }, (cfg) => {
        if (cfg.hiddenExtraUsage) { extraSection.style.display = 'none'; return; }
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
        const increasing = usedCents > (cfg.ct_prev_extra_used || 0);
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

    // Pass null when absent so a previously-shown renewal (e.g. before the
    // subscription was cancelled) is hidden rather than left stale.
    setRenewalDisplay(s.subscription?.renewal_date || null);

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
    // Skipped while the overview covers the detail view: #status-banner is display:none there,
    // and this runs on every lastStatus write during a collection run (it also costs a full
    // _filteredHistory() scan). enterDetail() -> selectOrg() re-renders the banner, so nothing
    // stale can survive the trip back.
    if (!isEnterprise && !isDetailHidden()) {
      renderStatusBanner(util5h, util7d, _filteredHistory(), s.five_hour?.resets_at, s.seven_day?.resets_at, s.five_hour?.window_seconds, s.seven_day?.window_seconds);
    }

    // Peak hours banner
    renderPeakBanner();

    // User info + version (last collection time removed to save footer space)
    _setFooterText(
      document.getElementById('user-info'),
      s.user_email !== 'unknown' ? s.user_email : '',
      'v' + chrome.runtime.getManifest().version,
    );
  }
}

// Footer note naming the Tuner account collected data actually lands in — shown ONLY when it
// differs from the provider account above it.
//
// Why it can differ, and why the difference is otherwise invisible: changing your provider
// account email (e.g. on claude.ai) makes the next snapshot carry the new address. The server
// rejects it against the old token (403 Email mismatch), the token is cleared, and the next
// cycle re-mints against the NEW address — so the install migrates to a different Tuner
// account on its own. The amber mismatch banner that could have explained this is REMOVED the
// moment collection succeeds again (bg/collect.js), so by the time the user looks, everything
// reads "fine" while the dashboard they open still shows the old account's data.
//
function _setFooterText(el, email, ver) {
  el.textContent = email ? `${email} | ${ver}` : ver;
}

/**
 * Which Tuner account this install's data lands in — shown whenever we know it.
 *
 * 🔴 THE PROVIDER ADDRESS IS NOT THE REFERENCE POINT. This used to compare the token identity
 * against whatever address the footer happened to be showing and stay silent unless they differed,
 * which encoded the pre-#702 model where the scraped provider email drove attribution. It no longer
 * does: every collector resolves through pickIngestIdentity() and the authenticated identity wins,
 * so the provider address is a LABEL (DESIGN-authenticated-attribution §7.1-2) and the token is the
 * fact. Comparing the fact against the label to decide whether to state the fact hid it in the two
 * cases that matter most:
 *
 *   - provider address not known yet (before the first collection, or a provider that never
 *     exposes one) → `!provider` short-circuited FIRST, so a user who had just signed in was told
 *     nothing at all about which account they signed in as;
 *   - addresses equal → silent, so nothing ever named the Tuner login. The footer shows *an*
 *     address, but never says it is the one to sign in to the dashboard with.
 *
 * Asking only `sync` collapses those into one sentence and drops the DOM-read workaround the old
 * comparison needed (it had to read the footer's own dataset because _updateUICore's six early
 * returns disagree about footer precedence — a problem that only existed because of the compare).
 */
export function renderSyncAccountNote() {
  const el = document.getElementById('sync-account-note');
  if (!el) return;
  const sync = state.syncEmail;
  if (!sync) {
    // Not signed in (gated). The login CTA already explains this; repeating it here is noise.
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = t('sync_account_note', sync);
  // 🔴 ADDITIVE, never a replacement. The comparison that used to live here was removed because it
  // short-circuited on an unknown provider address and went silent when the two matched — so a
  // user who had just signed in was told nothing at all. The sentence above now always names the
  // Tuner login; this only APPENDS when there is a real difference to report.
  //
  // WHY IT IS BACK. A fresh install mints its token before the extension has collected anything,
  // so `collecting_email` is absent, the server's mismatch check never runs, and nobody is asked
  // (live 2026-08-30: reinstall + an existing browser session did exactly this). Since the token
  // is already issued by the time the provider account becomes known, the only honest move left
  // is to say what happened — after the fact, where the user can see both addresses.
  if (state.providerEmail && state.providerEmail.toLowerCase() !== String(sync).toLowerCase()) {
    const warn = document.createElement('div');
    warn.style.cssText = 'margin-top:3px;color:var(--text-muted)';
    warn.textContent = t('sync_account_provider_note', state.providerEmail);
    el.appendChild(warn);
  }
  el.classList.remove('hidden');
}

/**
 * Renders the "this extension is too old to sync" banner. Set by bg/upgrade-gate.js when the
 * server answers an ingest POST with 426 upgrade_required (MIN_INGEST_VERSION gate); the block
 * record self-clears the moment the extension version changes, so this banner disappears on its
 * own once the update lands — no dismiss button, and none wanted: dismissing would restore
 * exactly the silent death this whole feature exists to prevent, and there is no "later" state
 * worth offering when nothing is reaching the server in the meantime.
 *
 * Reuses getUpgradeBlock() rather than reading `upgradeBlocked` directly so the version-staleness
 * rule (the recovery path) has ONE implementation — a popup that decided for itself when the
 * record was stale would be a second, drift-prone copy of the recovery contract.
 */
export async function renderUpgradeWarning() {
  const banner = document.getElementById('upgrade-warn');
  if (!banner) return;
  if (!(await getUpgradeBlock())) { banner.classList.add('hidden'); return; }
  document.getElementById('upgrade-warn-title').textContent = t('upgrade_required_title');
  document.getElementById('upgrade-warn-msg').textContent = t('upgrade_required_msg');
  document.getElementById('upgrade-warn-link').textContent = t('upgrade_required_link');
  document.getElementById('upgrade-warn-hint').textContent = t('upgrade_required_hint');
  banner.classList.remove('hidden');
  noteSurface('upgrade_warning');
}

// Renders the amber "Claude account email mismatch" banner from storage.
// Set by bg/collect.js when a Claude snapshot is rejected with 403 (the claude.ai
// account email ≠ the Tuner login bound to the ext_token), cleared on the next
// ★ auto-move notice (#966). The server stops sending `pin_move` once the move is
// acknowledged, and applyPinMoveState clears the record then — so this renders only while
// there really is something unacknowledged to say.
//
// 🔴 Explain-only. Undoing means writing primary_org_uuid, and every /api/me/* route is
// session/Google-only (it rejects ext_token, #745), so the popup links to the dashboard
// instead of offering a button it cannot honour.
export async function renderPinMoveNotice() {
  const banner = document.getElementById('pin-move-warn');
  if (!banner) return;
  const { pinMoveServer = null, pinMoveDismissedAt = null } =
    await chrome.storage.local.get({ pinMoveServer: null, pinMoveDismissedAt: null });
  // Hide first: a record cleared since the last popup open must not leave the banner up.
  banner.classList.add('hidden');
  if (!pinMoveServer || !pinMoveServer.movedAt) return;
  // Dismissal is compared against THIS move's timestamp, so a LATER move speaks again.
  if (pinMoveDismissedAt === pinMoveServer.movedAt) return;
  // 🔴 No age gate here, unlike the dashboard. The SERVER owns this notice's lifetime — it
  // stops sending `pin_move` the moment the move is acknowledged, and applyPinMoveState clears
  // the record then. Adding a second, client-side expiry would silence a notice the server is
  // still actively asserting, and the user would never learn why their plan changed.

  document.getElementById('pin-move-title').textContent = t('pin_move_title');
  document.getElementById('pin-move-msg').textContent = t('pin_move_msg');
  document.getElementById('pin-move-link').textContent = t('pin_move_open_dash');
  document.getElementById('pin-move-hint').textContent = t('pin_move_hint');
  banner.classList.remove('hidden');
  noteSurface('pin_move');

  const dismiss = document.getElementById('pin-move-dismiss');
  if (dismiss) {
    // 🔴 Carry the RENDERED move on the element, not in the listener's closure. The listener is
    // bound once (dataset.bound), so a closure would freeze the FIRST render's value and a
    // later click would dismiss the wrong move — either acknowledging one the user never saw,
    // or failing to silence the one they did. Re-stamped on every render; read at click time.
    dismiss.dataset.movedAt = pinMoveServer.movedAt;
    if (!dismiss.dataset.bound) {
      dismiss.dataset.bound = '1';
      dismiss.addEventListener('click', async () => {
        banner.classList.add('hidden');
        await chrome.storage.local.set({ pinMoveDismissedAt: dismiss.dataset.movedAt || null });
      });
    }
  }
}

// successful Claude collection. Dismissable; re-arms when a newer mismatch occurs.
export async function renderEmailMismatchWarning() {
  const banner = document.getElementById('claude-email-warn');
  if (!banner) return;
  const { claudeEmailMismatch = null, claudeEmailMismatchDismissedTs = 0, claudeAliasLink = null } =
    await chrome.storage.local.get({ claudeEmailMismatch: null, claudeEmailMismatchDismissedTs: 0, claudeAliasLink: null });

  // If this same Claude email is already linked, the "linked" box (renderClaudeLinkStatus)
  // owns the UI — don't also show the "not collecting, link it" banner (contradictory).
  const alreadyLinked = claudeAliasLink && claudeEmailMismatch
    && claudeAliasLink.claudeEmail === claudeEmailMismatch.claudeEmail;
  const active = claudeEmailMismatch && claudeEmailMismatch.ts > claudeEmailMismatchDismissedTs && !alreadyLinked;
  if (!active) { banner.classList.add('hidden'); return; }

  const email = claudeEmailMismatch.claudeEmail;
  document.getElementById('email-warn-title').textContent = t('email_mismatch_title');
  document.getElementById('email-warn-msg').textContent =
    email ? t('email_mismatch_msg', email) : t('email_mismatch_msg_noemail');
  document.getElementById('email-warn-link').textContent = t('open_claude');
  document.getElementById('email-warn-hint').textContent = t('email_mismatch_hint');
  banner.classList.remove('hidden');
  noteSurface('email_mismatch');

  const dismiss = document.getElementById('email-warn-dismiss');
  if (dismiss && !dismiss.dataset.bound) {
    dismiss.dataset.bound = '1';
    dismiss.addEventListener('click', async () => {
      banner.classList.add('hidden');
      await chrome.storage.local.set({ claudeEmailMismatchDismissedTs: Date.now() });
    });
  }

  // Cross-email link (step C): when we know the claude.ai account email, offer a
  // self-service link — email a code to that account (proving ownership), then the
  // client substitutes user_email so ingest is accepted. Only shown when the email
  // is known (needed to send the challenge and store the local mapping).
  const linkBlock = document.getElementById('email-link-block');
  if (linkBlock) {
    if (email) { linkBlock.classList.remove('hidden'); _wireEmailLink(email); }
    else linkBlock.classList.add('hidden');
  }
}

function _linkCfg() {
  return new Promise(r =>
    chrome.storage.sync.get({ serverUrl: CT_CONFIG.DEFAULT_SERVER_URL, apiKey: CT_CONFIG.DEFAULT_API_KEY }, r)
  );
}

// Persist the verified mapping and nudge an immediate collection so the very next
// snapshot carries the substituted (canonical) user_email and is accepted.
// Returns true when the link was stored and a reload is scheduled (caller should
// keep its spinner running until the page swaps), false on failure.
async function _finishEmailLink(claudeEmail, canonicalEmail, status) {
  if (!canonicalEmail) { status.textContent = t('email_link_err') || 'Could not link. Please try again.'; return false; }
  await chrome.storage.local.set({ claudeAliasLink: { claudeEmail, canonicalEmail } });
  await chrome.storage.local.remove('claudeEmailMismatch');
  status.textContent = t('email_link_success') || 'Linked — Claude usage will start syncing shortly.';
  chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' }).catch(() => {});
  // Short delay: keep the caller's spinner on until this reload swaps the page, so
  // it doesn't stop and flash the button back to normal before refreshing.
  setTimeout(() => location.reload(), 400);
  return true;
}

// Wires the request/verify buttons for the cross-email link flow. Idempotent:
// listeners are bound once per element (dataset.bound), safe to call on every render.
function _wireEmailLink(claudeEmail) {
  const stepReq = document.getElementById('email-link-step-request');
  const stepVer = document.getElementById('email-link-step-verify');
  const status = document.getElementById('email-link-status');
  const codeInput = document.getElementById('email-link-code');
  const sendBtn = document.getElementById('email-link-send');
  const verifyBtn = document.getElementById('email-link-verify');
  if (!sendBtn || !verifyBtn) return;

  sendBtn.textContent = t('email_link_cta') || 'Link this Claude account';
  verifyBtn.textContent = t('email_link_verify') || 'Verify & link';
  codeInput.placeholder = t('email_link_code_ph') || '6-digit code';

  if (!sendBtn.dataset.bound) {
    sendBtn.dataset.bound = '1';
    sendBtn.addEventListener('click', async () => {
      sendBtn.disabled = true; sendBtn.classList.add('spinning'); status.textContent = '';
      const restore = () => { sendBtn.disabled = false; sendBtn.classList.remove('spinning'); };
      try {
        const cfg = await _linkCfg();
        const res = await _authedFetch(cfg, cfg.serverUrl + '/api/auth/claude-link/request', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claude_email: claudeEmail }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.verified) {
          // Already verified → _finishEmailLink reloads; keep the spinner until then.
          if (!await _finishEmailLink(claudeEmail, data.canonical_email, status)) restore();
        } else if (res.ok) {
          stepReq.classList.add('hidden');
          stepVer.classList.remove('hidden');
          status.textContent = t('email_link_sent', claudeEmail) || `Verification code sent to ${claudeEmail}.`;
          codeInput.focus();
          restore();
        } else if (res.status === 409) {
          status.textContent = t('email_link_err_claimed') || 'This Claude account is linked to a different account.';
          restore();
        } else if (res.status === 401) {
          status.textContent = t('email_link_err_auth') || 'Please sign in again first.';
          restore();
        } else {
          status.textContent = t('email_link_err') || 'Could not send the code. Please try again.';
          restore();
        }
      } catch {
        status.textContent = t('email_link_err') || 'Could not send the code. Please try again.';
        restore();
      }
    });
  }

  if (!verifyBtn.dataset.bound) {
    verifyBtn.dataset.bound = '1';
    const doVerify = async () => {
      if (verifyBtn.disabled) return; // guard against Enter double-submit
      const code = (codeInput.value || '').trim();
      if (!/^\d{6}$/.test(code)) { status.textContent = t('email_link_err_code') || 'Enter the 6-digit code.'; return; }
      verifyBtn.disabled = true; verifyBtn.classList.add('spinning'); status.textContent = '';
      const restore = () => { verifyBtn.disabled = false; verifyBtn.classList.remove('spinning'); };
      try {
        const cfg = await _linkCfg();
        const res = await _authedFetch(cfg, cfg.serverUrl + '/api/auth/claude-link/verify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claude_email: claudeEmail, code }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.verified) {
          // Success → _finishEmailLink reloads; keep the spinner on until the page
          // swaps so it doesn't stop and flash the button back before refreshing.
          if (!await _finishEmailLink(claudeEmail, data.canonical_email, status)) restore();
        } else {
          status.textContent = t('email_link_err_invalid') || 'Invalid or expired code. Request a new one.';
          restore();
        }
      } catch {
        status.textContent = t('email_link_err_invalid') || 'Invalid or expired code. Request a new one.';
        restore();
      }
    };
    verifyBtn.addEventListener('click', doVerify);
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerify(); });
  }
}

// Renders the "linked" state (step C) when a verified cross-email link exists in
// storage, with a self-service unlink button. Idempotent (dataset.bound).
export async function renderClaudeLinkStatus() {
  const box = document.getElementById('claude-link-linked');
  if (!box) return;
  const { claudeAliasLink = null } = await chrome.storage.local.get({ claudeAliasLink: null });
  // Toggle style.display directly: the box carries an inline display, which would
  // override the .hidden class (no !important), so .hidden can't hide it.
  if (!claudeAliasLink || !claudeAliasLink.claudeEmail) { box.style.display = 'none'; return; }

  const claudeEmail = claudeAliasLink.claudeEmail;
  document.getElementById('claude-link-linked-text').textContent =
    t('email_link_status', claudeEmail) || `Claude account ${claudeEmail} linked.`;
  const unlinkBtn = document.getElementById('claude-link-unlink');
  unlinkBtn.textContent = t('email_link_unlink') || 'Unlink';
  box.style.display = 'flex';

  if (!unlinkBtn.dataset.bound) {
    unlinkBtn.dataset.bound = '1';
    unlinkBtn.addEventListener('click', async () => {
      // `.spinning` overlays a centered spinner and makes the text transparent (its
      // space is kept), so the button shows a spinner without resizing.
      unlinkBtn.disabled = true; unlinkBtn.classList.add('spinning');
      const textEl = document.getElementById('claude-link-linked-text');
      // Restore the button (used only on failure — on success the spinner keeps
      // running until the reload replaces the page, so it never flashes back).
      const restore = () => { unlinkBtn.disabled = false; unlinkBtn.classList.remove('spinning'); };
      try {
        const cfg = await _linkCfg();
        const res = await _authedFetch(cfg, cfg.serverUrl + '/api/auth/claude-link', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claude_email: claudeEmail }),
        });
        if (!res.ok) {
          // Server delete failed (e.g. 401 expired token). Keep the local mapping so
          // the user can retry, rather than silently diverging from the server row.
          textEl.textContent = t('email_link_unlink_err') || 'Could not unlink. Please try again.';
          restore();
          return;
        }
        // Clear local mapping + any stale mismatch state, then reload. The spinner
        // stays on until the reload swaps the page (no awkward gap where it stops
        // and the button flashes back before refreshing). Short delay lets the
        // MANUAL_COLLECT message dispatch before the popup context tears down.
        await chrome.storage.local.remove(['claudeAliasLink', 'claudeEmailMismatch', 'claudeEmailMismatchDismissedTs']);
        chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' }).catch(() => {});
        setTimeout(() => location.reload(), 250);
      } catch {
        textEl.textContent = t('email_link_unlink_err') || 'Could not unlink. Please try again.';
        restore();
      }
    });
  }
}
