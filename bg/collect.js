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
import { checkCollectFailNotification, checkUsageAlerts } from './notifications.js';
import {
  detectPlan, refineTeamPlan, fetchSubscriptionInfo,
  acceptPlanOrder, reportPlanOrderResult,
} from './plan.js';
import { getConfig, setStatus, getLastStatus, appendUsageHistory, mergeServerSnapshots } from './storage.js';

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
    seven_day_opus: {
      utilization: usageData.seven_day_opus?.utilization ?? null,
      resets_at: normalizeResetTime(usageData.seven_day_opus?.resets_at),
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

// === lastActiveOrg cookie 기반 org 감지 ===
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
  // 삭제된 계정이면 수집 중단
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
    // 1. 조직 정보 가져오기 (쿠키 인증, org-scoped 엔드포인트)
    let _ts = performance.now();
    const orgList = await fetchClaudeApi('/api/organizations');
    _timings['1_organizations'] = Math.round(performance.now() - _ts);

    if (!Array.isArray(orgList) || orgList.length === 0) {
      throw new Error('err_no_orgs');
    }

    // 각 org에서 플랜 감지 (API만 무시)
    const orgPlans = orgList.map(o => { const p = detectPlan(o); return `${o.name}(${p})${p === 'API' ? '[skip]' : ''}`; });
    console.log(`[Claude Tuner] ${orgList.length} orgs:`, orgPlans.join(' | '));
    const planScoreMap = { 'Max 20x': 7, 'Team Premium': 6, 'Max 5x': 5, 'Team Standard': 4, 'Max': 3.5, 'Enterprise': 3, 'Team': 2.5, 'Team Tier 2': 2.5, 'Pro': 2, 'Free': 1 };

    // === Primary org 선택: 수동 > 쿠키 > 플랜 점수 fallback ===
    let bestOrg = null;
    let bestPlan = 'unknown';
    let selectionMethod = '';
    const cookieOrgId = await getLastActiveOrgId();

    // 1) 수동 선택 (selectedOrgId)
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

    // 2) lastActiveOrg 쿠키 (Claude.ai가 org 전환 시 자동 설정)
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

    // 3) 플랜 점수 기반 fallback (쿠키 없거나 매칭 실패 시)
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
    // 옵션 페이지 표시용: 자동 선택된 조직 정보 저장
    if (bestOrg && selectionMethod !== 'manual') {
      await chrome.storage.local.set({ autoSelectedOrg: { name: bestOrg.name, plan: bestPlan, uuid: bestOrg.uuid } });
    }

    // 이메일 추출: email_address가 있는 org 우선, 없으면 org.name에서 추출
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
    // /api/account에서 이메일 + seat_tier 가져오기 (캐시 8시간)
    // grove_enabled는 별도 캐시 (30분) — 더 자주 변경될 수 있음
    let seatTier = null;
    let groveEnabled = null;
    let groveDetected = false; // API에서 grove_enabled를 성공적으로 읽었는지 여부
    {
      const ACCOUNT_CACHE_TTL = 8 * 60 * 60 * 1000; // 8시간
      const GROVE_CACHE_TTL = 30 * 60 * 1000; // 30분
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
          // 모든 org의 seat_tier 저장 (extra org plan 세분화용)
          const allSeatTiers = {};
          for (const m of memberships) {
            const mOrgUuid = m.organization_uuid || m.organization?.uuid;
            if (mOrgUuid && m.seat_tier) allSeatTiers[mOrgUuid] = m.seat_tier;
          }
          const acctName = acct?.full_name || acct?.display_name || '';
          await chrome.storage.local.set({ accountCache: { email: acctEmail, name: acctName, seatTier, orgUuid: bestOrgUuid, allSeatTiers, ts: Date.now() } });
          console.log('[Claude Tuner] Account API:', acctEmail, 'seat:', seatTier, 'org:', bestOrgUuid);
          // grove_enabled도 같은 응답에서 파싱 (추가 API 호출 불필요)
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

      // --- grove_enabled (별도 캐시 30분) ---
      const groveCacheValid = !force && groveC && (Date.now() - groveC.ts) < GROVE_CACHE_TTL;
      if (groveCacheValid) {
        groveEnabled = groveC.value ?? null;
        groveDetected = groveC.detected ?? false;
        console.log('[Claude Tuner] grove (cached):', groveEnabled, 'detected:', groveDetected);
      } else if (!groveDetected) {
        // account API에서 이미 파싱된 경우 스킵
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
                  // 파싱 실패 — 디버그 정보 수집
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
              // regex 매칭 성공 (true/false/null 모두 포함) → 명시적 감지
              groveEnabled = gr.value;
              groveDetected = true;
            } else if (gr) {
              // 파싱 실패 — debug 정보 있음
              if (gr.value != null) groveEnabled = gr.value;
            }
            saveGroveCache(groveEnabled, groveDetected);
            console.log('[Claude Tuner] grove API:', groveEnabled, 'detected:', groveDetected);
          } else {
            // 탭 없음 → 쿠키 폴백
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
          // 쿠키 기반 폴백: executeScript 실패 시 (권한 부족 등)
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

    // 시트 타입에 따라 플랜 세분화
    if (bestPlan === 'Team' && seatTier) {
      bestPlan = SEAT_TIER_MAP[seatTier] || 'Team Standard';
      console.log(`[Claude Tuner] Team seat_tier: ${seatTier} → ${bestPlan}`);
    } else if (bestPlan === 'Enterprise' && seatTier) {
      console.log(`[Claude Tuner] Enterprise seat_tier: ${seatTier}`);
    }

    // 모니터링 불가 조직 체크 (API만 해당)
    if (!bestOrg || bestPlan === 'API') {
      const hasAPI = orgList.some(o => detectPlan(o) === 'API');
      if (hasAPI) {
        throw new Error('err_api_only');
      } else {
        throw new Error('err_no_monitorable');
      }
    }

    // Free plan → 폴링 주기 60분으로 강제 / 업그레이드 시 복원
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

    // usage 데이터: 선택된 primary org에서 가져오기
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

    // 2-1. 구독 정보 가져오기 (갱신일, 예정 플랜 변경)
    // Team/Enterprise는 subscription_details 접근 불가 (403) → 개인 org에서만 시도
    let subscriptionInfo = {};
    const isPersonalPlan = !NON_PERSONAL_PLANS.some(t => bestPlan.startsWith(t));
    if (isPersonalPlan) {
      _ts = performance.now();
      // 구독 정보를 가져올 org 탐색 (개인 org만 — Team/Enterprise/API 제외)
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

    // 3. 스냅샷 빌드 (resets_at는 분 단위로 정규화)
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

    // ref_source 포함 (첫 전송 후 삭제)
    const { ref_source } = await chrome.storage.local.get('ref_source');
    if (ref_source) {
      snapshot.ref_source = ref_source;
      await chrome.storage.local.remove('ref_source');
    }

    // 4. 서버로 전송 (skipServer 시 로컬 저장만)
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
      await appendUsageHistory(buildHistoryPoint(snapshot, plan));
      updateBadge(snapshot.seven_day?.utilization, snapshot.five_hour?.utilization);
      return { success: true, snapshot, localOnly: true };
    }

    // 로컬 히스토리에 최근 6h 데이터가 부족하면 서버에 스냅샷 요청
    const { usageHistory: _histCheck = [], historyEmptyUntil = 0 } = await chrome.storage.local.get({ usageHistory: [], historyEmptyUntil: 0 });
    const sixHoursAgo = Date.now() - 6 * 3600000;
    const recent6h = _histCheck.filter(p => p.t > sixHoursAgo);
    const needHistory = recent6h.length < 30 && Date.now() > historyEmptyUntil;
    const body = { ...snapshot, ...(force ? { force: true } : {}), ...(needHistory ? { need_history: true } : {}) };

    // === 서버 POST: fire-and-forget (응답을 기다리지 않음) ===
    // 서버 저장은 백그라운드로 보내고, 로컬 UI 업데이트를 먼저 진행
    fetch(`${config.serverUrl}/api/snapshots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.apiKey,
      },
      body: JSON.stringify(body),
    }).then(async (response) => {
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

      // 서버 제공 poll_interval 반영
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

      // 리뷰 넛지 상태 저장
      if (result.review_nudge) {
        await chrome.storage.local.set({ ct_review_nudge: result.review_nudge });
      }
      // 자동승인 설정 저장
      if (result.admin_order_auto_approve !== undefined) {
        await chrome.storage.local.set({ ct_admin_order_auto_approve: result.admin_order_auto_approve });
      }

      // 플랜 변경 오더 처리
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
        }
      }

      // 서버 recommendation으로 lastStatus 업데이트 (배지도 갱신)
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

      // 서버 최근 스냅샷 병합 (히스토리 백필)
      if (needHistory) {
        if (result.recent_snapshots && result.recent_snapshots.length > 0) {
          await mergeServerSnapshots(result.recent_snapshots, plan, snapshot.claude_org_uuid);
        } else {
          try {
            const orgParam = snapshot.claude_org_uuid ? `?org=${encodeURIComponent(snapshot.claude_org_uuid)}` : '';
            const meResp = await fetch(`${config.serverUrl}/api/me${orgParam}`, {
              headers: { 'X-API-Key': config.apiKey, 'X-User-Email': snapshot.user_email },
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

    // === 로컬 UI 업데이트 (서버 응답을 기다리지 않음) ===
    const claudeTabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    const fetchMode = claudeTabs.length > 0 ? 'tab' : 'cookie';

    // 이전 recommendation 유지 (서버 응답 도착 시 비동기 갱신됨)
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

      // Uninstall tracking URL 갱신
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

    // 4-1. 로컬 사용률 히스토리 저장 (최근 7일, 스파크라인+예측용)
    await appendUsageHistory(buildHistoryPoint(snapshot, plan));

    // 4-2. 배지 업데이트 (이전 recommendation 기반, 서버 응답 시 비동기 갱신)
    if (recommendation?.type === 'upgrade' || recommendation?.type === 'downgrade') {
      await showRecommendationBadge(snapshot, recommendation.type);
    } else {
      await updateBadge(snapshot.seven_day.utilization, snapshot.five_hour.utilization);
    }

    // 4-3. 사용률 임계값 알림
    await checkUsageAlerts(snapshot);

    sendGAEvent('collect_success', { plan: snapshot.plan, fetch_mode: fetchMode });
    // 성공 시 heartbeat 타이머 리셋 + 에러 코드 클리어 + 수집 실패 상태 리셋
    chrome.storage.local.remove(['lastHeartbeatAt', 'collectFailState']);

    // === 멀티 org 수집: primary org 외 추가 org 스냅샷 전송 (최대 3개 org 총) ===
    if (!skipServer) {
      const MAX_ORGS = 3;
      // 수집 대상 org 결정: API 제외 + 멀티 org이면 Free도 제외
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
        // 전체 자동 수집: 모든 org (MAX_ORGS 제한 적용)
        targetOrgs = monitorableOrgs.slice(0, MAX_ORGS);
      } else if (monitorableOrgs.length > MAX_ORGS) {
        // 수동 선택 모드 + 4개 이상
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

      // primary org 외 추가 org 수집 (개별 org 실패 시 다른 org 수집 계속)
      // === Adaptive polling: secondary org는 사용량 변화에 따라 폴링 주기 조절 ===
      _ts = performance.now();
      const additionalOrgs = targetOrgs.filter(o => o.uuid !== bestOrg?.uuid);
      const successOrgs = [bestOrg?.uuid]; // primary는 이미 성공
      const orgUsageMap = {}; // org별 사용률 저장 (popup 칩 표시용)
      orgUsageMap[bestOrg?.uuid] = {
        h5: snapshot.five_hour.utilization, d7: snapshot.seven_day.utilization,
        spendUsed: snapshot.extra_usage?.used_credits ?? null,
        spendLimit: snapshot.extra_usage?.monthly_limit ?? null,
        plan: plan, // bestPlan (seat_tier 세분화 완료)
        resetsAt5h: snapshot.five_hour?.resets_at || null,
        resetsAt7d: snapshot.seven_day?.resets_at || null,
        extraUsage: snapshot.extra_usage || null,
      };
      const failedOrgs = [];
      const skippedOrgs = []; // adaptive polling으로 스킵된 org

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
          // allSeatTiers에서 해당 org의 seat_tier 조회 (서버 전송용)
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

          // usage API 성공 → orgUsageMap/successOrgs 즉시 채움 (서버 POST 결과 무관)
          successOrgs.push(extraOrg.uuid);
          orgUsageMap[extraOrg.uuid] = {
            h5: extraUsage.five_hour?.utilization ?? null, d7: extraUsage.seven_day?.utilization ?? null,
            spendUsed: extraUsage.extra_usage?.used_credits ?? null, spendLimit: extraUsage.extra_usage?.monthly_limit ?? null,
            plan: extraPlan,
            resetsAt5h: normalizeResetTime(extraUsage.five_hour?.resets_at) || null,
            resetsAt7d: normalizeResetTime(extraUsage.seven_day?.resets_at) || null,
            extraUsage: normalizeExtraUsage(extraUsage.extra_usage),
          };
          // extra org 히스토리도 저장 (org별 뷰용)
          await appendUsageHistory(buildHistoryPoint(extraSnapshot, extraPlan));
          const tierTag = orgPollState[extraOrg.uuid].tier !== 'active' ? ` [${orgPollState[extraOrg.uuid].tier}]` : '';
          console.log(`[Claude Tuner] Extra org snapshot: ${extraOrg.name} (${extraPlan})${tierTag}${usageChanged ? '' : ' [heartbeat]'}`);

          // 서버 POST: fire-and-forget
          fetch(`${config.serverUrl}/api/snapshots`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
            body: JSON.stringify(force ? { ...extraSnapshot, force: true } : extraSnapshot),
          }).then(r => {
            if (!r.ok) console.warn(`[Claude Tuner] Extra org ${extraOrg.name} server: ${r.status}`);
          }).catch(e => {
            console.warn(`[Claude Tuner] Extra org ${extraOrg.name} POST failed:`, e.message);
          });
        } catch (e) {
          // 403/401 = org에서 제거됨, 429 = 레이트리밋 등 — 다른 org 수집은 계속
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

      // 수집된 org 목록 저장 (성공한 org만 popup에 표시, 사용률 포함)
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

    // 수집 실패 시 에러 배지 표시 + 수집 중단 알림 체크
    updateBadgeError();
    await checkCollectFailNotification(errorMsg);

    sendGAEvent('collect_fail', { error: errorMsg.slice(0, 100) });

    // 6시간 간격으로 heartbeat 전송 (연결 실패 상태 서버에 알림)
    try {
      const { lastHeartbeatAt } = await chrome.storage.local.get('lastHeartbeatAt');
      if (!lastHeartbeatAt || (Date.now() - lastHeartbeatAt) >= HEARTBEAT_INTERVAL_MS) {
        const cfg = await getConfig();
        if (cfg.serverUrl && cfg.apiKey) {
          const ver = chrome.runtime.getManifest().version;
          const { accountCache } = await chrome.storage.local.get('accountCache');
          const hbEmail = accountCache?.email;
          if (hbEmail) {
            fetch(`${cfg.serverUrl}/api/heartbeat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.apiKey },
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
