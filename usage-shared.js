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
  // Served as a static JSON straight from the Cloudflare CDN (cdn.claudetuner.com,
  // an R2 custom domain) instead of the Worker route — so this high-frequency poll
  // (every sidebar mount + SPA nav + 30-min interval) never invokes the Worker.
  // The payload shape is identical to the old GET /api/announcements.
  const ANNOUNCE_URL = 'https://cdn.claudetuner.com/announcements.json';
  const NOTICE_BASE = 'https://notice.claudetuner.com/';
  // Client-side cache: announcements change a few times/week, so hold the raw
  // payload in chrome.storage for an hour and skip the network on every mount.
  const ANNOUNCE_CACHE_KEY = '__ct_announce_cache';
  const ANNOUNCE_TTL_MS = 60 * 60 * 1000; // 1h

  // Promisified chrome.storage.local access for the cached announcements payload.
  // Resolve null on any error so a storage hiccup just falls through to a fetch.
  function _getAnnounceCache() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(ANNOUNCE_CACHE_KEY, (o) => {
          if (chrome.runtime?.lastError) return resolve(null);
          resolve((o && o[ANNOUNCE_CACHE_KEY]) || null);
        });
      } catch { resolve(null); }
    });
  }
  function _setAnnounceCache(list) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [ANNOUNCE_CACHE_KEY]: { at: Date.now(), list } }, () => resolve());
      } catch { resolve(); }
    });
  }

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
    // Serve from the client-side cache while it's fresh so mounts/SPA-nav/interval
    // don't hit the network at all; a miss fetches the static CDN copy (never the
    // Worker). Only the network path throws, so callers keep last-known notices on
    // a transient CDN failure — a cache hit always succeeds.
    let list = null;
    const cached = await _getAnnounceCache();
    if (cached && Array.isArray(cached.list) && (Date.now() - (cached.at || 0)) < ANNOUNCE_TTL_MS) {
      list = cached.list;
    }
    if (!list) {
      const res = await fetch(ANNOUNCE_URL);
      if (!res.ok) throw new Error('fetchAnnouncements HTTP ' + res.status);
      list = await res.json();
      // Throw (not []) on an unexpected shape so callers keep their last-known notices.
      if (!Array.isArray(list)) throw new TypeError('fetchAnnouncements: unexpected shape');
      await _setAnnounceCache(list);
    }
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

  // Provider-aware plan label. ChatGPT's raw plan_type uses internal aliases
  // ("Prolite" = Pro 5x tier, "Pro" = Pro 20x tier); remap them to the user-facing
  // names so the extension matches the dashboard's planDisplayName(). Other tiers
  // (Plus/Go/Free/Team) and Claude/Gemini plans are already readable → pass through.
  function planDisplayName(plan, provider) {
    const p = (plan || '').trim().toLowerCase();
    if (provider === 'chatgpt') {
      if (p === 'prolite' || p === 'pro 5x') return 'Pro 5x';
      if (p === 'pro' || p === 'pro 20x') return 'Pro 20x';
    }
    return plan || '';
  }

  globalThis.__ctUsageCore = {
    gaugeColor,
    planDisplayName,
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
