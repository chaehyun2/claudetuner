// ui/compare/activity.js — the ACTIVITY PANEL slice of mountComparePage() (compare.js): the
// <details> above an answer that shows the provider's process (thinking blocks, tool calls,
// results) from the SW's ACTIVITY events, its summary line, fold and settle. Bodies are exactly
// as they were in compare.js (test/mutants/compare-page.json anchors on them). The ctx contract
// is written up in history.js.

import { ACTIVITY_THINKING, ACTIVITY_TOOL_USE, ACTIVITY_TOOL_RESULT, ACTIVITY_TOOL_WEB_SEARCH, MS_PER_SECOND } from './constants.js';

/** Installs the activity-panel slice onto `ctx` (see ui/compare/history.js for the ctx contract). */
export function installActivity(ctx) {
  const { t, clock, raf, el } = ctx;
  // ── activity panel (the provider's process) ──
  /**
   * A <details> above the answer: summary line (title + counters) and a scrolling list of
   * entries keyed by the event id — a thinking block grows in place, a tool call turns from
   * 「검색 중…」 into its query, a result line names its count and top titles.
   */
  function makeActivityPanel() {
    const box = el('details', 'cmp-act');
    box.hidden = true;
    box.open = true;
    const summary = el('summary', 'cmp-act-summary');
    const title = el('span', 'cmp-act-title', t('act_title'));
    const meta = el('span', 'cmp-act-meta');
    summary.appendChild(title);
    summary.appendChild(meta);
    box.appendChild(summary);
    const list = el('div', 'cmp-act-list');
    box.appendChild(list);
    return { box, summary, meta, list, entries: new Map(), searches: 0, thinkingChars: 0, thinkingStart: null, thinkingEnd: null, folded: false, scrollPending: false };
  }
  /** Label for a tool call: the known web search by name, else the tool's own name. */
  const toolLabel = (name) => (name === ACTIVITY_TOOL_WEB_SEARCH ? t('act_web_search') : String(name || ''));
  function paintActivityMeta(a) {
    const parts = [];
    if (a.searches) parts.push(t('act_searches', a.searches));
    // Thinking time = first thinking event → the fold / settle (not the turn's age — Codex act 1R #5).
    if (a.thinkingChars && a.thinkingStart != null) {
      const secs = Math.floor(((a.thinkingEnd != null ? a.thinkingEnd : clock.now()) - a.thinkingStart) / MS_PER_SECOND);
      if (secs > 0) parts.push(t('act_thought_for', secs));
    }
    a.meta.textContent = parts.join(' · ');
  }
  function applyActivity(a, msg) {
    const kind = msg.kind;
    const id = `${kind}:${String(msg.id ?? '0')}`;
    const text = typeof msg.text === 'string' ? msg.text : '';
    let item = a.entries.get(id);
    if (!item) {
      item = el('div', `cmp-act-item is-${kind}`);
      const icon = el('span', 'cmp-act-icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = kind === ACTIVITY_THINKING ? '💭' : (kind === ACTIVITY_TOOL_USE ? '🔍' : (kind === ACTIVITY_TOOL_RESULT ? '📄' : '·'));
      item.appendChild(icon);
      const body = el('span', 'cmp-act-text');
      item.appendChild(body);
      item.body = body;
      item.kind = kind;
      a.entries.set(id, item);
      a.list.appendChild(item);
      if (kind === ACTIVITY_TOOL_USE) a.searches++;
    }
    if (kind === ACTIVITY_THINKING) {
      // Deltas append (the SW forwards the client's throttled slices); a final with text is the tail.
      // One text node per block (textContent grows), not one node per 150 ms slice.
      if (text) { item.body.textContent += text; a.thinkingChars += text.length; if (a.thinkingStart == null) a.thinkingStart = clock.now(); }
      if (msg.final === true) item.classList.add('is-final');
    } else if (kind === ACTIVITY_TOOL_USE) {
      const label = toolLabel(msg.name);
      item.label = label;
      item.body.textContent = msg.final === true && text ? `${label} · ${text}` : (msg.final === true ? label : `${label} · ${t('act_searching')}`);
      if (msg.final === true) item.classList.add('is-final');
    } else if (kind === ACTIVITY_TOOL_RESULT) {
      const n = typeof msg.count === 'number' ? msg.count : null;
      item.body.textContent = [n != null ? t('act_results', n) : toolLabel(msg.name), text].filter(Boolean).join(' · ');
      item.classList.add('is-final');
    } else {
      item.body.textContent = text;
      item.classList.add('is-final');
    }
    // A panel whose first event lands after the answer already started appears FOLDED (the fold
    // was recorded while it was hidden — Codex act 1R #1).
    if (a.box.hidden) { a.box.hidden = false; a.box.open = !a.folded; }
    paintActivityMeta(a);
    // The list follows its newest line — one layout read per frame, not per event (Codex act 1R #2).
    if (a.box.open && !a.scrollPending) { a.scrollPending = true; raf(() => { a.scrollPending = false; a.list.scrollTop = a.list.scrollHeight; }); }
  }
  /** First answer text (or DONE): the panel folds to its summary line — once; a user who reopened it keeps it open. */
  function foldActivity(turn, done = false) {
    const a = turn && turn.activity;
    if (!a) return;
    if (a.thinkingStart != null && a.thinkingEnd == null) a.thinkingEnd = clock.now();
    // Recorded even while hidden: a panel that shows up later opens folded (see applyActivity).
    if (!a.folded) { a.folded = true; if (!a.box.hidden) a.box.open = false; }
    if (!a.box.hidden) paintActivityMeta(a);
    if (done) settleActivity(turn);
  }
  /** The turn is over (DONE / ERROR / ALL_DONE): every entry still 「검색 중…」 settles so nothing pulses forever. */
  function settleActivity(turn) {
    const a = turn && turn.activity;
    if (!a || a.box.hidden) return;
    if (a.thinkingStart != null && a.thinkingEnd == null) a.thinkingEnd = clock.now();
    for (const item of a.entries.values()) {
      // A tool call that never reported its input reads as its bare label, not 「검색 중…」 (Codex act 1R #3).
      if (item.kind === ACTIVITY_TOOL_USE && !item.classList.contains('is-final') && item.label) item.body.textContent = item.label;
      item.classList.add('is-final');
    }
    a.box.classList.add('is-done');
    paintActivityMeta(a);
  }
  // Everything another file reaches (compare.js destructures the names it calls bare).
  Object.assign(ctx, {
    makeActivityPanel, toolLabel, paintActivityMeta, applyActivity, foldActivity, settleActivity,
  });
}
