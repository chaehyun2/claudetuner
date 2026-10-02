// ui/compare/suggest.js — suggested follow-up questions on the round footer (#2026).
//
// Two sources, two rows of chips under the footer's buttons, both behind `compare_suggest`
// (COMPARE_STATUS.suggestOn — on the footer, so also behind `compare_round_footer`):
//
// 1. 「💬 이어서 물어보기」 — once a round the user asked settles, ONE hidden FOLLOWUP{fresh} goes to the
//    service of the column that finished first, in a THROWAWAY TEMPORARY conversation of its own (the SW's
//    freshClients — bg/compare.js): the round's question and that column's answer are quoted in it, then
//    "this question went to <the others> too; give N follow-ups whose answers would differ, as a JSON
//    array". 🔴 Never the column's own conversation (2026-10-03 user: asked there, the request became
//    context for the next real question), and nothing of it stays in the user's provider history. The
//    send is NOT a page round: no turn is drawn, nothing reaches the history entry / export / share, the
//    composer stays usable, `rounds` and the active round do not move. Its port messages are routed here
//    (onSuggestMessage) and read as text. The user's own send always wins: beginSend queues behind it,
//    ABORTs it and goes out when it settles (preemptSuggest). It spends one compare unit and the
//    provider's usage (accepted by the user, 2026-10-02).
// 2. 「🔀 비교에서 나온 질문」 — the 「요약·비교」 prompt (summary.js) asks the judge to end its verdict
//    with SUGGEST markers + questions on where the answers ACTUALLY differ; they are read from the
//    verdict (questionsFromVerdict) and offered
//    as a second row. No extra send.
//
// A chip sends its words to every column that answered (round-footer.js sendChip). The words are an
// AI's — row 1's from the asked column's service, row 2's from the verdict's services — so they carry
// that provenance through the #1985 cross-service gate. 🔴 AI output only ever becomes the TEXT of a
// follow-up and a button label (textContent), never markup.

import { COMPARE_I18N } from '../compare-i18n.js';
import { SEND_KIND_SEND, SEND_KIND_FOLLOWUP, SESSION_ID_RE, SUMMARY_FENCE_OPEN, SUMMARY_FENCE_CLOSE } from './constants.js';

/** The user's switch (options page, chrome.storage.sync — bg/compare.js COMPARE_SUGGEST_ENABLED_KEY; absent = on). */
export const SUGGEST_ENABLED_KEY = 'compareSuggestEnabled';

/** How many questions each row asks for / shows at most. */
export const SUGGEST_COUNT = 5; // 2026-10-02 user: five (was four) — the list folds to SUGGEST_VISIBLE anyway
/** A question's length bounds (characters): shorter is noise, longer is not a chip. */
export const SUGGEST_Q_MIN = 4;
export const SUGGEST_Q_MAX = 140;
/**
 * Questions shown folded: ONE, on the footer's button line right after 「토론 붙이기」, with 「질문 더 보기 (n)」
 * beside it (2026-10-03 user: the two full-width lines + their title line ate the narrow page). Opened, the
 * list takes a line of its own under the buttons, one question per line.
 */
export const SUGGEST_VISIBLE = 1;
/** How much of the round's question / the asked column's answer the throwaway conversation is shown (characters). */
export const SUGGEST_QUESTION_MAX = 1000;
export const SUGGEST_ANSWER_MAX = 6000;
/** The hidden send gives up (ABORT) after this long without settling — the row falls back to nothing. */
export const SUGGEST_TIMEOUT_MS = 90000;
/**
 * After an ABORT, how long the hidden send may take to settle. A provider that does not stop holds the
 * SW's round — and so the port — for good (Codex 1R): the port is then dropped (port.js dropPort → the
 * ordinary port-loss settlement, which ends the SW's clients and their stream), and a user send that was
 * waiting goes its own way after it — a SEND{resume} on a kept session, a refusal with the draft back
 * otherwise. Nothing of the hidden send can reach a user round: its port is gone.
 */
export const SUGGEST_ABORT_GRACE_MS = 12000;
/** The wire kind of the hidden send (bg/compare.js COMPARE_KINDS, worker EVENT_KINDS). */
export const SEND_KIND_SUGGEST = 'suggest';
/** Row 1's state. */
export const SUGGEST_LOADING = 'loading';
export const SUGGEST_READY = 'ready';
export const SUGGEST_FAILED = 'failed';

// The port messages of a round (port.js onPortMessage): while the hidden send is out, these are its.
const ROUND_MSG_TYPES = new Set(['CONSUME_OK', 'CONSUME_FAIL', 'CHUNK', 'IMAGE', 'MODEL', 'DONE', 'ERROR', 'ACTIVITY', 'DIAG', 'ALL_DONE']);

const stripMd = (s) => String(s).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
/** One candidate cleaned: markdown and list marks gone, wrapping quotes gone; null when it is not a question-sized string. */
function cleanQuestion(raw) {
  if (typeof raw !== 'string') return null;
  let q = stripMd(raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''));
  q = q.replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, '').trim();
  if (q.length < SUGGEST_Q_MIN || q.length > SUGGEST_Q_MAX) return null;
  return q;
}
/** The key two questions are "the same" by: lower case, letters and digits only. */
export const questionKey = (q) => String(q).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
/** `list` cleaned, deduplicated (also against `seen` keys), at most SUGGEST_COUNT. */
export function tidyQuestions(list, seen = new Set()) {
  const out = [];
  const keys = new Set(seen);
  for (const raw of Array.isArray(list) ? list : []) {
    const q = cleanQuestion(raw);
    if (!q) continue;
    const k = questionKey(q);
    if (!k || keys.has(k)) continue;
    keys.add(k);
    out.push(q);
    if (out.length >= SUGGEST_COUNT) break;
  }
  return out;
}

/**
 * Row 1's answer → questions: the first JSON array of strings in it (a model may wrap it in a code
 * fence or a sentence), else its list lines. [] when nothing usable came back.
 */
export function parseSuggestions(text) {
  const s = String(text || '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const arr = JSON.parse(s.slice(start, end + 1));
      if (Array.isArray(arr)) { const got = tidyQuestions(arr); if (got.length) return got; }
    } catch { /* not JSON — the lines below */ }
  }
  return tidyQuestions(s.split(/\r?\n/).filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l)));
}

// Row 2: the verdict's marker line (summary_prompt_tail_suggest asks for it in the page language; every
// language's marker is read, like the fact line) and the list under it.
const SUGGEST_MARKERS = Object.values(COMPARE_I18N).map((tbl) => tbl.suggest_marker).filter((m) => typeof m === 'string' && m);
const SUGGEST_MARKER_RE = new RegExp(`^\\s*(?:#+\\s*)?(?:[-*•]\\s*|\\d+[.)]\\s*)?(?:\\*\\*|__)?\\s*(?:${SUGGEST_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')).join('|')})\\s*(?:\\*\\*|__)?\\s*[:：]?\\s*(?:\\*\\*|__)?\\s*$`, 'i');
/** The index of the verdict's LAST marker line, or -1. */
function markerLine(lines) {
  for (let i = lines.length - 1; i >= 0; i--) if (SUGGEST_MARKER_RE.test(lines[i])) return i;
  return -1;
}
const LIST_LINE_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;
/**
 * The question block: its last marker line and the list lines right under it (blank lines between them
 * allowed). `{ at, end }` (end exclusive) or null. Anything after the list — a table, a fact line — is NOT
 * the block (Codex 1R: cutting from the marker to the end hid them).
 */
function questionBlock(lines) {
  const at = markerLine(lines);
  if (at < 0) return null;
  let end = at + 1;
  let lastList = at;
  while (end < lines.length && (LIST_LINE_RE.test(lines[end]) || !lines[end].trim())) { if (LIST_LINE_RE.test(lines[end])) lastList = end; end++; }
  return { at, end: lastList + 1, list: lines.slice(at + 1, lastList + 1).filter((l) => LIST_LINE_RE.test(l)) };
}
/** The questions a verdict ends with (the list right under its last marker line), [] when it has none. */
export function questionsFromVerdict(text) {
  const b = questionBlock(String(text || '').split(/\r?\n/));
  return b ? tidyQuestions(b.list) : [];
}

/**
 * Whether the settled round gets row 1 (the hidden send): the flag; the send that just settled IS the
 * footer's round and was accepted (`accepted`); it was a round the user asked — the composer's SEND /
 * FOLLOWUP or a chip (a summary, a retry, a resume, a debate never); once per round (`tried`); nothing
 * in flight; not in a debate; a live port (a FOLLOWUP must never be a fresh port's first message);
 * at least one column to ask.
 */
export function suggestDecision({ on, round, footerRound, accepted, kind, tried, sending, debate, hasPort, candidates }) {
  if (!on || !Number.isFinite(round) || round !== footerRound || accepted !== round) return false;
  if (kind !== SEND_KIND_SEND && kind !== SEND_KIND_FOLLOWUP) return false;
  if ((tried && tried.has(round)) || sending || debate || !hasPort) return false;
  return candidates > 0;
}

/** The column that finished first (`doneAt`, set at its DONE), of `cols`; ties keep page order. Null when none finished. */
export function firstFinished(cols) {
  let best = null;
  for (const c of cols) if (Number.isFinite(c.doneAt) && (!best || c.doneAt < best.doneAt)) best = c;
  return best;
}

/** Installs the suggest slice onto `ctx` (ctx contract: ui/compare/history.js header). */
export function installSuggest(ctx) {
  const { state, t, el, track, clock } = ctx;
  state.suggest = null; // row 1 of the footer's round: { round, colId, provider, status, questions }
  state.suggestInFlight = null; // the hidden send: { round, colId, provider, text, aborting, queued, timer }
  state.suggestTried = new Set(); // rounds row 1 was attempted for (once each)
  let rows = null;

  // The status says whether the feature is on (flag + the user's setting at the read). A change of the setting while the page
  // is open (options page) applies at once: `prefNow` overrides it, within what the flag allows (`suggestAvailable`).
  let prefNow = null;
  const on = () => {
    const st = state.status;
    if (!st) return false;
    if (prefNow === null) return st.suggestOn === true;
    return prefNow && (st.suggestAvailable === true || st.suggestOn === true);
  };
  const storageEvents = ctx.chrome && ctx.chrome.storage && ctx.chrome.storage.onChanged;
  if (storageEvents && typeof storageEvents.addListener === 'function') {
    storageEvents.addListener((changes, area) => {
      if (area !== 'sync' || !changes || !(SUGGEST_ENABLED_KEY in changes)) return;
      prefNow = changes[SUGGEST_ENABLED_KEY].newValue !== false;
      // Turned off with a hidden send out: it is stopped (nothing waits on it unless a user send queued behind it — that one goes on).
      if (!prefNow && state.suggestInFlight) abortSuggest();
      ctx.renderRoundFooter();
    });
  }
  const busy = () => !!state.suggestInFlight;

  /**
   * The page language's prompt for the throwaway conversation, which knows nothing of the round: the
   * round's question (quoted) and the asked column's answer (fenced as material, never instructions —
   * summary.js's neutraliseAttachment), each bounded, then the request naming the OTHER columns.
   */
  function suggestPrompt(col, others, round) {
    const names = others.map((c) => ctx.colLabel(c)).join(', ');
    const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}…` : s);
    const question = clip(String(ctx.roundQuestion(round) || ''), SUGGEST_QUESTION_MAX);
    const a = ctx.answerInRound(col, round);
    const answer = ctx.neutraliseAttachment(clip(a ? String(a.text) : '', SUGGEST_ANSWER_MAX));
    return [
      t('suggest_prompt_context'),
      ctx.quoteLines(question),
      SUMMARY_FENCE_OPEN(1, ctx.colLabel(col)),
      answer,
      SUMMARY_FENCE_CLOSE(1),
      '',
      t('suggest_prompt', names || t('suggest_prompt_others'), SUGGEST_COUNT),
    ].join('\n');
  }

  /** After a settle (round-footer.js settleRoundFooter, after the automatic summary had its turn). */
  function maybeSuggest(round, accepted, kind) {
    const answered = ctx.footerTargets ? ctx.footerTargets() : [];
    const go = suggestDecision({
      on: on(), round, footerRound: state.footerRound, accepted, kind, tried: state.suggestTried,
      sending: state.sending || busy(), debate: !!(ctx.debateTab() || ctx.debateActive() || state.frozenDebate), hasPort: !!state.port && !state.sessionEnded,
      candidates: answered.length,
    });
    if (!go) return;
    const col = firstFinished(answered) || answered[0];
    if (!col) return;
    state.suggestTried.add(round);
    startSuggest(col, answered.filter((c) => c !== col), round);
  }

  function startSuggest(col, others, round) {
    const port = state.port;
    if (!port) return;
    const text = suggestPrompt(col, others, round);
    const wire = ++state.roundSeq; // a round id of its own for the SW / server statistics — no turn ever carries it
    // `fresh`: the SW asks in a throwaway temporary conversation, never the column's own (see the header).
    const msg = { type: 'FOLLOWUP', text, targets: [col.id], kind: SEND_KIND_SUGGEST, fresh: true, round: wire, columns: ctx.columnsFor([col.id]) };
    if (ctx.src) msg.src = ctx.src;
    if (typeof state.sessionId === 'string' && SESSION_ID_RE.test(state.sessionId)) msg.session = state.sessionId;
    state.suggest = { round, colId: col.id, provider: col.provider, status: SUGGEST_LOADING, questions: [] };
    state.suggestInFlight = { round, colId: col.id, provider: col.provider, text: '', aborting: false, queued: null, timer: null };
    state.suggestInFlight.timer = clock.setTimeout(() => abortSuggest(), SUGGEST_TIMEOUT_MS);
    track('suggest_send', { provider: col.provider, others_n: others.length });
    try { port.postMessage(msg); } catch { settleSuggest(false); return; }
    ctx.renderRoundFooter();
  }

  function abortSuggest() {
    const f = state.suggestInFlight;
    if (!f || f.aborting) return;
    f.aborting = true;
    f.graceTimer = clock.setTimeout(() => { if (state.suggestInFlight === f) ctx.dropPort(true); }, SUGGEST_ABORT_GRACE_MS);
    try { if (state.port) state.port.postMessage({ type: 'ABORT' }); else settleSuggest(false); } catch { settleSuggest(false); }
  }


  /**
   * The hidden send is over (ALL_DONE / CONSUME_FAIL / port gone / 새 대화): row 1 gets its questions
   * (or nothing), and a user send that waited behind it goes out now — unless `dropQueued`.
   */
  function settleSuggest(answered, dropQueued = false) {
    const f = state.suggestInFlight;
    if (!f) return;
    state.suggestInFlight = null;
    if (f.timer != null) clock.clearTimeout(f.timer);
    if (f.graceTimer != null) clock.clearTimeout(f.graceTimer);
    if (state.suggest && state.suggest.round === f.round && state.suggest.status === SUGGEST_LOADING) {
      const qs = answered ? parseSuggestions(f.text) : [];
      state.suggest.status = qs.length ? SUGGEST_READY : SUGGEST_FAILED;
      state.suggest.questions = qs;
      track(qs.length ? 'suggest_ready' : 'suggest_fail', { provider: f.provider, n: qs.length, aborted: f.aborting });
    }
    if (f.queued && !dropQueued) {
      const run = f.queued;
      state.sending = false; // the queued send sets it again in beginSend
      run();
      return;
    }
    if (f.queued) { state.sending = false; ctx.updateControls(); }
    ctx.renderRoundFooter();
  }

  /**
   * port.js: every port message while the hidden send is out. Its round's messages are read here and
   * nothing else sees them (no turn, no badge, no round count); true = consumed.
   */
  function onSuggestMessage(msg) {
    const f = state.suggestInFlight;
    if (!f || !ROUND_MSG_TYPES.has(msg.type)) return false;
    switch (msg.type) {
      case 'CONSUME_OK':
        // The server counted it: the quota line re-reads (a counted account's number moved).
        if (msg.remaining != null) ctx.refreshQuota();
        ctx.startKeepalive();
        return true;
      case 'CHUNK':
        if (!f.aborting) f.text += String(msg.delta || '');
        return true;
      case 'DONE':
        // 🔴 Its text only: the throwaway conversation is no column's — a continuation (none is sent for it) is never taken.
        if (typeof msg.text === 'string' && msg.text && !f.aborting) f.text = msg.text;
        f.done = true;
        return true;
      case 'ERROR':
        f.failed = true;
        return true;
      case 'CONSUME_FAIL':
        settleSuggest(false);
        return true;
      case 'ALL_DONE':
        settleSuggest(!!f.done && !f.failed && !f.aborting);
        return true;
      default:
        return true; // IMAGE / MODEL / ACTIVITY / DIAG of the hidden send: nothing to show
    }
  }

  /**
   * beginSend (port.js) while the hidden send is out: the user's send waits for it — the hidden one is
   * ABORTed and `run` goes out when it settles. The page looks busy meanwhile (no second click).
   */
  function preemptSuggest(run) {
    const f = state.suggestInFlight;
    if (!f) return false;
    f.queued = run;
    state.sending = true;
    ctx.updateControls();
    // Said while it waits, and Stop cancels it (batch review 1.51.0: a provider slow to stop held a summary up to the grace with
    // nothing on screen and no way out). The replay's beginSend clears the notice.
    ctx.showNotice('info', [t('suggest_waiting')]);
    ctx.stopBtn.disabled = false;
    abortSuggest();
    return true;
  }
  /** Stop while a user send waits behind the hidden one (compare.js stop button): the wait is cancelled — nothing goes out, the draft comes back. */
  function cancelQueuedSend() {
    const f = state.suggestInFlight;
    if (!f || !f.queued) return false;
    f.queued = null;
    state.sending = false;
    state.summaryPending = null;
    ctx.restorePendingDraft();
    ctx.clearNotice();
    ctx.stopBtn.disabled = true;
    ctx.updateControls();
    return true;
  }

  /**
   * The port went (port.js settlePortLoss / closePort): the hidden send is over. Returns the user send that
   * waited behind it (the caller runs it once the loss is settled — it finds its own way, a resume or a
   * refusal), or null; `dropQueued` (새 대화) forgets it.
   */
  function suggestPortGone(dropQueued) {
    const f = state.suggestInFlight;
    if (!f) return null;
    const queued = f.queued;
    f.queued = null;
    settleSuggest(false);
    if (queued) { state.sending = false; ctx.updateControls(); }
    return dropQueued ? null : queued;
  }

  // ── the list (2026-10-03 UI): folded = the first SUGGEST_VISIBLE question inline on the button line + 「질문 더 보기」;
  // opened (`is-open`) = a line of its own under the buttons, one question per line. Row 1 and row 2 are one list (row 2's
  // lines carry a 「비교」 tag); each keeps its own group node so the round footer's tests and the provenance stay per source.
  let box = null;
  let moreBtn = null;
  let expandedRound = null; // the footer round whose list the user opened (a new round starts folded)
  /** Built inside the footer, before its note line (round-footer.js buildRoundFooter). */
  function buildSuggestRows(bar, before) {
    box = el('div', 'cmp-suggest');
    box.hidden = true;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', t('suggest_row_own'));
    // Folded: an icon before the one question (its words are the title / label); opened: the title line of the list.
    const title = el('span', 'cmp-suggest-title');
    title.appendChild(el('span', 'cmp-suggest-icon', '💬'));
    title.appendChild(el('span', 'cmp-suggest-title-text', t('suggest_row_own')));
    title.title = t('suggest_row_own');
    box.appendChild(title);
    rows = { own: makeRow('cmp-suggest-row-own', t('suggest_row_own')), cmp: makeRow('cmp-suggest-row-cmp', t('suggest_row_cmp')) };
    box.appendChild(rows.own.node);
    box.appendChild(rows.cmp.node);
    moreBtn = el('button', 'cmp-suggest-more');
    moreBtn.type = 'button';
    moreBtn.hidden = true;
    moreBtn.addEventListener('click', () => { expandedRound = expandedRound === state.footerRound ? null : state.footerRound; renderSuggestRows(state.footerRound, lastVerdict, lastEnabled); });
    // Folded: right after the one question; opened: CSS puts it on the title line (order), not under the list.
    box.appendChild(moreBtn);
    bar.insertBefore(box, before); // after 「토론 붙이기」 on the button line (round-footer.js: `before` = the note line)
  }
  function makeRow(cls, label) {
    const node = el('div', `cmp-suggest-row ${cls}`);
    node.setAttribute('role', 'group');
    node.setAttribute('aria-label', label);
    node.hidden = true;
    return { node, list: node, sig: '' };
  }
  /** One group's lines, rebuilt only when what it shows changed. `tag` = the small label before each line (row 2's 「비교」). */
  function paintRow(row, { loading, questions, provenance, chipId, enabled, tag }) {
    row.node.hidden = !loading && !questions.length;
    if (row.node.hidden) return [];
    const sig = JSON.stringify([loading, questions, provenance]);
    if (sig !== row.sig) {
      row.sig = sig;
      ctx.clear(row.list);
      if (loading) row.list.appendChild(el('span', 'cmp-suggest-loading', t('suggest_loading')));
      for (const q of questions) {
        const b = el('button', 'cmp-suggest-chip');
        b.type = 'button';
        b.title = `${t('suggest_chip_title')}\n${q}`;
        b.setAttribute('data-chip', chipId);
        if (tag) b.appendChild(el('span', 'cmp-suggest-tag', tag));
        b.appendChild(el('span', 'cmp-suggest-text', q));
        b.addEventListener('click', () => ctx.sendChip(chipId, q, provenance));
        row.list.appendChild(b);
      }
    }
    const btns = [...row.list.querySelectorAll('button')];
    for (const b of btns) b.disabled = !enabled;
    return btns;
  }
  let lastVerdict = null;
  let lastEnabled = false;
  /** Every footer render (round-footer.js renderRoundFooter, while the line shows). `verdict` = the round's newest verdict or null. */
  function renderSuggestRows(round, verdict, enabled) {
    if (!rows) return;
    lastVerdict = verdict;
    lastEnabled = enabled;
    const s = on() && state.suggest && state.suggest.round === round ? state.suggest : null;
    const own = s && s.status === SUGGEST_READY ? s.questions : [];
    const a = paintRow(rows.own, { loading: !!s && s.status === SUGGEST_LOADING, questions: own, provenance: s ? [s.provider] : [], chipId: 'suggest', enabled, tag: '' });
    // Row 2: the verdict's questions minus row 1's (the same question is offered once).
    const cmp = on() && verdict ? tidyQuestions(questionsFromVerdict(verdict.text), new Set(own.map(questionKey))) : [];
    const b = paintRow(rows.cmp, { loading: false, questions: cmp, provenance: verdict ? verdict.from : [], chipId: 'suggest_cmp', enabled, tag: t('suggest_tag_cmp') });
    box.hidden = rows.own.node.hidden && rows.cmp.node.hidden;
    // Folded: the first SUGGEST_VISIBLE lines (row 1 first); the rest behind 「더 보기 (n)」.
    const all = [...a, ...b];
    const open = expandedRound === round && all.length > SUGGEST_VISIBLE;
    box.classList.toggle('is-open', open);
    all.forEach((btn, i) => { btn.hidden = !open && i >= SUGGEST_VISIBLE; });
    const extra = all.length - SUGGEST_VISIBLE;
    moreBtn.hidden = extra <= 0;
    if (extra > 0) {
      const label = open ? t('suggest_less') : t('suggest_more', extra);
      if (moreBtn.textContent !== label) moreBtn.textContent = label;
      moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    // A group whose every line is folded away shows nothing (no empty gap).
    for (const r of [rows.own, rows.cmp]) if (!r.node.hidden && r.node.querySelector('button') && ![...r.node.querySelectorAll('button')].some((x) => !x.hidden) && !r.node.querySelector('.cmp-suggest-loading')) r.node.classList.add('is-folded'); else r.node.classList.remove('is-folded');
  }

  /** Row 1's questions of `round` while they are on screen (summary.js lists them as ones row 2 must not repeat), else []. */
  const suggestShownFor = (round) => (on() && state.suggest && state.suggest.round === round && state.suggest.status === SUGGEST_READY ? state.suggest.questions.slice() : []);
  /** 새 대화 / a history load (compare.js resetSession, history.js loadSession): round ids restart, so the left session's row 1 and tried rounds go. */
  function resetSuggest() { state.suggest = null; state.suggestTried = new Set(); expandedRound = null; } // the list folds again too (round ids restart — Codex list 1R)

  Object.assign(ctx, { cancelQueuedSend, resetSuggest, suggestShownFor, suggestOn: on, suggestBusy: busy, maybeSuggest, onSuggestMessage, preemptSuggest, suggestPortGone, buildSuggestRows, renderSuggestRows });
}
