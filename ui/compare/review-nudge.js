// ui/compare/review-nudge.js — the Chrome Web Store review banner of mountComparePage() (#1966).
//
// A slim strip at the page's foot (above the footer line, below the composer — it covers nothing),
// offered right after a satisfying moment: a cross-check round where EVERY column asked answered
// (port.js ALL_DONE), or a 👍 on a debate's live conclusion (debate.js offerFeedback — not the
// conclusion alone, so the rating and the review are never asked at once, and never after a 👎).
// At most once per page load, and only when the shared gates say so (bg/review-nudge.js
// reviewNudgeDue — the popup's and the options page's rules, over the same `ct_review_nudge`).
// The sentence is the link (the reviews page, new tab); × dismisses. A click / dismiss goes to the
// service worker (REVIEW_NUDGE_MSG_TYPE), which writes the local state and PATCHes the server —
// this page holds no token. GA: the extension-wide review_nudge_* names with `source` only.
//
// See ui/compare/history.js for the ctx contract.

import { REVIEW_NUDGE_KEY, REVIEW_ACTION_CLICKED, REVIEW_ACTION_DISMISSED, REVIEW_EVENT_SHOWN, REVIEW_EVENT_CLICKED, REVIEW_EVENT_DISMISSED, REVIEW_NUDGE_MSG_TYPE, CWS_REVIEW_URL, reviewNudgeDue } from '../../bg/review-nudge.js';
import { sendMessage, storageGet } from './helpers.js';
import { USER_MOVE_EVENTS } from './constants.js';

// `source` of the GA events, and which copy the banner shows.
export const REVIEW_SOURCE_COMPARE = 'compare';
export const REVIEW_SOURCE_DEBATE = 'debate';
const REVIEW_COPY = Object.freeze({ [REVIEW_SOURCE_COMPARE]: 'review_nudge_compare', [REVIEW_SOURCE_DEBATE]: 'review_nudge_debate' });

/** Installs the review-banner slice onto `ctx`. */
export function installReviewNudge(ctx) {
  const { chrome, doc, state, t, clock, track, el, link } = ctx;
  const storage = ctx.localStorageArea;
  // Once per page load: set when a check STARTS (two moments in a row read storage once), cleared
  // again when the gates said no — a later moment may ask again.
  let offered = false;

  // What the user is looking at: the tab and the session. A moment is for THAT screen — if either changed while
  // the gates were read (the tab switched to 토론 right after ALL_DONE, a stored session opened), it is dropped.
  const scene = () => `${typeof ctx.debateMode === 'function' ? ctx.debateMode() : ''}|${state.sessionId || ''}`;

  /**
   * A satisfying moment happened (`source` = REVIEW_SOURCE_*): show the banner if the gates allow. `reveal` —
   * the moment was the user's own click (a 👍), so the banner is scrolled into view (ctx.revealNode), and then
   * `keepInView` (what that click opened — the banner takes its room from the scroller above it, which can push
   * it out of sight). A moment that comes on its own (a round's end) never scrolls. 🔴 Neither does one whose
   * answer came after the user moved the page themselves (Codex 2R: a slow storage read landed while they were
   * scrolled up reading, and dragged them back down) — the banner still shows, in place.
   */
  async function reviewMoment(source, { reveal = false, keepInView = null } = {}) {
    if (offered || !REVIEW_COPY[source] || !storage) return;
    offered = true;
    const asked = scene();
    let moved = false;
    const onMove = () => { moved = true; };
    if (reveal) for (const type of USER_MOVE_EVENTS) doc.addEventListener(type, onMove, true);
    let got;
    try {
      got = await storageGet(chrome, storage, { [REVIEW_NUDGE_KEY]: null, lastStatus: null });
    } finally {
      if (reveal) for (const type of USER_MOVE_EVENTS) doc.removeEventListener(type, onMove, true);
    }
    // A refused or stale moment does not spend the page's one.
    if (scene() !== asked || !got || !reviewNudgeDue(got[REVIEW_NUDGE_KEY], { now: clock.now(), snapshot: got.lastStatus?.snapshot || null })) { offered = false; return; }
    const box = render(source);
    if (reveal && !moved) { ctx.revealNode(box); if (keepInView) ctx.revealNode(keepInView); }
  }

  function render(source) {
    const box = el('div', 'cmp-review');
    box.id = 'cmp-review';
    box.setAttribute('role', 'note');
    const cta = link(CWS_REVIEW_URL, t(REVIEW_COPY[source]), 'cmp-review-link');
    const close = el('button', 'cmp-review-close', '×');
    close.type = 'button';
    close.title = t('review_nudge_dismiss');
    close.setAttribute('aria-label', t('review_nudge_dismiss'));
    box.appendChild(cta);
    box.appendChild(close);
    const settle = (action, event) => {
      if (box.parentNode) box.parentNode.removeChild(box);
      sendMessage(chrome, { type: REVIEW_NUDGE_MSG_TYPE, action });
      track(event, { source });
    };
    cta.addEventListener('click', () => settle(REVIEW_ACTION_CLICKED, REVIEW_EVENT_CLICKED));
    close.addEventListener('click', () => settle(REVIEW_ACTION_DISMISSED, REVIEW_EVENT_DISMISSED));
    // Above the footer line: the last thing on the page, under the docked composer.
    ctx.root.insertBefore(box, ctx.footer);
    track(REVIEW_EVENT_SHOWN, { source });
    return box;
  }

  /**
   * The footer's standing review link (right end of the footer line, both tabs). Unlike the banner it
   * is not gated — it is a footnote, always there, so it never interrupts. `source()` says which tab
   * it was clicked from (FOOTER_SOURCE suffix keeps it apart from the banner in GA). 🔑 A click is
   * GA only — it does NOT record `clicked` (2026-10-02 user decision): opening the store is not a
   * review, so the banner and the popup's / options' nudges keep asking.
   */
  function footerReviewLink(source) {
    const a = link(CWS_REVIEW_URL, t('review_footer'), 'cmp-footer-review');
    a.addEventListener('click', () => {
      track(REVIEW_EVENT_CLICKED, { source: `${source()}${FOOTER_SOURCE_SUFFIX}` });
    });
    return a;
  }

  Object.assign(ctx, { reviewMoment, footerReviewLink });
}

// GA `source` of a footer-link click: `compare_footer` / `debate_footer`.
export const FOOTER_SOURCE_SUFFIX = '_footer';
