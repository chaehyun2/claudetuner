// ui/compare/summary-card.js — the 「요약·비교」 result as a full-width card under the columns
// (#1976 stage 2, plan docs/plans/compare-round-footer.md §3.2 / R10).
//
// DISPLAY ONLY. The summary's two turns (the folded request, the verdict) stay records of the judge
// column — `col.turns`, their `kind` / `round` / `summary` — so the history entry, the restore, the
// markdown export and the share snapshot read exactly what they read before. What changes is where
// their DOM is appended: column-thread.js asks summaryCardHost(col, turn) first, and a summary turn
// lands in a card's body instead of the column's (the same hook the debate uses for its timeline).
// A restored session draws its summaries through the same push functions, so they come back as cards.
//
// One card per summary request (its user turn opens one; the verdict that follows joins it). The
// newest card is open, older ones fold. A card whose turns were rolled back (a refused summary —
// port.js pops their roots) is dropped; one whose judge column is hidden hides with it; the column's
// reset (새 대화, a history load) takes its cards. The head names the judge and links its
// conversation (#1978 openLinkFor, OPEN_FROM_CARD) — the verdict is not in the judge column any more,
// so its 「열기 ↗」 is offered here too.
//
// Behind the round footer's flag (`compare_round_footer`): without it summaries stay in the column.
// See ui/compare/history.js for the ctx contract.

import { TURN_KIND_SUMMARY, PROVIDER_META, FOLLOW_AT_BOTTOM_PX, FOLLOW_ANCHOR_TOP_PX } from './constants.js';
import { OPEN_FROM_CARD } from './open-in-provider.js';

const CARD_FOLDED_CLASS = 'is-folded';

/** Installs the summary-card slice onto `ctx`. */
export function installSummaryCard(ctx) {
  const { state, t, el, raf } = ctx;
  let box = null;
  /** [{ node, body, head, judge, toggle, openSlot, col }] in creation order. */
  let cards = [];

  /** Built once, right after the columns (and the debate timeline) — so it sits above the docked composer. */
  function buildSummaryCards() {
    box = el('div', 'cmp-summary-cards');
    box.id = 'cmp-summary-cards';
    box.hidden = true;
    ctx.root.insertBefore(box, ctx.debateTimeline.nextSibling);
    ctx.summaryCardsBox = box;
  }

  const cardMode = () => !!(box && ctx.roundFooterOn() && !(ctx.debateActive && ctx.debateActive()) && !state.frozenDebate);

  function fold(card, folded) {
    card.node.classList.toggle(CARD_FOLDED_CLASS, folded);
    card.body.hidden = folded;
    card.toggle.textContent = t(folded ? 'summary_card_unfold' : 'summary_card_fold');
    card.toggle.setAttribute('aria-expanded', folded ? 'false' : 'true');
  }

  function makeCard(col) {
    const node = el('section', 'cmp-summary-card');
    node.setAttribute('aria-label', t('summary_badge'));
    const head = el('div', 'cmp-summary-card-head');
    head.appendChild(el('span', 'cmp-summary-badge', t('summary_badge')));
    const judge = el('span', 'cmp-summary-card-judge');
    head.appendChild(judge);
    const openSlot = el('span', 'cmp-summary-card-open');
    head.appendChild(openSlot);
    const toggle = el('button', 'cmp-summary-card-toggle');
    toggle.type = 'button';
    head.appendChild(toggle);
    const body = el('div', 'cmp-summary-card-body');
    body.id = `cmp-summary-card-${cards.length + 1}`;
    toggle.setAttribute('aria-controls', body.id);
    node.appendChild(head);
    node.appendChild(body);
    const card = { node, body, head, judge, toggle, openSlot, openUrl: null, col, answer: null, away: false, anchored: false };
    toggle.addEventListener('click', () => fold(card, !card.body.hidden));
    // The reader scrolled the card away from its end: the stream stops moving it (like a column's userScrolledUp).
    body.addEventListener('scroll', () => { const m = metrics(body); if (m) card.away = m.fromEnd > FOLLOW_AT_BOTTOM_PX && !card.anchored; });
    for (const older of cards) fold(older, true); // the newest verdict is the one open
    fold(card, false);
    cards.push(card);
    box.appendChild(node);
    box.hidden = false;
    paintCard(card);
    return card;
  }

  function metrics(node) {
    const { scrollTop, clientHeight, scrollHeight } = node;
    if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) return null;
    return { clientHeight, overflow: scrollHeight - clientHeight, fromEnd: scrollHeight - (scrollTop + clientHeight) };
  }
  /**
   * After a paint of the verdict streaming into a card (column-thread.js maybeFollowStream): follow
   * the end while it fits, anchor the verdict's start once it overflows (then the reader scrolls),
   * never move a card the reader scrolled — the column's rule, inside the card's own scroller.
   */
  function followSummaryCard(card, turn) {
    if (card.body.hidden || card.away || card.anchored) return;
    const m = metrics(card.body);
    if (!m) return;
    const node = turn.root;
    const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
    if (rect && rect.height > m.clientHeight - FOLLOW_ANCHOR_TOP_PX && m.overflow > FOLLOW_AT_BOTTOM_PX) {
      card.anchored = true;
      raf(() => { if (node.isConnected) card.body.scrollTop += node.getBoundingClientRect().top - card.body.getBoundingClientRect().top - FOLLOW_ANCHOR_TOP_PX; });
      return;
    }
    raf(() => { card.body.scrollTop = card.body.scrollHeight; });
  }

  /** The judge as the verdict names it: the model that SERVED the answer (an Auto column says which), else the column's own label. */
  function judgeLabel(card) {
    const m = card.answer && card.answer.model;
    const served = m && (m.label || m.id) ? String(m.label || m.id) : '';
    return served ? `${PROVIDER_META[card.col.provider].label} (${served})` : ctx.colLabel(card.col);
  }

  function paintCard(card) {
    const col = card.col;
    const label = t('summary_card_judge', judgeLabel(card));
    if (card.judge.textContent !== label) card.judge.textContent = label;
    // The judge's conversation link — rebuilt only when the URL changes (the continuation arrives at DONE).
    const a = ctx.openLinkFor ? ctx.openLinkFor(col.provider, col.continuation, OPEN_FROM_CARD) : null;
    const url = a ? a.getAttribute('href') : null;
    if (url !== card.openUrl) {
      card.openUrl = url;
      while (card.openSlot.firstChild) card.openSlot.removeChild(card.openSlot.firstChild);
      if (a) card.openSlot.appendChild(a);
    }
  }

  /**
   * Where a summary turn's DOM goes: a card's body, or null (the caller falls back to the column).
   * A request opens a new card; the verdict joins the card its request opened.
   */
  function summaryCardHost(col, turn) {
    if (!turn || turn.kind !== TURN_KIND_SUMMARY || !cardMode()) return null;
    let card = null;
    if (turn.role === 'assistant') {
      const last = col.turns[col.turns.length - 2]; // the turn pushed just before (the request)
      if (last && last.card && last.card.col === col) card = last.card;
    }
    if (!card) card = makeCard(col);
    turn.card = card;
    if (turn.role === 'assistant') card.answer = turn;
    return card.body;
  }

  /** The newest card of a judge column (startSummary reveals it), or null. */
  function latestSummaryCard(col) {
    for (let i = cards.length - 1; i >= 0; i--) if (cards[i].col === col && cards[i].node.parentNode) return cards[i].node;
    return null;
  }

  function dropCard(card) {
    if (card.node.parentNode) card.node.parentNode.removeChild(card.node);
  }

  /** A column's reset (새 대화 / a history load / a column reset): its cards go with its turns. */
  function dropSummaryCards(col) {
    const keep = [];
    for (const c of cards) { if (c.col === col) dropCard(c); else keep.push(c); }
    cards = keep;
    if (box) box.hidden = !cards.some((c) => !c.node.hidden);
  }

  /** Every pass of updateControls: rolled-back cards leave, a hidden judge hides its card, labels / links follow. */
  function syncSummaryCards() {
    if (!box) return;
    const keep = [];
    for (const c of cards) {
      if (!c.body.firstChild) { dropCard(c); continue; } // a refused summary: port.js removed its turns' roots
      keep.push(c);
      c.node.hidden = !!(c.col.node && c.col.node.hidden) || !!(ctx.debateActive && ctx.debateActive());
      paintCard(c);
    }
    cards = keep;
    box.hidden = !cards.some((c) => !c.node.hidden);
  }

  Object.assign(ctx, { buildSummaryCards, summaryCardHost, latestSummaryCard, dropSummaryCards, syncSummaryCards, followSummaryCard });
}
