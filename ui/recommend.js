// Recommendation card, plan fitness matrix, review nudge, and dashboard nudge for the popup.
// Leaf domain (does not call org-selector/prediction). Imports shared state + selectors, pure
// helpers, and the auth fetch wrapper; i18n `t` and CT_CONFIG are globals from classic scripts.
import { state, _isNonClaudePrimarySelected } from './state.js';
import { applyCollapseState } from './collapsible.js';
import { escHtml, _fmIcon, dashboardUrl, recType, planDisplayName } from './util.js';
import { _authedFetch } from './auth.js';
import { isServerSyncStalled } from '../bg/server-reach.js';
import { recDismissActive } from '../bg/rec-dismiss.js';

const _planApiToLabel = { pro_monthly: 'Pro', max_5x_monthly: 'Max 5x', max_20x_monthly: 'Max 20x' };

// Normalize a plan value (server canonical label like "Max 20x" or api id like "max_20x_monthly")
// to a known canonical label, or null when absent/unrecognized. Returning null for unknown
// strings means the stale-plan guard only fires on a CONFIDENT mismatch (both sides are known
// labels and differ) — an unrecognized/new tier never causes a valid rec to be suppressed.
// ChatGPT tiers are included so the guard actually fires for ChatGPT recs too. 'Pro' is shared
// with Claude, which is harmless: both sides of a comparison always come from the same org, so a
// ChatGPT 'Pro' is only ever compared against another ChatGPT plan.
const _KNOWN_PLANS = ['Free', 'Pro', 'Team Standard', 'Team Premium', 'Max 5x', 'Max 20x', 'Enterprise',
  'Go', 'Plus', 'Pro 5x', 'Pro 20x', 'Team', 'Business'];
const _canonPlan = (p) => {
  if (p == null) return null;
  const v = _planApiToLabel[p] || p;
  return _KNOWN_PLANS.includes(v) ? v : null;
};

// === REC PENDING SUPPRESSION: BEGIN (pinned by test/rec-pending-suppress-guard.mjs) ===
// Suppress a rec the user has ALREADY acted on. `pendingPlan` must come from the SAME provider as
// `rec` — see the caller note in ui/org-selector.js.
//
// 🔴 Both sides go through _canonPlan(). The two providers hand us the pending plan in DIFFERENT
// shapes: Claude stores an API id (`max_5x_monthly`, from subscription.pending_plan) and ChatGPT
// stores an already-display label (`Plus`, from bg/collect-chatgpt.js). The old comparison did a
// bare `_planApiToLabel[pendingPlan]` lookup, which is an API-id→label map — so a ChatGPT 'Plus'
// missed it and returned undefined, and the rec was never suppressed even when the right value was
// passed in. Canonicalizing both sides accepts either shape.
//
// A null canon means "unrecognized tier", NOT "no pending change" — requiring `pendingCanon` to be
// truthy keeps two unknown strings from comparing equal (null === null) and suppressing a valid rec.
export function _shouldSuppressRec(rec, pendingPlan) {
  const recTo = rec.to_plan || rec.toPlan;
  // The user's own "not now" / "don't show again", for as long as the SERVER said it lasts
  // (bg/rec-dismiss.js). Without this the card is only hidden until the popup is reopened (#1004).
  // Claude-scoped via the same `rec.provider || 'claude'` convention bg/rec-notice.js uses: the two
  // dismiss buttons refuse to run for any other provider, so their record must not silence one.
  if ((rec.provider || 'claude') === 'claude' && recDismissActive(state.recDismiss)) return true;
  // Suppress if same as just-executed plan change in this session
  if (state.planChangedTo && recTo === state.planChangedTo) return true;
  // Suppress if recommended plan matches an already scheduled pending plan
  const pendingCanon = _canonPlan(pendingPlan);
  if (pendingCanon && _canonPlan(recTo) === pendingCanon) return true;
  return false;
}
// === REC PENDING SUPPRESSION: END ===

const FM_CACHE_TTL = 8 * 3600000; // 8h
const FM_WINDOWS = ['24h', '7d', '14d'];

function renderFitnessMatrix(data) {
  const section = document.getElementById('fitness-section');
  const content = document.getElementById('fm-content');
  if (!section || !content || !data || !data.plans || !data.plans.length) {
    if (section) section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  applyCollapseState(section, 'fitness');

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
      html += '<span class="fm-badge fm-unknown">' + t('fm_ref') + '</span>';
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
  html += '</div><a href="' + dashboardUrl(state.selectedOrgId) + '" target="_blank">' + t('fm_reason') + ' →</a></div>';
  content.innerHTML = html;
}

export async function loadFitnessMatrix() {
  const section = document.getElementById('fitness-section');
  if (!section) return;
  // Non-Claude org selected: never show fitness matrix
  if (_isNonClaudePrimarySelected()) { section.classList.add('hidden'); return; }

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

export function checkReviewNudge() {
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
    if (state.currentSnapshot) {
      const maxUtil = Math.max(
        state.currentSnapshot.five_hour?.utilization ?? 0,
        state.currentSnapshot.seven_day?.utilization ?? 0
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

export function showRecFeedback(recType) {
  if (!recType) return;
  chrome.storage.local.get({ ['ct_rec_fb_' + recType]: false }, (r) => {
    if (r['ct_rec_fb_' + recType]) return;
    const toast = document.getElementById('rec-feedback-toast');
    if (!toast) return;
    const actions = document.getElementById('rft-actions');
    const question = document.getElementById('rft-question');
    const share = document.getElementById('rft-share');
    const closeBtn = document.getElementById('rft-close');
    const yesBtn = document.getElementById('rft-yes');
    const noBtn = document.getElementById('rft-no');
    if (!actions || !question || !share || !closeBtn || !yesBtn || !noBtn) return;
    toast.style.display = 'block';
    toast.style.position = 'relative';
    actions.style.display = 'flex';
    question.style.display = 'block';
    share.style.display = 'none';
    closeBtn.onclick = () => {
      toast.style.display = 'none';
      sendGAEvent('rec_toast_close');
    };
    question.textContent = t('rec_fb_question');
    yesBtn.textContent = '👍 ' + t('rec_fb_yes');
    noBtn.textContent = t('rec_fb_no');

    const autoHide = setTimeout(() => { toast.style.display = 'none'; }, 10000);

    yesBtn.onclick = () => {
      clearTimeout(autoHide);
      sendGAEvent('rec_feedback_yes');
      chrome.storage.local.set({ ['ct_rec_fb_' + recType]: true });
      actions.style.display = 'none';
      question.style.display = 'none';
      share.style.display = 'block';
      const shareText = document.getElementById('rft-share-text');
      const review = document.getElementById('rft-review');
      const twitter = document.getElementById('rft-twitter');
      const copy = document.getElementById('rft-copy');
      if (shareText) shareText.textContent = t('rec_fb_share');
      if (review) { review.textContent = t('rec_fb_review'); review.onclick = () => { sendGAEvent('rec_share_review'); }; }
      if (twitter) twitter.href = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent('ClaudeTuner helped me optimize my Claude AI plan! Try it free: https://claudetuner.com #Claude #ClaudeTuner');
      if (copy) { copy.textContent = t('rec_fb_copy'); copy.onclick = () => { navigator.clipboard.writeText('https://claudetuner.com'); copy.textContent = 'Copied!'; }; }
      setTimeout(() => { toast.style.display = 'none'; }, 15000);
    };

    noBtn.onclick = () => {
      clearTimeout(autoHide);
      sendGAEvent('rec_feedback_no');
      chrome.storage.local.set({ ['ct_rec_fb_' + recType]: true });
      toast.style.display = 'none';
    };
  });
}

// provider: which org's rec this is. Plan-change EXECUTION is Claude-only (bg/plan.js drives
// claude.ai's subscription API), so a non-Claude rec renders as advice with no action button.
export function _renderRecommendation(rec, provider, basisPlan) {
  if (!rec) return;
  const recProvider = provider || rec.provider || 'claude';
  state.recProvider = recProvider;
  const recEl = document.getElementById('recommendation');
  if (!recEl) return;

  // insufficient_data is a distinct state from "adequate": the utilization signal is missing, so
  // there is nothing to advise. Hide the row entirely rather than implying the plan is a good fit
  // — and never let it reach the actionable branch (docs/SPEC-chatgpt-plan-rec.md).
  // Read via recType(): this rec arrives from the extension shim, which moves `type` to
  // `rec_type` for exactly the to_plan-less recs — a bare rec.type is undefined here.
  if (recType(rec) === 'insufficient_data') {
    const row = document.getElementById('recommendation-row');
    if (row) row.classList.add('hidden');
    const detail = document.getElementById('smart-rec-detail');
    if (detail) detail.classList.add('hidden');
    return;
  }

  // Stale-plan guard: a cached actionable rec whose basis plan no longer matches the
  // user's current plan (e.g. they changed plans since the rec was computed; server
  // 24h-throttle + snapshot dedup can leave the prior rec cached) must NOT be shown —
  // otherwise e.g. a Max 20x user sees a stale "upgrade to Max 5x" card. Only suppress
  // on a confident mismatch (both sides resolve to known canonical labels and differ);
  // if either is unknown we render as before (no regression).
  // ⚠️ The basis plan must come from the SAME org/provider the rec was computed for.
  // state.currentPlan is refreshed from the PRIMARY (Claude) snapshot in render.js and is NOT
  // updated when a non-Claude org is selected — org-selector only swaps the displayed plan text.
  // Comparing a ChatGPT rec against it made a Claude Pro + ChatGPT Plus user's real
  // Plus→Go recommendation look "stale" ('Plus' !== 'Pro'), silently degrading it to
  // "current plan ok". Callers that render a specific org pass that org's plan explicitly;
  // the Claude/primary path passes nothing and keeps the original behaviour.
  const _recFromPlan = _canonPlan(rec.from_plan || rec.fromPlan);
  const _curPlan = _canonPlan(basisPlan != null ? basisPlan : state.currentPlan);
  const _planStale = _recFromPlan != null && _curPlan != null && _recFromPlan !== _curPlan;
  if (_planStale) {
    recEl.textContent = t('current_plan_ok');
    recEl.style.color = 'var(--text-primary)';
    const detail = document.getElementById('smart-rec-detail');
    if (detail) detail.classList.add('hidden');
    return;
  }

  const _type = recType(rec);
  const isActionable = (_type === 'upgrade' || _type === 'downgrade') && rec.to_plan;
  if (isActionable) {
    const isUpgrade = _type === 'upgrade';
    // Non-Claude recs (ChatGPT) surface the target plan in the row itself
    // ("Plus로 다운그레이드 추천"): their #smart-rec-detail carries no working execute/dismiss
    // buttons and no cost line, only a reason that duplicates the target — so the row is the only
    // place the plan should appear. Claude keeps the plain title + its actionable detail block.
    let _target = null;
    if (recProvider !== 'claude' && rec.to_plan) {
      const _label = planDisplayName(rec.to_plan, recProvider);
      _target = _label ? _label.charAt(0).toUpperCase() + _label.slice(1) : null;
    }
    const _recColor = isUpgrade
      ? (rec.urgency === 'urgent' ? '#dc2626' : '#d97706')
      : '#059669';
    if (_target) {
      // Highlight the target plan as a filled chip so it stands out in the row
      // ("[Plus] 으로 다운그레이드 추천"). Split the localized template on a private-use sentinel
      // substituted for {0}, then rebuild with an escaped chip span (template + target both escaped).
      const SENT = String.fromCharCode(0xE000); // unique sentinel, never in i18n text
      const _parts = t(isUpgrade ? 'opt_upgrade_to' : 'opt_downgrade_to', SENT).split(SENT);
      const _chip = '<span style="background:' + _recColor + ';color:#fff;padding:0 6px;border-radius:4px;font-weight:700">' + escHtml(_target) + '</span>';
      let _recHtml = _parts.map(escHtml).join(_chip);
      // ChatGPT plan changes can't be executed from the extension (no API, unlike Claude), so
      // append a link to ChatGPT's subscription page instead of a Claude-style execute button.
      if (recProvider === 'chatgpt') {
        _recHtml += ' <a href="https://chatgpt.com/#pricing" target="_blank" rel="noopener" style="color:' + _recColor + ';font-weight:600;white-space:nowrap">' + escHtml(t('rec_change_link')) + '</a>';
      }
      recEl.innerHTML = _recHtml;
    } else {
      recEl.textContent = t(isUpgrade ? 'opt_upgrade' : 'opt_downgrade');
    }
    recEl.style.color = _recColor;

    const detail = document.getElementById('smart-rec-detail');
    if (detail) {
      // Claude: show the actionable detail (reason + execute/dismiss buttons). Non-Claude: the
      // target plan is already in the row and the detail has no working buttons/cost — showing it
      // would only render a redundant reason line + empty padding, so hide it.
      if (recProvider === 'claude') detail.classList.remove('hidden');
      else detail.classList.add('hidden');
    }

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
      // Only Claude can be changed from here. Showing this button for a ChatGPT rec would fire a
      // claude.ai plan change from a ChatGPT recommendation — wrong provider, wrong plan.
      if (recProvider === 'claude') {
        btn.classList.remove('hidden');
        btn.textContent = t(isUpgrade ? 'opt_upgrade_btn' : 'opt_downgrade_btn', rec.to_plan);
        btn.style.background = isUpgrade ? '#d97706' : '#059669';
      } else {
        btn.classList.add('hidden');
      }
    }

    // Dismiss/mute persist through the Claude-only /api/snapshots/dismiss cooldown. The ChatGPT
    // engine has no dismiss state (getChatgptRecommendation), so for a ChatGPT/Gemini rec these
    // buttons were no-ops: clicking one showed a misleading "current plan ok" and the rec came
    // straight back on the next collection. Show them only where they actually work — like the
    // execute button above, which is already Claude-gated.
    const dismissBtn = document.getElementById('smart-rec-dismiss');
    const muteBtn = document.getElementById('smart-rec-mute');
    if (recProvider === 'claude') {
      if (dismissBtn) { dismissBtn.classList.remove('hidden'); dismissBtn.textContent = t('opt_dismiss'); }
      if (muteBtn) { muteBtn.classList.remove('hidden'); muteBtn.textContent = t('rec_mute'); }
    } else {
      if (dismissBtn) dismissBtn.classList.add('hidden');
      if (muteBtn) muteBtn.classList.add('hidden');
    }
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

    // Was an inline `rec.rec_type || rec.type` — the sprinkled form the shared helper replaces.
    const typeColors = { upgrade: '#d97706', downgrade: '#059669', high: '#ef4444', adequate: '#854d0e', good: 'var(--text-primary)', collecting: '#6b7280', nodata: '#6b7280' };
    recEl.style.color = typeColors[_type] || 'var(--text-primary)';
    const detail = document.getElementById('smart-rec-detail');
    if (detail) detail.classList.add('hidden');
  }
}

const DASH_NUDGE_MAX_SHOWS = 3;
const DASH_NUDGE_DAY_MS = 24 * 60 * 60 * 1000;
// 🔴 The cap used to be three POPUP OPENS with no clock, so it burned out in the first minutes
// after install — three opens takes no time at all. That is the worst possible timing for this
// audience: they are, by definition, people who have not yet found a reason to open the dashboard.
// The two gates below are what turn "3 shows" into "3 shows spread over about three weeks".
const DASH_NUDGE_MIN_AGE_MS = 3 * DASH_NUDGE_DAY_MS;                          // never on a fresh install
const DASH_NUDGE_GAP_MS = [7 * DASH_NUDGE_DAY_MS, 14 * DASH_NUDGE_DAY_MS];    // → ≈ D+3 / +10 / +24
// Rotate the wording: the same sentence three times is what gets tuned out fastest.
const DASH_NUDGE_KEYS = ['dash_nudge_paid', 'dash_nudge_paid_2', 'dash_nudge_paid_3'];

export async function maybeShowDashNudge() {
  if (state.dashNudgeEvaluated) return; // evaluate once per popup open
  // Claimed SYNCHRONOUSLY: two renders in the same tick must not both evaluate and both burn a
  // show. Handed back below if we bail on a server-block state.
  state.dashNudgeEvaluated = true;
  const el = document.getElementById('dash-nudge');
  if (!el) return;
  // Ask the ONE predicate that owns "is our data reaching the server". Naming states here is how
  // this check ended up incomplete three rounds running — see bg/server-reach.js.
  const stalled = await isServerSyncStalled();
  chrome.storage.local.get({
    dashNudge: { done: false, shows: 0, lastShownAt: 0 }, dashNudgeServer: null,
  }, (r) => {
    const st = (r && r.dashNudge) || { done: false, shows: 0, lastShownAt: 0 };
    if (st.done) return;
    // 🔴 Say NOTHING while this install cannot reach the server, and do not spend a show on it.
    // Two separate reasons, either one sufficient:
    //   - It would be a lie. "See your trends on the dashboard" points at data that stopped
    //     arriving; what they would find there is stale.
    //   - It competes with the one action that matters. The popup already renders the auth-blocked
    //     login CTA right above this, and a second, softer call to action next to it dilutes it.
    // Returning BEFORE the counter is touched means the nudge resumes intact once they recover,
    // rather than having burnt a rung on a day it could not have worked. (Cross-cutting review:
    // each feature was correct alone; only together did the popup end up saying both at once.)
    // 🔴 HAND THE EVALUATION BACK when we bail on a block state. Keeping it spent meant a popup
    // that was open when the user logged in could neither show nor retire the banner until it was
    // reopened — the one evaluation had been consumed by a state that is now gone. Giving it back
    // (rather than claiming it late) keeps the same-tick double-evaluation guard intact. (Codex.)
    if (stalled) { state.dashNudgeEvaluated = false; return; }
    const srv = r && r.dashNudgeServer;
    // No server verdict yet → stay quiet. Absence means "we don't know", and this banner tells the
    // user they are on a paid plan; saying that to a free user is worse than saying nothing.
    if (!srv || !srv.paid) return;
    // They opened the dashboard — on ANY device, which is the whole reason this fact comes from the
    // server. The nudge has served its purpose; retire it instead of waiting out the cap.
    if (!srv.neverVisited) { chrome.storage.local.set({ dashNudge: { ...st, done: true } }); return; }

    const now = Date.now();
    // 🔴 The trailing 'Z' is required, same as checkReviewNudge above: D1 `datetime()` renders UTC
    // with no timezone marker, so parsing it bare reads as LOCAL time and skews the age gate by up
    // to a day depending on the user's offset.
    const firstSeen = srv.firstSeenAt ? new Date(srv.firstSeenAt + 'Z').getTime() : 0;
    if (firstSeen && now - firstSeen < DASH_NUDGE_MIN_AGE_MS) return;   // too new to be nudged
    const shows = (st.shows || 0) + 1;
    const gap = DASH_NUDGE_GAP_MS[(st.shows || 0) - 1];
    if (st.lastShownAt && gap && now - st.lastShownAt < gap) return;    // not due yet

    const label = el.querySelector('[data-i18n]');
    if (label) {
      const key = DASH_NUDGE_KEYS[Math.min(shows, DASH_NUDGE_KEYS.length) - 1];
      label.setAttribute('data-i18n', key);
      label.textContent = t(key);
    }
    el.classList.remove('hidden');
    // Stop showing after the cap even if the user never interacts.
    chrome.storage.local.set({ dashNudge: { done: shows >= DASH_NUDGE_MAX_SHOWS, shows, lastShownAt: now } });
    const end = () => {
      el.classList.add('hidden');
      chrome.storage.local.set({ dashNudge: { done: true, shows, lastShownAt: now } });
    };
    const link = document.getElementById('dash-nudge-link');
    if (link) link.addEventListener('click', () => { // opens dashboard in a new tab
      chrome.storage.local.set({ dashNudge: { done: true, shows, lastShownAt: now } });
    });
    const close = document.getElementById('dash-nudge-close');
    if (close) close.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); end(); });
  });
}

