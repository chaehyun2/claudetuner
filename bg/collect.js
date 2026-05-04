import { sendGAEvent } from './analytics.js';
import {
  ALARM_NAME, DEFAULT_INTERVAL_MINUTES, FREE_PLAN_INTERVAL_MINUTES,
  HEARTBEAT_INTERVAL_MS, SEAT_TIER_MAP, NON_PERSONAL_PLANS,
  ORG_POLL_TIERS, ORG_POLL_TIER_ORDER, ORG_POLL_CHANGE_THRESHOLD,
  DEFAULT_SERVER_URL,
} from './constants.js';
import { bgLang, bt } from './i18n.js';
import { fetchClaudeApi, fetchWithCookies, normalizeResetTime } from './api.js';
import { updateBadge, updateBadgeError, resetIcon } from './badge.js';
import { checkCollectFailNotification, checkUsageAlerts, logNotification } from './notifications.js';
import {
  detectPlan, refineTeamPlan, fetchSubscriptionInfo,
  acceptPlanOrder, reportPlanOrderResult,
} from './plan.js';
import { getConfig, setStatus, getLastStatus, appendUsageHistory, mergeServerSnapshots, getAuthHeaders, authedFetch, setExtToken, clearExtTokenIfMatches, bearerFromAuthHeaders } from './storage.js';

// === Adaptive Polling helpers ===
export function getOrgPollDefault() {
  return { tier: 'active', unchangedCount: 0, lastValues: { h5: null, d7: null, extraUsed: null }, lastPollAt: 0 };
}

/** Check if an org is due for polling based on its adaptive tier */
export function isOrgDueForPoll(state, now, baseIntervalMs) {
  const tierInfo = ORG_POLL_TIERS[state.tier] || ORG_POLL_TIERS.active;
  const effectiveInterval = tierInfo.intervalMs || baseIntervalMs;
  return (now - state.lastPollAt) >= effectiveInterval * 0.9;
}

/** Compare usage values and return true if changed beyond threshold */
export function hasOrgUsageChanged(prev, current) {
  const diff = (a, b) => a != null && b != null && Math.abs(a - b) >= ORG_POLL_CHANGE_THRESHOLD;
  return diff(prev.h5, current.h5) || diff(prev.d7, current.d7) || diff(prev.extraUsed, current.extraUsed);
}

/** Update org poll state after a poll. Returns the updated state object */
export function updateOrgPollState(state, currentValues, changed) {
  if (changed) {
    return { ...state, tier: 'active', unchangedCount: 0, lastValues: currentValues, lastPollAt: Date.now() };
  }
  // Zombie org: no active 5h window (h5=0/null, r5=null) → fast-track to dormant
  const isZombie = (currentValues.h5 == null || currentValues.h5 === 0) && !currentValues.resetsAt5h;
  if (isZombie && state.tier !== 'dormant') {
    console.log(`[Claude Tuner] Org poll zombie detected (h5=0, r5=null): ${state.tier} → dormant`);
    return { ...state, tier: 'dormant', unchangedCount: 0, lastValues: currentValues, lastPollAt: Date.now() };
  }
  const newCount = state.unchangedCount + 1;
  const tierInfo = ORG_POLL_TIERS[state.tier];
  const tierIdx = ORG_POLL_TIER_ORDER.indexOf(state.tier);
  if (newCount >= tierInfo.promoteAfter && tierIdx < ORG_POLL_TIER_ORDER.length - 1) {
    const nextTier = ORG_POLL_TIER_ORDER[tierIdx + 1];
    console.log(`[Claude Tuner] Org poll tier promoted: ${state.tier} → ${nextTier}`);
    return { ...state, tier: nextTier, unchangedCount: 0, lastValues: currentValues, lastPollAt: Date.now() };
  }
  return { ...state, unchangedCount: newCount, lastValues: currentValues, lastPollAt: Date.now() };
}

/** Normalize raw extra_usage API response into a consistent shape */
function normalizeExtraUsage(raw) {
  if (!raw) return null;
  return {
    is_enabled: raw.is_enabled || false,
    monthly_limit: raw.monthly_limit ?? null,
    used_credits: raw.used_credits ?? null,
    utilization: raw.utilization ?? null,
  };
}

/** Parse grove_enabled from API response text via regex */
function parseGroveFromText(text) {
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  const m = str.match(/"grove_enabled"\s*:\s*(true|false|null)/);
  if (!m) return null;
  return m[1] === 'true' ? true : m[1] === 'false' ? false : null;
}

/** Save grove detection result to local cache */
function saveGroveCache(value, detected) {
  chrome.storage.local.set({ groveCache: { value, detected, ts: Date.now() } });
}

/** Build a history point from a snapshot for appendUsageHistory */
function buildHistoryPoint(snapshot, plan) {
  return {
    t: Date.now(),
    h5: snapshot.five_hour?.utilization ?? null,
    d7: snapshot.seven_day?.utilization ?? null,
    p: plan,
    r7: snapshot.seven_day?.resets_at || null,
    org: snapshot.claude_org_uuid || null,
    eu: snapshot.extra_usage?.used_credits ?? null,
    el: snapshot.extra_usage?.monthly_limit ?? null,
  };
}

/** Build common usage window fields shared by primary & extra org snapshots */
async function buildUsageFields(usageData, config) {
  return {
    five_hour: {
      utilization: usageData.five_hour?.utilization ?? null,
      resets_at: normalizeResetTime(usageData.five_hour?.resets_at),
    },
    seven_day: {
      utilization: usageData.seven_day?.utilization ?? null,
      resets_at: normalizeResetTime(usageData.seven_day?.resets_at),
    },
    seven_day_omelette: {
      utilization: usageData.seven_day_omelette?.utilization ?? null,
      resets_at: normalizeResetTime(usageData.seven_day_omelette?.resets_at),
    },
    seven_day_sonnet: {
      utilization: usageData.seven_day_sonnet?.utilization ?? null,
      resets_at: normalizeResetTime(usageData.seven_day_sonnet?.resets_at),
    },
    extra_usage: normalizeExtraUsage(usageData.extra_usage),
    user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    user_language: await bgLang(),
    poll_interval: config.intervalMinutes || DEFAULT_INTERVAL_MINUTES,
    poll_interval_explicit: !!config.intervalExplicitlySet,
  };
}

/** Sync notification permission to server (fire-and-forget, on change only) */
function syncNotificationPermission(config, userEmail) {
  chrome.notifications.getPermissionLevel((level) => {
    const blocked = level === 'denied';
    chrome.storage.local.get({ _lastNotifBlocked: null }, (r) => {
      if (r._lastNotifBlocked === blocked) return; // no change
      chrome.storage.local.set({ _lastNotifBlocked: blocked });

      const payload = { user_email: userEmail, notifications_blocked: blocked };

      // When newly blocked, include notification stats for analysis
      if (blocked) {
        chrome.storage.local.get({ _notifLog: [] }, ({ _notifLog }) => {
          if (_notifLog.length > 0) {
            const now = Date.now();
            const d7 = now - 7 * 24 * 60 * 60 * 1000;
            const recent = _notifLog.filter(e => e.ts > d7);
            // Per-category counts (last 7 days)
            const counts = {};
            for (const e of recent) counts[e.c] = (counts[e.c] || 0) + 1;
            // Last notification before block
            const last = _notifLog[_notifLog.length - 1];
            // Days with at least one notification (for daily avg)
            const days = new Set(recent.map(e => new Date(e.ts).toDateString())).size || 1;
            payload.notification_stats = JSON.stringify({
              last_category: last.c,
              last_ts: last.ts,
              seven_day_counts: counts,
              seven_day_total: recent.length,
              daily_avg: +(recent.length / days).toFixed(1),
            });
          }
          authedFetch(config, `${config.serverUrl}/api/users/preferences`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(() => {});
        });
      } else {
        authedFetch(config, `${config.serverUrl}/api/users/preferences`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      }
    });
  });
}

/** Sync notification toggle preferences to server (fire-and-forget, on change only) */
function syncNotificationPrefs(config, userEmail) {
  const defaults = {
    notifyUsageWarn: false, notifyUsageDanger: true,
    notifyResetSoon: true, notifyResetDone: true,
    notifyWeeklyReport: true, notifyCollectFail: true, notifyPlanChange: true,
  };
  chrome.storage.sync.get(defaults, (prefs) => {
    const json = JSON.stringify(prefs);
    chrome.storage.local.get({ _lastNotifPrefs: null }, (r) => {
      if (r._lastNotifPrefs === json) return; // no change
      chrome.storage.local.set({ _lastNotifPrefs: json });
      authedFetch(config, `${config.serverUrl}/api/users/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: userEmail, notification_prefs: json }),
      }).catch(() => {});
    });
  });
}

/** Show recommendation badge (⚠) with display-mode-aware utilization */
async function showRecommendationBadge(snapshot, recType) {
  resetIcon();
  const { usageDisplayMode: _bdm = '7d' } = await chrome.storage.sync.get({ usageDisplayMode: '7d' });
  let util;
  if (_bdm === '5h') util = snapshot.five_hour.utilization;
  else if (_bdm === 'both') util = Math.max(snapshot.five_hour.utilization || 0, snapshot.seven_day.utilization || 0);
  else util = snapshot.seven_day.utilization;
  chrome.action.setBadgeText({ text: Math.round(util || 0) + '⚠' });
  chrome.action.setBadgeBackgroundColor({ color: recType === 'upgrade' ? '#d97706' : '#059669' });
}

// === Org detection based on lastActiveOrg cookie ===
export async function getLastActiveOrgId() {
  try {
    const cookie = await chrome.cookies.get({ name: 'lastActiveOrg', url: 'https://claude.ai' });
    return cookie?.value || null;
  } catch (e) {
    console.warn('[Claude Tuner] lastActiveOrg cookie read failed:', e.message);
    return null;
  }
}

// === Core Collection Engine ===
export async function collectAndSend({ force = false, skipServer = false } = {}) {
  const _t0 = performance.now();
  const _timings = {};
  // Skip collection if account is deleted
  const { account_deleted } = await chrome.storage.local.get({ account_deleted: false });
  if (account_deleted) {
    console.log('[Claude Tuner] Account deleted. Skipping collection.');
    return { success: false, account_deleted: true };
  }

  const config = await getConfig();

  if (!config.serverUrl || !config.apiKey) {
    const error = 'Server URL 또는 API Key가 설정되지 않았습니다. 옵션 페이지에서 설정해주세요.';
    await setStatus({ error, timestamp: Date.now() });
    return { success: false, error };
  }

  try {
    // 1. Fetch organization info (cookie auth, org-scoped endpoint)
    let _ts = performance.now();
    const orgList = await fetchClaudeApi('/api/organizations');
    _timings['1_organizations'] = Math.round(performance.now() - _ts);

    if (!Array.isArray(orgList) || orgList.length === 0) {
      throw new Error('err_no_orgs');
    }

    // Detect plan for each org (skip API-only orgs)
    const orgPlans = orgList.map(o => { const p = detectPlan(o); return `${o.name}(${p})${p === 'API' ? '[skip]' : ''}`; });
    console.log(`[Claude Tuner] ${orgList.length} orgs:`, orgPlans.join(' | '));
    const planScoreMap = { 'Max 20x': 7, 'Team Premium': 6, 'Max 5x': 5, 'Team Standard': 4, 'Max': 3.5, 'Enterprise': 3, 'Team': 2.5, 'Team Tier 2': 2.5, 'Pro': 2, 'Free': 1 };

    // === Primary org selection: manual > cookie > plan score fallback ===
    let bestOrg = null;
    let bestPlan = 'unknown';
    let selectionMethod = '';
    const cookieOrgId = await getLastActiveOrgId();

    // 1) Manual selection (selectedOrgId)
    if (config.selectedOrgId) {
      bestOrg = orgList.find(o => o.uuid === config.selectedOrgId);
      if (bestOrg) {
        bestPlan = detectPlan(bestOrg);
        selectionMethod = 'manual';
      } else {
        console.warn('[Claude Tuner] selectedOrgId not found, resetting to auto');
        await chrome.storage.sync.set({ selectedOrgId: null });
      }
    }

    // 2) lastActiveOrg cookie (automatically set by Claude.ai on org switch)
    if (!bestOrg) {
      if (cookieOrgId) {
        const cookieOrg = orgList.find(o => o.uuid === cookieOrgId && detectPlan(o) !== 'API');
        if (cookieOrg) {
          bestOrg = cookieOrg;
          bestPlan = detectPlan(cookieOrg);
          selectionMethod = 'cookie';
        } else {
          console.log(`[Claude Tuner] lastActiveOrg cookie (${cookieOrgId}) not in org list or is API, falling back`);
        }
      } else {
        console.log('[Claude Tuner] lastActiveOrg cookie not found, falling back to plan scoring');
      }
    }

    // 3) Plan score-based fallback (when cookie is missing or match fails)
    if (!bestOrg) {
      const nonApiOrgs = orgList.filter(o => detectPlan(o) !== 'API');
      const isMultiOrg = nonApiOrgs.length > 1;
      let topScore = -1;
      for (const o of nonApiOrgs) {
        const p = detectPlan(o);
        if (isMultiOrg && p === 'Free') continue;
        const score = planScoreMap[p] || (p.startsWith('Max') ? 3 : 0);
        if (score > topScore) {
          topScore = score;
          bestOrg = o;
          bestPlan = p;
        }
      }
      selectionMethod = 'score';
    }

    console.log(`[Claude Tuner] Primary org: ${bestOrg?.name} (${bestPlan}) [${selectionMethod}]`);
    // Save auto-selected org info for options page display
    if (bestOrg && selectionMethod !== 'manual') {
      await chrome.storage.local.set({ autoSelectedOrg: { name: bestOrg.name, plan: bestPlan, uuid: bestOrg.uuid } });
    }

    // Extract email: prefer org with email_address, fallback to parsing from org.name
    let userEmail = 'unknown';
    for (const o of orgList) {
      const e = o.email_address || o.owner?.email_address;
      if (e) { userEmail = e; break; }
    }
    if (userEmail === 'unknown') {
      for (const o of orgList) {
        if (o.name) {
          const m = o.name.match(/^([^\s]+@[^\s]+)'s\s/i);
          if (m) { userEmail = m[1]; break; }
        }
      }
    }
    // Fetch email + seat_tier from /api/account (cached 8 hours)
    // grove_enabled has separate cache (30 min) — may change more frequently
    let seatTier = null;
    let groveEnabled = null;
    let groveDetected = false; // Whether grove_enabled was successfully read from the API
    {
      const ACCOUNT_CACHE_TTL = 8 * 60 * 60 * 1000; // 8 hours
      const GROVE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
      const cached = await chrome.storage.local.get(['accountCache', 'groveCache']);
      const cache = cached.accountCache;
      const groveC = cached.groveCache;

      // --- account (email, seatTier) ---
      const acctCacheValid = !force && cache && (Date.now() - cache.ts) < ACCOUNT_CACHE_TTL && cache.orgUuid === bestOrg?.uuid;
      if (acctCacheValid) {
        if (userEmail === 'unknown' && cache.email) userEmail = cache.email;
        seatTier = cache.seatTier || null;
        console.log('[Claude Tuner] Account (cached):', cache.email, 'seat:', seatTier);
      } else {
        try {
          _ts = performance.now();
          const acct = await fetchClaudeApi('/api/account', { quiet: true });
          _timings['2_account'] = Math.round(performance.now() - _ts);
          const acctEmail = acct?.email || acct?.email_address;
          const memberships = acct?.memberships || [];
          const bestOrgUuid = bestOrg?.uuid;
          const membership = memberships.find(m =>
            m.organization_uuid === bestOrgUuid || m.organization?.uuid === bestOrgUuid
          ) || memberships[0];
          seatTier = membership?.seat_tier || null;
          if (acctEmail) userEmail = acctEmail;
          // Save all orgs' seat_tier (for extra org plan refinement)
          const allSeatTiers = {};
          for (const m of memberships) {
            const mOrgUuid = m.organization_uuid || m.organization?.uuid;
            if (mOrgUuid && m.seat_tier) allSeatTiers[mOrgUuid] = m.seat_tier;
          }
          const acctName = acct?.full_name || acct?.display_name || '';
          await chrome.storage.local.set({ accountCache: { email: acctEmail, name: acctName, seatTier, orgUuid: bestOrgUuid, allSeatTiers, ts: Date.now() } });
          console.log('[Claude Tuner] Account API:', acctEmail, 'seat:', seatTier, 'org:', bestOrgUuid);
          // Parse grove_enabled from the same response (no extra API call needed)
          const groveNeedsFresh = force || !groveC || (Date.now() - groveC.ts) >= GROVE_CACHE_TTL;
          if (groveNeedsFresh && acct?.settings != null && typeof acct.settings === 'object' && 'grove_enabled' in acct.settings) {
            groveEnabled = acct.settings.grove_enabled === true ? true : acct.settings.grove_enabled === false ? false : null;
            groveDetected = true;
            saveGroveCache(groveEnabled, true);
            console.log('[Claude Tuner] grove from account API:', groveEnabled);
          }
        } catch (e) {
          console.warn('[Claude Tuner] Account API failed:', e.message);
          if (cache) {
            if (userEmail === 'unknown' && cache.email) userEmail = cache.email;
            seatTier = cache.seatTier || null;
          }
        }
      }

      // --- grove_enabled (separate cache, 30 min) ---
      const groveCacheValid = !force && groveC && (Date.now() - groveC.ts) < GROVE_CACHE_TTL;
      if (groveCacheValid) {
        groveEnabled = groveC.value ?? null;
        groveDetected = groveC.detected ?? false;
        console.log('[Claude Tuner] grove (cached):', groveEnabled, 'detected:', groveDetected);
      } else if (!groveDetected) {
        // Skip if already parsed from account API above
        try {
          _ts = performance.now();
          const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
          if (tabs.length > 0) {
            const groveResult = await chrome.scripting.executeScript({
              target: { tabId: tabs[0].id },
              world: 'MAIN',
              func: async () => {
                try {
                  const r = await fetch('/api/account', { credentials: 'include' });
                  const status = r.status;
                  if (!r.ok) return { value: null, debug: { status, error: 'http_error', response_length: 0, has_settings: false, has_grove_key: false, grove_context: null, settings_keys: 0 } };
                  const t = await r.text();
                  const m = t.match(/"grove_enabled"\s*:\s*(true|false|null)/);
                  if (m) return { value: m[1] === 'true' ? true : m[1] === 'false' ? false : null, debug: null };
                  // Parse failed — collect debug info
                  let hasSettings = false, settingsKeys = 0, hasGroveKey = false, groveContext = null;
                  try {
                    const j = JSON.parse(t);
                    hasSettings = j.settings != null && typeof j.settings === 'object';
                    if (hasSettings) settingsKeys = Object.keys(j.settings).length;
                    hasGroveKey = t.includes('"grove_enabled"');
                    if (hasGroveKey) {
                      const idx = t.indexOf('"grove_enabled"');
                      groveContext = t.slice(Math.max(0, idx - 10), idx + 50);
                    }
                  } catch {}
                  return { value: null, debug: { status, error: null, response_length: t.length, has_settings: hasSettings, has_grove_key: hasGroveKey, grove_context: groveContext, settings_keys: settingsKeys } };
                } catch (e) { return { value: null, debug: { status: -1, error: e.message, response_length: 0, has_settings: false, has_grove_key: false, grove_context: null, settings_keys: 0 } }; }
              },
              args: [],
            });
            const gr = groveResult?.[0]?.result;
            if (gr && !gr.debug) {
              // Regex match success (includes true/false/null) — explicit detection
              groveEnabled = gr.value;
              groveDetected = true;
            } else if (gr) {
              // Parse failed — debug info available
              if (gr.value != null) groveEnabled = gr.value;
            }
            saveGroveCache(groveEnabled, groveDetected);
            console.log('[Claude Tuner] grove API:', groveEnabled, 'detected:', groveDetected);
          } else {
            // No tabs available — cookie fallback
            const acctNo = await fetchWithCookies('https://claude.ai/api/account');
            const parsed = parseGroveFromText(acctNo);
            if (parsed !== null) {
              groveEnabled = parsed;
              groveDetected = true;
              saveGroveCache(groveEnabled, true);
              console.log('[Claude Tuner] grove no-tab cookie fallback:', groveEnabled);
            }
          }
        } catch (ge) {
          console.warn('[Claude Tuner] grove executeScript failed, trying cookie fallback:', ge.message);
          // Cookie-based fallback: when executeScript fails (insufficient permissions, etc.)
          try {
            const acct = await fetchWithCookies('https://claude.ai/api/account');
            const parsed = parseGroveFromText(acct);
            if (parsed !== null) {
              groveEnabled = parsed;
              groveDetected = true;
              saveGroveCache(groveEnabled, true);
              console.log('[Claude Tuner] grove cookie fallback:', groveEnabled, 'detected:', groveDetected);
            }
          } catch (ce) {
            console.warn('[Claude Tuner] grove cookie fallback failed:', ce.message);
            if (groveC) {
              groveEnabled = groveC.value ?? null;
              groveDetected = groveC.detected ?? false;
            }
          }
        }
        _timings['3_grove'] = Math.round(performance.now() - _ts);
      }
    }

    // Refine plan based on seat tier
    if (bestPlan === 'Team' && seatTier) {
      bestPlan = SEAT_TIER_MAP[seatTier] || 'Team Standard';
      console.log(`[Claude Tuner] Team seat_tier: ${seatTier} → ${bestPlan}`);
    } else if (bestPlan === 'Enterprise' && seatTier) {
      console.log(`[Claude Tuner] Enterprise seat_tier: ${seatTier}`);
    }

    // Check for non-monitorable orgs (API-only)
    if (!bestOrg || bestPlan === 'API') {
      const hasAPI = orgList.some(o => detectPlan(o) === 'API');
      if (hasAPI) {
        throw new Error('err_api_only');
      } else {
        throw new Error('err_no_monitorable');
      }
    }

    // Free plan: force poll interval to 60 min / restore on upgrade
    {
      const { intervalExplicitlySet } = await chrome.storage.sync.get({ intervalExplicitlySet: false });
      if (!intervalExplicitlySet) {
        const currentInterval = config.intervalMinutes || DEFAULT_INTERVAL_MINUTES;
        if (bestPlan === 'Free' && currentInterval !== FREE_PLAN_INTERVAL_MINUTES) {
          console.log(`[Claude Tuner] Free plan: poll interval ${currentInterval}m → ${FREE_PLAN_INTERVAL_MINUTES}m`);
          await chrome.storage.sync.set({ intervalMinutes: FREE_PLAN_INTERVAL_MINUTES });
          chrome.alarms.create(ALARM_NAME, { delayInMinutes: FREE_PLAN_INTERVAL_MINUTES, periodInMinutes: FREE_PLAN_INTERVAL_MINUTES });
        } else if (bestPlan !== 'Free' && currentInterval === FREE_PLAN_INTERVAL_MINUTES) {
          const restoreInterval = (await chrome.storage.local.get('serverPollInterval')).serverPollInterval || DEFAULT_INTERVAL_MINUTES;
          console.log(`[Claude Tuner] Upgraded from Free: poll interval ${FREE_PLAN_INTERVAL_MINUTES}m → ${restoreInterval}m`);
          await chrome.storage.sync.set({ intervalMinutes: restoreInterval });
          chrome.alarms.create(ALARM_NAME, { delayInMinutes: restoreInterval, periodInMinutes: restoreInterval });
        }
      }
    }

    // Fetch usage data from the selected primary org
    let org = bestOrg;
    let orgId = bestOrg?.uuid;
    let usageData = null;
    try {
      _ts = performance.now();
      usageData = await fetchClaudeApi(`/api/organizations/${orgId}/usage`);
      _timings['4_usage'] = Math.round(performance.now() - _ts);
    } catch (e) {
      console.warn(`[Claude Tuner] Usage fetch failed for ${bestOrg.name}: ${e.message}`);
      if (e.message && e.message.includes('err_rate_limit')) {
        throw new Error('err_rate_limit');
      }
    }
    if (!org || !usageData) {
      throw new Error('err_usage_failed');
    }

    const plan = bestPlan;
    console.log(`[Claude Tuner] User: ${userEmail}, Plan: ${plan}, UsageOrg: ${org.name} (${orgId})`);

    // 2-1. Fetch subscription info (renewal date, pending plan changes)
    // Team/Enterprise can't access subscription_details (403) — only try personal orgs
    let subscriptionInfo = {};
    const isPersonalPlan = !NON_PERSONAL_PLANS.some(t => bestPlan.startsWith(t));
    if (isPersonalPlan) {
      _ts = performance.now();
      // Find org to fetch subscription info from (personal orgs only — excludes Team/Enterprise/API)
      const subOrgId = await (async () => {
        const personalOrgs = (selectionMethod === 'manual' && bestOrg) ? [bestOrg] : orgList.filter(o => {
          const p = detectPlan(o);
          return !NON_PERSONAL_PLANS.some(s => p.startsWith(s));
        });
        for (const o of personalOrgs) {
          try {
            await fetchClaudeApi(`/api/organizations/${o.uuid}/subscription_details`, { quiet: true });
            return o.uuid;
          } catch (_) {}
        }
        return orgId;
      })();
      subscriptionInfo = await fetchSubscriptionInfo(subOrgId);
      _timings['5_subscription'] = Math.round(performance.now() - _ts);
    }

    // 3. Build snapshot (resets_at normalized to minute precision)
    const extVersion = chrome.runtime.getManifest().version;
    const snapshot = {
      user_email: userEmail,
      plan: plan,
      rate_limit_tier: bestOrg?.rate_limit_tier || null,
      seat_tier: seatTier || null,
      ext_version: extVersion,
      collected_at: new Date().toISOString(),
      subscription: subscriptionInfo,
      ...await buildUsageFields(usageData, config),
      grove_enabled: groveEnabled,
      grove_detected: groveDetected,
      claude_org_uuid: bestOrg?.uuid || null,
      claude_org_name: bestOrg?.name || null,
      is_primary_org: !!config.selectedOrgId && config.selectedOrgId === bestOrg?.uuid,
      last_active_org_uuid: cookieOrgId || null,
    };

    // Include ref_source (removed after first send)
    const { ref_source } = await chrome.storage.local.get('ref_source');
    if (ref_source) {
      snapshot.ref_source = ref_source;
      await chrome.storage.local.remove('ref_source');
    }

    // 4. Send to server (local save only when skipServer is true)
    if (skipServer) {
      console.log('[Claude Tuner] Local-only collection (boost mode)');
      await setStatus({
        success: true,
        timestamp: Date.now(),
        lastSuccessTimestamp: Date.now(),
        snapshot: snapshot,
        recommendation: (await getLastStatus())?.recommendation || null,
        fetchMode: (await chrome.tabs.query({ url: 'https://claude.ai/*' })).length > 0 ? 'tab' : 'cookie',
      });
      // Update collectedOrgs for boost mode so sidebar/input get fresh data
      // (storage.onChanged on collectedOrgs triggers pushSidebarUsage)
      const { collectedOrgs: prevOrgs = [] } = await chrome.storage.local.get({ collectedOrgs: [] });
      const updatedOrgs = prevOrgs.map(o => o.uuid === bestOrg?.uuid ? {
        ...o,
        h5: snapshot.five_hour?.utilization ?? o.h5,
        d7: snapshot.seven_day?.utilization ?? o.d7,
        resetsAt5h: snapshot.five_hour?.resets_at ?? o.resetsAt5h,
        resetsAt7d: snapshot.seven_day?.resets_at ?? o.resetsAt7d,
        extraUsage: snapshot.extra_usage ?? o.extraUsage,
      } : o);
      await chrome.storage.local.set({ collectedOrgs: updatedOrgs });
      await appendUsageHistory(buildHistoryPoint(snapshot, plan));
      updateBadge(snapshot.seven_day?.utilization, snapshot.five_hour?.utilization);
      return { success: true, snapshot, localOnly: true };
    }

    // Request server snapshots if local history lacks recent 6h data
    const { usageHistory: _histCheck = [], historyEmptyUntil = 0 } = await chrome.storage.local.get({ usageHistory: [], historyEmptyUntil: 0 });
    const sixHoursAgo = Date.now() - 6 * 3600000;
    const recent6h = _histCheck.filter(p => p.t > sixHoursAgo);
    const needHistory = recent6h.length < 30 && Date.now() > historyEmptyUntil;
    const body = { ...snapshot, ...(force ? { force: true } : {}), ...(needHistory ? { need_history: true } : {}) };

    // === Server POST: fire-and-forget (don't wait for response) ===
    // Send server save in background, proceed with local UI update first
    const authHeaders = await getAuthHeaders(config);
    const sentToken = bearerFromAuthHeaders(authHeaders);
    fetch(`${config.serverUrl}/api/snapshots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(body),
    }).then(async (response) => {
      if (response.status === 401 || response.status === 403) {
        // ext_token invalid (401) or email mismatch after account switch (403) —
        // clear and fall back to API key on next cycle to re-issue a fresh token.
        // Race-safe: only clear if the token we sent is still the stored one
        // (a concurrent request may have already rotated the token).
        const cleared = await clearExtTokenIfMatches(sentToken);
        if (cleared) {
          console.log(`[Claude Tuner] ext_token cleared (${response.status}). Will re-auth on next cycle.`);
        }
        return;
      }
      if (response.status === 410) {
        const errData = await response.json().catch(() => ({}));
        if (errData.account_deleted) {
          console.log('[Claude Tuner] Account has been deleted. Stopping collection.');
          await chrome.storage.local.set({ account_deleted: true });
          chrome.alarms.clear(ALARM_NAME);
          chrome.action.setBadgeText({ text: '!' });
          chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
          return;
        }
      }
      if (!response.ok) {
        console.warn(`[Claude Tuner] Server POST failed: ${response.status} ${response.statusText}`);
        return;
      }
      const result = await response.json();
      console.log(`[Claude Tuner] Snapshot sent: ${result.success ? 'ok' : 'fail'}${result.skipped ? ' (skipped)' : ''}`);

      // Store ext_token from server (TOFU issuance or refresh)
      if (result.ext_token) {
        await setExtToken(result.ext_token);
      }

      // Apply server-provided poll_interval
      if (result.poll_interval_minutes && result.poll_interval_minutes > 0) {
        const serverInterval = result.poll_interval_minutes;
        await chrome.storage.local.set({ serverPollInterval: serverInterval });
        const { intervalExplicitlySet } = await chrome.storage.sync.get({ intervalExplicitlySet: false });
        if (!intervalExplicitlySet && bestPlan !== 'Free') {
          const currentInterval = config.intervalMinutes || DEFAULT_INTERVAL_MINUTES;
          if (serverInterval !== currentInterval) {
            console.log(`[Claude Tuner] Updating poll interval: ${currentInterval}m → ${serverInterval}m (server)`);
            await chrome.storage.sync.set({ intervalMinutes: serverInterval });
            chrome.alarms.create(ALARM_NAME, { delayInMinutes: serverInterval, periodInMinutes: serverInterval });
          }
        }
      }

      // Save review nudge state
      if (result.review_nudge) {
        await chrome.storage.local.set({ ct_review_nudge: result.review_nudge });
      }
      // Save auto-approve setting
      if (result.admin_order_auto_approve !== undefined) {
        await chrome.storage.local.set({ ct_admin_order_auto_approve: result.admin_order_auto_approve });
      }

      // Handle plan change order
      if (result.plan_order) {
        const po = result.plan_order;
        console.log(`[Claude Tuner] Plan order received: #${po.order_id} ${po.from_plan} → ${po.to_plan} (auto_approve=${po.auto_approve})`);
        await chrome.storage.local.set({ pendingPlanOrder: po });
        if (po.auto_approve) {
          console.log('[Claude Tuner] Auto-approving plan order');
          try {
            await acceptPlanOrder(config, po, userEmail, { auto: true });
          } catch (e) {
            console.error('[Claude Tuner] Auto plan order failed:', e.message);
            await reportPlanOrderResult(config, po.order_id, userEmail, 'accepted', 'failed', e.message);
          }
        } else {
          chrome.action.setIcon({ path: { 16: 'icons/icon16-order.png', 48: 'icons/icon48-order.png', 128: 'icons/icon128-order.png' } });
          chrome.action.setBadgeText({ text: '📋' });
          chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
          chrome.notifications.create('plan-order-' + po.order_id, {
            type: 'basic', iconUrl: 'icons/icon128.png',
            title: await bt('po_title'),
            message: await bt('po_msg', po.org_name, po.from_plan, po.to_plan),
            buttons: [
              { title: await bt('po_accept') },
              { title: await bt('po_reject') },
            ],
            requireInteraction: true,
          });
          logNotification('plan-order');
        }
      }

      // Update lastStatus with server recommendation (also refreshes badge)
      if (!result.skipped && result.recommendation) {
        const curStatus = await getLastStatus();
        if (curStatus) {
          curStatus.recommendation = result.recommendation;
          await setStatus(curStatus);
        }
        const rec = result.recommendation;
        if (rec.type === 'upgrade' || rec.type === 'downgrade') {
          await showRecommendationBadge(snapshot, rec.type);
        }
      }

      // Merge server recent snapshots (history backfill)
      if (needHistory) {
        if (result.recent_snapshots && result.recent_snapshots.length > 0) {
          await mergeServerSnapshots(result.recent_snapshots, plan, snapshot.claude_org_uuid);
        } else {
          try {
            const orgParam = snapshot.claude_org_uuid ? `?org=${encodeURIComponent(snapshot.claude_org_uuid)}` : '';
            const meResp = await authedFetch(config, `${config.serverUrl}/api/me${orgParam}`, {
              headers: { 'X-User-Email': snapshot.user_email },
            });
            if (meResp.ok) {
              const meData = await meResp.json();
              if (meData.recent_snapshots && meData.recent_snapshots.length > 0) {
                await mergeServerSnapshots(meData.recent_snapshots, plan, snapshot.claude_org_uuid);
              } else {
                await chrome.storage.local.set({ historyEmptyUntil: Date.now() + 6 * 3600000 });
              }
            }
          } catch (e) {
            console.warn('[Claude Tuner] Failed to fetch /api/me for history bootstrap:', e.message);
            await chrome.storage.local.set({ historyEmptyUntil: Date.now() + 6 * 3600000 });
          }
        }
      }
    }).catch((e) => {
      console.warn('[Claude Tuner] Server POST fire-and-forget error:', e.message);
    });

    // === Local UI update (don't wait for server response) ===
    const claudeTabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    const fetchMode = claudeTabs.length > 0 ? 'tab' : 'cookie';

    // Keep previous recommendation (will be async-updated when server response arrives)
    const prevStatus = await getLastStatus();
    const recommendation = prevStatus?.recommendation || null;

    await setStatus({
      success: true,
      timestamp: Date.now(),
      lastSuccessTimestamp: Date.now(),
      snapshot: snapshot,
      recommendation,
      fetchMode,
    });

    // Review nudge: track install date + success count
    chrome.storage.local.get({ ct_install_date: null, ct_success_count: 0 }, (r) => {
      const u = { ct_success_count: (r.ct_success_count || 0) + 1 };
      if (!r.ct_install_date) u.ct_install_date = Date.now();
      chrome.storage.local.set(u);

      // Update uninstall tracking URL
      const daysUsed = r.ct_install_date ? Math.floor((Date.now() - r.ct_install_date) / 86400000) : 0;
      const params = new URLSearchParams({
        email: snapshot.user_email || '',
        plan: snapshot.plan || '',
        v: chrome.runtime.getManifest().version,
        days: String(daysUsed),
        lang: snapshot.user_language || (chrome.i18n?.getUILanguage?.()?.startsWith('ko') ? 'ko' : 'en'),
      });
      chrome.runtime.setUninstallURL(`${DEFAULT_SERVER_URL}/api/uninstall?${params}`);
    });

    // 4-0.5 Sync notification permission & preferences to server (fire-and-forget, on change only)
    syncNotificationPermission(config, snapshot.user_email);
    syncNotificationPrefs(config, snapshot.user_email);

    // 4-1. Save local usage history (last 7 days, for sparkline + prediction)
    await appendUsageHistory(buildHistoryPoint(snapshot, plan));

    // 4-2. Update badge (based on previous recommendation, async-updated on server response)
    if (recommendation?.type === 'upgrade' || recommendation?.type === 'downgrade') {
      await showRecommendationBadge(snapshot, recommendation.type);
    } else {
      await updateBadge(snapshot.seven_day.utilization, snapshot.five_hour.utilization);
    }

    // 4-3. Usage threshold alerts
    await checkUsageAlerts(snapshot);

    sendGAEvent('collect_success', { plan: snapshot.plan, fetch_mode: fetchMode });
    // On success: reset heartbeat timer + clear error code + reset collect fail state
    chrome.storage.local.remove(['lastHeartbeatAt', 'collectFailState']);

    // === Multi-org collection: send additional org snapshots beyond primary (up to 3 orgs total) ===
    if (!skipServer) {
      const MAX_ORGS = 3;
      // Determine target orgs: exclude API + exclude Free if multi-org
      const isMultiOrg = orgList.filter(o => detectPlan(o) !== 'API').length > 1;
      const monitorableOrgs = orgList.filter(o => {
        const p = detectPlan(o);
        if (p === 'API') return false;
        if (isMultiOrg && p === 'Free') return false;
        return true;
      });
      let targetOrgs = monitorableOrgs;

      const { orgAutoAll, selectedOrgIds } = await chrome.storage.sync.get({ orgAutoAll: true, selectedOrgIds: null });

      if (orgAutoAll) {
        // Auto collect all: all orgs (MAX_ORGS limit applied)
        targetOrgs = monitorableOrgs.slice(0, MAX_ORGS);
      } else if (monitorableOrgs.length > MAX_ORGS) {
        // Manual selection mode + 4 or more orgs
        if (selectedOrgIds && Array.isArray(selectedOrgIds) && selectedOrgIds.length > 0) {
          targetOrgs = monitorableOrgs.filter(o => selectedOrgIds.includes(o.uuid));
          if (targetOrgs.length === 0) targetOrgs = monitorableOrgs.slice(0, MAX_ORGS);
        } else {
          targetOrgs = monitorableOrgs
            .map(o => ({ org: o, score: planScoreMap[detectPlan(o)] || 0 }))
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_ORGS)
            .map(x => x.org);
        }
      }

      // Collect additional orgs beyond primary (continue collecting other orgs on individual failure)
      // === Adaptive polling: secondary orgs adjust poll interval based on usage changes ===
      _ts = performance.now();
      const additionalOrgs = targetOrgs.filter(o => o.uuid !== bestOrg?.uuid);
      const successOrgs = [bestOrg?.uuid]; // primary already succeeded
      const orgUsageMap = {}; // Per-org usage storage (for popup chip display)
      orgUsageMap[bestOrg?.uuid] = {
        h5: snapshot.five_hour.utilization, d7: snapshot.seven_day.utilization,
        spendUsed: snapshot.extra_usage?.used_credits ?? null,
        spendLimit: snapshot.extra_usage?.monthly_limit ?? null,
        plan: plan, // bestPlan (seat_tier refinement done)
        resetsAt5h: snapshot.five_hour?.resets_at || null,
        resetsAt7d: snapshot.seven_day?.resets_at || null,
        extraUsage: snapshot.extra_usage || null,
      };
      const failedOrgs = [];
      const skippedOrgs = []; // Orgs skipped by adaptive polling

      // Load adaptive poll state
      const { orgPollState: _pollState } = await chrome.storage.local.get({ orgPollState: {} });
      const orgPollState = _pollState || {};
      const baseIntervalMs = (config.intervalMinutes || DEFAULT_INTERVAL_MINUTES) * 60 * 1000;
      const now = Date.now();

      for (const extraOrg of additionalOrgs) {
        // Initialize poll state for new orgs
        if (!orgPollState[extraOrg.uuid]) {
          orgPollState[extraOrg.uuid] = getOrgPollDefault();
        }
        const pollState = orgPollState[extraOrg.uuid];

        // Check if this org is due for polling (skip if not, unless forced)
        if (!force && !isOrgDueForPoll(pollState, now, baseIntervalMs)) {
          skippedOrgs.push({ uuid: extraOrg.uuid, name: extraOrg.name, tier: pollState.tier });
          // Use cached values for popup display (don't remove from collectedOrgs)
          if (pollState.lastValues.h5 != null || pollState.lastValues.d7 != null || pollState.lastValues.extraUsed != null) {
            successOrgs.push(extraOrg.uuid);
            orgUsageMap[extraOrg.uuid] = {
              h5: pollState.lastValues.h5, d7: pollState.lastValues.d7,
              spendUsed: pollState.lastValues.extraUsed, spendLimit: null,
              plan: await refineTeamPlan(detectPlan(extraOrg), extraOrg.uuid),
              resetsAt5h: pollState.lastValues.resetsAt5h || null,
              resetsAt7d: pollState.lastValues.resetsAt7d || null,
              extraUsage: pollState.lastValues.extraUsage || null,
            };
          }
          continue;
        }

        try {
          const extraUsage = await fetchClaudeApi(`/api/organizations/${extraOrg.uuid}/usage`);
          if (!extraUsage) {
            failedOrgs.push({ uuid: extraOrg.uuid, name: extraOrg.name, reason: 'empty_usage' });
            continue;
          }

          let extraPlan = await refineTeamPlan(detectPlan(extraOrg), extraOrg.uuid);
          // Look up this org's seat_tier from allSeatTiers (for server submission)
          const acctCache = await chrome.storage.local.get({ accountCache: null });
          const extraSeatTier = acctCache.accountCache?.allSeatTiers?.[extraOrg.uuid] || null;

          // Adaptive polling: compare current values with previous
          const currentValues = {
            h5: extraUsage.five_hour?.utilization ?? null,
            d7: extraUsage.seven_day?.utilization ?? null,
            extraUsed: extraUsage.extra_usage?.used_credits ?? null,
            // Cache these for popup display when skipping future polls
            resetsAt5h: normalizeResetTime(extraUsage.five_hour?.resets_at) || null,
            resetsAt7d: normalizeResetTime(extraUsage.seven_day?.resets_at) || null,
            extraUsage: normalizeExtraUsage(extraUsage.extra_usage),
          };
          const usageChanged = hasOrgUsageChanged(pollState.lastValues, currentValues);
          orgPollState[extraOrg.uuid] = updateOrgPollState(pollState, currentValues, usageChanged);

          const isPersonalExtra = !NON_PERSONAL_PLANS.some(t => extraPlan.startsWith(t));
          const extraSnapshot = {
            user_email: userEmail,
            plan: extraPlan,
            rate_limit_tier: extraOrg.rate_limit_tier || null,
            seat_tier: extraSeatTier,
            ext_version: extVersion,
            collected_at: new Date().toISOString(),
            subscription: isPersonalExtra ? await fetchSubscriptionInfo(extraOrg.uuid) : {},
            ...await buildUsageFields(extraUsage, config),
            grove_enabled: null,
            grove_detected: false,
            claude_org_uuid: extraOrg.uuid,
            claude_org_name: extraOrg.name || null,
            is_heartbeat: !usageChanged,
          };

          // Usage API success — populate orgUsageMap/successOrgs immediately (regardless of server POST result)
          successOrgs.push(extraOrg.uuid);
          orgUsageMap[extraOrg.uuid] = {
            h5: extraUsage.five_hour?.utilization ?? null, d7: extraUsage.seven_day?.utilization ?? null,
            spendUsed: extraUsage.extra_usage?.used_credits ?? null, spendLimit: extraUsage.extra_usage?.monthly_limit ?? null,
            plan: extraPlan,
            resetsAt5h: normalizeResetTime(extraUsage.five_hour?.resets_at) || null,
            resetsAt7d: normalizeResetTime(extraUsage.seven_day?.resets_at) || null,
            extraUsage: normalizeExtraUsage(extraUsage.extra_usage),
          };
          // Save extra org history too (for per-org view)
          await appendUsageHistory(buildHistoryPoint(extraSnapshot, extraPlan));
          const tierTag = orgPollState[extraOrg.uuid].tier !== 'active' ? ` [${orgPollState[extraOrg.uuid].tier}]` : '';
          console.log(`[Claude Tuner] Extra org snapshot: ${extraOrg.name} (${extraPlan})${tierTag}${usageChanged ? '' : ' [heartbeat]'}`);

          // Server POST: fire-and-forget
          authedFetch(config, `${config.serverUrl}/api/snapshots`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(force ? { ...extraSnapshot, force: true } : extraSnapshot),
          }).then(r => {
            if (r && !r.ok) console.warn(`[Claude Tuner] Extra org ${extraOrg.name} server: ${r.status}`);
          }).catch(e => {
            console.warn(`[Claude Tuner] Extra org ${extraOrg.name} POST failed:`, e.message);
          });
        } catch (e) {
          // 403/401 = removed from org, 429 = rate limited, etc. — continue collecting other orgs
          failedOrgs.push({ uuid: extraOrg.uuid, name: extraOrg.name, reason: e.message });
          console.warn(`[Claude Tuner] Extra org ${extraOrg.name} failed:`, e.message);
        }
      }

      // Clean up poll state for orgs no longer in targetOrgs
      const activeOrgIds = new Set(targetOrgs.map(o => o.uuid));
      for (const uuid of Object.keys(orgPollState)) {
        if (!activeOrgIds.has(uuid)) delete orgPollState[uuid];
      }
      await chrome.storage.local.set({ orgPollState });

      if (skippedOrgs.length > 0) {
        console.log(`[Claude Tuner] Adaptive skip: ${skippedOrgs.map(s => `${s.name}(${s.tier})`).join(', ')}`);
      }
      if (failedOrgs.length > 0) {
        console.log(`[Claude Tuner] Multi-org: ${successOrgs.length} ok, ${failedOrgs.length} failed:`,
          failedOrgs.map(f => `${f.name}(${f.reason})`).join(', '));
      }

      // Save collected org list (only successful orgs shown in popup, with usage data)
      const collectedOrgsRaw = targetOrgs.filter(o => successOrgs.includes(o.uuid));
      const collectedOrgs = [];
      for (const o of collectedOrgsRaw) {
        collectedOrgs.push({
          uuid: o.uuid, name: o.name, plan: orgUsageMap[o.uuid]?.plan || await refineTeamPlan(detectPlan(o), o.uuid),
          isPrimary: o.uuid === bestOrg?.uuid,
          h5: orgUsageMap[o.uuid]?.h5 ?? null,
          d7: orgUsageMap[o.uuid]?.d7 ?? null,
          spendUsed: orgUsageMap[o.uuid]?.spendUsed ?? null,
          spendLimit: orgUsageMap[o.uuid]?.spendLimit ?? null,
          resetsAt5h: orgUsageMap[o.uuid]?.resetsAt5h ?? null,
          resetsAt7d: orgUsageMap[o.uuid]?.resetsAt7d ?? null,
          extraUsage: orgUsageMap[o.uuid]?.extraUsage ?? null,
        });
      }
      await chrome.storage.local.set({ collectedOrgs, failedOrgs: failedOrgs.length > 0 ? failedOrgs : null });
      _timings['7_extra_orgs'] = Math.round(performance.now() - _ts);
    }

    _timings['TOTAL'] = Math.round(performance.now() - _t0);
    console.log(`[Claude Tuner] ⏱️ Timing (ms):`, JSON.stringify(_timings));
    return { success: true, snapshot };

  } catch (error) {
    const errorMsg = error.message || 'Unknown error';
    console.error('[Claude Tuner] Collection failed:', errorMsg);
    const prevStatus = await getLastStatus();
    await setStatus({
      error: errorMsg,
      timestamp: Date.now(),
      lastSuccessTimestamp: prevStatus?.lastSuccessTimestamp
        || (prevStatus?.success ? prevStatus?.timestamp : null),
    });

    // On collection failure: show error badge + check collect-fail notification
    updateBadgeError();
    await checkCollectFailNotification(errorMsg);

    sendGAEvent('collect_fail', { error: errorMsg.slice(0, 100) });

    // Send heartbeat every 6 hours (notify server of connection failure state)
    try {
      const { lastHeartbeatAt } = await chrome.storage.local.get('lastHeartbeatAt');
      if (!lastHeartbeatAt || (Date.now() - lastHeartbeatAt) >= HEARTBEAT_INTERVAL_MS) {
        const cfg = await getConfig();
        if (cfg.serverUrl && cfg.apiKey) {
          const ver = chrome.runtime.getManifest().version;
          const { accountCache } = await chrome.storage.local.get('accountCache');
          const hbEmail = accountCache?.email;
          if (hbEmail) {
            authedFetch(cfg, `${cfg.serverUrl}/api/heartbeat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: hbEmail, error_code: errorMsg.split(':')[0].slice(0, 50), ext_version: ver }),
            }).catch(() => {});
          }
          await chrome.storage.local.set({ lastHeartbeatAt: Date.now() });
        }
      }
    } catch (_) {}

    return { success: false, error: errorMsg };
  }
}
