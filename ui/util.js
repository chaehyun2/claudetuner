// Pure leaf helpers shared across the popup UI.
// No module-level mutable state — only arguments + global i18n (`t`, `getLang` from i18n.js, a classic script).
// Extracted from popup.js (see refactor/popup-modular). Keep these dependency-free so any UI module can import them
// (the one import is ui/card-view/format.js, itself runtime-neutral — see below).

import * as cv from './card-view/format.js';

// ── Card-view compatibility wrappers (#2153) ──────────────────────────────────────────────────
// The display rules below (window labels, gauge colour, countdown, duration, time-ago) live in
// ui/card-view/format.js so the desktop app can bundle them without chrome/DOM/i18n.js. That
// module takes its words as an injected `labels` object; these wrappers keep the popup's original
// signatures and fill the labels from the global i18n `t`, so no call site changes.
// Every member reads `t` at CALL time — a language switch is picked up without rebuilding this.
const EXT_LABELS = Object.freeze({
  windowHours: (n) => t('window_hours', n),
  windowDays: (n) => t('window_days', n),
  usageWindow: (unit) => t('usage_window', unit),
  countdownSoon: () => t('countdown_soon'),
  durM: (m) => t('gauge_dur_m', m),
  durH: (h) => t('gauge_dur_h', h),
  durD: (d) => t('gauge_dur_d', d),
  durDH: (d, h) => t('gauge_dur_dhm', d, h),
  agoJustNow: () => t('ago_just_now'),
  agoMin: () => t('ago_min'),
  agoHour: () => t('ago_hour'),
  agoDay: () => t('ago_day'),
});
export function extLabels() { return EXT_LABELS; }

export function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Usage-window labels (#954) — rules and rationale in ui/card-view/format.js ──────────────────
export const formatWindowShort = cv.formatWindowShort;
export function windowUnitLabel(seconds) { return cv.windowUnitLabel(seconds, extLabels()); }
export function formatWindowLabel(seconds) { return cv.formatWindowLabel(seconds, extLabels()); }
// `fallbackKey` is the slot's static i18n key ('usage_5h' / 'usage_7d').
export function windowLabel(spanSeconds, fallbackKey) {
  return cv.windowLabel(spanSeconds, () => t(fallbackKey), extLabels());
}

/**
 * Write both detail-gauge labels from the reported spans. Lives here, not in a render module,
 * because THREE call sites need it and a second copy would drift: _updateUICore() (primary org),
 * selectOrg() (any selected org — the path a ChatGPT Free/Go user actually uses), and the
 * language-switch handler.
 *
 * 🔴 Call it AFTER _restoreGaugeHTML(). That reinstates popup.html's markup, whose spans carry
 * data-i18n="usage_5h"/"usage_7d", so a label written before it is discarded.
 *
 * 🔴 Both slots are written unconditionally, including the no-span case. _restoreGaugeHTML() is a
 * NO-OP when the gauge element already exists, so skipping the null case would carry org A's
 * "30일 사용률" onto org B on switch.
 *
 * Removing data-i18n is required (applyI18n() re-runs on language change and would restore the
 * static slot label), which is why the language-switch handler must call this itself.
 */
export function applyGaugeWindowLabels(span5, span7) {
  const set = (rowId, span, fallbackKey) => {
    const el = document.querySelector(`#gauge-row-${rowId} .gauge-label`);
    if (!el) return;
    el.textContent = windowLabel(span, fallbackKey);
    el.removeAttribute('data-i18n');
  };
  set('5h', span5 ?? null, 'usage_5h');
  set('7d', span7 ?? null, 'usage_7d');
}

// THE canonical way to read a recommendation's type. Every consumer must go through this —
// reading `rec.type` directly is a live bug, not a style preference.
//
// Why: the server ships the SAME rec in two shapes. getChatgptSmartRec() returns the raw spec
// shape with `type` intact, but everything that reaches the EXTENSION goes through
// formatForExtension() (worker/src/services/snapshot-service.ts), a back-compat shim for old
// popup builds that DELETES `type` and re-emits it as `rec_type` for every non-action rec.
// insufficient_data has no to_plan, so it always takes that branch and always arrives here as
// `rec_type`. A bare `rec.type` therefore yields undefined for exactly the recs the spec says
// must render NO card — `undefined !== 'insufficient_data'` passes every guard and shows the
// "data 부족" card to the users who must see nothing (docs/SPEC-chatgpt-plan-rec.md).
//
// The shim is NOT the thing to fix: old builds branch on `type` being present to choose their
// structured UI, so leaving `type` on a to_plan-less rec would make them render an actionable
// card with no action. The lossiness is deliberate and is pinned by test/chatgpt-rec-guard.mjs
// section 9. The client absorbs it — in ONE place, so the third consumer can't repeat it (this
// same bug already shipped once on the dashboard, commit 2ee04bf0, and was fixed only there).
export function recType(rec) {
  if (!rec) return null;
  return rec.type || rec.rec_type || null;
}

// Render the "renewal-group" row (next-billing date) shared by the base view
// (render.js) and the per-org selected view (org-selector.js). Pass a null/empty
// date to hide the row. Returns true when the row is shown. Single source of truth
// for the date formatting + urgency color so the two call sites can't drift.
export function setRenewalDisplay(renewalDate) {
  const renewalGroup = document.getElementById('renewal-group');
  const renewalEl = document.getElementById('renewal-date');
  if (!renewalDate || !renewalGroup || !renewalEl) {
    if (renewalGroup) renewalGroup.style.display = 'none';
    return false;
  }
  const d = new Date(renewalDate);
  const daysLeft = Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  renewalEl.textContent = `${d.getMonth() + 1}/${d.getDate()} (${daysLeft}${t('renewal_days_later')})`;
  renewalEl.style.color = daysLeft <= 3 ? '#ef4444' : (daysLeft <= 7 ? '#eab308' : '');
  renewalGroup.style.display = 'flex';
  return true;
}

// The "training data sharing ON" row (#privacy-row) — shared by render.js (Claude grove) and
// org-selector.js (Claude grove + ChatGPT training setting, #1889). Each provider has its OWN dismiss
// flag so hiding one provider's row never hides the other's; popup.js reads `dataset.provider` to know
// which flag the "hide" link sets.
export const PRIVACY_DISMISS_KEYS = Object.freeze({
  claude: 'hiddenPrivacyBanner',
  chatgpt: 'hiddenPrivacyBannerChatgpt',
});
const PRIVACY_SETTINGS = Object.freeze({
  claude: { url: 'https://claude.ai/settings/data-privacy-controls', titleKey: 'privacy_link_title' },
  chatgpt: { url: 'https://chatgpt.com/#settings/DataControls', titleKey: 'privacy_link_title_chatgpt' },
});
// Bumped by every show/hide so a dismiss-flag read that resolves after a later call (org switch) is dropped.
let _privacySeq = 0;

export function hidePrivacyRow() {
  _privacySeq++;
  const row = document.getElementById('privacy-row');
  if (row) row.classList.add('hidden');
}

/** User hid the row: remember it for the provider shown and drop any dismiss-flag read still in flight. */
export function dismissPrivacyRow() {
  const row = document.getElementById('privacy-row');
  if (!row) return;
  const key = PRIVACY_DISMISS_KEYS[row.dataset.provider] || PRIVACY_DISMISS_KEYS.claude;
  chrome.storage.local.set({ [key]: true });
  hidePrivacyRow();
}

export function showPrivacyRow(provider) {
  const cfg = PRIVACY_SETTINGS[provider];
  const row = document.getElementById('privacy-row');
  const val = document.getElementById('privacy-value');
  if (!cfg || !row || !val) { hidePrivacyRow(); return; }
  const seq = ++_privacySeq;
  row.dataset.provider = provider;
  val.textContent = t('privacy_on');
  val.href = '#';
  val.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: cfg.url }); };
  val.title = t(cfg.titleKey);
  const key = PRIVACY_DISMISS_KEYS[provider];
  chrome.storage.local.get({ [key]: false }, (st) => {
    if (seq !== _privacySeq) return;
    row.classList.toggle('hidden', !!st[key]);
  });
}

/**
 * TRUE when the provider answered and gave this org nothing to show.
 *
 * 🔴 SAME CONJUNCTION AS bg/sidebar-usage.js, and for the same reason: the stored `noUsage` flag
 * describes ONE response, while the values on screen are assembled from a snapshot and an org list
 * that different writers update at different times. Requiring the displayed windows to be empty
 * too means a stale or wrong flag can never put this notice over a working gauge — the failure
 * Codex reproduced three ways on the in-page widgets (#198).
 *
 * 🪤 The flag alone is NOT enough and the empty windows alone are NOT enough. Without the flag,
 * "both null" also describes a cold start, a failed fetch, and an extra ChatGPT workspace — saying
 * "the provider withheld it" about any of those is a false statement, not a missing one.
 */
/**
 * TRUE when the extra-usage section is actually drawn. Exported so the notice below and the two
 * render sites ask the SAME question — an "is anything on screen" test that disagrees with what is
 * on screen is the bug it exists to prevent.
 */
export function extraUsageShown(eu) {
  return !!(eu && eu.is_enabled && (eu.used_credits || 0) > 0);
}

/**
 * The sentence to show when usage was withheld — named by plan when we have one.
 *
 * 🔴 THE PLAN NAMES THE ACCOUNT; IT DOES NOT DECIDE ANYTHING. The branch is still
 * `usageWithheldForDisplay`, which reads the observation and the displayed values and never looks
 * at the plan — so if Anthropic restores Free and withholds from some other tier tomorrow, the
 * same sentence appears with THAT tier's name and nothing has to change.
 *
 * 🪤 Why name it at all, when the first cut deliberately did not: "이 계정의" says nothing, and a
 * user reads it as "something is wrong with MY account" — the cousin of the failure this whole
 * change exists to stop, where a provider policy reads as our defect. The popup already prints the
 * same label two rows below ("현재 플랜"), so this is a word we are ALREADY standing behind.
 *
 * A missing or unknown plan falls back to the neutral sentence rather than inventing a name.
 */
export function usageWithheldText(org) {
  // 🔴 `noUsagePlan`, not `org.plan`. The org's plan field is not refreshed by a collection, so on
  // a boost/gated/paused install it can be a tier the account left months ago — and this sentence
  // would then name it. `noUsagePlan` is written at the same moment as the observation itself.
  const plan = org && org.noUsagePlan;
  const p = typeof plan === 'string' ? plan.trim() : '';
  if (!p || p.toLowerCase() === 'unknown') return t('usage_withheld');
  return t('usage_withheld_plan', p);
}

/**
 * TRUE when the withheld notice may also say WHEN and FOR WHOM it started.
 *
 * Anthropic stopped serving Claude Free accounts any usage window on 2026-08-21 17:00 UTC
 * (#1391) — unannounced, and users read the bare notice as "my account is broken" (inquiry #208).
 * The tooltip that explains it names that plan and that date, so it may only appear on a Free
 * observation: on any other tier the same sentence would state a false date.
 *
 * 🔴 THIS NEVER DECIDES WHETHER THE NOTICE APPEARS. That is still `usageWithheldForDisplay`,
 * which reads the response, not the plan. This only decides whether the notice gets the extra
 * explanation. Pass `org.noUsagePlan`, not `org.plan` (see usageWithheldText).
 *
 * Pure and DOM-free: the service worker imports it (bg/sidebar-usage.js) so the in-page widgets
 * apply the same rule without restating it.
 */
export function usageWithheldIsFreeCutover(plan) {
  return typeof plan === 'string' && plan.trim().toLowerCase() === 'free';
}

/**
 * Append the ⓘ explanation to an element already holding usageWithheldText(org). No-op unless
 * the observation is a Free one. Idempotent only in the sense every caller needs: the element's
 * text is rewritten (textContent) on every render, which removes a previous icon first.
 */
export function appendUsageWithheldTip(el, org) {
  if (!el || !usageWithheldIsFreeCutover(org && org.noUsagePlan)) return;
  const tip = t('usage_withheld_free_tip');
  const icon = document.createElement('span');
  icon.className = 'withheld-tip';
  icon.textContent = 'ⓘ';
  icon.title = tip;
  icon.setAttribute('aria-label', tip);
  icon.tabIndex = 0;
  el.append(' ', icon);
}

export function usageWithheldForDisplay(org, util5h, util7d, extraUsage) {
  // 🔴 EXTRA USAGE COUNTS AS SOMETHING TO SHOW. Without this the popup printed "Claude isn't
  // providing usage for this account" directly above a working spend gauge — the account has null
  // windows AND live credits, which is a real combination, not a stale-flag artefact (Codex).
  // The sidebar builder already had this half; the popup did not.
  if (extraUsageShown(extraUsage)) return false;
  return !!(org && org.noUsage) && util5h == null && util7d == null;
}

export function _fmIcon(level) {
  const map = {
    exceeded:     { cls: 'fm-exceeded', label: 'fm_lv_exceeded', icon: '✕' },
    tight:        { cls: 'fm-tight',    label: 'fm_lv_tight',    icon: '✓' },
    fit:          { cls: 'fm-fit',      label: 'fm_lv_fit',      icon: '✓' },
    overspend:    { cls: 'fm-overspend',label: 'fm_lv_overspend',icon: '↓' },
    nodata:       { cls: 'fm-unknown',  label: 'fm_nodata',      icon: '—' },
    collecting:   { cls: 'fm-unknown',  label: 'fm_collecting',  icon: '…' },
    insufficient: { cls: 'fm-unknown',  label: 'fm_insufficient',icon: '—' },
  };
  return map[level] || map.nodata;
}

export const gaugeColor = cv.gaugeColor;
export function formatCountdown(resetAt) { return cv.formatCountdown(resetAt, extLabels()); }

// Localized day word for an instant relative to today: 어제/오늘/내일 (±1 day),
// otherwise the "M/D(요일)" date. Near-term times read far better as "오늘/내일"
// than as a date — and it dissolves the "different date on each row" problem when
// a 5h window's limit-hit and reset straddle midnight.
function relativeDay(d, lang) {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const dDay = new Date(d); dDay.setHours(0, 0, 0, 0);
  const days = Math.round((dDay.getTime() - midnight.getTime()) / 86400000);
  if (days === -1) return lang === 'ko' ? '어제' : 'Yesterday';
  if (days === 0) return lang === 'ko' ? '오늘' : 'Today';
  if (days === 1) return lang === 'ko' ? '내일' : 'Tomorrow';
  const dayNames = lang === 'ko'
    ? ['일','월','화','수','목','금','토']
    : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return `${d.getMonth() + 1}/${d.getDate()}(${dayNames[d.getDay()]})`;
}

// True when an instant would render as 어제/오늘/내일 (within ±1 local day) rather
// than a date. Callers use it to keep a two-row block in ONE format: a wait block
// whose limit-hit is "내일" but whose reset is days out shouldn't mix "내일" with a
// date — if either row is beyond the relative window, both fall back to dates.
export function isWithinRelativeDay(at) {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const dDay = new Date(at); dDay.setHours(0, 0, 0, 0);
  const days = Math.round((dDay.getTime() - midnight.getTime()) / 86400000);
  return days >= -1 && days <= 1;
}

// Absolute wall-clock time, compact and 24-hour: "오늘 17:00" / "내일 2:00" /
// "7/31(금) 6:00". 24h drops 오전/오후 (shorter, unambiguous); the day part uses
// relativeDay(). Pass { absoluteDate: true } to force the date form (no 오늘/내일) —
// used to keep both rows of a wait block in the same format.
export function formatResetAbsolute(resetAt, opts) {
  const d = new Date(resetAt);
  const lang = (typeof getLang === 'function' ? getLang() : 'ko');
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (opts && opts.absoluteDate) {
    const dayNames = lang === 'ko'
      ? ['일','월','화','수','목','금','토']
      : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    return `${d.getMonth() + 1}/${d.getDate()}(${dayNames[d.getDay()]}) ${time}`;
  }
  return `${relativeDay(d, lang)} ${time}`;
}

export function formatDuration(ms) { return cv.formatDuration(ms, extLabels()); }

// Provider-aware plan label. ChatGPT's raw plan_type uses internal aliases
// ("Prolite" = the $100 tier, "Pro" = the $200 tier); remap them to the user-facing
// names so the popup matches the dashboard's planDisplayName(). Other tiers
// (Plus/Go/Free/Team) and Claude/Gemini plans are already readable → pass through.
// 🔴 DISPLAY ONLY. OpenAI renamed the Pro tiers by price (Pro 100 / Pro 200 / Pro 500, 2026-09), but
// the STORED labels stay 'Pro 5x' / 'Pro 20x' / 'Pro 25x' everywhere (snapshots, multipliers,
// canonicalPlanKey, rec engine). Never feed this function's output back into planToMultiplier() or a
// plan table — 'Pro 200' would score 1x there, and substring ladders would read its '20'/'5'.
export function planDisplayName(plan, provider) {
  const p = (plan || '').trim().toLowerCase();
  if (provider === 'chatgpt') {
    if (p === 'prolite' || p === 'pro 5x') return 'Pro 100';
    if (p === 'pro' || p === 'pro 20x') return 'Pro 200';
    if (p === 'pro 25x' || p === 'promax') return 'Pro 500';
    if (p === 'self_serve_business_prolite') return 'Business Premium';
    if (p === 'team') return 'Business Standard';
  }
  return plan || '';
}

// Provider-aware quota multiplier, mirroring the dashboard's planMultiplier().
// ChatGPT/Gemini use exact-match tiers (their raw plan_type names differ from
// Claude's); Claude falls through to the original substring logic. ChatGPT "Pro"
// = Pro 20x tier (20x), "Prolite"/"Pro 5x" = Pro 5x tier (5x) — the same aliases
// remapped by planDisplayName().
// 🔴 `win` ('5h' | '7d') is REQUIRED at every call site. Claude Max 20x grants 20x Pro's 5-hour
// quota but only ~10x its WEEKLY quota (#955 — measured over 3 weeks of our own snapshots; the
// method is documented at planQuota() in worker/src/services/usage-calculator.ts). No compiler
// here, so test/plan-mult-window-args-guard.mjs enforces the argument; the runtime default is '5h'
// so a missed call degrades to the PREVIOUS behaviour instead of throwing in a user's popup.
export function planToMultiplier(plan, provider, win) {
  // trim() matters here and not in the Claude substring arms: the non-Claude arms below are EXACT
  // matches, so a padded " Pro 20x " would miss every one of them and fall through to `return 1` —
  // the same silent 20x under-count this function exists to prevent. planDisplayName() above already
  // trims, so an untrimmed label would also display correctly while scoring wrong.
  const p = (plan || '').trim().toLowerCase();
  if (provider === 'chatgpt') {
    if (p === 'free') return 0.2;
    if (p === 'go') return 0.4;
    if (p === 'pro' || p === 'pro 20x') return 20;
    if (p === 'pro 5x' || p === 'prolite') return 5;
    if (p === 'pro 25x' || p === 'promax') return 25; // $500 Pro tier (25x Plus quota; raw plan_type 'promax')
    if (p === 'team') return 1.25;
    if (p === 'self_serve_business_prolite') return 6.25; // Business Premium seat ($100/seat annual): 5x a Standard (Team) seat, no 5h limit (#1925)
    return 1; // plus, education, business, unknown
  }
  if (provider === 'gemini') {
    if (p === 'free') return 0.25;
    if (p.includes('ultra')) return p.includes('20') ? 20 : 5;
    // 'advanced' ≡ AI Plus (0.5): 'Advanced' is the planId-4 fallback label and every classifiable Gemini 'Advanced' row in AE claude_gemini_signals (92 days to 2026-09-30, before and after the 2026-08-09 policy rename) has full 7d quota 24,192 = AI Plus.
    if (p === 'ai plus' || p === 'advanced') return 0.5;
    return 1; // AI Pro, Business, unknown
  }
  // Claude (default): original substring logic
  if (!plan) return 1;
  if (p.includes('20')) return win === '7d' ? 10 : 20;
  if (p.includes('5x') || (p.includes('max') && p.includes('5'))) return 5;
  if (p.includes('max')) return 5; // "Max" alone defaults to 5x
  if (p.includes('team') && p.includes('premium')) return 6.25;
  if (p.includes('team')) return 1.25; // Team Standard
  if (p.includes('enterprise')) return 1; // Enterprise: usage-based, no multiplier
  return 1; // Pro, Free, unknown
}

// Provider-specific quota tiers used by the popup's dashed guide lines.
// `win` picks the Claude 20x tier's quota for THIS chart's window (#955). ChatGPT/Gemini 20x
// tiers are unmeasured and stay at 20 in both windows, so only the Claude arm below moves.
export function planLimitTiers(provider, currentMult, win) {
  if (currentMult === 1.25 || currentMult === 6.25) {
    return [
      { mult: 1.25, label: provider === 'chatgpt' ? 'Business Standard' : 'Team Standard', color: '#06b6d4' },
      { mult: 6.25, label: provider === 'chatgpt' ? 'Business Premium' : 'Team Premium', color: '#14b8a6' },
    ];
  }
  if (provider === 'chatgpt') {
    return [
      { mult: 1, label: 'Plus', color: '#22c55e' },
      { mult: 5, label: 'Pro 100', color: '#f97316' },
      { mult: 20, label: 'Pro 200', color: '#ef4444' },
      { mult: 25, label: 'Pro 500', color: '#a21caf' },
    ];
  }
  if (provider === 'gemini') {
    // AI Plus (0.5) must be a rung: 'Advanced' now scores 0.5 too (≡ AI Plus, #1928), and a plan
    // with no rung of its own gets no 100% line on its chart (1.49.0 batch review).
    return [
      { mult: 0.5, label: 'AI Plus', color: '#84cc16' },
      { mult: 1, label: 'AI Pro', color: '#22c55e' },
      { mult: 5, label: 'Ultra 5x', color: '#f97316' },
      { mult: 20, label: 'Ultra 20x', color: '#ef4444' },
    ];
  }
  return [
    { mult: 1, label: 'Pro', color: '#22c55e' },
    { mult: 5, label: 'Max 5x', color: '#f97316' },
    { mult: win === '7d' ? 10 : 20, label: 'Max 20x', color: '#ef4444' },
  ];
}

// 🔴 `currentMult` and `win` must describe the SAME window: the returned values are percentages of
// `currentMult`, so mixing a 5h denominator with a 7d ladder is the #955 defect in one line.
export function buildPlanLimitLines(currentMult, provider, win) {
  const tiers = planLimitTiers(provider, currentMult, win);
  const lowerTiers = tiers.filter((tier) => tier.mult < currentMult);
  const immediateLowerMult = lowerTiers.length
    ? Math.max(...lowerTiers.map((tier) => tier.mult))
    : null;
  return tiers.map((tier) => ({
    value: (tier.mult / currentMult) * 100,
    label: tier.label,
    color: tier.color,
    isImmediateLower: tier.mult === immediateLowerMult,
    // The tier the user is actually on lands at 100% — it IS the chart's limit. It used to be
    // dropped here on the theory that it "overlaps the current plan limit", but no such line was
    // ever drawn: 100% got nothing but the same gray gridline as 25/50/75, so a Max 20x user saw
    // a Max 5x boundary and no marker for their own ceiling.
    isCurrentPlan: Math.abs(tier.mult - currentMult) < 1e-9,
  }));
}

// Auto mode follows the data but always leaves room for the nearest lower plan.
//
// Deliberately asymmetric: the nearest LOWER line is forced into the axis, the current-plan line
// at 100% is not. They matter at opposite ends — "you could downgrade" is worth seeing precisely
// when usage is low (the case where the axis used to clip it away), while your own ceiling only
// matters as you approach it, and forcing 100% into every axis would squash a 5%-usage chart flat
// against the baseline. So 100% is left opportunistic: it appears once the data climbs near it.
export function chartMaxY(dataMax, fixed, limitLines) {
  if (fixed) return 100;
  const immediateLower = limitLines.find((line) => line.isImmediateLower);
  return Math.max(dataMax * 1.15, immediateLower ? immediateLower.value * 1.08 : 0);
}

export function formatTimeAgo(timestamp) { return cv.formatTimeAgo(timestamp, extLabels()); }

// REMOVED 2026-08-02 — calcPaceTier(). It projected end-of-window from the WINDOW AVERAGE
// (current / fraction-of-window-elapsed), a second forecast that disagreed with the one the
// gauges show: 34% used 1h25m into a 5h window is "97% at reset" by measured rate and "120%"
// here, so the popup rendered a silent gauge above a red "크게 초과" banner. The tier ladder now
// lives in ui/prediction.js (PROJECTION_TIERS) and reads calcPredictedAtReset like everything
// else. Do not reintroduce a window-average pace — test/limit-eta-guard.mjs fails on it.

export function _isDark() { return document.documentElement.dataset.theme === 'dark'; }
export function _cGrid() { return _isDark() ? '#2d3748' : '#f0f0f0'; }
export function _cLabel() { return _isDark() ? '#718096' : '#d1d5db'; }
// X-axis tick labels (dates/times). Darker than _cLabel so they stay legible
// against the chart fill — the faint gray tick text was hard to read (see charts).
export function _cTick() { return _isDark() ? '#94a3b8' : '#6b7280'; }

// Dashboard URL deep-linked to a specific org (?org=<uuid>); plain dashboard when no
// org. The dashboard resolves the uuid against its org list (provider included), so a
// single org param covers Claude/ChatGPT/Gemini.
//
// Deliberately carries NO account identity. An earlier attempt appended the synced account as
// a `#sync=` fragment so the dashboard could spot an account divergence; that was the wrong
// rail. The dashboard can just ASK the extension (site/shared/ext-detect.js
// getCollectingAccountEmail via externally_connectable), which works from bookmarks and typed
// URLs too instead of only from links the extension rewrote — and keeps the address out of the
// URL entirely, which matters because the dashboard forwards location.href to analytics.
export function dashboardUrl(orgId) {
  return orgId
    ? `https://claudetuner.com/dashboard/?org=${encodeURIComponent(orgId)}`
    : 'https://claudetuner.com/dashboard';
}

// Point every static dashboard anchor (marked data-dash-link) at the given org, so
// links shown in the detail view carry the org the user is currently viewing.
export function refreshDashboardLinks(orgId) {
  const url = dashboardUrl(orgId);
  document.querySelectorAll('a[data-dash-link]').forEach(a => { a.href = url; });
}
