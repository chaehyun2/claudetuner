// ChatGPT/Gemini: permission check, content-script registration, and org merge.
// Moved verbatim out of background.js (#1126); only the `export` keywords and these imports are new.
import { updateBadgeForSelectedOrg } from './badge.js';
import { collectChatGPT } from './collect-chatgpt.js';
import { collectGemini } from './collect-gemini.js';
import { appendUsageHistory, reconcileProviderRecs } from './storage.js';

// Check if optional host permission is granted for a provider
export function hasProviderPermission(provider) {
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

export async function registerChatGPTScripts() {
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

export async function unregisterChatGPTScripts() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CHATGPT_INJECT.id] });
  } catch { /* not registered */ }
}

// Inject into already-open chatgpt.com tabs (registerContentScripts only affects
// future navigations) — covers permission-grant and extension update/reload.
export async function injectChatGPTOpenTabs() {
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

export async function registerGeminiScripts() {
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

export async function unregisterGeminiScripts() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [GEMINI_INJECT.id] });
  } catch { /* not registered */ }
}

// Inject into already-open gemini.google.com tabs (registerContentScripts only
// affects future navigations) — covers permission-grant and update/reload.
export async function injectGeminiOpenTabs() {
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
// Whether the user currently has a Claude.ai session (sessionKey cookie).
// Used to attempt Claude collection even for provider-first users who later
// sign in to Claude — without it, skipClaude would permanently skip Claude.
export async function hasClaudeSession() {
  try {
    const cookies = await chrome.cookies.getAll({ url: 'https://claude.ai' });
    return cookies.some((c) => c.name === 'sessionKey');
  } catch {
    return false;
  }
}

// Merge ChatGPT orgs into collectedOrgs storage (independent of Claude collection)
export async function mergeChatGPTOrgs(force = false, userManual = false) {
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
          // r5 = the 5h window's reset id. Without it a 5h boundary can only be inferred from the
          // value FALLING, and it does not always fall: the new window can already hold more than
          // the old one did by the time we next sample (49% -> reset -> 50%). Burn measured across
          // such a boundary then reads +1 instead of "this cycle is already at 50". Samples
          // written before this field exists simply lack it, and the shared projector falls back
          // to drop-detection for those, so a mixed history stays safe.
          p: org.plan, r7: org.resetsAt7d || null, r5: org.resetsAt5h || null, org: org.uuid,
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
export async function mergeGeminiOrgs(force = false, userManual = false) {
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
          // r5 = the 5h window's reset id. Without it a 5h boundary can only be inferred from the
          // value FALLING, and it does not always fall: the new window can already hold more than
          // the old one did by the time we next sample (49% -> reset -> 50%). Burn measured across
          // such a boundary then reads +1 instead of "this cycle is already at 50". Samples
          // written before this field exists simply lack it, and the shared projector falls back
          // to drop-detection for those, so a mixed history stays safe.
          p: org.plan, r7: org.resetsAt7d || null, r5: org.resetsAt5h || null, org: org.uuid,
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
export async function maybeCollectGeminiForTab() {
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
