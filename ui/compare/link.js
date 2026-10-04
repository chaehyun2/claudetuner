// ui/compare/link.js — continuing a conversation the user pasted a link to (#1651).
//
// Pure functions only: no DOM, no port, no state object. What is here is the part that can be
// wrong in a way a test can see — which link this is, what is left of the composer once the link
// is taken out of it, whether the chip may appear at all, and which sentence a refusal gets.
//
// The transcript itself never reaches this file, or the page at all: the worker reads it and
// composes the send (bg/compare.js). The page holds a RECEIPT — provider, title, turn count —
// which is what the chip is made of.

import { providerForUrl, conversationRef } from '../../vendor-ai/sites.js';
import { SHARE_SITE_ORIGIN, SHARE_LINK_PATH_RE, CODE_SHARE_DELETED, CODE_SHARE_PRIVATE, CODE_NOT_FOUND, CODE_PERMISSION_REFUSED, CODE_AUTH_REQUIRED, CODE_NO_TAB, CODE_UNSUPPORTED, CODE_BAD_REQUEST } from './constants.js';

/**
 * The conversation link in `text`, or null.
 *
 * 🔴 MATCHED BY ORIGIN, never by substring: `https://chatgpt.com.evil.test/c/…` contains
 * "chatgpt.com" and is not ChatGPT. Which provider (`providerForUrl`) and whether the path names
 * one of its conversations (`conversationRef`) are the vendored package's own rules — the ones the
 * client applies when it reads the link (#2054). A hand copy here offered a chip for
 * `gemini.google.com/app/notes` or a wrong-case Gemini path that the client then refused.
 *
 * Only the path shapes that name a CONVERSATION count. `claude.ai/chats` is the list, not a chat;
 * offering to continue it would be an offer we cannot keep.
 *
 * A Claude Tuner share page (`https://claudetuner.com/c/<22 base62>`, #1784 U4) is a link KIND of
 * its own: `{kind:'share', provider:null, id}` — nobody holds it as a conversation, so every column
 * is told it. The SW's `linkTarget` is the other half (the share probe pins the two).
 *
 * @returns {{kind: 'vendor'|'share', provider: string|null, id?: string, url: string, start: number, end: number}|null}
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
    if (u.origin === SHARE_SITE_ORIGIN) {
      const share = SHARE_LINK_PATH_RE.exec(u.pathname);
      if (share) return { kind: 'share', provider: null, id: share[1], url: raw, start: m.index, end: m.index + raw.length };
      continue;
    }
    const provider = providerForUrl(raw);
    if (!provider || conversationRef(provider, raw) === null) continue;
    return { kind: 'vendor', provider, url: raw, start: m.index, end: m.index + raw.length };
  }
  return null;
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
    // A share page (#1784 U4): deleted by the sharer / an operator, or a private one (U5).
    case CODE_SHARE_DELETED: return { key: 'link_err_share_deleted' };
    case CODE_SHARE_PRIVATE: return { key: 'link_err_share_private' };
    default: return { key: 'link_err_generic' };
  }
}

/**
 * The chip's line for a link that has been read.
 *
 * A cut conversation says so HERE too, not only in the prompt: the user is the one who can decide
 * whether the missing beginning matters, and they can only decide it if they are told.
 */
/** A share title in the chip — the chip is one line under the composer. */
const LINK_CHIP_TITLE_MAX = 40;
export function linkChipText(link) {
  // A share page: its title (the page names the conversation; a provider name would be wrong).
  if (link.kind === 'share') {
    const full = typeof link.title === 'string' ? link.title.trim() : '';
    const title = full.length > LINK_CHIP_TITLE_MAX ? `${full.slice(0, LINK_CHIP_TITLE_MAX - 1)}…` : full;
    return link.truncated ? { key: 'link_ready_share_cut', args: [title, link.turns] } : { key: 'link_ready_share', args: [title, link.turns] };
  }
  const name = link.provider === 'claude' ? 'Claude' : link.provider === 'chatgpt' ? 'ChatGPT' : 'Gemini';
  return link.truncated
    ? { key: 'link_ready_cut', args: [name, link.turns] }
    : { key: 'link_ready', args: [name, link.turns] };
}
