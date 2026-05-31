// === ES Module Imports ===
import { sendGAEvent } from './bg/analytics.js';
import {
  ALARM_NAME, ALARM_EXPIRE_PREFIX, ALARM_BOOST, ALARM_WEEKLY_REPORT,
  DEFAULT_INTERVAL_MINUTES, FREE_PLAN_INTERVAL_MINUTES,
  LOCAL_ACTIVE_INTERVAL_MINUTES, LOCAL_BACKGROUND_INTERVAL_MINUTES,
  VISIBILITY_THROTTLE_MS, POPUP_COLLECT_THROTTLE_MS,
  NOTIF_ID_OPTIMIZE, NOTIF_ID_ALERT,
  DEFAULT_SERVER_URL, SITE_URL,
} from './bg/constants.js';
import { getActivityState, setActivityState, ACTIVITY_STATES } from './bg/activity.js';
import { bt } from './bg/i18n.js';
import { getConfig, getLastStatus, setStatus, getUsageHistory, appendUsageHistory, authedFetch } from './bg/storage.js';
import { fetchClaudeApi } from './bg/api.js';
import { updateBadge, updateBadgeForSelectedOrg, getSelectedOrgUsage, resetIcon } from './bg/badge.js';
import { scheduleWeeklyReport, sendWeeklyReport, logNotification } from './bg/notifications.js';
import {
  detectPlan, executePlanChange, cancelDowngrade, downgradeTo,
  acceptPlanOrder, reportPlanOrderResult, dismissRecommendationServer, muteRecommendationServer,
  setCollectAndSendRef,
} from './bg/plan.js';
import { collectAndSend as _collectAndSend, getLastActiveOrgId } from './bg/collect.js';
import { collectChatGPT } from './bg/collect-chatgpt.js';
import { collectGemini } from './bg/collect-gemini.js';

// Check if optional host permission is granted for a provider
function hasProviderPermission(provider) {
  const origins = {
    chatgpt: ['https://chatgpt.com/*'],
    gemini: ['https://gemini.google.com/*'],
  };
  if (!origins[provider]) return Promise.resolve(true);
  return chrome.permissions.contains({ origins: origins[provider] });
}

// Whether the user currently has a Claude.ai session (sessionKey cookie).
// Used to attempt Claude collection even for provider-first users who later
// sign in to Claude — without it, skipClaude would permanently skip Claude.
async function hasClaudeSession() {
  try {
    const cookies = await chrome.cookies.getAll({ url: 'https://claude.ai' });
    return cookies.some((c) => c.name === 'sessionKey');
  } catch {
    return false;
  }
}

// Merge ChatGPT orgs into collectedOrgs storage (independent of Claude collection)
async function mergeChatGPTOrgs() {
  try {
    const result = await collectChatGPT();
    const { collectedOrgs = [] } = await chrome.storage.local.get({ collectedOrgs: [] });
    const nonChatGPT = collectedOrgs.filter(o => o.provider !== 'chatgpt');
    if (result.orgs.length > 0) {
      // Preserve user-pinned primary org
      const prevPrimaryUuid = collectedOrgs.find(o => o.isPrimary)?.uuid;
      const merged = result.orgs.map(o => ({ ...o, isPrimary: o.uuid === prevPrimaryUuid }));
      await chrome.storage.local.set({ collectedOrgs: [...nonChatGPT, ...merged] });
      // Save history for chart display
      for (const org of result.orgs) {
        await appendUsageHistory({
          t: Date.now(), h5: org.h5 ?? null, d7: org.d7 ?? null,
          p: org.plan, r7: org.resetsAt7d || null, org: org.uuid,
        });
      }
      // Provider-only users (no Claude) — refresh the badge to this provider's
      // usage, since the Claude path won't run to update it.
      const { accountCache } = await chrome.storage.local.get({ accountCache: null });
      if (!accountCache?.email) await updateBadgeForSelectedOrg(null);
    }
  } catch (e) {
    console.warn('[Claude Tuner] ChatGPT collection skipped:', e.message);
  }
}

// Merge Gemini orgs into collectedOrgs storage (independent of Claude collection)
async function mergeGeminiOrgs() {
  try {
    const result = await collectGemini();
    const { collectedOrgs = [] } = await chrome.storage.local.get({ collectedOrgs: [] });
    const nonGemini = collectedOrgs.filter(o => o.provider !== 'gemini');
    if (result.orgs.length > 0) {
      // Preserve user-pinned primary org
      const prevPrimaryUuid = collectedOrgs.find(o => o.isPrimary)?.uuid;
      const merged = result.orgs.map(o => ({ ...o, isPrimary: o.uuid === prevPrimaryUuid }));
      await chrome.storage.local.set({ collectedOrgs: [...nonGemini, ...merged] });
      // Save history for chart display
      for (const org of result.orgs) {
        await appendUsageHistory({
          t: Date.now(), h5: org.h5 ?? null, d7: org.d7 ?? null,
          p: org.plan, r7: org.resetsAt7d || null, org: org.uuid,
        });
      }
      // Provider-only users (no Claude) — refresh the badge to this provider's
      // usage, since the Claude path won't run to update it.
      const { accountCache } = await chrome.storage.local.get({ accountCache: null });
      if (!accountCache?.email) await updateBadgeForSelectedOrg(null);
    }
  } catch (e) {
    console.warn('[Claude Tuner] Gemini collection skipped:', e.message);
  }
}

// Wrap collectAndSend to suppress spurious cookie-change events during collection
// ChatGPT/Gemini collection runs independently after Claude (regardless of Claude result)
async function collectAndSend(opts) {
  _collecting = true;
  try {
    const { collectClaude = true, collectChatGPT = true, collectGemini = true } = await chrome.storage.sync.get({ collectClaude: true, collectChatGPT: true, collectGemini: true });
    let result = { success: false, skipped: true };
    // Don't attempt Claude collection for users who clearly aren't Claude users —
    // it would always fail and surface a misleading "session expired" error +
    // "!" badge. This covers magic-link (independent) accounts AND signed-out
    // provider-only users (Gemini/ChatGPT collected, no Claude org/session).
    const { accountCache, independentAccount, collectedOrgs = [] } =
      await chrome.storage.local.get({ accountCache: null, independentAccount: null, collectedOrgs: [] });
    const hasClaudeOrg = collectedOrgs.some(o => (o.provider || 'claude') === 'claude');
    const hasProviderOrg = collectedOrgs.some(o => (o.provider || 'claude') !== 'claude');
    // Attempt Claude when a Claude.ai session exists — a provider-first user who
    // later signs in to Claude should be picked up, not permanently skipped.
    const claudeSession = await hasClaudeSession();
    const skipClaude = !accountCache?.email && !hasClaudeOrg && !claudeSession
      && (!!independentAccount?.email || hasProviderOrg);
    let claudeAttempted = false;
    if (collectClaude && !skipClaude) {
      claudeAttempted = true;
      result = await _collectAndSend(opts);
    } else if (skipClaude) {
      const prev = await getLastStatus();
      if (prev?.error) { await setStatus(null); resetIcon(); }
    }
    // Claude was attempted (because a session cookie was present) and failed with
    // an AUTH/session error, yet there's no Claude account backing it
    // (accountCache.email) while provider orgs exist — i.e. a non-Claude user with
    // a stale/invalid Claude session. Don't surface a Claude failure to them:
    // drop any leftover Claude org and clear the error/"!" badge. A valid session
    // would have SUCCEEDED above and repopulated the cache, so an active account
    // is never affected. Gated on auth errors only (not transient network/
    // rate-limit failures) and done post-attempt.
    const _errCode = (result && result.error) || '';
    const _isAuthError = _errCode.startsWith('err_auth_failed') || _errCode.startsWith('err_session_expired');
    if (claudeAttempted && result && !result.success && _isAuthError && !accountCache?.email && hasProviderOrg) {
      const { collectedOrgs: cur = [] } = await chrome.storage.local.get({ collectedOrgs: [] });
      const pruned = cur.filter(o => (o.provider || 'claude') !== 'claude');
      if (pruned.length !== cur.length) {
        await chrome.storage.local.set({ collectedOrgs: pruned });
      }
      const prevStale = await getLastStatus();
      if (prevStale?.error) { await setStatus(null); resetIcon(); }
    }
    // Await provider collection (sequentially) so the MV3 service worker stays
    // alive until each fetch+POST finishes. Fire-and-forget here meant the SW
    // could be terminated right after the awaited Claude work, killing in-flight
    // provider requests → dropped snapshots / irregular collection. Sequential
    // (not parallel) keeps peak load minimal on low-spec machines; .catch keeps
    // each provider independent so one failure doesn't block the other.
    if (collectChatGPT && await hasProviderPermission('chatgpt')) {
      await mergeChatGPTOrgs().catch(() => {});
    }
    if (collectGemini && await hasProviderPermission('gemini')) {
      await mergeGeminiOrgs().catch(() => {});
    }
    return result;
  } catch (e) {
    // Claude failed — still try ChatGPT/Gemini independently if enabled.
    // Await (sequentially) so the SW isn't terminated mid-request.
    const { collectChatGPT = true, collectGemini = true } = await chrome.storage.sync.get({ collectChatGPT: true, collectGemini: true });
    if (collectChatGPT && await hasProviderPermission('chatgpt')) await mergeChatGPTOrgs().catch(() => {});
    if (collectGemini && await hasProviderPermission('gemini')) await mergeGeminiOrgs().catch(() => {});
    throw e;
  } finally {
    _collecting = false;
  }
}

// Domain migration: auto-migrate existing users' serverUrl
chrome.storage.sync.get({ serverUrl: '' }, ({ serverUrl }) => {
  if (serverUrl === 'https://api.claudetuner.letrun.ai') {
    chrome.storage.sync.set({ serverUrl: DEFAULT_SERVER_URL });
  }
});

// Restore correct icon + badge on every service worker wake
// (Chrome persists stale icon state across SW restarts)
getLastStatus().then(s => {
  if (s?.snapshot) {
    updateBadgeForSelectedOrg(s.snapshot);
  } else {
    resetIcon();
  }
});

// Restore side panel preference (falls back to popup mode if sidePanel API unavailable)
async function restoreSidePanelPreference() {
  try {
    const hasSidePanel = !!(chrome.sidePanel && chrome.sidePanel.setPanelBehavior);
    if (!hasSidePanel) {
      await chrome.storage.local.set({ preferSidePanel: false });
    } else {
      const { preferSidePanel } = await chrome.storage.local.get({ preferSidePanel: true });
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: !!preferSidePanel });
    }
  } catch (e) {}
}

// === Dev only: auto-reload on version change (unpacked extension only) ===
if (chrome.runtime.getManifest().update_url === undefined) {
  setInterval(async () => {
    try {
      const resp = await fetch(chrome.runtime.getURL('manifest.json'));
      const disk = await resp.json();
      if (disk.version !== chrome.runtime.getManifest().version) {
        console.log('[Claude Tuner] Version changed, reloading...');
        chrome.runtime.reload();
      }
    } catch (_) { /* ignore */ }
  }, 2000);
}

// === Install / Startup ===
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Claude Tuner] Extension installed');
  // v1.9.x → v1.10+ migration (skip if already completed)
  if (details.reason === 'update') {
    const { intervalExplicitlySet } = await chrome.storage.sync.get({ intervalExplicitlySet: undefined });
    if (intervalExplicitlySet === undefined) {
      await chrome.storage.sync.set({ intervalExplicitlySet: false });
      console.log('[Claude Tuner] Migration: intervalExplicitlySet initialized to false');
    }
  }
  // Open welcome page on fresh install (captures ref_source)
  if (details.reason === 'install') {
    chrome.tabs.create({ url: `${SITE_URL}/welcome/` });
    // Allow auto-open side panel on first Claude.ai visit (fresh install only)
    await chrome.storage.local.set({ sidePanelAutoOpened: false });
  } else if (details.reason === 'update') {
    // Existing users: skip auto-open (they already know the extension)
    const { sidePanelAutoOpened } = await chrome.storage.local.get({ sidePanelAutoOpened: undefined });
    if (sidePanelAutoOpened === undefined) {
      await chrome.storage.local.set({ sidePanelAutoOpened: true });
    }
    // v1.24→1.25 migration: re-request previously-required host permissions
    // that moved to optional_host_permissions (Chrome may not auto-retain them)
    const { collectChatGPT = true, collectGemini = true } = await chrome.storage.sync.get({ collectChatGPT: true, collectGemini: true });
    const optionalOrigins = [];
    if (collectChatGPT) optionalOrigins.push('https://chatgpt.com/*');
    if (collectGemini) optionalOrigins.push('https://gemini.google.com/*');
    if (optionalOrigins.length > 0) {
      const already = await chrome.permissions.contains({ origins: optionalOrigins });
      if (!already) {
        console.log('[Claude Tuner] Migration: optional provider permissions not retained, popup will prompt');
      }
    }
  }
  await setupAlarm();
  sendGAEvent('extension_installed', { reason: details.reason });
  await restoreSidePanelPreference();

  // Re-inject content scripts into existing Claude.ai tabs (dev reload / extension update)
  try {
    const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    for (const tab of tabs) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['sidebar-usage.js', 'input-usage.js'],
      }).catch(() => {});
      chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['sidebar-usage.css', 'input-usage.css'],
      }).catch(() => {});
    }
  } catch { /* tabs API may fail in some contexts */ }
});

// External connect listener (used to wake up the service worker)
chrome.runtime.onConnectExternal.addListener((port) => {
  // Used to wake up the service worker via connect → disconnect, no further handling needed
});

// Handle messages from welcome page + dashboard login
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'set_ref_source' && message.ref_source) {
    chrome.storage.local.set({ ref_source: message.ref_source });
    console.log('[Claude Tuner] ref_source set:', message.ref_source);
    sendResponse({ ok: true });
    return;
  }

  // Get extension info
  if (message && message.type === 'GET_INFO') {
    sendResponse({ version: chrome.runtime.getManifest().version });
    return;
  }

  // Get collection status (for welcome page onboarding checklist).
  // Returns per-provider collection state so the welcome page can drive a
  // multi-provider checklist (Claude / ChatGPT / Gemini). `success` and
  // `lastStatus` are kept for backward compatibility with older welcome pages.
  if (message && message.type === 'get_status') {
    (async () => {
      const status = await getLastStatus();
      const { collectedOrgs = [] } = await chrome.storage.local.get({ collectedOrgs: [] });
      const collectedBy = (provider) =>
        collectedOrgs.some(o => (o.provider || 'claude') === provider);
      const [chatgptPerm, geminiPerm] = await Promise.all([
        hasProviderPermission('chatgpt'),
        hasProviderPermission('gemini'),
      ]);
      const providers = {
        claude: { collected: collectedBy('claude') || !!status?.success, hasPermission: true },
        chatgpt: { collected: collectedBy('chatgpt'), hasPermission: chatgptPerm },
        gemini: { collected: collectedBy('gemini'), hasPermission: geminiPerm },
      };
      const anyCollected = Object.values(providers).some(p => p.collected);
      sendResponse({
        success: status?.success || false,
        lastStatus: status,
        providers,
        anyCollected,
      });
    })();
    return true; // async sendResponse
  }

  // Trigger immediate collection (for welcome page onboarding)
  if (message && message.type === 'force_collect') {
    (async () => {
      try {
        const result = await collectAndSend({ force: true });
        sendResponse({ ok: true, success: result?.success || false });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // Open side panel request from welcome page
  if (message && message.type === 'OPEN_SIDE_PANEL') {
    (async () => {
      try {
        if (chrome.sidePanel && chrome.sidePanel.open) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab) await chrome.sidePanel.open({ tabId: tab.id });
          await chrome.storage.local.set({ sidePanelAutoOpened: true });
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'sidePanel not supported' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async sendResponse
  }

  // Dashboard login via Claude account
  if (message && message.type === 'GET_CLAUDE_LOGIN') {
    (async () => {
      try {
        // 1. Get email: use cache first, fall back to Claude.ai API
        let email = null;
        let userName = '';
        const cached = await chrome.storage.local.get(['accountCache']);
        const cache = cached.accountCache;
        if (cache && cache.email) {
          email = cache.email;
          userName = cache.name || '';
        } else {
          try {
            const acct = await fetchClaudeApi('/api/account', { quiet: true });
            email = acct?.email || acct?.email_address || null;
            userName = acct?.full_name || acct?.display_name || '';
          } catch (e) {
            console.warn('[Claude Tuner] Login: account API failed:', e.message);
          }
        }

        // Fall back to independent account if no Claude session
        if (!email) {
          const { independentAccount } = await chrome.storage.local.get({ independentAccount: null });
          if (independentAccount?.email) {
            email = independentAccount.email;
            userName = independentAccount.name || '';
          }
        }

        if (!email) {
          sendResponse({ success: false, error: 'not_logged_in' });
          return;
        }

        // 2. Request login token from server
        const config = await getConfig();
        const resp = await authedFetch(config, `${config.serverUrl}/api/auth/ext-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });

        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          sendResponse({ success: false, error: data.error || 'server_error' });
          return;
        }

        const data = await resp.json();
        sendResponse({ success: true, login_token: data.login_token, email, name: userName });
      } catch (e) {
        console.error('[Claude Tuner] Login error:', e);
        sendResponse({ success: false, error: 'extension_error' });
      }
    })();
    return true; // async response
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await setupAlarm();
  sendGAEvent('extension_loaded');
  await restoreSidePanelPreference();
});

// Wake from sleep/lock: collect immediately when the system becomes active.
// chrome.idle fires "active" after sleep, lock screen, or prolonged idle.
// On failure (network not ready after wake), retry at 10s/30s/60s intervals.
let _lastIdleCollect = 0;
const IDLE_COLLECT_THROTTLE_MS = 30 * 1000; // 30s throttle to avoid duplicate triggers
const WAKE_RETRY_ALARM = 'wake-retry';
const WAKE_RETRY_DELAYS_MS = [10_000, 30_000, 60_000]; // 10s, 30s, 60s

function clearWakeRetries() {
  WAKE_RETRY_DELAYS_MS.forEach((_, i) => chrome.alarms.clear(`${WAKE_RETRY_ALARM}-${i}`));
}

chrome.idle.onStateChanged.addListener(async (newState) => {
  if (newState !== 'active') return;
  const now = Date.now();
  if (now - _lastIdleCollect < IDLE_COLLECT_THROTTLE_MS) return;
  _lastIdleCollect = now;
  console.log('[Claude Tuner] System became active (wake/unlock), collecting now');
  const result = await collectAndSend().catch(() => null);
  if (result?.success) return;
  // First collect failed (likely network not ready after wake) — schedule retries
  console.log('[Claude Tuner] Wake collect failed, scheduling retries (10s/30s/60s)');
  // 10s: setTimeout (safe — service worker just activated by idle event)
  setTimeout(() => {
    collectAndSend().then(r => { if (r?.success) clearWakeRetries(); }).catch(() => {});
  }, WAKE_RETRY_DELAYS_MS[0]);
  // 30s & 60s: chrome.alarms (survives potential worker termination)
  chrome.alarms.create(`${WAKE_RETRY_ALARM}-1`, { delayInMinutes: WAKE_RETRY_DELAYS_MS[1] / 60_000 });
  chrome.alarms.create(`${WAKE_RETRY_ALARM}-2`, { delayInMinutes: WAKE_RETRY_DELAYS_MS[2] / 60_000 });
});

async function setupAlarm() {
  await updatePollAlarm();
  await scheduleWeeklyReport();
}

// Adaptive poll alarm: adjusts interval based on activity state.
// Server POST is gated separately inside the alarm handler.
async function updatePollAlarm() {
  const config = await getConfig();
  const baseInterval = config.intervalMinutes || DEFAULT_INTERVAL_MINUTES;

  // Free plan: fixed 60min, ignore activity
  if (baseInterval === FREE_PLAN_INTERVAL_MINUTES) {
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: FREE_PLAN_INTERVAL_MINUTES, periodInMinutes: FREE_PLAN_INTERVAL_MINUTES });
    return;
  }

  const state = getActivityState();
  let interval;
  switch (state) {
    case ACTIVITY_STATES.ACTIVE:     interval = LOCAL_ACTIVE_INTERVAL_MINUTES; break;     // 2min
    case ACTIVITY_STATES.BACKGROUND: interval = LOCAL_BACKGROUND_INTERVAL_MINUTES; break; // 5min
    default:                         interval = baseInterval; break;                       // 10min (server default)
  }

  const existing = await chrome.alarms.get(ALARM_NAME);
  if (existing && Math.abs(existing.periodInMinutes - interval) < 0.5) return; // no change needed

  chrome.alarms.create(ALARM_NAME, { delayInMinutes: interval, periodInMinutes: interval });
  console.log(`[Claude Tuner] Poll alarm: ${interval}m (activity=${state})`);
}

// === Auto-open side panel on first Claude.ai visit after fresh install ===
// Only attempts once (marks as done even on failure to prevent repeated errors)
async function tryAutoOpenSidePanel(tabId) {
  try {
    const { sidePanelAutoOpened } = await chrome.storage.local.get({ sidePanelAutoOpened: true });
    if (sidePanelAutoOpened) return;
    // Mark as done first to prevent retries on failure
    await chrome.storage.local.set({ sidePanelAutoOpened: true });
    if (chrome.sidePanel && chrome.sidePanel.open) {
      await chrome.sidePanel.open({ tabId });
      console.log('[Claude Tuner] Side panel auto-opened on first Claude.ai visit');
    }
  } catch (e) {
    console.log('[Claude Tuner] Side panel auto-open skipped:', e.message);
  }
}

// === Tab events: auto-collect on claude.ai visit/return ===
let _lastTabCollect = 0;
let _collecting = false; // suppress cookie-change events during collection
const TAB_COLLECT_THROTTLE_MS = 60 * 1000; // 1-minute throttle

// Restore from storage on SW restart (in-memory variables are reset)
chrome.storage.local.get({ _lastTabCollect: 0 }, (r) => { _lastTabCollect = r._lastTabCollect; });

async function tryTabCollect(reason) {
  const now = Date.now();
  // Skip throttle if previous collection was an error (retry immediately on login/tab return)
  const prevStatus = await getLastStatus();
  const wasError = prevStatus && !prevStatus.success && prevStatus.error;
  // cookie-org-changed is an org switch, exempt from throttle
  if (reason !== 'cookie-org-changed' && !wasError && now - _lastTabCollect < TAB_COLLECT_THROTTLE_MS) return;
  _lastTabCollect = now;
  chrome.storage.local.set({ _lastTabCollect: now });

  // Adaptive polling: reset all secondary orgs to ACTIVE on tab switch
  // (user may have switched orgs, so collect all immediately)
  try {
    const { orgPollState } = await chrome.storage.local.get({ orgPollState: {} });
    if (orgPollState && Object.keys(orgPollState).length > 0) {
      let resetCount = 0;
      for (const uuid of Object.keys(orgPollState)) {
        if (orgPollState[uuid].tier !== 'active') {
          orgPollState[uuid].tier = 'active';
          orgPollState[uuid].unchangedCount = 0;
          resetCount++;
        }
      }
      if (resetCount > 0) {
        await chrome.storage.local.set({ orgPollState });
        console.log(`[Claude Tuner] Adaptive poll: ${resetCount} org(s) reset to active (${reason})`);
      }
    }
  } catch (_) { /* ignore poll state reset failure */ }

  console.log(`[Claude Tuner] Tab collect triggered: ${reason}${wasError ? ' (retry after error)' : ''}`);

  // Apply server POST gate (same logic as alarm handler)
  const config = await getConfig();
  const serverInterval = (await chrome.storage.local.get('serverPollInterval')).serverPollInterval
    || config.intervalMinutes || DEFAULT_INTERVAL_MINUTES;
  const { _lastServerPost = 0 } = await chrome.storage.local.get('_lastServerPost');
  const shouldPost = (Date.now() - _lastServerPost) >= (serverInterval * 60_000 - 30_000);

  const result = await collectAndSend({ skipServer: !shouldPost });
  if (result.success) {
    if (!result.localOnly) await chrome.storage.local.set({ _lastServerPost: Date.now() });
    await scheduleExpireAlarms(result.snapshot);
  }
}

// Detect URL changes (login complete, page navigation, etc.)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.startsWith('https://claude.ai')) {
    // At least background state when a claude.ai tab is ready
    const prev = getActivityState();
    if (prev === ACTIVITY_STATES.IDLE) {
      await setActivityState(ACTIVITY_STATES.BACKGROUND);
      await updatePollAlarm();
    }
    tryTabCollect('tab-updated');
    tryAutoOpenSidePanel(tabId);
  }
});

// Detect tab activation (when returning to a claude.ai tab)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url?.startsWith('https://claude.ai')) {
      if (await setActivityState(ACTIVITY_STATES.ACTIVE)) await updatePollAlarm();
      tryTabCollect('tab-activated');
    } else {
      // Switched away from claude.ai — check if any claude.ai tabs remain
      const claudeTabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
      const newState = claudeTabs.length > 0 ? ACTIVITY_STATES.BACKGROUND : ACTIVITY_STATES.IDLE;
      if (await setActivityState(newState)) await updatePollAlarm();
    }
  } catch (_) { /* ignore tab query failure */ }
});

// Detect tab close — transition to idle if no claude.ai tabs remain
chrome.tabs.onRemoved.addListener(async () => {
  try {
    const claudeTabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    if (claudeTabs.length === 0) {
      if (await setActivityState(ACTIVITY_STATES.IDLE)) await updatePollAlarm();
    }
  } catch (_) { /* ignore */ }
});

// Detect lastActiveOrg cookie change → collect immediately on org switch + reset adaptive poll
// Suppress during collection: fetchViaTab for extra orgs may trigger spurious cookie changes
chrome.cookies.onChanged.addListener((info) => {
  if (info.cookie.name === 'lastActiveOrg' && info.cookie.domain?.includes('claude.ai') && !info.removed) {
    if (_collecting) {
      console.log(`[Claude Tuner] lastActiveOrg cookie changed → ${info.cookie.value} (suppressed: collecting)`);
      return;
    }
    console.log(`[Claude Tuner] lastActiveOrg cookie changed → ${info.cookie.value}`);
    // Notify popup/side panel immediately (for chip switch before collection completes)
    chrome.runtime.sendMessage({ type: 'ORG_COOKIE_CHANGED', orgId: info.cookie.value }).catch(() => {});
    tryTabCollect('cookie-org-changed');
  }
});

// === webRequest: detect Claude.ai completion 429 → collect immediately ===
// Refresh usage data immediately when a rate limit (429) occurs on message send/retry
let _last429Collect = 0;
const RATELIMIT_COLLECT_THROTTLE_MS = 30 * 1000; // 30-second throttle (prevent consecutive 429s)

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.statusCode === 429) {
      const now = Date.now();
      if (now - _last429Collect < RATELIMIT_COLLECT_THROTTLE_MS) return;
      _last429Collect = now;
      console.log(`[Claude Tuner] 429 detected: ${details.url.split('?')[0]}`);
      collectAndSend().then((result) => {
        if (result.success) scheduleExpireAlarms(result.snapshot);
      });
    }
  },
  {
    urls: [
      'https://claude.ai/api/organizations/*/completion',
      'https://claude.ai/api/organizations/*/retry_completion',
    ],
  }
);

// === Adaptive Boost: double local collection frequency on usage surge ===
async function evaluateBoost(snapshot) {
  if (snapshot?.five_hour?.utilization == null) return;
  const util5h = snapshot.five_hour.utilization;
  const { usageHistory = [] } = await chrome.storage.local.get({ usageHistory: [] });

  // Determine if usage is rising based on the last 2 data points
  const recent = usageHistory.filter(p => p.h5 != null).slice(-2);
  const isRising = recent.length >= 2 && recent[1].h5 > recent[0].h5;

  const shouldBoost = util5h >= 50 && isRising;
  const existing = await chrome.alarms.get(ALARM_BOOST);

  if (shouldBoost && !existing) {
    const { intervalMinutes = DEFAULT_INTERVAL_MINUTES } = await chrome.storage.sync.get({ intervalMinutes: DEFAULT_INTERVAL_MINUTES });
    const boostInterval = Math.max(intervalMinutes / 2, 1);
    chrome.alarms.create(ALARM_BOOST, { delayInMinutes: boostInterval, periodInMinutes: boostInterval });
    await chrome.storage.local.set({ boostActive: true });
    console.log(`[Claude Tuner] Boost ON: 5h=${util5h}%, interval=${boostInterval}m`);
  } else if (!shouldBoost && existing) {
    chrome.alarms.clear(ALARM_BOOST);
    await chrome.storage.local.set({ boostActive: false });
    console.log(`[Claude Tuner] Boost OFF: 5h=${util5h}%, rising=${isRising}`);
  }
}

// === Alarm Handler ===
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Wake-from-sleep retries (30s / 60s alarms)
  if (alarm.name.startsWith(WAKE_RETRY_ALARM)) {
    console.log(`[Claude Tuner] Wake retry alarm: ${alarm.name}`);
    const result = await collectAndSend().catch(() => null);
    if (result?.success) clearWakeRetries();
    return;
  }
  if (alarm.name === ALARM_BOOST) {
    // Boost collection: local save only, no server upload
    const result = await collectAndSend({ skipServer: true });
    if (result.success) await evaluateBoost(result.snapshot);
    return;
  }
  if (alarm.name === ALARM_NAME) {
    // Server POST gate: only send to server if enough time has passed
    const config = await getConfig();
    const serverInterval = (await chrome.storage.local.get('serverPollInterval')).serverPollInterval
      || config.intervalMinutes || DEFAULT_INTERVAL_MINUTES;
    const { _lastServerPost = 0 } = await chrome.storage.local.get('_lastServerPost');
    const shouldPost = (Date.now() - _lastServerPost) >= (serverInterval * 60_000 - 30_000); // 30s tolerance

    const result = await collectAndSend({ skipServer: !shouldPost });
    if (result.success) {
      if (!result.localOnly) await chrome.storage.local.set({ _lastServerPost: Date.now() });
      await scheduleExpireAlarms(result.snapshot);
      await evaluateBoost(result.snapshot);
    }
  }
  // Weekly report
  if (alarm.name === ALARM_WEEKLY_REPORT) {
    await sendWeeklyReport();
    return;
  }
  // Handle expire alarms (5min-before notification, 2min/1min/at-reset collection, post-reset notification)
  if (alarm.name.startsWith(ALARM_EXPIRE_PREFIX)) {
    console.log(`[Claude Tuner] Expire alarm fired: ${alarm.name}`);

    // Notification 5 minutes before reset
    if (alarm.name.includes('-notify5')) {
      const { notifyResetSoon = true } = await chrome.storage.sync.get({ notifyResetSoon: true });
      if (notifyResetSoon) {
        const is5h = alarm.name.includes('-5h-');
        const win = await bt(is5h ? 'win_5h' : 'win_7d');
        const ctxLabel = await getResetNotifContext();
        const usage = await getCurrentUsageForWindow(is5h ? '5h' : '7d');
        const prefix = usage != null ? await bt('reset_soon_usage_prefix', usage) : '';
        const opts = {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: await bt('reset_soon_title', win),
          message: prefix + await bt('reset_soon_msg', win) + '\n' + await bt('notif_settings_hint'),
          buttons: [{ title: await bt('notif_settings_btn') }],
          priority: 1,
        };
        if (ctxLabel) opts.contextMessage = ctxLabel;
        chrome.notifications.create(`reset-soon-${Date.now()}`, opts);
        logNotification('reset-soon');
      }
      return;
    }

    // Notification right after reset
    if (alarm.name.includes('-after')) {
      const { notifyResetDone = true } = await chrome.storage.sync.get({ notifyResetDone: true });
      if (notifyResetDone) {
        const win = await bt(alarm.name.includes('-5h-') ? 'win_5h' : 'win_7d');
        const ctxLabel = await getResetNotifContext();
        const opts = {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: await bt('reset_done_title', win),
          message: await bt('reset_done_msg', win) + '\n' + await bt('notif_settings_hint'),
          buttons: [{ title: await bt('notif_settings_btn') }],
          priority: 1,
        };
        if (ctxLabel) opts.contextMessage = ctxLabel;
        chrome.notifications.create(`reset-done-${Date.now()}`, opts);
        logNotification('reset-done');
      }
    }

    await collectAndSend();
  }
});

// Build a short label like "Claude" or "Claude · Dable Labs" for reset notifications.
// Single-Claude-org users see just the provider name; multi-org / non-Claude users
// get the org name appended so they can tell which account the alarm is for.
const PROVIDER_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
async function buildResetContextLabel() {
  const { collectedOrgs = [] } = await chrome.storage.local.get({ collectedOrgs: [] });
  if (!collectedOrgs.length) return null;
  const primary = collectedOrgs.find(o => o.isPrimary) || collectedOrgs[0];
  const provider = primary.provider || 'claude';
  const providerName = PROVIDER_LABELS[provider] || provider;
  if (collectedOrgs.length === 1 && provider === 'claude') return providerName;
  const orgName = (primary.name || '').trim();
  return orgName ? `${providerName} · ${orgName}` : providerName;
}

async function getResetNotifContext() {
  const { _resetNotifContext = null } = await chrome.storage.local.get('_resetNotifContext');
  return _resetNotifContext;
}

// Read current utilization (%) for the primary org and given window ('5h' | '7d').
// Returns null if no primary org or value isn't a number.
async function getCurrentUsageForWindow(windowKey) {
  const { collectedOrgs = [] } = await chrome.storage.local.get({ collectedOrgs: [] });
  if (!collectedOrgs.length) return null;
  const primary = collectedOrgs.find(o => o.isPrimary) || collectedOrgs[0];
  const val = windowKey === '5h' ? primary.h5 : primary.d7;
  return (typeof val === 'number' && isFinite(val)) ? Math.round(val) : null;
}

// Schedule additional collection alarms based on expire times
// Collect at 2min before, 1min before, and at resets_at
async function scheduleExpireAlarms(snapshot) {
  if (!snapshot) return;

  // Clear all existing expire alarms
  const allAlarms = await chrome.alarms.getAll();
  for (const a of allAlarms) {
    if (a.name.startsWith(ALARM_EXPIRE_PREFIX)) {
      await chrome.alarms.clear(a.name);
    }
  }

  let resetTimes = [];
  if (snapshot.five_hour?.resets_at) resetTimes.push({ key: '5h', time: snapshot.five_hour.resets_at });
  if (snapshot.seven_day?.resets_at) resetTimes.push({ key: '7d', time: snapshot.seven_day.resets_at });
  if (snapshot.seven_day_omelette?.resets_at) resetTimes.push({ key: 'design', time: snapshot.seven_day_omelette.resets_at });
  if (snapshot.seven_day_sonnet?.resets_at) resetTimes.push({ key: 'sonnet', time: snapshot.seven_day_sonnet.resets_at });

  // If a non-Claude org is selected, use its reset times for notifications
  const selectedUsage = await getSelectedOrgUsage();
  if (selectedUsage && selectedUsage.provider !== 'claude') {
    if (selectedUsage.resetsAt5h) {
      resetTimes = resetTimes.filter(r => r.key !== '5h');
      resetTimes.push({ key: '5h', time: selectedUsage.resetsAt5h });
    }
    if (selectedUsage.resetsAt7d) {
      resetTimes = resetTimes.filter(r => r.key !== '7d');
      resetTimes.push({ key: '7d', time: selectedUsage.resetsAt7d });
    }
  }

  const now = Date.now();
  const offsets = [
    { suffix: 'notify5', minutes: -5 }, // Notification 5min before
    { suffix: 'pre2', minutes: -2 },    // Collect 2min before
    { suffix: 'pre1', minutes: -1 },    // Collect 1min before
    { suffix: 'at', minutes: 0 },       // Collect at reset
    { suffix: 'after', minutes: 2 },    // Collect + notify 2min after reset
  ];

  let scheduled = 0;
  for (const { key, time } of resetTimes) {
    const expireMs = new Date(time).getTime();
    if (isNaN(expireMs)) continue;

    for (const { suffix, minutes } of offsets) {
      const triggerMs = expireMs + minutes * 60 * 1000;
      const delayMs = triggerMs - now;

      // Only schedule if in the future and more than 30 seconds away
      if (delayMs > 30000) {
        const delayMinutes = delayMs / 60000;
        const alarmName = `${ALARM_EXPIRE_PREFIX}${key}-${suffix}`;
        chrome.alarms.create(alarmName, { delayInMinutes: delayMinutes });
        scheduled++;
      }
    }
  }

  if (scheduled > 0) {
    console.log(`[Claude Tuner] ${scheduled} expire alarms scheduled`);
  }

  // Stash provider/org context so the alarm-fire notification can show it.
  const ctxLabel = await buildResetContextLabel();
  await chrome.storage.local.set({ _resetNotifContext: ctxLabel || null });
}

// === Visibility + Popup/Panel open handlers ===
let _lastVisibilityChange = 0;
let _lastPopupCollect = 0;

// Restore from storage on SW restart
chrome.storage.local.get({ _lastPopupCollect: 0 }, (r) => { _lastPopupCollect = r._lastPopupCollect; });

// === Message Handler (manual collection request from popup) ===
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Tab visibility change from content script (sidebar-usage.js)
  if (message.type === 'TAB_VISIBLE' || message.type === 'TAB_HIDDEN') {
    const now = Date.now();
    if (now - _lastVisibilityChange < VISIBILITY_THROTTLE_MS) return false;
    _lastVisibilityChange = now;
    (async () => {
      const newState = message.type === 'TAB_VISIBLE' ? ACTIVITY_STATES.ACTIVE : ACTIVITY_STATES.BACKGROUND;
      if (await setActivityState(newState)) await updatePollAlarm();
    })();
    return false;
  }
  // Popup or side panel opened — quick local-only refresh if data is stale
  if (message.type === 'POPUP_OPENED') {
    const now = Date.now();
    if (now - _lastPopupCollect < POPUP_COLLECT_THROTTLE_MS) {
      sendResponse({ skipped: true });
      return false;
    }
    _lastPopupCollect = now;
    chrome.storage.local.set({ _lastPopupCollect: now });
    collectAndSend({ skipServer: true }).then((result) => sendResponse(result));
    return true;
  }
  if (message.type === 'MANUAL_COLLECT') {
    collectAndSend({ force: true }).then((result) => sendResponse(result));
    return true;
  }
  if (message.type === 'SET_SIDE_PANEL_MODE') {
    (async () => {
      try {
        if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
          await chrome.sidePanel.setPanelBehavior({
            openPanelOnActionClick: !!message.enabled
          });
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.type === 'GET_STATUS') {
    getLastStatus().then((status) => sendResponse(status));
    return true;
  }
  if (message.type === 'REFRESH_BADGE') {
    getLastStatus().then((status) => {
      if (status?.snapshot) {
        updateBadgeForSelectedOrg(status.snapshot);
      }
      sendResponse({ success: true });
    });
    return true;
  }
  if (message.type === 'GET_USAGE_HISTORY') {
    getUsageHistory().then((history) => sendResponse(history));
    return true;
  }
  if (message.type === 'EXECUTE_PLAN_CHANGE') {
    executePlanChange(message.recommendation).then((result) => sendResponse(result));
    return true;
  }
  if (message.type === 'DISMISS_RECOMMENDATION') {
    dismissRecommendationServer().then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.type === 'MUTE_RECOMMENDATION') {
    muteRecommendationServer().then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.type === 'RESPOND_PLAN_ORDER') {
    (async () => {
      const { pendingPlanOrder: po } = await chrome.storage.local.get('pendingPlanOrder');
      if (!po) { sendResponse({ success: false, error: 'No pending order' }); return; }
      const config = await getConfig();
      const status = await getLastStatus();
      const userEmail = status?.snapshot?.user_email;
      if (message.action === 'accept') {
        try {
          const changeResult = await acceptPlanOrder(config, po, userEmail);
          sendResponse({ success: changeResult?.success, error: changeResult?.error });
          if (changeResult?.success) {
            setTimeout(() => collectAndSend(), 3000);
          }
        } catch (e) {
          await reportPlanOrderResult(config, po.order_id, userEmail, 'accepted', 'failed', e.message);
          sendResponse({ success: false, error: e.message });
        }
      } else {
        await reportPlanOrderResult(config, po.order_id, userEmail, 'rejected');
        await chrome.storage.local.set({ pendingPlanOrder: null });
        // Restore badge to show utilization
        const lastStatus = await getLastStatus();
        if (lastStatus?.snapshot) {
          await updateBadgeForSelectedOrg(lastStatus.snapshot);
        }
        sendResponse({ success: true });
      }
    })();
    return true;
  }
  if (message.type === 'CANCEL_DOWNGRADE') {
    cancelDowngrade().then(async (result) => {
      if (result?.success) {
        // Report revert if completedPlanOrder exists
        const { completedPlanOrder: cpo } = await chrome.storage.local.get('completedPlanOrder');
        if (cpo?.order_id) {
          const config = await getConfig();
          const status = await getLastStatus();
          const email = status?.snapshot?.user_email;
          if (email) {
            try {
              await authedFetch(config, `${config.serverUrl}/api/snapshots/plan-order-revert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order_id: cpo.order_id, user_email: email }),
              });
            } catch (e) { console.error('[Claude Tuner] Failed to report revert:', e.message); }
          }
        }
        await chrome.storage.local.set({ completedPlanOrder: null });
      }
      sendResponse(result);
      if (result?.success) setTimeout(() => collectAndSend(), 3000);
    });
    return true;
  }
  if (message.type === 'DOWNGRADE_TO') {
    downgradeTo(message.targetPlan).then((result) => sendResponse(result));
    return true;
  }
  if (message.type === 'GET_COOKIE_ORG') {
    getLastActiveOrgId().then(orgId => sendResponse({ orgId })).catch(() => sendResponse({ orgId: null }));
    return true;
  }
  if (message.type === 'OPEN_OPTIONS') {
    if (message.hash) {
      chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${message.hash}`) });
    } else {
      chrome.runtime.openOptionsPage();
    }
    return false;
  }
  if (message.type === 'GET_SIDEBAR_USAGE') {
    buildSidebarUsageData(message.orgId).then(data => sendResponse(data));
    return true;
  }
  if (message.type === 'GET_ORGANIZATIONS') {
    fetchClaudeApi('/api/organizations').then(orgList => {
      if (!Array.isArray(orgList)) { sendResponse({ success: false, error: 'Invalid response' }); return; }
      // Exclude API only (Enterprise included)
      const orgs = orgList
        .map(o => ({ uuid: o.uuid, name: o.name || o.display_name || 'Unknown', plan: detectPlan(o) }))
        .filter(o => o.plan !== 'API');
      sendResponse({ success: true, orgs });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // === Independent Account: email signup/login ===
  if (message.type === 'REQUEST_MAGIC_LINK') {
    (async () => {
      try {
        const config = await getConfig();
        const resp = await fetch(`${config.serverUrl}/api/auth/magic-link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: message.email,
            purpose: message.purpose || 'login',
            lang: message.lang || 'en',
          }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          sendResponse({ success: false, error: data.error || 'server_error' });
          return;
        }
        sendResponse({ success: true, purpose: data.purpose });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.type === 'VERIFY_MAGIC_CODE') {
    (async () => {
      try {
        const config = await getConfig();
        const resp = await fetch(`${config.serverUrl}/api/auth/verify-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: message.email,
            code: message.code,
            client: 'extension',
          }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          sendResponse({ success: false, error: data.error || 'invalid_code' });
          return;
        }
        // Store independent account + ext_token
        await chrome.storage.local.set({
          independentAccount: { email: data.email, name: data.name || '' },
          extToken: data.ext_token,
        });
        sendResponse({ success: true, email: data.email, name: data.name });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }
});

// === Notification click handler ===
chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  // Collection failure notification → open Claude.ai
  if (notifId.startsWith('collect-fail-') && btnIdx === 0) {
    chrome.tabs.create({ url: 'https://claude.ai' });
    chrome.notifications.clear(notifId);
    return;
  }
  // Plan change order notification
  if (notifId.startsWith('plan-order-')) {
    const orderId = parseInt(notifId.replace('plan-order-', ''));
    const { pendingPlanOrder: po } = await chrome.storage.local.get('pendingPlanOrder');
    if (!po || po.order_id !== orderId) return;
    const config = await getConfig();
    const status = await getLastStatus();
    const userEmail = status?.snapshot?.user_email;
    if (btnIdx === 0) {
      // Accept → execute plan change
      try {
        await acceptPlanOrder(config, po, userEmail);
      } catch (e) {
        await reportPlanOrderResult(config, po.order_id, userEmail, 'accepted', 'failed', e.message);
      }
    } else {
      // Reject
      await reportPlanOrderResult(config, po.order_id, userEmail, 'rejected');
      await chrome.storage.local.set({ pendingPlanOrder: null });
    }
    chrome.notifications.clear(notifId);
    return;
  }
  // Existing recommendation notification
  if (notifId === NOTIF_ID_OPTIMIZE && btnIdx === 0) {
    const status = await getLastStatus();
    const rec = status?.recommendation;
    if (rec?.type) {
      await executePlanChange(rec);
    }
  } else if (notifId === NOTIF_ID_OPTIMIZE && btnIdx === 1) {
    await dismissRecommendationServer();
  }
  // Settings button on recurring notifications (usage alert, reset, weekly report)
  if (btnIdx === 0 && (notifId.startsWith(NOTIF_ID_ALERT) || notifId.startsWith('reset-soon-') || notifId.startsWith('reset-done-') || notifId.startsWith('weekly-report-'))) {
    let hash = 'notifications';
    if (notifId.startsWith(NOTIF_ID_ALERT)) hash = 'notify-usage-warn';
    else if (notifId.startsWith('reset-soon-')) hash = 'notify-reset-soon';
    else if (notifId.startsWith('reset-done-')) hash = 'notify-reset-done';
    else if (notifId.startsWith('weekly-report-')) hash = 'notify-weekly-report';
    chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${hash}`) });
    chrome.notifications.clear(notifId);
  }
});

// === Sidebar Usage: build data for content script ===
async function buildSidebarUsageData(reqOrgId) {
  const [status, history, local] = await Promise.all([
    getLastStatus(),
    getUsageHistory(),
    new Promise(r => chrome.storage.local.get({ collectedOrgs: [], sidebarLang: null }, r)),
  ]);

  const allOrgs = local.collectedOrgs || [];
  const snapshot = status?.snapshot;

  // Sidebar/input on claude.ai should only display Claude data
  const collectedOrgs = allOrgs.filter(o => (o.provider || 'claude') === 'claude');
  if (!snapshot && collectedOrgs.length === 0) return null;

  // Determine which org to show — respect the requested org strictly
  let orgData = null;
  if (reqOrgId && collectedOrgs.length > 0) {
    orgData = collectedOrgs.find(o => o.uuid === reqOrgId);
    // Requested org not collected: return null (don't fall back to another org)
    if (!orgData) return null;
  }
  if (!orgData && collectedOrgs.length > 0) {
    orgData = collectedOrgs.find(o => o.isPrimary) || collectedOrgs[0];
  }

  // Prefer snapshot when it's for the same org and is newer than collectedOrgs.
  // Between setStatus (updates snapshot) and collectedOrgs write (happens after multi-org
  // polling), collectedOrgs can be stale — use timestamp comparison to pick the fresher source.
  const snapshotOrgMatch = snapshot && orgData &&
    snapshot.claude_org_uuid === orgData.uuid &&
    snapshot.five_hour?.utilization != null;
  const useSnapshot = snapshotOrgMatch && status?.timestamp &&
    (!orgData.updatedAt || status.timestamp >= orgData.updatedAt);

  const h5 = useSnapshot ? snapshot.five_hour.utilization : (orgData?.h5 ?? snapshot?.five_hour?.utilization ?? null);
  const d7 = useSnapshot ? (snapshot.seven_day?.utilization ?? orgData?.d7 ?? null) : (orgData?.d7 ?? snapshot?.seven_day?.utilization ?? null);
  const r5 = useSnapshot ? (snapshot.five_hour?.resets_at ?? orgData?.resetsAt5h ?? null) : (orgData?.resetsAt5h ?? snapshot?.five_hour?.resets_at ?? null);
  const r7 = useSnapshot ? (snapshot.seven_day?.resets_at ?? orgData?.resetsAt7d ?? null) : (orgData?.resetsAt7d ?? snapshot?.seven_day?.resets_at ?? null);
  const plan = orgData?.plan || snapshot?.plan || null;

  // Extra usage
  const eu = orgData?.extraUsage;
  const euEnabled = !!(eu && eu.is_enabled);
  const euUsed = eu?.used_credits ?? null;
  const euLimit = eu?.monthly_limit ?? null;

  // Prediction calculation (reuse popup logic)
  const pred5h = calcSidebarPrediction(history, 'h5', h5, r5, reqOrgId || orgData?.uuid);
  const pred7d = calcSidebarPrediction(history, 'd7', d7, r7, reqOrgId || orgData?.uuid);

  // Language detection
  const lang = local.sidebarLang || (snapshot?.user_lang) || 'en';

  return { plan, h5, d7, r5, r7, eu: euUsed, el: euLimit, euEnabled, pred5h, pred7d, lang };
}

// Lightweight prediction for sidebar (mirrors popup calcPredictedAtReset)
function calcSidebarPrediction(history, key, currentUtil, resetsAt, orgUuid) {
  if (!resetsAt || currentUtil == null || !history || history.length < 3) return null;

  const now = Date.now();
  const hoursToReset = (new Date(resetsAt).getTime() - now) / 3600000;
  if (hoursToReset <= 0) return null;

  // Filter history for matching org
  const orgHistory = orgUuid
    ? history.filter(p => p.org === orgUuid || !p.org)
    : history;

  let rate = null;
  let hoursDiff = 0;

  if (key === 'd7') {
    const sixHoursAgo = now - 6 * 3600000;
    const recent = orgHistory.filter(p => p.d7 != null && p.r7 && p.t > sixHoursAgo);
    if (recent.length >= 2) {
      let totalDelta = 0;
      for (let i = 1; i < recent.length; i++) {
        if (recent[i - 1].r7 === recent[i].r7) {
          totalDelta += Math.max(0, recent[i].d7 - recent[i - 1].d7);
        }
      }
      const timeDiffH = (recent[recent.length - 1].t - recent[0].t) / 3600000;
      if (timeDiffH > 0) { rate = totalDelta / timeDiffH; hoursDiff = timeDiffH; }
    }
    if (rate == null) {
      const elapsed = 7 * 24 - hoursToReset;
      if (elapsed < 1) return null;
      rate = currentUtil / elapsed;
      hoursDiff = elapsed;
    }
  } else {
    const lookbacks = [2 * 3600000, 6 * 3600000, Infinity];
    let valid = [];
    for (const lb of lookbacks) {
      valid = orgHistory.filter(p => p[key] != null && (lb === Infinity || p.t > now - lb));
      if (valid.length >= 2) break;
    }
    if (valid.length < 2) return null;
    const first = valid[0], last = valid[valid.length - 1];
    hoursDiff = (last.t - first.t) / 3600000;
    if (hoursDiff < 0.5) return null;
    rate = (last[key] - first[key]) / hoursDiff;
  }

  if (rate == null) return null;
  const predicted = currentUtil + (rate * hoursToReset);
  if (rate <= 0 || predicted - currentUtil < 3) return null;
  return Math.round(predicted);
}

// Notify sidebar content scripts to re-fetch with their own orgId
async function pushSidebarUsage() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    if (tabs.length === 0) return;
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'SIDEBAR_USAGE_REFRESH' }).catch(() => {});
    }
  } catch (e) {
    // Content script may not be ready; ignore
  }
}

// Hook into storage changes to push sidebar updates after collection.
// Only trigger when Claude orgs actually changed — ChatGPT/Gemini merges
// should not cause sidebar/input to re-render on claude.ai.
// For skipServer/boost mode (no collectedOrgs write), pushSidebarUsage()
// is called explicitly in collect.js.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.collectedOrgs) {
    const oldClaude = (changes.collectedOrgs.oldValue || []).filter(o => (o.provider || 'claude') === 'claude');
    const newClaude = (changes.collectedOrgs.newValue || []).filter(o => (o.provider || 'claude') === 'claude');
    if (JSON.stringify(oldClaude) !== JSON.stringify(newClaude)) {
      pushSidebarUsage();
    }
  }
});

// Resolve circular dependency between bg/collect.js ↔ bg/plan.js: inject via setter
setCollectAndSendRef(collectAndSend);
