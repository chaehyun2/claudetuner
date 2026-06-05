// Recommendation card, plan fitness matrix, review nudge, and dashboard nudge for the popup.
// Leaf domain (does not call org-selector/prediction). Imports shared state + selectors, pure
// helpers, and the auth fetch wrapper; i18n `t` and CT_CONFIG are globals from classic scripts.
import { state, _isNonClaudePrimarySelected } from './state.js';
import { escHtml, _fmIcon } from './util.js';
import { _authedFetch } from './auth.js';

const _planApiToLabel = { pro_monthly: 'Pro', max_5x_monthly: 'Max 5x', max_20x_monthly: 'Max 20x' };

export function _shouldSuppressRec(rec, pendingPlan) {
  const recTo = rec.to_plan || rec.toPlan;
  // Suppress if same as just-executed plan change in this session
  if (state.planChangedTo && recTo === state.planChangedTo) return true;
  // Suppress if recommended plan matches already scheduled pending plan
  if (pendingPlan && recTo === _planApiToLabel[pendingPlan]) return true;
  return false;
}

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
  html += '</div><a href="https://claudetuner.com/dashboard" target="_blank">' + t('fm_reason') + ' →</a></div>';
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

export function _renderRecommendation(rec) {
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
    const typeColors = { upgrade: '#d97706', downgrade: '#059669', high: '#ef4444', adequate: '#854d0e', good: 'var(--text-primary)', collecting: '#6b7280', nodata: '#6b7280' };
    recEl.style.color = typeColors[recType] || 'var(--text-primary)';
    const detail = document.getElementById('smart-rec-detail');
    if (detail) detail.classList.add('hidden');
  }
}

const DASH_NUDGE_MAX_SHOWS = 3;
export function maybeShowDashNudge() {
  if (state.dashNudgeEvaluated) return; // evaluate once per popup open
  state.dashNudgeEvaluated = true;
  const el = document.getElementById('dash-nudge');
  if (!el) return;
  chrome.storage.local.get({ dashNudge: { done: false, shows: 0 } }, (r) => {
    const st = (r && r.dashNudge) || { done: false, shows: 0 };
    if (st.done) return;
    const shows = (st.shows || 0) + 1;
    el.classList.remove('hidden');
    // Stop showing after the cap even if the user never interacts.
    chrome.storage.local.set({ dashNudge: { done: shows >= DASH_NUDGE_MAX_SHOWS, shows } });
    const end = () => {
      el.classList.add('hidden');
      chrome.storage.local.set({ dashNudge: { done: true, shows } });
    };
    const link = document.getElementById('dash-nudge-link');
    if (link) link.addEventListener('click', () => { // opens dashboard in a new tab
      chrome.storage.local.set({ dashNudge: { done: true, shows } });
    });
    const close = document.getElementById('dash-nudge-close');
    if (close) close.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); end(); });
  });
}

