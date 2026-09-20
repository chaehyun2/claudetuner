// ui/compare/summary.js — the 「요약·비교」 slice of mountComparePage() (compare.js, chathub batch 1,
// C5): which round is the comparison, which columns answered it, the judge, the prompt that
// attaches every answer (summaryStructure / renderSummaryPrompt), the button state and the confirm
// popover's content. The popover DOM and its listeners stay in compare.js (attached to ctx).
// Bodies are exactly as they were in compare.js; ctx contract: see ui/compare/history.js.

import { MAX_COLUMNS, colIdOf, PROVIDER_META, SUMMARY_PROMPT_MAX, SUMMARY_PER_COLUMN_MAX, SUMMARY_MIN_SHARE, SUMMARY_MIN_COLUMNS, SUMMARY_QUESTION_MAX, SUMMARY_FENCE_OPEN, SUMMARY_FENCE_CLOSE, SUMMARY_MODEL_LABEL_MAX, TURN_KIND_SUMMARY } from './constants.js';

/** Installs the summary slice onto `ctx` (ctx contract: ui/compare/history.js header). */
export function installSummary(ctx) {
  const { t, state, track, el, clear } = ctx;
  // ── 「요약·비교」 (chathub batch 1, C5) ──
  // One column's AI judges every answer: each sendable column's answer in the COMPARISON ROUND
  // (comparisonRound: the active round when it is one, else the latest) is attached to an
  // instruction (summaryStructure / renderSummaryPrompt) and sent as a FOLLOWUP to ONE column — the judge —
  // through beginSend, the same readiness → consume → send path as any follow-up (AC18 untouched,
  // 1 compare spent, which the button and the popover say). The judge answers in its own column,
  // its request folded, its answer badged (pushUserTurn / pushAssistantTurn `kind`). Gate: the SW's
  // `summaryOn` (flags.json `compare_summary`, absent = dark) AND a live follow-up path AND at
  // least SUMMARY_MIN_COLUMNS answered columns that can still be sent to AND a compare left.
  const summaryOn = () => !!(state.status && state.status.summaryOn === true);
  /**
   * A column's real answer (text, not a summary verdict) from `round`, or null. Provenance is the
   * turn's own `round` (Codex 3R #1): after a single-column follow-up (C4) the column's LATEST
   * answer is to a different question, so "latest" would attach a translation next to the others'
   * original answers. `partial` = text that streamed before an ERROR cut it, or before the
   * provider went silent (DONE{stalled}, #1519) — the prompt marks both the same way.
   */
  function answerInRound(col, round) {
    for (let i = col.turns.length - 1; i >= 0; i--) {
      const turn = col.turns[i];
      if (turn.role === 'assistant' && turn.text && turn.kind !== TURN_KIND_SUMMARY && turn.round === round) return { text: turn.text, partial: !!turn.errorText || turn.stalled === true, model: turn.model || null };
    }
    return null;
  }
  /**
   * The comparison round: the ACTIVE round (state.activeRound — the last accepted non-summary
   * send) when it is a comparison, else the latest round in which at least SUMMARY_MIN_COLUMNS
   * live, sendable columns hold a real answer AND whose request is still known; null when none.
   */
  function comparisonRound() {
    const perRound = new Map();
    for (const col of ctx.liveColumns()) {
      if (ctx.columnDead(col)) continue;
      for (const turn of col.turns) {
        if (turn.role !== 'assistant' || !turn.text || turn.kind === TURN_KIND_SUMMARY || !Number.isFinite(turn.round)) continue;
        if (!perRound.has(turn.round)) perRound.set(turn.round, new Set());
        perRound.get(turn.round).add(col.id);
      }
    }
    // The round the user last worked on (the last accepted NON-summary send — a retry of round 1
    // counts as round 1, a summary moves nothing) when it is a comparison; else the latest
    // comparison round (Codex 4R blocker: after a retry that completed round 1, a 「전체」 follow-up
    // in between must not steal the summary).
    // …and only a round whose REQUEST is still known (roundQuestion): answers whose question was
    // evicted from a stored entry cannot be compared against anything.
    const isComparison = (round) => perRound.has(round) && perRound.get(round).size >= SUMMARY_MIN_COLUMNS && roundQuestion(round) !== null;
    if (Number.isFinite(state.activeRound) && isComparison(state.activeRound)) return state.activeRound;
    let best = null;
    for (const [round] of perRound) if (isComparison(round) && (best === null || round > best)) best = round;
    return best;
  }
  /**
   * The question the comparison round asked: a plain user turn of that round in any column; the
   * question card for the first SEND round (which has no user turn); null for any other round
   * whose request is gone (evicted from a stored entry — Codex 6R blocker: never the first question
   * over a later round's answers).
   */
  function roundQuestion(round) {
    for (const col of ctx.liveColumns()) for (const turn of col.turns) if (turn.role === 'user' && turn.kind !== TURN_KIND_SUMMARY && turn.round === round) return turn.text;
    return round === state.firstRound ? state.question : null;
  }
  /** Columns whose answer is attached as evidence: answered IN the comparison round, not dead. */
  const answeredColumns = () => { const round = comparisonRound(); return round === null ? [] : ctx.liveColumns().filter((c) => !ctx.columnDead(c) && answerInRound(c, round) !== null); };
  /**
   * Columns that may JUDGE: the attachable ones minus a provider stuck behind a sign-in /
   * permission gate (providerUnresolvedGate — a FOLLOWUP to it fails readiness again; Codex
   * integration #6). Its earlier answer stays evidence for whoever else judges.
   */
  const judgeCandidates = () => answeredColumns().filter((c) => !ctx.providerUnresolvedGate(c.provider));
  /** The column of a judge id (a stored / legacy judge may name a provider → its first column). */
  const judgeColumn = (judge) => (judge ? state.columns.get(judge) || null : null);
  function summaryAllowed() {
    return summaryOn() && !ctx.quotaExhausted() && ctx.canFollowUp() && !state.sending && answeredColumns().length >= SUMMARY_MIN_COLUMNS && judgeCandidates().length > 0;
  }
  /**
   * The default judge: exactly ONE candidate on a paid tier (the header pill's data-tier, from
   * status.providers[p].plan) → that one; several paid or none → Claude when it took part; else
   * the first candidate (catalog order). The user's pick in the popover wins for the session.
   */
  function judgeDefault(cands) {
    if (state.judgeChoice && cands.some((c) => c.id === state.judgeChoice)) return state.judgeChoice;
    const paid = cands.filter((c) => c.plan.getAttribute('data-tier') === 'paid');
    if (paid.length === 1) return paid[0].id;
    const claude = cands.find((c) => c.provider === 'claude');
    return claude ? claude.id : (cands.length ? cands[0].id : null);
  }
  /**
   * An attachment is EVIDENCE, not instructions (Codex C5 2R #6): every attached answer is fenced
   * by SUMMARY_FENCE_OPEN / SUMMARY_FENCE_CLOSE lines the head tells the judge to trust, and a line
   * of the answer that could pass for a fence or a heading (starts with `<<<` or `#`) is set off by
   * one leading space — it still reads, it no longer parses as structure.
   */
  const neutraliseAttachment = (text) => String(text).split('\n').map((line) => (/^(<<<|#)/.test(line) ? ` ${line}` : line)).join('\n');
  /**
   * The structured 「요약·비교」 request (Codex 3R #2): what the prompt is REGENERATED from — for the
   * wire, the folded display, a retry and a reload alike. `attachments` are the comparison round's
   * answers with their own served model; `clipped` is set by fitEntry when the stored body was cut.
   */
  function summaryStructure(judge, round, cols) {
    return {
      judge,
      round,
      question: String(roundQuestion(round)).split('\n')[0], // its first line; the renderer bounds the length
      attachments: cols.map((c) => {
        const a = answerInRound(c, round);
        return { col: c.id, provider: c.provider, model: a && a.model ? { id: a.model.id == null ? null : String(a.model.id).slice(0, SUMMARY_MODEL_LABEL_MAX), label: String(a.model.label || '').slice(0, SUMMARY_MODEL_LABEL_MAX) } : null, text: a ? a.text : '', partial: !!(a && a.partial), clipped: false };
      }),
    };
  }
  /**
   * The judge's instruction + every attached answer, in the page language, from the structure.
   * Budgeted as a WHOLE (Codex C5 2R #2): the fixed parts (head, quoted question, fences, labels,
   * tail, markers) are measured first and the attachments share what SUMMARY_PROMPT_MAX leaves,
   * evenly, never more than SUMMARY_PER_COLUMN_MAX each — so the tail can never fall off the end.
   */
  function renderSummaryPrompt(summary) {
    const atts = Array.isArray(summary.attachments) ? summary.attachments : [];
    const head = [t('summary_prompt_head', atts.length), ctx.quoteLines(String(summary.question || '').slice(0, SUMMARY_QUESTION_MAX))];
    const tail = t('summary_prompt_tail');
    const items = atts.map((a, i) => {
      const m = a.model;
      const modelText = m ? String(m.label || m.id || '') : ''; // bounded where the structure is made / loaded (SUMMARY_MODEL_LABEL_MAX)
      // `Claude (Opus 5)`: a sibling column of the same provider is a peer, told apart by its model.
      const aCol = a.col || colIdOf(a.provider, null);
      const label = `${PROVIDER_META[a.provider] ? PROVIDER_META[a.provider].label : String(a.provider)}${modelText ? ` (${modelText})` : ''}${aCol === summary.judge ? ` ${t('summary_yours')}` : ''}`;
      return { open: SUMMARY_FENCE_OPEN(i + 1, label), close: SUMMARY_FENCE_CLOSE(i + 1), text: neutraliseAttachment(a.text || ''), partial: !!a.partial, clipped: !!a.clipped };
    }).slice(0, MAX_COLUMNS);
    const clipMark = `…\n\n_${t('summary_clipped')}_`;
    const partialMark = `_${t('summary_partial')}_`;
    // Everything but the answers themselves, with the widest marker each answer might carry.
    const separators = 2 * (head.length + 1 + items.length * 4); // '\n\n' joins (open, text, [mark], close per item)
    const fixed = head.join('').length + tail.length + separators + items.reduce((n, it) => n + it.open.length + it.close.length + clipMark.length + (it.partial ? partialMark.length : 0), 0);
    const budget = SUMMARY_PROMPT_MAX; // ONE bound for the estimate below and the check on the result
    let cap = Math.max(SUMMARY_MIN_SHARE, Math.min(SUMMARY_PER_COLUMN_MAX, Math.floor((budget - fixed) / Math.max(1, items.length))));
    const render = () => {
      const parts = [...head];
      for (const it of items) {
        parts.push(it.open);
        // A body the history bound already cut (`clipped`) still says so, whatever its length now.
        parts.push(it.text.length > cap ? `${it.text.slice(0, cap)}${clipMark}` : (it.clipped ? `${it.text}${clipMark}` : it.text));
        if (it.partial) parts.push(partialMark);
        parts.push(it.close);
      }
      parts.push(tail);
      return parts.join('\n\n');
    };
    // The budget is enforced on the RESULT too (Codex 4R #3): whatever the estimate missed, the
    // bodies give way — halved until it fits or they are at the minimum share — never the
    // fences, labels or tail.
    let out = render();
    for (let i = 0; out.length > budget && cap > SUMMARY_MIN_SHARE && i < 12; i++) { cap = Math.max(SUMMARY_MIN_SHARE, Math.floor(cap / 2)); out = render(); }
    return out;
  }
  /** A compare that is not counted — Pro, or a server that is not counting (limit null): no 「차감」 copy anywhere (Codex C5 3R #8). */
  const summaryCostFree = () => { const q = state.status && state.status.quota; return !!q && (q.pro === true || q.limit == null); };
  function syncSummaryButton() {
    ctx.summaryBtn.hidden = !summaryOn();
    ctx.summaryBtn.disabled = !summaryAllowed();
    ctx.summaryBtn.title = t(summaryCostFree() ? 'summary_btn_title_free' : 'summary_btn_title');
    if (ctx.summaryBtn.disabled) { if (!ctx.summaryPop.hidden) closeSummaryPop(); return; }
    // Open while the candidates changed under it (a port loss that left only some columns
    // resumable, a column that died) — the select and the count follow; a judge that dropped out
    // is replaced by the default, the popover stays (Codex C5 2R #5).
    if (!ctx.summaryPop.hidden) fillSummaryJudges(judgeCandidates());
  }
  /** The judge select = the candidates; the current choice kept when still one of them, else the default. Idempotent. */
  // `preferred`: the judge to select when it is a candidate (a fresh open passes the default);
  // otherwise the select's CURRENT choice is kept when still a candidate, else the default.
  // 🔴 A native <select> answers `.value` = its first option once options exist and none is
  // selected, and DISCARDS a value assigned before any option matches — so the wanted judge is
  // decided from `cands` before the options are rebuilt and assigned only after (Codex 3R #3:
  // paid-Gemini / remembered-Gemini both read back as Claude in a real browser).
  function fillSummaryJudges(cands, preferred = null) {
    const wanted = cands.map((c) => c.id);
    const shown = [...ctx.summaryJudge.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    const current = shown.includes(ctx.summaryJudge.value) ? ctx.summaryJudge.value : null;
    const judge = wanted.includes(preferred) ? preferred : (wanted.includes(current) ? current : judgeDefault(cands));
    if (shown.join() !== wanted.join()) {
      clear(ctx.summaryJudge);
      for (const c of cands) {
        const o = el('option', null, ctx.colLabel(c));
        o.value = c.id;
        o.setAttribute('value', c.id);
        ctx.summaryJudge.appendChild(o);
      }
    }
    for (const o of ctx.summaryJudge.querySelectorAll('option')) { if (o.getAttribute('value') === judge) o.setAttribute('selected', 'selected'); else o.removeAttribute('selected'); }
    ctx.summaryJudge.value = judge; // options first, then the value (see above)
    paintSummaryPop(cands);
  }
  /** The popover's lines for the current judge choice. */
  function paintSummaryPop(cands = judgeCandidates()) {
    const judge = ctx.summaryJudge.value || judgeDefault(cands);
    const jc = judgeColumn(judge);
    const label = jc ? ctx.colLabel(jc) : '';
    ctx.summaryDesc.textContent = t('summary_pop_desc', answeredColumns().length, label); // the count is what gets ATTACHED
    const free = summaryCostFree();
    ctx.summaryCost.hidden = free;
    ctx.summarySendBtn.textContent = t(free ? 'summary_pop_send_free' : 'summary_pop_send');
    // Only a kept session leaves the attached answers in the judge's own history.
    ctx.summaryHistoryNote.hidden = state.sessionSaveHistory !== true;
    ctx.summaryHistoryNote.textContent = state.sessionSaveHistory === true ? t('summary_pop_history', label) : '';
  }
  function openSummaryPop() {
    if (!summaryAllowed()) return;
    const cands = judgeCandidates();
    clear(ctx.summaryJudge); // a fresh open starts from the default (the remembered choice, else the rule)
    fillSummaryJudges(cands, judgeDefault(cands));
    ctx.closeHistoryPanel();
    ctx.summaryPop.hidden = false;
    ctx.summaryBtn.setAttribute('aria-expanded', 'true');
  }
  function closeSummaryPop() {
    if (ctx.summaryPop.hidden) return;
    ctx.summaryPop.hidden = true;
    ctx.summaryBtn.setAttribute('aria-expanded', 'false');
  }
  /** 「보내기」: one FOLLOWUP to the judge with every answer attached — nothing else changes hands. */
  function startSummary() {
    ctx.noteActivity();
    const cands = answeredColumns();
    const judge = ctx.summaryJudge.value;
    if (!summaryAllowed() || !judgeCandidates().some((c) => c.id === judge)) { closeSummaryPop(); return; }
    state.judgeChoice = judge;
    closeSummaryPop();
    const round = comparisonRound();
    if (round === null) return;
    const summary = summaryStructure(judge, round, cands);
    const text = renderSummaryPrompt(summary);
    state.summaryPending = judge;
    track('summarize', { judge, columns_n: cands.length });
    ctx.beginSend(text, [judge], 'FOLLOWUP', [], TURN_KIND_SUMMARY, summary);
  }
  // Everything another file reaches (compare.js destructures the names it calls bare).
  Object.assign(ctx, {
    summaryOn, answerInRound, comparisonRound, roundQuestion, answeredColumns, judgeCandidates, judgeColumn, summaryAllowed,
    judgeDefault, neutraliseAttachment, summaryStructure, renderSummaryPrompt, summaryCostFree, syncSummaryButton, fillSummaryJudges, paintSummaryPop,
    openSummaryPop, closeSummaryPop, startSummary,
  });
}
