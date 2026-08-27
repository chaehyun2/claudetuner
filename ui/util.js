// Pure leaf helpers shared across the popup UI.
// No module-level mutable state — only arguments + global i18n (`t`, `getLang` from i18n.js, a classic script).
// Extracted from popup.js (see refactor/popup-modular). Keep these dependency-free so any UI module can import them.

export function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Usage-window labels (#954) ────────────────────────────────────────────────────────────────
//
// The 5h / 7d slots are SLOTS, not window lengths. ChatGPT Free and Go report a **30-day** window
// in the 7d slot (938 + 80 users; 98.5% / 99.9% of their rows, measured 2026-08-26), so
// "7일 사용률" is a false label for them. The provider's own `limit_window_seconds` is the truth
// and it rides every response; these helpers turn it into a label.
//
// 🔴 Do NOT derive the window from the provider or the plan name. Within ChatGPT alone Plus is 7
// days and Free is 30, so a provider test is wrong in BOTH directions — which is exactly how the
// team Race broke (#952). The span is a property of (plan, point in time); read it from the data.
//
// A null/absent span means "not reported" (an older client, or a provider that does not send one,
// e.g. Claude) → callers fall back to the static usage_5h / usage_7d labels, so nothing changes
// for anyone whose window really is the slot's nominal length.
const WINDOW_HOUR = 3600;
const WINDOW_DAY = 86400;

/** True when `seconds` is a usable span. Rejects 0 and negatives, not merely non-numbers. */
function isSpan(seconds) {
  return typeof seconds === 'number' && isFinite(seconds) && seconds > 0;
}

/**
 * Short slot label for a chart tab: '5h' / '7d' / '30d'.
 * Returns null when there is no span, so the caller keeps its existing hard-coded label.
 */
export function formatWindowShort(seconds) {
  if (!isSpan(seconds)) return null;
  if (seconds < WINDOW_DAY) return `${Math.round(seconds / WINDOW_HOUR)}h`;
  return `${Math.round(seconds / WINDOW_DAY)}d`;
}

/**
 * Full gauge label: '30일 사용률' / '30-Day Usage'.
 * Returns null when there is no span (caller falls back to t('usage_5h') / t('usage_7d')).
 */
export function formatWindowLabel(seconds) {
  if (!isSpan(seconds)) return null;
  const unit = seconds < WINDOW_DAY
    ? t('window_hours', Math.round(seconds / WINDOW_HOUR))
    : t('window_days', Math.round(seconds / WINDOW_DAY));
  return t('usage_window', unit);
}

/**
 * THE way to label a usage gauge. Every caller goes through this rather than writing
 * `formatWindowLabel(x) || t('usage_7d')` itself — one rule, one place to change.
 *
 * `fallbackKey` is the slot's static label ('usage_5h' / 'usage_7d'), used when the provider
 * reported no span. That keeps Claude and every pre-span stored org rendering exactly as before.
 */
export function windowLabel(spanSeconds, fallbackKey) {
  return formatWindowLabel(spanSeconds) || t(fallbackKey);
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

export function gaugeColor(util) {
  if (util >= 80) return '#ef4444';
  if (util >= 50) return '#f59e0b';
  return '#06b6d4';
}

// Relative countdown, compact and language-neutral: "6h 29m" / "6d 13h" / "29m".
// Only the "resetting soon" word is localized; the units stay d/h/m so the popup
// and the three sidebars share one shape and the i18n surface stays tiny.
export function formatCountdown(resetAt) {
  const diff = new Date(resetAt).getTime() - Date.now();
  if (diff <= 0) return t('countdown_soon');
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) {
    const d = Math.floor(h / 24), rem = h % 24;
    return rem > 0 ? `${d}d ${rem}h` : `${d}d`;
  }
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}

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

// Approximate wait span for the headline ("약 3시간" reads as "3시간"; caller adds
// 약/예상). Rounded to the hour (the wait is an estimate — a limit-hit derived from
// a burn rate or a sampled history point), so no minute bucket: "3시간" / "4일 4시간".
export function formatDuration(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  if (totalMin < 60) return t('gauge_dur_m', totalMin);
  const totalHours = Math.round(ms / 3600000);
  if (totalHours >= 24) {
    const days = Math.floor(totalHours / 24), rem = totalHours % 24;
    return rem > 0 ? t('gauge_dur_dhm', days, rem) : t('gauge_dur_d', days);
  }
  return t('gauge_dur_h', totalHours);
}

// Provider-aware plan label. ChatGPT's raw plan_type uses internal aliases
// ("Prolite" = Pro 5x tier, "Pro" = Pro 20x tier); remap them to the user-facing
// names so the popup matches the dashboard's planDisplayName(). Other tiers
// (Plus/Go/Free/Team) and Claude/Gemini plans are already readable → pass through.
export function planDisplayName(plan, provider) {
  const p = (plan || '').trim().toLowerCase();
  if (provider === 'chatgpt') {
    if (p === 'prolite' || p === 'pro 5x') return 'Pro 5x';
    if (p === 'pro' || p === 'pro 20x') return 'Pro 20x';
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
    if (p === 'team') return 1.25;
    return 1; // plus, education, business, unknown
  }
  if (provider === 'gemini') {
    if (p === 'free') return 0.25;
    if (p.includes('ultra')) return p.includes('20') ? 20 : 5;
    if (p === 'ai plus') return 0.5;
    return 1; // AI Pro/Advanced, Business, unknown
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
      { mult: 1.25, label: provider === 'chatgpt' ? 'Team' : 'Team Standard', color: '#06b6d4' },
      { mult: 6.25, label: 'Team Premium', color: '#14b8a6' },
    ];
  }
  if (provider === 'chatgpt') {
    return [
      { mult: 1, label: 'Plus', color: '#22c55e' },
      { mult: 5, label: 'Pro 5x', color: '#f97316' },
      { mult: 20, label: 'Pro 20x', color: '#ef4444' },
    ];
  }
  if (provider === 'gemini') {
    return [
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

export function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t('ago_just_now');
  if (minutes < 60) return `${minutes}${t('ago_min')}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${t('ago_hour')}`;
  return `${Math.floor(hours / 24)}${t('ago_day')}`;
}

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
