// === ES Module Imports ===
import { sendGAEvent, pinnedState, authState } from './bg/analytics.js';
import {
  ALARM_NAME, ALARM_EXPIRE_PREFIX, RESET_ALARM_KEYS, ALARM_BOOST, ALARM_WEEKLY_REPORT, ALARM_REC,
  DEFAULT_INTERVAL_MINUTES, FREE_PLAN_INTERVAL_MINUTES,
  LOCAL_ACTIVE_INTERVAL_MINUTES, LOCAL_BACKGROUND_INTERVAL_MINUTES,
  VISIBILITY_THROTTLE_MS, POPUP_COLLECT_THROTTLE_MS,
  NOTIF_ID_ALERT,
  DEFAULT_SERVER_URL, SITE_URL,
  SEND_MIN_INTERVAL_MS,
  PROVIDER_LABELS,
} from './bg/constants.js';
import { getActivityState, setActivityState, ACTIVITY_STATES } from './bg/activity.js';
import { bt } from './bg/i18n.js';
import { extTokenEmail, extTokenSrc, mayReplaceStoredToken, decodeJwtPayload } from './bg/ext-token-claims.js';
import { getConfig, getLastStatus, setStatus, getUsageHistory, authedFetch, getExtToken, setExtToken, setExtTokenNoDowngrade, markProvenIfStored, getOrCreateInstallId, isServerSyncPaused, TOKEN_RETRY_ALARM } from './bg/storage.js';
import { fetchClaudeApi } from './bg/api.js';
import { updateBadgeForSelectedOrg, resetIcon, updateBadgeError, refreshToolbarTip } from './bg/badge.js';
import { REC_SEEN_KEY, REC_NOTICE_KEY, recNoticeKey } from './bg/rec-notice.js';
import { clearUpgradeBlocked } from './bg/upgrade-gate.js';
import { SEND_CODE_REASON, sendCodeReasonFromThrown } from './bg/send-code-error.js';
import { scheduleWeeklyReport, sendWeeklyReport, logNotification, checkPromoPush, notifyAuthBlockedOnce, checkAuthBlockedLadder, AUTH_LADDER_LAST_STAGE, AUTH_LADDER_KEYS, flushNotifCounters, bumpNotifCounter, notifCategoryFromId, createCountedNotification } from './bg/notifications.js';
import {
  detectPlan, executePlanChange, cancelDowngrade, downgradeTo,
  acceptPlanOrder, reportPlanOrderResult, dismissRecommendationServer, muteRecommendationServer,
  setCollectAndSendRef,
} from './bg/plan.js';
import { collectAndSend as _collectAndSend, getLastActiveOrgId, reportSyncPauseState } from './bg/collect.js';
import { getCadence, isCollectionPaused, setCadenceChangeHandler } from './bg/cadence-config.js';
import { collectChatGPT } from './bg/collect-chatgpt.js';
import { getProviderState, displayableProviderError, snoozeProviderError, reportClaudeCollectSkipped } from './bg/provider-state.js';
import { collectGemini } from './bg/collect-gemini.js';
import { fetchRecommendations } from './bg/rec-fetch.js';
import { maybeSendInstallBeacon, maybeSendFirstGatedBeacon, beaconJitterMinutes } from './bg/install-beacon.js';
import { hasProviderPermission, registerChatGPTScripts, unregisterChatGPTScripts, injectChatGPTOpenTabs, registerGeminiScripts, unregisterGeminiScripts, injectGeminiOpenTabs, hasClaudeSession, mergeChatGPTOrgs, mergeGeminiOrgs, maybeCollectGeminiForTab } from './bg/providers.js';
import { getResetNotifContext, resolveResetWindow, scheduleExpireAlarms } from './bg/reset-alarms.js';
import { buildSidebarUsageData, pushSidebarUsage } from './bg/sidebar-usage.js';
import { AD_FLUSH_ALARM, incrementAdCounter, flushAdCounters, updateAdFlushAlarm } from './bg/ad-counters.js';

// Google OAuth **web** client id — the SAME one the dashboard uses (site/shared/auth.js) and the
// only audience the worker accepts (`aud !== GOOGLE_CLIENT_ID` → 401, utils/google-token.ts).
// launchWebAuthFlow lets an extension reuse a web client id, which is precisely why we use it
// instead of chrome.identity.getAuthToken — that one forces a Chrome-app client id and a second
// accepted audience on the server. Public value (it ships in dashboard JS), not a secret.
// 🔴 Requires `https://<extension-id>.chromiumapp.org/` in the client's authorized redirect URIs.
const GOOGLE_CLIENT_ID = '1073913781930-7r6v6nim1unn7so8s6jueap2a28eprla.apps.googleusercontent.com';


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
      // #1162 — SAY THAT WE SKIPPED. This branch is deliberately silent to the USER (that is the
      // whole point: a non-Claude user must not be shown "session expired"), and it was equally
      // silent to us: no attempt, no exception, so no `provider_collect_fail`, no failure
      // heartbeat, no `users.last_error_code`. A real Claude user who signs out long enough to
      // land here therefore disappears from every signal we have. Not awaited — telemetry must
      // not delay the ChatGPT/Gemini merges below (same rule as the failure reporter).
      reportClaudeCollectSkipped('no_session');
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
        // #1162 — THE MOMENT AN INSTALL GOES SILENT. Removing the Claude org makes `hasClaudeOrg`
        // false, which is one of the four conditions of `skipClaude` above — so from the next
        // cycle Claude is not attempted at all, and this transition is the last observable thing
        // that happens before the silence. Unthrottled: it only fires when a row was actually
        // removed, and each occurrence is one install entering that state.
        reportClaudeCollectSkipped('org_pruned');
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
    // 🔴 FIRST STATEMENT ON PURPOSE. Grandfather EXISTING users so login-first never breaks their
    // current server sync (many still sync via the api_key fallback). The gate now fails CLOSED
    // while this flag is unwritten (#785), so every await ahead of this line is a window in which
    // an existing user's collection is withheld. Only set when never set — a fresh install already
    // wrote `false` and must stay gated across future updates.
    const { serverSyncGrandfathered } = await chrome.storage.local.get(['serverSyncGrandfathered']);
    if (serverSyncGrandfathered === undefined) {
      await chrome.storage.local.set({ serverSyncGrandfathered: true });
    }
    // Backfill the proven-token marker from a token this install already holds. Without it, an
    // install that updates while holding a login-proven token carries no marker until its next
    // token write — and if the token dies first, its shared-key fallback stays silent.
    await markProvenIfStored();
    // An update is the ONLY fix for a 426 upgrade_required block, so drop it the instant one
    // lands — the badge and popup banner then clear without waiting for the next poll cycle.
    // Belt-and-braces, not the contract: bg/upgrade-gate.js keys the record on the ext version
    // and drops a stale one on read, so recovery does not depend on this listener firing.
    await clearUpgradeBlocked();
    const { intervalExplicitlySet } = await chrome.storage.sync.get(['intervalExplicitlySet']);
    if (intervalExplicitlySet === undefined) {
      await chrome.storage.sync.set({ intervalExplicitlySet: false });
      console.log('[Claude Tuner] Migration: intervalExplicitlySet initialized to false');
    }
  }
  // Open welcome page on fresh install (captures ref_source)
  if (details.reason === 'install') {
    // Phase 2 단계 4 login-first: a FRESH install is NOT grandfathered → its usage is shown
    // locally, but it does NOT send to the server via the shared api_key. Server sync (and the
    // ingest-token TOFU it would mint) is gated behind login. Existing users are grandfathered
    // in the 'update' branch so their fallback is never broken.
    // 🔴 Set this FIRST — before opening the welcome tab or ANY awaited work. An uninitialized
    // flag is now GATED, not allowed (bg/storage.js), so the risk this ordering guards has flipped:
    // it is no longer "a fast force_collect leaks an api_key POST", it is "a fast force_collect is
    // needlessly withheld and shows a login CTA to someone we were about to grandfather". Writing
    // first keeps both failure modes out of reach.
    // `installFirstSeenAt` rides the SAME set() as the gate flag rather than taking a write of its
    // own — this branch's whole ordering argument is that nothing awaited comes between the event
    // and that first write, and a second await would reopen the window the comment above closes.
    //
    // 🔴 NEVER BACKFILL THIS. It is written HERE, in the 'install' branch, and nowhere else — not
    // on 'update', not on startup, not lazily at first read. The obvious "improvement" is to stamp
    // installs that have no value the first time they run a build that has this key, and that
    // would date every one of the ~1,000 installs already gated to whenever they adopted this
    // release: a retention curve manufactured out of the rollout curve, wrong in the direction
    // that looks right. An ABSENT value is the honest answer and a load-bearing one — a NULL
    // `first_seen_at` in unverified_install_beacons is precisely what lets an analyst separate
    // pre-existing installs from genuinely new ones instead of averaging the two cohorts (#1122).
    await chrome.storage.local.set({
      serverSyncGrandfathered: false,
      installFirstSeenAt: new Date().toISOString(),
    });
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
    const { sidePanelAutoOpened } = await chrome.storage.local.get(['sidePanelAutoOpened']);
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

// THE answer to "which Tuner account does this install sync into". Every consumer must go
// through this — the dashboard's account-mismatch banner (GET_ACCOUNT_EMAIL) and its settings
// org selector (GET_COLLECTED_ORGS) compare the result against the account on screen, and if
// the two handlers could disagree, a dashboard would pass one guard while the other named a
// different account. The server does not verify org ownership when selected_orgs is saved
// (worker/src/routes/me.ts), so that guard is the only thing standing there.
//
// Priority: the ext_token's own `email` claim, because that IS the account the server files
// snapshots under. accountCache is the provider profile behind an 8-hour TTL — bg/collect.js now
// refreshes it when the observed address changes, but the token remains the more direct answer.
// Fall back to the cache and then the magic-link account only when there is no usable token
// (gated install, fresh install, or an expired one).
async function resolveSyncIdentity() {
  const { accountCache, independentAccount, extToken } = await chrome.storage.local.get({
    accountCache: null,
    independentAccount: null,
    extToken: null,
  });
  const email = extTokenEmail(extToken)
    || accountCache?.email
    || independentAccount?.email
    || null;
  // Display names are stored next to their own address; attach one only when it is actually the
  // name for `email`, never just because it happens to be cached.
  let name = '';
  if (email && email === accountCache?.email) name = accountCache.name || '';
  else if (email && email === independentAccount?.email) name = independentAccount.name || '';
  return { email, name };
}

// Handle messages from welcome page + dashboard login
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // Silent recovery from the dashboard: the page is signed in, mints an ext_token server-side
  // (POST /api/auth/ext-from-session) and hands it over. Zero clicks for the user — every other
  // recovery path we shipped needs them to notice something first, and none did (2026-07-27).
  //
  // 🔴 Three guards, all load-bearing:
  //  [1] ORIGIN. externally_connectable also allows *.claude-tuner-site-git.pages.dev — every PR
  //      preview. That is harmless for the read-only probes above, but a message that INSTALLS A
  //      CREDENTIAL must come from production only.
  //  [2] NO LOGIN-PROVEN TOKEN. This used to read "no existing token at all", which made the
  //      recovery near-useless: a shared-key TOFU mint already leaves an `ingest` token on most
  //      installs (measured 3,775 dashboard sign-ins vs 26 `full` tokens). An `ingest` token
  //      proves nothing, so it may be upgraded; a `full` or scope-less legacy one may not.
  //  [3] IDENTITY. Opening the dashboard as account A must never re-point an extension collecting
  //      for account B — the exact account-mismatch the dashboard elsewhere warns about, caused by
  //      us. Narrowing [2] does NOT weaken this: the server 409s on an alias-aware mismatch, and
  //      when it could not compare, resolveSyncIdentity() reads the email out of the very token
  //      being replaced.
  if (message && message.type === 'RECOVER_EXT_TOKEN') {
    (async () => {
      if (sender.origin !== 'https://claudetuner.com') {
        sendResponse({ success: false, error: 'origin_not_allowed' });
        return;
      }
      if (!message.ext_token || typeof message.ext_token !== 'string') {
        sendResponse({ success: false, error: 'missing_token' });
        return;
      }
      // [2] SCOPE. Not every stored token is a credential worth protecting. `ingest` can ONLY
      // originate from a shared-api_key TOFU mint — the server hands one to anybody who POSTs a
      // snapshot with an email, and only login mints `full` (snapshots.ts:986 and :995). So an
      // `ingest` token proves nothing about who is using this browser, and replacing it with a
      // login-proven one is strictly an upgrade.
      //
      // Refusing EVERY existing token (the previous rule) meant this recovery almost never fired:
      // collecting on the shared key already leaves a TOFU token behind, so most installs hold
      // one. That is the measured 3,775 dashboard sign-ins against 26 `full` tokens.
      //
      // 🔴 `full` — and legacy tokens with NO scope claim, which must be assumed login-minted —
      // still win. That preserves the property this gate exists for: a working authenticated
      // install can never be re-pointed at whatever account the dashboard happens to be showing.
      // Identity is still checked below; this only decides whose token may be REPLACED.
      const existing = await getExtToken();
      if (!mayReplaceStoredToken(existing)) {
        sendResponse({ success: false, error: 'already_authed' });
        return;
      }
      // [3] IDENTITY. Tokenless is not the same as identity-less: an install can be collecting
      // for account B on the shared api_key while the dashboard is open as A. Installing A's
      // token there does not merely mis-attribute — the server would 403 every B snapshot on the
      // email mismatch, so a partially-working install becomes a fully-broken one. Only accept a
      // token for the identity this install already believes it is (Codex review).
      // The SERVER already compared both addresses with alias resolution when it saw
      // `collecting_email`; trust that over a raw string compare, which rejects an alias of the
      // same person as a stranger (Codex re-review). This stays as the check for the case where
      // the page sent no identity at all.
      const local = message.identity_verified === true ? { email: null } : await resolveSyncIdentity();
      if (local.email && message.email && local.email.toLowerCase() !== String(message.email).toLowerCase()) {
        console.log('[Claude Tuner] recovery refused: dashboard account differs from the collecting one');
        sendResponse({ success: false, error: 'identity_mismatch' });
        return;
      }
      // 🔴 REPLACING a credential needs POSITIVE proof of the same person; filling an EMPTY slot
      // does not. The mismatch check above only fires on a CONTRADICTION, so "we could not tell"
      // sails through it — acceptable for a tokenless install ("no opinion yet"), wrong the moment
      // [2] let us overwrite something. The reachable hole: an EXPIRED ingest token is replaceable
      // (extTokenScope ignores expiry) but extTokenEmail() rejects it, so resolveSyncIdentity()
      // can return null with no accountCache either — and account B's token would land on an
      // install collecting for A, whose snapshots then 403 forever on the email mismatch. A
      // partly-working install becomes a dead one, which is precisely what guard [3] exists to
      // prevent. (Codex DEPLOY-BLOCKER — introduced by narrowing [2], not pre-existing.)
      //
      // This also disposes of the "stale per-account state" worry for the ORDINARY upgrade: it
      // changes only the scope of the token, so accountCache/selectedOrgId stay valid.
      // 🔴 THAT PREMISE DOES NOT HOLD FOR `identity_verified`. That flag exists precisely to let
      // the server say "the user confirmed this install belongs to someone else now", so per-
      // account state CAN go stale here and must be handled explicitly — see the link reset below.
      if (existing && message.identity_verified !== true && !local.email) {
        console.log('[Claude Tuner] recovery refused: cannot confirm the replaced token belongs to this account');
        sendResponse({ success: false, error: 'identity_unknown' });
        return;
      }
      // #1109 — REMEMBER WHAT THIS INSTALL IS BEING MOVED AWAY FROM, BEFORE THE MOVE.
      //
      // `dash_claim` is the only src that means "the labels differed and a human confirmed the
      // take" (worker/src/utils/ext-token.ts), i.e. the one handoff that re-points a working
      // install at a DIFFERENT account. The popup's switch-back entry point has to name the account
      // it would return to, and after the next four lines nothing in storage still knows it: the
      // token is replaced here and `independentAccount` is overwritten with the receiver below.
      // So it is recorded first, or not at all.
      //
      // Its own resolveSyncIdentity() call rather than `local`: that one is deliberately blanked
      // for an identity_verified handoff — which is exactly the confirmed-claim case — so reading
      // it would record nothing for the population this exists for. Kept inside the `dash_claim`
      // branch so the ordinary upgrade path pays for no extra storage read.
      if (extTokenSrc(message.ext_token) === 'dash_claim') {
        const prev = (await resolveSyncIdentity()).email;
        const receiver = String(message.email || extTokenEmail(message.ext_token) || '');
        // Written even when we cannot answer (removed), never left stale: a later claim that
        // resolves no previous identity must not inherit an older claim's answer and put a wrong
        // address in front of the user.
        if (prev && receiver && prev.toLowerCase() !== receiver.toLowerCase()) {
          await chrome.storage.local.set({ claimPrevAccount: { email: prev, at: Date.now() } });
        } else {
          await chrome.storage.local.remove('claimPrevAccount');
        }
      }
      // Canonical writer, not a raw set(): it is the one choke point that ends a token-withheld
      // retry episode (clears TOKEN_RETRY_KEY) and refuses a full→ingest downgrade. Its own comment
      // already claims to cover "dashboard recovery" — this path was quietly bypassing it.
      await setExtTokenNoDowngrade(message.ext_token);
      if (message.email) {
        await chrome.storage.local.set({ independentAccount: { email: message.email, name: message.name || '' } });
      }
      // 🔴 A local claudeAliasLink OUTRANKS the token when Claude snapshots pick their identity
      // (bg/storage.js pickIngestIdentity: linkedCanonical || tokenEmail). It is cleared only by
      // a same-device unlink, so a server-side unlink — dashboard Settings, or account deletion —
      // leaves it orphaned here. Combine that with an identity-changing mint and every Claude POST
      // carries the OLD canonical address under the NEW token: 403 email mismatch, Claude sync
      // dead, right after the user clicked to confirm. The mint is the newer authenticated
      // statement about who this install is, so a link that disagrees with it is stale by
      // definition. ChatGPT/Gemini never consult the link and are unaffected.
      if (message.email) {
        const { claudeAliasLink = null } = await chrome.storage.local.get({ claudeAliasLink: null });
        if (claudeAliasLink?.canonicalEmail
            && String(claudeAliasLink.canonicalEmail).toLowerCase() !== String(message.email).toLowerCase()) {
          await chrome.storage.local.remove('claudeAliasLink');
          console.log('[Claude Tuner] stale claudeAliasLink cleared: it named a different canonical account than the new token');
        }
      }
      await chrome.storage.local.remove(['showLoginPrompt', 'needsFullLogin', 'authBlocked']);
      console.log('[Claude Tuner] ext_token recovered from dashboard session');
      // Collect right away so the dashboard the user is looking at stops being stale.
      collectAndSend({ force: true }).catch(() => {});
      sendResponse({ success: true });
    })();
    return true; // async sendResponse
  }

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

  // Would a RECOVER_EXT_TOKEN handoff be accepted right now? Read-only, mints nothing, and
  // deliberately reports ONLY the token-scope question — identity and origin are still decided by
  // the handoff itself, so a "yes" here is not permission to bind anything.
  //
  // Why the dashboard needs to ask FIRST: the handoff costs a Worker request that reads D1 and
  // signs a JWT, and most installs already hold a `full` token and would refuse the result. Firing
  // it on every dashboard page view to find that out would be a self-inflicted load problem.
  //
  // 🔴 A separate message type rather than a field on GET_INFO: GET_INFO answers synchronously and
  // is used as the extension-presence probe, so making it await storage would change the timing of
  // the one call every dashboard load already depends on. An older extension simply has no handler
  // here — the caller treats "no answer" as "unknown" and falls back to its own gate.
  if (message && message.type === 'CAN_ACCEPT_EXT_TOKEN') {
    (async () => {
      try {
        sendResponse({ canAccept: mayReplaceStoredToken(await getExtToken()) });
      } catch {
        sendResponse({ canAccept: false });   // unreadable storage → assume not replaceable
      }
    })();
    return true;                              // async response
  }

  // Get the Tuner account this install syncs INTO (read-only, no token minted — unlike
  // GET_CLAUDE_LOGIN). The dashboard uses this to detect an account mismatch: when its
  // signed-in account differs from the one the extension feeds, it can point the user to the
  // right account instead of showing a misleading "collection stopped" / "no data" banner.
  //
  // The ext_token's own `email` claim is the authority, NOT accountCache. accountCache is the
  // provider profile behind an 8-hour TTL that is only refreshed on force/expiry or an org-uuid
  // change (bg/collect.js) — and changing your provider account email changes neither. So right
  // after the migration this feature exists to explain (server re-mints the token against the
  // new address), accountCache still names the OLD account, and reporting it made the dashboard
  // conclude "same account" and clear the very warning it was supposed to raise.
  // Fall back to accountCache / independentAccount when there is no token yet (gated or fresh
  // install), where they are the best available answer.
  if (message && message.type === 'GET_ACCOUNT_EMAIL') {
    (async () => {
      try {
        const { email, name } = await resolveSyncIdentity();
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
      // Per-provider collection state (#852). Carried INSIDE each provider object, not as a
      // sibling field: every existing reader — the welcome checklist, site/shared/ext-detect.js,
      // site/shared/provider-connect.js — reaches for `providers[key]`, so a top-level `lastError`
      // would be dropped on the floor by all of them (Codex review).
      //
      // `lastError` is what is worth SHOWING, not merely what is stored: displayableProviderError()
      // applies the same staleness rule the popup uses, so the popup and the dashboard cannot
      // disagree about whether a provider is currently broken.
      const { collectChatGPT: cgEnabled = true, collectGemini: gmEnabled = true } =
        await chrome.storage.sync.get({ collectChatGPT: true, collectGemini: true });
      const pstate = await getProviderState();
      // Same rule as the popup (#1136): a paused install reports no SEND failure, because it was
      // asked to stop sending. This is what the dashboard reads, so both surfaces stay in step —
      // otherwise the popup would go quiet while claudetuner.com kept accusing the save path.
      const syncPaused = await isServerSyncPaused();
      const provInfo = (key, hasPermission, enabled) => {
        const st = pstate[key] || {};
        const err = displayableProviderError(st, undefined, syncPaused);
        return {
          collected: collectedBy(key),
          hasPermission,
          enabled,
          lastError: err ? err.code : null,
          lastErrorAt: err ? err.at : null,
          lastSuccessAt: st.lastSuccessAt || null,
          lastAttemptAt: st.lastAttemptAt || null,
        };
      };
      const providers = {
        claude: { collected: collectedBy('claude') || !!status?.success, hasPermission: true, enabled: true },
        chatgpt: provInfo('chatgpt', chatgptPerm, cgEnabled !== false),
        gemini: provInfo('gemini', geminiPerm, gmEnabled !== false),
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

  // Return every org the extension has locally detected (Claude + ChatGPT + Gemini),
  // read-only. The dashboard's "active orgs" selector uses this so a user can pick a
  // provider org the SERVER hasn't ingested yet — e.g. one being dropped at the 3-org
  // cap, which otherwise never appears server-side (deadlock). The extension is the
  // ground truth for "which orgs this account has"; the server only knows what it
  // ingested (minus the cap filter). Returns a minimal shape (no usage) — the selector
  // only needs identity + label. Degrades gracefully: an older extension without this
  // handler simply doesn't respond and the dashboard falls back to server data.
  if (message && message.type === 'GET_COLLECTED_ORGS') {
    (async () => {
      try {
        const { collectedOrgs = [] } = await chrome.storage.local.get({ collectedOrgs: [] });
        const orgs = (collectedOrgs || [])
          .filter(o => o && o.uuid)
          .map(o => ({ provider: o.provider || 'claude', uuid: o.uuid, name: o.name || '', plan: o.plan || '' }));
        // The account this extension syncs into — the dashboard compares it to the displayed
        // account and only trusts these orgs when they match, so an admin viewing another user
        // (viewAs) or a switched/shared machine never injects the wrong user's orgs into the
        // settings selector. MUST be the same resolution GET_ACCOUNT_EMAIL uses: if the two
        // disagreed, a dashboard could pass one handler's guard while the other names a
        // different account, and the server does not check org ownership on save.
        const { email } = await resolveSyncIdentity();
        sendResponse({ success: true, orgs, email });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
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
  // Rides the once-per-browser-start event rather than a new one: it samples EVERY install,
  // unlike the ext_settings channel, which only reports for people engaged enough to open Settings
  // and hit save — the opposite of the population this question is about.
  // Detached on purpose: telemetry must not sit in front of the real startup work. Awaiting the two
  // probes inline placed them ahead of restoreSidePanelPreference() and the dynamic script
  // re-registration below, so a chrome API that never settled would take those down with it. (Codex.)
  void (async () => {
    // Backfill before reporting: authState() reads the token, and the marker should reflect a
    // proven token the install is holding right now — onInstalled('update') fires once, this fires
    // on every browser start, so together they close the transition window.
    await markProvenIfStored();
    sendGAEvent('extension_loaded', { pinned: await pinnedState(), auth: await authState() });
  })();
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
  await scheduleInstallBeacon();
  // #1122 — the EARLIEST gate observation, and for some installs the only one they ever produce.
  // scheduleInstallBeacon() above only ARMS the 12h alarm, whose first fire lands uniformly across
  // ~12h, so an install that converts sooner files nothing. The collection-path trigger closes that
  // for successful Claude collects only — NOT for provider-only installs (ChatGPT/Gemini never
  // reach that branch), installs whose Claude collect fails before it, or installs that convert
  // before any collection runs. setupAlarm() runs on install, update and startup, so hooking it
  // here reaches all of them. Self-gating and throttled internally (once per gate reason, ≥1h
  // apart): a no-op for logged-in installs, and it cannot repeat on every service-worker wake.
  await maybeSendFirstGatedBeacon();
  await updateAdFlushAlarm(); // periodic ad impression/click counter flush (design §5.4)
}

// Gated-install beacon alarm (#1122) — twice a day. Only a login-first / token-lost install ever
// sends anything; maybeSendInstallBeacon() returns immediately for everyone else, so the alarm can
// be scheduled unconditionally for the whole fleet.
const ALARM_INSTALL_BEACON = 'installBeacon';
const INSTALL_BEACON_PERIOD_MINUTES = 720; // 12h

// 🔴 A PER-INSTALL FIXED OFFSET, hashed from install_id — not scheduleRecFetch's Math.random().
// The two alarms answer different problems. The rec fetch only needs its FIRST fire de-synced, and
// once created it never reschedules, so a random phase is enough. This alarm is recreated whenever
// the alarm is missing (a fresh install, a CWS update, storage loss), and a fresh random draw each
// time re-clusters the fleet around the update window it is supposed to spread away from. A hash
// of the install id gives each install one permanent slot in the 12h period, stable across every
// service-worker restart.
async function scheduleInstallBeacon() {
  const existing = await chrome.alarms.get(ALARM_INSTALL_BEACON);
  if (existing) return; // already scheduled — recreating would reset its period
  const installId = await getOrCreateInstallId().catch(() => null);
  if (!installId) return; // no id → nothing to key the offset (or the payload) on; retry next start
  // +1 for the same reason TOKEN_RETRY_BASE_MS is a whole minute (bg/constants.js): Chrome clamps
  // sub-minute alarm delays, so an offset of 0 would not mean "now" anyway.
  const offsetMin = 1 + beaconJitterMinutes(installId, INSTALL_BEACON_PERIOD_MINUTES);
  chrome.alarms.create(ALARM_INSTALL_BEACON, {
    delayInMinutes: offsetMin,
    periodInMinutes: INSTALL_BEACON_PERIOD_MINUTES,
  });
  console.log(`[install-beacon] Alarm scheduled (offset ${offsetMin}m, then every 12h)`);
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

/**
 * Record the recommendation currently on offer as "seen", so its toolbar marker stops showing.
 * Never throws: an acknowledgement failing must not break opening the popup.
 */
async function markRecNoticeSeenFromStatus() {
  try {
    // 🔴 ACKNOWLEDGE WHAT THE MARKER IS SHOWING, NOT WHAT STORAGE HAPPENS TO HOLD (Codex). This
    // read used to be `lastStatus.recommendation`, and a concurrent writer — the rec-fetch alarm,
    // or a fire-and-forget POST response — can replace that between the panel opening and this
    // read resolving. Acknowledging the replacement marks a recommendation the user has never seen
    // as seen, and since the marker is keyed on identity that suppresses it PERMANENTLY.
    //
    // The derived key is what the icon is actually painted from, so acknowledging it can only ever
    // dismiss something that was on screen. Residual: if the marker changes in that same window
    // the user acknowledges the new one — but they are then looking at the new one, and the worst
    // case is one missed marker rather than a permanently silenced recommendation.
    const { [REC_NOTICE_KEY]: notice } = await chrome.storage.local.get({ [REC_NOTICE_KEY]: null });
    // Null means no recommendation is entitled to a marker — nothing to acknowledge, and writing
    // would be pointless storage churn on every panel open.
    if (notice) await chrome.storage.local.set({ [REC_SEEN_KEY]: notice });
  } catch (e) {
    // Never let an acknowledgement failure break opening the panel.
    console.warn('[Claude Tuner] rec notice ack failed:', e?.message);
  }
}

// === Toolbar tooltip: one subscription instead of N call sites (#994 unit 3) ===
// 🔴 The states behind the tooltip are written from many places — `pendingPlanOrder` from the
// collector, two accept paths and a reject path; `pinMoveServer` from the ingest response; the
// recommendation from the GET path, the POST path and the popup. Hanging a refresh off each is the
// drift trap this work keeps running into: the rule lands on all of them but one, and the miss is
// silent. Watching the keys instead cannot drift, because a writer that forgets to notify does not
// exist — writing IS the notification.
//
// `_toolbarTip` itself is deliberately NOT watched: it is what this handler writes, and watching it
// would loop.
const TOOLBAR_TIP_DEPS = ['pinMoveServer', 'pinMoveDismissedAt', 'pendingPlanOrder', '_recNotice'];
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (TOOLBAR_TIP_DEPS.some((k) => k in changes)) { refreshToolbarTip(); return; }
  // `lastStatus` churns on every collection, so refreshing on any change to it would put the
  // expensive rebuild back on the hot path. Only its RECOMMENDATION matters here — and comparing
  // identities costs nothing, because onChanged already handed us both values. This is also what
  // catches the popup clearing a recommendation after executing it, which writes no other key.
  if (changes.lastStatus) {
    const before = recNoticeKey(changes.lastStatus.oldValue?.recommendation);
    const after = recNoticeKey(changes.lastStatus.newValue?.recommendation);
    if (before !== after) refreshToolbarTip();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Wake-from-sleep retries (30s / 60s alarms)
  if (alarm.name.startsWith(WAKE_RETRY_ALARM)) {
    console.log(`[Claude Tuner] Wake retry alarm: ${alarm.name}`);
    const result = await collectAndSend().catch(() => null);
    if (result?.success) clearWakeRetries();
    return;
  }
  // Token-withheld fast retry (bg/storage.js noteTokenWithheld). The server answered 200 with no
  // ext_token on an api_key POST, so this install is still tokenless — re-POST now rather than
  // waiting a full cycle for a condition that is usually over in seconds.
  //
  // force:true is REQUIRED, not incidental: with flat usage the delta-gate would skip the send
  // entirely (send-gate.js shouldSendSnapshot) and the retry would produce no POST at all — and
  // therefore no chance at a token. It also bypasses the ALARM_NAME handler's `_lastServerPost`
  // 10-min floor, which is the whole point of retrying early.
  //
  // The ladder is armed only by noteTokenWithheld, which re-checks authBlocked/upgradeBlocked and
  // the login-first gate before scheduling. A retry that again comes back tokenless re-arms the
  // next rung from there; one that receives a token clears the record.
  if (alarm.name === TOKEN_RETRY_ALARM) {
    console.log('[Claude Tuner] Token-retry alarm — re-POSTing to obtain an ext_token');
    await collectAndSend({ force: true }).catch(() => null);
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
  // Gated-install beacon (#1122, twice a day). Self-gating: it returns immediately unless server
  // sync is being withheld, so this dispatch costs one storage read on an install that syncs
  // normally. Never throws — the module swallows its own failures.
  if (alarm.name === ALARM_INSTALL_BEACON) {
    // The module swallows its own send failures; this .catch() covers the one thing it cannot —
    // its first statement is the gate read (that ordering is the safety property, so it cannot sit
    // inside a try), and a rejected storage read there would otherwise reject this whole listener.
    await maybeSendInstallBeacon().catch((e) => console.warn('[install-beacon]', e && e.message));
    return;
  }
  // Ad counter flush (flushAdCounters already serializes through _adEnqueue).
  // Notification counters ride the SAME alarm rather than adding one of their own: both are
  // low-value-per-row telemetry, and a second alarm would double the wake-ups to say half as
  // much. Each flush serializes through its own op-chain, so they do not contend.
  if (alarm.name === AD_FLUSH_ALARM) {
    flushAdCounters();
    flushNotifCounters();
    return;
  }
  // Handle expire alarms (5min-before notification, 2min/1min/at-reset collection, post-reset notification)
  if (alarm.name.startsWith(ALARM_EXPIRE_PREFIX)) {
    console.log(`[Claude Tuner] Expire alarm fired: ${alarm.name}`);
    // Which limit this alarm is about — `claude-expire-<key>-<suffix>` (#1132).
    //
    // 🔴 It goes in the notification ID. Chrome REPLACES a notification whose id already exists,
    // so a stable id is the whole mechanism by which yesterday's "5h limit resetting soon" makes
    // way for today's. The previous `reset-soon-${Date.now()}` was unique every time, so nothing
    // ever replaced anything: 5h resets ~4.8×/day and each one fires notify5 + after, which is
    // ~70 undismissed toasts a week piling up in the OS notification centre. Measured over the 14
    // days to 2026-09-03: reset-soon 133,074 sends + reset-done 126,949 = 82.7% of ALL our
    // notifications, earning 808 clicks between them (0.31%).
    //
    // Per KEY, not per window: `7d`, `design` and `sonnet` are three different limits (and today
    // share one sentence — see #1133), so collapsing them onto one id would let one silently
    // replace another. Same key replacing itself is the only substitution that is always true.
    // 🔴 WHITELISTED AGAINST THE SCHEDULER'S OWN LIST, not merely shape-checked. A shape check
    // (`/^[a-z0-9]{1,12}$/`) accepts anything that looks like a key, so a stale `claude-expire-team-
    // after` alarm from another build would mint `reset-done-team` and show 7d-worded copy for a
    // limit this build cannot name (Codex FOLLOW-UP). An unknown key means we do not know which
    // limit it is about, and a notification we cannot word correctly is worse than none — the
    // collection below still runs.
    const rawKey = alarm.name.slice(ALARM_EXPIRE_PREFIX.length).replace(/-(?:notify5|pre1|after)$/, '');
    const resetKey = RESET_ALARM_KEYS.includes(rawKey) ? rawKey : null;

    // Notification 5 minutes before reset
    if (alarm.name.includes('-notify5')) {
      const { notifyResetSoon = true } = await chrome.storage.sync.get({ notifyResetSoon: true });
      const soonWin = resetKey ? await resolveResetWindow(resetKey) : null;
      if (notifyResetSoon && soonWin) {
        const win = soonWin.label;
        const ctxLabel = await getResetNotifContext();
        const usage = soonWin.util;
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
        createCountedNotification(`reset-soon-${resetKey}`, opts, 'reset-soon');
        logNotification('reset-soon');
      }
      return;
    }

    // Notification right after reset
    if (alarm.name.includes('-after')) {
      const { notifyResetDone = true } = await chrome.storage.sync.get({ notifyResetDone: true });
      const doneWin = resetKey ? await resolveResetWindow(resetKey) : null;
      if (notifyResetDone && doneWin) {
        const win = doneWin.label;
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
        createCountedNotification(`reset-done-${resetKey}`, opts, 'reset-done');
        logNotification('reset-done');
      }
    }

    await collectAndSend();
  }
});


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
    // 🔴 Opening the panel IS the acknowledgement (#994 unit 2). The recommendation marker is a
    // notification, not a state light: it says "there is something you have not looked at", so it
    // has to go out when they look. Stored against the recommendation's identity, not as a bare
    // boolean, so the NEXT recommendation can still speak — same contract #984 used for ★ moves.
    //
    // Marked BEFORE the collect below rather than after: that collect repaints the icon, and
    // marking afterwards would paint the marker and then clear the reason for it, leaving the
    // dot up until some later paint happened to run.
    // 🔴 AWAITED, AND BEFORE THE COLLECT. Not awaiting looks harmless — the acknowledgement is
    // "just" a storage write — but the collect below ends in updateBadge()→applyStateIcon(), which
    // reads the very key this writes. Losing that race leaves the marker up, and nothing repaints
    // again until the next alarm: up to an HOUR of a dot the user already dismissed by looking.
    // That teaches "this marker is a lie", which is the exact failure the transient design exists
    // to prevent. (The reverse race — acknowledging a recommendation the user never saw — cannot
    // happen here: this collect is skipServer, and the local-only path carries `recommendation`
    // over unchanged from the previous status. A NEW rec only ever arrives on a server response.)
    markRecNoticeSeenFromStatus()
      .then(() => collectAndSend({ skipServer: true }))
      .then((result) => sendResponse(result));
    return true;
  }
  // #1119 — the popup just paused or resumed server sync. Tell the server so its "collection
  // stopped" reminders (and the 6h disconnection mail, whose 3rd escalation goes to the ORG ADMIN)
  // stop treating a deliberate choice as a fault. Fire-and-forget: the hourly heartbeat carries the
  // same live value, so a lost report costs at most one cycle.
  if (message.type === 'SYNC_PAUSE_CHANGED') {
    reportSyncPauseState().then((ok) => sendResponse({ ok }));
    return true;
  }
  // The popup's × on a provider failure banner (#1130).
  //
  // 🔴 The WRITE happens here, not in the popup, even though the popup could import the same
  // function. `patch()` in bg/provider-state.js serializes read-modify-write on one storage key
  // with a module-level promise chain, and that is only sufficient because there is exactly ONE
  // writer — the service worker. A popup writing directly would be a second, uncoordinated writer
  // against a collector that patches the same key on every alarm tick: whichever side read first
  // would clobber the other's field, and the field most likely to be lost is the dismissal the
  // user just clicked — the banner would simply come back.
  if (message.type === 'SNOOZE_PROVIDER_ERROR') {
    snoozeProviderError(message.provider, message.code)
      .then((next) => sendResponse({ ok: !!next }))
      .catch(() => sendResponse({ ok: false }));
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
    dismissRecommendationServer()
      .then((r) => sendResponse({ success: true, dismiss: r }))
      .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
    return true;
  }
  if (message.type === 'MUTE_RECOMMENDATION') {
    muteRecommendationServer()
      .then((r) => sendResponse({ success: true, dismiss: r }))
      .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
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
  // Returns { plan: 'pro' | 'free' } from /api/users/entitlement. Cache is
  // scoped to the resolved account email and only trusted within a 24h TTL; on any
  // failure (or a different/expired account) it fails CLOSED to 'free' so a lapsed
  // or swapped account can never keep Pro-only capacity offline indefinitely.
  //
  // 🔴 THE ENDPOINT IS THE WHOLE FIX. This asked `/api/me` until 1.29.22, and that call could never
  // succeed: `/api/me` is behind the worker's googleAuthMiddleware, which accepts only a session or
  // Google credential, and this extension has no session token at all. So it 401'd on every attempt,
  // the fail-closed path below answered 'free', and the 24h cache never filled because it only
  // caches successes ⇒ `_plan` was permanently 'free'. A PAYING subscriber got free child/nesting
  // limits and "upgrade" prompts on subfolder/color/icon. Invisible only because the folders feature
  // sits behind a CDN flag that is still false.
  //
  // `/api/users/entitlement` is behind authMiddleware, which DOES accept our ext_token, and reports
  // the same billingSummary. Deliberately NOT `/api/folders`: that endpoint enforces Pro, so it
  // looks like it could answer this, but sync availability and entitlement are independent — it 404s
  // when FOLDER_SYNC_ENABLED=0 (saying nothing about Pro) and its 403 means either 'Pro required' or
  // 'Email mismatch', so its status cannot be read as an entitlement answer.
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
        const resp = await authedFetch(config, `${config.serverUrl}/api/users/entitlement`, {
          headers: { 'X-User-Email': email },
        });
        // Fail CLOSED on any server error: never serve a Pro plan we couldn't
        // confirm this call. (A fresh same-account cache is already returned by the
        // non-force path above, so reaching here means we have no trustworthy Pro.)
        if (!resp.ok) { sendResponse({ plan: 'free', stale: true }); return; }
        const data = await resp.json();
        // Flat billingSummary — NOT nested under `billing` like /api/me's payload was.
        const plan = data?.plan === 'pro' ? 'pro' : 'free';
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
      // Declared OUTSIDE the try so the catch can name the address that failed. A `const` inside
      // the try is block-scoped, and reading it from the catch is a ReferenceError — which would
      // replace the error being reported with a different one.
      let config;
      try {
        config = await getConfig();
        const resp = await fetch(`${config.serverUrl}/api/auth/magic-link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: message.email,
            purpose: message.purpose || 'login',
            lang: message.lang || 'en',
          }),
        });
        // Tolerate a non-JSON body: a bare `.json()` throws into the catch below, which would
        // report a server that ANSWERED as one that was never reached — the single distinction
        // this path exists to make (#1172). `null`, not `{}`, so "no parsable body" stays
        // tellable apart from "an object without the field".
        const data = await resp.json().catch(() => null);
        if (!resp.ok) {
          // `status` is what the caller classifies on: only the server knows the difference
          // between "we could not mail it" (503) and "you asked too often" (429), and the string
          // body alone never carried it.
          sendResponse({ success: false, status: resp.status, error: data?.error || 'server_error' });
          return;
        }
        // 🔴 A 2xx is NOT success — `{ sent: true }` is (worker/src/routes/auth.ts). Tolerating an
        // unparsable body without also pinning the success contract turns "200 + HTML from the
        // wrong host" into "Code sent", parking the user on a verify screen for a code nobody
        // sent. That host is not hypothetical: claudetuner.com answers 200 + HTML on every unknown
        // path, so a `serverUrl` missing the `api.` prefix lands exactly here.
        if (data?.sent !== true) {
          console.error('[Claude Tuner] magic-link: 2xx without the success contract', config?.serverUrl, resp.status);
          sendResponse({ success: false, status: resp.status, reason: SEND_CODE_REASON.BAD_RESPONSE });
          return;
        }
        sendResponse({ success: true, purpose: data.purpose });
      } catch (e) {
        // Logging is the point — this catch was silent, so a fetch that never left the browser
        // left the service worker console CLEAN, and every diagnosis started from "there is no
        // error in the console" and went looking for the fault somewhere else (#1172).
        // The reason is derived, not assumed: only a fetch that never completed is the network.
        // The server address goes HERE, not into the user-facing sentence: `server-url` is a
        // hidden input, so telling the user to check it names a control they do not have. The
        // person who can act on it is reading this console.
        console.error('[Claude Tuner] magic-link request failed:', config?.serverUrl, e);
        sendResponse({ success: false, reason: sendCodeReasonFromThrown(e), detail: e.message });
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
        const data = await resp.json().catch(() => null);
        if (!resp.ok) {
          sendResponse({ success: false, status: resp.status, error: data?.error || 'invalid_code' });
          return;
        }
        // 🔴 A 2xx with an unusable body must not fall through to setExtToken(undefined): that
        // stores a broken token and reads to every later check as a successful login. Both fields
        // are required because both are consumed — `email` becomes independentAccount.email, and a
        // missing one would silently register an account with no address. The success contract is
        // `{ ext_token, email, name }` (worker/src/routes/auth.ts).
        if (!data?.ext_token || !data.email) {
          console.error('[Claude Tuner] verify-code: 2xx without the success contract', config?.serverUrl, resp.status);
          sendResponse({ success: false, status: resp.status, reason: SEND_CODE_REASON.BAD_RESPONSE });
          return;
        }
        // Store independent account + login-proven ext_token (scope:'full'). This opens the
        // Phase 2 단계 4 server-sync gate (extToken now present) and clears the login CTA flags
        // so the popup/welcome nudge disappears and scope_insufficient degradation resets.
        // 🔴 setExtToken, NOT a raw set: it is the choke point that records
        // `everHadProvenToken` (and ends a token-withheld retry episode). Writing `extToken`
        // directly here meant a LOGIN-proven token left no trace, so a later token loss fell
        // back to the shared key silently — for exactly the population this is meant to protect
        // (Codex DEPLOY-BLOCKER).
        await setExtToken(data.ext_token);
        await chrome.storage.local.set({
          independentAccount: { email: data.email, name: data.name || '' },
        });
        // `authBlocked` too: a login IS the fix for the email-provider 401, so the CTA must go
        // now rather than waiting for the next accepted POST to clear it (bg/storage.js).
        await chrome.storage.local.remove(['showLoginPrompt', 'needsFullLogin', 'authBlocked']);
        sendResponse({ success: true, email: data.email, name: data.name });
      } catch (e) {
        // Same reason as the request path above: a silent catch here is why "the console is
        // clean" stopped meaning anything (#1172). ⚠️ This try also wraps the storage writes that
        // follow a successful verify, so the reason is derived rather than assumed — a failing
        // chrome.storage write is not the network and must not be described as one.
        console.error('[Claude Tuner] verify-code request failed:', e);
        sendResponse({ success: false, reason: sendCodeReasonFromThrown(e), detail: e.message });
      }
    })();
    return true;
  }

  // Google sign-in from the popup → ext_token('full'), the one-click twin of VERIFY_MAGIC_CODE.
  // The `identity` permission is OPTIONAL and requested by the popup (chrome.permissions.request
  // needs a user gesture, which a message handler does not have) — by the time we get here it is
  // already granted. Server counterpart: POST /api/auth/ext-google.
  if (message.type === 'GOOGLE_SIGNIN') {
    (async () => {
      try {
        const redirectUri = chrome.identity.getRedirectURL();
        // `nonce` is required for response_type=id_token, and it only guards anything if somebody
        // CHECKS it on the way back — see the comparison after the redirect. Until 2026-07-27 this
        // line claimed to be "our replay guard" while nothing anywhere read the claim: not here,
        // and not on the server (`verifyGoogleIdToken` checks `aud` + `email_verified` only, and
        // never sees this value). A guard that exists only in a comment is worse than none — the
        // next reader stops looking.
        const nonce = crypto.randomUUID();
        const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
          + `?client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}`
          + '&response_type=id_token'
          + `&redirect_uri=${encodeURIComponent(redirectUri)}`
          + `&scope=${encodeURIComponent('openid email profile')}`
          + `&nonce=${encodeURIComponent(nonce)}`
          + '&prompt=select_account';
        const redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
        if (!redirect) { sendResponse({ success: false, error: 'cancelled' }); return; }
        // id_token comes back in the URL FRAGMENT (implicit flow), never the query string.
        const idToken = new URLSearchParams(new URL(redirect).hash.slice(1)).get('id_token');
        if (!idToken) { sendResponse({ success: false, error: 'no_id_token' }); return; }

        // Bind the token to THIS request: Google echoes our nonce into the id_token, so one
        // minted for a different request cannot be substituted into this redirect.
        // 🔴 Scope of the guarantee, stated so nobody over-trusts it again — this reads an
        // UNVERIFIED payload client-side, so it stops substitution in this flow, NOT forgery.
        // Authenticity stays the server's job (signature + `aud` in verifyGoogleIdToken).
        if (decodeJwtPayload(idToken)?.nonce !== nonce) {
          console.warn('[Claude Tuner] Google sign-in: id_token nonce mismatch — refusing');
          sendResponse({ success: false, error: 'nonce_mismatch' });
          return;
        }

        const config = await getConfig();
        const resp = await fetch(`${config.serverUrl}/api/auth/ext-google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ google_token: idToken }),
        });
        const data = await resp.json();
        if (!resp.ok) { sendResponse({ success: false, error: data.error || 'signin_failed' }); return; }

        // 🔴 setExtToken, NOT a raw set: it is the choke point that records
        // `everHadProvenToken` (and ends a token-withheld retry episode). Writing `extToken`
        // directly here meant a LOGIN-proven token left no trace, so a later token loss fell
        // back to the shared key silently — for exactly the population this is meant to protect
        // (Codex DEPLOY-BLOCKER).
        await setExtToken(data.ext_token);
        await chrome.storage.local.set({
          independentAccount: { email: data.email, name: data.name || '' },
        });
        await chrome.storage.local.remove(['showLoginPrompt', 'needsFullLogin', 'authBlocked']);
        sendResponse({ success: true, email: data.email, name: data.name });
      } catch (e) {
        // launchWebAuthFlow rejects when the user closes the window — not an error worth surfacing
        // as a failure message beyond "cancelled".
        const msg = String(e?.message || e);
        sendResponse({ success: false, error: /closed|canceled|cancelled/i.test(msg) ? 'cancelled' : msg });
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
// Server-sync block → badge + one-time notification. Driven off the storage EDGE rather than
// polled: bg/storage.js sets `authBlocked` deep inside the POST path, and importing notifications
// there would close an import cycle (notifications.js already imports storage.js). onChanged also
// gives the once-per-episode semantics for free — it fires only on an actual value change, so a
// recovery followed by a fresh block notifies again while a steady block stays quiet.
// Catch-up for a block that started BEFORE this build: the edge listener below never fires for
// it, because the flag was already true. Runs on every service-worker wake; notifyAuthBlockedOnce
// is idempotent via its episode marker, so this costs one storage read.
(async () => {
  const { authBlocked } = await chrome.storage.local.get('authBlocked');
  if (authBlocked === true) await notifyAuthBlockedOnce();
  // Stages 2..4. Runs on every service-worker wake, which is what gives the ladder its clock —
  // there is no alarm for it, and it must keep advancing for a user who never opens the popup.
  await checkAuthBlockedLadder();
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.authBlocked) return;
  const { oldValue, newValue } = changes.authBlocked;
  if (newValue === true && oldValue !== true) {
    notifyAuthBlockedOnce();
    // Stamp the episode start on the EDGE, where the true start time is known. The wake catch-up
    // also stamps, but only with "now" — for a block that begins while the worker is alive, that
    // would be a later (wrong) date. Written unconditionally because this branch IS the transition.
    chrome.storage.local.set({ authBlockedSince: Date.now() });
    // Paint the badge now instead of waiting for the next collection tick — the whole point is
    // that this user may not look at the extension for hours.
    // 🔴 Through updateBadgeError(), not a raw setBadgeText (#994). The icon is now a
    // semantic channel: painting the `!` badge without the error icon leaves the NORMAL
    // icon next to an alarm badge, which reads as two states at once. Chrome persists the
    // icon across service-worker restarts, so a missed paint is permanent, not transient.
    updateBadgeError();
  } else if (oldValue === true && newValue !== true) {
    // Recovered (clearAuthBlocked removes the key → newValue undefined). Drop the alarm state
    // immediately; leaving a red '!' up until the next collection tick would read as "still
    // broken" right after the login that fixed it.
    resetIcon();
    chrome.action.setBadgeText({ text: '' });
    chrome.notifications.clear('auth-blocked');
    // Clear every follow-up still on screen too — leaving "you're missing 10 days of insights" up
    // after the login that fixed it is worse than never having sent it.
    for (let s = 2; s <= AUTH_LADDER_LAST_STAGE; s++) chrome.notifications.clear(`auth-blocked-r${s}`);
    // Drop the episode marker AND the whole ladder state so a FUTURE block starts from rung one.
    // 🔴 All four keys or none: a surviving `authBlockedStage` would silently skip straight to the
    // last rung of the next episode, and a surviving `authBlockedSince` would make it fire at once.
    chrome.storage.local.remove(AUTH_LADDER_KEYS);
  }
});

chrome.notifications.onClicked.addListener(async (notifId) => {
  // Counted BEFORE the promo-push filter below: a click on any notification is a click, and
  // gating the count on the one id this handler acts upon would report a 0% CTR for every other
  // category — the wrong number is worse than none, because it reads as "nobody engages".
  bumpNotifCounter(notifCategoryFromId(notifId), 'clk');
  if (!notifId.startsWith('promo-push-')) return;
  const promoId = notifId.replace('promo-push-', '');
  const { promoPushState = {} } = await chrome.storage.local.get({ promoPushState: {} });
  const url = promoPushState[promoId]?.url;
  if (url) chrome.tabs.create({ url });
  chrome.notifications.clear(notifId);
});

chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  // Same reasoning as onClicked: count every button click, whichever branch below handles it.
  // A button press and a body click are both "the user engaged", so they share one counter —
  // splitting them would need a dimension nobody has asked a question about yet.
  bumpNotifCounter(notifCategoryFromId(notifId), 'clk');
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
  // Server-sync blocked → put the user in front of the login CTA. Opened as a TAB, not via
  // chrome.action.openPopup(): that API is Chrome 127+ and throws when no window is focused,
  // which is exactly the state a notification click can arrive in. popup.html renders the same
  // CTA in a tab, so the simple path is also the reliable one.
  // Prefix, not equality: the follow-up ladder fires 'auth-blocked-r2'…'-r4' with the SAME Verify
  // button, and an exact match left those buttons dead — the one action the notification exists to
  // offer. (Codex.)
  if ((notifId === 'auth-blocked' || notifId.startsWith('auth-blocked-r')) && btnIdx === 0) {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
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
      // Accept → open the popup, do NOT execute here.
      //
      // This button used to call acceptPlanOrder() directly, which for an upgrade meant one click
      // on a Chrome notification put a charge on the user's card (upgrade_to_max bills on the spot
      // — inquiry #182, tracked as #820). A notification cannot host a confirmation step: its
      // buttons fire immediately and it cannot state the amount. So the button now does the only
      // safe thing it can, which is hand off to the surface that CAN confirm — the popup renders
      // the plan-order banner from `pendingPlanOrder` (still set) and its accept button goes
      // through the shared confirmation modal.
      //
      // Deliberately direction-agnostic: routing only upgrades would leave a branch where a
      // mislabelled or hierarchy-unknown plan silently takes the executing path. The notification
      // never changes a plan, full stop — that invariant is what the guard test asserts.
      chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
    } else {
      // Reject
      await reportPlanOrderResult(config, po.order_id, userEmail, 'rejected');
      await chrome.storage.local.set({ pendingPlanOrder: null });
    }
    chrome.notifications.clear(notifId);
    return;
  }
  // NOTIF_ID_OPTIMIZE deliberately has NO button handler. notifyPlanChange() (bg/plan.js) creates
  // that notification without `buttons`, so Chrome can never fire onButtonClicked for it — the
  // handler that used to live here (btnIdx 0 -> executePlanChange, btnIdx 1 -> dismiss) was
  // unreachable code holding a door open: adding a single button to that notification would have
  // silently turned it into a one-click plan upgrade, and an upgrade is billed by Anthropic on the
  // spot (inquiry #182). A RECOMMENDATION-driven plan change must go through the popup's
  // confirmation modal, the only surface that states the charge. (The plan-order branch above now
  // holds to the same rule: its Accept button opens the popup instead of executing — #820.)
  // Do not reintroduce a button handler here.
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


// Hook into storage changes to push sidebar updates after collection.
// Only trigger when Claude orgs actually changed — ChatGPT/Gemini merges
// should not cause sidebar/input to re-render on claude.ai.
// skipServer/boost and the withheld local-only path DO write collectedOrgs
// (bg/org-merge.js upserts there), so this listener fires for them too;
// collect.js also calls pushSidebarUsage() explicitly on those paths.
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


// Resolve circular dependency between bg/collect.js ↔ bg/plan.js: inject via setter
setCollectAndSendRef(collectAndSend);

// Reschedule BOTH the poll alarm and the ad-flush alarm immediately when the server
// changes the cadence (poll: collect floor / pause; flush: impression_flush_minutes)
// — without this the existing alarms keep their old period until an unrelated event
// fires the reschedule.
setCadenceChangeHandler(async () => { await updatePollAlarm(); await updateAdFlushAlarm(); });
