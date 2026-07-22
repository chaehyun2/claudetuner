// === ES Module Imports ===
import { sendGAEvent } from './bg/analytics.js';
import {
  ALARM_NAME, ALARM_EXPIRE_PREFIX, ALARM_BOOST, ALARM_WEEKLY_REPORT, ALARM_REC,
  DEFAULT_INTERVAL_MINUTES, FREE_PLAN_INTERVAL_MINUTES,
  LOCAL_ACTIVE_INTERVAL_MINUTES, LOCAL_BACKGROUND_INTERVAL_MINUTES,
  VISIBILITY_THROTTLE_MS, POPUP_COLLECT_THROTTLE_MS,
  NOTIF_ID_OPTIMIZE, NOTIF_ID_ALERT,
  DEFAULT_SERVER_URL, SITE_URL,
  SEND_MIN_INTERVAL_MS,
} from './bg/constants.js';
import { getActivityState, setActivityState, ACTIVITY_STATES } from './bg/activity.js';
import { diurnalProject7dAdaptive } from './ui/diurnal.js';
import { bt } from './bg/i18n.js';
import { getConfig, getLastStatus, setStatus, getUsageHistory, appendUsageHistory, authedFetch, getExtToken, reconcileProviderRecs } from './bg/storage.js';
import { fetchClaudeApi } from './bg/api.js';
import { updateBadge, updateBadgeForSelectedOrg, getSelectedOrgUsage, resetIcon } from './bg/badge.js';
import { scheduleWeeklyReport, sendWeeklyReport, logNotification, checkPromoPush } from './bg/notifications.js';
import {
  detectPlan, executePlanChange, cancelDowngrade, downgradeTo,
  acceptPlanOrder, reportPlanOrderResult, dismissRecommendationServer, muteRecommendationServer,
  setCollectAndSendRef,
} from './bg/plan.js';
import { collectAndSend as _collectAndSend, getLastActiveOrgId } from './bg/collect.js';
import { getCadence, isCollectionPaused, setCadenceChangeHandler } from './bg/cadence-config.js';
import { collectChatGPT } from './bg/collect-chatgpt.js';
import { collectGemini } from './bg/collect-gemini.js';
import { fetchRecommendations } from './bg/rec-fetch.js';

// Check if optional host permission is granted for a provider
function hasProviderPermission(provider) {
  const origins = {
    chatgpt: ['https://chatgpt.com/*'],
    gemini: ['https://gemini.google.com/*'],
  };
  if (!origins[provider]) return Promise.resolve(true);
  return chrome.permissions.contains({ origins: origins[provider] });
}

// ── ChatGPT in-page usage panel (content scripts) ──
// chatgpt.com is an OPTIONAL host permission, so its content scripts can't be
// declared statically in the manifest — register them dynamically once the
// permission is granted, and unregister when revoked.
// claude-folders.js registers the single canonical folders engine
// (globalThis.__ctFoldersEngine) and self-mounts ONLY on claude.ai; here it is
// injected purely to expose that engine, then chatgpt-folders.js mounts the
// ChatGPT adapter against it — no duplicated folder logic. claude-folders.css is
// provider-agnostic (neutral grays + brand accent + color:inherit; the theme text
// tokens are swapped in JS via the adapter), so it is reused as-is — no ChatGPT CSS
// fork. Order matters: claude-folders.js MUST precede chatgpt-folders.js.
const CHATGPT_INJECT = {
  id: 'ct-chatgpt-usage',
  matches: ['https://chatgpt.com/*'],
  js: ['usage-shared.js', 'chatgpt-sidebar.js', 'chatgpt-input.js', 'claude-folders.js', 'chatgpt-folders.js'],
  css: ['chatgpt-usage.css', 'claude-folders.css'],
  runAt: 'document_idle',
};

async function registerChatGPTScripts() {
  try {
    if (!(await hasProviderPermission('chatgpt'))) return;
    const existing = await chrome.scripting
      .getRegisteredContentScripts({ ids: [CHATGPT_INJECT.id] })
      .catch(() => []);
    // Update (not skip) when already registered: a persisted registration from an
    // older build could otherwise keep injecting a stale js/css list after update.
    if (existing.length > 0) {
      await chrome.scripting.updateContentScripts([CHATGPT_INJECT]);
    } else {
      await chrome.scripting.registerContentScripts([CHATGPT_INJECT]);
    }
  } catch (e) {
    console.warn('[Claude Tuner] registerChatGPTScripts failed:', e.message);
  }
}

async function unregisterChatGPTScripts() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CHATGPT_INJECT.id] });
  } catch { /* not registered */ }
}

// Inject into already-open chatgpt.com tabs (registerContentScripts only affects
// future navigations) — covers permission-grant and extension update/reload.
async function injectChatGPTOpenTabs() {
  try {
    if (!(await hasProviderPermission('chatgpt'))) return;
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    for (const tab of tabs) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CHATGPT_INJECT.js }).catch(() => {});
      chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: CHATGPT_INJECT.css }).catch(() => {});
    }
  } catch { /* tabs API may fail in some contexts */ }
}

// ── Gemini in-page usage panel (content scripts) ──
// gemini.google.com is an OPTIONAL host permission — register/unregister its
// content scripts dynamically, mirroring the ChatGPT block above. The panel
// (gemini-sidebar.js) and input strip (gemini-input.js) share usage-shared.js.
const GEMINI_INJECT = {
  id: 'ct-gemini-usage',
  matches: ['https://gemini.google.com/*'],
  js: ['usage-shared.js', 'gemini-sidebar.js', 'gemini-input.js'],
  css: ['gemini-usage.css', 'gemini-input.css'],
  runAt: 'document_idle',
};

async function registerGeminiScripts() {
  try {
    if (!(await hasProviderPermission('gemini'))) return;
    const existing = await chrome.scripting
      .getRegisteredContentScripts({ ids: [GEMINI_INJECT.id] })
      .catch(() => []);
    // Update (not skip) when already registered: a persisted registration from an
    // older build could otherwise keep injecting a stale js/css list after update.
    if (existing.length > 0) {
      await chrome.scripting.updateContentScripts([GEMINI_INJECT]);
    } else {
      await chrome.scripting.registerContentScripts([GEMINI_INJECT]);
    }
  } catch (e) {
    console.warn('[Claude Tuner] registerGeminiScripts failed:', e.message);
  }
}

async function unregisterGeminiScripts() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [GEMINI_INJECT.id] });
  } catch { /* not registered */ }
}

// Inject into already-open gemini.google.com tabs (registerContentScripts only
// affects future navigations) — covers permission-grant and update/reload.
async function injectGeminiOpenTabs() {
  try {
    if (!(await hasProviderPermission('gemini'))) return;
    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    for (const tab of tabs) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: GEMINI_INJECT.js }).catch(() => {});
      chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: GEMINI_INJECT.css }).catch(() => {});
    }
    if (tabs.length > 0) maybeCollectGeminiForTab(); // fill the freshly-injected panel
  } catch { /* tabs API may fail in some contexts */ }
}

chrome.permissions.onAdded.addListener((perm) => {
  if (perm.origins?.some(o => o.includes('chatgpt.com'))) {
    registerChatGPTScripts();
    injectChatGPTOpenTabs();
  }
  if (perm.origins?.some(o => o.includes('gemini.google.com'))) {
    registerGeminiScripts();
    injectGeminiOpenTabs();
  }
});
chrome.permissions.onRemoved.addListener((perm) => {
  if (perm.origins?.some(o => o.includes('chatgpt.com'))) {
    unregisterChatGPTScripts();
    // Already-injected scripts in open chatgpt.com tabs can't be messaged by URL
    // once the host permission is gone. Instead they self-teardown: their next
    // GET_SIDEBAR_USAGE poll gets `{ revoked: true }` (handler checks permission).
  }
  if (perm.origins?.some(o => o.includes('gemini.google.com'))) {
    unregisterGeminiScripts();
    // Same self-teardown path as ChatGPT: open Gemini tabs' scripts get
    // `{ revoked: true }` on their next GET_SIDEBAR_USAGE poll.
  }
});

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
async function mergeChatGPTOrgs(force = false, userManual = false) {
  try {
    const result = await collectChatGPT(force, userManual);
    // Reconcile the stored recs against what we just OBSERVED, on both branches — the empty one is
    // the whole point. collectChatGPT() returns no orgs when the user is signed out of ChatGPT (or
    // it is unreadable), and the merge below deliberately leaves the previously-collected orgs in
    // place, so without this the popup keeps rendering a rec whose signal is gone. Runs after the
    // collection (which POSTs and may store a FRESH rec), so a just-written rec is reconciled
    // against the very orgs it was computed from and survives.
    await reconcileProviderRecs('chatgpt', result.orgs);
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
// Returns true when Gemini usage was actually collected + stored, false otherwise
// (so callers can debounce only on success, not on a failed/empty attempt).
async function mergeGeminiOrgs(force = false, userManual = false) {
  try {
    const result = await collectGemini(force, userManual);
    // Gemini has no rec engine today, so this normally finds nothing to do. It is wired anyway
    // because the map is provider-GENERIC: the day a provider is added, the invalidation is
    // already here rather than waiting to be rediscovered as a stale-rec bug.
    await reconcileProviderRecs('gemini', result.orgs);
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
      return true;
    }
    return false;
  } catch (e) {
    console.warn('[Claude Tuner] Gemini collection skipped:', e.message);
    return false;
  }
}

// Collect Gemini usage when a gemini.google.com tab loads/activates so the in-page
// panel fills immediately, instead of waiting for the periodic alarm or a manual
// re-collect. mergeGeminiOrgs() writes collectedOrgs → storage.onChanged →
// pushSidebarUsage() tells the panel to re-fetch.
//
// Debounce design (mirrors Claude's persisted tab-collect throttle):
//  - success debounce (_lastGeminiTabCollect, persisted): after a successful
//    collect, skip further collects for 30s — survives MV3 worker restarts.
//  - attempt floor (_lastGeminiTabAttempt, in-memory): after ANY attempt, wait 5s
//    before retrying, so a failed first collect fills soon instead of being locked
//    out for 30s, while still not hammering the RPC.
let _lastGeminiTabCollect = 0;
let _lastGeminiTabAttempt = 0;
let _geminiCollectInFlight = false;
const GEMINI_TAB_COLLECT_DEBOUNCE_MS = 30_000;
const GEMINI_TAB_ATTEMPT_FLOOR_MS = 5_000;
// Restore the persisted success timestamp; awaited inside maybeCollectGeminiForTab
// so a very early tab event doesn't ignore a recent (persisted) collect.
const _geminiCollectRestore = chrome.storage.local.get({ _lastGeminiTabCollect: 0 })
  .then((r) => { _lastGeminiTabCollect = r._lastGeminiTabCollect || 0; })
  .catch(() => {});
async function maybeCollectGeminiForTab() {
  if (_geminiCollectInFlight) return;                                        // serialize concurrent triggers
  const now = Date.now();
  if (now - _lastGeminiTabAttempt < GEMINI_TAB_ATTEMPT_FLOOR_MS) return;     // set BEFORE awaits so parallel calls can't all pass
  _lastGeminiTabAttempt = now;
  _geminiCollectInFlight = true;
  try {
    await _geminiCollectRestore;
    if (Date.now() - _lastGeminiTabCollect < GEMINI_TAB_COLLECT_DEBOUNCE_MS) return; // recent success (persisted)
    const { collectGemini: geminiEnabled = true } = await chrome.storage.sync.get({ collectGemini: true });
    if (!geminiEnabled) return;
    if (!(await hasProviderPermission('gemini'))) return;
    const ok = await mergeGeminiOrgs(false).catch(() => false);
    if (ok) {
      _lastGeminiTabCollect = Date.now();
      chrome.storage.local.set({ _lastGeminiTabCollect });
    }
  } finally {
    _geminiCollectInFlight = false;
  }
}

// Wrap collectAndSend to suppress spurious cookie-change events during collection
// ChatGPT/Gemini collection runs independently after Claude (regardless of Claude result)
async function collectAndSend(opts) {
  _collecting = true;
  try {
    // Provider-incident collection pause (server circuit breaker), enforced for the
    // WHOLE orchestration — Claude + ChatGPT + Gemini — so no provider is fetched
    // while paused. force (manual) bypasses. (collect.js has its own guard for direct
    // Claude calls; this one covers the provider merges below that bypass it.)
    if (!opts?.force && isCollectionPaused(await getCadence())) {
      console.log('[Claude Tuner] Collection paused by server (provider incident). Skipping all providers.');
      return { success: false, paused: true };
    }
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
      await mergeChatGPTOrgs(opts?.force, opts?.userManual).catch(() => {});
    }
    if (collectGemini && await hasProviderPermission('gemini')) {
      await mergeGeminiOrgs(opts?.force, opts?.userManual).catch(() => {});
    }
    return result;
  } catch (e) {
    // Claude failed — still try ChatGPT/Gemini independently if enabled.
    // Await (sequentially) so the SW isn't terminated mid-request.
    const { collectChatGPT = true, collectGemini = true } = await chrome.storage.sync.get({ collectChatGPT: true, collectGemini: true });
    if (collectChatGPT && await hasProviderPermission('chatgpt')) await mergeChatGPTOrgs(opts?.force, opts?.userManual).catch(() => {});
    if (collectGemini && await hasProviderPermission('gemini')) await mergeGeminiOrgs(opts?.force, opts?.userManual).catch(() => {});
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
  checkPromoPush(); // fire a pending server push on install/update too (best-effort)
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
    // Only force the welcome page's language when the user has *explicitly* set
    // the extension language. On 'auto' (the default), pass no param and let the
    // welcome page self-detect via navigator.language — the same signal the popup
    // uses. (Do NOT use chrome.i18n.getUILanguage()/bgLang here: it reflects
    // Chrome's app UI language, which can differ from navigator.language and would
    // mismatch what the user sees in the popup.)
    let explicitLang = null;
    try {
      const { lang } = await chrome.storage.sync.get({ lang: 'auto' });
      if (lang === 'ko' || lang === 'en') explicitLang = lang;
    } catch (e) { /* fall through with no param */ }
    const welcomeUrl = new URL('/welcome/', SITE_URL);
    if (explicitLang) welcomeUrl.searchParams.set('lang', explicitLang);
    chrome.tabs.create({ url: welcomeUrl.toString() });
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
        files: ['usage-shared.js', 'sidebar-usage.js', 'input-usage.js'],
      }).catch(() => {});
      chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['sidebar-usage.css', 'input-usage.css'],
      }).catch(() => {});
    }
  } catch { /* tabs API may fail in some contexts */ }

  // Register + inject ChatGPT panel scripts (no-op without the optional permission)
  await registerChatGPTScripts();
  await injectChatGPTOpenTabs();
  // Register + inject Gemini panel scripts (no-op without the optional permission)
  await registerGeminiScripts();
  await injectGeminiOpenTabs();
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

  if (message && message.type === 'set_org_context' && message.org_name) {
    chrome.storage.local.set({ onboardOrgName: message.org_name }, () => {
      console.log('[Claude Tuner] onboardOrgName set:', message.org_name);
      sendResponse({ ok: true });
    });
    return true; // async sendResponse
  }

  // Get extension info
  if (message && message.type === 'GET_INFO') {
    sendResponse({ version: chrome.runtime.getManifest().version });
    return;
  }

  // Get the account the extension is currently collecting for (read-only, no token
  // minted — unlike GET_CLAUDE_LOGIN). The dashboard uses this to detect an
  // account mismatch: when the signed-in dashboard account has no data but the
  // extension is collecting under a DIFFERENT email, it can point the user to the
  // right account instead of showing a misleading "collection stopped" banner.
  if (message && message.type === 'GET_ACCOUNT_EMAIL') {
    (async () => {
      try {
        const { accountCache, independentAccount } = await chrome.storage.local.get({
          accountCache: null,
          independentAccount: null,
        });
        let email = accountCache?.email || null;
        let name = accountCache?.name || '';
        if (!email && independentAccount?.email) {
          email = independentAccount.email;
          name = independentAccount.name || '';
        }
        sendResponse({ success: !!email, email, name });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true; // async sendResponse
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
        // userManual: onboarding is a user-initiated collect — bypass the server-backoff gate.
        const result = await collectAndSend({ force: true, userManual: true });
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
  checkPromoPush(); // server-signaled push, independent of collection success (best-effort)
  sendGAEvent('extension_loaded');
  await restoreSidePanelPreference();
  // Re-register dynamic ChatGPT/Gemini scripts on browser restart (registrations
  // persist, but this self-heals if they were lost; no-op without the optional
  // permission).
  await registerChatGPTScripts();
  await registerGeminiScripts();
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
  await scheduleRecFetch();
  await updateAdFlushAlarm(); // periodic ad impression/click counter flush (design §5.4)
}

// Plan recommendation fetch alarm (~6h). Recs now arrive via GET /api/recommendations rather than
// the ingest POST response, so this slow timer keeps them fresh. Guarded so it isn't recreated on
// every startup (which would reset its period), mirroring scheduleWeeklyReport's precedent. A short
// initial delay does the first fetch so the user doesn't wait a full 6h after install/startup.
async function scheduleRecFetch() {
  const existing = await chrome.alarms.get(ALARM_REC);
  if (existing) return; // already scheduled
  // De-sync jitter on the first fire, same rationale as updatePollAlarm's: Chrome fires periodic
  // alarms relative to creation, and a CWS auto-update recreates the fleet's alarms within a short
  // window — without jitter the whole fleet then hits GET /api/recommendations on the same 6h grid
  // (each fetch is a D1+Timescale read on a KV miss). A 0-59min random phase spreads that grid; the
  // rec is advisory, so the first fetch landing within the hour (not at 1m) costs nothing visible.
  const jitterMin = Math.random() * 59;
  chrome.alarms.create(ALARM_REC, { delayInMinutes: 1 + jitterMin, periodInMinutes: 360 });
  console.log(`[rec-fetch] Recommendation alarm scheduled (initial ${Math.round(1 + jitterMin)}m, then every 6h)`);
}

// Adaptive poll alarm: adjusts interval based on activity state.
// Server POST is gated separately inside the alarm handler.
async function updatePollAlarm() {
  const config = await getConfig();
  const baseInterval = config.intervalMinutes || DEFAULT_INTERVAL_MINUTES;
  const cadence = await getCadence();

  // Base interval by plan/activity. Free plan is fixed 60min (ignores activity); paid
  // plans use the activity tiers.
  let interval;
  if (baseInterval === FREE_PLAN_INTERVAL_MINUTES) {
    interval = FREE_PLAN_INTERVAL_MINUTES;
  } else {
    const state = getActivityState();
    switch (state) {
      case ACTIVITY_STATES.ACTIVE:     interval = LOCAL_ACTIVE_INTERVAL_MINUTES; break;     // 2min (floored below)
      case ACTIVITY_STATES.BACKGROUND: interval = LOCAL_BACKGROUND_INTERVAL_MINUTES; break; // 5min
      default:                         interval = baseInterval; break;                       // 10min (server default)
    }
  }

  // Collection floor applies to ALL plans (incl. Free): never collect faster than the
  // resolved collect floor (hard 5min min + any server collect_floor for provider
  // incidents). MAX so the server can only SLOW collection, never speed it past the
  // 5min hard floor (too fast → provider ban). Active's 2min effectively becomes >=5min;
  // a fleet collect_floor above 60 also slows Free.
  const collectFloorMin = cadence.collectFloorMs / 60000;
  interval = Math.max(interval, collectFloorMin);
  // Corrupt-config guard: a malformed stored `intervalMinutes` or server `poll_interval_minutes`
  // can make `interval` NaN/Infinity (Math.max(NaN, n) === NaN), which would make delayInMinutes
  // NaN — Chrome silently drops the alarm and collection STOPS. Fall back to the default interval
  // (always finite; collectFloorMin is itself clamped finite by cadence-config). Pre-existing risk;
  // the jitter below would propagate it, so harden here.
  if (!Number.isFinite(interval) || interval <= 0) interval = DEFAULT_INTERVAL_MINUTES;
  // Collection pause (provider-incident circuit breaker): delay the next tick to the
  // pause end so the fleet stops hitting the provider; the collectAndSend pause guard
  // is the authoritative skip if a tick still fires.
  const paused = isCollectionPaused(cadence);
  // De-sync jitter: give the FIRST fire a per-client random phase offset so clients that
  // (re)create their alarm at the same instant don't all fire on the same wall-clock minute.
  // The synchronizer is the Monday-morning wave of users opening Claude: they transition to
  // the active tier together (interval 10→5min), the alarm is re-created at ~the same time,
  // and Chrome fires periodic alarms RELATIVE TO CREATION — so every client's phase clusters
  // and ~1/3 of the active fleet then POSTs on one server minute every `interval`, stalling
  // the single-D1 primary (2026-06-21 incident). NB collection ≠ posting, but the periodic
  // server POST only happens inside collectAndSend (the ALARM_NAME wake) — the SW is dormant
  // otherwise — so spreading the collection grid spreads the POSTs too; per-user POST rate is
  // still the 15min send floor, this only spreads WHEN each client's grid lands.
  // The jitter is ADDED to `interval` (never below it → can't undercut the collect floor /
  // provider protection) and CAPPED at the collect floor (collectFloorMin) so the extra
  // first-fire delay is bounded (~5min) even for the 60min free-plan interval — while the
  // dominant 5min active/bg tier (the wave) still gets a full-period spread (cap == its period).
  // `interval` is server-tunable (collectFloor pushed via /api/snapshots) so the jitter scales.
  // The phase persists because the alarm isn't re-created while the interval is unchanged (guard below).
  let delay = interval + Math.random() * Math.min(interval, collectFloorMin);
  if (paused) {
    delay = Math.max(interval, Math.ceil((cadence.collectPauseUntil - Date.now()) / 60000));
  }

  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!paused && existing && Math.abs(existing.periodInMinutes - interval) < 0.5) return; // no change needed

  chrome.alarms.create(ALARM_NAME, { delayInMinutes: delay, periodInMinutes: interval });
  console.log(`[Claude Tuner] Poll alarm: ${interval}m (collectFloor=${collectFloorMin}m${paused ? `, paused ${delay}m` : ''})`);
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

  // Coarse server-path floor (same as the alarm handler): run the server path
  // at most ~every SEND_MIN_INTERVAL; the per-org delta-gate inside
  // collectAndSend makes the actual send decision (change / 1h heartbeat floor).
  const { _lastServerPost = 0 } = await chrome.storage.local.get('_lastServerPost');
  const shouldPost = (Date.now() - _lastServerPost) >= (SEND_MIN_INTERVAL_MS - 30_000);

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
  // Gemini has no server-side polling here; collect on tab load so its panel fills.
  if (changeInfo.status === 'complete' && tab.url?.startsWith('https://gemini.google.com')) {
    maybeCollectGeminiForTab();
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
      // Also refresh the Gemini panel when returning to its tab.
      if (tab.url?.startsWith('https://gemini.google.com')) maybeCollectGeminiForTab();
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
// Refresh usage data immediately when a rate limit (429) occurs on message send/retry.
// The first 429 force-posts promptly (capture the rate-limit moment), but each 429 also
// forces a server POST — so a user sitting on a sustained rate limit could fire one every
// 30s and undercut adaptive-polling savings. Use exponential backoff: the throttle window
// doubles on each consecutive 429-triggered collect (30s → 60s → … capped at 10min), and
// resets to the base once 429s stop for a quiet period (the limit cleared).
let _last429Collect = 0;
let _429BackoffMs = 0; // current backoff window; 0 = fresh (next 429 collects promptly)
const RATELIMIT_BASE_THROTTLE_MS = 30 * 1000;      // minimum spacing between forced collects
const RATELIMIT_MAX_THROTTLE_MS = 10 * 60 * 1000;  // cap — sustained 429 = usage already maxed
const RATELIMIT_BACKOFF_RESET_MS = 15 * 60 * 1000; // quiet gap → treat next 429 as fresh

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.statusCode === 429) {
      const now = Date.now();
      const sinceLast = now - _last429Collect;
      // A long quiet gap means the rate limit cleared — reset backoff so the next
      // 429 collects promptly again.
      if (sinceLast >= RATELIMIT_BACKOFF_RESET_MS) _429BackoffMs = 0;
      const throttle = Math.max(RATELIMIT_BASE_THROTTLE_MS, _429BackoffMs);
      if (sinceLast < throttle) return;
      _last429Collect = now;
      // Grow the window for the NEXT consecutive 429 (exponential, capped).
      _429BackoffMs = Math.min(
        _429BackoffMs ? _429BackoffMs * 2 : RATELIMIT_BASE_THROTTLE_MS * 2,
        RATELIMIT_MAX_THROTTLE_MS
      );
      console.log(`[Claude Tuner] 429 detected: ${details.url.split('?')[0]} (next throttle ${Math.round(_429BackoffMs / 1000)}s)`);
      // force: a rate-limit event is a real usage change — always post it, even if
      // the primary org's adaptive tier would otherwise be mid-interval (idle/dormant).
      collectAndSend({ force: true }).then((result) => {
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
    // Coarse server-path floor: run the server path at most ~every
    // SEND_MIN_INTERVAL (10min). The actual send decision is made per-org by the
    // delta-gate inside collectAndSend (send on usage change, or a 1h heartbeat
    // floor). This replaces the old serverPollInterval time-throttle — with
    // delta-gating the client already minimizes sends by change, so the coarse
    // gate only needs to bound how often we re-evaluate. Local history/UI still
    // updates every alarm tick (skipServer path) so the popup stays fresh.
    const { _lastServerPost = 0 } = await chrome.storage.local.get('_lastServerPost');
    const shouldPost = (Date.now() - _lastServerPost) >= (SEND_MIN_INTERVAL_MS - 30_000); // 30s tolerance

    const result = await collectAndSend({ skipServer: !shouldPost });
    if (result.success) {
      if (!result.localOnly) await chrome.storage.local.set({ _lastServerPost: Date.now() });
      await scheduleExpireAlarms(result.snapshot);
      await evaluateBoost(result.snapshot);
    }
    // Server-signaled push: run every poll tick, independent of collection success, so a
    // momentary collection failure never suppresses a launch push (throttled + deduped inside).
    checkPromoPush();
  }
  // Weekly report
  if (alarm.name === ALARM_WEEKLY_REPORT) {
    await sendWeeklyReport();
    return;
  }
  // Plan recommendation refresh (~6h): the ingest POST response no longer carries recs, so
  // pull them from the worker on a slow timer. Best-effort — never throws.
  if (alarm.name === ALARM_REC) {
    const config = await getConfig();
    await fetchRecommendations(config);
    return;
  }
  // Ad counter flush (flushAdCounters already serializes through _adEnqueue).
  if (alarm.name === AD_FLUSH_ALARM) {
    flushAdCounters();
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

  // NOTE: we intentionally do NOT clear existing expire alarms first. Alarm names
  // are deterministic per (key, suffix), so chrome.alarms.create() overwrites the
  // same alarm when the reset time shifts. Clearing first + the >30s guard below
  // would DELETE an already-scheduled due-soon alarm and then refuse to recreate
  // it (a collection cycle inside the ramp window could thus starve pre1/after).
  // Not clearing lets a due-soon alarm survive and fire. Stale alarms for a reset
  // key that disappeared simply fire once (a harmless collect) and aren't
  // recreated. Combined with the stable per-device jitter below, every reschedule
  // lands each ramp alarm at the same time → idempotent.

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
  // Ramp trimmed to peak + drop. The server's 60min unchanged-usage dedup
  // already collapses the redundant steps: for a plateaued user, pre2/pre1/at
  // land identical pre-reset values and only the post-reset drop survives
  // (2026-06-17 data: e.g. 100→100→100→0). pre2 and 'at' were therefore dropped —
  // pre1 captures the pre-reset peak, 'after' the post-reset drop — which also
  // halves the synchronized top-of-hour POST volume the deduped steps still cost.
  const offsets = [
    { suffix: 'notify5', minutes: -5 }, // Notification 5min before
    { suffix: 'pre1', minutes: -1 },    // Collect 1min before (peak)
    { suffix: 'after', minutes: 2 },    // Collect + notify 2min after reset (drop)
  ];

  // De-sync the fleet: reset times are clock-aligned (7d all at :00, 5h at :X0),
  // so without jitter every device's collect alarms fire at the same wall-clock
  // minute → a ~40% top-of-hour write spike on the single-writer D1 (2026-06-17).
  // Use a STABLE per-device jitter fraction (generated once, persisted): the same
  // device always shifts by the same amount → reschedules land each alarm at the
  // SAME time (idempotent, no starvation), while different devices get different
  // offsets → the cohort spreads across ~90s. Apply it DIRECTIONALLY — pre-reset
  // alarms shift EARLIER and post-reset alarms shift LATER — so a jittered 'pre1'
  // never crosses the reset (still captures the peak) and 'after' never fires
  // before the reset (still captures the drop).
  let { ct_jitter_offset: jf } = await chrome.storage.local.get('ct_jitter_offset');
  if (typeof jf !== 'number' || jf < 0 || jf > 1) {
    jf = Math.random();
    await chrome.storage.local.set({ ct_jitter_offset: jf });
  }
  const jitterMag = jf * 90 * 1000; // stable 0..90s for this device

  let scheduled = 0;
  for (const { key, time } of resetTimes) {
    const expireMs = new Date(time).getTime();
    if (isNaN(expireMs)) continue;

    for (const { suffix, minutes } of offsets) {
      // pre-reset (minutes <= 0) shifts earlier, post-reset shifts later
      const dirJitter = minutes <= 0 ? -jitterMag : jitterMag;
      const triggerMs = expireMs + minutes * 60 * 1000 + dirJitter;
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
  // Ad measurement (design §5.3/§5.4): content scripts detect viewability/click and
  // send here; the SW is the single owner that increments + flushes. Fire-and-forget.
  if (message.type === 'ad_metric') { incrementAdCounter(message); return false; }
  if (message.type === 'ad_flush_hint') { flushAdCounters(); return false; }
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
    // userManual: the user pressed the popup "수집" button — bypass the server-backoff
    // gate so a manual collect isn't silently no-op'd during a backoff window.
    collectAndSend({ force: true, userManual: true }).then((result) => sendResponse(result));
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
    const provider = message.provider || 'claude';
    // Non-Claude panels require the optional host permission. If it was revoked
    // after injection, tell the (still-running) content script to tear itself
    // down — we can't message provider tabs by URL once the permission is gone.
    if (provider !== 'claude') {
      hasProviderPermission(provider).then(ok => {
        if (!ok) { sendResponse({ revoked: true }); return; }
        return buildSidebarUsageData(message.orgId, provider).then(sendResponse);
      });
      return true;
    }
    buildSidebarUsageData(message.orgId, provider).then(sendResponse);
    return true;
  }
  // Folder freemium gate: resolve our billing entitlement (server-authoritative).
  // Returns { plan: 'pro' | 'free' } from /api/me's `billing` summary. Cache is
  // scoped to the resolved account email and only trusted within a 24h TTL; on any
  // failure (or a different/expired account) it fails CLOSED to 'free' so a lapsed
  // or swapped account can never keep Pro-only capacity offline indefinitely.
  if (message.type === 'GET_ENTITLEMENT') {
    (async () => {
      const CACHE_KEY = 'ct_entitlement';
      const TTL_MS = 24 * 60 * 60 * 1000;
      const config = await getConfig().catch(() => null);
      const status = await getLastStatus().catch(() => null);
      let email = status?.snapshot?.user_email;
      if (!email) {
        const { independentAccount } = await chrome.storage.local.get({ independentAccount: null });
        email = independentAccount?.email || null;
      }
      // Cache is valid only when it belongs to the current account AND is within TTL.
      const readFreshCache = async () => {
        try {
          const cached = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY];
          if (cached && cached.email === email && email &&
              (Date.now() - (cached.at || 0) < TTL_MS)) return cached.plan === 'pro' ? 'pro' : 'free';
        } catch { /* ignore */ }
        return null; // no usable cache -> caller fails closed to 'free'
      };
      try {
        if (!message.force) {
          const cachedPlan = await readFreshCache();
          if (cachedPlan) { sendResponse({ plan: cachedPlan, cached: true }); return; }
        }
        if (!config?.serverUrl || !email) { sendResponse({ plan: 'free', stale: true }); return; }
        const resp = await authedFetch(config, `${config.serverUrl}/api/me`, {
          headers: { 'X-User-Email': email },
        });
        // Fail CLOSED on any server error: never serve a Pro plan we couldn't
        // confirm this call. (A fresh same-account cache is already returned by the
        // non-force path above, so reaching here means we have no trustworthy Pro.)
        if (!resp.ok) { sendResponse({ plan: 'free', stale: true }); return; }
        const data = await resp.json();
        const plan = data?.billing?.plan === 'pro' ? 'pro' : 'free';
        await chrome.storage.local.set({ [CACHE_KEY]: { plan, at: Date.now(), email } });
        sendResponse({ plan });
      } catch (e) {
        sendResponse({ plan: 'free', stale: true });
      }
    })();
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

  // === M3 folder server sync (Pro-gated, KV-backed, whole-store LWW) ===
  // The content script (claude-folders.js) cannot reach the API directly (that
  // needs host_permissions, which are forbidden). It proxies all folder sync
  // through here, reusing the same authed-fetch + ext_token path as snapshots.
  // The authed email is resolved the same way GET_ENTITLEMENT does and echoed
  // back so the content script can build the store without extra round-trips.
  if (message.type === 'ct_folders_pull') {
    (async () => {
      try {
        const config = await getConfig().catch(() => null);
        const status = await getLastStatus().catch(() => null);
        let email = status?.snapshot?.user_email;
        if (!email) {
          const { independentAccount } = await chrome.storage.local.get({ independentAccount: null });
          email = independentAccount?.email || null;
        }
        if (!config?.serverUrl || !email) { sendResponse({ ok: false, status: 0, email: null }); return; }
        const resp = await authedFetch(config, `${config.serverUrl}/api/folders?email=${encodeURIComponent(email)}`);
        if (!resp.ok) { sendResponse({ ok: false, status: resp.status, email }); return; }
        const data = await resp.json().catch(() => ({}));
        sendResponse({ ok: true, store: data?.store ?? null, email });
      } catch (e) {
        sendResponse({ ok: false, status: -1, email: null });
      }
    })();
    return true;
  }
  if (message.type === 'ct_folders_push') {
    (async () => {
      try {
        const config = await getConfig().catch(() => null);
        const status = await getLastStatus().catch(() => null);
        let email = status?.snapshot?.user_email;
        if (!email) {
          const { independentAccount } = await chrome.storage.local.get({ independentAccount: null });
          email = independentAccount?.email || null;
        }
        if (!config?.serverUrl || !email) { sendResponse({ ok: false, status: 0, email: null }); return; }
        const resp = await authedFetch(config, `${config.serverUrl}/api/folders`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, store: message.store }),
        });
        const data = await resp.json().catch(() => ({}));
        // 409 = server copy newer (LWW loss); hand the server store back to adopt.
        if (resp.status === 409) { sendResponse({ ok: false, conflict: true, store: data?.store ?? null, status: 409, email }); return; }
        if (!resp.ok) { sendResponse({ ok: false, status: resp.status, email }); return; }
        sendResponse({ ok: true, updatedAt: data?.updatedAt, email });
      } catch (e) {
        sendResponse({ ok: false, status: -1, email: null });
      }
    })();
    return true;
  }
});

// Auto-dismiss timed promo push notifications when their TTL alarm fires. chrome.alarms
// survives service-worker suspension (unlike setTimeout). Alarm name: 'promopushclear:<notifId>'.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name && alarm.name.startsWith('promopushclear:')) {
    chrome.notifications.clear(alarm.name.slice('promopushclear:'.length));
  }
});

// === Notification click handler ===
// Promo push (e.g. Product Hunt launch): clicking the notification body opens the promo URL.
chrome.notifications.onClicked.addListener(async (notifId) => {
  if (!notifId.startsWith('promo-push-')) return;
  const promoId = notifId.replace('promo-push-', '');
  const { promoPushState = {} } = await chrome.storage.local.get({ promoPushState: {} });
  const url = promoPushState[promoId]?.url;
  if (url) chrome.tabs.create({ url });
  chrome.notifications.clear(notifId);
});

chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  // Promo push (e.g. Product Hunt launch) → open the promo URL
  if (notifId.startsWith('promo-push-') && btnIdx === 0) {
    const promoId = notifId.replace('promo-push-', '');
    const { promoPushState = {} } = await chrome.storage.local.get({ promoPushState: {} });
    const url = promoPushState[promoId]?.url;
    if (url) chrome.tabs.create({ url });
    chrome.notifications.clear(notifId);
    return;
  }
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
async function buildSidebarUsageData(reqOrgId, provider) {
  const wantProvider = provider || 'claude';
  const [status, history, local] = await Promise.all([
    getLastStatus(),
    getUsageHistory(),
    new Promise(r => chrome.storage.local.get({ collectedOrgs: [], sidebarLang: null }, r)),
  ]);

  const allOrgs = local.collectedOrgs || [];
  // The Claude snapshot only describes Claude data — never apply it to a
  // non-Claude provider's panel (ChatGPT/Gemini).
  const snapshot = wantProvider === 'claude' ? status?.snapshot : null;

  // Each provider's in-page panel only displays that provider's data.
  const collectedOrgs = allOrgs.filter(o => (o.provider || 'claude') === wantProvider);
  if (!snapshot && collectedOrgs.length === 0) return null;

  // Determine which org to show. Claude content scripts pass the active org id
  // (lastActiveOrg cookie) and we respect it strictly. Non-Claude panels pass
  // no org id — fall back to the pinned/first org of that provider.
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
  const pred5h = calcSidebarPrediction(history, 'h5', h5, r5, reqOrgId || orgData?.uuid, wantProvider);
  const pred7d = calcSidebarPrediction(history, 'd7', d7, r7, reqOrgId || orgData?.uuid, wantProvider);

  // Language detection
  const lang = local.sidebarLang || (snapshot?.user_lang) || 'en';

  // No-limit plan (Gemini Workspace/Business/Enterprise): the collector sets this
  // by plan (these seats report 0% windows, not null), so trust the stored flag.
  const noLimits = !!orgData?.noLimits;

  return { plan, h5, d7, r5, r7, eu: euUsed, el: euLimit, euEnabled, pred5h, pred7d, lang, noLimits };
}

// Lightweight prediction for sidebar (mirrors popup calcPredictedAtReset)
function calcSidebarPrediction(history, key, currentUtil, resetsAt, orgUuid, provider) {
  if (!resetsAt || currentUtil == null || !history || history.length < 3) return null;

  const now = Date.now();
  const hoursToReset = (new Date(resetsAt).getTime() - now) / 3600000;
  if (hoursToReset <= 0) return null;

  // Filter history for matching org. The legacy unscoped (no `org`) points are
  // pre-multi-org Claude samples — only fold them into Claude predictions, never
  // into a non-Claude provider's (which would skew ChatGPT/Gemini estimates).
  const allowUnscoped = (provider || 'claude') === 'claude';
  const orgHistory = orgUuid
    ? history.filter(p => p.org === orgUuid || (allowUnscoped && !p.org))
    : history;

  let rate = null;
  let hoursDiff = 0;

  if (key === 'd7') {
    // 7d: activity-normalized adaptive projection. Mirrors ui/prediction.js calcPredictedAtReset —
    // keep the CORE and this sidebar duplicate in sync (docs/DESIGN-rate-estimator.md).
    // EWMA burn rate over ~48h of activity time, projected through the user's personal
    // diurnal + weekly curve (global fallback when data is thin). Pass the org-scoped history
    // so the personal curve is built from this org's own samples.
    const samples = orgHistory
      .filter(p => p.d7 != null && p.r7)
      .map(p => ({ tMs: p.t, util: p.d7, resetMs: new Date(p.r7).getTime() }));
    const dp = diurnalProject7dAdaptive({ samples, currentUtil, resetMs: new Date(resetsAt).getTime(), nowMs: now });
    if (!dp || dp.rate <= 0 || dp.predicted - currentUtil < 3) return null;
    return Math.round(dp.predicted);
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

// Notify in-page usage panels (Claude + provider) to re-fetch with their own
// orgId/provider. Each content script re-requests GET_SIDEBAR_USAGE on receipt.
async function pushSidebarUsage() {
  // Query each origin independently: a tabs.query that includes an origin the
  // extension lacks host permission for (chatgpt.com is optional) can reject,
  // and a combined query would then drop the Claude refresh too. Claude is
  // always granted; ChatGPT only when its optional permission is present.
  const refresh = (tab) => chrome.tabs.sendMessage(tab.id, { type: 'SIDEBAR_USAGE_REFRESH' }).catch(() => {});
  try {
    const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    for (const tab of tabs) refresh(tab);
  } catch { /* content script may not be ready */ }
  try {
    if (await hasProviderPermission('chatgpt')) {
      const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
      for (const tab of tabs) refresh(tab);
    }
  } catch { /* no permission / not ready */ }
  try {
    if (await hasProviderPermission('gemini')) {
      const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
      for (const tab of tabs) refresh(tab);
    }
  } catch { /* no permission / not ready */ }
}

// Hook into storage changes to push sidebar updates after collection.
// Only trigger when Claude orgs actually changed — ChatGPT/Gemini merges
// should not cause sidebar/input to re-render on claude.ai.
// For skipServer/boost mode (no collectedOrgs write), pushSidebarUsage()
// is called explicitly in collect.js.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.collectedOrgs) {
    // Push when any provider that has an in-page panel changed. pushSidebarUsage()
    // notifies claude.ai, chatgpt.com and gemini.google.com tabs; each re-fetches
    // its own data.
    const PANEL_PROVIDERS = ['claude', 'chatgpt', 'gemini'];
    const oldVal = changes.collectedOrgs.oldValue || [];
    const newVal = changes.collectedOrgs.newValue || [];
    const changed = PANEL_PROVIDERS.some(p => {
      const o = oldVal.filter(x => (x.provider || 'claude') === p);
      const n = newVal.filter(x => (x.provider || 'claude') === p);
      return JSON.stringify(o) !== JSON.stringify(n);
    });
    if (changed) pushSidebarUsage();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// In-house ad measurement — SINGLE-OWNER counter + batched flush (design §5.3/§5.4)
// ══════════════════════════════════════════════════════════════════════════
// The background service worker is the SINGLE OWNER of all ad impression/click
// counters: it does BOTH the increments (from content-script 'ad_metric' messages)
// AND the periodic flush to /api/event, serialized through ONE async op-chain
// (_adEnqueue) so there is never a read-modify-write race across tabs or between an
// increment and an in-flight flush. Content scripts never touch the counter storage.

const AD_COUNTERS_KEY = '__ct_ad_counters'; // { "campaign|content|placement": {imp,clk} }
const AD_FLUSH_ALARM = 'ad-flush';
const AD_EVENT_ENDPOINT = 'https://api.claudetuner.com/api/event';
// Per-flush row cap. The worker /api/event caps the body at 4096 bytes AND 50 rows;
// campaign/content IDs can be up to 128 chars each, so a fixed row count can exceed the
// worker's 4096-byte /api/event cap → the worker drops the body but returns 204 while
// the client would subtract/delete the counters = silent count loss. The flush builds
// its batch by BYTE BUDGET (AD_FLUSH_MAX_BYTES, headroom under 4096) with a 50-row hard
// cap; excess keys stay in the store and drain over subsequent flush ticks (design §5.4).
const AD_FLUSH_MAX_ROWS = 50;   // hard row cap (matches the worker's row slice)
const AD_FLUSH_MAX_BYTES = 3600; // serialized-body byte budget (headroom under the worker's 4096)

// Byte-accurate size of a string: Blob is exact for any encoding; str.length is an
// ASCII-only fallback (ad IDs are ASCII, so char ≈ byte) when Blob is unavailable.
function _adByteSize(str) {
  try { return new Blob([str]).size; } catch { return str.length; }
}

// Single async op-chain (mutex): every counter read-modify-write — increment AND
// flush — is appended here so they can never interleave. Failures are swallowed so
// one bad op never wedges the chain.
let _adOpChain = Promise.resolve();
function _adEnqueue(fn) { _adOpChain = _adOpChain.then(fn).catch(() => {}); return _adOpChain; }

function _adValidStr(v) { return typeof v === 'string' && v.length > 0; }

// Increment one counter cell from an 'ad_metric' message. Ignored unless all three
// identity keys are non-empty strings and kind is a known event.
function incrementAdCounter(message) {
  const { kind, campaign, content, placement } = message || {};
  if (!_adValidStr(campaign) || !_adValidStr(content) || !_adValidStr(placement)) return;
  if (kind !== 'impression' && kind !== 'click') return;
  _adEnqueue(async () => {
    const store = (await chrome.storage.local.get(AD_COUNTERS_KEY))[AD_COUNTERS_KEY] || {};
    const key = campaign + '|' + content + '|' + placement;
    const e = store[key] || { imp: 0, clk: 0 };
    if (kind === 'impression') e.imp++; else e.clk++;
    store[key] = e;
    await chrome.storage.local.set({ [AD_COUNTERS_KEY]: store });
  });
}

// Flush batched counters to /api/event. Runs through the op-chain so it never races
// an increment. Sends a snapshot of the current non-empty cells, then SUBTRACTS
// exactly what was sent from a FRESH re-read (never zeroes the store) so increments
// that arrived during the in-flight POST are preserved. No-op when nothing to send;
// on POST failure the counters are left intact for the next flush.
function flushAdCounters() {
  return _adEnqueue(async () => {
    const store = (await chrome.storage.local.get(AD_COUNTERS_KEY))[AD_COUNTERS_KEY] || {};
    const keys = Object.keys(store).filter((k) => store[k].imp > 0 || store[k].clk > 0);
    if (!keys.length) return;
    const ver = chrome.runtime.getManifest().version;
    // Accumulate rows by BYTE BUDGET: add one at a time and stop before the serialized
    // body would exceed AD_FLUSH_MAX_BYTES OR AD_FLUSH_MAX_ROWS is reached (whichever
    // first). Keys not included stay in the store and drain next flush (only the keys in
    // `batch` are subtracted below). A single row that alone exceeds the budget (only
    // possible with corrupted/impossible keys — a valid 128-char-ID row is ~375B) is
    // SKIPPED, never force-sent, so the worker can't silently drop it and cause the
    // subtract-on-204 to delete real counts.
    const batch = [];
    const rows = [];
    for (const k of keys) {
      const [campaign, content, placement] = k.split('|');
      const row = { campaign, content, placement, imp: store[k].imp, clk: store[k].clk };
      const candidate = JSON.stringify({ type: 'banner_batch', ver, rows: rows.concat([row]) });
      if (_adByteSize(candidate) > AD_FLUSH_MAX_BYTES) {
        if (rows.length) break; // batch full — send the rest next flush
        continue;               // lone oversized row — skip (don't force-send + lose it)
      }
      rows.push(row);
      batch.push(k);
      if (batch.length >= AD_FLUSH_MAX_ROWS) break; // hard row cap
    }
    if (!rows.length) return; // nothing sendable this tick
    let ok = false;
    try {
      // text/plain keeps this a CORS simple request (no preflight), matching the project's
      // simplePost convention. The server always returns 204.
      //
      // `_auth` carries the ext_token ONLY so the server can count DISTINCT users reached
      // (privacy §9: it is hashed with a server secret, held <=24h as a de-duplication key,
      // and never written to analytics). ext_token only — never the shared public api_key,
      // which identifies nobody and would collapse the whole fleet onto one key. Absent
      // token → the beacon stays anonymous and impressions still count, we just get no reach.
      const extToken = await getExtToken();
      const payload = { type: 'banner_batch', ver, rows };
      if (extToken) payload._auth = extToken;
      const r = await fetch(AD_EVENT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      ok = r.ok || r.status === 204;
    } catch { ok = false; }
    if (!ok) return; // leave counters intact; retry on next flush
    // Re-read and SUBTRACT what was actually sent (preserve concurrent increments).
    const cur = (await chrome.storage.local.get(AD_COUNTERS_KEY))[AD_COUNTERS_KEY] || {};
    for (const k of batch) {
      if (!cur[k]) continue;
      cur[k].imp -= store[k].imp;
      cur[k].clk -= store[k].clk;
      if (cur[k].imp <= 0 && cur[k].clk <= 0) delete cur[k];
    }
    await chrome.storage.local.set({ [AD_COUNTERS_KEY]: cur });
  });
}

// (Re)schedule the periodic flush alarm from the server-tunable flush cadence
// (getCadence().flushMaxMs; default 60min). Called from setupAlarm (startup/install)
// and the cadence-change handler.
async function updateAdFlushAlarm() {
  const cadence = await getCadence();
  // Clamp to [1min, 1440min (24h)] so a pathological server cadence value can't set an
  // absurd alarm period. The value self-heals via cadence TTL, but bound it anyway.
  const minutes = Math.min(1440, Math.max(1, Math.round(cadence.flushMaxMs / 60000)));
  const existing = await chrome.alarms.get(AD_FLUSH_ALARM);
  if (existing && Math.abs(existing.periodInMinutes - minutes) < 0.5) return; // no change needed
  chrome.alarms.create(AD_FLUSH_ALARM, { periodInMinutes: minutes });
}

// Resolve circular dependency between bg/collect.js ↔ bg/plan.js: inject via setter
setCollectAndSendRef(collectAndSend);

// Reschedule BOTH the poll alarm and the ad-flush alarm immediately when the server
// changes the cadence (poll: collect floor / pause; flush: impression_flush_minutes)
// — without this the existing alarms keep their old period until an unrelated event
// fires the reschedule.
setCadenceChangeHandler(async () => { await updatePollAlarm(); await updateAdFlushAlarm(); });
