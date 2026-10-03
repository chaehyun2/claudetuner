// ui/compare/summary.js — the 「요약·비교」 slice of mountComparePage() (compare.js, chathub batch 1,
// C5): which round is the comparison, which columns answered it, the judge, the prompt that
// attaches every answer (summaryStructure / renderSummaryPrompt), the button state and the confirm
// popover's content. The popover DOM and its listeners stay in compare.js (attached to ctx).
// Bodies are exactly as they were in compare.js; ctx contract: see ui/compare/history.js.

import { neutraliseQuoted, storageGet } from './helpers.js';
import { keptFor } from './save-mode.js';
import { consentAfterSend, mayDirectSummarize } from './consent.js';
import { usagePeak, USAGE_FLOOR_PCT } from './usage-floor.js';
import { MAX_COLUMNS, colIdOf, PROVIDER_META, SUMMARY_PROMPT_MAX, SUMMARY_PER_COLUMN_MAX, SUMMARY_MIN_SHARE, SUMMARY_MIN_COLUMNS, SUMMARY_QUESTION_MAX, SUMMARY_FENCE_OPEN, SUMMARY_FENCE_CLOSE, SUMMARY_MODEL_LABEL_MAX, TURN_KIND_SUMMARY, SUMMARY_CONSENT_KEY, SUMMARY_AUTO_KEY } from './constants.js';

/** Installs the summary slice onto `ctx` (ctx contract: ui/compare/history.js header). */
// On the judge column while its summary is starting (compare.css: a one-shot accent ring).
const SUMMARY_FLASH_CLASS = 'is-summary-target';
// On the popover while it is anchored to a button other than the topbar's (the round footer, #1976).
const SUMMARY_ANCHORED_CLASS = 'is-anchored';
// The anchored popover's gap above its button and its minimum distance from the viewport edge.
const SUMMARY_POP_GAP_PX = 8;
const SUMMARY_POP_EDGE_PX = 8;
// GA `summarize.via` (plan §4): where the popover that sent it was opened from.
const SUMMARY_VIA_TOPBAR = 'topbar';
const SUMMARY_VIA_FOOTER = 'footer';
const SUMMARY_VIA_AUTO = 'auto';
// GA `summarize.judge_pick` (plan §4): the user picked the judge this session, or the default did.
const SUMMARY_PICK_USER = 'user';
const SUMMARY_PICK_DEFAULT = 'default';

/**
 * The default judge (#1976 R11) over `cands` = [{id, provider, paid}] in page order:
 *   1. the user's pick this session (`choice`) while it is a candidate;
 *   2. candidates whose provider is BUSY (usage ≥ USAGE_FLOOR_PCT on a live 5h or 7d window — usage-floor.js) drop
 *      out, unless every candidate is busy;
 *   3. the most headroom wins: the lowest peak among those with a gauge. A candidate WITHOUT a
 *      number (no snapshot, no gauge, no limits) is not ranked by usage — it stays in the running
 *      at the legacy rule's place (plan §6-4);
 *   4. ties (sibling columns of one provider, unknowns) by the legacy rule: exactly one paid → it,
 *      else Claude, else the first.
 * `peakOf(provider)` = the provider's peak utilisation or null.
 */
export function pickJudge(cands, { choice = null, peakOf = () => null } = {}) {
  if (!cands.length) return null;
  if (choice && cands.some((c) => c.id === choice)) return choice;
  const peak = (c) => { const v = peakOf(c.provider); return typeof v === 'number' && Number.isFinite(v) ? v : null; };
  const calm = cands.filter((c) => { const v = peak(c); return v === null || v < USAGE_FLOOR_PCT; });
  const pool = calm.length ? calm : cands;
  const known = pool.map(peak).filter((v) => v !== null);
  const best = known.length ? Math.min(...known) : null;
  const group = pool.filter((c) => { const v = peak(c); return v === null || v === best; });
  const paid = group.filter((c) => c.paid);
  if (paid.length === 1) return paid[0].id;
  const claude = group.find((c) => c.provider === 'claude');
  return claude ? claude.id : group[0].id;
}

// 「다음부터 묻지 않고 바로 정리」 (#1976 R4) lives in consent.js beside the #1985 cross consent (one
// system, two lifetimes); re-exported here for the callers that always imported it from this file.
export { consentAfterSend, mayDirectSummarize };

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
  // The answer as the judge reads it: its text, plus one line saying images were part of it
  // (#1684) — the judge gets no pictures, and an image-only answer must not vanish from the
  // comparison (nor read as an empty one).
  function answerText(turn) {
    const n = ctx.outImageCount(turn);
    return n ? `${turn.text}${turn.text ? '\n\n' : ''}[${t('summary_image_note', n)}]` : turn.text;
  }
  function answerInRound(col, round) {
    for (let i = col.turns.length - 1; i >= 0; i--) {
      const turn = col.turns[i];
      if (turn.role === 'assistant' && answerText(turn) && turn.kind !== TURN_KIND_SUMMARY && turn.round === round) return { text: answerText(turn), partial: !!turn.errorText || turn.stalled === true, model: turn.model || null };
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
        if (turn.role !== 'assistant' || !answerText(turn) || turn.kind === TURN_KIND_SUMMARY || !Number.isFinite(turn.round)) continue;
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
   * The default judge (pickJudge): the user's pick this session, else the candidate with the most
   * usage headroom (busy providers out), ties by the old rule — exactly ONE candidate on a paid tier
   * (the header pill's data-tier, from status.providers[p].plan), else Claude, else the first.
   */
  function judgeDefault(cands) {
    // #1976 R11: the remaining usage now ranks the candidates (pickJudge) — the same numbers as the column heads' gauges.
    const usage = (p) => { const e = state.status && state.status.providers && state.status.providers[p]; return e && typeof e === 'object' ? e.usage : null; };
    return pickJudge(cands.map((c) => ({ id: c.id, provider: c.provider, paid: c.plan.getAttribute('data-tier') === 'paid' })), { choice: state.judgeChoice, peakOf: (p) => usagePeak(usage(p)) });
  }
  /**
   * An attachment is EVIDENCE, not instructions (Codex C5 2R #6): every attached answer is fenced
   * by SUMMARY_FENCE_OPEN / SUMMARY_FENCE_CLOSE lines the head tells the judge to trust, and a line
   * of the answer that could pass for a fence or a heading (starts with `<<<` or `#`) is set off by
   * one leading space — it still reads, it no longer parses as structure.
   */
  const neutraliseAttachment = neutraliseQuoted; // helpers.js — shared with the debate prompts (debate-core.js)
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
      // #2026: whether the verdict is asked for questions — FIXED here, at the send, so a retry / a reload / a flag change later
      // renders the very prompt that went out (Codex 2R). Nothing to avoid any more: its questions REPLACE row 1's (2026-10-03),
      // so it picks the best ones freely (`avoid` stays readable for entries stored before).
      ...(ctx.suggestOn && ctx.suggestOn() ? { suggest: { avoid: [] } } : {}),
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
    // #2026: with the suggested-question chips on, the verdict also ends with questions on where the answers differ (row 2).
    // #2026: the structure says whether the verdict was asked for questions and which shown ones to avoid (live test 2026-10-02:
    // the two rows repeated each other) — never the live state, so a re-render is the prompt that was sent.
    const sg = summary.suggest && typeof summary.suggest === 'object' ? summary.suggest : null;
    const avoid = sg && Array.isArray(sg.avoid) ? sg.avoid : [];
    const tail = t('summary_prompt_tail') + (sg ? `\n${t('summary_prompt_tail_suggest')}${avoid.length ? `\n${t('summary_prompt_tail_avoid')}\n${avoid.map((q) => `- ${neutraliseAttachment(q)}`).join('\n')}` : ''}` : '');
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
    // Only a kept JUDGE provider (#1985) leaves the attached answers in its own history.
    const judgeKept = !!jc && keptFor(state.sessionSaveBy, jc.provider);
    ctx.summaryHistoryNote.hidden = !judgeKept;
    ctx.summaryHistoryNote.textContent = judgeKept ? t('summary_pop_history', label) : '';
    // 「다음부터 묻지 않고 바로 정리」 (#1976 R4): offered only beside the history note it consents to,
    // ticked when this judge's provider already has consent (unticking it revokes at 보내기).
    ctx.summaryAutoLabel.hidden = ctx.summaryHistoryNote.hidden || !ctx.roundFooterOn();
    ctx.summaryAuto.checked = !!jc && mayDirectSummarize(state.summaryConsent, jc.provider);
    // 「답이 끝나면 자동으로 정리」 (stage 4, §3.5 / R5): default off; offered beside the same history note,
    // because turning it on IS consent for this judge's provider (R4) — see the change listener in compare.js.
    ctx.summaryAutorunLabel.hidden = ctx.summaryAutoLabel.hidden;
    ctx.summaryAutorun.checked = state.summaryAutorun === true;
    // #1985 §3.4.5-1: the popover IS the consent card when an incognito service's answer would be kept in
    // the judge's history — the sentence, 「동의하고 보내기」, and 「시크릿 답 빼고 보내기」 while the rest still makes a summary.
    const pending = jc ? crossPendingFor(jc.id, answeredColumns()) : [];
    ctx.summaryCross.hidden = !pending.length;
    ctx.summaryCross.textContent = pending.length ? ctx.crossConsentText('cross_consent_body', pending) : '';
    if (pending.length) ctx.summarySendBtn.textContent = t('cross_consent_agree');
    ctx.summaryExcludeBtn.hidden = !pending.length || withoutIncognito(answeredColumns()).length < SUMMARY_MIN_COLUMNS;
  }
  /** The answers an incognito service gave, left out (「시크릿 답 빼고 보내기」). */
  const withoutIncognito = (cols) => cols.filter((c) => keptFor(state.sessionSaveBy, c.provider));
  /** The cross pairs a summary of `cols` judged by column `judge` would leak (not yet agreed). */
  function crossPendingFor(judge, cols) {
    return ctx.crossPendingFor(cols.map((c) => c.provider), [judge]);
  }
  /** The popover's 보내기 while it asks (#1985): agreeing is that click — the pairs it showed, then the send. */
  function sendFromPop(exclude = false) {
    const pending = crossPendingFor(ctx.summaryJudge.value, answeredColumns());
    if (pending.length) {
      track('cross_consent', { surface: 'summary_pop', choice: exclude ? 'exclude' : 'agree', pairs_n: pending.length });
      if (!exclude) ctx.agreeCross(pending);
    }
    startSummary(null, false, { exclude });
  }
  function cancelFromPop() {
    const pending = ctx.summaryJudge.value ? crossPendingFor(ctx.summaryJudge.value, answeredColumns()) : [];
    if (pending.length) track('cross_consent', { surface: 'summary_pop', choice: 'cancel', pairs_n: pending.length });
    closeSummaryPop();
  }
  /**
   * The autorun box changed (stage 4, R5): ON stores the setting AND this judge provider's consent — it is
   * ticked beside the history note, so it is consent the R4 way; OFF stores the setting only.
   */
  function setSummaryAutorun(on) {
    state.summaryAutorun = on === true;
    const jc = judgeColumn(ctx.summaryJudge.value);
    if (state.summaryAutorun && jc && !ctx.summaryAutoLabel.hidden) {
      state.summaryConsent = consentAfterSend(state.summaryConsent, jc.provider, { noteShown: true, checked: true });
      ctx.summaryAuto.checked = true;
      saveSummaryConsent();
    }
    try { if (ctx.localStorageArea) ctx.localStorageArea.set({ [SUMMARY_AUTO_KEY]: state.summaryAutorun }); } catch { /* best effort */ }
    track('summary_autorun', { on: state.summaryAutorun });
  }
  /** The stored consents (chrome.storage.local), read once at mount; a failed read = none. */
  function loadSummaryConsent() {
    const store = ctx.localStorageArea;
    if (!store) return Promise.resolve();
    return storageGet(ctx.chrome, store, { [SUMMARY_CONSENT_KEY]: null, [SUMMARY_AUTO_KEY]: false }).then((got) => {
      state.summaryAutorun = !!(got && got[SUMMARY_AUTO_KEY] === true);
      const v = got && got[SUMMARY_CONSENT_KEY];
      const out = {};
      if (v && typeof v === 'object') for (const [k, on] of Object.entries(v)) if (on === true && Object.prototype.hasOwnProperty.call(PROVIDER_META, k)) out[k] = true;
      state.summaryConsent = out;
      if (ctx.renderRoundFooter) ctx.renderRoundFooter();
    });
  }
  function saveSummaryConsent() {
    try { if (ctx.localStorageArea) ctx.localStorageArea.set({ [SUMMARY_CONSENT_KEY]: state.summaryConsent }); } catch { /* best effort */ }
  }
  // The button the popover was opened from (#1976 R9): the topbar's 「요약·비교」 or the round
  // footer's 「차이점 정리」 — its aria-expanded follows the popover, and the popover sits by it.
  let opener = null;
  const summaryOpener = () => opener;
  /**
   * Any opener but the topbar button anchors the popover just above it (fixed, clamped into the
   * viewport); the topbar's keeps the stylesheet's place under the bar.
   */
  function placeSummaryPop(from) {
    const pop = ctx.summaryPop;
    const anchored = from !== ctx.summaryBtn && from && typeof from.getBoundingClientRect === 'function';
    pop.classList.toggle(SUMMARY_ANCHORED_CLASS, !!anchored);
    if (!anchored) { pop.style.left = ''; pop.style.top = ''; return; }
    const r = from.getBoundingClientRect();
    const vw = (ctx.win && ctx.win.innerWidth) || 0;
    const vh = (ctx.win && ctx.win.innerHeight) || 0;
    const width = pop.offsetWidth || 0;
    const height = pop.offsetHeight || 0;
    const left = Math.max(SUMMARY_POP_EDGE_PX, Math.min(r.left, vw - width - SUMMARY_POP_EDGE_PX));
    // Above the button when it fits, else below it; either way clamped into the viewport (a short window).
    const above = r.top - SUMMARY_POP_GAP_PX - height;
    const want = above >= SUMMARY_POP_EDGE_PX ? above : r.bottom + SUMMARY_POP_GAP_PX;
    const top = Math.max(SUMMARY_POP_EDGE_PX, Math.min(want, vh - height - SUMMARY_POP_EDGE_PX));
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }
  function openSummaryPop(from = ctx.summaryBtn) {
    if (!summaryAllowed()) return;
    if (opener && opener !== from) opener.setAttribute('aria-expanded', 'false');
    opener = from || ctx.summaryBtn;
    const cands = judgeCandidates();
    clear(ctx.summaryJudge); // a fresh open starts from the default (the remembered choice, else the rule)
    fillSummaryJudges(cands, judgeDefault(cands));
    ctx.closeHistoryPanel();
    ctx.summaryPop.hidden = false;
    placeSummaryPop(opener); // after unhiding: its width is measured
    opener.setAttribute('aria-expanded', 'true');
    // #1985 (Codex stage 4 1R 후속): while it asks for consent, the default focus is 취소 — one Enter is never consent.
    if (!ctx.summaryCross.hidden) { try { ctx.summaryCancelBtn.focus(); } catch { /* detached */ } }
  }
  function closeSummaryPop() {
    if (ctx.summaryPop.hidden) return;
    ctx.summaryPop.hidden = true;
    if (opener) opener.setAttribute('aria-expanded', 'false');
    opener = null;
  }
  /** 「보내기」: one FOLLOWUP to the judge with every answer attached — nothing else changes hands. */
  // `direct` (#1976 R4): the round footer sends to `direct` (its default judge, whose provider has
  // consent) without the popover; otherwise the judge is the popover's select.
  // `auto` (stage 4): the round footer's automatic run — reported as via `auto`, and it never takes the user's
  // activity (the idle countdown is the user's, not ours).
  // `opts.exclude` (#1985 §3.4.4): the incognito services' answers are left out (the consent card's second choice).
  function startSummary(direct = null, auto = false, opts = {}) {
    if (!auto) ctx.noteActivity();
    const cands = opts.exclude ? withoutIncognito(answeredColumns()) : answeredColumns();
    const fromPop = typeof direct !== 'string';
    const judge = fromPop ? ctx.summaryJudge.value : direct;
    const via = auto ? SUMMARY_VIA_AUTO : !fromPop ? SUMMARY_VIA_FOOTER : opener && opener !== ctx.summaryBtn ? SUMMARY_VIA_FOOTER : SUMMARY_VIA_TOPBAR; // read before closeSummaryPop forgets it
    const judgePick = state.judgeChoice ? SUMMARY_PICK_USER : SUMMARY_PICK_DEFAULT;
    if (!summaryAllowed() || !judgeCandidates().some((c) => c.id === judge)) { closeSummaryPop(); return; }
    const jcol = judgeColumn(judge);
    if (!fromPop && !(jcol && mayDirectSummarize(state.summaryConsent, jcol.provider))) return; // no consent: the popover asks (never a silent send)
    // 🔴 #1985: R4 consent does not cover an incognito service's answer — a direct / automatic run with a
    // pending cross pair opens the popover instead (it asks); the popover sends only after its click agreed.
    const pending = crossPendingFor(judge, cands);
    if (pending.length) {
      if (!fromPop) { track('cross_consent', { surface: auto ? 'summary_auto' : 'summary_pop', choice: 'shown', pairs_n: pending.length }); openSummaryPop(); }
      return;
    }
    if (cands.length < SUMMARY_MIN_COLUMNS) { closeSummaryPop(); return; }
    if (fromPop && jcol) {
      const next = consentAfterSend(state.summaryConsent, jcol.provider, { noteShown: !ctx.summaryAutoLabel.hidden, checked: !!ctx.summaryAuto.checked });
      if (JSON.stringify(next) !== JSON.stringify(state.summaryConsent || {})) { state.summaryConsent = next; saveSummaryConsent(); }
    }
    if (fromPop) state.judgeChoice = judge;
    closeSummaryPop();
    const round = comparisonRound();
    if (round === null) return;
    const summary = summaryStructure(judge, round, cands);
    const text = renderSummaryPrompt(summary);
    state.summaryPending = judge;
    track('summarize', { judge, columns_n: cands.length, via, judge_pick: judgePick, direct: !fromPop });
    // provenance = the attached answers' services (#1985 gate — beginSend refuses a pending pair).
    ctx.beginSend(text, [judge], 'FOLLOWUP', [], TURN_KIND_SUMMARY, summary, null, false, null, null, summary.attachments.map((a) => a.provider));
    // The result is written INTO the judge's column — say where (#1714 ①: it arrived there silently
    // and users looked for it): that column is scrolled into view and flashes once.
    const judgeCol = state.columns.get(judge);
    // #1976 stage 2: the result is drawn in a full-width card under the columns — that is where to look.
    const card = judgeCol && ctx.latestSummaryCard ? ctx.latestSummaryCard(judgeCol) : null;
    if (auto) return; // an automatic run never moves the page under the reader (it shows where it lands, unscrolled)
    if (card) {
      ctx.revealNode(card);
      if (card.classList) { card.classList.remove(SUMMARY_FLASH_CLASS); void card.offsetWidth; card.classList.add(SUMMARY_FLASH_CLASS); }
    } else if (judgeCol && judgeCol.node) {
      // In focus mode a judge that is a 48px rail shows no body at all: the focus moves to it (Codex 1R).
      if (state.focusedCol && state.focusedCol !== judge) ctx.setColumnFocus(judge);
      ctx.revealNode(judgeCol.node);
      if (judgeCol.node.classList) {
        judgeCol.node.classList.remove(SUMMARY_FLASH_CLASS);
        void judgeCol.node.offsetWidth; // restart the animation on a second summary
        judgeCol.node.classList.add(SUMMARY_FLASH_CLASS);
      }
    }
  }
  // Everything another file reaches (compare.js destructures the names it calls bare).
  Object.assign(ctx, {
    summaryOn, answerInRound, comparisonRound, roundQuestion, answeredColumns, judgeCandidates, judgeColumn, summaryAllowed,
    judgeDefault, neutraliseAttachment, summaryStructure, renderSummaryPrompt, summaryCostFree, syncSummaryButton, fillSummaryJudges, paintSummaryPop,
    openSummaryPop, closeSummaryPop, startSummary, summaryOpener, loadSummaryConsent, setSummaryAutorun, sendFromPop, cancelFromPop,
  });
}
