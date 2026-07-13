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

  globalThis.__ctUsageCore = {
    gaugeColor,
    planDisplayName,
    formatCountdown,
    formatResetAbsolute,
    escapeHtml,
    detectLang,
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
    selectAds,
    noteAdServed,
    getAdRefreshMs,
    startAdRotation,
    trackAdViewability,
    trackAdClick,
    sendAdFlushHint,
    buildAdBannerHtml,
  };
})();
