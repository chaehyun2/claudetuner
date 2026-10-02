// ui/compare/open-in-provider.js — 「<서비스>에서 열기 ↗」 (#1978, docs/plans/compare-open-in-provider.md):
// opens the provider conversation a column actually used, in a new tab.
//
// Two surfaces, one computation (syncOpenButtons, run on every change of a column's turns or
// continuation — never decided once at settle: the first DONE sets `col.continuation` AFTER the turn
// settled, plan §3.1-3):
//   - under the column's LATEST settled answer (plan §8 decision 5) — never in a debate (its
//     conversations show the composed prompts, plan §3.3-5);
//   - the column head's service name (`col.nameLink`): the conversation once there is one, the
//     site's front page otherwise — and in a debate only once it has ENDED (§8 decision 3: a
//     conversation the debate may still write to would split under the user's typing).
//
// 🔑 A continuation on the column = a link that exists: the package hands none out for a
// conversation it will delete (incognito / unanswered / swept), and port.js keeps one only for a
// column of a kept PROVIDER (`keptFor(state.sessionSaveBy, col.provider)`, #1985). The share snapshot never carries it.
//
// conversationUrl() is pure and exported; another surface (the #1976 summary card) gets a ready link
// from ctx.openLinkFor(provider, continuation, OPEN_FROM_CARD).
// See ui/compare/history.js for the ctx contract.

import { PROVIDER_META } from './constants.js';

// The providers whose conversation is linked, and where their id sits in the continuation
// (vendor-ai/*-client.js getContinuation()). Gemini waits for #1953 (plan §8 decision 1): its
// continuation does not say which Google account (`/u/<n>/`) the conversation belongs to, and the
// bare `/app/<id>` opens the DEFAULT account — 「not found」 for anyone on a second account.
const CONVERSATION_LINKS = Object.freeze({
  claude: Object.freeze({ idKey: 'uuid', path: 'chat/' }),
  chatgpt: Object.freeze({ idKey: 'conversationId', path: 'c/' }),
});
// Strict on purpose (plan §8 decision 5): a provider that changes its id format loses the button
// quietly instead of us building a link we never verified.
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The provider conversation's URL for a column's continuation, or null (no button, the head keeps
 * the front page). The origin is PROVIDER_META's only and the id is inserted only after it matched
 * CONVERSATION_ID_RE — no input can steer the link to another host or path.
 */
export function conversationUrl(provider, continuation) {
  if (!Object.prototype.hasOwnProperty.call(CONVERSATION_LINKS, provider)) return null;
  if (!continuation || typeof continuation !== 'object') return null;
  const { idKey, path } = CONVERSATION_LINKS[provider];
  const id = continuation[idKey];
  if (typeof id !== 'string' || !CONVERSATION_ID_RE.test(id)) return null;
  return `${PROVIDER_META[provider].site}${path}${id.toLowerCase()}`;
}

// GA `open_in_provider.from` — where the click came from. One list: openLinkFor() refuses anything else.
export const OPEN_FROM_ANSWER = 'answer';
export const OPEN_FROM_HEAD = 'head';
export const OPEN_FROM_CARD = 'card';
export const OPEN_FROMS = Object.freeze([OPEN_FROM_ANSWER, OPEN_FROM_HEAD, OPEN_FROM_CARD]);

/** Installs the open-in-provider slice onto `ctx`. */
export function installOpenInProvider(ctx) {
  const { state, t, el, track } = ctx;

  /** The 「<서비스>에서 열기 ↗」 link without its target: new tab, no opener / referrer, GA `from`. */
  function openAnchor(provider, from) {
    const label = PROVIDER_META[provider].label;
    const a = el('a', 'cmp-turn-open');
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    a.appendChild(el('span', null, t('open_in_provider', label)));
    const arrow = el('span', 'cmp-ext-arrow', '↗');
    arrow.setAttribute('aria-hidden', 'true');
    a.appendChild(arrow);
    // The branch warning (plan §3.3-4) rides the title and the accessible name.
    a.title = t('open_in_provider_title', label);
    a.setAttribute('aria-label', `${t('open_in_provider', label)} — ${t('open_in_provider_title', label)}`);
    a.addEventListener('click', () => track('open_in_provider', { provider, from }));
    return a;
  }

  /** 「<서비스>에서 열기 ↗」 under one answer — hidden until syncOpenButtons picks it. */
  function openButton(col) {
    const a = openAnchor(col.provider, OPEN_FROM_ANSWER);
    a.hidden = true;
    return a;
  }

  /**
   * A ready 「<서비스>에서 열기 ↗」 link for another surface (the #1976 summary card: `from` =
   * OPEN_FROM_CARD) — the one way a slice gets a conversation link (compare-xss-guard allows href only
   * here). null when there is no conversation to open (no / unlinkable continuation, Gemini) or `from`
   * is not one of OPEN_FROMS. Static: the caller rebuilds it when the column's continuation changes.
   */
  function openLinkFor(provider, continuation, from) {
    if (!OPEN_FROMS.includes(from)) return null;
    const url = conversationUrl(provider, continuation);
    if (!url) return null;
    const a = openAnchor(provider, from);
    a.setAttribute('href', url);
    return a;
  }

  /** The column's latest answer that settled with words (an errored or streaming one carries no button). */
  function latestAnswer(col) {
    for (let i = col.turns.length - 1; i >= 0; i--) {
      const turn = col.turns[i];
      if (turn.role === 'assistant' && turn.settled && turn.text && !turn.errorText) return turn;
    }
    return null;
  }

  function syncHead(col, url) {
    const link = col.nameLink;
    if (!link) return;
    const label = PROVIDER_META[col.provider].label;
    const text = url ? t('open_provider_conversation', label) : t('open_provider_site', label);
    link.setAttribute('href', url || PROVIDER_META[col.provider].site);
    link.title = text;
    link.setAttribute('aria-label', text);
  }

  /** Every column's answer button and head link, from its turns and continuation as they are now. */
  function syncOpenButtons() {
    const debate = !!(ctx.debateActive && ctx.debateActive());
    const debateRunning = debate && !ctx.debateEnded();
    for (const col of state.columns.values()) {
      const url = conversationUrl(col.provider, col.continuation);
      const latest = !url || debate ? null : latestAnswer(col);
      for (const turn of col.turns) {
        if (!turn.openBtn) continue;
        turn.openBtn.hidden = turn !== latest;
        if (turn === latest) turn.openBtn.setAttribute('href', url);
      }
      syncHead(col, debateRunning ? null : url);
    }
  }

  Object.assign(ctx, { openButton, openLinkFor, syncOpenButtons });
}
