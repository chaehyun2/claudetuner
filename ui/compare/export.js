// ui/compare/export.js — the copy / export slice of mountComparePage() (compare.js): the
// clipboard write with its execCommand fallback, the copy buttons and their 「복사됨」 feedback
// registry, and the markdown document of a column / the whole comparison (markdownFor). Also
// the column-list helpers every other slice reads (participatingColumns, allColumns, …).
// Bodies are exactly as they were in compare.js; ctx contract: see ui/compare/history.js.

import { PROVIDER_META, COPY_FEEDBACK_MS, SVG_NS, TURN_KIND_SUMMARY } from './constants.js';
import { modelOptionText } from './helpers.js';

/** Installs the export slice onto `ctx` (ctx contract: ui/compare/history.js header). */
export function installExport(ctx) {
  const { doc, t, state, clock, nav, track, el } = ctx;
  // ── copy to clipboard ──
  /**
   * Copy `text`: navigator.clipboard first, the execCommand textarea as the fallback (older
   * contexts, or the async API refusing because the document lost focus). Resolves true only
   * when one of them reported success; never throws (mini-dom has neither).
   */
  async function copyText(text) {
    try {
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') { await nav.clipboard.writeText(text); return true; }
    } catch { /* denied / no focus → try the legacy path */ }
    if (typeof doc.execCommand !== 'function') return false;
    // Selecting the scratch textarea steals focus (and a text control's selection) from wherever
    // the user was — a half-typed follow-up, say. Remember it, put it back afterwards (Codex 1R #3).
    const active = doc.activeElement || null;
    const hadSelection = !!active && typeof active.selectionStart === 'number' && typeof active.setSelectionRange === 'function';
    const selStart = hadSelection ? active.selectionStart : 0;
    const selEnd = hadSelection ? active.selectionEnd : 0;
    const ta = el('textarea', 'cmp-clip');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(ta);
    let copied = false;
    try {
      if (typeof ta.select === 'function') ta.select();
      copied = !!doc.execCommand('copy');
    } catch { copied = false; } finally {
      ta.remove();
      if (active && active !== doc.body && typeof active.focus === 'function') {
        focusQuietly(active);
        if (hadSelection) { try { active.setSelectionRange(selStart, selEnd); } catch { /* not a text control any more */ } }
      }
    }
    return copied;
  }
  /** focus() without scrolling the page to the element; plain focus() where the option is unsupported; never throws. */
  function focusQuietly(node) {
    try { node.focus({ preventScroll: true }); } catch { try { node.focus(); } catch { /* not focusable */ } }
  }
  /** The copy glyph (two offset squares) — built with createElementNS; no markup string anywhere. */
  function copyIcon() {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linejoin', 'round');
    const back = doc.createElementNS(SVG_NS, 'rect');
    back.setAttribute('x', '5.5'); back.setAttribute('y', '5.5'); back.setAttribute('width', '8'); back.setAttribute('height', '8'); back.setAttribute('rx', '1.5');
    const front = doc.createElementNS(SVG_NS, 'path');
    front.setAttribute('d', 'M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2');
    svg.appendChild(back);
    svg.appendChild(front);
    return svg;
  }
  /**
   * A ghost icon button that copies whatever `getText()` returns at click time — the RAW text of a
   * turn (`turn.text`, markdown source), never the rendered DOM. Success shows 「복사됨」 for
   * COPY_FEEDBACK_MS; a failed copy leaves the button as it was (nothing to undo, nothing to say).
   */
  // Every copy button whose 「복사됨」 feedback is showing, with the timer that ends it — so a reset
  // (새 대화 / coming-soon) can end them all at once instead of letting a timer fire into the next
  // session (the question's button survives the reset and would keep saying 복사됨). `copyEpoch`
  // is bumped by those resets: a clipboard promise that resolves afterwards belongs to a session
  // that no longer exists and must show nothing (Codex 1R #5).
  const copyFeedback = new Map(); // btn → { timer, revert }
  let copyEpoch = 0;
  function clearCopyFeedback() {
    copyEpoch++;
    for (const { timer, revert } of copyFeedback.values()) { clock.clearTimeout(timer); revert(); }
    copyFeedback.clear();
  }
  /**
   * Wire `btn` to copy `getText()` on click with the shared feedback rules; `paint(copied)` draws
   * the button's two states (the icon button and the topbar 「전체 복사」 look different, the
   * timing / registry / epoch rules are one).
   */
  function attachCopy(btn, getText, paint, kind, provider) {
    const revert = () => { copyFeedback.delete(btn); btn.classList.remove('is-copied'); paint(false); };
    btn.addEventListener('click', async () => {
      const text = String(getText() || '');
      if (!text) return;
      track('copy', provider ? { kind, provider } : { kind });
      const epoch = copyEpoch;
      const copied = await copyText(text);
      if (!copied || epoch !== copyEpoch) return;
      const prev = copyFeedback.get(btn);
      if (prev) clock.clearTimeout(prev.timer);
      btn.classList.add('is-copied');
      paint(true);
      copyFeedback.set(btn, { timer: clock.setTimeout(revert, COPY_FEEDBACK_MS), revert });
    });
  }
  /**
   * A quiet copy button, ALWAYS visible (item 5: the hover-only ghost was never found). Icon plus
   * a text label when `label` is given (「답변 복사」 under an answer, 「대화 복사」 in a column
   * head); icon-only otherwise (a user turn, the frozen question) — its aria-label / title say
   * what it copies. The label reads 「복사됨」 for COPY_FEEDBACK_MS after a successful copy.
   */
  function copyButton(getText, { kind, provider = null, label = '', aria = '' } = {}) {
    const btn = el('button', 'cmp-copy' + (label ? ' cmp-copy-labelled' : ''));
    btn.type = 'button';
    btn.appendChild(copyIcon());
    const labelNode = el('span', 'cmp-copy-label');
    btn.appendChild(labelNode);
    const idle = aria || label || t('copy');
    const paint = (copied) => {
      labelNode.textContent = copied ? t('copied') : label;
      btn.setAttribute('aria-label', copied ? t('copied') : idle);
      btn.title = copied ? t('copied') : idle;
    };
    paint(false);
    attachCopy(btn, getText, paint, kind, provider);
    return btn;
  }
  /**
   * The whole comparison as ONE markdown document (batch 2, 「전체 복사」):
   *   # <question>   (a multi-line question: its first line as the heading, the whole of it as
   *                    a blockquote under it — a line of it can never read as a heading)
   *   ## <Provider> (<served model, when known>)   — participating columns, catalog order (an
   *   excluded source never participates: the checkbox locks at the first send)
   *   <raw assistant text of every turn>; a follow-up's question as `> **Q:** …` (EVERY line of
   *   it quoted) before its answer; an error as `_<error line>_` after whatever streamed; a
   *   skipped turn as `_건너뜀_`.
   * Blocks are joined by blank lines; nothing is escaped (it is the raw text, like the per-turn copy).
   */
  /** Every line quoted, the first one carrying the `**Q:**` mark — a line break cannot leave the quote. */
  const quoteLines = (text, first = '') => String(text).split('\n').map((line, i) => `> ${i === 0 ? first : ''}${line}`).join('\n');
  /**
   * ONE builder for both copies (item 5): the whole comparison (every participating column,
   * catalog order) and a single column's thread (「대화 복사」) are the same document over a
   * different column list — the question block is shared, so the two can never drift in shape.
   */
  function markdownFor(cols) {
    const qLines = String(state.question).split('\n');
    const blocks = [`# ${qLines[0]}`];
    if (qLines.length > 1) blocks.push(quoteLines(state.question));
    for (const col of cols) {
      const m = col.servedModel;
      const modelText = m ? String(m.label || m.id || '') : '';
      blocks.push(`## ${PROVIDER_META[col.provider].label}${modelText ? ` (${modelText})` : ''}`);
      for (const turn of col.turns) {
        // A summary request (C5) carries every other column's answer — the export names it
        // instead of repeating them; its answer is titled so the verdict reads as one.
        if (turn.role === 'user') blocks.push(turn.kind === TURN_KIND_SUMMARY ? `> **Q:** ${t('summary_md_q')}` : quoteLines(turn.text, '**Q:** '));
        else if (turn.role === 'skipped') blocks.push(`_${t('col_skipped')}_`);
        else {
          if (turn.kind === TURN_KIND_SUMMARY) blocks.push(`**${t('summary_badge')}**`);
          // The markdown SOURCE, Gemini's trailing `<FollowUp …/>` tags included (#1571): the export
          // is the answer as sent, and stripping them by text would also strip a code example that
          // shows the tag (Codex 1R #1). The chips are the page's rendering, not the answer.
          if (turn.text) blocks.push(turn.text);
          if (turn.errorText) blocks.push(`_${turn.errorText}_`);
          if (turn.stalled) blocks.push(`_${ctx.cutNote(turn)}_`);
        }
      }
    }
    return blocks.join('\n\n');
  }
  /** Participating columns in catalog order (an excluded source never participates: the checkbox locks at the first send). */
  const participatingColumns = () => state.columnIds.map((id) => state.columns.get(id)).filter((c) => c && c.participated);
  /** Columns in page order. */
  const allColumns = () => state.columnIds.map((id) => state.columns.get(id)).filter(Boolean);
  /** The first column of a provider on the page (the one that carries the provider-level UI), or null. */
  const firstColumnOf = (provider) => allColumns().find((c) => c.provider === provider) || null;
  /** A column's display label: the provider, plus its model label when it has one (`Claude (Opus 5)`). */
  function colLabel(col) {
    const base = PROVIDER_META[col.provider].label;
    const ml = modelLabelOf(col.provider, col.model);
    return ml ? `${base} (${ml})` : base;
  }
  /** The catalog label of a model id for a provider ('' for auto / unknown — the id itself then). */
  function modelLabelOf(provider, model) {
    if (model == null) return '';
    const list = state.status && state.status.models && Array.isArray(state.status.models[provider]) ? state.status.models[provider] : [];
    const m = list.find((x) => x && String(x.id) === String(model));
    return m ? modelOptionText(m, t) : String(model);
  }
  const compareMarkdown = () => markdownFor(participatingColumns());
  const columnMarkdown = (col) => (col.participated ? markdownFor([col]) : '');
  /** A column holds at least one answer with text. */
  const columnHasAnswer = (c) => c.turns.some((turn) => turn.role === 'assistant' && turn.text);
  /** 「전체 복사」 is worth pressing once some column holds an answer; a column's 「대화 복사」 once THAT column does. */
  function syncCopyAll() {
    ctx.copyAllBtn.disabled = ![...state.columns.values()].some(columnHasAnswer);
    for (const col of state.columns.values()) col.copyColBtn.hidden = !columnHasAnswer(col);
  }
  // Everything another file reaches (compare.js destructures the names it calls bare).
  Object.assign(ctx, {
    copyText, focusQuietly, copyIcon, clearCopyFeedback, attachCopy, copyButton, quoteLines, markdownFor,
    participatingColumns, allColumns, firstColumnOf, colLabel, modelLabelOf, compareMarkdown, columnMarkdown, columnHasAnswer,
    syncCopyAll, copyFeedback,
  });
}
