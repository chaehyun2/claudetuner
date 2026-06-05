// Pure leaf helpers shared across the popup UI.
// No module-level mutable state — only arguments + global i18n (`t`, `getLang` from i18n.js, a classic script).
// Extracted from popup.js (see refactor/popup-modular). Keep these dependency-free so any UI module can import them.

export function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

export function planToMultiplier(plan) {
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
