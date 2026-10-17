// Update-time "what's new" page (#2427). No-account installs get it on any update (with a sign-in
// ask); signed-in installs only on a MAJOR update (first or second version digit — the user's rule:
// they already know the product), with a store-review ask when the review-nudge gates allow it.
//
// After an extension UPDATE, an install with no Tuner account that has not seen this page for 30
// days, and for which there is at least one new announcement in its language, is put in one of two
// arms (fixed per install): `show` (90%) opens /welcome/?mode=whatsnew, `holdout` (10%) opens
// nothing. A holdout lapses 14 days after it was drawn and is then treated like `show` (reported as
// `holdout_expired` so the analysis can tell it apart). Both arms get the same cooldown stamp and the
// same `whats_new_eligible` event, so the arms stay comparable; a later login reports
// `whats_new_login{arm}` once.
//
// The decision is pure (whatsNewPrecheck / whatsNewDecision / pickArm / armLabel) so it can be tested in node;
// chrome.* calls live only in the thin wrappers at the bottom.
import { SITE_URL, ANNOUNCEMENTS_URL } from './constants.js';
import { CWS_EXT_ID } from '../ui/compare/constants.js';
import { sendGAEvent } from './analytics.js';
import { reviewNudgeDue, REVIEW_NUDGE_KEY } from './review-nudge.js';

export const WN_SHOWN_AT_KEY = 'whatsNewShownAt';   // ms of the last eligible update (both arms)
export const WN_ARM_KEY = 'whatsNewArm';            // 'show' | 'holdout', written once
export const WN_ARM_AT_KEY = 'whatsNewArmAt';       // ms the arm was drawn (holdout expiry clock)
export const WN_OPTOUT_KEY = 'whatsNewOptOut';      // set by the page's "don't open this again"
export const WN_LOGIN_SENT_KEY = 'whatsNewLoginSent'; // whats_new_login already reported

// Stored arms are SHOW/HOLDOUT; HOLDOUT_EXPIRED is only a reporting label (see armLabel).
export const WN_ARMS = Object.freeze({ SHOW: 'show', HOLDOUT: 'holdout', HOLDOUT_EXPIRED: 'holdout_expired' });
const DAY_MS = 24 * 60 * 60 * 1000;
export const WN_HOLDOUT_RATE = 0.1;
export const WN_HOLDOUT_TTL_MS = 14 * DAY_MS;
export const WN_COOLDOWN_MS = 30 * DAY_MS;
// Short on purpose: a slow CDN must not leave a tab opening seconds after the update.
export const WN_FETCH_TIMEOUT_MS = 5000;
const WN_LANGS = ['ko', 'en'];
// Leading YYYY-MM-DD; a time suffix (e.g. a Notion datetime) is ignored.
const NOTICE_DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/;
const VERSION_RE = /^(\d+)\.(\d+)(?:\.\d+){0,2}$/;

// 1.55.22 → 1.56.0 (or 2.x) is major; 1.55.21 → 1.55.22 is not. Unknown/unparsable → false: a
// signed-in install never gets the tab on a guess.
export function isMajorUpdate(previousVersion, currentVersion) {
  const p = VERSION_RE.exec(String(previousVersion || ''));
  const c = VERSION_RE.exec(String(currentVersion || ''));
  if (!p || !c) return false;
  const [pMaj, pMin, cMaj, cMin] = [p[1], p[2], c[1], c[2]].map(Number);
  return cMaj > pMaj || (cMaj === pMaj && cMin > pMin);
}

// Same definition as `hasAccount` in ui/login-nudge.js (PR #2425): a token of any scope, or the
// magic-link/Google account record. Follow-up: once #2425 is merged, share one helper between the
// two instead of keeping this copy in step by hand.
export function hasAccount(s) {
  return !!(s && (s.extToken || s.independentAccount?.email));
}

// Explicit extension language wins; 'auto' falls back to the browser language (the popup's rule).
export function resolveWhatsNewLang(setting, browserLang) {
  if (WN_LANGS.includes(setting)) return setting;
  return String(browserLang || '').toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

// 'YYYY-MM-DD…' → UTC midnight ms of that day; anything else → NaN (never counts as new).
export function noticeDateMs(date) {
  const m = typeof date === 'string' ? NOTICE_DATE_RE.exec(date) : null;
  return m ? Date.parse(`${m[1]}T00:00:00Z`) : NaN;
}

function validMs(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// The checks that need no network. The wrapper runs this first so an install that can never be
// eligible (signed in, opted out, cooling down) does not fetch the feed at all.
export function whatsNewPrecheck({ storage, now, previousVersion, currentVersion }) {
  const s = storage || {};
  const acct = hasAccount(s);
  if (acct && !isMajorUpdate(previousVersion, currentVersion)) return { eligible: false, reason: 'account_not_major', acct };
  if (s[WN_OPTOUT_KEY] === true) return { eligible: false, reason: 'opted_out', acct };
  const shownAt = validMs(s[WN_SHOWN_AT_KEY]);
  if (shownAt !== null && now - shownAt < WN_COOLDOWN_MS) return { eligible: false, reason: 'cooldown', acct };
  return { eligible: true, reason: 'precheck_ok', acct };
}

// Full decision. `announcements` is the parsed feed, or null when it could not be loaded — which is
// NOT eligible: no tab is ever opened on a guess.
export function whatsNewDecision({ storage, announcements, lang, now, previousVersion, currentVersion }) {
  const pre = whatsNewPrecheck({ storage, now, previousVersion, currentVersion });
  if (!pre.eligible) return pre;
  if (!Array.isArray(announcements)) return { eligible: false, reason: 'no_feed', acct: pre.acct };
  // First time: only the last 30 days count, so an old install is not shown a year of notices.
  // ⚠️ The CDN feed itself only carries ACTIVE notices, and the worker archives a notice 7 days
  // after its date (worker/src/routes/announcements.ts archiveExpiredAnnouncements). So in practice
  // "new" means "published in the last ~7 days and after the last stamp" — narrower than 30 days,
  // in the safe direction (fewer tabs, never a wrong one). A 30-day window needs a feed that keeps
  // archived notices (worker follow-up, #2427).
  const since = validMs(storage[WN_SHOWN_AT_KEY]) ?? now - WN_COOLDOWN_MS;
  const fresh = announcements.some((n) => n && n.lang === lang && noticeDateMs(n.date) > since);
  if (!fresh) return { eligible: false, reason: 'no_new_notice', acct: pre.acct };
  return { eligible: true, reason: 'eligible', acct: pre.acct };
}

// Signed-in page only: ask for a store review when the SAME gates as every other review-nudge
// surface allow it (bg/review-nudge.js reviewNudgeDue — dismissals, snooze, install age, near-limit,
// already clicked). Never re-decided here; the page just follows rv=1.
export function whatsNewReviewAsk({ acct, storage, now }) {
  if (!acct) return false;
  const s = storage || {};
  return reviewNudgeDue(s[REVIEW_NUDGE_KEY], { now, snapshot: s.lastStatus?.snapshot || null });
}

function isStoredArm(v) {
  return v === WN_ARMS.SHOW || v === WN_ARMS.HOLDOUT;
}

// Arm is drawn once and then fixed for the install.
export function pickArm(existing, random) {
  if (isStoredArm(existing)) return existing;
  return random() < WN_HOLDOUT_RATE ? WN_ARMS.HOLDOUT : WN_ARMS.SHOW;
}

// The arm in effect at `now`. The stored value never changes; a holdout drawn 14+ days ago simply
// stops holding out, and is labelled `holdout_expired` so it is not counted as either pure arm.
export function armLabel(arm, armAt, now) {
  if (arm !== WN_ARMS.HOLDOUT) return arm;
  const at = validMs(armAt);
  return at !== null && now - at >= WN_HOLDOUT_TTL_MS ? WN_ARMS.HOLDOUT_EXPIRED : WN_ARMS.HOLDOUT;
}

// The account appears: `independentAccount` gains an email it did not have. Every login path
// writes it (verify-code, Google sign-in, and the dashboard/welcome RECOVER_EXT_TOKEN handoff,
// which sends `email` from site/shared/ext-detect.js).
export function accountAppeared(change) {
  return !!(change && change.newValue?.email && !change.oldValue?.email);
}

// Feed → array, or null on HTTP error, timeout, or a body that is not an array.
export async function fetchAnnouncements({ fetchImpl = fetch, timeoutMs = WN_FETCH_TIMEOUT_MS, now = Date.now() } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Hourly cache buster, same as the popup's read of this feed.
    const res = await fetchImpl(`${ANNOUNCEMENTS_URL}?t=${Math.floor(now / 3600000)}`, { signal: ctrl.signal });
    if (!res || !res.ok) return null;
    const body = await res.json();
    return Array.isArray(body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The welcome page URL, shared by the fresh-install tab and the what's-new tab. `params` go first
// (mode/v/ref), then the two install-time rules:
//  - `lang` only when the user EXPLICITLY set the extension language. On 'auto' the page
//    self-detects via navigator.language, the same signal the popup uses. (Not
//    chrome.i18n.getUILanguage(): Chrome's UI language can differ from navigator.language.)
//  - `ext` only for a non-store build. An unpacked (dev) build has its own id; without this the
//    page (it reads ?ext=, site/welcome/index.html) hands the sign-in token to the store id — a
//    disabled or absent extension — and login "fails" right after a correct code.
export async function buildWelcomeUrl(params = {}) {
  let explicitLang = null;
  try {
    const { lang } = await chrome.storage.sync.get({ lang: 'auto' });
    if (lang === 'ko' || lang === 'en') explicitLang = lang;
  } catch (e) { /* fall through with no param */ }
  const url = new URL('/welcome/', SITE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (explicitLang) url.searchParams.set('lang', explicitLang);
  if (chrome.runtime.id !== CWS_EXT_ID) url.searchParams.set('ext', chrome.runtime.id);
  return url.toString();
}

const STATE_KEYS = ['extToken', 'independentAccount', WN_SHOWN_AT_KEY, WN_ARM_KEY, WN_ARM_AT_KEY, WN_OPTOUT_KEY,
  REVIEW_NUDGE_KEY, 'lastStatus'];

// onInstalled('update') entry point. Callers must NOT await it inside the migration chain.
export async function runWhatsNewOnUpdate({ previousVersion = null, random = Math.random } = {}) {
  const currentVersion = chrome.runtime.getManifest().version;
  const first = await chrome.storage.local.get(STATE_KEYS);
  if (!whatsNewPrecheck({ storage: first, now: Date.now(), previousVersion, currentVersion }).eligible) return;
  const announcements = await fetchAnnouncements();
  if (!announcements) return;
  let setting = 'auto';
  try { ({ lang: setting } = await chrome.storage.sync.get({ lang: 'auto' })); } catch { /* auto */ }
  const browserLang = (typeof navigator !== 'undefined' && navigator.language)
    || chrome.i18n?.getUILanguage?.() || 'en';
  const lang = resolveWhatsNewLang(setting, browserLang);
  // Re-read: the user may have signed in or opted out while the feed was loading.
  const storage = await chrome.storage.local.get(STATE_KEYS);
  const now = Date.now();
  const decision = whatsNewDecision({ storage, announcements, lang, now, previousVersion, currentVersion });
  if (!decision.eligible) return;
  const acct = decision.acct === true;
  const rv = whatsNewReviewAsk({ acct, storage, now });
  const arm = pickArm(storage[WN_ARM_KEY], random);
  // The expiry clock starts when the arm is drawn and is never moved afterwards.
  const armAt = isStoredArm(storage[WN_ARM_KEY]) ? (validMs(storage[WN_ARM_AT_KEY]) ?? now) : now;
  // Stamp BEFORE the event and the tab, and identically for both arms: the holdout's cooldown
  // must run exactly like the shown arm's or the comparison is not like-for-like.
  await chrome.storage.local.set({ [WN_SHOWN_AT_KEY]: now, [WN_ARM_KEY]: arm, [WN_ARM_AT_KEY]: armAt });
  const label = armLabel(arm, armAt, now);
  sendGAEvent('whats_new_eligible', { arm: label, acct: acct ? 1 : 0, rv: rv ? 1 : 0 });
  if (label === WN_ARMS.HOLDOUT) return;
  // Page contract (site/welcome mode=whatsnew): acct=1 → no sign-in UI; rv=1 → the review card.
  const url = await buildWelcomeUrl({
    mode: 'whatsnew',
    v: currentVersion,
    ref: 'whats_new',
    ...(acct ? { acct: '1' } : {}),
    ...(rv ? { rv: '1' } : {}),
  });
  await chrome.tabs.create({ url });
}

// Login attribution: once per install, only for installs that were put in an arm. The in-flight
// promise collapses near-simultaneous storage events into one report; the flag covers later ones.
let _loginReport = null;
export function reportWhatsNewLogin() {
  if (!_loginReport) {
    _loginReport = (async () => {
      const s = await chrome.storage.local.get([WN_ARM_KEY, WN_ARM_AT_KEY, WN_LOGIN_SENT_KEY, WN_SHOWN_AT_KEY]);
      const arm = s[WN_ARM_KEY];
      if (!isStoredArm(arm) || s[WN_LOGIN_SENT_KEY] === true) return;
      await chrome.storage.local.set({ [WN_LOGIN_SENT_KEY]: true });
      const shownAt = validMs(s[WN_SHOWN_AT_KEY]);
      // Arm in effect at login time: a holdout that lapsed reports `holdout_expired`.
      const params = { arm: armLabel(arm, s[WN_ARM_AT_KEY], Date.now()) };
      if (shownAt !== null) params.days_since_shown = Math.max(0, Math.floor((Date.now() - shownAt) / DAY_MS));
      sendGAEvent('whats_new_login', params);
    })().finally(() => { _loginReport = null; });
  }
  return _loginReport;
}
