// bg/debate-notify.js — the debate's Chrome notifications (#1971 §3.2, docs/plans/debate-background-run.md).
//
// A debate keeps running in a hidden tab; when it needs the user (a conclusion, the moderator's question,
// a stop) the page asks here — DEBATE_NOTIFY{kind, run[, provider]} — and only while its tab is hidden.
// The SW owns the notification because the page cannot name its own tab: `sender.tab` is the tab to bring
// back, which for the site shell (claudetuner.com framing compare.html) is the shell's tab, not a frame.
//
// 🔴 State only. The wording is fixed per kind here; the page sends no text, so neither the topic nor
// anyone's words can reach the OS notification centre, a lock screen or a shared screen.
//
// Ids are `debate-<kind>-<tabId>-<run>`: per kind (notifCategoryFromId → `debate-<kind>`, so sends and
// clicks land in one bucket per kind), per tab (a click focuses it; DEBATE_NOTIFY_CLEAR and a closed tab
// drop that tab's cards) and per run (the page's own once-per-kind-per-run rule names the same card).
import { DEBATE_NOTIFY_MSG, DEBATE_NOTIFY_CLEAR_MSG, DEBATE_NOTIFY_KINDS } from '../ui/compare/constants.js';
import { PROVIDER_LABELS } from './constants.js';

export const DEBATE_NOTIF_PREFIX = 'debate-';
const ID_RE = /^debate-([a-z]+)-(\d+)-(\d+)$/;
// The compare page is the only sender (the extension page itself, or framed by the site shell).
const COMPARE_PAGE_PATH = '/compare.html';

/** The id of one debate notification, or null for anything outside the contract. */
export function debateNotifId(kind, tabId, run) {
  if (!DEBATE_NOTIFY_KINDS.includes(kind) || !Number.isSafeInteger(tabId) || tabId < 0 || !Number.isSafeInteger(run) || run < 0) return null;
  return `${DEBATE_NOTIF_PREFIX}${kind}-${tabId}-${run}`;
}
/** `{ kind, tabId, run }` of a debate notification id, null for any other id. */
export function parseDebateNotifId(id) {
  const m = ID_RE.exec(String(id || ''));
  if (!m || !DEBATE_NOTIFY_KINDS.includes(m[1])) return null;
  return { kind: m[1], tabId: Number(m[2]), run: Number(m[3]) };
}

/**
 * The SW half. Injected: `chrome` (notifications · tabs · windows · runtime), `createCountedNotification`
 * and `logNotification` (bg/notifications.js — the telemetry chokepoints), `bt` (bg/i18n.js) and
 * `sendGAEvent`. Nothing here is awaited by a caller.
 */
export function createDebateNotifier(deps) {
  const { chrome, createCountedNotification, logNotification, bt, sendGAEvent } = deps;
  const fromComparePage = (sender) => {
    try {
      const u = new URL(String(sender && sender.url));
      return u.protocol === 'chrome-extension:' && u.host === chrome.runtime.id && u.pathname === COMPARE_PAGE_PATH;
    } catch { return false; }
  };
  // Per tab, bumped by every clear: a card whose wording was still being read when its tab was cleared (a new run,
  // the debate left) is dropped instead of appearing after the clear (Codex 1R #4).
  const generation = new Map();
  const genOf = (tabId) => generation.get(tabId) || 0;
  const ga = (name, params) => { try { Promise.resolve(sendGAEvent(name, params)).catch(() => {}); } catch { /* telemetry */ } };

  /** Every debate card of `tabId` (all of them with null) cleared. */
  function clearTab(tabId) {
    if (tabId !== null) generation.set(tabId, genOf(tabId) + 1);
    else generation.clear();
    try {
      chrome.notifications.getAll((all) => {
        for (const id of Object.keys(all || {})) {
          const p = parseDebateNotifId(id);
          if (p && (tabId === null || p.tabId === tabId)) chrome.notifications.clear(id);
        }
      });
    } catch { /* best effort */ }
  }

  async function show(kind, tabId, run, provider) {
    const id = debateNotifId(kind, tabId, run);
    if (!id) return;
    const gen = genOf(tabId);
    const label = PROVIDER_LABELS[provider] || '';
    const title = await bt(`debate_notif_${kind}_title`);
    const message = await bt(kind === 'usage' && label ? 'debate_notif_usage_msg_named' : `debate_notif_${kind}_msg`, label);
    if (genOf(tabId) !== gen) return; // the tab was cleared meanwhile
    const opts = { type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 1 };
    // The id is spelled out at the call so the telemetry guard reads its shape (test/notif-telemetry-guard.mjs).
    createCountedNotification(`debate-${kind}-${tabId}-${run}`, opts, `debate-${kind}`).then((ok) => { if (ok) ga('cmp_debate_notify', { kind }); });
    logNotification(`debate-${kind}`);
  }

  /** runtime.onMessage adapter: true when the message was one of ours (answered at once). */
  function handleMessage(message, sender, sendResponse) {
    if (!message || (message.type !== DEBATE_NOTIFY_MSG && message.type !== DEBATE_NOTIFY_CLEAR_MSG)) return false;
    const tabId = sender && sender.tab && Number.isSafeInteger(sender.tab.id) ? sender.tab.id : null;
    const ok = fromComparePage(sender) && tabId !== null;
    if (ok && message.type === DEBATE_NOTIFY_CLEAR_MSG) clearTab(tabId);
    else if (ok) show(message.kind, tabId, message.run, typeof message.provider === 'string' ? message.provider : '').catch(() => {});
    try { sendResponse({ ok }); } catch { /* page gone */ }
    return true;
  }

  /** notifications.onClicked: a debate card brings its tab (and window) forward. True when it was ours. */
  function handleClick(notifId) {
    const p = parseDebateNotifId(notifId);
    if (!p) return false;
    ga('cmp_debate_notify_click', { kind: p.kind });
    try {
      chrome.tabs.update(p.tabId, { active: true }, (tab) => {
        void chrome.runtime.lastError; // the tab is gone: nothing to focus
        if (tab && Number.isSafeInteger(tab.windowId)) chrome.windows.update(tab.windowId, { focused: true }, () => { void chrome.runtime.lastError; });
      });
    } catch { /* best effort */ }
    chrome.notifications.clear(notifId);
    return true;
  }

  return { handleMessage, handleClick, clearTab };
}
