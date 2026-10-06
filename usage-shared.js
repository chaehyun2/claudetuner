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

  // <usage-level> AUTO-GENERATED from ui/usage-tiers.js by scripts/sync-usage-tiers.mjs — DO NOT EDIT
  const USAGE_LEVEL_HIGH_PCT = 80;
  const USAGE_LEVEL_MID_PCT = 50;

  // 'high' | 'mid' | 'low', or null when there is no reading (callers draw their "no data" shade).
  function usageLevel(util) {
    if (util == null || util === '') return null;
    const n = Number(util);
    if (!Number.isFinite(n)) return null;
    return n >= USAGE_LEVEL_HIGH_PCT ? 'high' : n >= USAGE_LEVEL_MID_PCT ? 'mid' : 'low';
  }
  // </usage-level>

  // The bar colour of a usage %: ui/usage-tiers.js usageLevel (the copy above) on the popup's
  // palette — ui/util.js gaugeColor answers the same (#2067). No reading is the low shade.
  const GAUGE_LEVEL_COLORS = { high: '#ef4444', mid: '#f59e0b', low: '#06b6d4' };
  function gaugeColor(util) {
    return GAUGE_LEVEL_COLORS[usageLevel(util)] || GAUGE_LEVEL_COLORS.low;
  }

  // Localized day word relative to today (어제/오늘/내일 within ±1 day, else the
  // "M/D(요일)" date). MUST match the popup's ui/util.js relativeDay() — the popup
  // (ESM) and these sidebars (classic content scripts) can't share code, so this is
  // a deliberate synced copy; the guard test asserts the two stay identical.
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

  // Compact, language-neutral countdown: "6h 29m" / "6d 13h" / "29m" (only the
  // "resetting soon" word is localized). Matches the popup's formatCountdown; the
  // ⏱ prefix is the sidebar's own.
  function formatCountdown(resetAt, lang) {
    const diff = new Date(resetAt).getTime() - Date.now();
    if (diff <= 0) return `⏱ ${lang === 'ko' ? '곧 리셋' : 'Resetting soon'}`;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    let body;
    if (h >= 24) { const d = Math.floor(h / 24), rem = h % 24; body = rem > 0 ? `${d}d ${rem}h` : `${d}d`; }
    else if (h >= 1) body = `${h}h ${m}m`;
    else body = `${m}m`;
    return `⏱ ${body}`;
  }

  function formatResetAbsolute(resetAt, lang, opts) {
    if (!resetAt) return '';
    const d = new Date(resetAt);
    // Compact form for the inline second line: "오늘 17:00" / "8/4(목) 6:00" — 24h,
    // day-relative, no timezone (matches the popup's formatResetAbsolute). The
    // verbose form below (with tz + label) stays for the hover tooltip.
    if (opts && opts.compact) {
      const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
      return `${relativeDay(d, lang)} ${time}`;
    }
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

  // Inner HTML for a sidebar reset cell — the single source shared by all three
  // sidebars (Claude/ChatGPT/Gemini), which differ only by their outer wrapper's
  // class prefix. With a reset: a countdown line (`.ct-reset-count`, ticked每秒 by
  // each sidebar's updateCountdowns) over a static compact absolute-time line
  // (`.ct-reset-abs`). Without a reset but with a window (Claude's 5h is usage-
  // anchored → no reset at 0%): a quiet idle hint (`.ct-reset-idle`). Inner class
  // names are prefix-free so the three CSS files can share identical rules.
  function buildResetCellInner(resetAt, lang) {
    if (!resetAt) {
      return `<span class="ct-reset-idle">${lang === 'ko' ? '최근 사용 없음' : 'No recent usage'}</span>`;
    }
    return `<span class="ct-reset-count">${formatCountdown(resetAt, lang)}</span>` +
           `<span class="ct-reset-abs">${formatResetAbsolute(resetAt, lang, { compact: true })}</span>`;
  }

  // ── Window span labels ───────────────────────────────────────────────────────────────────────
  //
  // 🔴 A WINDOW IS LABELLED BY THE SPAN THE PROVIDER REPORTED, NEVER BY THE SLOT IT SITS IN.
  // ChatGPT Free and Go report a THIRTY-DAY window, which the collector files in the 7d slot
  // because there is nowhere else for it to go — so "주간 사용률" beside a 29-day countdown is a
  // false label, and the two sat on the same line (inquiry #198, verified against a live Free
  // account 2026-09-10: limit_window_seconds = 2592000).
  //
  // 🪤 THIS IS A SECOND COPY OF ui/util.js's RULE, and it is deliberate: ui/ is popup ESM and a
  // content script cannot import it — a runtime boundary, not a convenience. What must not drift
  // is the MAPPING (under a day → hours, else days, rounded), so test/window-span-label-guard.mjs
  // executes both and requires identical output across a table of spans. Signatures differ on
  // purpose: ui/ resolves its own i18n key, content scripts pass their already-localized fallback.
  const WINDOW_HOUR_S = 3600;
  const WINDOW_DAY_S = 86400;
  /** True when `seconds` is a usable span. Rejects 0 and negatives, not merely non-numbers. */
  function isSpanSeconds(seconds) {
    return typeof seconds === 'number' && isFinite(seconds) && seconds > 0;
  }
  /** The reported window as a bare unit — '5시간' / '30일' / '5-Hour' / '30-Day' — or null. */
  // 🔴 THE SPEND GAUGE'S OWN RENDER CONDITION — canonical for the whole extension.
  // Both in-page panels (sidebar-usage.js, input-usage.js) draw the extra-usage bar only when this
  // is true, and the background payload builder (bg/sidebar-usage.js) asks the SAME question to
  // decide whether the panel has anything on it at all. It used to be written out at each of those
  // three sites, and the builder's copy left out the limit — so "enabled + spend + no limit" made
  // the builder believe a gauge was on screen, which suppressed the "no usage" notice while the
  // panels drew nothing (#1410 ②).
  //
  // 🪤 The limit is not decoration: the bar is a PERCENTAGE OF IT (used/limit), so without a limit
  // there is no bar to draw. Any "is the spend gauge showing" test that ignores `el` is wrong.
  //
  // The service worker is a module in another world and cannot reach this global, so its copy is a
  // mechanical sync copy — test/extra-gauge-drawn-guard.mjs runs both against the same truth table
  // and fails on any disagreement.
  function extraGaugeDrawn(d) {
    return !!(d && d.euEnabled && d.el && (d.eu || 0) > 0);
  }

  function windowUnitLabel(seconds, lang) {
    if (!isSpanSeconds(seconds)) return null;
    const ko = lang === 'ko';
    if (seconds < WINDOW_DAY_S) {
      const n = Math.round(seconds / WINDOW_HOUR_S);
      return ko ? `${n}시간` : `${n}h`; // #1372 short form — keep in step with i18n.js window_hours
    }
    const n = Math.round(seconds / WINDOW_DAY_S);
    return ko ? `${n}일` : `${n}-Day`;
  }
  /**
   * THE way an in-page widget labels a usage gauge. `fallbackText` is the caller's own static
   * slot label, already localized — used when the provider reported no span, which keeps Claude
   * and every pre-span stored org rendering exactly as before.
   */
  function windowLabel(seconds, lang, fallbackText) {
    const unit = windowUnitLabel(seconds, lang);
    if (unit == null) return fallbackText;
    return lang === 'ko' ? `${unit} 사용률` : `${unit} Usage`;
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

  // ── Zombie-instance guard (shared by every content-script panel) ──
  // A panel script can run more than once in the SAME document: background.js
  // re-injects the content scripts into open tabs on install/update while the
  // manifest-injected instance is still live, and a dev reload leaves the old
  // isolated world running. Without a guard the previous instance keeps its
  // intervals (usage refresh, notice refresh, AD ROTATION) and its observers,
  // so the ad slot is fetched, re-rendered and impression-counted twice.
  //
  // Each instance claims a generation token on globalThis (which survives
  // re-injection, unlike this closure). It stops being "current" the moment a
  // newer instance claims the token or the extension context dies — and then
  // tears down everything it registered. Timers registered via guard.setInterval
  // self-check on every tick, so teardown happens even in a hidden tab where the
  // rAF mount loop and the MutationObserver are throttled to a standstill.
  function createInstanceGuard(genKey, onTeardown) {
    const gen = (globalThis[genKey] = (globalThis[genKey] || 0) + 1);
    const intervals = [];
    const observers = [];
    let torndown = false;

    const guard = {
      // This instance owns the page (newest generation + live runtime).
      isCurrent() {
        return !torndown && gen === globalThis[genKey] && isContextValid();
      },
      // setInterval that stops itself once superseded — the tick is the one clock
      // that keeps running in a background tab, so it doubles as the teardown probe.
      setInterval(fn, ms) {
        const id = setInterval(() => {
          if (guard.teardownIfStale()) return;
          fn();
        }, ms);
        intervals.push(id);
        return id;
      },
      // Register an observer so teardown disconnects it.
      addObserver(observer) {
        observers.push(observer);
        return observer;
      },
      // Returns true when this instance is no longer the live one (and has been
      // torn down). Call at the top of any loop/callback that must not outlive it.
      teardownIfStale() {
        if (torndown) return true;
        if (guard.isCurrent()) return false;
        guard.teardown();
        return true;
      },
      // Idempotent: clears timers + observers, then runs the caller's cleanup
      // (DOM unmount, listener removal) exactly once.
      teardown() {
        if (torndown) return;
        torndown = true;
        intervals.forEach(clearInterval);
        intervals.length = 0;
        observers.forEach((o) => { try { o.disconnect(); } catch { /* noop */ } });
        observers.length = 0;
        if (onTeardown) { try { onTeardown(); } catch { /* never throw out of teardown */ } }
      },
    };
    return guard;
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
  // ("Prolite" = the $100 tier, "Pro" = the $200 tier); remap them to the user-facing
  // names so the extension matches the dashboard's planDisplayName(). Other tiers
  // (Plus/Go/Free/Team) and Claude/Gemini plans are already readable → pass through.
  // DISPLAY ONLY — stored labels stay 'Pro 5x' / 'Pro 20x' / 'Pro 25x' (twin of ui/util.js).
  function planDisplayName(plan, provider) {
    const p = (plan || '').trim().toLowerCase();
    if (provider === 'chatgpt') {
      if (p === 'prolite' || p === 'pro 5x') return 'Pro 100';
      if (p === 'pro' || p === 'pro 20x') return 'Pro 200';
      if (p === 'pro 25x' || p === 'promax') return 'Pro 500';
    }
    return plan || '';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // In-house ad server — Phase 1 SERVING (design docs/DESIGN-sidebar-ad-server.md)
  // ══════════════════════════════════════════════════════════════════════════
  // This is the SINGLE CANONICAL source of ad-serving logic for the whole
  // EXTENSION: the three provider sidebars (Claude/ChatGPT/Gemini) already consume
  // __ctUsageCore, and the popup loads usage-shared.js too (see popup.html) so its
  // ESM modules reach the same core via globalThis. The only unavoidable copy is
  // the dashboard (site/shared/announcement.js) — a separate Cloudflare Pages
  // deploy that can't import extension files; PLACEMENTS there is a mechanical
  // sync copy guarded by test/ads-dry-guard.mjs (single-source-of-truth rule).
  //
  // Serving (above) and measurement are separate: banners render + are clickable
  // here, and viewability/click counting attaches at the trackAdViewability/
  // trackAdClick seam below, which only MESSAGES the background service worker (the
  // single owner of the counters) — content scripts never touch counter storage.

  // Canonical placement taxonomy (design §2.2). Do NOT hardcode these strings in
  // the render files — reference CORE.PLACEMENTS.
  const PLACEMENTS = Object.freeze({
    CLAUDE_SIDEBAR: 'claude_sidebar',
    CHATGPT_SIDEBAR: 'chatgpt_sidebar',
    GEMINI_SIDEBAR: 'gemini_sidebar',
    POPUP: 'popup',
    DASHBOARD: 'dashboard',
  });

  // Served as a static JSON straight from the CDN (mirrors announcements.json) so
  // the high-frequency poll never wakes the Worker. Shape = design §3.1 (nested
  // campaign→contents array).
  const ADS_URL = 'https://cdn.claudetuner.com/ads.json';
  const ADS_CACHE_KEY = '__ct_ads_cache';        // { at, list }
  const ADS_TTL_MS = 5 * 60 * 1000;              // 5min — match CDN max-age=300 so a
                                                 // pulled/edited creative propagates fast
  const AD_STICKY_KEY = '__ct_ad_sticky';        // { [campaign_id]: content_id }
  const AD_CAP_KEY = '__ct_ad_cap';              // { "campaign|placement": {day,count} }
  const AD_COUNTRY_KEY = '_ct_country';          // ISO country piggybacked on POST responses
  const AD_INQUIRY_URL = 'https://tally.so/r/q4dyQk?source=ad_inquiry'; // advertiser-inquiry Tally form (opened from the "Ad" label)

  // ── Ad rotation period (server-tunable) ──
  // How often a sidebar re-runs selectAds and re-renders the slot (a different advertiser
  // may be drawn). Server-tunable through the SAME piggyback channel as the country
  // signal: the Worker puts `ad_refresh_minutes` on POST responses, bg/cadence-config.js
  // mirrors it into this storage key, and the content scripts read it here. No extra
  // request, and no CWS release needed to change the period.
  //
  // ⚠️ RUNTIME BOUNDARY: the writer is an ESM service-worker module and the reader is a
  // classic content script, so this key literal cannot be imported — it is duplicated on
  // purpose and pinned by a drift guard (test/ads-dry-guard.mjs). Rename in BOTH or neither.
  const AD_REFRESH_KEY = '_ct_ad_refresh_ms';    // number (ms), written by bg/cadence-config.js
  const AD_REFRESH_DEFAULT_MS = 3 * 60 * 1000;   // standalone-safe default (server silent)
  const AD_REFRESH_MIN_MS = 60 * 1000;           // clamp: 1min floor. Cheap (ads.json is cached
  const AD_REFRESH_MAX_MS = 60 * 60 * 1000;      // 5min) but a 0/absurd value must not busy-loop.
  // Fixed tick, variable period: the rotation timer fires at the FINEST period the server may
  // ask for and simply returns when the configured period has not elapsed. That way the period
  // can change at runtime without re-arming (or leaking) a timer.
  const AD_TICK_MS = AD_REFRESH_MIN_MS;

  // ── Premium ad gate (1.32.0, plan compare-quota-premium §2 R4) ──
  // Premium = no ads, decided on the CLIENT from the billing entitlement (the server's ad
  // targeting never sees a plan key — privacy notice §9). The gate sits at the CALL SITES (each
  // surface's fetchAds / the popup's loadPopupAnnouncements), never inside selectAds /
  // buildAdBannerHtml: those two have a byte-identical sync copy on the dashboard
  // (test/ads-dry-guard.mjs) and the dashboard gates on /api/me billing.plan itself.
  /** Pure: the GET_ENTITLEMENT answer (`{plan}`) → true only for a confirmed Premium. */
  function isAdFree(entitlement) {
    return !!(entitlement && entitlement.plan === 'pro');
  }
  // How long a surface waits for the SW's entitlement answer before it shows ads anyway. The SW
  // answers from its 24h cache in a few ms; a dead channel (no callback ever) must not become a
  // "no ads" outcome — the gate FAILS OPEN on every path (missing runtime, thrown sendMessage,
  // lastError, null / malformed answer, timeout).
  const AD_GATE_TIMEOUT_MS = 1500;
  /**
   * Ask the SW (GET_ENTITLEMENT — its 24h cache, written through from the compare status too) and
   * answer isAdFree(). Never rejects; false on every failure so ads render as before (fail open).
   * `runtime` is the caller's chrome.runtime — passed in so the popup and the content scripts share
   * one implementation and a test can hand in a stub.
   */
  function adFreeEntitled(runtime) {
    return new Promise((resolve) => {
      let done = false;
      const settle = (v) => { if (done) return; done = true; resolve(v === true); };
      try {
        if (!runtime || typeof runtime.sendMessage !== 'function') { settle(false); return; }
        setTimeout(() => settle(false), AD_GATE_TIMEOUT_MS);
        runtime.sendMessage({ type: 'GET_ENTITLEMENT' }, (res) => {
          // An error on the channel outranks whatever rode with it (Codex U3 1R #3): a set
          // lastError — or a getter that throws — is "no confirmed answer" → ads as before.
          let err = null;
          try { err = runtime.lastError || null; } catch { err = true; }
          settle(!err && isAdFree(res));
        });
      } catch { settle(false); }
    });
  }

  // Promisified chrome.storage.local get/set. Resolve null/void on any error so a
  // storage hiccup just falls through (never throws into the render path).
  function _adGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (o) => {
          if (chrome.runtime?.lastError) return resolve(null);
          resolve((o && o[key]) || null);
        });
      } catch { resolve(null); }
    });
  }
  function _adSet(key, val) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set({ [key]: val }, () => resolve()); } catch { resolve(); }
    });
  }

  // Fetch the nested ads.json with a 5min client cache (same strategy as
  // fetchAnnouncements, shorter TTL). Throws only on the network path so a cache hit always
  // succeeds; callers treat a throw as "no ads this round" (keep surface clean).
  async function fetchAds() {
    const cached = await _adGet(ADS_CACHE_KEY);
    if (cached && Array.isArray(cached.list) && (Date.now() - (cached.at || 0)) < ADS_TTL_MS) {
      return cached.list;
    }
    const res = await fetch(ADS_URL);
    if (!res.ok) throw new Error('fetchAds HTTP ' + res.status);
    const list = await res.json();
    if (!Array.isArray(list)) throw new TypeError('fetchAds: unexpected shape');
    await _adSet(ADS_CACHE_KEY, { at: Date.now(), list });
    return list;
  }

  // Country is the one targeting signal the client lacks (design §3.2/§4): the
  // server piggybacks cf.country on snapshot POST responses and the extension
  // caches it here. Absent → null → country targeting passes (don't over-suppress).
  async function getAdCountry() {
    const v = await _adGet(AD_COUNTRY_KEY);
    return (typeof v === 'string' && v) ? v.toUpperCase() : null;
  }

  // Resolved rotation period. Clamped HERE (the reader) rather than at the writer so a
  // malformed value that somehow reached storage still cannot busy-loop the sidebars.
  async function getAdRefreshMs() {
    const v = await _adGet(AD_REFRESH_KEY);
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return AD_REFRESH_DEFAULT_MS;
    return Math.min(Math.max(v, AD_REFRESH_MIN_MS), AD_REFRESH_MAX_MS);
  }

  /**
   * Rotate the ad slot on the server-tunable period. `setIntervalFn` is the caller's
   * guarded setInterval (createInstanceGuard) so the timer is torn down with the instance;
   * `onRefresh` is the surface's fetchAds.
   *
   * Callers run onRefresh once themselves at mount — this only schedules the ROTATION, so
   * the first one lands a full period later.
   */
  function startAdRotation(setIntervalFn, onRefresh) {
    let lastAt = Date.now();
    setIntervalFn(async () => {
      const period = await getAdRefreshMs();
      if (Date.now() - lastAt < period) return; // not due yet — period may have grown
      lastAt = Date.now();
      onRefresh();
    }, AD_TICK_MS);
  }

  // Absent/empty/null list = match all; a null signal value also passes (unknown →
  // don't suppress, per Phase 1 "don't over-suppress" rule for country). But a
  // PRESENT non-array list is malformed data → fail closed (NO match) so a bad
  // upload can never leak to every user.
  function _adInList(list, val) {
    if (list == null) return true;
    if (!Array.isArray(list)) return false;
    if (list.length === 0) return true;
    if (val == null) return true;
    return list.includes(val);
  }

  // Campaign-level targeting + schedule filter (design §3.2 step 1). Frequency cap
  // is checked separately in selectAds (it needs the persisted counter store).
  //
  // Targeting signals are deliberately limited to placement + country + language.
  // The public privacy notice (site/privacy §9) promises ads are targeted "only by
  // broad signals — your country and interface language — never by your personal
  // information", so plan/provider must NOT be matched here. Legacy `plan`/`provider`
  // keys may still exist in stored campaign JSON; they are ignored (back-compat) and
  // the admin UI no longer writes them. Provider was in any case redundant — it is a
  // function of the placement, which is already targetable.
  function adCampaignMatches(c, ctx) {
    if (!c || !c.campaign_id) return false;
    const t = c.targeting || {};
    const s = c.schedule || {};
    if (s.start_at && ctx.now < s.start_at) return false;
    if (s.end_at && ctx.now > s.end_at) return false;
    if (!_adInList(t.placements, ctx.placement)) return false;
    if (!_adInList(t.lang, ctx.lang)) return false;
    if (!_adInList(t.country, ctx.country)) return false;
    return true;
  }

  // Weighted random pick over a campaign's contents (weight <= 0 treated as 1).
  function _weightedPickContent(contents) {
    let total = 0;
    for (const c of contents) total += (Number(c.weight) > 0 ? Number(c.weight) : 1);
    let r = Math.random() * total;
    for (const c of contents) {
      r -= (Number(c.weight) > 0 ? Number(c.weight) : 1);
      if (r <= 0) return c;
    }
    return contents[contents.length - 1];
  }

  // Pick ONE content for a campaign (design §3.2 step 2 / §6). rotation 'weighted'
  // = fresh weighted random per load; 'sticky' (default) = reuse the persisted
  // (user,campaign)→content assignment for fair A/B, weighting only the first pick.
  // Returns { content, assigned } where `assigned` is the sticky id to persist (or null).
  function selectAdContent(campaign, stickyStore) {
    const contents = (campaign.contents || []).filter(
      (c) => c && c.content_id && (c.active == null || c.active)
    );
    if (!contents.length) return { content: null, assigned: null };
    if (campaign.rotation === 'weighted') {
      return { content: _weightedPickContent(contents), assigned: null };
    }
    const prev = stickyStore[campaign.campaign_id];
    const found = prev && contents.find((c) => c.content_id === prev);
    if (found) return { content: found, assigned: null };
    const chosen = _weightedPickContent(contents);
    return { content: chosen, assigned: chosen.content_id };
  }

  function _adDayKey(now) {
    const d = new Date(now);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function _adCapId(campaignId, placement) { return campaignId + '|' + placement; }
  function _adCapReached(capStore, campaignId, placement, perDay, today) {
    if (!perDay || perDay <= 0) return false;
    const e = capStore[_adCapId(campaignId, placement)];
    return !!(e && e.day === today && e.count >= perDay);
  }

  // Fetch → target-filter → cap-check → pick ONE campaign at random → content-select.
  // Returns an array holding a single { campaign, content, placement } (or []) — one ad
  // slot per fetch, chosen uniformly at random among servable campaigns so the banner
  // rotates across advertisers on each fetch cycle instead of stacking them. Persists any
  // new sticky assignment. Frequency cap is only CHECKED here (not incremented) — a serve
  // is counted later via noteAdServed() at render time so re-selecting doesn't inflate it.
  async function selectAds(ctx) {
    const placement = ctx && ctx.placement;
    if (!placement) return [];
    let campaigns;
    try { campaigns = await fetchAds(); } catch { return []; }
    if (!Array.isArray(campaigns) || !campaigns.length) return [];
    const now = ctx.now || Date.now();
    // Only the signals the privacy notice promises: placement + language + country.
    // A caller's ctx.plan (if any) is deliberately NOT forwarded into matching.
    const matchCtx = {
      placement,
      lang: ctx.lang || null,
      country: await getAdCountry(),
      now,
    };
    const eligible = campaigns.filter((c) => adCampaignMatches(c, matchCtx));
    if (!eligible.length) return [];

    const stickyStore = (await _adGet(AD_STICKY_KEY)) || {};
    const capStore = (await _adGet(AD_CAP_KEY)) || {};
    const today = _adDayKey(now);
    // Keep only campaigns whose daily cap is not yet reached.
    const servable = eligible.filter((c) => {
      const perDay = c.cap && Number(c.cap.per_day);
      return !_adCapReached(capStore, c.campaign_id, placement, perDay, today);
    });
    if (!servable.length) return [];
    // Uniform-random single slot (rotates across advertisers per fetch).
    const c = servable[Math.floor(Math.random() * servable.length)];
    const { content, assigned } = selectAdContent(c, stickyStore);
    if (!content) return [];
    if (assigned) { stickyStore[c.campaign_id] = assigned; await _adSet(AD_STICKY_KEY, stickyStore); }
    return [{ campaign: c, content, placement }];
  }

  // Record that a campaign was actually served at this placement, toward its daily
  // frequency cap (design §6). Serving-side (NOT measurement) — no beacon. Deduped
  // per JS context so re-renders within one page load count a single serve; a fresh
  // page load / SW wake counts again (≈ shows/day, coarse cap granularity is fine).
  const _adServedSession = new Set();
  async function noteAdServed(campaignId, placement, now = Date.now()) {
    if (!campaignId || !placement) return;
    const memKey = _adCapId(campaignId, placement);
    if (_adServedSession.has(memKey)) return;
    _adServedSession.add(memKey);
    const capStore = (await _adGet(AD_CAP_KEY)) || {};
    const today = _adDayKey(now);
    const e = capStore[memKey];
    if (e && e.day === today) e.count += 1;
    else capStore[memKey] = { day: today, count: 1 };
    await _adSet(AD_CAP_KEY, capStore);
  }

  // ── Measurement seam (Phase 2) ──────────────────────────────────────────────
  // Serving (above) and measurement are intentionally separate (design §5.1).
  // Content scripts NEVER touch the counter storage directly — they only detect
  // viewability/click here and SEND A MESSAGE to the background service worker,
  // which is the SINGLE OWNER of all ad counters (increments AND flushes are
  // serialized there through one op-chain, so there are no read-modify-write races
  // across tabs — design §5.4/§5.4.1). These helpers must never throw into render.
  const AD_METRIC_MSG = 'ad_metric';        // { type, kind:'impression'|'click', campaign, content, placement }
  const AD_FLUSH_HINT_MSG = 'ad_flush_hint'; // best-effort tail flush on tab hide / pagehide

  // Fire a counter message at the SW. The SW may be asleep or the extension context
  // may be invalidated (navigation) — both surface as a throw here; swallow it.
  function _adSendMetric(msg) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* SW asleep / context invalidated */ }
  }

  // Per-key impression/click dedup windows (Date.now() ms). Keyed by the creative
  // identity (campaign|content|placement) so a sidebar re-render (which mints a NEW
  // element on every periodic refresh) can't re-count the SAME creative each refresh.
  // Scope is one content-script instance (module-level Map), which is the right grain:
  // a genuinely fresh page load / SW wake starts clean.
  const AD_IMPRESSION_DEDUP_MS = 10 * 60 * 1000; // ≤1 impression per creative / 10min
  const AD_CLICK_DEDUP_MS = 1000;                // collapse click bursts / double-fires
  const _adImpressionSeen = new Map(); // key → lastFiredMs
  const _adClickSeen = new Map();      // key → lastFiredMs
  function _adKey(ad) {
    return ad.campaign.campaign_id + '|' + ad.content.content_id + '|' + ad.placement;
  }

  // Viewability-gated impression (design §5.2): count ONE impression per creative when
  // it stays >=50% visible in a visible tab for 1s. Deduped BOTH per element (__ctViz,
  // cheap) and per creative key (10-min window) so refresh re-renders don't inflate.
  // The 1s timer's fire path REVALIDATES visibility+intersection at fire time; it only
  // disconnects/dedups on a SUCCESSFUL fire, otherwise it re-arms when viewable again.
  //
  // `guard` (optional, from createInstanceGuard) is what makes the dedup survive a
  // content-script RE-INJECTION. The 10-min dedup map lives in this closure, and a new
  // instance gets a fresh one — so a superseded instance whose observer/timer is still
  // armed must never fire: it would count an impression the new instance is free to
  // count again. The observer and its pending timer are therefore registered for
  // teardown, and fire() re-checks that this instance still owns the page.
  function trackAdViewability(el, ad, guard) {
    if (!el || el.__ctViz || !ad || !ad.campaign || !ad.content) return;
    if (typeof IntersectionObserver !== 'function') return;
    const key = _adKey(ad);
    const seen = _adImpressionSeen.get(key);
    if (seen && (Date.now() - seen) < AD_IMPRESSION_DEDUP_MS) return; // already counted this window — don't even observe
    el.__ctViz = true;
    let intersecting = false; // live viewability, updated on every IO callback
    let timer = null;
    let obs;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    // Clear a pending timer the moment the tab is hidden mid-wait so it can't fire
    // against a hidden tab; removed on disconnect to avoid a listener leak.
    const onVis = () => { if (document.visibilityState !== 'visible') clear(); };
    const disconnect = () => {
      clear();
      obs.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
    const fire = () => {
      timer = null;
      // Superseded by a newer instance, or our element was unmounted → stop for good.
      // Firing here would double-count: the new instance's dedup map is empty.
      if ((guard && !guard.isCurrent()) || !el.isConnected) { disconnect(); return; }
      // Revalidate at fire time: only a still-viewable ad in a visible tab counts.
      if (document.visibilityState !== 'visible' || intersecting !== true) return; // not viewable now → keep observing, re-arm on re-entry
      disconnect();
      _adImpressionSeen.set(key, Date.now());
      _adSendMetric({
        type: AD_METRIC_MSG, kind: 'impression',
        campaign: ad.campaign.campaign_id, content: ad.content.content_id, placement: ad.placement,
      });
    };
    obs = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      intersecting = !!(entry && entry.isIntersecting && entry.intersectionRatio >= 0.5);
      const viewable = intersecting && document.visibilityState === 'visible';
      if (viewable) { if (!timer) timer = setTimeout(fire, 1000); }
      else { clear(); } // left viewport / tab hidden before 1s → restart on re-entry
    }, { threshold: [0, 0.5] });
    document.addEventListener('visibilitychange', onVis);
    obs.observe(el);
    // disconnect() clears the pending timer too, so teardown leaves nothing armed.
    if (guard) guard.addObserver({ disconnect });
  }

  // Click counter (design §5.3). Fire-and-forget message. Ignores synthetic clicks
  // (isTrusted === false) and collapses same-creative bursts within AD_CLICK_DEDUP_MS
  // (double-fire / click fraud). A genuine repeat click after the window still counts.
  function trackAdClick(ad, e) {
    if (!ad || !ad.campaign || !ad.content) return;
    if (e && e.isTrusted === false) return; // synthetic click → ignore
    const key = _adKey(ad);
    const seen = _adClickSeen.get(key);
    const now = Date.now();
    if (seen && (now - seen) < AD_CLICK_DEDUP_MS) return; // dup within window
    _adClickSeen.set(key, now);
    _adSendMetric({
      type: AD_METRIC_MSG, kind: 'click',
      campaign: ad.campaign.campaign_id, content: ad.content.content_id, placement: ad.placement,
    });
  }

  // Best-effort tail flush: nudge the SW to flush counters now (tab hiding / pagehide)
  // so short sessions don't wait for the periodic flush alarm (design §5.4).
  function sendAdFlushHint() {
    try { chrome.runtime.sendMessage({ type: AD_FLUSH_HINT_MSG }).catch(() => {}); } catch { /* SW asleep / context invalidated */ }
  }

  function _adSafeUrl(u) {
    const s = String(u || '').trim();
    return /^https?:\/\//i.test(s) ? s : '';
  }

  // Build one self-contained, theme-neutral ad banner. Inline styles (no CSS-file
  // dependency) so the identical markup renders in the popup + all three provider
  // sidebars, which each have different theme systems. The outer element carries
  // data-ad-url (click target) + data-ad-key (stable identity for the measurement
  // seam); the caller wires the click/impression handlers (open mechanism differs
  // per surface). An "Ad"/"광고" source label is shown for brand safety (design §12).
  function buildAdBannerHtml(ad, lang) {
    const c = ad.content || {};
    const img = _adSafeUrl(c.image_url);
    const url = _adSafeUrl(c.url);
    const key = escapeHtml(ad.campaign.campaign_id + '|' + c.content_id + '|' + ad.placement);
    const tooltip = lang === 'ko'
      ? 'Claude Tuner가 게재하는 광고입니다. 광고 문의하려면 클릭하세요.'
      : 'Ad shown by Claude Tuner. Click to advertise with us.';
    // "Corner badge" layout: the disclosure mark is taken OUT OF FLOW (absolute, pinned to
    // the banner's top-left) instead of occupying its own leading line. The leading-line
    // version cost a full row of vertical space in a 230px-wide sidebar for a 9px chip.
    // Out of flow, the logo + headline row starts at the top and the banner is ~14px shorter.
    let h = '<div class="ct-ad-banner" data-ad-key="' + key + '"'
      + (url ? ' data-ad-url="' + escapeHtml(url) + '"' : '')
      + ' style="position:relative;width:100%;box-sizing:border-box;'
      + 'border:1px solid rgba(128,128,128,0.28);border-radius:10px;padding:8px 10px;margin:6px 0;'
      + 'box-shadow:0 1px 2px rgba(0,0,0,0.04);font-family:inherit;'
      + (url ? 'cursor:pointer;' : '') + '">';
    // Disclosure badge: out of flow, pinned to the banner's top-RIGHT corner. Top-left
    // would land on the creative's logo (34px, vertically centred) and read as dirty,
    // especially over a light logo tile on a dark theme. Right-aligned it collides with
    // nothing — only the headline's first line, which reserves room for it below.
    // Deliberately low-contrast (outline only, no fill) so it recedes — but the outline
    // STAYS: it is what reads the mark as a disclosure rather than part of the ad copy.
    // Don't fade it further; an ad label has to remain plainly recognisable.
    // It stays an advertiser-inquiry link: hover discloses it's an ad, click opens the
    // inquiry form. Each surface's banner click handler ignores clicks inside
    // .ct-ad-label so the ad URL isn't opened too.
    h += '<a class="ct-ad-label" href="' + escapeHtml(AD_INQUIRY_URL) + '" target="_blank" rel="noopener noreferrer"'
      + ' title="' + escapeHtml(tooltip) + '"'
      + ' style="position:absolute;top:2px;right:3px;z-index:1;'
      + 'font-size:7.5px;font-weight:600;letter-spacing:0.03em;line-height:11px;padding:0 2px;'
      + 'border:1px solid rgba(128,128,128,0.22);border-radius:3px;'
      + 'background:none;opacity:0.45;'
      + 'text-decoration:none;color:inherit;cursor:pointer;white-space:nowrap">AD</a>';
    // Content row: logo (only if present) + full-width headline/subtitle. No leading chip
    // above it any more — the badge floats over this row's top-right corner.
    h += '<div style="display:flex;align-items:center;gap:8px">';
    if (img) {
      h += '<img src="' + escapeHtml(img) + '" alt="" style="width:34px;height:34px;'
        + 'border-radius:9px;object-fit:cover;flex-shrink:0" />';
    }
    h += '<div style="flex:1;min-width:0">';
    // padding-right reserves exactly the strip the badge floats over, so the headline can
    // never run underneath it. 12px is measured, not guessed: the badge is 17px wide and
    // overhangs the text column by ~10px, and anything wider (a 20px badge, or 16px+ of
    // padding) pushes this headline onto a SECOND line and gives back all the height we
    // just saved. Only the headline needs it — the body sits below the badge.
    // No bold: the headline inherits the surface's normal weight so the banner reads as
    // part of the panel rather than shouting over it.
    h += '<div style="font-size:13px;line-height:1.25;padding-right:12px">'
      + escapeHtml(c.title || '') + '</div>';
    if (c.body) {
      h += '<div style="font-size:10.5px;opacity:0.6;margin-top:1px;line-height:1.3;'
        + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(c.body) + '</div>';
    }
    h += '</div>';
    h += '</div>';
    h += '</div>';
    return h;
  }

  // ── What the ChatGPT account percentage does NOT include ──
  //
  // 🔴 CANONICAL COPY FOR THE EXTENSION. Two panels are injected into chatgpt.com at once
  // (chatgpt-sidebar.js and chatgpt-input.js, both in background.js CHATGPT_INJECT), and they
  // render the SAME number. Marking one and not the other is worse than marking neither: the user
  // compares them and reads the unmarked one as "so THIS is the chat gauge". Keeping the string
  // here is what makes "both panels say the same thing" structural instead of a thing to remember.
  //
  // OpenAI dropped the text-chat message cap on 2026-08-06 and on 08-25 reinstated a 5h cap for
  // Codex / ChatGPT Work only, so this percentage counts everything EXCEPT text chat. Two users
  // (문의 #195, #196) read it as chat usage, and our first reply to #195 got it wrong too.
  //
  // ⚠️ The dashboard has its OWN copy — `gauge_note_chatgpt` in site/dashboard/dashboard-i18n.js.
  // That is a runtime boundary (CWS extension vs CF Pages), so the copy is unavoidable; the drift
  // is not. test/chatgpt-astra-obs-guard.mjs asserts the two stay word-for-word identical.
  //
  // 🪤 No double quote in either locale: consumers interpolate this into a title="..." attribute,
  // where one would truncate the tooltip mid-sentence.
  const CG_USAGE_NOTE = {
    ko: '이 값에는 Codex 등 텍스트 채팅 외 사용이 포함됩니다. 텍스트 채팅은 2026년 8월부터 한도가 없어 이 수치에 잡히지 않습니다.',
    en: 'This includes usage outside text chat, such as Codex. Text chat has had no cap since August 2026, so it is not counted here.',
  };
  function cgUsageNote(lang) { return CG_USAGE_NOTE[lang] || CG_USAGE_NOTE.en; }

  // ── Usage-limit reset pass holdings chip (#2092 P1-1) ────────────────────────────────────────
  //
  // 🔴 CANONICAL COPY FOR THE EXTENSION. The popup / side panel (ESM, loads this file — see
  // popup.html) and the in-page sidebars (classic content scripts) draw the SAME one-line chip from
  // the org's `resetPasses` summary (bg/reset-pass-model.js shape). Building it here once is what
  // keeps the two from disagreeing about whether a pass exists.
  //
  // Rules (docs/plans/usage-reset-passes.md §3 P1-1):
  //   · `known:false` (field absent / ineligible / unreadable) and `available: 0` both render
  //     NOTHING. 「모름」 must never read as 「0장」, and 0 passes is not worth a line.
  //   · kinds with a zero count are left out; when the kinds are not known (ChatGPT before its
  //     detail read) the chip says only the total.
  //   · expiry is a DATE (10/23), never "N days left": a countdown would change the HTML on every
  //     collection and re-render the surfaces (and drop a hovered tooltip) for nothing.
  //   · the link is NOT built here: the caller passes it, made by bg/reset-pass-model.js
  //     resetPassSiteUrl (the one place the two settings pages are spelled — ESM, which this classic
  //     script cannot import; the SW hands it to the in-page panels as payload `rpUrl`). No url →
  //     no chip, so a stale caller can never point it somewhere else. Passes are spent on the
  //     provider's page, never from the extension (§4).
  //
  // 🪤 No double quote in any string below: the title is interpolated into title="...".
  const RESET_PASS_WARN_DAYS = 3;
  // ↻ in currentColor — the same mark as the popup overview's 「↻ RESET」 badge. Replaces 🎟, which
  // renders as a grey slanted ticket on most systems (user, 2026-10-05: 「어글리」).
  const RP_ICON_SVG = '<svg width=\'11\' height=\'11\' viewBox=\'0 0 16 16\' fill=\'none\' stroke=\'currentColor\''
    + ' stroke-width=\'2.4\' stroke-linecap=\'round\' stroke-linejoin=\'round\' aria-hidden=\'true\''
    + ' style=\'flex:none;vertical-align:-1px;margin-right:3px\'><path d=\'M13.5 8a5.5 5.5 0 1 1-1.8-4.1\'/>'
    + '<path d=\'M13.5 2.5v3.2h-3.2\'/></svg>';
  const RESET_PASS_DAY_MS = 86400000;
  const RESET_PASS_KINDS = ['full', 'five_hour', 'weekly'];
  const RP_UI_TEXT = {
    ko: {
      rp_ui_chip_name: '초기화 패스',
      rp_ui_kind_full: '전체 {n}',
      rp_ui_kind_five_hour: '5시간 {n}',
      rp_ui_kind_weekly: '주간 {n}',
      rp_ui_chip_total: '{n}장 보유',
      rp_ui_chip_expires: '{d} 만료',
      rp_ui_line_now: '지금 풀 수 있어요',
      rp_ui_chip_cg_scope: 'Codex·Work 한도만',
      rp_ui_tip_held: '사용 한도 초기화 패스 {n}장 보유',
      rp_ui_tip_kinds: '종류: {k}',
      rp_ui_tip_expires: '가장 빠른 만료: {d}',
      rp_ui_tip_cg_scope: 'ChatGPT 패스는 Codex·Work 한도에만 적용돼요(채팅 한도 제외)',
      rp_ui_tip_click: '클릭하면 사용량 설정이 열려요 — 거기서 바로 사용할 수 있어요',
      rp_ui_help_tip_claude: '전체 초기화는 5시간 및 주간 사용량 제한을 다시 채웁니다. 5시간 초기화는 5시간 사용량 제한을 다시 채웁니다.',
      rp_ui_help_tip_chatgpt: '초기화를 사용해 5시간 한도나 주간 한도, 또는 두 한도를 모두 복원하세요. Codex·Work 한도에만 적용됩니다(채팅 제외).',
      rp_ui_help_more: '? 를 누르면 도움말이 열립니다.',
      rp_ui_tk_head: '초기화 패스 {n}장',
      rp_ui_tk_label_full: '전체',
      rp_ui_tk_label_five_hour: '5시간',
      rp_ui_tk_label_weekly: '주간',
      rp_ui_tk_what_full: '전체 초기화 — 5시간 + 주간 한도',
      rp_ui_tk_what_five_hour: '5시간 초기화 — 5시간 한도만',
      rp_ui_tk_what_weekly: '주간 초기화 — 주간 한도만',
      rp_ui_tk_expires: '{d} 만료',
      rp_ui_tk_soon: '3일 안에 만료돼요',
      rp_ui_tk_click: '클릭하면 사용량 설정이 열려요',
      rp_ui_tk_more: '+{n}',
      rp_ui_tk_more_tip: '{n}장 더 있어요 — 클릭하면 사용량 설정에서 전부 볼 수 있어요',
    },
    en: {
      rp_ui_chip_name: 'Reset passes',
      rp_ui_kind_full: 'Full {n}',
      rp_ui_kind_five_hour: '5-hour {n}',
      rp_ui_kind_weekly: 'Weekly {n}',
      rp_ui_chip_total: '{n} held',
      rp_ui_chip_expires: 'expires {d}',
      rp_ui_line_now: 'clear it now',
      rp_ui_chip_cg_scope: 'Codex & Work limits only',
      rp_ui_tip_held: 'Usage limit reset passes held: {n}',
      rp_ui_tip_kinds: 'Kinds: {k}',
      rp_ui_tip_expires: 'Earliest expiry: {d}',
      rp_ui_tip_cg_scope: 'ChatGPT passes apply to Codex & Work limits only (not chat)',
      rp_ui_tip_click: 'Click to open the usage settings — you can use a pass right there',
      rp_ui_help_tip_claude: 'A full reset refills your 5-hour and weekly usage limits. A 5-hour reset refills your 5-hour usage limit.',
      rp_ui_help_tip_chatgpt: 'Use a reset to restore your 5-hour limit, weekly limit, or both. Applies to Codex & Work limits only (not chat).',
      rp_ui_help_more: 'Click ? to open the help article.',
      rp_ui_tk_head: 'Reset passes: {n}',
      rp_ui_tk_label_full: 'Full',
      rp_ui_tk_label_five_hour: '5-hour',
      rp_ui_tk_label_weekly: 'Weekly',
      rp_ui_tk_what_full: 'Full reset — 5-hour + weekly limits',
      rp_ui_tk_what_five_hour: '5-hour reset — 5-hour limit only',
      rp_ui_tk_what_weekly: 'Weekly reset — weekly limit only',
      rp_ui_tk_expires: 'expires {d}',
      rp_ui_tk_soon: 'Expires within 3 days',
      rp_ui_tk_click: 'Click to open the usage settings',
      rp_ui_tk_more: '+{n}',
      rp_ui_tk_more_tip: '{n} more — open the usage settings to see them all',
    },
  };
  function rpText(lang, key, vars) {
    const table = RP_UI_TEXT[lang] || RP_UI_TEXT.en;
    let s = table[key] || RP_UI_TEXT.en[key] || '';
    for (const k in (vars || {})) s = s.replace('{' + k + '}', String(vars[k]));
    return s;
  }
  function rpCount(n) { return Number.isInteger(n) && n > 0 ? n : 0; }
  /**
   * The chip as data — `{ text, title, url, warn }` — or null when nothing may be shown.
   * `url` = resetPassSiteUrl(provider, SITE_ORIGINS) from the caller; `provider` defaults to the
   * summary's own.
   */
  function resetPassChip(summary, lang, nowMs, provider, url) {
    const s = summary;
    if (!s || typeof s !== 'object' || s.known !== true) return null;
    const total = rpCount(s.available);
    if (!total) return null;
    const pv = provider || s.provider;
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) return null;
    const kinds = s.by_kind || {};
    const kindParts = RESET_PASS_KINDS
      .filter((k) => rpCount(kinds[k]) > 0)
      .map((k) => rpText(lang, 'rp_ui_kind_' + k, { n: rpCount(kinds[k]) }));
    // Kinds are shown only when the summary says it knows them AND they carry a count — a
    // ChatGPT summary read before its detail fetch has `available` but all-zero kinds.
    const kindsKnown = s.kinds_known !== false && kindParts.length > 0;
    const parts = [rpText(lang, 'rp_ui_chip_name')];
    if (kindsKnown) parts.push(...kindParts);
    else parts.push(rpText(lang, 'rp_ui_chip_total', { n: total }));
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const expMs = s.next_expires_at ? Date.parse(s.next_expires_at) : NaN;
    let warn = false;
    if (Number.isFinite(expMs)) {
      const d = new Date(expMs);
      parts.push(rpText(lang, 'rp_ui_chip_expires', { d: `${d.getMonth() + 1}/${d.getDate()}` }));
      warn = expMs - now <= RESET_PASS_WARN_DAYS * RESET_PASS_DAY_MS;
    }
    // ChatGPT passes clear the Codex / Work limits only — the same meaning as its gauge, but a
    // user reading "초기화 패스" beside a chat they cannot send would otherwise expect it to help.
    if (pv === 'chatgpt') parts.push(rpText(lang, 'rp_ui_chip_cg_scope'));
    return { text: parts.join(' · '), title: resetPassDetailTip(s, lang, pv), url, warn };
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  /**
   * The hover text of every holdings line (chip, 7d note, headline link): count, kinds, the
   * earliest expiry as date AND local time, the ChatGPT scope, and what a click does. Static for
   * an unchanged summary (no countdown), so a re-render with the same data keeps the tooltip.
   * Empty string when the summary may not be shown (「모름」 / 0 passes).
   */
  function resetPassDetailTip(summary, lang, provider) {
    const s = summary;
    if (!s || typeof s !== 'object' || s.known !== true) return '';
    const total = rpCount(s.available);
    if (!total) return '';
    const pv = provider || s.provider;
    const lines = [rpText(lang, 'rp_ui_tip_held', { n: total })];
    const kinds = s.by_kind || {};
    const kindParts = RESET_PASS_KINDS
      .filter((k) => rpCount(kinds[k]) > 0)
      .map((k) => rpText(lang, 'rp_ui_kind_' + k, { n: rpCount(kinds[k]) }));
    if (s.kinds_known !== false && kindParts.length) lines.push(rpText(lang, 'rp_ui_tip_kinds', { k: kindParts.join(', ') }));
    const expMs = s.next_expires_at ? Date.parse(s.next_expires_at) : NaN;
    if (Number.isFinite(expMs)) {
      const d = new Date(expMs);
      lines.push(rpText(lang, 'rp_ui_tip_expires',
        { d: `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` }));
    }
    if (pv === 'chatgpt') lines.push(rpText(lang, 'rp_ui_tip_cg_scope'));
    lines.push(rpText(lang, 'rp_ui_tip_click'));
    return lines.join('\n');
  }
  /** The 「?」 help link HTML (empty unless `helpUrl` is https). Shared by every holdings line. */
  function buildResetPassHelpHtml(lang, helpUrl, provider) {
    if (typeof helpUrl !== 'string' || !/^https:\/\//.test(helpUrl)) return '';
    // What a pass DOES, in the provider's own words (claude.ai 「5시간 및 주간 사용량 제한을 다시
    // 채웁니다」 · chatgpt.com 「5시간 한도나 주간 한도, 또는 두 한도를 모두 복원하세요」), then
    // where the click goes. ChatGPT passes cover Codex/Work only.
    const what = rpText(lang, provider === 'chatgpt' ? 'rp_ui_help_tip_chatgpt' : 'rp_ui_help_tip_claude');
    const tip = escapeHtml(what + '\n' + rpText(lang, 'rp_ui_help_more'));
    return '<a class="ct-rp-help" href="' + escapeHtml(helpUrl) + '" target="_blank" rel="noopener noreferrer"'
      + ' title="' + tip + '" aria-label="' + tip + '"'
      + ' style="flex:none;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;'
      + 'border-radius:50%;border:1px solid currentColor;font-size:9px;line-height:1;text-decoration:none;'
      + 'color:inherit;opacity:0.6;cursor:help">?</a>';
  }
  /** The chip as one HTML line (empty string when hidden). `cls` = the surface's extra class. */
  // Ticket chips (#2092, user choice 2026-10-05): one small ticket per held pass — kind on the left
  // of a dashed perforation, expiry date on the right, amber when it expires within 3 days, the
  // earliest first. Drawn only when the summary knows each pass (`kinds_known` + `tickets`);
  // otherwise the one-line chip below stands. Inline styles: the in-page sidebars load no CSS of
  // ours, and the colours are translucent so they read on light and dark pages alike.
  const RESET_PASS_TICKETS_SHOWN = 6;
  const RP_TICKET_COLORS = {
    full: ['#6a58d6', 'rgba(106,88,214,0.15)'],
    five_hour: ['#17845f', 'rgba(23,132,95,0.15)'],
    weekly: ['#2f6bcf', 'rgba(47,107,207,0.15)'],
  };
  // Kind colours are tint / band / perforation only — the text inherits the page colour, so it keeps
  // its contrast on light and dark pages alike (Codex 1R 후속: coloured 10.5px text was ~3:1).
  const RP_SOON_COLOR = '#d97706';
  const RP_SOON_BG = 'rgba(217,119,6,0.22)';
  function rpDateTime(ms) {
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  function buildResetPassTicketsHtml(summary, lang, nowMs, provider, url, cls, helpUrl) {
    const s = summary;
    if (!s || typeof s !== 'object' || s.known !== true || s.kinds_known !== true) return '';
    const total = rpCount(s.available);
    const tickets = Array.isArray(s.tickets) ? s.tickets.filter((x) => x && Object.hasOwn(RP_TICKET_COLORS, x.kind)
      && Number.isFinite(Date.parse(x.expires_at))) : [];
    if (!total || !tickets.length) return '';
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) return '';
    const pv = provider || s.provider;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const link = (inner, title, style, extraCls) => '<a class="' + extraCls + '" href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer"'
      + ' title="' + escapeHtml(title) + '" aria-label="' + escapeHtml(title.replace(/\n/g, ' · ')) + '" style="' + style + '">' + inner + '</a>';
    const head = '<div style="display:flex;align-items:center;gap:5px;min-width:0;font-size:11px;line-height:1.4">'
      + link(RP_ICON_SVG + escapeHtml(rpText(lang, 'rp_ui_tk_head', { n: total }))
          + (pv === 'chatgpt' ? '<span style="opacity:0.65;font-weight:400"> · ' + escapeHtml(rpText(lang, 'rp_ui_chip_cg_scope')) + '</span>' : ''),
        resetPassDetailTip(s, lang, pv), 'color:inherit;text-decoration:none;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0', 'ct-rp-head')
      + buildResetPassHelpHtml(lang, helpUrl, pv)
      + '</div>';
    const shown = tickets.slice(0, RESET_PASS_TICKETS_SHOWN);
    let chips = '';
    for (const tk of shown) {
      const exp = Date.parse(tk.expires_at);
      const soon = exp - now <= RESET_PASS_WARN_DAYS * RESET_PASS_DAY_MS;
      const [fg, bg] = RP_TICKET_COLORS[tk.kind];
      const d = new Date(exp);
      const tip = [rpText(lang, 'rp_ui_tk_what_' + tk.kind), rpText(lang, 'rp_ui_tk_expires', { d: rpDateTime(exp) })]
        .concat(soon ? [rpText(lang, 'rp_ui_tk_soon')] : [], [rpText(lang, 'rp_ui_tk_click')]).join('\n');
      chips += link(
        '<span style="padding:2px 6px;font-weight:700;border-left:3px solid ' + fg + ';border-radius:5px 0 0 5px">'
          + escapeHtml(rpText(lang, 'rp_ui_tk_label_' + tk.kind)) + '</span>'
          + '<span style="padding:2px 6px;border-left:1.5px dashed ' + fg + ';font-variant-numeric:tabular-nums'
          + (soon ? ';font-weight:700;background:' + RP_SOON_BG : '') + '">' + (d.getMonth() + 1) + '/' + d.getDate() + '</span>',
        tip,
        // Text takes the page's own colour (readable on any sidebar theme); the kind colour is the
        // tint, the left band and the perforation, amber marks a pass expiring within 3 days.
        'display:inline-flex;align-items:stretch;border-radius:5px;font-size:10.5px;line-height:1.5;text-decoration:none;'
          + 'color:inherit;background:' + bg + ';border:1px solid ' + (soon ? RP_SOON_COLOR : 'transparent'),
        'ct-rp-ticket' + (soon ? ' is-soon' : ''));
    }
    const more = total - shown.length;
    if (more > 0) {
      chips += link(escapeHtml(rpText(lang, 'rp_ui_tk_more', { n: more })), rpText(lang, 'rp_ui_tk_more_tip', { n: more }),
        'display:inline-flex;align-items:center;padding:2px 6px;border-radius:5px;font-size:10.5px;text-decoration:none;color:inherit;opacity:0.7;border:1px dashed currentColor',
        'ct-rp-more');
    }
    return '<div class="ct-rp-row ct-rp-tickets' + (cls ? ' ' + escapeHtml(cls) : '') + '" style="display:grid;gap:4px;min-width:0">'
      + head + '<div style="display:flex;flex-wrap:wrap;gap:4px">' + chips + '</div></div>';
  }
  // The in-page sidebars' version (user, 2026-10-05: the ticket chips 「too loud」 inside
  // chatgpt.com / claude.ai): ONE line in the site's own secondary text colour (`textClass`, the
  // class the panel already uses for its labels), the label size, no tint, no border, no 「?」 —
  // 「↻ 초기화 패스 3장 · 10/5 만료」. Each pass and its expiry, the ChatGPT scope and the click
  // target live in the tooltip. Emphasis only when it matters, in amber via the `ct-rp-hot` class
  // (each sidebar's CSS picks a dark amber on light pages, a light one on dark — #f59e0b at 12px on
  // white is 2.15:1, Codex 1R): the date of a pass expiring within
  // 3 days, or 「· 지금 풀 수 있어요」 when one pass clears every window blocked now (`clearNow`,
  // decided in bg/sidebar-usage.js by canClearNow — this classic script cannot import it). The
  // popup keeps the ticket chips (buildResetPassChipHtml) — that surface is ours.
  function buildResetPassLineHtml(summary, lang, nowMs, provider, url, textClass, clearNow) {
    const s = summary;
    if (!s || typeof s !== 'object' || s.known !== true) return '';
    const total = rpCount(s.available);
    if (!total || typeof url !== 'string' || !/^https:\/\//.test(url)) return '';
    const pv = provider || s.provider;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const tickets = s.kinds_known === true && Array.isArray(s.tickets)
      ? s.tickets.filter((x) => x && Object.hasOwn(RP_TICKET_COLORS, x.kind) && Number.isFinite(Date.parse(x.expires_at))) : [];
    const exps = (tickets.length ? tickets.map((x) => x.expires_at) : [s.next_expires_at])
      .map((x) => (x ? Date.parse(x) : NaN)).filter((x) => Number.isFinite(x) && x > now);
    const first = exps.length ? Math.min(...exps) : NaN;
    const soon = Number.isFinite(first) && first - now <= RESET_PASS_WARN_DAYS * RESET_PASS_DAY_MS;
    let date = '';
    if (Number.isFinite(first)) {
      const d = new Date(first);
      date = escapeHtml(rpText(lang, 'rp_ui_chip_expires', { d: `${d.getMonth() + 1}/${d.getDate()}` }));
      if (soon) date = '<b class="ct-rp-hot" style="font-weight:600">' + date + '</b>';
    }
    const tip = [rpText(lang, 'rp_ui_tk_head', { n: total })]
      .concat(tickets.slice(0, RESET_PASS_TICKETS_SHOWN).map((x) => rpText(lang, 'rp_ui_tk_label_' + x.kind)
        + ' · ' + rpText(lang, 'rp_ui_tk_expires', { d: rpDateTime(Date.parse(x.expires_at)) })))
      .concat(tickets.length > RESET_PASS_TICKETS_SHOWN ? [rpText(lang, 'rp_ui_tk_more', { n: tickets.length - RESET_PASS_TICKETS_SHOWN })] : [])
      .concat(!tickets.length ? [resetPassDetailTip(s, lang, pv)] : [])
      .concat(pv === 'chatgpt' && tickets.length ? [rpText(lang, 'rp_ui_tip_cg_scope')] : [])
      .concat(tickets.length ? [rpText(lang, 'rp_ui_tip_click')] : [])
      .filter(Boolean).join('\n');
    return '<a class="ct-rp-line' + (textClass ? ' ' + escapeHtml(textClass) : '') + '" href="' + escapeHtml(url) + '"'
      + ' target="_blank" rel="noopener noreferrer" title="' + escapeHtml(tip) + '" aria-label="' + escapeHtml(tip.replace(/\n/g, ' · ')) + '"'
      + ' style="display:flex;align-items:center;min-width:0;font-size:12px;line-height:1.4;text-decoration:none">'
      + RP_ICON_SVG
      + '<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">'
      // In the 「clear it now」 state the date gives way to the action: a ~250px sidebar would
      // otherwise ellipsize exactly the part that matters (the date stays in the tooltip).
      + escapeHtml(rpText(lang, 'rp_ui_tk_head', { n: total })) + (date && clearNow !== true ? ' · ' + date : '')
      + (clearNow === true ? ' · <b class="ct-rp-hot" style="font-weight:600">'
        + escapeHtml(rpText(lang, 'rp_ui_line_now')) + ' ↗</b>' : '')
      + '</span></a>';
  }
  function buildResetPassChipHtml(summary, lang, nowMs, provider, url, cls, helpUrl) {
    const tickets = buildResetPassTicketsHtml(summary, lang, nowMs, provider, url, cls, helpUrl);
    if (tickets) return tickets;
    const chip = resetPassChip(summary, lang, nowMs, provider, url);
    if (!chip) return '';
    const title = escapeHtml(chip.title);
    // One row: the chip link (ellipsis) + the 「?」 help link. The row, not the chip, carries `cls`.
    return '<div class="ct-rp-row' + (cls ? ' ' + escapeHtml(cls) : '') + '"'
      + ' style="display:flex;align-items:center;gap:4px;min-width:0">'
      + '<a class="ct-rp-chip' + (chip.warn ? ' is-warn' : '') + '"'
      + ' href="' + escapeHtml(chip.url) + '" target="_blank" rel="noopener noreferrer"'
      + ' title="' + title + '" aria-label="' + escapeHtml(chip.text) + ' — ' + title + '"'
      + ' style="display:block;min-width:0;font-size:11px;line-height:1.4;text-decoration:none;cursor:pointer;'
      + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
      + (chip.warn ? 'color:#d97706;font-weight:600' : 'color:inherit;opacity:0.75') + '">'
      + RP_ICON_SVG + escapeHtml(chip.text) + '</a>'
      + buildResetPassHelpHtml(lang, helpUrl, provider || (summary && summary.provider))
      + '</div>';
  }

  // Why an in-page panel has nothing to draw, as one short sentence (#852 in-page remainder, #1592).
  //
  // The panels used to say "수집 중..." for every empty answer, which is a claim — that data is
  // coming — and it was false whenever collection was failing. bg/sidebar-usage.js now answers
  // `{ err: <stored code> }` in that case; this turns the code into copy, ONCE, for all four
  // panels (chatgpt/gemini × input/sidebar), which are classic scripts with inline i18n and would
  // otherwise carry four copies of ten sentences.
  //
  // Bucketed, not per code: a strip is one line and a sidebar row not much more. The popup keeps
  // the per-code sentence with a button (provider-state.js / i18n.js); this only has to stop the
  // panel lying and point at where the full answer is. An UNKNOWN code — a newer background than
  // this injected script, or a future family — reads as the generic "couldn't fetch", never as
  // "collecting".
  //
  // 🪤 No double quote in either locale (interpolated into title="..." by some callers).
  const NO_DATA_REASON_BUCKETS = [
    // session problems — signed out, expired, or a token we could not read. Worded as "check your
    // sign-in", not "you are signed out": no_at_token and auth_failed:403 also arise on a signed-in
    // session (Codex R1), so the observation supports a prompt, not a verdict.
    { re: /_(not_logged_in|session_expired|no_cookies|no_at_token|auth_failed)$/, key: 'login' },
    // the provider is refusing us — time fixes it, not the user
    { re: /_(cloudflare|rate_limit)$/, key: 'blocked' },
    { re: /_network$/, key: 'network' },
  ];
  const NO_DATA_REASON_TEXT = {
    ko: {
      login: '{p} 로그인 상태를 확인해 주세요 — 사용량을 못 가져옵니다',
      blocked: '{p}가 요청을 막고 있습니다 — 잠시 후 다시 시도합니다',
      network: '네트워크 오류 — 잠시 후 다시 시도합니다',
      failed: '{p} 사용량을 가져오지 못했습니다 — 확장 팝업에서 확인',
    },
    en: {
      login: 'Check your {p} sign-in — usage unavailable',
      blocked: '{p} is blocking requests — retrying later',
      network: 'Network error — retrying later',
      failed: 'Could not fetch {p} usage — see the extension popup',
    },
  };
  function noDataReason(code, lang, providerName) {
    const base = String(code || '').split(':')[0];
    const bucket = (NO_DATA_REASON_BUCKETS.find((b) => b.re.test(base)) || { key: 'failed' }).key;
    const table = NO_DATA_REASON_TEXT[lang] || NO_DATA_REASON_TEXT.en;
    return table[bucket].replace('{p}', providerName || '');
  }

  // The composer strip's compare button may not cost a line.
  //
  // Every strip (claude.ai / chatgpt.com / gemini.google.com) is a wrapping flex row: usage %, a
  // bar, the reset countdown, sometimes extra usage, then the gear and the 「…에도 물어보기」
  // button. Narrow the composer and the button is the first thing pushed onto a second line —
  // and a second line under the composer reads as a broken layout, not as a feature. So the rule
  // is measured, not guessed from a breakpoint (the width the button needs depends on the plan's
  // segments and the language): draw it, see whether the strip got taller, and if it did, take
  // the button out. Widen the composer again and the same measurement puts it back.
  //
  // Inline style, not the `hidden` attribute: `.ct-cmp-btn { display: inline-flex }` out-ranks
  // the UA's `[hidden] { display: none }`.
  //
  // Two synchronous layouts per call; the callers run it on render and from a ResizeObserver on
  // the strip, both of which are already layout-bound moments. The observer cannot loop on its
  // own toggle: the size it reports is the frame's final one, and this function is idempotent
  // for a given width.
  //
  // 🪤 The threshold is HALF THE BUTTON'S HEIGHT, not a pixel. The pill (18px) is taller than the
  // strip's text line (~16px), so merely showing it on the SAME line grows the strip by a couple of
  // pixels — a 1px tolerance read that as "a new line" and hid the button at every width (caught by
  // the chromium probe test/cmp-btn-fit-probe.mjs). A genuine extra line grows the strip
  // by at least a line height (≥ 15px); half the pill (9px) sits cleanly between the two.
  function fitCompareButton(container, btn) {
    if (!container || !btn || !btn.isConnected) return false;
    btn.style.display = '';
    const withBtn = container.getBoundingClientRect().height;
    const threshold = Math.max(4, btn.getBoundingClientRect().height / 2);
    btn.style.display = 'none';
    const without = container.getBoundingClientRect().height;
    const fits = (withBtn - without) < threshold;
    btn.style.display = fits ? '' : 'none';
    return fits;
  }
  // Keep the decision current as the composer resizes. Returns a disconnect function.
  function observeCompareFit(container, findBtn) {
    if (typeof ResizeObserver !== 'function' || !container) return () => {};
    const ro = new ResizeObserver(() => { try { fitCompareButton(container, findBtn()); } catch { /* detached */ } });
    ro.observe(container);
    return () => ro.disconnect();
  }

  // Buckets in `additional_rate_limits[]` that are NOT per-feature model limits, and so must not be
  // listed under a heading that calls them limits. Shared by every extension surface that renders
  // that array; the dashboard keeps its own copy as NON_MODEL_SLOT_NAMES (site/shared/chart-utils.js)
  // because it is a separate deploy, and the guard pins the two together.
  const NON_MODEL_BUCKET_NAMES = ['gpt-reserve'];
  function isNonModelBucket(name) { return NON_MODEL_BUCKET_NAMES.indexOf(name) >= 0; }

  // Provider slugs that have a real product name. Drawing the raw slug is what #1213 objects to on
  // the sidebar and what `gpt-reserve` did in the popup: a reader seeing `gpt-reserve 0%` beside a
  // weekly gauge at 100% has no way to learn what it is.
  //
  // 🔴 A RENAME IS NOT A CLAIM. This maps a slug to the vendor's own name for the same bucket and
  // changes nothing about the number, which these surfaces have always drawn straight from the
  // payload. Do NOT grow it into interpretation ("you can keep working") — THAT would be a claim,
  // and nothing we have observed supports it: `reached_type` was 'none' on all 1,207 accounts over
  // 7 days (AE cg_obs, measured 2026-09-08), so we have never once seen this population actually
  // blocked. Same bar bg/sidebar-usage.js applies to `reachedType`. See #1312.
  //
  // Unlocalised on purpose — these are proper nouns. The descriptive gloss beside the name is the
  // translated half, and it lives in the surface that draws it.
  // 🔴 null-prototype + own-key check, because the KEY IS PROVIDER-CONTROLLED. A plain object
  // literal answers `BUCKET_DISPLAY_NAMES['constructor']` with a FUNCTION, and 'toString' /
  // '__proto__' likewise — so a bucket named any of those would return a non-string that
  // escHtml() throws on (killing the whole popup section) or that renders as '[object Object]'.
  // The parent commit had no lookup at all and drew those slugs fine, so a bare `obj[name]` here
  // would be a REGRESSION, not merely a latent edge case.
  // 🪤 Codex Spark keeps its model version, deliberately. The slug is unreadable because it leads
  // with the version ('GPT-5.3-Codex-Spark'); moving the feature name to the front fixes that
  // without discarding which model the bucket meters — a user comparing this row against OpenAI's
  // own limits page needs the version to match it up. Dropping to a bare 'Codex Spark' would also
  // survive a version bump SILENTLY and start mislabelling 5.4 as 5.3.
  //
  // These slugs rotate (#926 moved this bucket's window; 'codex_bengalfox' is its metered_feature
  // codename). An unmapped slug falls through to itself, so a rotation degrades to today's raw
  // display rather than to a wrong name — and the scoped-model-watch cron alarm is the maintenance
  // trigger that says a new one appeared.
  const BUCKET_DISPLAY_NAMES = Object.assign(Object.create(null), {
    'gpt-reserve': 'Luna Reserve',
    'GPT-5.3-Codex-Spark': 'Codex Spark (GPT-5.3)',
  });
  // What each bucket actually IS, in the user's language. Single-sourced here because the popup
  // (ui/org-selector.js) and the ChatGPT sidebar both render these rows and used to say nothing —
  // the popup had no tooltip at all, and the sidebar gave every bucket the same generic
  // "a limit for this feature" line, which is true of Spark and false of Reserve.
  //
  // 🔴 EVERY CLAIM HERE IS ATTRIBUTED, DELIBERATELY. This repo has already published two confident
  // wrong descriptions of gpt-reserve by reasoning from payload field names. What we can defend is
  // what the vendor says, so the copy says "OpenAI 안내상 …" / "OpenAI describes it as …" rather
  // than asserting mechanism in our own voice.
  //   Luna Reserve — help.openai.com "Luna Reserve in Codex and ChatGPT Work" + openai/codex#42217,
  //     #42830 (verified 2026-09-08, see docs/CHATGPT-USAGE-SEMANTICS.md).
  //   Codex Spark — openai.com "Introducing GPT-5.3-Codex-Spark" (own rate limit, research preview,
  //     limits may shift with demand) + openai/codex#23150, which corroborates the separate bucket.
  // 🪤 #23150 is a BUG REPORT that Spark usage sometimes drains regular Codex limits anyway. The
  // copy therefore says OpenAI meters them apart AND carries the counter-example, because the
  // decision this text actually drives is "should I switch to Spark to save my regular quota" —
  // stating only the vendor's intent would answer that question wrongly for the users in #23150.
  //
  // 🔴 And nothing here may tell the user what they will be ABLE to do (see the reserve-copy guard
  // in test/chatgpt-astra-obs-guard.mjs): we have never observed an account in this population
  // actually blocked, so "you can keep working past your limit" remains unevidenced for us.
  const BUCKET_NOTES = Object.assign(Object.create(null), {
    'gpt-reserve': {
      ko: '정상 한도와 별개로 주어지는 예비 사용량입니다.\nOpenAI 안내상 지원되는 계정·앱에서, 정상 한도를 모두 쓴 뒤 GPT-5.6 Luna로만 쓰입니다.',
      en: 'A reserve allowance, separate from your regular limits.\nOpenAI describes it as GPT-5.6 Luna usage, on supported accounts and apps, once regular limits run out.',
    },
    'GPT-5.3-Codex-Spark': {
      ko: '빠른 응답용 Codex 모델에 붙은 별도 한도입니다.\nOpenAI 안내상 일반 Codex 사용량과 따로 계산됩니다.\n다만 일반 한도도 함께 줄었다는 사용자 보고가 있습니다.',
      en: 'A separate limit on the low-latency Codex model.\nOpenAI describes it as metered apart from regular Codex use.\nSome users report their regular limit dropping too.',
    },
  });
  /** Slugs we have a note for. Exposed so a guard can check EVERY entry, not a hand-written list
   *  that silently stops matching the map (which is exactly what happened once). */
  function bucketNoteSlugs() { return Object.keys(BUCKET_NOTES); }

  /** The per-bucket explanation, or null when we have nothing sourced to say about this slug. */
  function bucketNote(name, lang) {
    if (!Object.prototype.hasOwnProperty.call(BUCKET_NOTES, name)) return null;
    const n = BUCKET_NOTES[name];
    return n[lang] || n.en;
  }

  // claude.ai's active org — the uuid in its `lastActiveOrg` cookie, or null. ONE parser for the
  // three claude.ai content scripts (sidebar-usage.js, input-usage.js, claude-folders.js), which
  // each had their own copy (#2054). The cookie NAME is a copy of vendor-ai/sites.js
  // CLAUDE_ACTIVE_ORG_COOKIE: this is a classic content script and cannot import the ESM file, so
  // test/sidebar-usage-org-scope-guard.mjs pins the two strings together.
  const CLAUDE_ACTIVE_ORG_COOKIE = 'lastActiveOrg';
  function getClaudeActiveOrgId(cookieString) {
    const src = typeof cookieString === 'string' ? cookieString : document.cookie;
    const prefix = `${CLAUDE_ACTIVE_ORG_COOKIE}=`;
    const row = src.split(/;\s*/).find((r) => r.startsWith(prefix));
    return (row && row.slice(prefix.length)) || null;
  }

  // A conversation id from a claude.ai / chatgpt.com path — the folders' one parser (#2065), which
  // used to be four loose `/\/chat\/([\w-]+)/` matches (no anchor, no uuid check, no lowercasing)
  // in claude-folders.js / chatgpt-folders.js.
  // 🪤 SYNC COPY of vendor-ai/sites.js CONVERSATION_RULES (claude + chatgpt `path` and `canon`):
  // this is a classic content script and cannot import the ESM file, so
  // test/folders-dry-guard.mjs runs both over a table of paths and requires identical answers.
  // Takes a PATHNAME (query/hash ignored); null when the path names no conversation.
  const CONVERSATION_PATH_RULES = {
    claude: /^\/chat\/([0-9a-f-]{36})\/?$/i,
    chatgpt: /^\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{36})\/?$/i,
  };
  const CONVERSATION_UUID_ISH_RE = /^[0-9a-f-]{36}$/i;
  function conversationIdFromPath(provider, path) {
    if (!Object.prototype.hasOwnProperty.call(CONVERSATION_PATH_RULES, provider)) return null;
    if (typeof path !== 'string') return null;
    const m = path.trim().replace(/[?#].*$/, '').match(CONVERSATION_PATH_RULES[provider]);
    return m && CONVERSATION_UUID_ISH_RE.test(m[1]) ? m[1].toLowerCase() : null;
  }
  // Same, from a link's href (relative or absolute): resolved against `base` (the page URL) and
  // only when it stays on the page's own origin — a sidebar link to another site is no conversation.
  function conversationIdFromHref(provider, href, base) {
    if (typeof href !== 'string' || !href) return null;
    let u, b;
    try { b = new URL(base); u = new URL(href, b); } catch { return null; }
    return u.origin === b.origin ? conversationIdFromPath(provider, u.pathname) : null;
  }
  // A STORED folder chat id as the parser above would spell it today: a uuid lowercased, anything
  // else unchanged. Applied when folders are read so an entry saved under an older, looser parser
  // keeps matching — never dropped (a non-uuid entry stays listed and openable).
  function canonicalStoredChatId(id) {
    return typeof id === 'string' && CONVERSATION_UUID_ISH_RE.test(id) ? id.toLowerCase() : id;
  }

  function bucketDisplayName(name) {
    return Object.prototype.hasOwnProperty.call(BUCKET_DISPLAY_NAMES, name)
      ? BUCKET_DISPLAY_NAMES[name]
      : name;
  }

  // ── Sidebar notice + ad blocks (#2065) ──────────────────────────────────────────────────────
  // ONE copy of the announcement strip, bell badge and in-house ad banner that the three sidebars
  // (sidebar-usage.js / chatgpt-sidebar.js / gemini-sidebar.js) each carried. They differ only by
  // their class prefix, theme text classes, utm_source and placement — passed in.
  //
  // 🔴 Every helper reads the core's ad methods off the EXPORTED object at CALL time, never the
  // closure: what a sidebar can rely on is what the exported object holds (a stale or partially
  // replaced core is exactly the case the readiness check is for — #1422, and
  // test/panel-render-execution-guard.mjs ages the exported object method by method).
  const exported = () => globalThis.__ctUsageCore || {};
  const AD_CORE_METHODS = ['selectAds', 'buildAdBannerHtml', 'noteAdServed', 'trackAdViewability', 'trackAdClick'];
  // 🔑 THE SET, not `buildAdBannerHtml` alone: a banner we cannot fully operate is worse than none —
  // its click handler would throw before window.open. Plus the placement: it is what selection is
  // scoped by, so a core that cannot name it must not be asked.
  function sidebarAdsReady(placementKey) {
    const c = exported();
    return AD_CORE_METHODS.every((n) => typeof c[n] === 'function')
      && !!(c.PLACEMENTS && c.PLACEMENTS[placementKey]);
  }
  // Premium ad gate (1.32.0, plan compare-quota-premium §2): FAIL-OPEN — any error, a missing
  // adFreeEntitled or a non-Premium answer → ads as before.
  function sidebarAdFree() {
    try {
      const c = exported();
      if (typeof c.adFreeEntitled !== 'function') return Promise.resolve(false);
      return Promise.resolve(c.adFreeEntitled(chrome.runtime)).then((v) => v === true, () => false);
    } catch { return Promise.resolve(false); }
  }
  /**
   * One ad round for a sidebar: the ads to show ([] = Premium, clear the slot), or null = leave the
   * slot as it is (core not ready, superseded instance, or a transient selection error). The caller
   * re-checks its own isCurrent() before touching the DOM with the answer.
   */
  async function fetchSidebarAds({ placementKey, lang, isCurrent }) {
    // The gate is asked even when the ad set is incomplete: clearing a banner already on screen
    // needs no ad method, and a Premium answer must clear it (Codex #2065 R2).
    const gated = await sidebarAdFree();
    // Superseded while the SW answered (Codex U3 1R #5): neither branch may touch shared DOM or fetch.
    if (isCurrent && !isCurrent()) return null;
    if (gated) return [];
    if (!sidebarAdsReady(placementKey)) return null;
    try {
      const c = exported();
      return await c.selectAds({ placement: c.PLACEMENTS[placementKey], lang });
    } catch { return null; }
  }
  /** Draw `ads` into the sidebar's ad slot (or hide it when empty); `utm` is the click's utm_source. */
  function renderSidebarAds(container, ads, { placementKey, lang, guard, utm }) {
    if (!container) return;
    // Clearing first: it needs no ad method, so even an incomplete core can empty the slot.
    if (!ads || !ads.length) { container.innerHTML = ''; container.style.display = 'none'; return; }
    if (!sidebarAdsReady(placementKey)) return;
    const c = exported();
    container.style.display = '';
    container.innerHTML = ads.map((ad) => c.buildAdBannerHtml(ad, lang)).join('');
    container.querySelectorAll('.ct-ad-banner').forEach((el, i) => {
      const ad = ads[i];
      c.noteAdServed(ad.campaign.campaign_id, ad.placement); // daily frequency cap (serving-side)
      c.trackAdViewability(el, ad, guard); // measurement seam: viewability-gated impression → SW counter owner
      const url = el.getAttribute('data-ad-url');
      if (url) el.addEventListener('click', (e) => {
        // Label chip is an advertiser-inquiry link (its own target=_blank nav) — not an ad click.
        if (e.target.closest && e.target.closest('.ct-ad-label')) return;
        c.trackAdClick(ad, e); // measurement seam: click → SW counter owner
        window.open(url + (url.includes('?') ? '&' : '?') + 'utm_source=' + utm, '_blank');
      });
    });
  }
  /** The bell's unseen-count badge. */
  function renderBellBadge(badge, notices, lastSeenId) {
    if (!badge) return;
    const unseen = getUnseenCount(notices, lastSeenId);
    if (unseen > 0) { badge.textContent = unseen; badge.style.display = ''; }
    else { badge.style.display = 'none'; }
  }
  /**
   * The inline announcement strip: the latest notice the user has not dismissed, or nothing.
   * `getNotices` is read when the dismissed list arrives (the sidebar's list may have been refreshed
   * meanwhile); `rerender` runs after a dismissal; `isCurrent` (the sidebar's instance guard) is
   * re-checked after every async step so a superseded injection never touches shared DOM.
   */
  function renderSidebarNotice(container, { getNotices, lang, prefix, textClass, closeClass, utm, isCurrent, rerender }) {
    if (!container) return;
    const live = () => !isCurrent || isCurrent();
    chrome.storage.local.get({ ct_dismissed_notices: [] }, (result) => {
      if (!live()) return; // superseded by a newer injection since the async read
      const dismissed = result.ct_dismissed_notices || [];
      const active = (getNotices() || []).filter((n) => !dismissed.includes(n.id));
      if (active.length === 0) { container.innerHTML = ''; container.style.display = 'none'; return; }
      const latest = active[0];
      container.style.display = '';
      container.innerHTML = `
        <span class="${prefix}-notice-icon">📢</span>
        <span class="${prefix}-notice-text${textClass ? ` ${textClass}` : ''}">${escapeHtml(latest.title || '')}</span>
        <button class="${prefix}-notice-close${closeClass ? ` ${closeClass}` : ''}">×</button>
      `;
      container.querySelector(`.${prefix}-notice-text`).addEventListener('click', () => {
        // Reject non-http(s) schemes (e.g. javascript:) before navigating.
        let url = latest.url || '';
        try { const u = new URL(url); if (u.protocol !== 'http:' && u.protocol !== 'https:') url = ''; } catch { url = ''; }
        if (!url) url = NOTICE_BASE + lang;
        window.open(url + (url.includes('?') ? '&' : '?') + 'utm_source=' + utm, '_blank');
      });
      container.querySelector(`.${prefix}-notice-close`).addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.storage.local.get({ ct_dismissed_notices: [] }, (r) => {
          if (!live()) return; // superseded since the click
          const arr = r.ct_dismissed_notices || [];
          if (!arr.includes(latest.id)) arr.push(latest.id);
          chrome.storage.local.set({ ct_dismissed_notices: arr }, () => { if (live() && rerender) rerender(); });
        });
      });
    });
  }

  globalThis.__ctUsageCore = {
    gaugeColor,
    planDisplayName,
    formatCountdown,
    formatResetAbsolute,
    buildResetCellInner,
    escapeHtml,
    detectLang,
    windowUnitLabel,
    extraGaugeDrawn,
    windowLabel,
    cgUsageNote,
    // ── Reset pass chip (#2092 P1-1) ──
    resetPassChip,
    buildResetPassChipHtml,
    buildResetPassLineHtml,
    resetPassDetailTip,
    buildResetPassHelpHtml,
    noDataReason,
    fitCompareButton,
    observeCompareFit,
    isNonModelBucket,
    bucketDisplayName,
    CLAUDE_ACTIVE_ORG_COOKIE,
    getClaudeActiveOrgId,
    conversationIdFromPath,
    conversationIdFromHref,
    canonicalStoredChatId,
    bucketNote,
    bucketNoteSlugs,
    isContextValid,
    createInstanceGuard,
    PRED_MIN_DELTA,
    ANNOUNCE_URL,
    NOTICE_BASE,
    compareVersions,
    fetchAnnouncements,
    getUnseenCount,
    // ── Ad server (Phase 1 serving) ──
    PLACEMENTS,
    isAdFree,
    adFreeEntitled,
    selectAds,
    noteAdServed,
    getAdRefreshMs,
    startAdRotation,
    trackAdViewability,
    trackAdClick,
    sendAdFlushHint,
    buildAdBannerHtml,
    // ── Sidebar notice + ad blocks (#2065) ──
    fetchSidebarAds,
    renderSidebarAds,
    renderBellBadge,
    renderSidebarNotice,
  };
})();
