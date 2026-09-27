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
//   wins; Stop aborts the stream and pauses, the queue survives.

import { TURN_KIND_DEBATE, SEND_VIA_DEBATE, DEBATE_SEND_BUDGET, DEBATE_HIDDEN_PAUSE_MS, DEBATE_MIN_TURNS_TO_END, DEBATE_PREFS_KEY, DEBATE_ALIASES_KEY, DEBATE_FOLLOW_PX, GATE_CODES, CODE_ABORTED, STAGE_SEND_START, STAGE_STREAM_DONE, TTFT_MAX_MS, MODEL_SOURCE_REQUESTED, PROVIDER_META, SVG_NS } from './constants.js';
import { BRAND_MARK_VIEWBOX, BRAND_MARK_PATHS, BRAND_WORDMARK } from './brand-marks.js';
import {
  MOD_AI, MOD_AUTO, MOD_USER, MODERATOR_KINDS, STANCES, STANCE_NONE, TONES, TONE_FRIENDS, TONE_CUSTOM, DEBATE_TONE_MAX, cleanTone, toneProblem, normalizeTone, SPEAKER_USER, ROLE_USER, ROLE_PARTICIPANT, ROLE_MODERATOR,
  DEBATE_DELTA_MAX, DEBATE_TOPIC_MAX, DEBATE_ALIAS_MAX, cleanAlias, aliasProblem, resolveNames, deltaFor, fitDelta, stancesOf,
  openingPrompt, turnPrompt, moderatorPrompt, splitControl, mentionOf, autoNext, chooseAfterModerator, moderatorMayEnd, tierOf, secondsBetween, metaLine, budgetStep, hiddenTooLong,
  DEBATE_RECORD_LOG_MAX, transcriptFromRecord, trimRecordLog, debateMarkdown,
  MODE_CROSSCHECK, MODE_DEBATE, MODES, TAB_CONFIRM, TAB_LOCKED, initialMode, tabSwitchAction,
  SETTING_MODERATOR, SETTING_STANCE, SETTING_TONE, changedSettings, problemInSettings, defaultModerator, tierSlug,
} from './debate-core.js';

const PHASE_OPENING = 'opening';
const PHASE_SPEAKING = 'speaking';
const PHASE_MODERATING = 'moderating';
const PHASE_AWAIT = 'await';
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

/** Installs the debate slice onto `ctx` (see ui/compare/history.js for the ctx contract). */
export function installDebate(ctx) {
  const { chrome, state, t, el, clear, track } = ctx;
  const store = (chrome && chrome.storage && chrome.storage.local) || null;
  // `settingsOpen`: the ⚙ panel (plan §18) — closed until the user opens it once, then remembered.
  // `modChosen`: the user picked the moderator (the 「진행」 select) — until then the plan-picked seat
  // moderates by default (plan §18.8; `state.debateSeat` is set by compare.js with the debate layout).
  state.debatePrefs = { on: false, moderator: MOD_AUTO, modCol: null, modChosen: false, stance: STANCE_NONE, tone: TONE_FRIENDS, toneCustom: '', settingsOpen: false };
  if (state.debateSeat === undefined) state.debateSeat = null;
  state.aliases = {};
  state.debate = null;

  const debateOn = () => !!(state.status && state.status.debateOn === true);
  const doc_active = () => (ctx.doc && ctx.doc.activeElement) || null;
  const debateActive = () => !!state.debate;
  /** The name the page shows for a cast column in the debate on screen ('' outside one) — what a share carries (#1784). */
  const debateNameOf = (id) => (state.debate && state.debate.names.get(id) ? state.debate.names.get(id).name || '' : '');
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
              stance: STANCES.includes(p.stance) ? p.stance : STANCE_NONE,
              // No / unknown tone = friends (§12.1 ③ — nothing shipped used another default).
              tone: TONES.includes(p.tone) ? p.tone : TONE_FRIENDS,
              toneCustom: typeof p.toneCustom === 'string' ? cleanTone(p.toneCustom).slice(0, DEBATE_TONE_MAX * 2) : '',
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
    return p.modChosen ? { moderator: p.moderator, modCol: p.modCol } : defaultModerator(state.debateSeat, targets);
  }
  /** The settings that differ from this page's defaults (the ⚙ dot, the summary line). */
  const changedNow = (targets = reachable()) => changedSettings({ ...state.debatePrefs, ...modChoice(targets) }, defaultModerator(state.debateSeat, targets));
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
  /** `{ debaters, modCol, names, conflicts, problem }` for the current setup (problem = i18n key or null). */
  function planCast() {
    const targets = reachable();
    const modCol = moderatorCol(targets);
    const debaters = targets.filter((id) => id !== modCol);
    const cast = [...debaters, ...(modCol ? [modCol] : [])];
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
  const setupRow = el('div', 'cmp-debate-setup-row');
  const modLabel = el('label', 'cmp-debate-field');
  modLabel.appendChild(el('span', 'cmp-debate-field-name', t('debate_mod_label')));
  const modSelect = el('select', 'cmp-debate-select');
  modSelect.id = 'cmp-debate-moderator';
  modLabel.appendChild(modSelect);
  setupRow.appendChild(modLabel);
  const stanceLabel = el('label', 'cmp-debate-field');
  stanceLabel.appendChild(el('span', 'cmp-debate-field-name', t('debate_stance_label')));
  const stanceSelect = el('select', 'cmp-debate-select');
  stanceSelect.id = 'cmp-debate-stance';
  for (const s of STANCES) { const o = el('option', null, t(`debate_stance_opt_${s}`)); o.value = s; stanceSelect.appendChild(o); }
  stanceLabel.appendChild(stanceSelect);
  setupRow.appendChild(stanceLabel);
  // 말투 (§12): friends (default) / calm / custom — the custom line is a one-line input beside it.
  const toneLabel = el('label', 'cmp-debate-field');
  toneLabel.appendChild(el('span', 'cmp-debate-field-name', t('debate_tone_label')));
  const toneSelect = el('select', 'cmp-debate-select');
  toneSelect.id = 'cmp-debate-tone';
  for (const k of TONES) { const o = el('option', null, t(`debate_tone_opt_${k}`)); o.value = k; toneSelect.appendChild(o); }
  toneLabel.appendChild(toneSelect);
  setupRow.appendChild(toneLabel);
  const toneInput = el('input', 'cmp-debate-tone-input');
  toneInput.id = 'cmp-debate-tone-custom';
  toneInput.type = 'text';
  toneInput.maxLength = DEBATE_TONE_MAX * 2; // UTF-16 units; toneProblem counts characters and is the check
  toneInput.placeholder = t('debate_tone_placeholder');
  toneInput.setAttribute('aria-label', t('debate_tone_input_label', DEBATE_TONE_MAX));
  toneInput.hidden = true;
  setupRow.appendChild(toneInput);
  setupBody.appendChild(setupRow);
  // The cast is not listed here any more (plan §17.5): each participant's avatar and alias sit on
  // its own column head — the debate tab draws the pre-session columns as participant cards.
  // The run's safeguards, said before it starts (plan §15.1 ①).
  setupBody.appendChild(el('p', 'cmp-debate-hint', t('debate_budget_hint', DEBATE_SEND_BUDGET)));
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

  modSelect.addEventListener('change', () => {
    const v = String(modSelect.value || '');
    if (v.startsWith(`${MOD_AI}:`)) { state.debatePrefs.moderator = MOD_AI; state.debatePrefs.modCol = v.slice(MOD_AI.length + 1); }
    else { state.debatePrefs.moderator = MODERATOR_KINDS.includes(v) ? v : MOD_AUTO; }
    state.debatePrefs.modChosen = true; // from now on the user's, not the plan-picked default
    savePrefs();
    renderSetup();
    ctx.updateControls();
  });
  toneSelect.addEventListener('change', () => {
    state.debatePrefs.tone = TONES.includes(toneSelect.value) ? toneSelect.value : TONE_FRIENDS;
    savePrefs();
    track('debate_tone', { tone: state.debatePrefs.tone });
    renderSetup();
    ctx.updateControls();
    if (state.debatePrefs.tone === TONE_CUSTOM) { try { toneInput.focus(); } catch { /* focus is a nicety */ } }
  });
  toneInput.addEventListener('input', () => {
    state.debatePrefs.toneCustom = toneInput.value; // folded on use (cleanTone); the input keeps what was typed
    savePrefs();
    ctx.updateControls();
  });
  stanceSelect.addEventListener('change', () => {
    state.debatePrefs.stance = STANCES.includes(stanceSelect.value) ? stanceSelect.value : STANCE_NONE;
    savePrefs();
    renderSetup(); // the ⚙ dot and the summary line say it at once (plan §18.7 ③)
    ctx.updateControls();
  });
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
      const target = p && p.startsWith('debate_tone_err_') ? toneInput : modSelect;
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
  function castChip(id, info, isMod) {
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
    return chip;
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
    // Moderator options: the two rules, then one 「AI 진행」 per reachable column (only with ≥ 3 — two
    // debaters plus the moderator; with fewer the choice is not offered at all).
    const opts = [[MOD_AUTO, t('debate_mod_auto')], [MOD_USER, t('debate_mod_user')]];
    if (targets.length >= 3) for (const id of targets) opts.push([`${MOD_AI}:${id}`, t('debate_mod_ai', ctx.colLabel(colOf(id)))]);
    const want = mod.moderator === MOD_AI ? `${MOD_AI}:${mod.modCol}` : mod.moderator;
    // An AI moderator chosen but not on the page (its column closed, or fewer than 3 AIs): the
    // select SAYS so rather than showing 「자동 순서」 over a stored AI choice that blocks the start
    // (plan §18.7 ①). `ai:` = no moderator picked; choosing another option is the way out.
    if (mod.moderator === MOD_AI && !opts.some(([v]) => v === want)) {
      opts.push([`${MOD_AI}:`, t(targets.length >= 3 ? 'debate_mod_ai_pick' : 'debate_mod_ai_need3')]);
    }
    clear(modSelect);
    for (const [v, label] of opts) { const o = el('option', null, label); o.value = v; modSelect.appendChild(o); }
    modSelect.value = opts.some(([v]) => v === want) ? want : mod.moderator === MOD_AI ? `${MOD_AI}:` : MOD_AUTO;
    modSelect.disabled = state.sending;
    stanceSelect.value = state.debatePrefs.stance;
    stanceSelect.disabled = state.sending;
    toneSelect.value = state.debatePrefs.tone;
    toneSelect.disabled = state.sending;
    toneInput.hidden = state.debatePrefs.tone !== TONE_CUSTOM;
    toneInput.disabled = state.sending;
    if (toneInput.value !== state.debatePrefs.toneCustom && doc_active() !== toneInput) toneInput.value = state.debatePrefs.toneCustom;
    clearSlots();
    for (const id of plan.debaters) fillSlot(id, castChip(id, plan.names.get(id), false), false);
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
  const pauseBtn = el('button', 'cmp-btn cmp-btn-sm cmp-debate-pause', t('debate_pause'));
  pauseBtn.id = 'cmp-debate-pause';
  pauseBtn.type = 'button';
  bar.appendChild(barChips);
  bar.appendChild(barStatus);
  bar.appendChild(pauseBtn);
  pauseBtn.addEventListener('click', () => { if (!state.debate) return; if (isRunning()) pause(); else resume(); });

  let userFollow = true; // the reader is at (or near) the end of the timeline
  timeline.addEventListener('scroll', () => {
    const { scrollTop, clientHeight, scrollHeight } = timeline;
    if ([scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) userFollow = scrollHeight - (scrollTop + clientHeight) <= DEBATE_FOLLOW_PX;
  });
  /** Keep the newest words in view while the reader is at the end (`force`: a new turn started). */
  function follow(force = false) {
    if (!force && !userFollow) return;
    if (force) userFollow = true;
    ctx.raf(() => { timeline.scrollTop = timeline.scrollHeight; });
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
    const ava = avatar(col.provider, info, 'cmp-debate-ava', true);
    const head = el('div', 'cmp-debate-meta');
    head.appendChild(el('span', 'cmp-debate-name', info.name));
    head.appendChild(el('span', 'cmp-debate-svc', ctx.colLabel(col)));
    if (isMod) head.appendChild(el('span', 'cmp-debate-badge is-moderator', t('debate_role_moderator')));
    const stance = d.stances.get(col.id);
    if (stance) head.appendChild(el('span', 'cmp-debate-badge', t(stance)));
    turn.debateHead = head;
    turn.root.classList.add('cmp-debate-msg', 'is-typing');
    // 「입력이 끝나면 한 번에」 (plan §14 / §14.1 ①②): while the answer streams the row shows a typing
    // bubble — the words are painted as always but hidden, from the accessibility tree too (the
    // timeline is aria-live) — and reveal() shows them all at once when the turn settles.
    turn.node.setAttribute('aria-hidden', 'true');
    d.typing.add(turn);
    if (isMod) turn.root.classList.add('is-moderator');
    turn.root.insertBefore(head, turn.root.firstChild);
    turn.root.insertBefore(ava, head);
    // A new speaker brings the reader along — once, when it starts; during the opening only its first
    // bubble does (the others fill in at the same time, and yanking the view for each would fight a
    // reader who scrolled up to read — plan §11.4 ⑤).
    const openingLater = d.phase === PHASE_OPENING && d.openingGroup && d.openingGroup.querySelectorAll('.cmp-debate-msg').length > 1;
    follow(!openingLater);
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
    turn.root.classList.remove('is-typing');
    turn.root.classList.add('is-revealed');
    turn.node.removeAttribute('aria-hidden');
    if (!turn.debateSide) {
      const side = el('div', 'cmp-debate-side');
      // A turn read back from the history has no clock time (it was never stored) — not 「now」.
      if (!(d && d.restoring)) side.appendChild(el('span', 'cmp-debate-clock', clockNow()));
      turn.root.appendChild(side);
      turn.debateSide = side;
    }
    if (d) d.typing.delete(turn);
    follow();
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
    head.appendChild(el('span', 'cmp-debate-room-line', t('debate_room_line', mod, t(`debate_stance_opt_${d.stance}`))));
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
  const STOPPED = [PHASE_PAUSED, PHASE_BUDGET, PHASE_HIDDEN, PHASE_DONE, PHASE_TOO_FEW, PHASE_DEAD, PHASE_AWAIT];
  const isRunning = () => !!state.debate && !STOPPED.includes(state.debate.phase);
  // When the tab went hidden (null while visible) — advance() pauses before the next send once it
  // has been hidden for DEBATE_HIDDEN_PAUSE_MS (§15.1 ②).
  let hiddenSince = null;
  const docHidden = () => !!(ctx.doc && ctx.doc.hidden);
  if (ctx.doc && typeof ctx.doc.addEventListener === 'function') {
    ctx.doc.addEventListener('visibilitychange', () => { hiddenSince = docHidden() ? ctx.clock.now() : null; });
  }
  /**
   * A stopped debate starts moving again (▶ 계속, a pick chip, the user speaking): a spent budget
   * gets another DEBATE_SEND_BUDGET, the hidden-tab clock restarts. Dead / too-few stay stopped.
   */
  function reopen(d) {
    if (!STOPPED.includes(d.phase) || d.phase === PHASE_DEAD || d.phase === PHASE_TOO_FEW) return;
    if (d.sendsUsed >= d.sendBudget) { d.sendBudget = d.sendsUsed + DEBATE_SEND_BUDGET; d.wrapUpDone = false; }
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
    const stances = stancesOf(debaters, state.debatePrefs.stance);
    const openingGroup = el('div', 'cmp-debate-opening');
    state.debate = {
      topic, debaters, modCol, names, stances, stance: state.debatePrefs.stance,
      modKind: modCol ? MOD_AI : (modChoice().moderator === MOD_USER ? MOD_USER : MOD_AUTO),
      transcript: [], seq: 0,
      delivered: new Map(), lastSpoke: new Map(), prev: null,
      eligible: new Set(debaters), firstReplied: new Set(), modStarted: false, modFails: 0,
      phase: PHASE_OPENING, turnsUsed: 0,
      sendsUsed: 1, sendBudget: DEBATE_SEND_BUDGET, wrapUpDone: false, // the opening is the first counted send
      queue: [], forced: null, pendingNext: null, current: null,
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
    // The opening's slots are reserved in the cast's order (Codex D-risk 2): who finishes first
    // must not decide the order the others read them in.
    const slots = new Map();
    for (const id of debaters) { d.seq += 1; d.transcript.push({ seq: d.seq, speaker: id, role: ROLE_PARTICIPANT, name: nameOf(id), text: '', pending: true, opening: true }); slots.set(id, d.seq); }
    d.current = { kind: PHASE_OPENING, slots };
    // The cast as the opening names it: alias (service model · model group) — no time yet (§13).
    const roster = debaters.map((id) => { const c = colOf(id); const m = metaLine({ label: ctx.colLabel(c), tierKey: tierOf(c.provider, c.model, ctx.modelLabelOf(c.provider, c.model)) }, t); return m ? `${nameOf(id)} (${m})` : nameOf(id); });
    const stanceLines = [...stances.entries()].filter(([, k]) => k).map(([id, k]) => `- ${nameOf(id)} (${ctx.colLabel(colOf(id))}): ${t(k)}`);
    const text = openingPrompt({ t, names: roster, moderatorName: modCol ? nameOf(modCol) : null, stanceLines, topic, tone: d.tone });
    ctx.root.classList.add(DEBATE_CLASS);
    timeline.hidden = false;
    // Which model moderates (plan §18.8 ⑥): its service, model id (`auto` = the service's Auto), model
    // group, and whether it is the plan-picked default the page offered (the user never chose).
    const modC = modCol ? colOf(modCol) : null;
    const modMeta = modC ? { mod_provider: modC.provider, mod_model: modC.model || 'auto', mod_tier: tierSlug(tierOf(modC.provider, modC.model, ctx.modelLabelOf(modC.provider, modC.model))) } : {};
    track('debate_start', { n: debaters.length, moderator: d.modKind, stance: state.debatePrefs.stance, tone: d.tone.kind, custom_names: debaters.filter((id) => names.get(id).custom).length, ...modMeta, mod_default: !changedNow().includes(SETTING_MODERATOR) });
    state.question = topic;
    ctx.beginSend(text, debaters, 'SEND', [], TURN_KIND_DEBATE, null, null, false, SEND_VIA_DEBATE);
    stampRound(d.transcript);
    renderBar();
    return true;
  }

  /** A round was REFUSED (CONSUME_FAIL — nothing was sent): drop what it reserved; the opening's refusal ends the debate before it began. */
  function onRoundRefused() {
    const d = state.debate;
    if (!d || !d.current) return;
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
    if (d.current.kind === PHASE_SPEAKING) d.turnsUsed = Math.max(0, d.turnsUsed - 1);
    d.sendsUsed = Math.max(1, d.sendsUsed - 1); // a refused round was never counted
    if (d.current.wrapUp) d.wrapUpDone = false;
    if (d.current.kind === PHASE_SPEAKING && d.current.col) d.pendingNext = d.current.col; // the same speaker is still owed the floor
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
          const pick = chooseAfterModerator({ control, candidates: candidates(), order: d.debaters, eligible: d.eligible, prev: d.prev, lastSpoke: d.lastSpoke, numbered: cur.numbered, canEnd: moderatorMayEnd({ turnsUsed: cur.wrapUp ? Infinity : d.turnsUsed, minTurns: DEBATE_MIN_TURNS_TO_END, queued: d.queue.length }) });
          if (pick.end) { d.phase = PHASE_DONE; renderBar(); track('debate_end', { turns: d.turnsUsed, by: 'moderator' }); return false; }
          d.pendingNext = pick.id;
          if (pick.fallback && turn && turn.debateHead) turn.debateHead.appendChild(el('span', 'cmp-debate-badge is-auto', t('debate_auto_pick')));
        } else {
          d.modFails += 1;
          if (col && col.status === 'error' && col.errorCode === CODE_ABORTED) { d.phase = PHASE_PAUSED; renderBar(); return false; }
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
        } else {
          if (col && col.status === 'error' && col.errorCode === CODE_ABORTED) { d.phase = PHASE_PAUSED; renderBar(); return false; }
          dropIfDead(cur.col, col);
          d.prev = cur.col; // a failed speaker is not asked again straight away
        }
      }
    }
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
    const label = served && served.label ? `${PROVIDER_META[col.provider].label} ${served.label}` : ctx.colLabel(col);
    if (isMod) return { meta: metaLine({ label }, t), tierKey: null, secs: null };
    const tierKey = tierOf(col.provider, col.model, ctx.modelLabelOf(col.provider, col.model), served);
    const clean = answered && turn && !turn.stalled && !turn.errorText && col.status === 'done';
    const st = col.stages || {};
    const secs = clean ? secondsBetween(st[STAGE_SEND_START], st[STAGE_STREAM_DONE], TTFT_MAX_MS) : null;
    return { meta: metaLine({ label, tierKey, secs }, t), tierKey, secs };
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
    if (!ctx.canFollowUp()) { d.phase = PHASE_DEAD; renderBar(); return; }
    // No compares left: pause instead of sending a round the server will refuse (the quota line and
    // its CTA already say why; 「계속」 after the reset — or a Premium upgrade — picks it up).
    if (ctx.quotaExhausted()) { d.phase = PHASE_PAUSED; renderBar(); return; }
    // After a lost port a column without a continuation has no client behind it any more
    // (columnDead): it leaves the rotation — and a dead moderator hands the floor to the rule.
    for (const id of [...d.eligible]) if (ctx.columnDead(colOf(id))) d.eligible.delete(id);
    if (d.modKind === MOD_AI && d.modCol && ctx.columnDead(colOf(d.modCol))) d.modKind = MOD_AUTO;
    if (d.eligible.size < 2) { d.phase = PHASE_TOO_FEW; renderBar(); return; }
    // The run's safeguards (plan §15.1): the tab hidden too long → wait for the user; the send budget
    // spent → stop; one send left with an AI moderator → it closes the debate.
    if (hiddenTooLong({ hidden: docHidden(), since: hiddenSince, now: ctx.clock.now(), limit: DEBATE_HIDDEN_PAUSE_MS })) { d.phase = PHASE_HIDDEN; track('debate_hidden_pause', { sends: d.sendsUsed }); renderBar(); return; }
    const step = budgetStep({ used: d.sendsUsed, budget: d.sendBudget, aiModerator: d.modKind === MOD_AI && !!d.modCol, wrapUpDone: d.wrapUpDone, forced: !!(d.forced && d.eligible.has(d.forced)) });
    if (step === 'stop') { d.phase = PHASE_BUDGET; track('debate_budget', { sends: d.sendsUsed }); renderBar(); return; }
    d.phase = PHASE_SPEAKING;
    if (step === 'wrapup') { d.forced = null; d.pendingNext = null; d.wrapUpDone = true; moderate(true); return; }
    if (d.forced && d.eligible.has(d.forced)) { const id = d.forced; d.forced = null; d.pendingNext = null; speak(id); return; }
    d.forced = null;
    if (d.pendingNext && d.eligible.has(d.pendingNext) && d.pendingNext !== d.prev) { const id = d.pendingNext; d.pendingNext = null; speak(id); return; }
    d.pendingNext = null;
    if (d.modKind === MOD_USER) { d.phase = PHASE_AWAIT; renderBar(); return; }
    if (d.modKind === MOD_AI && d.modCol) { moderate(); return; }
    const id = autoNext({ order: d.debaters, eligible: d.eligible, prev: d.prev, lastSpoke: d.lastSpoke });
    if (!id) { d.phase = PHASE_TOO_FEW; renderBar(); return; }
    speak(id);
  }

  /** The delta `id` has not received, fitted; `covered` = the last seq it includes. */
  function pendingFor(id) {
    const d = state.debate;
    const since = d.delivered.has(id) ? d.delivered.get(id) : 0;
    return { delta: fitDelta(deltaFor(d.transcript, id, since), DEBATE_DELTA_MAX - PROMPT_OVERHEAD), covered: lastSeq() };
  }
  function speak(id) {
    const d = state.debate;
    const { delta, covered } = pendingFor(id);
    const text = turnPrompt({ t, selfName: nameOf(id), stanceKey: d.stances.get(id), delta, instruction: null, firstReply: !d.firstReplied.has(id), tone: d.tone });
    d.seq += 1;
    d.transcript.push({ seq: d.seq, speaker: id, role: ROLE_PARTICIPANT, name: nameOf(id), text: '', pending: true });
    d.current = { kind: PHASE_SPEAKING, col: id, seq: d.seq, covered };
    d.turnsUsed += 1;
    d.sendsUsed += 1;
    ctx.beginSend(text, [id], 'FOLLOWUP', [], TURN_KIND_DEBATE, null, null, false, SEND_VIA_DEBATE);
    stampRound([d.transcript[d.transcript.length - 1]]);
    renderBar();
  }
  function moderate(wrapUp = false) {
    const d = state.debate;
    const id = d.modCol;
    const { delta, covered } = pendingFor(id);
    const order = d.debaters.filter((x) => d.eligible.has(x));
    const names = order.map(nameOf);
    const text = moderatorPrompt({ t, names, lastName: d.prev ? nameOf(d.prev) : null, delta, first: !d.modStarted, topic: d.topic, canEnd: d.turnsUsed >= DEBATE_MIN_TURNS_TO_END, tone: d.tone, wrapUp });
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

  function pause() {
    const d = state.debate;
    if (!d) return;
    d.phase = PHASE_PAUSED;
    if (state.sending && state.port) { try { state.port.postMessage({ type: 'ABORT' }); } catch { /* the port is gone; the round settles on its own */ } }
    track('debate_pause', { turns: d.turnsUsed });
    renderBar();
  }
  function resume() {
    const d = state.debate;
    if (!d) return;
    if (d.phase === PHASE_DEAD || d.phase === PHASE_TOO_FEW) { renderBar(); return; }
    reopen(d);
    track('debate_resume', { turns: d.turnsUsed });
    advance();
  }
  /** Give the floor to `id` next (a pick chip, or `@name`): now when idle, after the current turn otherwise. */
  function pick(id) {
    const d = state.debate;
    if (!d || !d.eligible.has(id)) return;
    d.forced = id;
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
    bar.hidden = !d || !state.sessionStarted && !(d && d.phase === PHASE_OPENING);
    if (!d) return;
    clear(barChips);
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
    else if (cur && cur.kind === PHASE_MODERATING) status = t('debate_status_moderating', nameOf(cur.col));
    else if (cur) status = t('debate_status_speaking', nameOf(cur.col));
    else if (d.phase === PHASE_AWAIT) status = t('debate_status_await');
    else if (d.phase === PHASE_BUDGET) status = t('debate_status_budget', d.sendsUsed, DEBATE_SEND_BUDGET);
    else if (d.phase === PHASE_HIDDEN) status = t('debate_status_hidden');
    else if (d.phase === PHASE_DONE) status = t('debate_status_done');
    else if (d.phase === PHASE_TOO_FEW) status = t('debate_status_too_few');
    else if (d.phase === PHASE_DEAD) status = t('debate_status_dead');
    else if (d.phase === PHASE_PAUSED) status = t('debate_status_paused');
    else status = '';
    const running = isRunning();
    // While it runs, how much of this run's send budget is used (plan §15 — the debate goes on by itself).
    if (running && d.sendsUsed) status = [status, t('debate_status_sends', d.sendsUsed, d.sendBudget)].filter(Boolean).join(' \u00B7 ');
    barStatus.textContent = status;
    pauseBtn.textContent = running ? t('debate_pause') : t('debate_resume');
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
      log.push({ q: e.seq, c: e.speaker, r: e.round, ...(e.role === ROLE_MODERATOR ? { mod: true } : {}), ...(e.opening ? { o: true } : {}), ...(e.tierKey ? { tk: e.tierKey } : {}), ...(Number.isFinite(e.secs) ? { s: e.secs } : {}) });
    }
    let q = d.seq;
    for (const item of d.queue) log.push({ q: ++q, u: clipText(item.text) });
    const aliases = {};
    for (const [id, info] of d.names) if (info && info.custom) aliases[id] = info.name;
    return {
      debaters: d.debaters.slice(), modCol: d.modCol, modKind: d.modKind, stance: d.stance, tone: { kind: d.tone.kind, custom: d.tone.custom || '' }, aliases,
      log: trimRecordLog(log, d.delivered, DEBATE_RECORD_LOG_MAX), dl: Object.fromEntries(d.delivered), prev: d.prev, fr: [...d.firstReplied], el: [...d.eligible],
      turns: d.turnsUsed, modStarted: d.modStarted, ...(d.phase === PHASE_DONE ? { done: true } : {}),
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
      topic: state.question, debaters: record.debaters.slice(), modCol: record.modCol, names, stances: stancesOf(record.debaters, record.stance), stance: record.stance,
      modKind: record.modKind,
      transcript: [], seq: 0,
      delivered: new Map(), lastSpoke: new Map(), prev: record.prev,
      eligible: new Set(record.el), firstReplied: new Set(record.fr), modStarted: record.modStarted, modFails: 0,
      phase: PHASE_PAUSED, turnsUsed: record.turns,
      // A reloaded debate is stopped; 「계속」 starts a fresh run of the budget (like a spent one).
      sendsUsed: 0, sendBudget: DEBATE_SEND_BUDGET, wrapUpDone: false,
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
        text: displayText(turn), note: turn.errorText || (turn.stalled ? ctx.cutNote(turn) : ''),
      });
    };
    for (const node of timeline.children) {
      if (node === d.openingGroup) { for (const child of node.children) add(child, true); } else add(node, false);
    }
    return debateMarkdown({ topic: d.topic, entries }, t);
  }

  /** 새 대화 / a history load: the debate (if any) is over; the page is the columns again. */
  function reset() {
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
    debateReveal: reveal,
    debateOn, debateActive, debateChosen, debateNameOf, readDebatePrefs: readPrefs, renderDebateSetup: renderSetup, debateStartProblem: startProblem,
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
