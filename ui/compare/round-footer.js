// ui/compare/round-footer.js — the round footer of mountComparePage() (#1976, plan
// docs/plans/compare-round-footer.md §9): one line under a SETTLED comparison round that offers the
// next step — 「✨ 차이점 정리」 (the 「요약·비교」 popover, opened from here) and fixed follow-up chips
// that send their own words to every column that answered.
//
// When it shows (R1): a round is judged only when it SETTLES (port.js finishSend — ALL_DONE,
// CONSUME_FAIL and a lost port all end there), never while answers stream in. The settled round must
// be the active (non-summary) round and hold answers from at least SUMMARY_MIN_COLUMNS columns. It
// stays while a summary of that round runs and after it (the summary moves no active round, R8);
// it goes when a new non-summary round is accepted. Never in the debate tab, never without the
// `compare_round_footer` flag (COMPARE_STATUS.roundFooterOn — the kill switch).
//
// A chip (R2/R3) goes to the columns that answered the round AND can be sent to now — the same
// resend rule as a 「전체」 follow-up (resendable), minus a provider behind a sign-in gate, minus a
// column without a continuation on a resumed session. It reads and writes nothing of the dock: not
// the routing boxes, not the draft, not the tray (SEND_VIA_CHIP — attachments.js), and a refused
// chip is not put back into the composer (no pendingFollowup).
//
// The pure rules are exported for the guard (test/compare-round-footer-guard.mjs); ctx contract:
// see ui/compare/history.js.

import { mayDirectSummarize } from './summary.js';
import { FOLLOWUP_RESEND_CODES, CODE_ABORTED, SUMMARY_MIN_COLUMNS, SEND_KIND_SUMMARY, SEND_KIND_SEND, SEND_KIND_FOLLOWUP, FACT_CHIP_MAX, FACT_CHIP_LABEL_MAX, SEND_VIA_CHIP, TURN_KIND_SUMMARY, MAX_COLUMNS, normalizeColId, DEBATE_HANDOFF_KEY, DEBATE_HANDOFF_PARAM, DEBATE_HANDOFF_TTL_MS, DEBATE_HANDOFF_ID_RE, DEBATE_HANDOFF_ID_LEN, DEBATE_HANDOFF_WRITE_MS, SHARE_SITE_ORIGIN, MULTIAI_DEBATE_PATH, CWS_EXT_ID } from './constants.js';
import { MODE_DEBATE, DEBATE_TOPIC_MAX } from './debate-core.js';
import { autoGrow } from './helpers.js';
import { usagePeak, USAGE_FLOOR_PCT } from './usage-floor.js';
import { COMPARE_I18N } from '../compare-i18n.js';
import { foldSaveBy, isSaveBy, normalizeSaveBy, uniformSaveBy, SAVE_MODE_KEPT } from './save-mode.js';

/** The fixed chips, in order (§9.4 decision 1: two). `key` is both the label and the prompt, in the page language. */
export const FOOTER_CHIPS = Object.freeze([
  Object.freeze({ id: 'sources', key: 'chip_sources' }),
  Object.freeze({ id: 'brief', key: 'chip_brief' }),
]);

/**
 * 🔴 A ChatGPT column STOPPED during its first answer has no conversation to continue: the client
 * records `conversation_id` only when a stream completes (vendor-ai chatgpt-client), so a follow-up
 * would open a new, context-less conversation — shown as this thread's next turn and charged
 * (1.37.0 batch review; #1757 made stopped columns resendable). Claude creates its conversation
 * before streaming and Gemini records its ids mid-stream, so theirs continue; a ChatGPT column with
 * an earlier completed answer continues too.
 */
export function threadless(c) {
  return c.provider === 'chatgpt' && c.status === 'error' && c.errorCode === CODE_ABORTED
    && !c.turns.some((turn) => turn.role === 'assistant' && !turn.errorText);
}

/**
 * The 「전체」 follow-up's resend rule (AC21): a column whose error a resend cannot cure (sign-in,
 * provider limits, timeouts) is skipped; a lost tab, a Stop and a restored error line are cured by
 * the resend itself (FOLLOWUP_RESEND_CODES). One predicate for compare.js followupPlan and the chips.
 */
export function resendable(c) {
  return (c.status !== 'error' || FOLLOWUP_RESEND_CODES.has(c.errorCode)) && !threadless(c);
}

/**
 * The chip's targets: of `answered` (the columns holding an answer in the footer's round, page
 * order), those that can be sent to now; the rest are `skipped` (drawn 「건너뜀」, like a 「전체」
 * follow-up). `gated(c)` = its provider is behind an unresolved sign-in gate; `needContinuation` =
 * the session was resumed (or is resumable), so a column without a continuation has no client.
 */
export function chipTargets(answered, { gated = () => false, needContinuation = false } = {}) {
  const targets = [];
  const skipped = [];
  for (const c of answered) {
    if (!gated(c) && resendable(c) && !(needContinuation && !c.continuation)) targets.push(c.id);
    else skipped.push(c.id);
  }
  return { targets, skipped };
}

/**
 * The round the footer belongs to, judged at a settle: the active round when it holds at least
 * SUMMARY_MIN_COLUMNS answered columns, else none. `answeredCount(round)` counts them.
 */
export function footerRoundAtSettle(activeRound, answeredCount) {
  return Number.isFinite(activeRound) && answeredCount(activeRound) >= SUMMARY_MIN_COLUMNS ? activeRound : null;
}

/**
 * Whether the line is on screen. `inFlightKind` = the wire kind of the round in flight (state.roundKind
 * while `sending`): only a summary of the footer's round leaves the line up while it runs — any other
 * send hides it until it settles (R1: never a line over answers still streaming).
 */
export function footerVisible({ flagOn, debate, sessionStarted, footerRound, activeRound, sending, inFlightKind, answeredCount }) {
  if (!flagOn || debate || !sessionStarted || !Number.isFinite(footerRound) || footerRound !== activeRound) return false;
  if (sending && inFlightKind !== SEND_KIND_SUMMARY) return false;
  return answeredCount >= SUMMARY_MIN_COLUMNS;
}

/**
 * Whether a chip may be pressed now (R2/R8): nothing in flight, a live follow-up path that is NOT a
 * resume (a resume has its own cost copy — the chip would hide it), a compare left, no link being
 * read, at least one target.
 */
export function chipsEnabled({ sending, canFollowUp, sessionEnded, quotaExhausted, linkReading, targetsN }) {
  return !sending && !!canFollowUp && !sessionEnded && !quotaExhausted && !linkReading && targetsN > 0;
}

/**
 * The one-shot debate handoff (#1976 stage 3) — what the cross-check tab writes to
 * chrome.storage.session: the topic, the cast (colIds) and whether the session was incognito.
 */
export function makeDebateHandoff({ id, now, topic, cols, saveBy }) {
  // #1985: the session's per-service map rides as is; `incognito` (any provider incognito) stays for GA and an old reader.
  const sb = isSaveBy(saveBy) ? normalizeSaveBy(saveBy, false) : uniformSaveBy(false);
  return { id, at: now, topic: String(topic || ''), cols: cols.slice(0, MAX_COLUMNS), incognito: foldSaveBy(sb) !== SAVE_MODE_KEPT, saveBy: { ...sb } };
}
/** The storage key of one handoff (one per click — Codex 3단계 1R: a shared key let a second bridge overwrite the first). */
export const debateHandoffKey = (id) => `${DEBATE_HANDOFF_KEY}:${id}`;
/** A question the debate can take as its topic (debate.js start refuses one over DEBATE_TOPIC_MAX). */
export const bridgeableTopic = (topic) => { const s = String(topic || '').trim(); return s.length > 0 && s.length <= DEBATE_TOPIC_MAX; };
/**
 * The handoff the debate tab may apply: the stored entry when it is THIS tab's (`id`), fresh
 * (DEBATE_HANDOFF_TTL_MS) and well-formed; null otherwise. Nothing is repaired — a malformed entry is
 * dropped, and the tab opens as a plain debate tab.
 */
export function readDebateHandoff(stored, id, now) {
  if (!stored || typeof stored !== 'object' || typeof id !== 'string' || !DEBATE_HANDOFF_ID_RE.test(id) || stored.id !== id) return null;
  if (typeof stored.at !== 'number' || now - stored.at > DEBATE_HANDOFF_TTL_MS || stored.at - now > DEBATE_HANDOFF_TTL_MS) return null;
  if (typeof stored.topic !== 'string' || !bridgeableTopic(stored.topic) || typeof stored.incognito !== 'boolean' || !Array.isArray(stored.cols)) return null;
  const cols = stored.cols.map(normalizeColId).filter(Boolean).filter((c, i, a) => a.indexOf(c) === i).slice(0, MAX_COLUMNS);
  if (cols.length < SUMMARY_MIN_COLUMNS) return null;
  // A map that is not a SaveBy (an entry from before #1985) → the boolean for every provider.
  const saveBy = isSaveBy(stored.saveBy) ? normalizeSaveBy(stored.saveBy, false) : uniformSaveBy(!stored.incognito);
  return { topic: stored.topic, cols, incognito: foldSaveBy(saveBy) !== SAVE_MODE_KEPT, saveBy };
}
/**
 * The new tab: the site's debate shell, the handoff id in the FRAGMENT (never sent to a server or analytics),
 * `?ext=` only for an unpacked build — 🔴 never the topic or the cast. The shell frames compare.html with
 * `mode=debate` (its path) and passes the validated id on; the page's language is the shell's own.
 */
export function debateHandoffUrl(id, extId) {
  const u = new URL(MULTIAI_DEBATE_PATH, SHARE_SITE_ORIGIN);
  if (extId && extId !== CWS_EXT_ID) u.searchParams.set('ext', extId);
  u.hash = new URLSearchParams({ [DEBATE_HANDOFF_PARAM]: id }).toString();
  return u.toString();
}

/**
 * Should the settled round be summarised automatically (stage 4, §3.5 / R5)? 'run', 'busy' (skipped —
 * the judge is near its limit; the line says so) or null (not this round). Once per session × comparison
 * round (`tried`), only when the send that settled IS that round and was accepted (`accepted`), only after a round the user asked (the composer's SEND / FOLLOWUP — never a summary, a
 * retry, a resume or a chip round), only with the setting on AND consent for the judge's provider.
 */
export function autoSummaryDecision({ autorun, round, accepted, tried, kind, via, consented, allowed, judgePeak }) {
  if (!autorun || !Number.isFinite(round) || (tried && tried.has(round))) return null;
  // The send that just settled must be THIS round, accepted (Codex 4단계 1R: a refused follow-up settles
  // too — finishSend — while the previous round is still the active one; it must not summarise that).
  if (accepted !== round) return null;
  if (kind !== SEND_KIND_SEND && kind !== SEND_KIND_FOLLOWUP) return null;
  if (via === SEND_VIA_CHIP || !consented || !allowed) return null;
  if (typeof judgePeak === 'number' && judgePeak >= USAGE_FLOOR_PCT) return 'busy';
  return 'run';
}

// The verdict's fact line (stage 4, §3.3): the summary prompt asks the judge to start it with the
// `fact_marker` of the page language (summary_prompt_tail, ko/en); a judge that answers in the other
// language is read too — so every language's marker is accepted, whatever the page speaks.
const FACT_MARKERS = Object.values(COMPARE_I18N).map((tbl) => tbl.fact_marker).filter((m) => typeof m === 'string' && m);
const FACT_LINE_RE = new RegExp(`^\\s*(?:[-*•]\\s*|\\d+[.)]\\s*)?(?:\\*\\*|__)?\\s*(?:${FACT_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')).join('|')})\\s*(?:\\*\\*|__)?\\s*[:：]\\s*(?:\\*\\*|__)?\\s*(.+?)\\s*$`, 'i');
/**
 * The 「확인할 사실」 of a verdict, as plain text, or null: the LAST line carrying the marker; markdown
 * emphasis / code / link syntax stripped; at most FACT_CHIP_MAX characters (longer = not a one-line fact).
 * 🔴 AI output: it only ever becomes the words of a follow-up (text), never markup.
 */
export function factFromVerdict(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = FACT_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const plain = m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
    if (plain.length < 2 || plain.length > FACT_CHIP_MAX) return null;
    return plain;
  }
  return null;
}
/** The chip's face: the fact cut to FACT_CHIP_LABEL_MAX with an ellipsis (the title keeps it whole). */
export const factChipLabel = (fact) => (fact.length > FACT_CHIP_LABEL_MAX ? `${fact.slice(0, FACT_CHIP_LABEL_MAX - 1)}…` : fact);

/** Installs the round-footer slice onto `ctx` (ctx contract: ui/compare/history.js header). */
export function installRoundFooter(ctx) {
  const { t, state, track, el } = ctx;
  let bar = null;
  let summarizeBtn = null;
  let judgeBtn = null; // 「<판정 AI>가 판정 ▾」 — the judge the click would use; opens the popover to change it (stage 2)
  const chipBtns = [];
  let bridgeBtn = null;
  let factBtn = null;
  let factNow = null; // the fact the fact chip would ask about now
  let factFrom = []; // #1985: the services whose words that verdict was made of (its attachments + its judge)
  let consentRow = null; // #1985 §3.4.5-3: the chip's inline consent card (under the chips)
  let noteLine = null; // 「<AI> 사용량이 많아 자동 정리를 건너뛰었어요」
  let bridging = false; // a bridge click is writing its handoff — a second click waits (one new tab per click)
  /** chrome.storage.session, or null (an older browser / a context without it — the bridge is then not offered). */
  const sessionArea = () => (ctx.chrome && ctx.chrome.storage && ctx.chrome.storage.session && typeof ctx.chrome.storage.session.set === 'function' ? ctx.chrome.storage.session : null);

  const flagOn = () => !!(state.status && state.status.roundFooterOn === true);
  /** The judge 「차이점 정리」 would use now (summary.js judgeDefault over the candidates), or null. */
  const defaultJudge = () => { const cands = ctx.judgeCandidates(); return cands.length ? ctx.judgeDefault(cands) : null; };
  const inDebate = () => !!(ctx.debateTab() || ctx.debateActive() || state.frozenDebate);
  /** Live, reachable columns holding a real answer in `round` (summary.js answerInRound — the same evidence 「요약·비교」 attaches). */
  const answeredIn = (round) => ctx.liveColumns().filter((c) => !ctx.columnDead(c) && ctx.answerInRound(c, round) !== null);
  /** A summary of `round` was already asked in this session (any column) — the button then says 「다시 정리」. */
  const summarized = (round) => ctx.liveColumns().some((c) => c.turns.some((turn) => turn.kind === TURN_KIND_SUMMARY && turn.role === 'user' && turn.summary && turn.summary.round === round));
  const targetsNow = () => chipTargets(answeredIn(state.footerRound), { gated: (c) => ctx.providerUnresolvedGate(c.provider), needContinuation: ctx.canResume() || state.resumed });

  /** Built once, right above the dock's follow-up composer (compare.js calls it after the dock exists). */
  function buildRoundFooter() {
    bar = el('div', 'cmp-round-footer');
    bar.id = 'cmp-round-footer';
    bar.hidden = true;
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', t('footer_label'));
    summarizeBtn = el('button', 'cmp-btn cmp-btn-sm cmp-round-footer-summary', t('footer_summarize'));
    summarizeBtn.id = 'cmp-footer-summary';
    summarizeBtn.type = 'button';
    summarizeBtn.title = t('footer_summarize_title');
    summarizeBtn.setAttribute('aria-haspopup', 'dialog');
    summarizeBtn.setAttribute('aria-expanded', 'false');
    // Stage 2 (R4): with consent for the default judge's provider the click sends at once; without it
    // the popover asks (and offers the consent box). The ▾ beside it always opens the popover.
    summarizeBtn.addEventListener('click', () => {
      if (!ctx.summaryPop.hidden && ctx.summaryOpener() === summarizeBtn) { ctx.closeSummaryPop(); return; }
      const judge = defaultJudge();
      const jc = judge ? ctx.judgeColumn(judge) : null;
      if (jc && mayDirectSummarize(state.summaryConsent, jc.provider)) ctx.startSummary(judge);
      else ctx.openSummaryPop(summarizeBtn);
    });
    bar.appendChild(summarizeBtn);
    judgeBtn = el('button', 'cmp-btn cmp-btn-sm cmp-round-footer-judge');
    judgeBtn.id = 'cmp-footer-judge';
    judgeBtn.type = 'button';
    judgeBtn.setAttribute('aria-haspopup', 'dialog');
    judgeBtn.setAttribute('aria-expanded', 'false');
    judgeBtn.addEventListener('click', () => {
      if (!ctx.summaryPop.hidden && ctx.summaryOpener() === judgeBtn) ctx.closeSummaryPop();
      else ctx.openSummaryPop(judgeBtn);
    });
    bar.appendChild(judgeBtn);
    for (const chip of FOOTER_CHIPS) {
      const b = el('button', 'cmp-btn cmp-btn-sm cmp-round-footer-chip', t(chip.key));
      b.type = 'button';
      b.title = t('chip_title');
      b.setAttribute('data-chip', chip.id);
      b.addEventListener('click', () => sendChip(chip.id, t(chip.key)));
      chipBtns.push(b);
      bar.appendChild(b);
    }
    // 「확인해 줘: …」 (stage 4, `compare_fact_chip`): the verdict's own fact line, when there is one.
    factBtn = el('button', 'cmp-btn cmp-btn-sm cmp-round-footer-fact');
    factBtn.type = 'button';
    factBtn.setAttribute('data-chip', 'fact');
    factBtn.hidden = true;
    // 🔴 #1985: the fact is the JUDGE's words made from the attached answers — not the user's — so it carries
    // their services as provenance through the gate (Codex plan 1R blocker 2).
    factBtn.addEventListener('click', () => { if (factNow) sendChip('fact', t('chip_fact_prompt', factNow), factFrom); });
    bar.appendChild(factBtn);
    // 「🗣 토론 붙이기」 (stage 3): the same question as a debate, in a new tab — this session stays as it is.
    bridgeBtn = el('button', 'cmp-btn cmp-btn-sm cmp-round-footer-bridge', t('chip_debate'));
    bridgeBtn.type = 'button';
    bridgeBtn.title = t('chip_debate_title');
    bridgeBtn.setAttribute('data-chip', 'debate');
    bridgeBtn.addEventListener('click', bridgeToDebate);
    bar.appendChild(bridgeBtn);
    noteLine = el('span', 'cmp-round-footer-note');
    noteLine.hidden = true;
    bar.appendChild(noteLine);
    // #2026: the suggested-question rows (suggest.js), each on a line of its own above the note.
    if (ctx.buildSuggestRows) ctx.buildSuggestRows(bar, noteLine);
    consentRow = el('div', 'cmp-round-footer-consent');
    consentRow.setAttribute('role', 'group');
    consentRow.hidden = true;
    bar.appendChild(consentRow);
    ctx.dock.insertBefore(bar, ctx.followup.section);
    Object.assign(ctx, { roundFooter: bar, roundFooterSummary: summarizeBtn });
  }

  /** A round settled (port.js finishSend): the footer is re-judged — the only place it is (R1). */
  function settleRoundFooter() {
    const before = state.footerRound;
    state.footerRound = footerRoundAtSettle(state.activeRound, (r) => answeredIn(r).length);
    if (state.footerRound !== before) state.autoSkipNote = null;
    // After the settle has run its course (finishSend still paints and persists): the automatic summary, once.
    const round = state.footerRound;
    // Pinned now and CONSUMED (Codex 4단계 2R): an accepted round is judged at its own settle only — a later
    // finishSend with nothing new accepted (a port lost while idle re-settles) finds null and starts nothing.
    const accepted = state.acceptedRound;
    state.acceptedRound = null;
    const kind = state.roundKind; // the settled send's kind, read now (a later send replaces it)
    // The automatic summary first: when it starts, the hidden suggestion send stands aside (its verdict brings row 2).
    if (Number.isFinite(round)) ctx.clock.setTimeout(() => { maybeAutoSummarize(round, accepted); if (ctx.maybeSuggest) ctx.maybeSuggest(round, accepted, kind); }, 0);
  }

  /** The automatic summary (stage 4, R5) — re-judged at the moment it would send. */
  function maybeAutoSummarize(round, accepted) {
    if (!Number.isFinite(round) || round !== state.footerRound || round !== state.activeRound || state.sending || inDebate() || !flagOn() || !ctx.summaryOn()) return;
    const judge = defaultJudge();
    const jc = judge ? ctx.judgeColumn(judge) : null;
    const entry = jc && state.status && state.status.providers ? state.status.providers[jc.provider] : null;
    const decision = autoSummaryDecision({
      autorun: state.summaryAutorun === true, round, accepted, tried: state.autoSummaryTried, kind: state.roundKind, via: state.roundVia,
      consented: !!jc && mayDirectSummarize(state.summaryConsent, jc.provider), allowed: ctx.summaryAllowed(), judgePeak: entry ? usagePeak(entry.usage) : null,
    });
    if (!decision) return;
    state.autoSummaryTried.add(round); // spent at the attempt — a refused or failed run is not retried (R5)
    if (decision === 'busy') { state.autoSkipNote = t('footer_auto_skipped', ctx.colLabel(jc)); track('summary_auto_skip', { judge: jc.provider }); renderRoundFooter(); return; }
    ctx.startSummary(judge, true);
  }

  /** The newest settled verdict of a summary of `round` (its text), or null. */
  function verdictOf(round) {
    let best = null;
    for (const col of ctx.liveColumns()) {
      for (let i = 0; i + 1 < col.turns.length; i++) {
        const req = col.turns[i];
        const ans = col.turns[i + 1];
        if (req.role === 'user' && req.kind === TURN_KIND_SUMMARY && req.summary && req.summary.round === round && ans.role === 'assistant' && ans.kind === TURN_KIND_SUMMARY && ans.settled && ans.text && !ans.errorText) {
          if (!best || (Number.isFinite(ans.round) && ans.round > best.round)) best = { round: ans.round, text: ans.text, col: col.id, from: [col.provider, ...(Array.isArray(req.summary.attachments) ? req.summary.attachments.map((a) => a.provider) : [])] };
        }
      }
    }
    return best;
  }

  function renderRoundFooter() {
    if (!bar) return;
    const round = state.footerRound;
    const visible = footerVisible({
      flagOn: flagOn(), debate: inDebate(), sessionStarted: state.sessionStarted, footerRound: round, activeRound: state.activeRound,
      sending: state.sending, inFlightKind: state.roundKind, answeredCount: Number.isFinite(round) ? answeredIn(round).length : 0,
    });
    bar.hidden = !visible;
    if (!visible) {
      hideChipConsent();
      if (!ctx.summaryPop.hidden && (ctx.summaryOpener() === summarizeBtn || ctx.summaryOpener() === judgeBtn)) ctx.closeSummaryPop();
      return;
    }
    if (state.footerShownRound !== round) { state.footerShownRound = round; track('round_footer_shown', { answers_n: answeredIn(round).length }); }
    // 「차이점 정리」 rides the 「요약·비교」 gates (R7: dark without `compare_summary`).
    summarizeBtn.hidden = !ctx.summaryOn();
    summarizeBtn.disabled = !ctx.summaryAllowed();
    const label = t(summarized(round) ? 'footer_resummarize' : 'footer_summarize');
    if (summarizeBtn.textContent !== label) summarizeBtn.textContent = label;
    const judge = defaultJudge();
    const jc = judge ? ctx.judgeColumn(judge) : null;
    judgeBtn.hidden = summarizeBtn.hidden || !jc;
    judgeBtn.disabled = summarizeBtn.disabled;
    const jl = jc ? t('footer_judge', ctx.colLabel(jc)) : '';
    if (judgeBtn.textContent !== jl) judgeBtn.textContent = jl;
    const enabled = chipsEnabled({ sending: state.sending, canFollowUp: ctx.canFollowUp(), sessionEnded: state.sessionEnded, quotaExhausted: ctx.quotaExhausted(), linkReading: state.linkReading, targetsN: targetsNow().targets.length });
    for (const b of chipBtns) b.disabled = !enabled;
    // The fact chip: behind `compare_fact_chip` (COMPARE_STATUS.factChipOn), from the round's newest verdict.
    const verdict = state.status && state.status.factChipOn === true ? verdictOf(round) : null;
    factNow = verdict ? factFromVerdict(verdict.text) : null;
    factFrom = verdict ? verdict.from : [];
    // With the suggested questions on, the fact leads their list instead (suggest.js paintFact — one chip on the line, not two).
    const factInList = !!factNow && !!ctx.renderSuggestRows && ctx.suggestOn();
    factBtn.hidden = !factNow || factInList;
    if (factNow && !factInList) {
      const label = t('chip_fact', factChipLabel(factNow));
      if (factBtn.textContent !== label) factBtn.textContent = label;
      factBtn.title = `${t('chip_fact_title')}\n${factNow}`;
      factBtn.disabled = !enabled;
    }
    if (ctx.renderSuggestRows) ctx.renderSuggestRows(round, ctx.suggestOn() ? verdictOf(round) : null, enabled, factInList ? { text: factNow, from: factFrom } : null);
    noteLine.hidden = !state.autoSkipNote;
    noteLine.textContent = state.autoSkipNote || '';
    // The bridge sends nothing (a new tab, its own session): offered with the debate (`compare_debate`) and a session store.
    bridgeBtn.hidden = !(ctx.debateOn() && sessionArea() && ctx.chrome.tabs && typeof ctx.chrome.tabs.create === 'function');
    // A question the debate could not take (over DEBATE_TOPIC_MAX) is not bridged: the button says why.
    const topicOk = bridgeableTopic(state.question);
    bridgeBtn.disabled = state.sending || bridging || !topicOk;
    bridgeBtn.title = topicOk ? t('chip_debate_title') : t('debate_topic_long', DEBATE_TOPIC_MAX);
  }

  /** A random handoff id (crypto when present). */
  function handoffId() {
    const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const out = [];
    const c = ctx.win && ctx.win.crypto && typeof ctx.win.crypto.getRandomValues === 'function' ? ctx.win.crypto : (typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : null);
    const bytes = c ? c.getRandomValues(new Uint8Array(DEBATE_HANDOFF_ID_LEN)) : Array.from({ length: DEBATE_HANDOFF_ID_LEN }, () => Math.floor(ctx.random() * 256));
    for (const b of bytes) out.push(abc[b % abc.length]);
    return out.join('');
  }

  /**
   * 「🗣 토론 붙이기」 (R6, §9.4-3): the session's question and the columns that answered go to a NEW tab as a
   * debate — through a one-shot chrome.storage.session entry, never the URL. An incognito session opens an
   * incognito debate. This tab, its session and its port are left exactly as they are.
   */
  function bridgeToDebate() {
    ctx.noteActivity();
    const area = sessionArea();
    if (!area || state.sending || bridging || !ctx.debateOn()) return;
    const cols = answeredIn(state.footerRound).map((c) => c.id);
    // The SESSION's question — the round's own request may be a follow-up or a chip's words.
    const topic = String(state.question || '').trim();
    if (!bridgeableTopic(topic) || cols.length < SUMMARY_MIN_COLUMNS) return;
    const id = handoffId();
    // #1985: the session's map (an unknown session → all incognito, the safe side).
    const saveBy = state.sessionSaveBy || uniformSaveBy(false);
    const incognito = foldSaveBy(saveBy) !== SAVE_MODE_KEPT;
    const entry = makeDebateHandoff({ id, now: ctx.clock.now(), topic, cols, saveBy });
    bridging = true;
    renderRoundFooter();
    // The tab opens only once the entry is stored (Codex 3단계 1R 후속: a failed write opened an empty debate).
    const written = (ok) => {
      bridging = false;
      if (ok) {
        try { ctx.chrome.tabs.create({ url: debateHandoffUrl(id, ctx.chrome.runtime.id) }); } catch { /* tabs API gone */ }
        track('debate_bridge', { cols_n: cols.length, incognito });
      }
      renderRoundFooter();
    };
    try {
      let settled = false;
      const once = (ok) => { if (!settled) { settled = true; written(ok); } };
      // A store that never answers must not lock the button for good (Codex 3단계 2R 후속): give up — no tab.
      ctx.clock.setTimeout(() => once(false), DEBATE_HANDOFF_WRITE_MS);
      const r = area.set({ [debateHandoffKey(id)]: entry }, () => once(!(ctx.chrome.runtime && ctx.chrome.runtime.lastError)));
      if (r && typeof r.then === 'function') r.then(() => once(true), () => once(false));
    } catch { written(false); }
  }

  /**
   * The debate tab opened by a bridge (boot, before the first status builds the columns): the entry
   * named by `?handoff=` is read ONCE and removed, then applied — the cast as this tab's debate layout
   * (in memory: the user's stored layout is not overwritten unless they edit it), the topic in the box,
   * 시크릿 대화 on when the cross-check was. Resolves either way; a missing / stale entry changes nothing.
   */
  function takeDebateHandoff() {
    const id = ctx.params && typeof ctx.params.get === 'function' ? ctx.params.get(DEBATE_HANDOFF_PARAM) : null;
    const area = sessionArea();
    if (!id || !area || !DEBATE_HANDOFF_ID_RE.test(id)) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (got) => {
        if (done) return;
        done = true;
        void (ctx.chrome.runtime && ctx.chrome.runtime.lastError);
        const stored = got && got[debateHandoffKey(id)];
        if (stored) { try { area.remove(debateHandoffKey(id)); } catch { /* best effort */ } }
        const h = readDebateHandoff(stored, id, ctx.clock.now());
        if (h) {
          state.storedLayouts[MODE_DEBATE] = h.cols;
          state.storedSeat = null; // the cast is the cross-check's columns: no seat from an earlier debate (the default moderator rule picks)
          state.debateFromHandoff = true; // a chosen AI moderator outside this cast gives way to the default (debate.js modChoice)
          ctx.qInput.value = h.topic;
          autoGrow(ctx.qInput);
          // Both ways, and fixed (Codex 3단계 1R): the status read that follows must not put the stored default over it.
          state.saveBy = h.saveBy;
          state.saveTouched = true;
          state.saveByOnce = true; // the new debate's own session only — never written as the preference
          track('debate_bridge_open', { cols_n: h.cols.length, incognito: h.incognito });
        }
        resolve(!!h);
      };
      try { const r = area.get(debateHandoffKey(id), finish); if (r && typeof r.then === 'function') r.then(finish, () => finish(null)); } catch { finish(null); }
    });
  }

  /** A chip: its words, now, to every column that answered and can take it — nothing of the dock moves. */
  // `id` = the chip (GA, never its words); `text` = what it sends — a fixed chip's label, or the fact chip's prompt.
  // `provenance` (#1985): the services whose words the chip's text came from (the fact chip's verdict); the
  // fixed chips are our own words → []. The TARGETS are recomputed at the click (and at the consent's answer).
  function sendChip(id, text, provenance = [], only = null) {
    ctx.noteActivity();
    hideChipConsent();
    let { targets, skipped } = targetsNow();
    if (only) { skipped = skipped.concat(targets.filter((x) => !only.includes(x))); targets = targets.filter((x) => only.includes(x)); }
    if (!chipsEnabled({ sending: state.sending, canFollowUp: ctx.canFollowUp(), sessionEnded: state.sessionEnded, quotaExhausted: ctx.quotaExhausted(), linkReading: state.linkReading, targetsN: targets.length })) return;
    if (ctx.debateActive() || ctx.debateTab()) return;
    const pending = ctx.crossPendingFor(provenance, targets);
    if (pending.length) { askChipConsent(id, text, provenance, targets, pending); return; }
    track('chip_click', { chip: id, targets_n: targets.length });
    const refused = ctx.beginSend(text, targets, 'FOLLOWUP', skipped, null, null, null, false, SEND_VIA_CHIP, null, provenance);
    if (refused && refused.consent) askChipConsent(id, text, provenance, targets, refused.consent);
  }
  /**
   * The chip's inline card (#1985 §3.4.5-3): agree → the same chip again; 「시크릿 서비스에만 보내기」 → the
   * chip to the targets whose history would NOT keep it (the leaking kept columns left out); cancel → nothing.
   */
  function askChipConsent(id, text, provenance, targets, pairs) {
    const leakTo = new Set(pairs.map((x) => x.to));
    const rest = targets.filter((x) => !leakTo.has((state.columns.get(x) || {}).provider));
    const actions = ctx.crossConsentActions({
      pairs, surface: 'chip', excludeKey: 'cross_consent_exclude_chip',
      onAgree: () => sendChip(id, text, provenance),
      onExclude: rest.length ? () => sendChip(id, text, provenance, rest) : null,
      onCancel: hideChipConsent,
    });
    ctx.clear(consentRow);
    consentRow.appendChild(el('p', 'cmp-round-footer-consent-text', ctx.crossConsentText('chip_cross_consent', pairs)));
    consentRow.appendChild(actions);
    consentRow.hidden = false;
    actions.focusDefault();
  }
  function hideChipConsent() {
    if (!consentRow || consentRow.hidden) return;
    consentRow.hidden = true;
    ctx.clear(consentRow);
  }

  /** The columns a chip would go to now, as columns (suggest.js asks one of them). */
  const footerTargets = () => targetsNow().targets.map((id) => state.columns.get(id)).filter(Boolean);

  Object.assign(ctx, { buildRoundFooter, settleRoundFooter, renderRoundFooter, sendChip, roundFooterOn: flagOn, bridgeToDebate, takeDebateHandoff, maybeAutoSummarize, footerTargets });
}
