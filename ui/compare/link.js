// ui/compare/link.js — continuing a conversation the user pasted a link to (#1651).
//
// Pure functions only: no DOM, no port, no state object. What is here is the part that can be
// wrong in a way a test can see — which link this is, what is left of the composer once the link
// is taken out of it, whether the chip may appear at all, and which sentence a refusal gets.
//
// The transcript itself never reaches this file, or the page at all: the worker reads it and
// composes the send (bg/compare.js). The page holds a RECEIPT — provider, title, turn count —
// which is what the chip is made of.

import { LINK_ORIGINS, CODE_NOT_FOUND, CODE_PERMISSION_REFUSED, CODE_AUTH_REQUIRED, CODE_NO_TAB, CODE_UNSUPPORTED, CODE_BAD_REQUEST } from './constants.js';

/**
 * The conversation link in `text`, or null.
 *
 * 🔴 MATCHED BY ORIGIN, never by substring: `https://chatgpt.com.evil.test/c/…` contains
 * "chatgpt.com" and is not ChatGPT. The URL is parsed and its origin compared, which is also what
 * the worker does (`providerForLink`) — this copy exists so the chip can appear before anything is
 * sent, and the drift guard pins the two lists together.
 *
 * Only the path shapes that name a CONVERSATION count. `claude.ai/chats` is the list, not a chat;
 * offering to continue it would be an offer we cannot keep.
 *
 * @returns {{provider: string, url: string, start: number, end: number}|null}
 */
export function findLink(text) {
  if (typeof text !== 'string' || !text) return null;
  // A URL ends at whitespace; the surrounding prose is the user's question and stays.
  const re = /https?:\/\/[^\s<>"']+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0].replace(/[.,;:)\]}]+$/, '');   // trailing punctuation is the sentence's, not the URL's
    let u;
    try { u = new URL(raw); } catch { continue; }
    const provider = Object.hasOwn(LINK_ORIGINS, u.origin) ? LINK_ORIGINS[u.origin] : null;
    if (!provider || !isConversationPath(provider, u.pathname)) continue;
    return { provider, url: raw, start: m.index, end: m.index + raw.length };
  }
  return null;
}

/** Whether this provider's path names one conversation (the shapes the package accepts). */
function isConversationPath(provider, pathname) {
  if (provider === 'claude') return /^\/chat\/[0-9a-f-]{36}\/?$/i.test(pathname);
  if (provider === 'chatgpt') return /^\/(?:g\/[^/]+\/)?c\/[0-9a-f-]{36}\/?$/i.test(pathname);
  if (provider === 'gemini') return /^\/(?:app|u\/\d+\/app)\/[A-Za-z0-9_-]+\/?$/i.test(pathname);
  return false;
}

/**
 * The composer's text with the link taken out.
 *
 * The link is an instruction to the page, not part of the question — leaving it in would send the
 * URL to three models as if the user had asked about it. Whitespace either side collapses so
 * "이거 봐 <link> 어떻게 생각해?" does not become a double space.
 */
export function textWithoutLink(text, link) {
  if (!link) return text;
  const before = text.slice(0, link.start);
  const after = text.slice(link.end);
  return `${before}${after}`.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Whether a pasted link may be offered at all.
 *
 * 🔴 ONLY BEFORE THE FIRST ROUND. Mid-conversation the columns already hold their own threads, and
 * grafting somebody else's onto them would make every later turn ambiguous — the history entry
 * could not say which conversation a turn belonged to. A session that has started answers
 * questions; it does not change what it is.
 */
export function mayOfferLink(state) {
  return !state.sessionStarted && !state.sending && !state.disabled && !state.link && !state.linkReading;
}

/**
 * The sentence a refusal gets, as `{key, arg}` for `t()`.
 *
 * 🔴 Every code the worker can send has one, and an unknown code falls back to the generic line
 * rather than to nothing: a notice the page cannot fill is a notice the user never sees, and they
 * would be left with a chip that simply stopped.
 */
export function linkErrorText(code, provider) {
  const site = provider === 'claude' ? 'claude.ai' : provider === 'chatgpt' ? 'chatgpt.com' : 'gemini.google.com';
  switch (code) {
    case CODE_NOT_FOUND: return { key: 'link_err_not_found' };
    case CODE_PERMISSION_REFUSED: return { key: 'link_err_permission' };
    case CODE_AUTH_REQUIRED: return { key: 'link_err_auth', arg: site };
    case CODE_NO_TAB: return { key: 'link_err_no_tab', arg: site };
    case CODE_UNSUPPORTED: case CODE_BAD_REQUEST: return { key: 'link_err_unsupported' };
    default: return { key: 'link_err_generic' };
  }
}

/**
 * The chip's line for a link that has been read.
 *
 * A cut conversation says so HERE too, not only in the prompt: the user is the one who can decide
 * whether the missing beginning matters, and they can only decide it if they are told.
 */
export function linkChipText(link) {
  const name = link.provider === 'claude' ? 'Claude' : link.provider === 'chatgpt' ? 'ChatGPT' : 'Gemini';
  return link.truncated
    ? { key: 'link_ready_cut', args: [name, link.turns] }
    : { key: 'link_ready', args: [name, link.turns] };
}
