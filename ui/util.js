// Pure leaf helpers shared across the popup UI.
// No module-level mutable state — only arguments + global i18n (`t`, `getLang` from i18n.js, a classic script).
// Extracted from popup.js (see refactor/popup-modular). Keep these dependency-free so any UI module can import them.

export function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

export function formatCountdown(resetAt) {
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

export function formatResetAbsolute(resetAt) {
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
export function planToMultiplier(plan, provider) {
  const p = (plan || '').toLowerCase();
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
  if (p.includes('20')) return 20;
  if (p.includes('5x') || (p.includes('max') && p.includes('5'))) return 5;
  if (p.includes('max')) return 5; // "Max" alone defaults to 5x
  if (p.includes('team') && p.includes('premium')) return 6.25;
  if (p.includes('team')) return 1.25; // Team Standard
  if (p.includes('enterprise')) return 1; // Enterprise: usage-based, no multiplier
  return 1; // Pro, Free, unknown
}

// Provider-specific quota tiers used by the popup's dashed guide lines.
export function planLimitTiers(provider, currentMult) {
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
    { mult: 20, label: 'Max 20x', color: '#ef4444' },
  ];
}

export function buildPlanLimitLines(currentMult, provider) {
  const tiers = planLimitTiers(provider, currentMult);
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

// Project current utilization to end-of-window and bucket into a pace tier (shared by status banner + charts).
export function calcPaceTier(currentUtil, resetsAt, windowSeconds) {
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

export function _isDark() { return document.documentElement.dataset.theme === 'dark'; }
export function _cGrid() { return _isDark() ? '#2d3748' : '#f0f0f0'; }
export function _cLabel() { return _isDark() ? '#718096' : '#d1d5db'; }
// X-axis tick labels (dates/times). Darker than _cLabel so they stay legible
// against the chart fill — the faint gray tick text was hard to read (see charts).
export function _cTick() { return _isDark() ? '#94a3b8' : '#6b7280'; }

// Dashboard URL deep-linked to a specific org (?org=<uuid>); plain dashboard when no
// org. The dashboard resolves the uuid against its org list (provider included), so a
// single org param covers Claude/ChatGPT/Gemini.
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
