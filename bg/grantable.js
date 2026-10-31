// Providers whose collection sits behind an OPTIONAL host permission, and what granting one means.
// Shared by the SW (OPEN_PERMISSION_PAGE validates against it) and grant.html (requests it), so
// the page can never be asked for an origin the SW did not vouch for, and neither keeps a copy.
import { SITE_TAB_PATTERNS } from './constants.js';

export const GRANTABLE = Object.freeze({
  chatgpt: Object.freeze({ label: 'ChatGPT', origin: SITE_TAB_PATTERNS.chatgpt, syncKey: 'collectChatGPT', notUsingKey: 'notUsingChatGPT' }),
  gemini: Object.freeze({ label: 'Gemini', origin: SITE_TAB_PATTERNS.gemini, syncKey: 'collectGemini', notUsingKey: 'notUsingGemini' }),
});

export function isGrantable(provider) {
  return typeof provider === 'string' && Object.prototype.hasOwnProperty.call(GRANTABLE, provider);
}

// "I don't use it" on the permission banner (#2628). 🔴 It writes ONLY its own mark, never the
// collect toggle: Settings stays the one writer of `collectX` (storage.sync has no compare-and-set,
// so a second writer of that key races Settings — three Codex rounds found three such races). The
// mark means "do not ask while access is missing"; with access granted it has no effect, because
// collection is decided by `collectX && permission` exactly as before.
export function notUsingPatch(providers) {
  return Object.fromEntries(providers.filter(isGrantable).map((p) => [GRANTABLE[p].notUsingKey, true]));
}

// storage.sync defaults for the two keys per provider that providerWanted() reads.
export const PROVIDER_PREF_DEFAULTS = Object.freeze(Object.fromEntries(
  Object.values(GRANTABLE).flatMap((g) => [[g.syncKey, true], [g.notUsingKey, false]])));

// Does the user want this provider? false = switched off in Settings, OR answered "I don't use it"
// while access is still missing. 🔴 `granted` matters: the mark only means "do not ask while access
// is missing" — once access exists (granted from any surface) collection runs on the Settings
// toggle, and hiding its errors or telling the dashboard "disabled" would contradict that (Codex).
// The one predicate for every "should we ask / complain about it" surface.
export function providerWanted(sync, provider, granted) {
  const g = GRANTABLE[provider];
  return !!g && sync?.[g.syncKey] !== false && (granted === true || sync?.[g.notUsingKey] !== true);
}

// GA `perm_banner_shown` (#2628): the denominator for `perm_banner_action`. Once per install per
// LOCAL day — the popup re-renders the banner on every open and account switch, so per-render
// counts would measure opens, not people. storage.local holds the last day sent.
export const PERM_BANNER_SHOWN_KEY = 'permBannerShownDay';
export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function permBannerShownDue(lastDay, today) {
  return lastDay !== today;
}

export const GRANT_PAGE = 'grant.html';
