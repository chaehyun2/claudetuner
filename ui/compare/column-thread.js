// ui/compare/column-thread.js — the COLUMN THREAD slice of mountComparePage() (compare.js): the turn
// records a column body holds (user / assistant / skipped), the throttled markdown paint, the
// stream-follow scrolling and the 「↓ 새 내용」 pill, the C3 action row under the last turn (retry,
// Auto retry, open-tab, gate buttons), the per-column composer, the counted quota, the retry
// pair and the error copy. Bodies are exactly as they were in compare.js
// (test/mutants/compare-page.json anchors on them). The ctx contract is written up in history.js.

import { PROVIDER_META, COPY_KIND_TURN, COPY_KIND_THREAD, MODEL_AUTO_VALUE, FOLLOW_AT_BOTTOM_PX, FOLLOW_ANCHOR_TOP_PX, CODE_RATE_LIMITED, CODE_ABORTED, CODE_TIMEOUT, DEFAULT_SEND_BUDGET_MS, MS_PER_MINUTE, PROVIDER_RATE_LIMIT_KEY, CODE_NO_TAB, CODE_AUTH_REQUIRED, CODE_PERMISSION_REFUSED, CODE_MODEL_UNAVAILABLE, GATE_CODES, PROVIDER_BUSY_CODES, SEND_VIA_COLUMN, TURN_KIND_SUMMARY, ERROR_TITLE_MAX } from './constants.js';
import { autoGrow } from './helpers.js';
import { renderMarkdown } from '../md-render.js';
import { COMPARE_I18N } from '../compare-i18n.js';

/** Installs the column-thread slice onto `ctx` (see ui/compare/history.js for the ctx contract). */
export function installColumnThread(ctx) {
  const { doc, state, t, raf, el, clear, track } = ctx;
  /** Re-render the assistant turn from the accumulated text (throttled to one paint per frame). */
  function scheduleRender(col) {
    if (col.renderScheduled) return;
    col.renderScheduled = true;
    raf(() => { col.renderScheduled = false; paintAssistant(col); });
  }
  // The error line is re-appended on every paint: a CHUNK render scheduled before ERROR arrived
  // used to run after it and wipe the reason (Codex #8).
  /** Scroll metrics of a column body, or null where there is no layout engine (mini-dom). */
  function scrollMetrics(node) {
    const { scrollTop, clientHeight, scrollHeight } = node;
    if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) return null;
    return { scrollTop, clientHeight, scrollHeight, overflow: scrollHeight - clientHeight, fromEnd: scrollHeight - (scrollTop + clientHeight) };
  }
  /** Scroll a column to its end (next frame, like a paint) and let the scroll event clear the scrolled-up mark. */
  function scrollColumnToEnd(col) {
    raf(() => { col.body.scrollTop = col.body.scrollHeight; syncJumpButton(col); });
  }
  /** The 「↓ 새 내용」 pill: shown when the reader is away from the end of a column that holds content. */
  function syncJumpButton(col) {
    const m = scrollMetrics(col.body);
    const away = !!m && m.overflow > FOLLOW_AT_BOTTOM_PX && m.fromEnd > FOLLOW_AT_BOTTOM_PX;
    col.jumpBtn.hidden = !(away && col.turns.length > 0);
  }
  /**
   * After a paint of the live answer: follow while it fits, anchor its start once it overflows,
   * never move a view the user scrolled away from (see FOLLOW_AT_BOTTOM_PX).
   */
  function maybeFollowStream(col, turn) {
    if (col.userScrolledUp) { syncJumpButton(col); return; }
    // The pill was pressed during the stream: the reader asked for the tail — follow it to the end
    // until they scroll up again (an anchored column would otherwise stay put after the jump).
    if (col.followTail) { scrollColumnToEnd(col); return; }
    if (col.followAnchored) { syncJumpButton(col); return; }
    const m = scrollMetrics(col.body);
    if (!m) return;
    const rect = typeof turn.root.getBoundingClientRect === 'function' ? turn.root.getBoundingClientRect() : null;
    if (rect && rect.height > m.clientHeight - FOLLOW_ANCHOR_TOP_PX && m.overflow > FOLLOW_AT_BOTTOM_PX) {
      col.followAnchored = true;
      // Capture the node: a rollback / 새 대화 may remove it before the frame.
      const node = turn.root;
      raf(() => {
        if (!node.isConnected) return;
        const delta = node.getBoundingClientRect().top - col.body.getBoundingClientRect().top - FOLLOW_ANCHOR_TOP_PX;
        col.body.scrollTop += delta; // the answer's start just under the head; the rest streams in below
        syncJumpButton(col);
      });
      return;
    }
    scrollColumnToEnd(col); // still fits → keep the latest text visible
  }
  function paintAssistant(col) {
    const turn = col.turns[col.turns.length - 1];
    if (!turn || turn.role !== 'assistant') return;
    clear(turn.node);
    try {
      turn.node.appendChild(renderMarkdown(turn.text, doc));
    } catch {
      // md-render is bounded, but a renderer failure must never blank the answer: fall back to text.
      turn.node.appendChild(doc.createTextNode(turn.text));
    }
    if (turn.errorText) {
      const line = el('p', 'cmp-col-error', ctx.errorLineText(turn));
      if (turn.errorTitle) line.title = turn.errorTitle;
      turn.node.appendChild(line);
      turn.errorLine = line; // the ticker rewrites this node's text while a reset countdown runs
    }
    if (turn.stalled) turn.node.appendChild(el('p', 'cmp-col-stalled', cutNote(turn)));
    maybeFollowStream(col, turn);
  }

  // A turn record: `node` is the text node the paints touch (paintAssistant clears and refills it),
  // `root` is what sits in the column body and what a rollback removes — the block wrapping the
  // node together with its copy button, so the button survives every repaint.
  // `kind` (C5): TURN_KIND_SUMMARY marks the two turns of a 「요약·비교」 round — the request folds
  // into a <details> (the attached answers are already on screen in their own columns), the
  // answer wears a badge. Anything else = a plain turn.
  // `extra` (C5 provenance, Codex 3R #1/#2): `round` = the round the turn belongs to (state.roundSeq
  // at send time, or the stored id on reload) — a comparison attaches answers BY ROUND, never "the
  // latest"; `summary` = the structured request (judge, round, question, attachments) a summary
  // turn is REGENERATED from (retry, reload, display), the text itself is never the record;
  // `model` = the served model captured for THIS answer (an attachment is labelled with its own).
  function pushUserTurn(col, text, kind = null, extra = null) {
    const summary = kind === TURN_KIND_SUMMARY;
    let node;
    if (summary) {
      node = el('details', 'cmp-turn cmp-turn-user cmp-turn-summary-req');
      node.appendChild(el('summary', 'cmp-summary-req-title', t('summary_req_summary')));
      node.appendChild(el('pre', 'cmp-summary-req-text', text));
    } else node = el('div', 'cmp-turn cmp-turn-user', text);
    const turn = { role: 'user', text, node, root: null, ...(summary ? { kind: TURN_KIND_SUMMARY } : {}), ...turnExtra(extra) };
    const root = el('div', 'cmp-turn-block cmp-turn-block-user');
    root.appendChild(node);
    root.appendChild(ctx.copyButton(() => turn.text, { kind: COPY_KIND_THREAD, provider: col.provider }));
    turn.root = root;
    col.turns.push(turn);
    col.body.appendChild(root);
  }
  /** The provenance fields of `extra` worth keeping on a turn record: a finite round, a summary structure, a model. */
  function turnExtra(extra) {
    const out = {};
    if (!extra || typeof extra !== 'object') return out;
    if (Number.isFinite(extra.round)) out.round = extra.round;
    if (extra.summary && typeof extra.summary === 'object') out.summary = extra.summary;
    if (extra.model && typeof extra.model === 'object') out.model = { id: extra.model.id == null ? null : String(extra.model.id), label: extra.model.label == null ? '' : String(extra.model.label) };
    return out;
  }
  function pushAssistantTurn(col, kind = null, extra = null) {
    const node = el('div', 'cmp-turn cmp-turn-assistant is-streaming');
    const turn = { role: 'assistant', text: '', node, root: null, copyBtn: null, ...(kind === TURN_KIND_SUMMARY ? { kind: TURN_KIND_SUMMARY } : {}), ...turnExtra(extra) };
    const root = el('div', 'cmp-turn-block cmp-turn-block-assistant');
    if (turn.kind === TURN_KIND_SUMMARY) { root.classList.add('cmp-turn-block-summary'); root.appendChild(el('span', 'cmp-summary-badge', t('summary_badge'))); }
    // The process panel sits above the answer, hidden until the first activity event arrives.
    const activity = ctx.makeActivityPanel();
    root.appendChild(activity.box);
    turn.activity = activity;
    root.appendChild(node);
    // 「답변 복사」 under the answer (item 5): hidden while it streams, shown once the turn settled
    // (DONE / ERROR / ALL_DONE) and only if there is text to copy — an errored turn that never got
    // a chunk has none.
    const copyBtn = ctx.copyButton(() => turn.text, { kind: COPY_KIND_TURN, provider: col.provider, label: t('copy_answer') });
    copyBtn.hidden = true;
    root.appendChild(copyBtn);
    turn.root = root;
    turn.copyBtn = copyBtn;
    col.turns.push(turn);
    col.body.appendChild(root);
    col.status = 'streaming';
    col.errorCode = null;
    col.errorTitle = '';
    col.servedModel = null;
    col.stages = {}; // a fresh round, fresh timers
    // A fresh answer follows again until IT overflows; the send itself brings the column to its
    // new question (a scroll-up before the send is over — the user asked for more).
    col.followAnchored = false;
    col.followTail = false;
    col.userScrolledUp = false;
    scrollColumnToEnd(col);
    renderColumnActions(col);
    // Between SEND and CONSUME_OK the SW is acquiring tabs / running the clients' prepare() step,
    // which can take seconds — say so, rather than "waiting for an answer" that was not asked yet.
    ctx.setBadge(col, 'col_preparing', 'is-streaming');
    return turn;
  }
  function pushSkippedTurn(col) {
    const node = el('div', 'cmp-turn cmp-turn-assistant is-skipped', t('col_skipped'));
    col.turns.push({ role: 'skipped', text: '', node, root: node });
    col.body.appendChild(node);
  }
  /** The turn stopped streaming: offer its copy button when there is something to copy. */
  function settleTurn(turn) {
    if (turn && turn.copyBtn) turn.copyBtn.hidden = !turn.text;
    ctx.syncCopyAll();
  }

  /**
   * The action row under a column's last turn: shown while the column sits in a retriable error
   * (anything but the user's own Stop), with the open-tab link when the tab is what failed.
   * Moved to the end of the body each time so it always follows the LAST turn.
   */
  function renderColumnActions(col) {
    const errored = col.status === 'error' && col.errorCode !== CODE_ABORTED;
    // A STALLED answer (DONE{stalled}, #1519 / §5) is done, but the user may want the whole
    // reply: the plain retry is offered under it with the same gates as an error's — nothing
    // else of the C3 map (those actions answer an error CODE, and there is none).
    const stalled = stalledRetryable(col);
    const show = errored || stalled;
    col.actions.hidden = !show;
    const code = col.errorCode;
    const meta = PROVIDER_META[col.provider];
    // C3 — the action map by error code (see CODE_AUTH_REQUIRED). A gate code hides the retry
    // until a later status read cleared it; a provider-side limit keeps the retry and adds the
    // site link; model_unavailable adds the Auto retry (once per choice, and only when a specific
    // model was chosen — Auto failing again is what the retry is for).
    const gated = errored && GATE_CODES.has(code) && !col.gateCleared;
    const busy = errored && PROVIDER_BUSY_CODES.has(code);
    col.loginLink.hidden = !(gated && code === CODE_AUTH_REQUIRED);
    col.permBtn.hidden = !(gated && code === CODE_PERMISSION_REFUSED);
    col.checkBtn.hidden = !gated;
    // The reason above the buttons: only while the column is showing a readiness failure.
    col.readinessLine.hidden = !(show && col.readiness);
    col.readinessLine.textContent = col.readiness ? col.readiness.text : '';
    col.actionHint.hidden = col.permBtn.hidden;
    if (col.permBtn.hidden) col.actionHint.textContent = '';
    // The open-tab link: 「탭 열기」 for a lost tab, 「탭에서 확인」 for a limit the site itself explains.
    col.openTab.hidden = !(errored && (code === CODE_NO_TAB || busy));
    col.openTab.textContent = t(busy ? 'open_provider_check' : 'open_provider_tab', meta.label);
    // Only when the built picker HAS an Auto option (Codex batch-1 #1): ChatGPT's catalog has no
    // `id:null` entry, so "switch to Auto" would select nothing there and a later MODELS refresh
    // would put the rejected model back — for such a provider the plain retry is the offer.
    const autoOffered = errored && code === CODE_MODEL_UNAVAILABLE && !col.modelWrap.hidden && ctx.hasAutoOption(col) && col.model != null && !col.autoRetried;
    // A retry costs a compare: with none left it is not offered (the open-tab link still is).
    col.retryBtn.hidden = quotaExhausted() || gated || (show && retryPair(col) === null);
    col.autoBtn.hidden = !autoOffered || quotaExhausted();
    // A column without a continuation cannot be sent to once the port was lost or the session
    // resumed (its client is gone; a fresh one would answer without the thread) — the button
    // says why instead of clicking into nothing (batch-3 Codex #3).
    const dead = ctx.columnDead(col);
    col.retryBtn.disabled = state.sending || !ctx.canFollowUp() || dead;
    col.retryBtn.title = dead ? t('retry_needs_new_chat') : '';
    col.autoBtn.disabled = col.retryBtn.disabled;
    col.autoBtn.title = col.retryBtn.title;
    if (show) col.body.appendChild(col.actions);
  }
  /**
   * 「Auto로 바꿔 다시 보내기」 (C3): the pill back to the provider's default — the SAME choice the
   * <select> would make (state.modelChoice[p] = null, `models[p]: null` on the wire, which the SW
   * persists), then the column's retry. Offered once per model choice: a second model_unavailable
   * on Auto is the site's problem, and the plain retry stays for it.
   */
  function retryColumnOnAuto(provider) {
    ctx.noteActivity();
    const col = state.columns.get(provider);
    if (!col || col.autoBtn.hidden || col.autoBtn.disabled) return;
    // The same gates retryColumn applies, BEFORE anything is mutated: a click that could not send
    // (another round in flight, a dead column, no compares left) must not move the pill either
    // (Codex batch-1 guard gap — `disabled` alone is one render behind).
    if (col.status !== 'error' || col.node.hidden || state.sending || !ctx.canFollowUp() || quotaExhausted() || ctx.columnDead(col) || !ctx.hasAutoOption(col)) return;
    col.modelSelect.value = MODEL_AUTO_VALUE;
    col.modelTouched = true;
    ctx.setColumnModel(col, null);
    col.autoRetried = true;
    track('model_change', { provider: col.provider, col: ctx.gaCol(col), model: '', via: SEND_VIA_COLUMN });
    retryColumn(col.id);
  }
  /**
   * The column can take a follow-up of its own (the per-column input is offered): a participant
   * that is on screen, alive (a dead column — port lost, no continuation — cannot be a target,
   * Codex batch-1 #3), not behind an unresolved gate, in a session that can follow up. The same
   * eligibility the C4 head button had, minus "more than one column" (the input is the column's
   * own; it stands with one column too).
   */
  function columnAskable(col) {
    return state.sessionStarted && ctx.canFollowUp() && col.participated && !col.node.hidden && !ctx.columnDead(col) && !ctx.providerUnresolvedGate(col.provider);
  }
  /** The column composer's open state (no eligibility check — the wrapper's visibility is updateControls' call). */
  function setColumnAsk(col, open) {
    col.askOpen = open;
    col.askBox.hidden = !open;
    col.ask.classList.toggle('is-open', open);
    col.askTab.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) autoGrow(col.askInput);
  }
  /** Open / close a column's composer (the tab, Esc); opening focuses its textarea. `open` = force. */
  function toggleColumnAsk(provider, open = null) {
    ctx.noteActivity();
    const col = state.columns.get(provider);
    if (!col) return;
    const next = open === null ? !col.askOpen : !!open;
    if (next && !columnAskable(col)) return;
    setColumnAsk(col, next);
    if (next) ctx.focusQuietly(col.askInput);
  }
  /**
   * Enter in a column's composer: a FOLLOWUP to THIS column only — the same path as the dock
   * (beginSend: readiness → consume → send, a new round, src / session as usual), the dock's
   * routing set and caption untouched. The draft is cleared and the composer folds; a
   * CONSUME_FAIL hands the draft back to this column (pendingFollowupCol).
   */
  function sendColumnFollowup(provider) {
    ctx.noteActivity();
    const col = state.columns.get(provider);
    if (!col) return;
    const text = String(col.askInput.value || '').trim();
    if (!text || state.sending || !columnAskable(col) || quotaExhausted()) return;
    state.pendingFollowup = text;
    state.pendingFollowupCol = col.id;
    col.askInput.value = '';
    autoGrow(col.askInput);
    toggleColumnAsk(col.id, false);
    ctx.beginSend(text, [col.id], 'FOLLOWUP', [], null, null, null, false, SEND_VIA_COLUMN);
  }
  /**
   * The counted (free) quota as clamped finite numbers — `{remaining, limit}` — or null when the
   * answer is not a count (Premium, uncounted, unknown, a non-number). ONE reading for the widget
   * and the gate (Codex U3 1R #4): a value the gate would not act on must not draw as exhausted,
   * and vice versa. `pro` wins over any digits; a negative remaining clamps to 0, one above the
   * limit to the limit; a limit that is not a finite number (off-wire) reads as the remaining
   * itself, so the state is still consistent (0/0 = exhausted, never NaN%).
   */
  function countedQuota(q) {
    if (!q || q.pro || !Number.isFinite(q.remaining)) return null;
    const limit = Math.max(0, Number.isFinite(q.limit) ? q.limit : q.remaining);
    return { limit, remaining: Math.max(0, Math.min(limit, q.remaining)) };
  }
  /** The server said 0 left (a counted quota, not Pro / uncounted) — a send would only CONSUME_FAIL. */
  function quotaExhausted() {
    const c = countedQuota(state.status && state.status.quota);
    return !!c && c.remaining <= 0;
  }
  /**
   * The ONE request/answer pair a retry repeats (Codex 4R blocker): the column's last answer turn
   * — the errored one while the column is in error — and the user turn immediately before it
   * (same round; a first-round answer has none: its request is the question card). Text, kind,
   * structure and round all come from that pair, never from "the last user turn" and "the last
   * answer" separately — a 「전체」 follow-up that SKIPPED this column pushed a user turn with no
   * answer after the error, and pairing across it would resend that question under the old
   * round. A summary request is regenerated from its structure (the stored text may be clipped).
   * null when there is no such pair (no answer turn at all) — then nothing is offered.
   */
  function retryPair(col) {
    let i = col.turns.length - 1;
    while (i >= 0 && col.turns[i].role !== 'assistant') i--;
    if (i < 0) return null;
    const answer = col.turns[i];
    const round = Number.isFinite(answer.round) ? answer.round : null;
    // No round stamp (an entry stored before provenance): a retry REPEATS a round, and there is
    // none to repeat — none is offered (the error line stays). Assigning rounds to legacy turns
    // was the alternative; it would have to agree with roundQuestion / firstRound on entries
    // that never had them, so the safe answer is no retry (Codex page 1R #2).
    if (round === null) return null;
    const req = i > 0 && col.turns[i - 1].role === 'user' ? col.turns[i - 1] : null;
    // No user turn before it: the first SEND round's request is the question card; any other
    // round's request is gone (evicted) and there is nothing to repeat.
    if (!req) return round === state.firstRound ? { text: state.question, kind: null, summary: null, round } : null;
    if (req.kind === TURN_KIND_SUMMARY) {
      if (!req.summary) return null; // a bare-text summary request (no structure) cannot be regenerated
      return { text: ctx.renderSummaryPrompt(req.summary), kind: TURN_KIND_SUMMARY, summary: req.summary, round };
    }
    return { text: req.text, kind: req.kind || null, summary: null, round };
  }
  /**
   * 「이 열만 다시 보내기」: a FOLLOWUP to that one provider with the text it was last asked — the
   * same path as an individual-target follow-up, minus the composer (the SW prepares FOLLOWUP with
   * mayOpenTab:true, so a lost tab is re-opened; a provider limit may simply fail again). Costs a
   * compare, which the label says.
   */
  /**
   * The sentence for an answer that did not finish. ONE chooser, used by all three places that
   * say it (the note under the answer, the badge title, the summary attachment) — three copies of
   * this ternary is how the two cases drift apart.
   */
  function cutNote(turn) { return t(turn && turn.cutError === true ? 'answer_cut_error' : 'answer_stalled'); }

  /** The column's last answer is a stalled one (its retry is offered, see renderColumnActions). */
  function stalledRetryable(col) {
    if (col.status !== 'done') return false;
    const last = ctx.lastAssistantTurn(col);
    return !!last && last.stalled === true && last === col.turns[col.turns.length - 1];
  }
  function retryColumn(provider) {
    ctx.noteActivity();
    const col = state.columns.get(provider);
    if (!col || col.node.hidden) return;
    if (!((col.status === 'error' && col.errorCode !== CODE_ABORTED) || stalledRetryable(col))) return;
    if (state.sending || !ctx.canFollowUp() || quotaExhausted()) return;
    // On a lost port / a resumed session only a column with a continuation can be sent to (D3).
    if (ctx.columnDead(col)) return;
    const pair = retryPair(col);
    if (!pair || !pair.text) return;
    const { text, kind, summary, round } = pair;
    if (kind === TURN_KIND_SUMMARY) state.summaryPending = col.id;
    // A retry REPEATS a round, it does not open one: its turns carry the round of the answer it
    // replaces, so the comparison round still counts this column (a fresh round would silently
    // drop a retried column from the summary — the point of the retry; Codex integration).
    ctx.beginSend(text, [col.id], 'FOLLOWUP', [], kind, summary, round, true);
  }

  /** Back to a column that never took part: empty body, no turns, no badge (new chat). */
  function resetColumn(col) {
    clear(col.body);
    col.turns = [];
    col.qBubble = null; // went with the body (display only — never a turn)
    col.askInput.value = '';
    setColumnAsk(col, false);
    col.followAnchored = false;
    col.followTail = false;
    col.userScrolledUp = false;
    col.jumpBtn.hidden = true;
    col.status = 'idle';
    col.errorCode = null;
    col.errorTitle = '';
    col.participated = false;
    col.round = null;
    col.servedModel = null;
    col.stages = {};
    col.gate = null;
    col.continuation = null;
    col.gateCleared = false;
    col.gateErrorSeq = 0;
    col.autoRetried = false;
    col.copyColBtn.hidden = true;
    col.ask.hidden = true;
    col.askColBtn.hidden = true;
    renderColumnActions(col);
    ctx.setBadge(col, null, '');
  }

  function errorText(provider, code, reason, budgetMs) {
    const label = PROVIDER_META[provider].label;
    if (code === CODE_RATE_LIMITED) return t(PROVIDER_RATE_LIMIT_KEY, label);
    // The timeout names the budget the SW actually applied (ERROR.budgetMs), in whole minutes.
    if (code === CODE_TIMEOUT) return t('err_timeout', Math.max(1, Math.round((Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : DEFAULT_SEND_BUDGET_MS) / MS_PER_MINUTE)));
    // Reason-specific copy first (err_no_tab_load_timeout → "click the tab to wake it"), then the
    // code's, then unknown. Only keys that exist are used, so an unlisted reason is not a hole.
    const specific = reason ? `err_${code}_${reason}` : '';
    if (specific && COMPARE_I18N.en[specific]) return t(specific, label);
    const key = `err_${code}`;
    return t(COMPARE_I18N.en[key] ? key : 'err_unknown', label);
  }

  /** The hover text of an errored column: `<reason>: <detail>` from the ERROR message, bounded; '' when it carried neither. */
  function errorTitle(msg) {
    const reason = typeof msg.reason === 'string' ? msg.reason.trim() : '';
    const detail = typeof msg.detail === 'string' ? msg.detail.trim() : '';
    const text = reason && detail ? `${reason}: ${detail}` : (reason || detail);
    return text.length > ERROR_TITLE_MAX ? `${text.slice(0, ERROR_TITLE_MAX)}…` : text;
  }
  // Everything another file reaches (compare.js destructures the names it calls bare).
  Object.assign(ctx, {
    scheduleRender, scrollMetrics, scrollColumnToEnd, syncJumpButton, maybeFollowStream, paintAssistant, pushUserTurn, turnExtra,
    pushAssistantTurn, pushSkippedTurn, settleTurn, renderColumnActions, retryColumnOnAuto, columnAskable, setColumnAsk, toggleColumnAsk,
    sendColumnFollowup, countedQuota, quotaExhausted, retryPair, cutNote, stalledRetryable, retryColumn, resetColumn,
    errorText, errorTitle,
  });
}
