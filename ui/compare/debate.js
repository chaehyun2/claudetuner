// ui/compare/debate.js — the 「토론 모드」 slice of mountComparePage() (compare.js, #1769; design
// docs/plans/compare-debate-mode.md): the mode tabs (🔍 크로스체크 | 🗣️ 토론, plan §17), the pre-session
// setup (moderator, stances, the cast with its aliases), the ONE timeline a debate session draws into instead of the columns, and the
// orchestrator — opening round → (moderator →) one debater at a time → pause / end. The pure parts
// (aliases, deltas, prompts, the moderator's control line, the next-speaker rule) are in
// debate-core.js; this file owns state.debate and the DOM. ctx contract: ui/compare/history.js.
//
// Decisions (2026-09-26, Codex design round D1–D6):
// • The mode is chosen BEFORE the first send and fixed for the session (like 시크릿 대화). A debate
//   session appends its turn DOM into the timeline (turnHost) — the columns stay the setup surface.
// • Every send is the page's ordinary one: the opening is the first SEND (one text, every debater),
//   each later turn is a single-column FOLLOWUP (a moderator column joins on its first one — the SW
//   builds clients per column on demand). Wire kinds stay `send` / `followup`; only the TURNS carry
//   TURN_KIND_DEBATE (the worker's event kinds are untouched until it can be deployed with them).
// • A speaker is told only what it has not received (`delivered` = the last transcript seq that was
//   in a prompt it ANSWERED — a failed turn is re-sent next time rather than lost).
// • A user message while an AI streams is QUEUED and applied after the turn; the latest `@name`
//   wins; Stop aborts the stream and pauses, the queue survives. ⏸ 멈춤 (#1816) never aborts: it
//   lets the turn in flight finish and stops before the next one (`pauseAfter`).

import { TURN_KIND_DEBATE, SEND_VIA_DEBATE, DEBATE_SEND_BUDGET, DEBATE_HIDDEN_PAUSE_MS, DEBATE_MIN_TURNS_TO_END, DEBATE_MAX_ASKS, DEBATE_PREFS_KEY, DEBATE_ALIASES_KEY, DEBATE_FOLLOW_PX, GATE_CODES, CODE_ABORTED, STAGE_SEND_START, STAGE_STREAM_DONE, TTFT_MAX_MS, MODEL_SOURCE_REQUESTED, PROVIDER_META, SVG_NS, FEEDBACK_MSG_TYPE, DEBATE_FEEDBACK_REASONS, DEBATE_FEEDBACK_NOTE_MAX, DEBATE_FEEDBACK_TIMEOUT_MS, DEBATE_SLOW_NOTE_MS, DEBATE_SLOW_SKIP_MS, DEBATE_SLOW_SHARE_PCT, DEBATE_SLOW_SKIP_FIRST_MS, DEBATE_SLOW_SHARE_FIRST_PCT, MS_PER_SECOND, WAIT_TICK_MS } from './constants.js';
import { BRAND_MARK_VIEWBOX, BRAND_MARK_PATHS, BRAND_WORDMARK } from './brand-marks.js';
import {
  MOD_AI, MOD_AUTO, MOD_USER, MODERATOR_KINDS, STANCE_BASES, STANCE_ROLES, STANCE_NONE, STANCE_DEVIL, composeStance, splitStance, recordStance, recordPace, roleAllowed, stanceText, TONES, TONE_FRIENDS, TONE_CUSTOM, DEBATE_TONE_MAX, cleanTone, toneProblem, normalizeTone, SPEAKER_USER, ROLE_USER, ROLE_PARTICIPANT, ROLE_MODERATOR,
  DEBATE_DELTA_MAX, DEBATE_TOPIC_MAX, DEBATE_ALIAS_MAX, cleanAlias, aliasProblem, resolveNames, deltaFor, fitDelta, stancesOf,
  openingPrompt, turnPrompt, moderatorPrompt, splitControl, tightenConclusion, conclusionLabels, mentionOf, autoNext, chooseAfterModerator, moderatorMayEnd, owedAfterForced, tierOf, secondsBetween, metaLine, servedModelText, subjectParticle, budgetStep, hiddenTooLong,
  DEBATE_RECORD_LOG_MAX, transcriptFromRecord, trimRecordLog, debateMarkdown,
  MODE_CROSSCHECK, MODE_DEBATE, MODES, TAB_CONFIRM, TAB_LOCKED, initialMode, tabSwitchAction,
  unsearchedLinks, SETTING_MODERATOR, SETTING_STANCE, SETTING_ROLES, SETTING_TONE, SETTING_PACE, SETTING_LENGTH, LENGTHS, LENGTH_NORMAL, PACES, PACE_QUICK, PACE_DEFAULT, moderatorCanEnd, userSpokeSince, autoWrapDue, autoWrapTurns, pickConcluder, changedSettings, problemInSettings, defaultModerator, tierSlug,
} from './debate-core.js';

// #1862 fold heights (px of bubble) by reply length, and the slack a bubble may exceed them by unfolded
// (a bubble a few px over the line is not worth a button).
// 「더 보기」 folding is parked (2026-09-28 user: 「잠시 빼두자」) — the code stays, this switch keeps it off.
const FOLD_ENABLED = false;
const FOLD_PX = { short: 180, normal: 280, long: 460 };
const FOLD_SLACK_PX = 60;
const PHASE_OPENING = 'opening';
const PHASE_SPEAKING = 'speaking';
const PHASE_MODERATING = 'moderating';
const PHASE_AWAIT = 'await';
const PHASE_ASKED = 'asked'; // the AI moderator asked the user something (#1843) — the user's reply carries it on
const PHASE_PAUSED = 'paused';
const PHASE_BUDGET = 'budget'; // the run's send budget is spent (plan §15.1 ①)
const PHASE_HIDDEN = 'hidden'; // paused because the tab was hidden too long (§15.1 ②)
const PHASE_DONE = 'done';
const PHASE_TOO_FEW = 'too_few';
const PHASE_DEAD = 'dead';
const DEBATE_CLASS = 'is-debate';
const SETUP_CLASS = 'is-debate-setup'; // on the root: the debate tab before its session — the columns are participant cards
const MOD_CARD_CLASS = 'is-moderator'; // on a card: the AI moderator's column
// Fixed text a prompt carries besides the quoted messages (instructions, fences, names): what the
// delta budget leaves room for. Generous on purpose — the budget is a ceiling, not a target.
const PROMPT_OVERHEAD = 1500;
// The closed ⚙'s summary quotes a custom tone line up to this many characters (plan §18.3).
const SUMMARY_TONE_CHARS = 20;
// Where the focus goes when the ⚙ body opens from a line that hides (setSettingsOpen).
const FOCUS_FIRST = 'first';
const FOCUS_CAUSE = 'cause';
// The ⚙ budget note per moderation (#1818 ③): an AI moderator's calls count, 「내가 진행」 waits for a pick.
const BUDGET_HINT = { [MOD_AI]: 'debate_budget_hint', [MOD_AUTO]: 'debate_budget_hint_auto', [MOD_USER]: 'debate_budget_hint_user' };

/** Installs the debate slice onto `ctx` (see ui/compare/history.js for the ctx contract). */
export function installDebate(ctx) {
  const { chrome, state, t, el, clear, track } = ctx;
  const store = (chrome && chrome.storage && chrome.storage.local) || null;
  // `settingsOpen`: the ⚙ panel (plan §18) — closed until the user opens it once, then remembered.
  // `modChosen`: the user picked the moderator (the 「진행」 select) — until then the plan-picked seat
  // moderates by default (plan §18.8; `state.debateSeat` is set by compare.js with the debate layout).
  state.debatePrefs = { on: false, moderator: MOD_AUTO, modCol: null, modChosen: false, stance: STANCE_NONE, roles: [], tone: TONE_FRIENDS, toneCustom: '', pace: PACE_DEFAULT, paceChosen: false, length: LENGTH_NORMAL, settingsOpen: false };
  if (state.debateSeat === undefined) state.debateSeat = null;
  state.aliases = {};
  state.debate = null;

  const debateOn = () => !!(state.status && state.status.debateOn === true);
  const doc_active = () => (ctx.doc && ctx.doc.activeElement) || null;
  const debateActive = () => !!state.debate;
  /** The AI moderator asked the user something and waits for the answer (#1843 ASK). */
  const debateAsked = () => !!state.debate && state.debate.phase === PHASE_ASKED;
  /** The name the page shows for a cast column in the debate on screen ('' outside one) — what a share carries (#1784). */
  const debateNameOf = (id) => (state.debate && state.debate.names.get(id) ? state.debate.names.get(id).name || '' : '');
  /** The avatar emoji the page shows for a cast column ('' outside a debate) — a share carries it too (never a photo). */
  const debateEmojiOf = (id) => (state.debate && state.debate.names.get(id) ? state.debate.names.get(id).emoji || '' : '');
  /** The pre-session choice: debate mode toggled on (and offered by the flag). */
  const debateChosen = () => debateOn() && state.debatePrefs.on === true;

  // ── storage (aliases + the setup choices; both local, per browser) ──
  function readPrefs() {
    // The tab the page opens on (plan §17.3): the URL's `mode`, else `src` → cross-check, else the
    // stored last tab. In memory only — the stored choice changes when the user picks a tab.
    const opened = () => { state.debatePrefs.on = initialMode({ urlMode: ctx.params && typeof ctx.params.get === 'function' ? ctx.params.get('mode') : null, src: ctx.src, stored: state.debatePrefs.on }) === MODE_DEBATE; };
    if (!store) { opened(); return Promise.resolve(); }
    return new Promise((resolve) => {
      try {
        store.get({ [DEBATE_PREFS_KEY]: null, [DEBATE_ALIASES_KEY]: null }, (got) => {
          const p = got && got[DEBATE_PREFS_KEY];
          if (p && typeof p === 'object') {
            state.debatePrefs = {
              on: p.on === true,
              moderator: MODERATOR_KINDS.includes(p.moderator) ? p.moderator : MOD_AUTO,
              modCol: typeof p.modCol === 'string' ? p.modCol : null,
              // A value stored before `modChosen` existed that is not the old default WAS a choice (plan §18.9 ③).
              modChosen: p.modChosen === true || (p.modChosen === undefined && MODERATOR_KINDS.includes(p.moderator) && p.moderator !== MOD_AUTO),
              // Positions and roles split (2026-09-29): a stored single value — 'devil' / 'verify' of before —
              // reads as a free debate with that role; `roles` stored since then is the list itself.
              stance: splitStance(p.stance).base,
              roles: Array.isArray(p.roles) ? STANCE_ROLES.filter((r) => p.roles.includes(r)) : splitStance(p.stance).roles,
              // No / unknown tone = friends (§12.1 ③ — nothing shipped used another default).
              tone: TONES.includes(p.tone) ? p.tone : TONE_FRIENDS,
              toneCustom: typeof p.toneCustom === 'string' ? cleanTone(p.toneCustom).slice(0, DEBATE_TONE_MAX * 2) : '',
              // The pace the user picked is kept (`paceChosen`). One stored before that flag existed was a
              // pick only if it is 「빠르게」: 「깊게」 was the default until 2026-09-29, and every other
              // setting's save wrote it along — so it moves to the new default, 「충분히」 (like modChosen, §18.9 ③).
              pace: PACES.includes(p.pace) && (p.paceChosen === true || p.pace === PACE_QUICK) ? p.pace : PACE_DEFAULT,
              paceChosen: PACES.includes(p.pace) && (p.paceChosen === true || p.pace === PACE_QUICK),
              length: LENGTHS.includes(p.length) ? p.length : LENGTH_NORMAL, // #1862
              settingsOpen: p.settingsOpen === true,
            };
          }
          const a = got && got[DEBATE_ALIASES_KEY];
          if (a && typeof a === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(a)) { const s = cleanAlias(v); if (typeof k === 'string' && s && !aliasProblem(s)) out[k] = s; }
            state.aliases = out;
          }
          opened();
          resolve();
        });
      } catch { opened(); resolve(); }
    });
  }
  function savePrefs() { try { if (store) store.set({ [DEBATE_PREFS_KEY]: state.debatePrefs }); } catch { /* best effort */ } }
  function saveAliases() { try { if (store) store.set({ [DEBATE_ALIASES_KEY]: state.aliases }); } catch { /* best effort */ } }

  // ── the cast ──
  const colOf = (id) => state.columns.get(id);
  /** The columns the first SEND would reach (visible, sendable), in page order. */
  const reachable = () => ctx.currentTargets();
  /** The moderator in effect: the user's choice once made, else the default for this page (the seat — plan §18.8). */
  function modChoice(targets = reachable()) {
    const p = state.debatePrefs;
    return p.modChosen ? { moderator: p.moderator, modCol: p.modCol } : defMod(targets);
  }
  /** This page's default moderation (defaultModerator — the seat, or one of 3+ columns #1909). */
  const colTier = (id) => { const c = colOf(id); return c ? tierOf(c.provider, c.model, ctx.modelLabelOf(c.provider, c.model)) : null; };
  const defMod = (targets) => defaultModerator(state.debateSeat, targets, colTier);
  /** The settings that differ from this page's defaults (the ⚙ dot, the summary line). */
  const changedNow = (targets = reachable()) => changedSettings({ ...state.debatePrefs, ...modChoice(targets) }, defMod(targets));
  /** The AI moderator column when that is the choice and it is reachable; else null. */
  function moderatorCol(targets = reachable()) {
    const m = modChoice(targets);
    return m.moderator === MOD_AI && m.modCol && targets.includes(m.modCol) ? m.modCol : null;
  }
  const personOf = (id, alias = state.aliases[id]) => { const c = colOf(id); return { id, provider: c.provider, model: c.model, modelLabel: ctx.modelLabelOf(c.provider, c.model), alias: alias || '', label: ctx.colLabel(c) }; };
  /** The cast's names (`aliasOf(id)` = the alias to honour). */
  function castNames(cast, aliasOf) {
    return resolveNames(cast.map((id) => personOf(id, aliasOf(id))), t);
  }
  /**
   * The cast in naming order: the debaters in page order, then the moderator. Default names are
   * given in this order (resolveNames numbers shared families by it), so the moderator chips name
   * each candidate with the cast it WOULD make (Codex §19 plan 1R) — the name on a chip is the name
   * it keeps once picked.
   */
  function castOrder(targets, modCol) {
    const debaters = targets.filter((id) => id !== modCol);
    return { debaters, cast: [...debaters, ...(modCol ? [modCol] : [])] };
  }
  /** The run's one stance value from the ⚙ choices: the position plus the roles it allows. */
  const runStance = () => composeStance(state.debatePrefs.stance, state.debatePrefs.roles);
  /** Each debater's side and role (i18n keys or null) — the ONE assignment the cards preview and start() uses. */
  const castStances = (plan) => stancesOf(plan.debaters, runStance());
  /** The short badge of a side or role (the roles' prompt lines are sentences, not badges). */
  const stanceBadge = (key) => t(key === 'debate_stance_devil' ? 'debate_stance_badge_devil' : key === 'debate_stance_verify' ? 'debate_stance_badge_verify' : key);
  /** One badge per key a debater holds (a side and a role may go together). */
  function appendStanceBadges(parent, keys, cls) {
    for (const k of keys || []) parent.appendChild(el('span', cls, stanceBadge(k)));
  }
  /** The run's stance as the room line names it: the position, then each role — 「자유 토론 + 검증 담당 1명」. */
  const stanceLabel = (stance) => { const { base, roles } = splitStance(stance); return [base, ...roles].map((k) => t(`debate_stance_opt_${k}`)).join(' + '); };
  /** `{ debaters, modCol, names, conflicts, problem }` for the current setup (problem = i18n key or null). */
  function planCast() {
    const targets = reachable();
    const modCol = moderatorCol(targets);
    const { debaters, cast } = castOrder(targets, modCol);
    const { names, conflicts } = castNames(cast, (id) => state.aliases[id]);
    let problem = null;
    if (modChoice(targets).moderator === MOD_AI && !modCol) problem = targets.length >= 3 ? 'debate_pick_moderator' : 'debate_need_three_ai';
    else if (debaters.length < 2) problem = 'debate_need_two';
    else if (conflicts.length) problem = 'debate_alias_err_conflict';
    else if (state.debatePrefs.tone === TONE_CUSTOM && toneProblem(state.debatePrefs.toneCustom)) problem = `debate_tone_err_${toneProblem(state.debatePrefs.toneCustom)}`;
    // A held conversation link (#1651) cannot open a debate (sendInitial refuses it) — said here, so
    // the start button is not dead for no stated reason. The tray is not a problem: the debate tab
    // hides it and the opening never carries it (plan §17.11 ②).
    else if (state.link || state.linkReading) problem = 'debate_no_link';
    return { debaters, modCol, names, conflicts, problem };
  }

  // ── the mode tabs (plan §17): in the heading's place, while the flag offers the debate ──
  const currentMode = () => (state.sessionStarted ? (debateActive() ? MODE_DEBATE : MODE_CROSSCHECK) : (debateChosen() ? MODE_DEBATE : MODE_CROSSCHECK));
  const tabs = el('div', 'cmp-mode-tabs');
  tabs.id = 'cmp-mode-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', t('mode_tabs_label'));
  tabs.hidden = true;
  const TAB_GLYPH = { [MODE_CROSSCHECK]: '\u{1F50D}', [MODE_DEBATE]: '\u{1F5E3}\u{FE0F}' };
  const TAB_LABEL = { [MODE_CROSSCHECK]: t('mode_tab_crosscheck'), [MODE_DEBATE]: t('mode_tab_debate') };
  const TAB_TIP = { [MODE_CROSSCHECK]: t('mode_tab_crosscheck_tip'), [MODE_DEBATE]: t('mode_tab_debate_tip') };
  const tabBtns = new Map();
  for (const mode of MODES) {
    const b = el('button', 'cmp-mode-tab');
    b.type = 'button';
    b.id = `cmp-tab-${mode}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('data-mode', mode);
    const g = el('span', 'cmp-mode-tab-glyph', TAB_GLYPH[mode]);
    g.setAttribute('aria-hidden', 'true');
    b.appendChild(g);
    b.appendChild(el('span', null, TAB_LABEL[mode]));
    b.addEventListener('click', () => requestMode(mode, 'click'));
    tabs.appendChild(b);
    tabBtns.set(mode, b);
  }
  // Tabs pattern: ←/→ move the focus between the two, Enter / Space (the button's own) activate —
  // manual activation, since activating in a session may ask first.
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const at = MODES.indexOf(doc_active() && doc_active().getAttribute ? doc_active().getAttribute('data-mode') : currentMode());
    const next = MODES[(Math.max(0, at) + 1) % MODES.length];
    try { tabBtns.get(next).focus(); } catch { /* focus is a nicety */ }
  });
  // ⚙ 토론 설정 (plan §18): the run's settings (moderator · stances · tone · the send budget note)
  // fold behind it so a first debate is just a topic — the defaults suit most. Beside the tabs,
  // debate tab only; locked like the tabs once a first send is on the wire (plan §18.7 ③). A dot
  // says a setting differs from the defaults.
  const gearBtn = el('button', 'cmp-debate-gear');
  gearBtn.type = 'button';
  gearBtn.id = 'cmp-debate-gear';
  gearBtn.hidden = true;
  gearBtn.setAttribute('aria-controls', 'cmp-debate-setup-body');
  gearBtn.setAttribute('aria-label', t('debate_settings_btn'));
  const gearGlyph = el('span', 'cmp-debate-gear-glyph', '\u{2699}\u{FE0F}');
  gearGlyph.setAttribute('aria-hidden', 'true');
  gearBtn.appendChild(gearGlyph);
  const gearDot = el('span', 'cmp-debate-gear-dot');
  gearDot.setAttribute('aria-hidden', 'true');
  gearBtn.appendChild(gearDot);
  gearBtn.addEventListener('click', () => setSettingsOpen(!state.debatePrefs.settingsOpen));
  // The ask before leaving a session that would lose something (tabSwitchAction → confirm): a small
  // popover under the tabs — one sentence, 「새로 시작」 / 「취소」.
  const confirmBox = el('div', 'cmp-mode-confirm');
  confirmBox.id = 'cmp-mode-confirm';
  confirmBox.setAttribute('role', 'alertdialog');
  confirmBox.hidden = true;
  const confirmText = el('p', 'cmp-mode-confirm-text');
  confirmText.id = 'cmp-mode-confirm-text';
  confirmBox.setAttribute('aria-labelledby', confirmText.id);
  confirmBox.appendChild(confirmText);
  const confirmRow = el('div', 'cmp-mode-confirm-row');
  const confirmOk = el('button', 'cmp-btn cmp-btn-sm cmp-btn-primary', t('mode_confirm_ok'));
  confirmOk.type = 'button';
  confirmOk.id = 'cmp-mode-confirm-ok';
  const confirmCancel = el('button', 'cmp-btn cmp-btn-sm', t('mode_confirm_cancel'));
  confirmCancel.type = 'button';
  confirmCancel.id = 'cmp-mode-confirm-cancel';
  confirmRow.appendChild(confirmOk);
  confirmRow.appendChild(confirmCancel);
  confirmBox.appendChild(confirmRow);
  let confirmFor = null; // the mode the open confirm would switch to
  function closeConfirm(refocus = false) {
    if (confirmFor === null) return;
    const back = tabBtns.get(confirmFor);
    confirmFor = null;
    confirmBox.hidden = true;
    if (refocus && back) { try { back.focus(); } catch { /* focus is a nicety */ } }
  }
  function openConfirm(mode, why) {
    confirmFor = mode;
    confirmText.textContent = t(`mode_confirm_${why}_${mode}`);
    confirmBox.hidden = false;
    try { confirmOk.focus(); } catch { /* focus is a nicety */ }
  }
  confirmOk.addEventListener('click', () => { const mode = confirmFor; closeConfirm(); if (mode) applyMode(mode, 'click'); });
  confirmCancel.addEventListener('click', () => closeConfirm(true));
  if (ctx.doc && typeof ctx.doc.addEventListener === 'function') {
    // Escape closes it wherever the focus went (Tab can leave the popover).
    ctx.doc.addEventListener('keydown', (e) => { if (confirmFor !== null && e && e.key === 'Escape') { e.preventDefault(); closeConfirm(true); } });
    ctx.doc.addEventListener('click', (e) => {
      if (confirmFor === null || !e || !e.target) return;
      for (let n = e.target; n; n = n.parentNode) if (n === confirmBox || n === tabs) return;
      closeConfirm();
    });
  }
  /** A tab asked for `mode` (a click / key): switch, ask first, or refuse while a first send is unanswered. */
  function requestMode(mode, via) {
    if (!debateOn() || !MODES.includes(mode) || mode === currentMode()) { closeConfirm(); return; }
    // `kept`: this session has a history entry (history.js persistSession / loadSession stamp its id).
    const kept = !!state.sessionId && state.persistedId === state.sessionId;
    const action = tabSwitchAction({ sessionStarted: state.sessionStarted, sending: state.sending, running: isRunning(), kept });
    if (action === TAB_LOCKED) return;
    // Losing the whole conversation outranks stopping it: that is the sentence the user must read.
    if (action === TAB_CONFIRM) { openConfirm(mode, kept ? 'running' : 'unsaved'); return; }
    applyMode(mode, via);
  }
  /** Switches to `mode`: a session on screen is left as 새 대화 leaves it (the page is then the new tab's). */
  function applyMode(mode, via) {
    closeConfirm();
    if (!state.sessionStarted && state.sending) return; // re-checked: the confirm may be answered after a send began
    state.debatePrefs.on = mode === MODE_DEBATE;
    savePrefs();
    track('mode_tab', { mode, via });
    writeUrlMode(mode);
    if (state.sessionStarted) ctx.resetSession();
    ctx.modeChanged();
    try { tabBtns.get(mode).focus(); } catch { /* focus is a nicety */ }
  }
  /** The address says the tab (a reload opens it again): `mode` in this page's own query, nothing else touched. */
  function writeUrlMode(mode) {
    try {
      const w = ctx.win;
      if (!w || !w.history || typeof w.history.replaceState !== 'function' || !w.location) return;
      const u = new URL(w.location.href);
      if (u.searchParams.get('mode') === mode) return;
      u.searchParams.set('mode', mode);
      w.history.replaceState(w.history.state, '', u.toString());
    } catch { /* an address that cannot be rewritten keeps the old one — the stored tab still holds */ }
  }
  /**
   * A history entry was opened (history.js loadSession): the tab follows what it opened AS — the
   * debate room or the columns — and becomes the last tab used, so 새 대화 stays in that room.
   */
  function followEntry(asDebate) {
    if (!debateOn()) return;
    const mode = asDebate ? MODE_DEBATE : MODE_CROSSCHECK;
    closeConfirm();
    if (state.debatePrefs.on === asDebate) return;
    state.debatePrefs.on = asDebate;
    savePrefs();
    track('mode_tab', { mode, via: 'history' });
    writeUrlMode(mode);
    ctx.modeChanged();
  }
  /** The tabs as the page stands: shown while the flag offers the debate; locked while a first send is unanswered. */
  function renderTabs() {
    tabs.hidden = !debateOn();
    if (tabs.hidden) { closeConfirm(); renderGear(); return; }
    const cur = currentMode();
    const locked = state.disabled || (state.sending && !state.sessionStarted);
    for (const [mode, b] of tabBtns) {
      const on = mode === cur;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('is-active', on);
      b.disabled = !on && locked;
      b.title = !on && locked ? t('mode_tab_locked') : TAB_TIP[mode];
    }
    if (confirmFor === cur) closeConfirm();
    renderGear();
  }
  /** The ⚙ as the page stands: debate tab only, locked from the first send on, a dot while a setting differs from the defaults. */
  function renderGear() {
    gearBtn.hidden = tabs.hidden || currentMode() !== MODE_DEBATE;
    const locked = state.disabled || state.sending || state.sessionStarted;
    gearBtn.disabled = locked;
    closeSettingsBtn.disabled = locked; // the same toggle as the ⚙, locked with it
    const tip = t(locked ? 'debate_settings_locked' : 'debate_settings_btn');
    if (gearBtn.title !== tip) gearBtn.title = tip;
    gearBtn.setAttribute('aria-expanded', state.debatePrefs.settingsOpen ? 'true' : 'false'); // the body's own state, locked or not (Codex U1 1R)
    gearBtn.classList.toggle('is-changed', changedNow().length > 0);
  }

  const setup = el('div', 'cmp-debate-setup');
  setup.id = 'cmp-debate-setup';
  setup.hidden = true;
  // The ⚙ body (plan §18.3): the selects and the budget note. Outside it, always: the summary of
  // what differs from the defaults (closed only) and why the debate cannot start.
  const setupBody = el('div', 'cmp-debate-setup-body');
  setupBody.id = 'cmp-debate-setup-body';
  setup.appendChild(setupBody);
  // Each setting is a radio group of option cards — a title and what it does (plan §19): a bare
  // select made people pick before knowing what a choice meant. The cards are built once and only
  // their state changes on render, so a keystroke-driven renderSetup never drops their focus.
  const setupRow = el('div', 'cmp-debate-setup-row');
  /** A labelled radio group of option cards; `onPick(value)` writes the preference. */
  function optGroup(id, labelKey, options, onPick, multi = false) {
    const field = el('div', 'cmp-debate-field');
    const name = el('span', 'cmp-debate-field-name', t(labelKey));
    name.id = `${id}-label`;
    const group = el('div', 'cmp-debate-opts');
    group.id = id;
    // `multi` = independent on/off cards (the roles): checkboxes, each in the tab order, no arrow-key picking.
    group.setAttribute('role', multi ? 'group' : 'radiogroup');
    group.setAttribute('aria-labelledby', name.id);
    const cards = new Map();
    for (const [value, titleKey, glyph] of options) {
      const card = el('button', 'cmp-debate-opt');
      card.type = 'button';
      card.setAttribute('role', multi ? 'checkbox' : 'radio');
      card.setAttribute('data-value', value);
      const title = el('span', 'cmp-debate-opt-title');
      title.appendChild(el('span', 'cmp-debate-opt-glyph', glyph));
      title.appendChild(el('span', null, t(titleKey)));
      card.appendChild(title);
      const desc = el('span', 'cmp-debate-opt-desc');
      card.appendChild(desc);
      card.addEventListener('click', () => { if (card.getAttribute('aria-disabled') !== 'true') onPick(value); });
      cards.set(value, { card, desc });
      group.appendChild(card);
    }
    // Arrow keys move AND pick, like native radios; a disabled card is skipped — stepping from the
    // card in focus in the whole order, so ← from a disabled card goes left (Codex §19 1R 후속).
    if (!multi) group.addEventListener('keydown', (e) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 1, End: -1 };
      if (!(e.key in keys)) return;
      const all = [...cards.values()].map((c) => c.card);
      const live = (c) => !c.disabled && c.getAttribute('aria-disabled') !== 'true';
      if (!all.some(live)) return;
      e.preventDefault();
      const step = keys[e.key];
      let i = e.key === 'Home' ? -1 : e.key === 'End' ? all.length : all.indexOf(doc_active());
      if (i === -1 && step < 0 && e.key !== 'Home') i = 0;
      do i = (i + step + all.length) % all.length; while (!live(all[i]));
      const next = all[i];
      onPick(next.getAttribute('data-value'));
      // The pick may have sent the focus on (「직접 입력」 → its input): leave it there (Codex §19 1R 후속).
      const now = doc_active();
      if (!now || group.contains(now) || now === ctx.doc.body) { try { next.focus(); } catch { /* focus is a nicety */ } }
    });
    field.appendChild(name);
    field.appendChild(group);
    return { field, group, cards, multi };
  }
  /** Checked / disabled / descriptions of one group; a radio group has exactly one card in the tab order, a multi group all. */
  function paintGroup(g, checked, descOf, disabledOf = () => false) {
    let tabbed = null;
    for (const [value, { card, desc }] of g.cards) {
      const on = g.multi ? checked.includes(value) : value === checked;
      card.setAttribute('aria-checked', on ? 'true' : 'false');
      card.classList.toggle('is-checked', on);
      card.disabled = state.sending;
      const off = disabledOf(value); // a stored choice stays shown as chosen (plan §18.7 ①) — and says it cannot be used
      if (off) card.setAttribute('aria-disabled', 'true'); else card.removeAttribute('aria-disabled');
      const d = descOf(value);
      if (desc.textContent !== d) desc.textContent = d;
      card.tabIndex = g.multi ? 0 : -1;
      if (on) tabbed = card;
    }
    if (!g.multi) (tabbed || [...g.cards.values()][0].card).tabIndex = 0;
  }
  const modGroup = optGroup('cmp-debate-moderator', 'debate_mod_label', [
    [MOD_AUTO, 'debate_mod_auto', '\u{1F501}'], [MOD_AI, 'debate_mod_ai_card', '\u{1F399}\u{FE0F}'], [MOD_USER, 'debate_mod_user', '\u{1F64B}'],
  ], (v) => setModerator(v));
  // Who moderates (AI moderator only): one chip per reachable AI, named as the debate will name it.
  const modPicks = el('div', 'cmp-debate-modpicks');
  modPicks.id = 'cmp-debate-modpicks';
  modPicks.hidden = true;
  modGroup.field.appendChild(modPicks);
  setupRow.appendChild(modGroup.field);
  const stanceGroup = optGroup('cmp-debate-stance', 'debate_stance_label', [
    [STANCE_BASES[0], `debate_stance_opt_${STANCE_BASES[0]}`, '\u{1F4AC}'], [STANCE_BASES[1], `debate_stance_opt_${STANCE_BASES[1]}`, '\u{2696}\u{FE0F}'],
  ], (v) => setStance(v));
  setupRow.appendChild(stanceGroup.field);
  // 역할 추가 (2026-09-29): on top of the position, each role on or off — one debater each.
  const rolesGroup = optGroup('cmp-debate-roles', 'debate_roles_label', [
    [STANCE_ROLES[0], `debate_stance_opt_${STANCE_ROLES[0]}`, '\u{1F608}'], [STANCE_ROLES[1], `debate_stance_opt_${STANCE_ROLES[1]}`, '\u{1F50E}'],
  ], (v) => toggleRole(v), true);
  setupRow.appendChild(rolesGroup.field);
  // 말투 (§12): friends (default) / calm / custom — the custom line is a one-line input under the cards.
  const toneGroup = optGroup('cmp-debate-tone', 'debate_tone_label', [
    [TONES[0], `debate_tone_opt_${TONES[0]}`, '\u{1F604}'], [TONES[1], `debate_tone_opt_${TONES[1]}`, '\u{1F393}'], [TONES[2], `debate_tone_opt_${TONES[2]}`, '\u{270F}\u{FE0F}'],
  ], (v) => setTone(v));
  const toneInput = el('input', 'cmp-debate-tone-input');
  toneInput.id = 'cmp-debate-tone-custom';
  toneInput.type = 'text';
  toneInput.maxLength = DEBATE_TONE_MAX * 2; // UTF-16 units; toneProblem counts characters and is the check
  toneInput.placeholder = t('debate_tone_placeholder');
  toneInput.setAttribute('aria-label', t('debate_tone_input_label', DEBATE_TONE_MAX));
  toneInput.hidden = true;
  toneGroup.field.appendChild(toneInput);
  setupRow.appendChild(toneGroup.field);
  // 토론 길이 (#1843): 「깊게 파고들기」 / 「충분히 논의 후 결론」 (default) / 「빠르게 결론」 — read by an AI moderator only.
  const paceGroup = optGroup('cmp-debate-pace', 'debate_pace_label', [
    [PACES[0], `debate_pace_opt_${PACES[0]}`, '\u{1F50D}'], [PACES[1], `debate_pace_opt_${PACES[1]}`, '\u{1F9ED}'], [PACES[2], `debate_pace_opt_${PACES[2]}`, '\u{23F1}\u{FE0F}'],
  ], (v) => setPace(v));
  setupRow.appendChild(paceGroup.field);
  // 발언 길이 (#1862): how much one turn says — short / normal (default) / long. Every moderation kind.
  const lengthGroup = optGroup('cmp-debate-length', 'debate_length_label', [
    [LENGTHS[0], `debate_length_opt_${LENGTHS[0]}`, '\u{1F90F}'], [LENGTHS[1], `debate_length_opt_${LENGTHS[1]}`, '\u{1F4AC}'], [LENGTHS[2], `debate_length_opt_${LENGTHS[2]}`, '\u{1F4DC}'],
  ], (v) => setLength(v));
  setupRow.appendChild(lengthGroup.field);
  setupBody.appendChild(setupRow);
  // The cast is not listed here any more (plan §17.5): each participant's avatar and alias sit on
  // its own column head — the debate tab draws the pre-session columns as participant cards.
  // The run's safeguards, said before it starts (plan §15.1 ①).
  // Worded per moderation (#1818 ③) — renderSetup sets it.
  const budgetHint = el('p', 'cmp-debate-hint');
  budgetHint.id = 'cmp-debate-hint';
  // The open panel closes where the reader is — its foot — not only on the ⚙ above it (2026-09-28 user:
  // 「다시 닫으려면 상단 옵션 버튼을 눌러야 해서 직관적이지 않아」).
  // The button leads the foot, on the left (2026-09-29 user): under the cards and the ⚙, where the eye already is —
  // at the far right of a wide window it sat past the end of every card row.
  const setupFoot = el('div', 'cmp-debate-setup-foot');
  const closeSettingsBtn = el('button', 'cmp-btn cmp-btn-sm cmp-debate-settings-close', t('debate_settings_close'));
  closeSettingsBtn.type = 'button';
  closeSettingsBtn.id = 'cmp-debate-settings-close';
  closeSettingsBtn.setAttribute('aria-controls', 'cmp-debate-setup-body');
  closeSettingsBtn.addEventListener('click', () => setSettingsOpen(false));
  setupFoot.appendChild(closeSettingsBtn);
  setupFoot.appendChild(budgetHint);
  setupBody.appendChild(setupFoot);
  const summaryBtn = el('button', 'cmp-debate-summary');
  summaryBtn.type = 'button';
  summaryBtn.id = 'cmp-debate-summary';
  summaryBtn.title = t('debate_settings_summary_tip');
  summaryBtn.hidden = true;
  const summaryGlyph = el('span', 'cmp-debate-summary-glyph', '\u{2699}\u{FE0F}');
  summaryGlyph.setAttribute('aria-hidden', 'true');
  summaryBtn.appendChild(summaryGlyph);
  const summaryText = el('span');
  summaryBtn.appendChild(summaryText);
  summaryBtn.addEventListener('click', () => setSettingsOpen(true, FOCUS_FIRST)); // the line it was clicked on goes away
  setup.appendChild(summaryBtn);
  const setupErr = el('p', 'cmp-debate-err');
  setupErr.id = 'cmp-debate-err';
  setupErr.hidden = true;
  setupErr.setAttribute('role', 'alert');
  const setupErrText = el('span');
  setupErr.appendChild(setupErrText);
  // 「설정 열기」: the problem's cause is a control behind the closed ⚙ (problemInSettings).
  const setupErrOpen = el('button', 'cmp-debate-err-open', t('debate_settings_open'));
  setupErrOpen.type = 'button';
  setupErrOpen.id = 'cmp-debate-err-open';
  setupErrOpen.hidden = true;
  setupErrOpen.addEventListener('click', () => setSettingsOpen(true, FOCUS_CAUSE));
  setupErr.appendChild(setupErrOpen);
  setup.appendChild(setupErr);
  let editing = null; // colId whose alias input is open
  let aliasError = null; // { id, key, arg } of the last refused alias edit
  // renderSetup runs on every updateControls (each keystroke in the question box): the selects and
  // the cast are rebuilt only when what they show changed — a rebuild would drop the focus of a
  // chip and, worse, destroy an alias input mid-typing.
  let setupSig = '';

  /** 진행: the rule, or the AI moderator (keeps a reachable pick, else takes this page's seat, else none yet). */
  function setModerator(kind) {
    const p = state.debatePrefs;
    const targets = reachable();
    if (kind === MOD_AI) {
      const cur = modChoice(targets);
      const seat = defMod(targets);
      p.modCol = cur.modCol && targets.includes(cur.modCol) ? cur.modCol : seat.moderator === MOD_AI ? seat.modCol : null;
      p.moderator = MOD_AI;
    } else {
      p.moderator = MODERATOR_KINDS.includes(kind) ? kind : MOD_AUTO;
    }
    p.modChosen = true; // from now on the user's, not the plan-picked default
    savePrefs();
    renderSetup();
    ctx.updateControls();
  }
  /** 진행자: this column moderates (the chip row under 「AI 진행자」). */
  function setModCol(id) {
    const p = state.debatePrefs;
    p.moderator = MOD_AI;
    p.modCol = id;
    p.modChosen = true;
    savePrefs();
    renderSetup();
    ctx.updateControls();
    const chip = [...modPicks.children].find((c) => c.getAttribute('data-col') === id);
    if (chip) { try { chip.focus(); } catch { /* focus is a nicety */ } } // the row was rebuilt under the click
  }
  function setTone(kind) {
    state.debatePrefs.tone = TONES.includes(kind) ? kind : TONE_FRIENDS;
    savePrefs();
    track('debate_tone', { tone: state.debatePrefs.tone });
    renderSetup();
    ctx.updateControls();
    if (state.debatePrefs.tone === TONE_CUSTOM) { try { toneInput.focus(); } catch { /* focus is a nicety */ } }
  }
  toneInput.addEventListener('input', () => {
    state.debatePrefs.toneCustom = toneInput.value; // folded on use (cleanTone); the input keeps what was typed
    savePrefs();
    ctx.updateControls();
  });
  function setLength(length) {
    state.debatePrefs.length = LENGTHS.includes(length) ? length : LENGTH_NORMAL;
    savePrefs();
    renderSetup();
    ctx.updateControls();
  }
  function setPace(pace) {
    state.debatePrefs.pace = PACES.includes(pace) ? pace : PACE_DEFAULT;
    state.debatePrefs.paceChosen = true;
    savePrefs();
    renderSetup();
    ctx.updateControls();
  }
  function toggleRole(role) {
    if (!STANCE_ROLES.includes(role) || !roleAllowed(state.debatePrefs.stance, role)) return;
    const on = state.debatePrefs.roles.includes(role);
    state.debatePrefs.roles = STANCE_ROLES.filter((r) => (r === role ? !on : state.debatePrefs.roles.includes(r)));
    savePrefs();
    renderSetup(); // the ⚙ dot, the summary line and the cards' badges say it at once
    ctx.updateControls();
    const card = rolesGroup.cards.get(role);
    if (card) { try { card.card.focus(); } catch { /* focus is a nicety */ } } // the row repainted under the click
  }
  function setStance(stance) {
    state.debatePrefs.stance = STANCE_BASES.includes(stance) ? stance : STANCE_NONE;
    savePrefs();
    renderSetup(); // the ⚙ dot, the summary line and the cards' side badges say it at once (plan §18.7 ③, §19)
    ctx.updateControls();
  }
  /**
   * Opens / closes the ⚙ body. Remembered (a user who opened it once sees it open next time).
   * Closing moves a focus left inside the body to the ⚙, never onto a hidden control. Opening from
   * a line that then hides (`focus`): FOCUS_FIRST lands on the first setting, FOCUS_CAUSE on the
   * control the start problem is about (the error line's 「설정 열기」).
   */
  function setSettingsOpen(open, focus = null) {
    if (open === state.debatePrefs.settingsOpen && !focus) return;
    const focusInside = !open && setupBody.contains(doc_active());
    state.debatePrefs.settingsOpen = open;
    savePrefs();
    track('debate_settings', { open });
    renderSetup();
    renderGear();
    if (focusInside) { try { gearBtn.focus(); } catch { /* focus is a nicety */ } }
    if (open && focus) {
      const p = focus === FOCUS_CAUSE ? planCast().problem : null;
      const firstPick = modPicks.hidden ? null : modPicks.querySelector('button');
      const checked = modGroup.group.querySelector('[aria-checked="true"]') || modGroup.group.querySelector('button');
      const target = p && p.startsWith('debate_tone_err_') ? toneInput : p === 'debate_pick_moderator' && firstPick ? firstPick : checked;
      try { target.focus(); } catch { /* focus is a nicety */ }
    }
  }

  /**
   * A speaker's avatar: the model's emoji on the service tint, and — with `badge` — the service mark
   * as a small corner badge (2026-09-27 user decision, plan §11.6: every speaker looks alike in
   * form, the emoji says which model, the badge which service). The mark is inline SVG with constant
   * path data (brand-marks.js); a service without a usable mark gets its letter tile. Decoration
   * only (aria-hidden); the name says who.
   */
  function avatar(provider, info, cls, badge = false) {
    const a = el('span', cls);
    a.setAttribute('aria-hidden', 'true');
    a.setAttribute('data-provider', provider);
    a.appendChild(el('span', 'cmp-debate-ava-emoji', (info && info.emoji) || ''));
    if (!badge) return a;
    const path = BRAND_MARK_PATHS[provider];
    const word = !path ? BRAND_WORDMARK[provider] : null;
    if (path && ctx.doc && typeof ctx.doc.createElementNS === 'function') {
      // The mark's colour is CSS `fill` from the --brand-* token (compare.css), not an attribute.
      const b = el('span', 'cmp-debate-ava-badge');
      const svg = ctx.doc.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', BRAND_MARK_VIEWBOX);
      svg.setAttribute('focusable', 'false');
      const pathEl = ctx.doc.createElementNS(SVG_NS, 'path');
      pathEl.setAttribute('d', path);
      svg.appendChild(pathEl);
      b.appendChild(svg);
      a.appendChild(b);
    } else if (word) {
      // No usable mark (brand-marks.js): the letter tile, plain text.
      a.appendChild(el('span', 'cmp-debate-ava-badge is-word', word));
    }
    return a;
  }
  /**
   * One participant's identity on its card (the column head's cast slot): avatar + name (a button
   * that opens the alias input in place) + 🎙 진행자 for the moderator. The service and model are the
   * head's own controls right under it.
   */
  function castChip(id, info, isMod, stance = null) {
    const col = colOf(id);
    const chip = el('span', 'cmp-debate-chip' + (isMod ? ' is-moderator' : ''));
    chip.setAttribute('data-col', id);
    chip.appendChild(avatar(col.provider, info, 'cmp-debate-ava', true)); // the service badge: the card drops the head's service dot
    if (editing === id) {
      const input = el('input', 'cmp-debate-alias-input');
      input.type = 'text';
      input.value = state.aliases[id] || '';
      input.placeholder = info.custom ? '' : info.name;
      input.maxLength = DEBATE_ALIAS_MAX * 2; // emoji count double in UTF-16; aliasProblem is the check
      input.setAttribute('aria-label', t('debate_alias_input_label', ctx.colLabel(col)));
      let done = false;
      const commit = (keep) => {
        if (done) return;
        done = true;
        if (keep) {
          const v = cleanAlias(input.value);
          const why = aliasProblem(v);
          if (why) { aliasError = { id, key: `debate_alias_err_${why}`, arg: DEBATE_ALIAS_MAX }; editing = null; renderSetup(); return; }
          if (v) state.aliases[id] = v; else delete state.aliases[id];
          saveAliases();
          track('debate_alias', { custom: !!v });
        }
        aliasError = null;
        editing = null;
        renderSetup();
        ctx.updateControls();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(true); }
        else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      });
      input.addEventListener('blur', () => commit(true));
      chip.appendChild(input);
    } else {
      const nameBtn = el('button', 'cmp-debate-chip-name', info.name);
      nameBtn.type = 'button';
      nameBtn.title = t('debate_rename_tip');
      nameBtn.addEventListener('click', () => {
        editing = id;
        aliasError = null;
        renderSetup();
        // Focused NOW (the input exists once renderSetup returned): keys typed right after the click must land in it.
        const input = colOf(id).debateSlot.querySelector('.cmp-debate-alias-input');
        if (input) { try { input.focus(); input.select(); } catch { /* focus is a nicety */ } }
      });
      chip.appendChild(nameBtn);
    }
    if (isMod) chip.appendChild(el('span', 'cmp-debate-badge is-moderator', `\u{1F399}\u{FE0F} ${t('debate_role_moderator')}`));
    else appendStanceBadges(chip, stance, 'cmp-debate-badge is-stance'); // the side / role it will take (plan §19)
    return chip;
  }
  /**
   * 「AI 진행자」's chip row: one chip per reachable AI, avatar + the name it will have as the
   * moderator (castOrder), the chosen one checked. Hidden for the other rules and below 3 AIs.
   */
  function renderModPicks(targets, mod, need3) {
    clear(modPicks);
    modPicks.hidden = mod.moderator !== MOD_AI || need3;
    if (modPicks.hidden) return;
    modPicks.appendChild(el('span', 'cmp-debate-modpicks-label', t('debate_mod_pick_label')));
    for (const id of targets) {
      const info = castNames(castOrder(targets, id).cast, (x) => state.aliases[x]).names.get(id);
      const on = mod.modCol === id;
      const b = el('button', 'cmp-debate-modpick' + (on ? ' is-checked' : ''));
      b.type = 'button';
      b.setAttribute('data-col', id);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.title = ctx.colLabel(colOf(id));
      b.disabled = state.sending;
      b.appendChild(avatar(colOf(id).provider, info, 'cmp-debate-ava')); // no service badge: the chip is too small for it (the title names the service)
      b.appendChild(el('span', null, info.name));
      b.addEventListener('click', () => setModCol(id));
      modPicks.appendChild(b);
    }
    modPicks.appendChild(el('span', 'cmp-debate-modpicks-note', t(mod.modCol && targets.includes(mod.modCol) ? 'debate_mod_pick_note' : 'debate_mod_pick_none')));
  }

  /** The setup block from the current choice: moderator options, the cast, the reason it cannot start. */
  function renderSetup() {
    const inSetup = debateChosen() && !state.sessionStarted;
    // The cards (plan §17.5): `is-debate-setup` on the root restyles the pre-session column heads;
    // off in the cross-check tab and once the session starts (the timeline replaces the grid).
    if (ctx.root) ctx.root.classList.toggle(SETUP_CLASS, inSetup);
    if (!inSetup) { setup.hidden = true; clearSlots(); setupSig = ''; return; }
    const targets = reachable();
    const plan = planCast();
    // The closed / open face (plan §18.3) — every pass, outside the signature: opening the ⚙ must
    // not rebuild the cards or the selects (§18.7 ②).
    const open = state.debatePrefs.settingsOpen === true;
    // A refused alias edit does not hide what blocks the start (Codex U1 1R): both are said, and the
    // 「설정 열기」 follows the start problem.
    const problem = [aliasError ? t(aliasError.key, aliasError.arg) : '', plan.problem ? t(plan.problem, problemArg(plan)) : ''].filter(Boolean).join(' · ');
    const changed = changedNow(targets);
    const mod = modChoice(targets);
    const hint = t(BUDGET_HINT[mod.moderator] || BUDGET_HINT[MOD_AI], DEBATE_SEND_BUDGET);
    if (budgetHint.textContent !== hint) budgetHint.textContent = hint;
    setupBody.hidden = !open;
    summaryBtn.hidden = open || !changed.length;
    summaryBtn.disabled = state.sending; // locked with the ⚙ (its target controls are disabled then — Codex U1 2R)
    if (!summaryBtn.hidden) summaryText.textContent = settingsSummary(changed, plan.modCol ? plan.names.get(plan.modCol).name : '');
    if (setupErrText.textContent !== problem) setupErrText.textContent = problem;
    setupErr.hidden = !problem;
    // Too few debaters because the AI moderator takes a seat: the cards are one way out, the ⚙'s
    // 「진행」 the other — offer it too.
    setupErrOpen.hidden = open || !(problemInSettings(plan.problem) || (plan.problem === 'debate_need_two' && !!plan.modCol));
    setup.hidden = !open && summaryBtn.hidden && setupErr.hidden;
    setup.classList.toggle('is-closed', !open);
    const { settingsOpen, ...shown } = state.debatePrefs;
    const sig = JSON.stringify([targets, targets.map((id) => ctx.colLabel(colOf(id))), shown, mod, [...plan.names.entries()].map(([k, v]) => [k, v.name]), plan.problem, editing, aliasError, state.sending]);
    // The slots live in the column nodes: a rebuilt layout (applyLayout) brings empty ones under an
    // unchanged signature, so an empty slot of the cast forces the redraw.
    const slotsDrawn = targets.every((id) => colOf(id) && colOf(id).debateSlot && colOf(id).debateSlot.firstChild);
    if (sig === setupSig && slotsDrawn) return;
    setupSig = sig;
    // 진행: the AI card needs 3+ reachable AIs (two debaters plus the moderator) — except that a
    // stored AI choice is shown as chosen even then, with why it cannot start (plan §18.7 ①).
    const need3 = targets.length < 3;
    paintGroup(modGroup, mod.moderator, (v) => t(v === MOD_AI && need3 ? 'debate_mod_desc_need3' : `debate_mod_desc_${v}`), (v) => v === MOD_AI && need3);
    paintGroup(stanceGroup, state.debatePrefs.stance, (v) => t(`debate_stance_desc_${v}`));
    // Under for/against the contrarian is off (half the table already argues against): a stored choice stays
    // shown as chosen and says it does not apply (plan §18.7 ①) — it comes back with a free debate.
    const roleOff = (v) => !roleAllowed(state.debatePrefs.stance, v);
    paintGroup(rolesGroup, state.debatePrefs.roles, (v) => t(roleOff(v) ? 'debate_role_desc_devil_procon' : `debate_stance_desc_${v}`), roleOff);
    paintGroup(toneGroup, state.debatePrefs.tone, (v) => t(`debate_tone_desc_${v}`));
    // The pace: an AI moderator reads it; 「자동 순서」 turns it into a turn count (#1909); only 「내가 진행」 has none.
    const noAi = mod.moderator === MOD_USER;
    const paceDesc = (v) => (mod.moderator === MOD_AUTO ? t(`debate_pace_desc_auto_${v}`, autoWrapTurns(v)) : t(`debate_pace_desc_${v}`));
    paintGroup(lengthGroup, state.debatePrefs.length, (v) => t(`debate_length_desc_${v}`));
    paintGroup(paceGroup, state.debatePrefs.pace, (v) => (noAi ? t('debate_pace_desc_needai') : paceDesc(v)), () => noAi);
    renderModPicks(targets, mod, need3);
    toneInput.hidden = state.debatePrefs.tone !== TONE_CUSTOM;
    toneInput.disabled = state.sending;
    if (toneInput.value !== state.debatePrefs.toneCustom && doc_active() !== toneInput) toneInput.value = state.debatePrefs.toneCustom;
    const stances = castStances(plan);
    clearSlots();
    for (const id of plan.debaters) fillSlot(id, castChip(id, plan.names.get(id), false, stances.get(id)), false);
    if (plan.modCol) fillSlot(plan.modCol, castChip(plan.modCol, plan.names.get(plan.modCol), true), true);
  }
  /** The closed ⚙'s line: each setting that differs from the defaults, as the panel names it. */
  function settingsSummary(changed, modName) {
    const p = state.debatePrefs;
    const parts = [];
    for (const k of changed) {
      // The moderator's options already say 「진행」 (내가 진행 / AI 진행: <name>); the AI is named as its card is.
      if (k === SETTING_MODERATOR) {
        const kind = modChoice().moderator;
        parts.push(kind === MOD_AI ? (modName ? t('debate_mod_ai', modName) : t('debate_mod_ai_any')) : t(kind === MOD_USER ? 'debate_mod_user' : 'debate_mod_auto'));
      } else if (k === SETTING_STANCE) {
        parts.push(`${t('debate_stance_label')}: ${t(`debate_stance_opt_${p.stance}`)}`);
      } else if (k === SETTING_ROLES) {
        parts.push(`${t('debate_roles_label')}: ${splitStance(runStance()).roles.map((r) => t(`debate_stance_opt_${r}`)).join(', ')}`);
      } else if (k === SETTING_LENGTH) {
        parts.push(`${t('debate_length_label')}: ${t(`debate_length_opt_${p.length}`)}`);
      } else if (k === SETTING_PACE) {
        parts.push(`${t('debate_pace_label')}: ${t(`debate_pace_opt_${p.pace}`)}`);
      } else if (k === SETTING_TONE) {
        const line = p.tone === TONE_CUSTOM ? cleanTone(p.toneCustom) : '';
        parts.push(`${t('debate_tone_label')}: ${line ? `“${[...line].slice(0, SUMMARY_TONE_CHARS).join('')}${[...line].length > SUMMARY_TONE_CHARS ? '…' : ''}”` : t(`debate_tone_opt_${p.tone}`)}`);
      }
    }
    return parts.join(' · ');
  }
  /** Every column's cast slot emptied (a column outside the cast — gated, hidden — shows none). */
  function clearSlots() {
    for (const col of state.columns.values()) {
      if (!col.debateSlot) continue;
      if (col.debateSlot.firstChild) clear(col.debateSlot);
      col.debateSlot.hidden = true;
      col.node.classList.remove(MOD_CARD_CLASS);
    }
  }
  function fillSlot(id, chip, isMod) {
    const col = colOf(id);
    if (!col || !col.debateSlot) return;
    col.debateSlot.appendChild(chip);
    col.debateSlot.hidden = false;
    col.node.classList.toggle(MOD_CARD_CLASS, isMod);
  }
  /** The `{0}` of a problem sentence: the clashing names, or the tone limit. */
  const problemArg = (plan) => (plan.problem === 'debate_tone_err_long' ? DEBATE_TONE_MAX : plan.conflicts.map((id) => plan.names.get(id).name).join(', '));
  /** Why the debate cannot start right now (an i18n'd sentence), or '' — the send button reads it. */
  function startProblem() {
    if (!debateChosen()) return '';
    const plan = planCast();
    return plan.problem ? t(plan.problem, problemArg(plan)) : '';
  }

  // ── the timeline + the in-session bar ──
  const timeline = el('div', 'cmp-debate-timeline');
  /** A rendered Conclusion card (markConclusion adds the class to the turn's root). */
  const CONCLUSION_CARD_SEL = '.cmp-debate-msg.is-conclusion';
  timeline.id = 'cmp-debate-timeline';
  timeline.hidden = true;
  timeline.setAttribute('aria-live', 'polite');
  // Holder for the turn records the timeline must not show (the composed prompts each column was
  // sent): they stay real turns — copy, history, the export read them — but are not the conversation.
  const hiddenHolder = el('div', 'cmp-debate-hidden');
  hiddenHolder.hidden = true;
  const bar = el('div', 'cmp-debate-bar');
  bar.id = 'cmp-debate-bar';
  bar.hidden = true;
  const barStatus = el('span', 'cmp-debate-status');
  barStatus.id = 'cmp-debate-status';
  barStatus.setAttribute('aria-live', 'polite');
  const barChips = el('div', 'cmp-debate-picks');
  barChips.id = 'cmp-debate-picks';
  barChips.setAttribute('role', 'group');
  barChips.setAttribute('aria-labelledby', 'cmp-debate-picks-label');
  const pauseBtn = el('button', 'cmp-btn cmp-btn-sm cmp-debate-pause', t('debate_pause'));
  pauseBtn.id = 'cmp-debate-pause';
  pauseBtn.type = 'button';
  bar.appendChild(barChips);
  bar.appendChild(barStatus);
  bar.appendChild(pauseBtn);
  // Shown only at a spent budget with an AI moderator (renderBar) — the other answer to 「늘릴까요?」.
  const concludeBtn = el('button', 'cmp-btn cmp-btn-sm cmp-debate-conclude', t('debate_conclude_now'));
  concludeBtn.title = t('debate_conclude_tip');
  concludeBtn.id = 'cmp-debate-conclude';
  concludeBtn.type = 'button';
  concludeBtn.hidden = true;
  bar.appendChild(concludeBtn);
  concludeBtn.addEventListener('click', () => concludeNow());
  pauseBtn.addEventListener('click', () => { if (!state.debate) return; if (isRunning() && !state.debate.pauseAfter) pause(true); else resume(); });

  // Follow like a chat app (2026-09-28 user: 「ChatGPT처럼」): a reader who scrolled up stays where they
  // are while new words arrive; a 「↓」 pill over the dock says there is more below and jumps there.
  let userFollow = true; // the reader is at (or near) the end of the timeline
  let lastTop = 0;
  let lastLayout = ''; // the timeline's own box (clientWidth × clientHeight) at the last scroll event
  let unseen = false; // words arrived below while the reader was away
  // The READER moved up (not the page — start() puts the room at its top by itself): only then does a
  // new speaker leave the view alone.
  let readerMoved = false;
  let upSeq = 0; // bumps on every move up by the reader — a frame scheduled before one never scrolls
  const jumpBtn = el('button', 'cmp-btn cmp-btn-sm cmp-jump cmp-debate-jump', t('debate_jump'));
  jumpBtn.id = 'cmp-debate-jump';
  jumpBtn.type = 'button';
  jumpBtn.hidden = true;
  jumpBtn.setAttribute('aria-label', t('debate_jump_aria'));
  bar.appendChild(jumpBtn); // the dock is sticky: the pill floats just above it, over the timeline's end
  const fromEnd = () => {
    const { scrollTop, clientHeight, scrollHeight } = timeline;
    return [scrollTop, clientHeight, scrollHeight].every(Number.isFinite) ? scrollHeight - (scrollTop + clientHeight) : null;
  };
  function syncJump() {
    const f = fromEnd();
    const away = !timeline.hidden && f !== null && f > DEBATE_FOLLOW_PX;
    if (!away) unseen = false;
    jumpBtn.hidden = !away;
    jumpBtn.textContent = t(unseen ? 'debate_jump_new' : 'debate_jump');
    jumpBtn.classList.toggle('has-new', unseen);
  }
  timeline.addEventListener('scroll', () => {
    const top = timeline.scrollTop;
    const f = fromEnd();
    if (f === null) return;
    // A move a RESIZE made (the box changes, the text re-wraps, scrollTop is clamped) is not the reader
    // scrolling up. The box only — a stream grows scrollHeight all the time, and a scrollbar drag up
    // during one must still count.
    const layout = `${timeline.clientWidth}x${timeline.clientHeight}`;
    const relaid = layout !== lastLayout;
    lastLayout = layout;
    // Up = the reader is reading (a stream that grows the page never moves scrollTop up); back
    // at the end = follow again.
    if (top < lastTop - 1 && !relaid) { userFollow = false; readerMoved = true; upSeq += 1; } else if (f <= DEBATE_FOLLOW_PX) { userFollow = true; readerMoved = false; }
    lastTop = top;
    syncJump();
  });
  // The intent, before its scroll lands: a paint scheduled in this frame must not pull the reader back
  // (the old reader only learned from the scroll event — a small scroll up during a stream snapped back).
  const readerUp = () => { userFollow = false; readerMoved = true; upSeq += 1; };
  timeline.addEventListener('wheel', (e) => { if (e.deltaY < 0) readerUp(); }, { passive: true });
  let touchY = null;
  timeline.addEventListener('touchstart', (e) => { touchY = e.touches && e.touches[0] ? e.touches[0].clientY : null; }, { passive: true });
  timeline.addEventListener('touchmove', (e) => { const y = e.touches && e.touches[0] ? e.touches[0].clientY : null; if (y !== null && touchY !== null && y > touchY) readerUp(); touchY = y; }, { passive: true });
  timeline.addEventListener('keydown', (e) => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) readerUp(); });
  jumpBtn.addEventListener('click', () => {
    userFollow = true;
    readerMoved = false;
    unseen = false;
    try { timeline.scrollTo({ top: timeline.scrollHeight, behavior: 'smooth' }); } catch { timeline.scrollTop = timeline.scrollHeight; }
    syncJump();
  });
  // A resize fires no scroll: a narrower window re-wraps every bubble below a scrollTop that stays
  // put, so a reader who was at the end was left mid-conversation (#1819). Keep them at the end.
  const RO = ctx.win && typeof ctx.win.ResizeObserver === 'function' ? ctx.win.ResizeObserver : null;
  if (RO) new RO(() => { if (userFollow) timeline.scrollTop = timeline.scrollHeight; }).observe(timeline);
  /** Keep the newest words in view while the reader is at the end (`force`: a new turn started). */
  function follow(force = false) {
    if (!force && !userFollow) { unseen = true; syncJump(); return; }
    if (force) userFollow = true;
    // Re-checked in the frame: the reader may have scrolled up after this was scheduled — then even a
    // forced follow (a new speaker, the user's own message) stays put (Codex 1R: 400 → 1000).
    const seq = upSeq;
    ctx.raf(() => {
      if (seq !== upSeq || (!force && !userFollow)) { unseen = true; syncJump(); return; }
      timeline.scrollTop = timeline.scrollHeight;
      syncJump();
    });
  }

  /** Where a turn's DOM goes: the timeline in a debate session, the column body otherwise. */
  function turnHost(col, turn) {
    const d = state.debate;
    if (!d) return col.body;
    if (turn && turn.role === 'user' && turn.kind === TURN_KIND_DEBATE) return hiddenHolder;
    if (turn && turn.role === 'skipped') return hiddenHolder;
    if (d.phase === PHASE_OPENING && d.openingGroup) return d.openingGroup;
    return timeline;
  }
  /**
   * A chat message row (plan §11.2 / §11.4 ④): `turn.root` ITSELF becomes the row — the avatar goes
   * in as its first child and CSS lays it out as a grid (avatar | the name line, the activity panel,
   * the bubble = `turn.node`, the copy icon). Nothing is wrapped, so a rollback's `turn.root.remove()`
   * takes the whole row and `paintAssistant` still repaints only the bubble.
   */
  function decorateTurn(col, turn) {
    const d = state.debate;
    if (!d || !turn || turn.role !== 'assistant') return;
    const info = d.names.get(col.id) || { name: ctx.colLabel(col), emoji: '' };
    const isMod = col.id === d.modCol;
    turn.debateRole = isMod ? ROLE_MODERATOR : ROLE_PARTICIPANT;
    turn.debateProvider = col.provider; // #1856 stage 0 reads it when the turn is revealed
    const ava = avatar(col.provider, info, 'cmp-debate-ava', true);
    const head = el('div', 'cmp-debate-meta');
    head.appendChild(el('span', 'cmp-debate-name', info.name));
    turn.debateSvc = el('span', 'cmp-debate-svc', ctx.colLabel(col));
    head.appendChild(turn.debateSvc);
    if (isMod) head.appendChild(el('span', 'cmp-debate-badge is-moderator', t('debate_role_moderator')));
    appendStanceBadges(head, d.stances.get(col.id), 'cmp-debate-badge');
    turn.debateHead = head;
    turn.root.classList.add('cmp-debate-msg', 'is-typing');
    // 「입력이 끝나면 한 번에」 (plan §14 / §14.1 ①②): while the answer streams the row shows a typing
    // bubble — the words are painted as always but hidden, from the accessibility tree too (the
    // timeline is aria-live) — and reveal() shows them all at once when the turn settles.
    turn.node.setAttribute('aria-hidden', 'true');
    // #1854: a turn that searches the web says so beside the dots while it types (the 과정 panel is
    // hidden until the answer is revealed) — a 97-second search read as a stalled debate.
    if (turn.activity) turn.activity.onSearch = (n) => noteSearch(turn, n);
    d.typing.add(turn);
    if (isMod) turn.root.classList.add('is-moderator');
    turn.root.insertBefore(head, turn.root.firstChild);
    turn.root.insertBefore(ava, head);
    if (!d.restoring) watchSlow(col, turn);
    // A new speaker is followed only by a reader already at the end (2026-09-28 user: 「ChatGPT처럼」 —
    // it used to pull everyone down at every turn; a reader scrolled up gets the 「↓ 새 발언」 pill).
    // During the opening start() shows the room from the top (#1818 ⑩) and nothing pulls (§11.4 ⑤);
    // the first speaker after it brings a reader who has not moved along.
    follow(d.phase !== PHASE_OPENING && !readerMoved);
  }
  /**
   * #1854: 「🔍 웹 검색 중 · 3회」 beside the typing dots. Drawn by CSS from an attribute on the bubble
   * (`data-typing-note`, `::before`) — the bubble's children are repainted as the answer streams, an
   * attribute survives that. The first search is announced once through a screen-reader-only line;
   * the count updates are not (the timeline is aria-live).
   */
  function noteSearch(turn, n) {
    if (!turn || !turn.node || !turn.root || !turn.root.classList.contains('is-typing')) return;
    turn.node.setAttribute('data-typing-note', `\u{1F50D} ${t('debate_typing_search', n)}`);
    if (!turn.searchAnnounced) {
      turn.searchAnnounced = true;
      const sr = el('span', 'cmp-sr-only cmp-debate-typing-sr', t('col_searching'));
      turn.root.appendChild(sr);
      turn.typingSr = sr;
    }
  }
  /**
   * #1856 stage 0: a revealed turn that names links but ran no web search this turn gets 「⚠️ 검색
   * 기록 없음」 beside its name — the links may be recalled rather than looked up. Live turns only: a
   * restored turn has no activity record to judge by. Screen only (not the transcript or a share).
   */
  function flagUnsearchedLinks(turn) {
    const d = state.debate;
    // Not the moderator (it hands the floor, it does not argue a sourced point — 1R).
    if (!d || d.restoring || !turn || !turn.debateHead || turn.debateNoSearch || !turn.activity || turn.errorText || turn.debateRole === ROLE_MODERATOR) return;
    // Everything already on record: the topic, every transcript line but this turn's own, and the user's
    // words still queued (sent while this turn was typing — 1R #2).
    // This turn's own line is still `pending` here (reveal runs before recordRound settles it); a
    // settled line is on record whatever its words — even the same words repeated (2R).
    const knownTexts = [d.topic, ...d.transcript.filter((e) => !e.pending && e.text).map((e) => e.text), ...d.queue.map((q) => q.text)];
    const links = unsearchedLinks({ provider: turn.debateProvider, text: turn.text, searches: turn.activity.searches, knownTexts });
    if (!links.length) return;
    turn.debateNoSearch = true;
    const badge = el('span', 'cmp-debate-badge is-warn', t('debate_nosearch_badge'));
    badge.title = t('debate_nosearch_tip');
    turn.debateHead.appendChild(badge);
  }
  /**
   * #1862: a long debater turn shows its beginning and 「더 보기」 — a long reply no longer costs the
   * reader the flow of the debate. The fold height follows the reply-length setting (a 「길게」 debate
   * folds later). Never the moderator or the conclusion; measured a frame after the words appear.
   */
  // Every live fold watcher — 새 대화 / a history load (reset) disconnects them all (2R follow-up: no leak).
  const foldObservers = new Set();
  function foldIfLong(turn) {
    const d = state.debate;
    if (!FOLD_ENABLED || !d || !turn || !turn.root || !turn.node || turn.debateFoldWatch || turn.debateRole === ROLE_MODERATOR) return;
    turn.debateFoldWatch = true;
    const limit = FOLD_PX[d.length] || FOLD_PX[LENGTH_NORMAL];
    const fold = (on) => { turn.root.classList.toggle('is-folded', on); turn.node.style.maxHeight = on ? `${limit}px` : ''; };
    const setOpen = (open) => {
      fold(!open);
      turn.debateFold.textContent = t(open ? 'debate_less' : 'debate_more');
      turn.debateFold.setAttribute('aria-expanded', String(open));
    };
    // Measured now and again whenever the bubble grows (1R: an output image or a re-wrap made it long
    // after the first frame) — until it has folded once; the user's own 「접기/더 보기」 rules after that.
    let observer = null;
    const measure = () => {
      if (turn.debateFold || !turn.root.isConnected) { if (observer && !turn.root.isConnected) observer.disconnect(); return; }
      if (turn.node.scrollHeight <= limit + FOLD_SLACK_PX) return;
      if (observer) { observer.disconnect(); foldObservers.delete(observer); }
      const btn = el('button', 'cmp-debate-more', t('debate_more'));
      btn.type = 'button';
      turn.debateFold = btn;
      btn.addEventListener('click', () => setOpen(turn.root.classList.contains('is-folded')));
      turn.root.appendChild(btn);
      setOpen(false);
      // Keyboard focus moving INTO the folded part opens it (1R follow-up: a link below the fold took focus unseen).
      // Only when the focused element sits BELOW the fold (2R: a visible link at the top reopened a turn the user had folded).
      // Judged by the element's place in the bubble, not the screen: focusing it scrolls the clipped box itself.
      turn.node.addEventListener('focusin', (e) => {
        if (!turn.root.classList.contains('is-folded') || !e || !e.target) return;
        let y = 0;
        for (let el = e.target; el && el !== turn.node; el = el.offsetParent) y += el.offsetTop || 0;
        if (turn.node.scrollTop > 0 || y + (e.target.offsetHeight || 0) > limit) { setOpen(true); turn.node.scrollTop = 0; }
      });
    };
    ctx.raf(measure);
    const RO = ctx.win && ctx.win.ResizeObserver;
    if (typeof RO === 'function') { observer = new RO(() => measure()); observer.observe(turn.node); foldObservers.add(observer); }
  }
  /** 「오후 3:12」 / 「3:12 PM」 — the clock time a bubble shows beside it. */
  function clockNow() {
    try { return new Date(ctx.clock.now()).toLocaleTimeString(ctx.lang === 'ko' ? 'ko-KR' : 'en-US', { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
  }
  /**
   * A turn settled (column-thread settleTurn — every way a turn ends: DONE, ERROR, ALL_DONE, a
   * stop, a lost port): its words appear at once, with the clock time beside the bubble. Idempotent;
   * onRoundSettled sweeps whatever is still typing (§14.1 ①).
   */
  function reveal(turn) {
    const d = state.debate;
    if (!turn || !turn.root || !turn.root.classList.contains('is-typing')) return;
    unwatchSlow(turn);
    if (turn.debateSkipped) showSkipped(turn);
    turn.root.classList.remove('is-typing');
    turn.root.classList.add('is-revealed');
    turn.node.removeAttribute('aria-hidden');
    flagUnsearchedLinks(turn);
    foldIfLong(turn);
    // The search note goes with the dots (#1854) — the 과정 chip carries the record from here.
    turn.node.removeAttribute('data-typing-note');
    if (turn.typingSr) { turn.typingSr.remove(); turn.typingSr = null; }
    if (!turn.debateSide) {
      const side = el('div', 'cmp-debate-side');
      // A turn read back from the history has no clock time (it was never stored) — not 「now」.
      if (!(d && d.restoring)) side.appendChild(el('span', 'cmp-debate-clock', clockNow()));
      turn.root.appendChild(side);
      turn.debateSide = side;
    }
    if (d) d.typing.delete(turn);
    // A turn left waiting in the opening may now be the only one the round waits for (holdsRound) —
    // looked at once this settle's own handler is through (a skip posts ABORT, which settles the round).
    if (d && d.typing.size) Promise.resolve().then(() => { for (const other of [...d.typing]) checkSlow(other); });
    follow();
  }

  // ── slow turns (2026-09-30 user decision) ──
  // A turn with no answer text DEBATE_SLOW_NOTE_MS after its send offers 「이번 차례 건너뛰기」; at
  // DEBATE_SLOW_SKIP_MS (a column's first turn: DEBATE_SLOW_SKIP_FIRST_MS) it is skipped by itself. A skip is the page's one Stop (ABORT) — so it is only
  // offered while this turn is all the round waits for: the opening's other debaters still writing
  // would be aborted with it. Every exit clears the timers: the first words (firstText), the turn
  // settling (reveal), a refused round, 새 대화 / a history load (reset), the page closing.
  const SLOW_NOTE = 1;
  const SLOW_SKIP = 2;
  const slowTurns = new Set(); // turns whose slow timers are live
  const secsOf = (ms) => Math.round(ms / MS_PER_SECOND);
  /**
   * The column's first turn of the session: nothing it said before has any words (the opening, the
   * moderator's first call, or a turn after a first one that was skipped). A new conversation on that AI with
   * the run's longest prompt — it gets DEBATE_SLOW_SKIP_FIRST_MS (see constants).
   */
  const isFirstTurn = (col, turn) => !(col.turns || []).some((x) => x !== turn && x.role === 'assistant' && x.text);
  function watchSlow(col, turn) {
    turn.debateCol = col;
    turn.debateSentAt = ctx.clock.now();
    turn.debateFirst = isFirstTurn(col, turn);
    turn.debateSkipMs = turn.debateFirst ? DEBATE_SLOW_SKIP_FIRST_MS : DEBATE_SLOW_SKIP_MS;
    // When the auto-skip is due, from the send — moved later if the round gets under way late (checkSlow).
    turn.debateSkipAt = turn.debateSentAt + turn.debateSkipMs;
    const at = (stage, ms) => ctx.clock.setTimeout(() => { turn.debateSlowStage = stage; checkSlow(turn); }, ms);
    turn.debateSlowTimers = [at(SLOW_NOTE, DEBATE_SLOW_NOTE_MS), at(SLOW_SKIP, turn.debateSkipMs)];
    slowTurns.add(turn);
  }
  function unwatchSlow(turn) {
    if (!turn || !slowTurns.has(turn)) return;
    for (const id of turn.debateSlowTimers || []) ctx.clock.clearTimeout(id);
    turn.debateSlowTimers = null;
    slowTurns.delete(turn);
    dropNote(turn);
  }
  const clearSlow = () => { for (const turn of [...slowTurns]) unwatchSlow(turn); };
  const dropNote = (turn) => { if (turn.debateSlowNote) { turn.debateSlowNote.remove(); turn.debateSlowNote = null; } };
  /**
   * A turn's first words (or image) arrived (port.js CHUNK / IMAGE): it is no longer slow. In the opening
   * the others' offer goes too — skipping them now would abort this answer (it comes back when this one settles).
   */
  function firstText(turn) {
    unwatchSlow(turn);
    const held = state.debate ? waitingOn() : null;
    if (!held || held.length !== 1) for (const other of slowTurns) dropNote(other);
  }
  /** Nothing has arrived for this turn yet — no words, no image. */
  const silent = (turn) => !turn.text && !(ctx.outImageCount && ctx.outImageCount(turn));
  /** The turns the round in flight still waits for — null when any of them has started answering. */
  function waitingOn() {
    const d = state.debate;
    const out = [];
    for (const id of state.roundTargets || []) {
      const col = colOf(id);
      if (!col || col.status !== 'streaming') continue;
      const turn = ctx.lastAssistantTurn(col);
      if (!turn || !slowTurns.has(turn) || !d.typing.has(turn) || !silent(turn)) return null;
      out.push(turn);
    }
    return out;
  }
  /** A timer fired, or another turn of the round settled: note, skip, or nothing. */
  function checkSlow(turn) {
    const d = state.debate;
    if (!slowTurns.has(turn)) return;
    if (!d || !d.typing.has(turn) || !turn.root.isConnected || !silent(turn)) { unwatchSlow(turn); return; }
    if (!turn.debateSlowStage || !state.sending) return;
    // Before CONSUME_OK there is no Stop (the SW is still preparing — an ABORT then is a refused round
    // that pauses the debate): looked at again each tick until the round is under way.
    if (!ctx.stopBtn || ctx.stopBtn.disabled) { turn.debateHeldBack = true; turn.debateSlowTimers.push(ctx.clock.setTimeout(() => checkSlow(turn), WAIT_TICK_MS)); return; }
    // Under way only after a stage was due: the auto-skip waits the note's own lead (skip − note) from here —
    // the least a turn gets once its round is under way (Codex 1R #1: a prepare that took 60 s must not be skipped
    // the moment the model is asked). The note then quotes that moved deadline, not the planned one.
    if (turn.debateHeldBack) {
      const lead = turn.debateSkipMs - DEBATE_SLOW_NOTE_MS;
      turn.debateHeldBack = false; turn.debateLate = true; turn.debateWasLate = true;
      turn.debateSkipAt = Math.max(turn.debateSkipAt, ctx.clock.now() + lead);
      turn.debateSlowTimers.push(ctx.clock.setTimeout(() => { turn.debateLate = false; checkSlow(turn); }, lead));
    }
    const held = waitingOn();
    if (!held || !held.includes(turn)) return;
    // At 60 s every turn still silent goes (several only in an opening where none has answered).
    if (held.every((x) => x.debateSlowStage >= SLOW_SKIP && !x.debateLate)) { skipTurns(held, secsOf(turn.debateWasLate ? ctx.clock.now() - turn.debateSentAt : turn.debateSkipMs)); return; }
    // The button skips one speaker: offered only on the one turn the round is left waiting for.
    if (held.length !== 1 || turn.debateSlowNote) return;
    const box = el('div', 'cmp-debate-slow');
    box.appendChild(el('p', 'cmp-debate-slow-text', t('debate_slow_note', secsOf(DEBATE_SLOW_NOTE_MS), turn.debateFirst ? DEBATE_SLOW_SHARE_FIRST_PCT : DEBATE_SLOW_SHARE_PCT, secsOf(turn.debateSkipAt - turn.debateSentAt))));
    const btn = el('button', 'cmp-debate-slow-skip', t('debate_slow_skip'));
    btn.type = 'button';
    btn.addEventListener('click', () => { const now = waitingOn(); if (now && now.length === 1 && now[0] === turn) skipTurns(now, secsOf(ctx.clock.now() - turn.debateSentAt)); });
    box.appendChild(btn);
    turn.root.appendChild(box);
    turn.debateSlowNote = box;
    follow();
  }
  /**
   * Skip the turns the round waits for: the round's Stop (the same ABORT as 「중지」 — the SW aborts only
   * what has not settled), marked so recordRound moves on instead of pausing. Once per round.
   */
  function skipTurns(turns, secs) {
    const d = state.debate;
    if (!d || !d.current || d.current.skipped || !state.sending || !state.port || !ctx.stopBtn || ctx.stopBtn.disabled) return;
    d.current.skipped = true;
    for (const turn of turns) {
      const name = nameOf(turn.debateCol.id);
      turn.debateSkipped = t('debate_slow_skipped', name, subjectParticle(name), secs);
      unwatchSlow(turn);
    }
    try { state.port.postMessage({ type: 'ABORT' }); } catch { /* the port is gone; the round settles on its own */ }
  }
  /** A skipped turn settles as its line, never as 「중지됐어요」 or whatever slipped in before the abort landed. */
  function showSkipped(turn) {
    turn.text = '';
    turn.outImages = null; // an image that slipped in before the abort landed (Codex 1R #2)
    turn.errorText = turn.debateSkipped;
    turn.root.classList.add('is-skipped');
    if (turn.debateCol) ctx.paintAssistant(turn.debateCol);
  }
  /**
   * The moderator's closing message becomes the 「결론」 card (#1817 ②): a divider above it and the
   * card's own emphasis. Screen and 「전체 복사」 only — the transcript, the prompts and the share
   * snapshot keep it a plain moderator line.
   */
  /**
   * A live conclusion's missing blank lines put back (tightenConclusion) — in the turn's text, so the card,
   * 「전체 복사」, the history and the transcript entry all read the same thing. Repainted when it is still
   * the column's last turn (it is: this runs right as the conclusion settles).
   */
  function tightenConclusionTurn(turn, entry) {
    if (!turn) return;
    const tight = tightenConclusion(turn.text, conclusionLabels(`${t('debate_conclusion_format')}\n${t('debate_conclusion_format_friends')}`));
    if (tight === turn.text) return;
    turn.text = tight;
    if (entry) entry.text = turn.debateRole === ROLE_MODERATOR ? splitControl(tight).body : tight;
    const col = turn.debateCol;
    if (col && col.turns[col.turns.length - 1] === turn) ctx.paintAssistant(col);
  }
  function markConclusion(turn) {
    if (!turn || !turn.root || turn.debateConclusion) return;
    turn.debateConclusion = true;
    turn.root.classList.add('is-conclusion');
    if (turn.root.parentNode) turn.root.parentNode.insertBefore(el('div', 'cmp-debate-divider is-conclusion', t('debate_conclusion')), turn.root);
  }
  /**
   * #1917: 「이 토론, 도움이 됐나요? 👍 👎」 under a conclusion that happened LIVE on this page (a restored or shared
   * debate is not asked about). The rating is sent on the click; a 👎 opens its reason chips, either opens an
   * optional note, and 「보내기」 sends them — the same row (session · run · leg), the latest wins. 🔴 Nothing of
   * the conversation is sent: the payload is the rating, the chips, the user's own note and the run's settings.
   */
  function offerFeedback(turn, concludedBy) {
    const d = state.debate;
    if (!d || !turn || !turn.root || !turn.root.parentNode || !state.sessionId || !Number.isFinite(d.run)) return;
    d.fbLeg = Number.isInteger(d.fbLeg) ? d.fbLeg + 1 : 0;
    const leg = d.fbLeg;
    const run = d.run;
    const box = el('div', 'cmp-debate-fb');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', t('debate_fb_q'));
    const row = el('div', 'cmp-debate-fb-row');
    row.appendChild(el('span', 'cmp-debate-fb-q', t('debate_fb_q')));
    const rateBtn = (rating, glyph) => {
      const b = el('button', 'cmp-debate-fb-rate', glyph);
      b.type = 'button';
      b.setAttribute('data-rating', rating);
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', t(`debate_fb_${rating}`));
      b.title = t(`debate_fb_${rating}`);
      return b;
    };
    const up = rateBtn('up', '\u{1F44D}');
    const down = rateBtn('down', '\u{1F44E}');
    row.appendChild(up);
    row.appendChild(down);
    const thanks = el('span', 'cmp-debate-fb-thanks', t('debate_fb_thanks'));
    thanks.hidden = true;
    row.appendChild(thanks);
    box.appendChild(row);
    const more = el('div', 'cmp-debate-fb-more');
    more.hidden = true;
    const chips = el('div', 'cmp-debate-fb-reasons');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', t('debate_fb_reasons_label'));
    const picked = new Set();
    for (const r of DEBATE_FEEDBACK_REASONS) {
      const c = el('button', 'cmp-debate-fb-chip', t(`debate_fb_reason_${r}`));
      c.type = 'button';
      c.setAttribute('role', 'checkbox');
      c.setAttribute('aria-checked', 'false');
      c.setAttribute('data-reason', r);
      c.addEventListener('click', () => {
        if (picked.has(r)) picked.delete(r); else picked.add(r);
        c.setAttribute('aria-checked', picked.has(r) ? 'true' : 'false');
      });
      chips.appendChild(c);
    }
    more.appendChild(chips);
    const note = el('textarea', 'cmp-debate-fb-note');
    note.rows = 2;
    note.maxLength = DEBATE_FEEDBACK_NOTE_MAX;
    note.placeholder = t('debate_fb_note_placeholder');
    note.setAttribute('aria-label', t('debate_fb_note_label'));
    more.appendChild(note);
    const foot = el('div', 'cmp-debate-fb-foot');
    foot.appendChild(el('span', 'cmp-debate-fb-privacy', t('debate_fb_privacy')));
    const send = el('button', 'cmp-btn cmp-btn-sm cmp-debate-fb-send', t('debate_fb_send'));
    send.type = 'button';
    foot.appendChild(send);
    more.appendChild(foot);
    box.appendChild(more);
    let rating = null;
    let seq = 0; // this row's send order — the server keeps the latest (1R #1)
    // Once the reasons/note reached the server, a later rating click must carry them: the server upserts the whole row,
    // so a bare rating would silently wipe the stored note while the box still shows it (1.48.0 batch review).
    let detailsSent = false;
    // The run's settings and cast at the conclusion — what the rating is ABOUT (never its words).
    const facts = (() => {
      const modC = d.modKind === MOD_AI && d.modCol ? colOf(d.modCol) : null;
      const tierAt = (id) => { for (let i = d.transcript.length - 1; i >= 0; i--) { const e = d.transcript[i]; if (e.speaker === id && e.tierKey) return e.tierKey; } return colTier(id); };
      return {
        kind: 'debate', session_id: state.sessionId, run, leg, concluded_by: concludedBy,
        pace: d.pace, length: d.length, moderator: d.modKind, stance: d.stance, tone: d.tone.kind, n: d.debaters.length,
        turns: Math.max(0, d.turnsUsed - d.turnsAtRun),
        ...(modC ? { mod_provider: modC.provider, mod_tier: tierSlug(tierOf(modC.provider, modC.model, ctx.modelLabelOf(modC.provider, modC.model))) } : {}),
        cast: d.debaters.map((id) => { const c = colOf(id); return { provider: c ? c.provider : '', tier: tierSlug(tierAt(id)) || 'unknown' }; }),
      };
    })();
    // ONE rule for the form (3R — closed by narrowing, not by another round): it shows the LATEST send's latest known
    // answer. `show(ok)` is called for a send only while it is the latest (seq); no answer within
    // DEBATE_FEEDBACK_TIMEOUT_MS shows a failure for now, and a real answer arriving later still replaces it (a late
    // success reads as a success). Choosing a rating starts the form over — no older send can hold its button.
    const post = (withDetails, show) => {
      const reasons = rating === 'down' ? DEBATE_FEEDBACK_REASONS.filter((r) => picked.has(r)) : [];
      const text = withDetails ? note.value.trim().slice(0, DEBATE_FEEDBACK_NOTE_MAX) : '';
      seq += 1;
      const mine = seq;
      const report = (ok) => { if (mine === seq) show(ok); };
      const timer = setTimeout(() => report(false), DEBATE_FEEDBACK_TIMEOUT_MS);
      const settle = (ok) => { clearTimeout(timer); report(ok); };
      try {
        const r = chrome.runtime.sendMessage({ type: FEEDBACK_MSG_TYPE, payload: { ...facts, seq: mine, rating, reasons, ...(text ? { note: text } : {}) } }, (res) => { void chrome.runtime.lastError; settle(!!(res && res.ok === true)); });
        if (r && typeof r.catch === 'function') r.catch(() => settle(false));
      } catch { settle(false); }
      track('debate_feedback', { rating, reasons: reasons.length, note: text ? 1 : 0 });
    };
    const say = (key, failed) => { thanks.textContent = t(key); thanks.classList.toggle('is-failed', failed); thanks.hidden = false; };
    const choose = (value) => {
      // Re-pressing the selected rating is not a new answer — sending it again could only lose what was sent.
      if (value === rating) return;
      rating = value;
      for (const b of [up, down]) b.setAttribute('aria-pressed', b.getAttribute('data-rating') === value ? 'true' : 'false');
      chips.hidden = value !== 'down';
      more.hidden = false;
      thanks.hidden = true;
      send.disabled = false;
      send.textContent = t('debate_fb_send');
      // The rating counts even if the note is never sent — and a rating the server did not store says so (2R).
      post(detailsSent, (ok) => { if (!ok) say('debate_fb_failed', true); else if (thanks.classList.contains('is-failed')) thanks.hidden = true; });
    };
    up.addEventListener('click', () => choose('up'));
    down.addEventListener('click', () => choose('down'));
    send.addEventListener('click', () => {
      if (!rating || send.disabled) return;
      send.disabled = true;
      send.textContent = t('debate_fb_sending');
      thanks.hidden = true;
      post(true, (ok) => {
        send.disabled = false;
        send.textContent = t(ok ? 'debate_fb_send' : 'debate_fb_retry');
        if (ok) detailsSent = true;
        say(ok ? 'debate_fb_thanks' : 'debate_fb_failed', !ok);
        more.hidden = ok; // a failed send keeps the form (and the note) for 「다시 보내기」
      });
    });
    turn.root.parentNode.insertBefore(box, turn.root.nextSibling);
  }
  /**
   * #1852: a moderator's question TO THE USER looks like one — a 「❓ 나에게 질문」 divider and a marked
   * bubble (the plain moderator bubble read like any other turn and was easy to miss).
   */
  function markAsked(turn) {
    if (!turn || !turn.root || turn.debateAsked) return;
    turn.debateAsked = true;
    turn.root.classList.add('is-ask');
    if (turn.root.parentNode) turn.root.parentNode.insertBefore(el('div', 'cmp-debate-divider is-ask', t('debate_asked_you')), turn.root);
  }
  /** What a turn's text renders as: a moderator's reply without its control line. */
  function displayText(turn) {
    return turn && turn.debateRole === ROLE_MODERATOR ? splitControl(turn.text).body : (turn ? turn.text : '');
  }
  /** The room's head line at the top of the timeline: the cast's avatars, who moderates, the positions. */
  function roomHead(d) {
    const head = el('div', 'cmp-debate-room');
    const avas = el('span', 'cmp-debate-room-avas');
    avas.setAttribute('aria-hidden', 'true');
    for (const id of [...d.debaters, ...(d.modCol ? [d.modCol] : [])]) {
      avas.appendChild(avatar(colOf(id).provider, d.names.get(id), 'cmp-debate-ava', true));
    }
    head.appendChild(avas);
    const mod = d.modCol ? nameOf(d.modCol) : t(d.modKind === MOD_USER ? 'debate_mod_user' : 'debate_mod_auto');
    head.appendChild(el('span', 'cmp-debate-room-line', t('debate_room_line', mod, stanceLabel(d.stance))));
    return head;
  }
  /**
   * The user's own avatar beside their bubble (2026-09-27 user request): the Google photo from the
   * popup's Google sign-in (`state.mePhoto`, bound to the account — bg/profile-photo.js), else
   * the first letter of the account name / email, else nothing. Screen only: never in a prompt, the
   * history or a copy. Decoration (aria-hidden) — the bubble's place already says who.
   */
  function meAvatar() {
    const photo = state.mePhoto;
    const letter = [...String(state.feedbackName || state.feedbackEmail || '').trim()][0] || '';
    if (!photo && !letter) return null;
    const a = el('span', 'cmp-debate-ava cmp-debate-me-ava');
    a.setAttribute('aria-hidden', 'true');
    const tile = () => { a.textContent = letter.toUpperCase(); a.classList.add('is-letter'); };
    if (photo) {
      const img = el('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer'; // Google's photo host refuses some referrers
      img.addEventListener('error', () => { img.remove(); if (letter) tile(); else a.remove(); }, { once: true });
      img.src = photo;
      a.appendChild(img);
    } else tile();
    return a;
  }
  /** The account was read after bubbles were drawn (it is async): give them their avatar now. */
  ctx.debateMeChanged = () => {
    for (const block of timeline.querySelectorAll('.cmp-debate-user')) {
      const old = block.querySelector('.cmp-debate-me-ava');
      const me = meAvatar();
      if (old) old.remove();
      if (me) block.insertBefore(me, block.firstChild);
    }
  };
  /** The words of each user bubble in the timeline (the 「전체 복사」 walk reads them back). */
  const userText = new WeakMap();
  /** A user bubble in the timeline (the topic, or a message typed mid-debate); `clock` '' = none (a restored one). */
  function userBubble(text, queued = false, clock = clockNow()) {
    const block = el('div', 'cmp-debate-user' + (queued ? ' is-queued' : ''));
    const bubble = el('div', 'cmp-debate-ububble', text);
    userText.set(block, text);
    const me = meAvatar();
    if (me) block.appendChild(me);
    block.appendChild(bubble);
    const side = el('div', 'cmp-debate-side');
    if (queued) side.appendChild(el('span', 'cmp-debate-queued', t('debate_queued')));
    if (clock) side.appendChild(el('span', 'cmp-debate-clock', clock));
    block.appendChild(side);
    timeline.appendChild(block);
    follow(true);
    return block;
  }

  // ── orchestrator ──
  const STOPPED = [PHASE_PAUSED, PHASE_BUDGET, PHASE_HIDDEN, PHASE_DONE, PHASE_TOO_FEW, PHASE_DEAD, PHASE_AWAIT, PHASE_ASKED];
  const isRunning = () => !!state.debate && !STOPPED.includes(state.debate.phase);
  // When the tab went hidden (null while visible) — advance() pauses before the next send once it
  // has been hidden for DEBATE_HIDDEN_PAUSE_MS (§15.1 ②).
  let hiddenSince = null;
  const docHidden = () => !!(ctx.doc && ctx.doc.hidden);
  if (ctx.doc && typeof ctx.doc.addEventListener === 'function') {
    ctx.doc.addEventListener('visibilitychange', () => { hiddenSince = docHidden() ? ctx.clock.now() : null; });
    // #1842: closing the page ends the run as 「left」 (reportFinish skips a run that already reported its end).
    if (ctx.win && typeof ctx.win.addEventListener === 'function') ctx.win.addEventListener('pagehide', () => { clearSlow(); reportFinish('left'); });
  }
  /**
   * A stopped debate starts moving again (▶ 계속, a pick chip, the user speaking): a spent budget
   * gets another DEBATE_SEND_BUDGET, the hidden-tab clock restarts. Dead / too-few stay stopped.
   */
  function reopen(d) {
    d.pauseAfter = false; // moving again cancels a 「멈춤」 still waiting for the turn in flight
    if (!STOPPED.includes(d.phase) || d.phase === PHASE_DEAD || d.phase === PHASE_TOO_FEW) return;
    if (d.sendsUsed >= d.sendBudget) { d.sendBudget = d.sendsUsed + DEBATE_SEND_BUDGET; d.wrapGranted = false; }
    hiddenSince = docHidden() ? ctx.clock.now() : null;
    d.phase = PHASE_SPEAKING;
  }
  const nameOf = (id) => (id === SPEAKER_USER ? t('debate_name_user') : (state.debate.names.get(id) || {}).name || id);
  const candidates = () => state.debate.debaters.map((id) => { const c = colOf(id); return { id, names: [nameOf(id), ctx.colLabel(c), ctx.modelLabelOf(c.provider, c.model)].filter(Boolean), words: (state.debate.names.get(id) || {}).words || [] }; });
  const lastSeq = () => (state.debate.transcript.length ? state.debate.transcript[state.debate.transcript.length - 1].seq : 0);

  /**
   * The first send of a debate session (sendInitial routes here when the toggle is on). Returns
   * false when it cannot start — the send button already says why (startProblem).
   */
  function start(topic) {
    const plan = planCast();
    if (plan.problem) { renderSetup(); return false; }
    if (topic.length > DEBATE_TOPIC_MAX) { ctx.showNotice('warn', [t('debate_topic_long', DEBATE_TOPIC_MAX)]); return false; }
    const { debaters, modCol, names } = plan;
    const stances = castStances(plan);
    const openingGroup = el('div', 'cmp-debate-opening');
    state.debate = {
      topic, debaters, modCol, names, stances, stance: runStance(), pace: state.debatePrefs.pace, length: state.debatePrefs.length || LENGTH_NORMAL, asks: 0, longFor: null,
      run: ctx.clock.now(), userMsgs: 0, restored: false, reported: null, reportSeq: 0, turnsAtRun: 0, legStart: 0, // #1842 finish statistics · legStart: #1909 automatic conclusion
      modKind: modCol ? MOD_AI : (modChoice().moderator === MOD_USER ? MOD_USER : MOD_AUTO),
      transcript: [], seq: 0,
      delivered: new Map(), lastSpoke: new Map(), prev: null,
      eligible: new Set(debaters), firstReplied: new Set(), modStarted: false, modFails: 0,
      phase: PHASE_OPENING, turnsUsed: 0,
      sendsUsed: 1, sendBudget: DEBATE_SEND_BUDGET, wrapNow: false, // the opening is the first counted send
      queue: [], forced: null, pendingNext: null, current: null, pauseAfter: false,
      openingGroup, topicBubble: null,
      tone: normalizeTone(state.debatePrefs.tone, state.debatePrefs.toneCustom),
      typing: new Set(), // turns still showing the typing bubble (reveal() empties it)
    };
    const d = state.debate;
    clear(timeline);
    timeline.appendChild(hiddenHolder);
    timeline.appendChild(roomHead(d));
    d.topicBubble = userBubble(topic);
    timeline.appendChild(el('div', 'cmp-debate-divider', t('debate_opening_divider')));
    timeline.appendChild(openingGroup);
    // The room opens at its top — the cast line and the topic (#1818 ⑩); userBubble's pull to the end
    // is undone (its frame runs first), and the opening's bubbles do not pull (decorateTurn).
    userFollow = false;
    readerMoved = false;
    ctx.raf(() => { lastTop = 0; timeline.scrollTop = 0; }); // lastTop first: this move up is the page's, not the reader's
    // The opening's slots are reserved in the cast's order (Codex D-risk 2): who finishes first
    // must not decide the order the others read them in.
    const slots = new Map();
    for (const id of debaters) { d.seq += 1; d.transcript.push({ seq: d.seq, speaker: id, role: ROLE_PARTICIPANT, name: nameOf(id), text: '', pending: true, opening: true }); slots.set(id, d.seq); }
    d.current = { kind: PHASE_OPENING, slots };
    // The cast as the opening names it: alias (service model · model group) — no time yet (§13).
    const roster = debaters.map((id) => { const c = colOf(id); const m = metaLine({ label: ctx.colLabel(c), tierKey: tierOf(c.provider, c.model, ctx.modelLabelOf(c.provider, c.model)) }, t); return m ? `${nameOf(id)} (${m})` : nameOf(id); });
    const stanceLines = [...stances.entries()].filter(([, k]) => k).map(([id, k]) => `- ${nameOf(id)} (${ctx.colLabel(colOf(id))}): ${stanceText(t, k)}`);
    const opening = { t, names: roster, moderatorName: modCol ? nameOf(modCol) : null, stanceLines, topic, tone: d.tone, length: d.length };
    const text = openingPrompt(opening);
    // Each debater's own copy names it and its position (#1815); `text` stays the generic one.
    const texts = Object.fromEntries(debaters.map((id) => [id, openingPrompt({ ...opening, self: { name: nameOf(id), stanceKey: stances.get(id) } })]));
    ctx.root.classList.add(DEBATE_CLASS);
    timeline.hidden = false;
    // Which model moderates (plan §18.8 ⑥): its service, model id (`auto` = the service's Auto), model
    // group, and whether it is the plan-picked default the page offered (the user never chose).
    const modC = modCol ? colOf(modCol) : null;
    const modMeta = modC ? { mod_provider: modC.provider, mod_model: modC.model || 'auto', mod_tier: tierSlug(tierOf(modC.provider, modC.model, ctx.modelLabelOf(modC.provider, modC.model))) } : {};
    track('debate_start', { n: debaters.length, moderator: d.modKind, stance: d.stance, tone: d.tone.kind, pace: d.pace, custom_names: debaters.filter((id) => names.get(id).custom).length, ...modMeta, mod_default: !changedNow().includes(SETTING_MODERATOR) });
    state.question = topic;
    ctx.beginSend(text, debaters, 'SEND', [], TURN_KIND_DEBATE, null, null, false, SEND_VIA_DEBATE, texts);
    stampRound(d.transcript);
    renderBar();
    return true;
  }

  /** A round was REFUSED (CONSUME_FAIL — nothing was sent): drop what it reserved; the opening's refusal ends the debate before it began. */
  function onRoundRefused() {
    const d = state.debate;
    if (!d || !d.current) return;
    clearSlow(); // the round's turns are rolled back
    if (d.current.kind === PHASE_OPENING) {
      state.debate = null;
      ctx.root.classList.remove(DEBATE_CLASS);
      timeline.hidden = true;
      clear(timeline);
      renderSetup();
      renderBar();
      return;
    }
    d.transcript = d.transcript.filter((e) => e.seq !== d.current.seq);
    if (d.current.kind === PHASE_SPEAKING && !d.current.conclude) d.turnsUsed = Math.max(0, d.turnsUsed - 1); // a conclusion is no debate turn
    d.sendsUsed = Math.max(1, d.sendsUsed - 1); // a refused round was never counted
    if (d.current.wrapUp || d.current.conclude) d.wrapNow = true; // 「결론 내기」 was refused: ▶ 계속 asks for the conclusion again
    else if (d.current.kind === PHASE_SPEAKING && d.current.col) d.pendingNext = d.current.col; // the same speaker is still owed the floor
    d.current = null;
    d.phase = PHASE_PAUSED;
    renderBar();
  }

  /**
   * A round settled (ALL_DONE → finishSend): record what it produced, then take the next step.
   * The history entry is written again between the two (finishSend's own write came before the
   * record): a reload must find the cursors this round moved.
   */
  function onRoundSettled() {
    const d = state.debate;
    if (!d || !d.current) return;
    const go = recordRound();
    ctx.persistSession();
    if (go) advance();
  }
  /** What the settled round produced, into the transcript and the cursors; true = the loop takes the next step. */
  function recordRound() {
    const d = state.debate;
    const cur = d.current;
    d.current = null;
    for (const turn of [...d.typing]) reveal(turn); // nothing of a settled round may stay a typing bubble
    if (cur.kind === PHASE_OPENING) {
      for (const [id, seq] of cur.slots) {
        const col = colOf(id);
        const turn = col && ctx.lastAssistantTurn(col);
        const entry = d.transcript.find((e) => e.seq === seq);
        const ok = !!(col && col.status === 'done' && turn && turn.text.trim());
        entry.text = ok ? turn.text : '';
        entry.pending = false;
        if (col) { const info = turnMeta(col, turn, ok, false); keepMeta(entry, info); if (turn) turn.debateInfo = info; if (ok) showMeta(turn, info); }
        if (ok) { d.lastSpoke.set(id, seq); d.delivered.set(id, 0); } // it has read nobody yet
        else dropIfDead(id, col);
      }
      if (d.phase === PHASE_OPENING) d.phase = PHASE_SPEAKING;
    } else {
      const col = colOf(cur.col);
      const turn = col && ctx.lastAssistantTurn(col);
      const entry = d.transcript.find((e) => e.seq === cur.seq);
      const answered = !!(col && col.status === 'done' && turn && turn.text.trim());
      if (cur.kind === PHASE_MODERATING) {
        const { body, control } = splitControl(answered ? turn.text : '');
        if (entry) { entry.text = body; entry.pending = false; if (col) entry.meta = turnMeta(col, turn, answered, true).meta; }
        if (entry && turn) turn.debateInfo = { meta: entry.meta }; // 「전체 복사」 (no name-line meta for a moderator)
        if (answered && body.trim()) {
          d.delivered.set(cur.col, cur.covered);
          d.modStarted = true;
          d.modFails = 0;
          // 🔴 Words the user sent while the moderator was answering outrank its END (Codex 1R
          // blocker): ending here would strand them in the queue, never delivered.
          const pick = chooseAfterModerator({ control, candidates: candidates(), order: d.debaters, eligible: d.eligible, prev: d.prev, lastSpoke: d.lastSpoke, numbered: cur.numbered, canEnd: cur.wrapUp ? moderatorMayEnd({ turnsUsed: Infinity, minTurns: 0, queued: d.queue.length }) : mayEnd(d, cur.seq), canAsk: mayAsk(d, cur) });
          if (pick.ask) {
            d.asks += 1;
            if (entry) entry.ask = true; // the record keeps it (snapshot → `ask`): a reload redraws the question and its count
            markAsked(turn);
            track('debate_ask', { turns: d.turnsUsed, asks: d.asks });
            // 🔴 「중지」 landed after this answer was complete (late Stop, 2026-10-01 — the SW then sends it as a
            // DONE): the question is recorded and shown, but the user's stop stands — no 「asked」 phase, no pull to the box.
            if (d.phase === PHASE_PAUSED) { renderBar(); return false; }
            d.phase = PHASE_ASKED;
            renderBar();
            // #1852: the answer box says what it is for (updateControls → placeholder) and the cursor
            // waits in the box. The question comes into view like any new words — a reader scrolled up
            // stays put and the 「↓」 pill lights (2026-09-28 user: no pull while reading).
            follow();
            ctx.updateControls();
            // Never taken from a field the user is typing in (1R #1): the cursor moves only from nowhere.
            const box = ctx.doc && ctx.doc.getElementById('cmp-followup-input');
            const active = ctx.doc && ctx.doc.activeElement;
            const typing = !!active && active !== box && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
            if (box && ctx.focusQuietly && !typing) ctx.focusQuietly(box);
            return false;
          }
          // The wrap-up call MUST conclude: its answer is the conclusion even without the END line (Codex U2 1R #3 —
          // a wrap-up that came back as a NEXT slipped back into turns). Queued user words still come first.
          if (pick.end || (cur.wrapUp && !d.queue.length)) { if (entry) entry.conclusion = true; tightenConclusionTurn(turn, entry); markConclusion(turn); offerFeedback(turn, 'moderator'); d.phase = PHASE_DONE; d.legStart = d.turnsUsed; renderBar(); track('debate_end', { turns: d.turnsUsed, by: 'moderator' }); reportFinish('moderator'); return false; }
          d.pendingNext = pick.id;
          // 「NEXT: n LONG」: that speaker may answer at length this once (#1862).
          d.longFor = pick.long && pick.id ? pick.id : null;
          if (pick.fallback && turn && turn.debateHead) turn.debateHead.appendChild(el('span', 'cmp-debate-badge is-auto', t('debate_auto_pick')));
        } else {
          d.modFails += 1;
          // A wrap-up that failed is asked for again — by the moderator, or a debater once it falls back (Codex U2 1R #3).
          if (cur.wrapUp) d.wrapNow = true;
          // A skipped call (no words in time) is a failed one, not the user's Stop: the loop goes on.
          if (col && col.status === 'error' && col.errorCode === CODE_ABORTED && !cur.skipped) { d.phase = PHASE_PAUSED; renderBar(); return false; }
          if (d.modFails >= 2) { d.modKind = MOD_AUTO; ctx.showNotice('warn', [t('debate_mod_fallback')]); track('debate_mod_fallback', {}); }
        }
      } else {
        if (entry) { entry.text = answered ? turn.text : ''; entry.pending = false; }
        if (entry && col) { const info = turnMeta(col, turn, answered, false); keepMeta(entry, info); if (turn) turn.debateInfo = info; if (answered) showMeta(turn, info); }
        if (answered) {
          d.delivered.set(cur.col, cur.covered);
          d.lastSpoke.set(cur.col, cur.seq);
          d.prev = cur.col;
          d.firstReplied.add(cur.col);
          // A debater's conclusion (#1909 — no AI moderator) closes the run like a moderator's END; the next
          // leg (the user speaks again) gets its own automatic-order turn count.
          if (cur.conclude) {
            if (entry) entry.conclusion = true;
            tightenConclusionTurn(turn, entry);
            markConclusion(turn);
            offerFeedback(turn, 'debater');
            d.legStart = d.turnsUsed;
            track('debate_end', { turns: d.turnsUsed, by: 'concluder' });
            // Words the user sent while the conclusion was being written are answered, not stranded (Codex U2
            // 1R #1): the debate goes on into a new leg, like the user speaking after the end.
            if (d.queue.length) {
              // …unless ⏸ 멈춤 was pressed meanwhile: it stops here, the words wait for ▶ 계속 (Codex U2 2R #1).
              // 「중지」 too: a Stop that lands after the conclusion was complete comes back answered (#1954 late
              // stop) with the debate already PAUSED — the queued words must not go out on their own (1.49.1 batch).
              if (d.pauseAfter || d.phase === PHASE_PAUSED) { d.pauseAfter = false; d.phase = PHASE_PAUSED; renderBar(); return false; }
              return true;
            }
            d.phase = PHASE_DONE;
            renderBar();
            reportFinish('moderator');
            return false;
          }
        } else if (cur.conclude) {
          // A conclusion that failed is asked for again on ▶ 계속 — the debate does not slip back into turns.
          if (col && col.status !== 'error') dropIfDead(cur.col, col);
          d.wrapNow = true;
          d.phase = PHASE_PAUSED;
          renderBar();
          return false;
        } else {
          if (col && col.status === 'error' && col.errorCode === CODE_ABORTED && !cur.skipped) { d.phase = PHASE_PAUSED; renderBar(); return false; }
          dropIfDead(cur.col, col);
          d.prev = cur.col; // a failed speaker is not asked again straight away
        }
      }
    }
    // ⏸ 멈춤 pressed while this round was in flight (#1816): its answer is kept above, the loop stops here.
    if (d.pauseAfter) { d.pauseAfter = false; d.phase = PHASE_PAUSED; }
    if (d.phase === PHASE_PAUSED) { renderBar(); return false; }
    return true;
  }
  /**
   * What the others are told about a speaker's turn (plan §13 / §13.1 ②③), fixed at settle time:
   * the model label (a model the SITE reported serving wins over the column's own label), the model
   * group hint — from the requested model, or for Auto only from a reported one — and, for a turn
   * that finished cleanly, how long it took. The moderator's header carries its model only.
   */
  function turnMeta(col, turn, answered, isMod) {
    const served = col.servedModel && col.servedModel.source !== MODEL_SOURCE_REQUESTED && (col.servedModel.id || col.servedModel.label) ? col.servedModel : null;
    const words = servedWords(col, served);
    const label = metaLabel(col, words);
    showServed(turn, col, words);
    if (isMod) return { meta: metaLine({ label }, t), tierKey: null, secs: null };
    const tierKey = tierOf(col.provider, col.model, ctx.modelLabelOf(col.provider, col.model), served);
    const clean = answered && turn && !turn.stalled && !turn.errorText && col.status === 'done';
    const st = col.stages || {};
    const secs = clean ? secondsBetween(st[STAGE_SEND_START], st[STAGE_STREAM_DONE], TTFT_MAX_MS) : null;
    return { meta: metaLine({ label, tierKey, secs }, t), tierKey, secs };
  }
  /** The catalog's display text of a model id, '' when the catalog has no such row (modelLabelOf echoes the id then). */
  function catalogText(provider, id) {
    const text = ctx.modelLabelOf(provider, id);
    return text && text !== String(id) ? text : '';
  }
  /** A served model `{ id, label }` in words a reader knows (#1818 ⑨ — never a bare internal id), '' when none. */
  const servedWords = (col, model) => servedModelText(model, (id) => catalogText(col.provider, id));
  /** The meta line's model label: the served model when known, else the column's. */
  const metaLabel = (col, words) => (words ? `${PROVIDER_META[col.provider].label} ${words}` : ctx.colLabel(col));
  /** The name line names the served model too (#1818 ⑨ — 「Gemini」 alone under Auto), worded as colLabel words a model. */
  function showServed(turn, col, words) {
    if (turn && turn.debateSvc && words) turn.debateSvc.textContent = `${PROVIDER_META[col.provider].label} (${words})`;
  }
  /** The facts on a transcript entry — the meta line the others read, and its parts for the history. */
  function keepMeta(entry, info) {
    entry.meta = info.meta;
    entry.tierKey = info.tierKey || null;
    entry.secs = Number.isFinite(info.secs) ? info.secs : null;
  }
  /** The same facts on the speaker's name line in the timeline (the user sees what the AIs see). */
  function showMeta(turn, info) {
    if (!turn || !turn.debateHead) return;
    turn.debateInfo = info; // 「전체 복사」 repeats the name line
    if (info.tierKey) turn.debateHead.appendChild(el('span', 'cmp-debate-tier', t(info.tierKey)));
    if (Number.isFinite(info.secs)) {
      reveal(turn); // the side column exists from here
      if (turn.debateSide) turn.debateSide.insertBefore(el('span', 'cmp-debate-secs', t('debate_meta_secs', info.secs)), turn.debateSide.firstChild);
    }
  }
  /** A debater whose column cannot answer any more (a gate — sign-in, permission — or no thread) leaves the rotation. */
  function dropIfDead(id, col) {
    if (!col || col.status !== 'error') return;
    if (GATE_CODES.has(col.errorCode) || ctx.columnDead(col) || ctx.threadless(col)) state.debate.eligible.delete(id);
  }

  /** Take the next step, if the debate is running and nothing is in flight. */
  function advance() {
    const d = state.debate;
    if (!d || state.sending || d.current) { renderBar(); return; }
    // The queue first: the user's words are part of what the next speaker reads.
    while (d.queue.length) {
      const q = d.queue.shift();
      d.seq += 1;
      d.transcript.push({ seq: d.seq, speaker: SPEAKER_USER, role: ROLE_USER, name: nameOf(SPEAKER_USER), text: q.text });
      if (q.bubble) { q.bubble.classList.remove('is-queued'); const tag = q.bubble.querySelector('.cmp-debate-queued'); if (tag) tag.remove(); }
      if (q.mention) d.forced = q.mention; // the latest explicit mention wins
    }
    if (![PHASE_SPEAKING, PHASE_AWAIT].includes(d.phase) && !d.forced) { renderBar(); return; }
    if (!ctx.canFollowUp()) { d.phase = PHASE_DEAD; reportFinish('dead'); renderBar(); return; }
    // No compares left: pause instead of sending a round the server will refuse (the quota line and
    // its CTA already say why; 「계속」 after the reset — or a Premium upgrade — picks it up).
    if (ctx.quotaExhausted()) { d.phase = PHASE_PAUSED; renderBar(); return; }
    // After a lost port a column without a continuation has no client behind it any more
    // (columnDead): it leaves the rotation — and a dead moderator hands the floor to the rule.
    for (const id of [...d.eligible]) if (ctx.columnDead(colOf(id))) d.eligible.delete(id);
    if (d.modKind === MOD_AI && d.modCol && ctx.columnDead(colOf(d.modCol))) d.modKind = MOD_AUTO;
    if (d.eligible.size < 2) { d.phase = PHASE_TOO_FEW; reportFinish('too_few'); renderBar(); return; }
    // The run's safeguards (plan §15.1): the tab hidden too long → wait for the user; the send budget
    // spent → stop; one send left with an AI moderator → it closes the debate.
    if (hiddenTooLong({ hidden: docHidden(), since: hiddenSince, now: ctx.clock.now(), limit: DEBATE_HIDDEN_PAUSE_MS })) { d.phase = PHASE_HIDDEN; track('debate_hidden_pause', { sends: d.sendsUsed }); renderBar(); return; }
    // A spent budget stops and asks (renderBar: 「늘려서 계속」 / 「결론 내기」) — whoever is owed the floor
    // (pendingNext, a LONG grant, the user's pick) is kept for 「늘려서 계속」.
    // A conclusion already asked for is the one send past a spent budget (Codex U2 1R #2 — pressed during the
    // 50th send, it was stopped by the limit and its button hidden).
    // Once per spent budget (Codex U2 2R #2): a conclusion that FAILED at that extra send stops at the limit
    // and asks, instead of granting itself send after send.
    if (d.wrapNow && !d.wrapGranted && budgetStep({ used: d.sendsUsed, budget: d.sendBudget }) === 'stop') { d.sendBudget = d.sendsUsed + 1; d.wrapGranted = true; }
    if (budgetStep({ used: d.sendsUsed, budget: d.sendBudget }) === 'stop') { d.phase = PHASE_BUDGET; track('debate_budget', { sends: d.sendsUsed }); reportFinish('budget'); renderBar(); return; }
    d.phase = PHASE_SPEAKING;
    // 「자동 순서」 has nobody to END it (#1909): at the pace's turn count a debater concludes.
    if (!d.wrapNow && autoWrapDue({ pace: d.pace, modKind: d.modKind, legTurns: d.turnsUsed - d.legStart })) d.wrapNow = true;
    // 「결론 내기」 (concludeNow, or the automatic one above): the AI moderator's wrap-up call, else a debater's
    // conclusion (pickConcluder). A LONG grant belongs to the owed turn it came with — dropped whenever that turn is (2R #1).
    if (d.wrapNow) {
      d.wrapNow = false;
      // A debater the user named (a chip, @name) wins over a 「결론 내기」 still waiting (Codex 1R #2).
      if (!(d.forced && d.eligible.has(d.forced))) {
        if (d.modKind === MOD_AI && d.modCol) { d.forced = null; d.pendingNext = null; d.longFor = null; moderate(true); return; }
        const id = concluderOf(d);
        if (id) { d.forced = null; d.pendingNext = null; d.longFor = null; speak(id, true); return; }
      }
    }
    // The user's pick goes first; the debater the moderator had just asked stays owed the floor (#1817 ③).
    if (d.forced && d.eligible.has(d.forced)) { const id = d.forced; d.forced = null; d.pendingNext = owedAfterForced(d.pendingNext, id); speak(id); return; }
    d.forced = null;
    if (d.pendingNext && d.eligible.has(d.pendingNext) && d.pendingNext !== d.prev) { const id = d.pendingNext; d.pendingNext = null; speak(id); return; }
    d.pendingNext = null;
    d.longFor = null;
    if (d.modKind === MOD_USER) { d.phase = PHASE_AWAIT; renderBar(); return; }
    if (d.modKind === MOD_AI && d.modCol) { moderate(); return; }
    const id = autoNext({ order: d.debaters, eligible: d.eligible, prev: d.prev, lastSpoke: d.lastSpoke });
    if (!id) { d.phase = PHASE_TOO_FEW; reportFinish('too_few'); renderBar(); return; }
    speak(id);
  }

  /** The delta `id` has not received, fitted; `covered` = the last seq it includes. */
  function pendingFor(id) {
    const d = state.debate;
    const since = d.delivered.has(id) ? d.delivered.get(id) : 0;
    return { delta: fitDelta(deltaFor(d.transcript, id, since), DEBATE_DELTA_MAX - PROMPT_OVERHEAD), covered: lastSeq() };
  }
  function speak(id, conclude = false) {
    const d = state.debate;
    const { delta, covered } = pendingFor(id);
    // A longer turn this once (#1862): the moderator's LONG for this speaker — spent only by the turn it is
    // for (1R #2: the user's pick speaking first kept A's grant for A). A user's 「자세히」 the debater reads itself.
    const long = d.longFor === id;
    if (long) d.longFor = null;
    const text = turnPrompt({ t, selfName: nameOf(id), stanceKey: d.stances.get(id), delta, instruction: null, firstReply: !d.firstReplied.has(id), tone: d.tone, length: d.length, long, conclude });
    d.seq += 1;
    d.transcript.push({ seq: d.seq, speaker: id, role: ROLE_PARTICIPANT, name: nameOf(id), text: '', pending: true });
    d.current = { kind: PHASE_SPEAKING, col: id, seq: d.seq, covered, ...(conclude ? { conclude: true } : {}) };
    if (!conclude) d.turnsUsed += 1; // a conclusion is no debate turn (the automatic-order count)
    d.sendsUsed += 1;
    ctx.beginSend(text, [id], 'FOLLOWUP', [], TURN_KIND_DEBATE, null, null, false, SEND_VIA_DEBATE);
    stampRound([d.transcript[d.transcript.length - 1]]);
    renderBar();
  }
  /**
   * May the AI moderator END now — while endRule says on-request (「깊게」, 「충분히」 before its minimum)
   * only when the user has spoken since its last answered call (#1843). Read off the transcript, not kept as a flag (2R: a flag did not survive a history
   * restore, so a 「마무리해 줘」 stored before a reload was refused). `skip` = the call being judged.
   */
  const mayEnd = (d, skip = null) => moderatorCanEnd({ pace: d.pace, turnsUsed: d.turnsUsed, minTurns: DEBATE_MIN_TURNS_TO_END, queued: d.queue.length, userSpoke: userSpokeSince(d.transcript, skip) });
  /**
   * May this moderator reply stop the run to ask the user (#1843)? Not on the wrap-up (it must
   * conclude), not past the run's cap, and not while the user's own words wait in the queue — they
   * already answered, and asking again would strand them like an early END would.
   */
  /**
   * Are the sides free — may the moderator hand someone the other side when the openings all agree (#1817 ④)?
   * A free debate without a contrarian: for/against assigned them, and a contrarian already argues against.
   */
  const freeSides = (stance) => { const { base, roles } = splitStance(stance); return base === STANCE_NONE && !roles.includes(STANCE_DEVIL); };
  const mayAsk = (d, cur) => !(cur && cur.wrapUp) && d.asks < DEBATE_MAX_ASKS && !d.queue.length;
  function moderate(wrapUp = false) {
    const d = state.debate;
    const id = d.modCol;
    const { delta, covered } = pendingFor(id);
    const order = d.debaters.filter((x) => d.eligible.has(x));
    const names = order.map(nameOf);
    const services = order.map((x) => { const c = colOf(x); return c && PROVIDER_META[c.provider] ? PROVIDER_META[c.provider].label : ''; });
    const text = moderatorPrompt({ t, names, lastName: d.prev ? nameOf(d.prev) : null, delta, first: !d.modStarted, topic: d.topic, canEnd: mayEnd(d), tone: d.tone, wrapUp, freeStance: freeSides(d.stance), pace: d.pace, turnsUsed: d.turnsUsed, canAsk: mayAsk(d, { wrapUp }), services, length: d.length });
    d.seq += 1;
    d.transcript.push({ seq: d.seq, speaker: id, role: ROLE_MODERATOR, name: nameOf(id), text: '', pending: true });
    // The PHASE stays 「speaking」 (the debate is running); what is in flight is `current.kind` — a
    // phase of its own left the loop parked after the moderator answered (preview run, 2026-09-26).
    d.current = { kind: PHASE_MODERATING, col: id, seq: d.seq, covered, numbered: order, wrapUp }; // the numbers its cast line used
    d.sendsUsed += 1;
    ctx.beginSend(text, [id], 'FOLLOWUP', [], TURN_KIND_DEBATE, null, null, false, SEND_VIA_DEBATE);
    stampRound([d.transcript[d.transcript.length - 1]]);
    renderBar();
  }
  /** The round the send just drew its turns under, on the entries it answers — how the history finds their words again. */
  function stampRound(entries) {
    const r = state.roundInFlight;
    if (!Number.isInteger(r)) return;
    for (const e of entries) if (e && e.speaker !== SPEAKER_USER && e.pending && !Number.isInteger(e.round)) e.round = r;
  }

  /**
   * Stop the loop. The top 「중지」 (ctx.debatePause(), no argument) aborts the turn in flight — its
   * bubble ends as 「중지됐어요」. ⏸ 멈춤 (`afterTurn`, #1816) is a pause, not a cancel: a turn in
   * flight is answered in full and the loop stops before the next one; with nothing in flight it
   * stops now. The hidden-tab and send-budget stops are graceful the same way (advance() checks them
   * before a send, never during one).
   */
  function pause(afterTurn = false) {
    const d = state.debate;
    if (!d) return;
    track('debate_pause', { turns: d.turnsUsed, ...(afterTurn ? { after_turn: true } : {}) });
    if (afterTurn && d.current) { d.pauseAfter = true; renderBar(); return; }
    d.pauseAfter = false;
    d.phase = PHASE_PAUSED;
    if (!afterTurn && state.sending && state.port) { try { state.port.postMessage({ type: 'ABORT' }); } catch { /* the port is gone; the round settles on its own */ } }
    renderBar();
  }
  function resume() {
    const d = state.debate;
    if (!d) return;
    // ▶ 계속 before the turn in flight settled: the pause is called off, the loop just goes on.
    if (d.pauseAfter && d.current) { d.pauseAfter = false; track('debate_resume', { turns: d.turnsUsed }); renderBar(); return; }
    if (d.phase === PHASE_DEAD || d.phase === PHASE_TOO_FEW) { renderBar(); return; }
    reopen(d);
    track('debate_resume', { turns: d.turnsUsed });
    advance();
  }
  /**
   * 「🏁 결론 내기」 (2026-09-28 at a spent budget; #1909 at any time, in every moderation): the AI moderator's
   * conclusion, else a debater's (pickConcluder). With a turn in flight it comes right after that turn;
   * stopped, it goes now. At a spent budget it is that one send only — a conclusion that does not come
   * stops and asks again. It goes through advance(): every safeguard (quota, the hidden tab) still applies.
   */
  function concludeNow() {
    const d = state.debate;
    if (!d || !conclusionOffered(d)) return;
    d.wrapNow = true;
    // The LATER press wins (Codex U2 4R #1, 5R #1): a chip pick — or an @mention in words still queued —
    // waiting on the turn in flight is called off here, as a chip or @mention sent AFTER 「결론 내기」 calls
    // the conclusion off. The queued words themselves stay: the conclusion's writer reads them.
    d.forced = null;
    for (const q of d.queue) q.mention = null;
    track('debate_resume', { turns: d.turnsUsed, conclude: true });
    if (d.current) { d.pauseAfter = false; renderBar(); return; } // after the turn in flight (recordRound → advance)
    // Spent by the COUNT, not the phase (Codex U2 3R): after a failed conclusion at the limit the run is PAUSED,
    // and reopen() would otherwise buy a whole new budget for what is one send.
    const spent = d.sendsUsed >= d.sendBudget;
    reopen(d);
    if (spent) { d.sendBudget = d.sendsUsed + 1; d.wrapGranted = true; } // the user's own one send past the limit
    advance();
  }
  /**
   * The debater who would write a conclusion now (no AI moderator), or null. Its model group is the one its
   * turns were shown with (turnMeta — an Auto column's SERVED model, e.g. Sonnet 5.5), else the column's own.
   */
  function concluderOf(d) {
    const tierKeyOf = (id) => {
      for (let i = d.transcript.length - 1; i >= 0; i--) { const e = d.transcript[i]; if (e.speaker === id && e.tierKey) return e.tierKey; }
      return colTier(id);
    };
    return pickConcluder({ order: d.debaters, eligible: d.eligible, tierKeyOf });
  }
  /** Is there anyone to write the conclusion — a live AI moderator, or an eligible debater? */
  const canConclude = (d) => (d.modKind === MOD_AI && !!d.modCol && !ctx.columnDead(colOf(d.modCol))) || !!concluderOf(d);
  /** Is 「🏁 결론 내기」 offered right now: a debate past its opening, not finished, not already concluding. */
  function conclusionOffered(d) {
    // A conclusion waiting on the turn in flight hides it; one that failed and stopped offers it again.
    if (!d || (d.wrapNow && d.current) || [PHASE_DONE, PHASE_DEAD, PHASE_TOO_FEW, PHASE_OPENING].includes(d.phase)) return false;
    const cur = d.current;
    if (cur && (cur.kind === PHASE_OPENING || cur.wrapUp || cur.conclude)) return false;
    return canConclude(d);
  }
  /** Give the floor to `id` next (a pick chip, or `@name`): now when idle, after the current turn otherwise. */
  function pick(id) {
    const d = state.debate;
    if (!d || !d.eligible.has(id)) return;
    d.forced = id;
    d.wrapNow = false; // naming a debater calls off a 「결론 내기」 still waiting (Codex 1R #2: after a refused one)
    reopen(d);
    track('debate_pick', {});
    advance();
  }
  /** The dock's send during a debate: the user's words join the timeline now and the transcript at the next step. */
  function userMessage(text) {
    const d = state.debate;
    if (!d) return false;
    const mention = mentionOf(text, candidates());
    const busy = state.sending || !!d.current;
    const bubble = userBubble(text, busy);
    d.queue.push({ text, mention: mention && d.eligible.has(mention) ? mention : null, bubble });
    d.userMsgs += 1;
    // Speaking up resumes a paused / finished debate (the user wants an answer to what they said).
    if (d.phase !== PHASE_AWAIT) reopen(d); // 「내가 진행」 keeps waiting for a pick; any other stop starts moving again
    track('debate_user', { mention: !!mention, busy });
    // The words exist nowhere but this page until an entry holds them (Codex tabs U1 1R ②: in
    // 「내가 진행」 they wait for a pick with no round to write them) — stored now, so 새 대화 / a tab
    // switch / a closed tab cannot lose them. The record keeps undelivered words (trimRecordLog).
    // While a round streams its settle writes them (onRoundSettled) — no half-streamed turn is stored.
    if (!busy) ctx.persistSession();
    if (!busy) advance(); else renderBar();
    return true;
  }

  /** The bar above the dock: the pick chips, what is happening, and 멈춤 / 계속. */
  function renderBar() {
    const d = state.debate;
    syncJump();
    bar.hidden = !d || !state.sessionStarted && !(d && d.phase === PHASE_OPENING);
    if (!d) return;
    clear(barChips);
    // What the chips are for (#1818 ⑥): they look like a legend otherwise. Short and first in the row.
    const picksLabel = el('span', 'cmp-debate-picks-label');
    picksLabel.id = 'cmp-debate-picks-label';
    const mic = el('span', 'cmp-debate-picks-glyph', '\u{1F3A4}');
    mic.setAttribute('aria-hidden', 'true');
    picksLabel.appendChild(mic);
    picksLabel.appendChild(el('span', null, t('debate_picks_label')));
    barChips.appendChild(picksLabel);
    for (const id of d.debaters) {
      const info = d.names.get(id);
      const chip = el('button', 'cmp-debate-pick' + (d.eligible.has(id) ? '' : ' is-out'));
      chip.type = 'button';
      chip.setAttribute('data-col', id);
      chip.title = t('debate_pick_tip', info.name);
      chip.disabled = !d.eligible.has(id) || d.phase === PHASE_DEAD;
      chip.appendChild(avatar(colOf(id).provider, info, 'cmp-debate-avatar'));
      chip.appendChild(el('span', null, info.name));
      chip.addEventListener('click', () => pick(id));
      barChips.appendChild(chip);
    }
    const cur = d.current;
    let status;
    if (cur && cur.kind === PHASE_OPENING) status = t('debate_status_opening');
    else if (cur && cur.kind === PHASE_MODERATING) status = t('debate_status_moderating', nameOf(cur.col), subjectParticle(nameOf(cur.col)));
    else if (cur) status = t('debate_status_speaking', nameOf(cur.col));
    else if (d.phase === PHASE_AWAIT) status = t('debate_status_await');
    else if (d.phase === PHASE_ASKED) status = t('debate_status_asked');
    else if (d.phase === PHASE_BUDGET) status = t(canConclude(d) ? 'debate_status_budget' : 'debate_status_budget_auto', d.sendsUsed, d.sendBudget);
    else if (d.phase === PHASE_HIDDEN) status = t('debate_status_hidden');
    // Point at the Conclusion card only when one is ON SCREEN — not when the log merely says so: a
    // record finished before the card existed has no `end`, and a marked turn evicted by the history
    // bound restores without its card (integration review 1R, 2R).
    else if (d.phase === PHASE_DONE) status = t(timeline.querySelector(CONCLUSION_CARD_SEL) ? 'debate_status_done' : 'debate_status_done_plain');
    else if (d.phase === PHASE_TOO_FEW) status = t('debate_status_too_few');
    else if (d.phase === PHASE_DEAD) status = t('debate_status_dead');
    else if (d.phase === PHASE_PAUSED) status = t('debate_status_paused');
    else status = '';
    if (cur && d.pauseAfter) status = [status, t('debate_status_pausing')].filter(Boolean).join(' \u00B7 ');
    if (cur && d.wrapNow) status = [status, t('debate_status_wrap_pending')].filter(Boolean).join(' \u00B7 ');
    const running = isRunning();
    // While it runs, how much of this run's send budget is used (plan §15 — the debate goes on by itself).
    if (running && d.sendsUsed) status = [status, t('debate_status_sends', d.sendsUsed, d.sendBudget)].filter(Boolean).join(' \u00B7 ');
    barStatus.textContent = status;
    // The answer box's wording follows the phase wherever it changes (1R #2: ▶ 계속 with no compares
    // left went asked → paused without a controls pass, and 「진행자 질문에 답하기…」 stayed).
    if (typeof ctx.syncComposerPlaceholders === 'function') ctx.syncComposerPlaceholders();
    const budgetAsk = d.phase === PHASE_BUDGET && !cur;
    pauseBtn.textContent = running && !d.pauseAfter ? t('debate_pause') : t(budgetAsk ? 'debate_budget_more' : 'debate_resume');
    // 「🏁 결론 내기」 (#1909): whenever a conclusion can be asked for — not only at a spent budget.
    concludeBtn.hidden = !conclusionOffered(d);
    pauseBtn.disabled = d.phase === PHASE_DEAD || d.phase === PHASE_TOO_FEW || (d.phase === PHASE_AWAIT && !running);
    pauseBtn.hidden = d.phase === PHASE_AWAIT;
  }

  // ── history (#1769 후속): the debate's record in the session's entry, and the timeline read back ──
  /**
   * The debate's record for the history entry (debate-core readDebateRecord is its reader), or null
   * outside a debate. Words the user typed are the only text it carries — every AI's words are in
   * its column's turns already, found again by (column, round). Messages still queued are written
   * as said: a reload hands them to the next speaker.
   */
  function snapshot(clipText) {
    const d = state.debate;
    if (!d || d.restoring) return null;
    const log = [];
    for (const e of d.transcript) {
      if (e.speaker === SPEAKER_USER) { log.push({ q: e.seq, u: clipText(e.text) }); continue; }
      if (!Number.isInteger(e.round)) continue; // never went out (a refused round is removed; this is a guard)
      log.push({ q: e.seq, c: e.speaker, r: e.round, ...(e.role === ROLE_MODERATOR ? { mod: true } : {}), ...(e.ask ? { ask: true } : {}), ...(e.conclusion ? (e.role === ROLE_MODERATOR ? { end: true } : { ce: true }) : {}), ...(e.opening ? { o: true } : {}), ...(e.tierKey ? { tk: e.tierKey } : {}), ...(Number.isFinite(e.secs) ? { s: e.secs } : {}) });
    }
    let q = d.seq;
    for (const item of d.queue) log.push({ q: ++q, u: clipText(item.text) });
    const aliases = {};
    for (const [id, info] of d.names) if (info && info.custom) aliases[id] = info.name;
    return {
      // 🔎 verifier: written as vf beside a stance an older reader knows, so it keeps the entry (recordStance).
      debaters: d.debaters.slice(), modCol: d.modCol, modKind: d.modKind, ...recordStance(d.stance), ...recordPace(d.pace), length: d.length, tone: { kind: d.tone.kind, custom: d.tone.custom || '' }, aliases,
      log: trimRecordLog(log, d.delivered, DEBATE_RECORD_LOG_MAX), dl: Object.fromEntries(d.delivered), prev: d.prev, fr: [...d.firstReplied], el: [...d.eligible],
      turns: d.turnsUsed, modStarted: d.modStarted, ...(d.phase === PHASE_DONE ? { done: true } : {}), ...(d.asks ? { asks: d.asks } : {}),
    };
  }
  /**
   * A history load of a debate entry, BEFORE its turns are drawn (history.js loadSession): the
   * debate exists from here, so every restored turn is decorated as it is pushed — a moderator's
   * reply is painted without its control line, a composed prompt goes to the hidden holder. false
   * (the entry opens as columns) when a column the record names is not on the page — or when the
   * debate is not offered (`compare_debate` off): the flag is the rollback lever, and a stored debate
   * must not bring the room (nor the account photo it requests) back past it (1.38 batch review).
   */
  function restoreBegin(record) {
    if (!debateOn()) return false;
    const cast = [...record.debaters, ...(record.modCol ? [record.modCol] : [])];
    if (cast.some((id) => !colOf(id))) return false;
    // An entry from before records has no aliases of its own: today's are the best guess.
    const { names } = castNames(cast, (id) => (record.legacy ? state.aliases[id] : record.aliases[id]));
    state.debate = {
      topic: state.question, debaters: record.debaters.slice(), modCol: record.modCol, names, stances: stancesOf(record.debaters, record.stance), stance: record.stance, pace: record.pace, length: record.length, asks: 0, longFor: null,
      // A restore's 「계속」 is a new run (#1842); its turn count starts where the record left off (1R).
      run: ctx.clock.now(), userMsgs: 0, restored: true, reported: null, reportSeq: 0, turnsAtRun: record.turns, legStart: record.turns,
      modKind: record.modKind,
      transcript: [], seq: 0,
      delivered: new Map(), lastSpoke: new Map(), prev: record.prev,
      eligible: new Set(record.el), firstReplied: new Set(record.fr), modStarted: record.modStarted, modFails: 0,
      phase: PHASE_PAUSED, turnsUsed: record.turns,
      // A reloaded debate is stopped; 「계속」 starts a fresh run of the budget (like a spent one).
      sendsUsed: 0, sendBudget: DEBATE_SEND_BUDGET, wrapNow: false,
      queue: [], forced: null, pendingNext: null, current: null,
      openingGroup: el('div', 'cmp-debate-opening'), topicBubble: null,
      tone: record.tone,
      typing: new Set(),
      restoring: record, // until restoreFinish: no clock on the restored bubbles, no snapshot
    };
    ctx.root.classList.add(DEBATE_CLASS);
    clear(timeline);
    timeline.appendChild(hiddenHolder);
    return true;
  }
  /** The turns are drawn: lay the timeline out in the record's order and rebuild the transcript + cursors. */
  function restoreFinish() {
    const d = state.debate;
    if (!d || !d.restoring) return;
    const record = d.restoring;
    const turnAt = (id, round) => {
      const col = colOf(id);
      if (!col) return null;
      for (let i = col.turns.length - 1; i >= 0; i--) { const x = col.turns[i]; if (x.role === 'assistant' && x.round === round) return x; } // a retried round: its last answer
      return null;
    };
    const { transcript, lastSpoke } = transcriptFromRecord(record, (id, round) => {
      const turn = turnAt(id, round);
      return turn ? (turn.errorText ? '' : turn.text) : null; // an errored turn was never delivered (live: status done only)
    });
    for (const e of transcript) {
      e.name = nameOf(e.speaker);
      if (e.speaker !== SPEAKER_USER) { const c = colOf(e.speaker); e.meta = metaLine(e.role === ROLE_MODERATOR ? { label: ctx.colLabel(c) } : { label: ctx.colLabel(c), tierKey: e.tierKey || null, secs: e.secs }, t); }
    }
    d.transcript = transcript;
    d.seq = transcript.length ? transcript[transcript.length - 1].seq : 0;
    d.lastSpoke = lastSpoke;
    d.delivered = new Map(Object.entries(record.dl));
    // DEBATE_MAX_ASKS holds across a reload: the stored count, or the log's when it says more (a log cut by its bound undercounts).
    d.asks = Math.max(record.asks || 0, transcript.filter((e) => e.ask).length);
    // The DOM, in the record's order (the turns were drawn column by column).
    clear(timeline);
    timeline.appendChild(hiddenHolder);
    timeline.appendChild(roomHead(d));
    d.topicBubble = userBubble(d.topic, false, '');
    if (transcript.some((e) => e.opening)) {
      timeline.appendChild(el('div', 'cmp-debate-divider', t('debate_opening_divider')));
      timeline.appendChild(d.openingGroup);
    }
    const placed = new Set();
    for (const e of transcript) {
      if (e.speaker === SPEAKER_USER) { userBubble(e.text, false, ''); continue; }
      const turn = turnAt(e.speaker, e.round);
      if (!turn || placed.has(turn)) continue; // evicted by the history bound
      placed.add(turn);
      (e.opening ? d.openingGroup : timeline).appendChild(turn.root);
      if (e.conclusion) markConclusion(turn);
      if (e.ask) markAsked(turn);
      turn.debateInfo = { meta: e.meta }; // 「전체 복사」
      if (e.role !== ROLE_MODERATOR && e.text.trim()) showMeta(turn, { meta: e.meta, tierKey: e.tierKey || null, secs: e.secs });
    }
    // A debate turn the record does not name (an entry written mid-round, a stray column of an old
    // entry): after the rest, in round order — never silently dropped from view.
    const rest = [];
    for (const col of ctx.allColumns()) {
      if (col.closed || !col.participated) continue;
      for (const turn of col.turns) if (turn.role === 'assistant' && turn.kind === TURN_KIND_DEBATE && !placed.has(turn)) rest.push(turn);
    }
    rest.sort((a, b) => (a.round || 0) - (b.round || 0));
    for (const turn of rest) timeline.appendChild(turn.root);
    for (const turn of [...d.typing]) reveal(turn);
    d.restoring = null;
    d.phase = record.done ? PHASE_DONE : PHASE_PAUSED;
    timeline.hidden = false;
    renderBar();
    follow(true);
    track('debate_restore', { turns: d.turnsUsed, legacy: !!record.legacy });
  }

  /**
   * 「전체 복사」 in a debate session (debate-core debateMarkdown), or '' outside one: the timeline as
   * it SHOWS, walked in its order — an opening answer already revealed while another still types, the
   * words a stopped / failed turn got out, a restored turn the record does not name, a queued message.
   * A turn still typing shows nothing, so it exports nothing.
   */
  function markdown() {
    const d = state.debate;
    if (!d) return '';
    const byRoot = new Map();
    for (const col of ctx.allColumns()) for (const turn of col.turns) if (turn.role === 'assistant' && turn.root) byRoot.set(turn.root, { col, turn });
    const entries = [];
    const add = (node, opening) => {
      if (node === d.topicBubble) return; // the heading
      if (userText.has(node)) { entries.push({ role: ROLE_USER, name: nameOf(SPEAKER_USER), text: userText.get(node) }); return; }
      const hit = byRoot.get(node);
      if (!hit || d.typing.has(hit.turn)) return;
      const { col, turn } = hit;
      const info = turn.debateInfo || {};
      entries.push({
        role: turn.debateRole || ROLE_PARTICIPANT, name: nameOf(col.id), opening,
        // The meta the others were told (turnMeta: a served model wins over the column's label); a
        // turn that never settled into one gets the column's label + what its name line shows.
        meta: info.meta || metaLine(turn.debateRole === ROLE_MODERATOR ? { label: ctx.colLabel(col) } : { label: ctx.colLabel(col), tierKey: info.tierKey || null, secs: info.secs }, t),
        ...(turn.debateConclusion ? { conclusion: true } : {}),
        text: displayText(turn), note: turn.errorText || (turn.stalled ? ctx.cutNote(turn) : ''),
      });
    };
    for (const node of timeline.children) {
      if (node === d.openingGroup) { for (const child of node.children) add(child, true); } else add(node, false);
    }
    return debateMarkdown({ topic: d.topic, entries }, t);
  }

  /**
   * #1842: one debate RUN's finish statistics — `cmp_debate_finish` to GA and, through the SW, one
   * compare_debates row (upserted per session + run, so a later end of the same run replaces it).
   * Settings, how it ended and how long it took; never the topic or anyone's words. `left` (새 대화,
   * another session, the page closing) is reported only for a run that moved since its last report
   * — a debate that already concluded and was then left keeps its real ending.
   */
  function reportFinish(outcome) {
    const d = state.debate;
    if (!d || d.restoring || !state.sessionId || !Number.isFinite(d.run)) return;
    const moved = `${d.turnsUsed}:${d.sendsUsed}:${d.userMsgs}`;
    if (outcome === 'left' && (!d.sendsUsed || (d.reported && d.reported.moved === moved))) return;
    if (d.reported && d.reported.outcome === outcome && d.reported.moved === moved) return;
    d.reported = { outcome, moved };
    d.reportSeq += 1;
    const modC = d.modKind === MOD_AI && d.modCol ? colOf(d.modCol) : null;
    track('debate_finish', {
      outcome, pace: d.pace, length: d.length, moderator: d.modKind, stance: d.stance, tone: d.tone.kind, n: d.debaters.length,
      turns: Math.max(0, d.turnsUsed - d.turnsAtRun), sends: d.sendsUsed, user_msgs: d.userMsgs, asks: d.asks,
      elapsed_s: Math.max(0, Math.round((ctx.clock.now() - d.run) / 1000)), restored: !!d.restored,
      ...(modC ? { mod_provider: modC.provider, mod_tier: tierSlug(tierOf(modC.provider, modC.model, ctx.modelLabelOf(modC.provider, modC.model))) } : {}),
      session_id: state.sessionId, run: d.run, seq: d.reportSeq,
    });
  }
  /** 새 대화 / a history load: the debate (if any) is over; the page is the columns again. */
  function reset() {
    reportFinish('left');
    clearSlow();
    for (const o of foldObservers) o.disconnect();
    foldObservers.clear();
    state.debate = null;
    ctx.root.classList.remove(DEBATE_CLASS);
    timeline.hidden = true;
    clear(timeline);
    editing = null;
    aliasError = null;
    setupSig = '';
    renderBar();
    renderSetup();
  }

  Object.assign(ctx, {
    debateReveal: reveal, debateFirstText: firstText,
    debateOn, debateActive, debateAsked, debateChosen, debateNameOf, debateEmojiOf, readDebatePrefs: readPrefs, renderDebateSetup: renderSetup, debateStartProblem: startProblem,
    debateStart: start, debateRoundRefused: onRoundRefused, debateRoundSettled: onRoundSettled, debateUserMessage: userMessage,
    debatePause: pause, debateResume: resume, debatePick: pick, renderDebateBar: renderBar, debateReset: reset,
    debateSnapshot: snapshot, debateMarkdown: markdown, debateRestoreBegin: restoreBegin, debateRestoreFinish: restoreFinish,
    turnHost, decorateDebateTurn: decorateTurn, debateDisplayText: displayText, debateFollow: follow,
    debateModeTabs: tabs, debateModeConfirm: confirmBox, debateMode: currentMode, renderModeTabs: renderTabs, debateFollowEntry: followEntry, debateRequestMode: requestMode,
    debateSetup: setup, debateTimeline: timeline, debateBar: bar, debateGear: gearBtn,
    debateModCol: () => (state.debate ? state.debate.modCol : null),
    saveDebatePrefs: savePrefs,
  });
}
