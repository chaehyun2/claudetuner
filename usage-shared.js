// Claude Tuner — Shared usage-injection core
// Theme-independent helpers shared by the provider-specific in-page usage panels
// (currently ChatGPT sidebar + input strip; structured so Gemini/Claude can adopt it).
// Loaded as the FIRST content script in each provider's injection so the globals
// are available before the provider files run (same isolated world).

(() => {
  'use strict';

  // Always (re)assign the core. The functions are pure, so re-injection (dev
  // reload / executeScript / extension update) overwriting it is harmless — and
  // it ensures a newer build's added methods replace any stale core object left
  // in the isolated world (a plain `if (exists) return` guard would keep the old
  // object and hide new methods like fetchAnnouncements from fresh callers).

  function gaugeColor(util) {
    if (util >= 80) return '#ef4444';
    if (util >= 50) return '#f59e0b';
    return '#06b6d4';
  }

  function formatCountdown(resetAt, lang) {
    const soon = lang === 'ko' ? '곧 리셋' : 'Resetting soon';
    const diff = new Date(resetAt).getTime() - Date.now();
    if (diff <= 0) return `⏱ ${soon}`;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (h >= 24) {
      const d = Math.floor(h / 24);
      return `⏱ ${d}d ${h % 24}h`;
    }
    return `⏱ ${h}h ${m}m`;
  }

  function formatResetAbsolute(resetAt, lang) {
    if (!resetAt) return '';
    const d = new Date(resetAt);
    const tz = d.toLocaleTimeString(lang === 'ko' ? 'ko-KR' : 'en-US', { timeZoneName: 'short' })
      .replace(/.*\s/, ''); // extract timezone abbreviation
    if (lang === 'ko') {
      const days = ['일', '월', '화', '수', '목', '금', '토'];
      const ampm = d.getHours() < 12 ? '오전' : '오후';
      const h12 = d.getHours() % 12 || 12;
      const min = String(d.getMinutes()).padStart(2, '0');
      return `${d.getMonth() + 1}/${d.getDate()}(${days[d.getDay()]}) ${ampm} ${h12}시 ${min}분 (${tz}) 리셋`;
    }
    const h12 = d.getHours() % 12 || 12;
    const ampm = d.getHours() < 12 ? 'AM' : 'PM';
    const min = String(d.getMinutes()).padStart(2, '0');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `Resets ${months[d.getMonth()]} ${d.getDate()} (${days[d.getDay()]}) ${h12}:${min} ${ampm} (${tz})`;
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function detectLang() {
    const browserLang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return browserLang === 'ko' ? 'ko' : 'en';
  }

  // Whether the extension runtime is still alive (false after reload/unload).
  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  // Minimum predicted-vs-current delta before showing a prediction marker.
  const PRED_MIN_DELTA = 3;

  // ── Announcements (shared by the Claude + ChatGPT sidebars) ──
  const ANNOUNCE_URL = 'https://api.claudetuner.com/api/announcements';
  const NOTICE_BASE = 'https://notice.claudetuner.com/';

  // Returns `true` if version `a` >= version `b` (dotted numeric compare).
  function compareVersions(a, b) {
    const pa = (a || '0').split('.').map(Number);
    const pb = (b || '0').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const va = pa[i] || 0, vb = pb[i] || 0;
      if (va > vb) return true;
      if (va < vb) return false;
    }
    return true;
  }

  // Fetch + filter announcements for the given language / extension version.
  // Throws on network/parse error so callers can keep their last-known notices
  // (don't clear on a transient failure). Drops promo banners (own placement).
  async function fetchAnnouncements(lang, extVersion) {
    const cacheBuster = Math.floor(Date.now() / 3600000);
    const res = await fetch(ANNOUNCE_URL + '?t=' + cacheBuster);
    if (!res.ok) throw new Error('fetchAnnouncements HTTP ' + res.status);
    const list = await res.json();
    // Throw (not []) on an unexpected shape so callers keep their last-known notices.
    if (!Array.isArray(list)) throw new TypeError('fetchAnnouncements: unexpected shape');
    return list.filter((n) => {
      if (n.type === 'promo') return false;
      if (n.min_version && !compareVersions(extVersion, n.min_version)) return false;
      if (n.lang && n.lang !== lang) return false;
      return true;
    });
  }

  // Count notices newer than the last-seen id (notices assumed newest-first).
  function getUnseenCount(notices, lastSeenId) {
    if (!lastSeenId || notices.length === 0) return notices.length;
    let count = 0;
    for (const n of notices) {
      if (n.id === lastSeenId) break;
      count++;
    }
    return count;
  }

  globalThis.__ctUsageCore = {
    gaugeColor,
    formatCountdown,
    formatResetAbsolute,
    escapeHtml,
    detectLang,
    isContextValid,
    PRED_MIN_DELTA,
    ANNOUNCE_URL,
    NOTICE_BASE,
    compareVersions,
    fetchAnnouncements,
    getUnseenCount,
  };
})();
