// Providers whose collection sits behind an OPTIONAL host permission, and what granting one means.
// Shared by the SW (OPEN_PERMISSION_PAGE validates against it) and grant.html (requests it), so
// the page can never be asked for an origin the SW did not vouch for, and neither keeps a copy.
import { SITE_TAB_PATTERNS } from './constants.js';

export const GRANTABLE = Object.freeze({
  chatgpt: Object.freeze({ label: 'ChatGPT', origin: SITE_TAB_PATTERNS.chatgpt, syncKey: 'collectChatGPT' }),
  gemini: Object.freeze({ label: 'Gemini', origin: SITE_TAB_PATTERNS.gemini, syncKey: 'collectGemini' }),
});

export function isGrantable(provider) {
  return typeof provider === 'string' && Object.prototype.hasOwnProperty.call(GRANTABLE, provider);
}

export const GRANT_PAGE = 'grant.html';
