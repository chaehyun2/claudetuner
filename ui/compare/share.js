// ui/compare/share.js — the SHARE slice of mountComparePage() (compare.js, #1784 U3,
// docs/plans/compare-share.md §0.5): the topbar 「공유」 button, the share dialog (title · author ·
// warning · preview · create / update / copy / delete) and 「내 공유 링크」. ctx contract: see
// ui/compare/history.js.
//
// 🔴 WHAT IS SHOWN = WHAT GOES UP. The conversation is read ONCE, when the dialog opens (never while
// a round is in flight), and the request carries exactly the snapshot the preview last drew
// (`dlg.snapshot`) — never one rebuilt at the click, which could publish answers the user never saw
// (Codex U3b 1R). Drawn with the same md-render the site viewer runs, never from the page's own DOM
// (error lines, assembled prompts, images).
// The server is the truth for everything about a share (who it shows as, whether it still exists):
// the dialog settles on what the SW relays back, and the local map (SHARE_MAP_KEY) only remembers
// which conversation has which link.

import { buildShareSnapshot } from './share-snapshot.js';
import { renderAnswer } from '../md-render.js';
import {
  PROVIDER_META, COPY_FEEDBACK_MS, SHARE_MSG_TYPE, SHARE_OP_CREATE, SHARE_OP_UPDATE, SHARE_OP_DELETE, SHARE_OP_LIST,
  SHARE_AUTHOR_ANON, SHARE_AUTHOR_NAME, SHARE_AUTHOR_NAME_PHOTO, SHARE_AUTHOR_MODES, SHARE_AUTHOR_PREF_KEY, SHARE_MAP_KEY, SHARE_MAP_MAX,
  SHARE_ID_RE, SHARE_TITLE_INPUT_MAX, SHARE_NAME_INPUT_MAX, SHARE_LOCK_NAME, SHARE_LOCK_WAIT_MS, shareUrlOf,
} from './constants.js';
import { sendMessage } from './helpers.js';

/** Server / SW codes the dialog has its own sentence for; anything else reads share_err_generic. */
/** On the page root while it may share: the per-bubble buttons show (compare.css). */
const SHARE_CAN_CLASS = 'cmp-can-share';
/** Server / SW codes the dialog has its own sentence for — see SHARE_ERR_CODES below. */
const SHARE_ERR_CODES = ['generic', 'exists', 'empty', 'too_many_columns', 'share_off', 'share_disabled', 'share_daily_limit', 'rate_limited', 'payload_too_large', 'account_deleted', 'scope_insufficient', 'ext_token_required', 'share_deleted', 'not_found', 'network_error'];

/** Installs the share slice onto `ctx` (ctx contract: ui/compare/history.js header). */
export function installShare(ctx) {
  const { chrome, doc, state, t, el, clear, track, clock } = ctx;
  const shareOn = () => !!(state.status && state.status.shareOn === true);
  const storage = () => ctx.historyStorage || null;
  state.shares = {}; // SHARE_MAP_KEY as last read: sessionId → {id, title, updatedAt, kind}

  // ── the local map ──
  const readKey = (key) => new Promise((resolve) => {
    const s = storage();
    if (!s) { resolve(undefined); return; }
    try {
      const r = s.get(key, (v) => { void ctx.lastErr(); resolve(v ? v[key] : undefined); });
      if (r && typeof r.then === 'function') r.then((v) => resolve(v ? v[key] : undefined), () => resolve(undefined));
    } catch { resolve(undefined); }
  });
  const writeKey = (key, value) => new Promise((resolve) => {
    const s = storage();
    if (!s) { resolve(false); return; }
    try {
      const r = s.set({ [key]: value }, () => resolve(!ctx.lastErr()));
      if (r && typeof r.then === 'function') r.then(() => resolve(true), () => resolve(false));
    } catch { resolve(false); }
  });
  /** A stored map, rows that are not ours dropped (a hand edit, an older shape). */
  function cleanMap(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [sid, v] of Object.entries(raw)) {
      if (v && typeof v === 'object' && typeof v.id === 'string' && SHARE_ID_RE.test(v.id)) {
        out[sid] = { id: v.id, title: typeof v.title === 'string' ? v.title.slice(0, SHARE_TITLE_INPUT_MAX) : '', updatedAt: Number.isFinite(v.updatedAt) ? v.updatedAt : 0, kind: v.kind === 'debate' ? 'debate' : 'compare', sig: typeof v.sig === 'string' ? v.sig : '' };
      }
    }
    return out;
  }
  async function loadShares() {
    state.shares = cleanMap(await readKey(SHARE_MAP_KEY));
    return state.shares;
  }
  /** Read → change → write (another tab may have shared meanwhile: always from a fresh read). */
  async function updateShares(fn) {
    const map = cleanMap(await readKey(SHARE_MAP_KEY));
    fn(map);
    const keys = Object.keys(map).sort((a, b) => map[b].updatedAt - map[a].updatedAt);
    for (const k of keys.slice(SHARE_MAP_MAX)) delete map[k];
    await writeKey(SHARE_MAP_KEY, map);
    state.shares = map;
    if (ctx.historyList && !ctx.historyPanel.hidden) ctx.paintHistoryList();
  }
  const shareFor = (sessionId) => (sessionId && state.shares[sessionId]) || null;
  const forgetShareId = (id) => updateShares((map) => { for (const k of Object.keys(map)) if (map[k].id === id) delete map[k]; });

  /**
   * A fingerprint of what a snapshot SAYS (columns, rounds / timeline — not its title or focus):
   * whether the conversation went on since it was shared. Not the entry's updatedAt — every
   * snapshotSession() stamps the current time, so a time comparison said 「behind」 on every reopen.
   */
  function snapshotSig(snap) {
    const str = JSON.stringify([snap.columns, snap.rounds || null, snap.debate || null]);
    let h = 0x811c9dc5; // FNV-1a 32
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return `${str.length.toString(36)}.${h.toString(36)}`;
  }

  // ── what is shared ──
  /** The conversation on screen as a normalised entry (null: nothing stored — incognito, no session). */
  function currentEntry() {
    const snap = ctx.snapshotSession();
    return snap ? ctx.normalizeEntry(snap) : null;
  }
  /** Served model label, else the catalog label of the column's own model, else '' (provider only). */
  function modelLabel(_id, stored) {
    if (stored && stored.model && stored.model.label) return stored.model.label;
    return stored ? ctx.modelLabelOf(stored.provider, stored.colModel) : '';
  }
  function build(entry, title, focus) {
    return buildShareSnapshot(entry, {
      lang: ctx.lang, title, focus, modelLabel,
      aliasOf: (id) => (ctx.debateNameOf ? ctx.debateNameOf(id) : ''),
      summaryQuestion: t('summary_md_q'),
    });
  }
  /** The button: offered while the flag is on and there is a KEPT conversation with an answer. */
  function shareable() {
    // Not while a round is in flight: a streaming answer has no error / cut mark yet and would go up
    // as a complete one.
    // Never a frozen debate entry (history.js loadSession): shown as columns, it has no record to share.
    return shareOn() && !state.frozenDebate && state.sessionStarted && state.sessionSaveHistory === true && !!state.sessionId && !state.sending && [...state.columns.values()].some(ctx.columnHasAnswer);
  }
  function syncShareButton() {
    if (!ctx.shareBtn) return;
    ctx.shareBtn.hidden = !shareOn() || !state.sessionStarted;
    ctx.shareBtn.disabled = !shareable();
    // An incognito conversation is never stored, so it cannot be shared either — the button says why.
    ctx.shareBtn.title = state.sessionStarted && state.sessionSaveHistory !== true ? t('share_incognito') : t('share_btn_title');
    ctx.shareBtn.classList.toggle('is-shared', !!shareFor(state.sessionId));
    // The per-bubble buttons (shareTurnButton) follow the same gate through one class on the page.
    ctx.root.classList.toggle(SHARE_CAN_CLASS, shareable());
    syncTurnShareButtons();
  }
  /**
   * Which answers show 「공유」 — only where the share can open on THAT bubble (Codex U3c 1R/2R): it
   * settled with words, did not fail (the page and the link preview skip a failed answer), has a
   * round, and is its column's LAST answer of that round (the share carries a round's last answer,
   * share-snapshot.js). Computed from the turns AS THEY ARE on every sync — never stored on a turn:
   * a retry that is rolled back (CONSUME_FAIL removes its turn) must give the earlier answer its
   * button back, which a flag set when the retry was drawn never did.
   */
  function syncTurnShareButtons() {
    for (const col of state.columns.values()) {
      const lastOfRound = new Map();
      for (const turn of col.turns) if (turn.role === 'assistant' && Number.isFinite(turn.round)) lastOfRound.set(turn.round, turn);
      for (const turn of col.turns) {
        if (turn.role !== 'assistant' || !turn.shareBtn) continue;
        turn.shareBtn.hidden = !turn.settled || !turn.text || !!turn.errorText || !Number.isFinite(turn.round) || lastOfRound.get(turn.round) !== turn;
      }
    }
  }
  /**
   * 「공유」 under one bubble (#1784 U3c): the dialog opens with that bubble as the share's `focus`
   * — the page the link opens scrolls to it and the link preview quotes it. `getFocus()` is read
   * at click time (a turn learns its round when it is drawn). Shown only while the page may share
   * (SHARE_CAN_CLASS, CSS) and the caller's own `hidden` allows (an answer: once it has text).
   */
  function shareTurnButton(getFocus) {
    const btn = el('button', 'cmp-turn-share', t('share_turn'));
    btn.type = 'button';
    btn.title = t('share_turn_title');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.addEventListener('click', () => { openShareDialog(getFocus(), btn); });
    return btn;
  }

  // ── the dialog (built on first use) ──
  let dlg = null;
  let busy = false;
  let opener = null;
  // Bumped by every open AND every close (Codex U3b 1R): an open whose storage reads resolve after
  // the user left the conversation (새 대화, another history entry) must not show its dialog.
  let gen = 0;
  function buildDialog() {
    const node = el('div', 'cmp-share');
    node.id = 'cmp-share';
    node.hidden = true;
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-modal', 'true');
    node.setAttribute('aria-labelledby', 'cmp-share-title');
    const box = el('div', 'cmp-share-box');
    const head = el('div', 'cmp-share-head');
    const heading = el('h2', 'cmp-share-title', t('share_title'));
    heading.id = 'cmp-share-title';
    const close = el('button', 'cmp-share-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', t('share_close'));
    close.title = t('share_close');
    head.appendChild(heading);
    head.appendChild(close);
    box.appendChild(head);

    // The link, once there is one: the URL, copy, open, and whether the page is behind the chat.
    const linkRow = el('div', 'cmp-share-link');
    const linkUrl = el('input', 'cmp-share-url');
    linkUrl.type = 'text';
    linkUrl.readOnly = true;
    linkUrl.setAttribute('aria-label', t('share_link_label'));
    const copyBtn = el('button', 'cmp-btn cmp-btn-sm cmp-btn-primary', t('share_copy'));
    copyBtn.type = 'button';
    linkRow.appendChild(linkUrl);
    linkRow.appendChild(copyBtn);
    const openSlot = el('span', 'cmp-share-open-slot'); // the 「열기」 link, drawn per share (paintLink)
    linkRow.appendChild(openSlot);
    const linkNote = el('p', 'cmp-share-note');
    box.appendChild(linkRow);
    box.appendChild(linkNote);

    const form = el('div', 'cmp-share-form');
    const titleLabel = el('label', 'cmp-share-label', t('share_title_label'));
    const titleInput = el('input', 'cmp-share-input');
    titleInput.type = 'text';
    titleInput.maxLength = SHARE_TITLE_INPUT_MAX;
    titleInput.id = 'cmp-share-title-input';
    titleLabel.setAttribute('for', titleInput.id);
    form.appendChild(titleLabel);
    form.appendChild(titleInput);

    const authorSet = el('fieldset', 'cmp-share-author');
    authorSet.appendChild(el('legend', 'cmp-share-label', t('share_author_label')));
    const radios = {};
    for (const mode of SHARE_AUTHOR_MODES) {
      const lab = el('label', 'cmp-share-radio');
      const r = el('input');
      r.type = 'radio';
      r.name = 'cmp-share-author';
      r.value = mode;
      lab.appendChild(r);
      lab.appendChild(el('span', null, t(`share_author_${mode}`)));
      authorSet.appendChild(lab);
      radios[mode] = r;
    }
    const nameInput = el('input', 'cmp-share-input cmp-share-name');
    nameInput.type = 'text';
    nameInput.maxLength = SHARE_NAME_INPUT_MAX;
    nameInput.placeholder = t('share_name_placeholder');
    nameInput.setAttribute('aria-label', t('share_name_label'));
    authorSet.appendChild(nameInput);
    form.appendChild(authorSet);
    box.appendChild(form);

    const warn = el('p', 'cmp-share-warn', t('share_warn'));
    box.appendChild(warn);
    const previewLabel = el('p', 'cmp-share-label', t('share_preview'));
    const preview = el('div', 'cmp-share-preview');
    preview.setAttribute('tabindex', '0');
    preview.setAttribute('aria-label', t('share_preview'));
    box.appendChild(previewLabel);
    box.appendChild(preview);

    const error = el('p', 'cmp-share-error');
    error.setAttribute('role', 'alert');
    box.appendChild(error);

    const actions = el('div', 'cmp-share-actions');
    const mineBtn = el('button', 'cmp-btn cmp-btn-sm cmp-share-mine-btn', t('share_mine'));
    mineBtn.type = 'button';
    const deleteBtn = el('button', 'cmp-btn cmp-btn-sm cmp-share-delete', t('share_delete'));
    deleteBtn.type = 'button';
    const submitBtn = el('button', 'cmp-btn cmp-btn-sm cmp-btn-primary cmp-share-submit');
    submitBtn.type = 'button';
    actions.appendChild(mineBtn);
    actions.appendChild(deleteBtn);
    actions.appendChild(submitBtn);
    box.appendChild(actions);
    const confirmRow = el('div', 'cmp-share-confirm');
    confirmRow.appendChild(el('p', 'cmp-share-note', t('share_delete_confirm')));
    const confirmYes = el('button', 'cmp-btn cmp-btn-sm cmp-share-delete', t('share_delete_yes'));
    confirmYes.type = 'button';
    const confirmNo = el('button', 'cmp-btn cmp-btn-sm', t('share_delete_no'));
    confirmNo.type = 'button';
    confirmRow.appendChild(confirmNo);
    confirmRow.appendChild(confirmYes);
    box.appendChild(confirmRow);

    confirmRow.hidden = true;
    const mine = el('div', 'cmp-share-mine');
    mine.hidden = true;
    box.appendChild(mine);
    node.appendChild(box);

    close.addEventListener('click', closeShareDialog);
    node.addEventListener('click', (e) => { if (e.target === node) closeShareDialog(); });
    // Escape from anywhere while it is open — focus can land on the body when the control it was on
    // is hidden (the delete confirm row), and the dialog must still close.
    doc.addEventListener('keydown', (e) => { if (e && e.key === 'Escape' && !node.hidden) { e.preventDefault(); closeShareDialog(); } });
    titleInput.addEventListener('input', () => repaintPreview());
    for (const r of Object.values(radios)) r.addEventListener('change', () => { syncNameInput(); repaintPreview(); });
    nameInput.addEventListener('input', () => repaintPreview());
    copyBtn.addEventListener('click', async () => {
      if (!linkUrl.value) return;
      const copied = await ctx.copyText(linkUrl.value);
      if (!copied) return;
      track('share_copy', { kind: dlg.kind });
      copyBtn.textContent = t('copied');
      clock.setTimeout(() => { copyBtn.textContent = t('share_copy'); }, COPY_FEEDBACK_MS);
    });
    submitBtn.addEventListener('click', submit);
    deleteBtn.addEventListener('click', () => { confirmRow.hidden = false; actions.hidden = true; confirmNo.focus(); });
    confirmNo.addEventListener('click', () => { confirmRow.hidden = true; actions.hidden = false; });
    confirmYes.addEventListener('click', () => removeShare(dlg.share && dlg.share.id, 'dialog'));
    mineBtn.addEventListener('click', toggleMine);
    ctx.root.appendChild(node);
    return { snapshot: null, node, box, heading, form, warn, previewLabel, close, linkRow, linkUrl, copyBtn, openSlot, linkNote, titleInput, radios, nameInput, preview, error, actions, mineBtn, deleteBtn, submitBtn, confirmRow, mine, kind: 'compare', entry: null, focus: null, share: null, sessionId: null };
  }
  const authorMode = () => SHARE_AUTHOR_MODES.find((m) => dlg.radios[m].checked) || SHARE_AUTHOR_ANON;
  function syncNameInput() { dlg.nameInput.hidden = authorMode() === SHARE_AUTHOR_ANON; }
  function setError(code) {
    dlg.error.textContent = code ? t(SHARE_ERR_CODES.includes(code) ? `share_err_${code}` : 'share_err_generic') : '';
    dlg.error.hidden = !code;
  }
  /**
   * 「내 공유 링크」 only (manage mode): the list and its deletes, nothing of a conversation. The way to
   * take a public link down must not depend on having a shareable conversation on screen — after 새
   * 대화, with the history entry gone, or with the flag off (delete / list stay open by design), the
   * dialog's other door is shut (share-ON batch review 1R ①). Opened from the history panel.
   */
  function setManageMode(on) {
    dlg.heading.textContent = t(on ? 'share_mine' : 'share_title');
    for (const n of [dlg.form, dlg.warn, dlg.previewLabel, dlg.preview, dlg.actions]) n.hidden = on;
    if (on) { dlg.linkRow.hidden = true; dlg.linkNote.hidden = true; dlg.confirmRow.hidden = true; }
  }
  /**
   * The inputs of a write are frozen while it is on the wire (share-ON batch review 1R ②): an edit
   * after the click would redraw the preview with words that were NOT sent, and the success view
   * would then show that preview beside the link.
   */
  function lockInputs(on) {
    dlg.titleInput.disabled = on;
    dlg.nameInput.disabled = on;
    for (const r of Object.values(dlg.radios)) r.disabled = on;
  }
  async function openMyShares(from = null) {
    if (!dlg) dlg = buildDialog();
    gen++; // any open / submit of a conversation dialog is void now
    opener = from || null;
    dlg.entry = null;
    dlg.sessionId = null;
    dlg.share = null;
    dlg.snapshot = null;
    dlg.focus = null;
    setError(null);
    setManageMode(true);
    clear(dlg.preview);
    dlg.node.hidden = false;
    dlg.mine.hidden = false;
    track('share_mine_open');
    try { dlg.close.focus(); } catch { /* focus is a nicety */ }
    await renderMine();
  }
  /** The history panel's 「내 공유 링크」: while sharing is offered, or while this browser still holds links it made. */
  async function syncMySharesEntry() {
    if (!ctx.historySharesBtn) return;
    if (!shareOn()) await loadShares();
    ctx.historySharesBtn.hidden = !shareOn() && !Object.keys(state.shares).length;
  }

  /**
   * Open for the conversation on screen. `focus` = the bubble the share starts from (compare
   * {round, col?} in the entry's rounds, debate {seq} / {topic: true}), null for the whole thing.
   */
  async function openShareDialog(focus = null, from = null) {
    if (!shareable()) return;
    if (!dlg) dlg = buildDialog();
    const my = ++gen;
    const entry = currentEntry();
    if (!entry) return;
    const current = () => my === gen && state.sessionId === entry.id; // not closed, not reopened, same conversation
    await loadShares();
    if (!current()) return;
    const pref = await readKey(SHARE_AUTHOR_PREF_KEY);
    if (!current()) return;
    opener = from || ctx.shareBtn || null;
    dlg.entry = entry;
    dlg.focus = focus;
    dlg.sessionId = entry.id;
    dlg.share = shareFor(entry.id);
    dlg.titleInput.value = dlg.share ? dlg.share.title : '';
    const mode = SHARE_AUTHOR_MODES.includes(pref) ? pref : SHARE_AUTHOR_ANON; // anonymous until the user picks otherwise (§10.2)
    for (const m of SHARE_AUTHOR_MODES) dlg.radios[m].checked = m === mode;
    dlg.nameInput.value = '';
    syncNameInput();
    setError(null);
    setManageMode(false);
    lockInputs(busy);
    dlg.confirmRow.hidden = true;
    dlg.actions.hidden = false;
    dlg.mine.hidden = true;
    clear(dlg.mine);
    repaintPreview(); // first: the link note compares against the snapshot it draws
    paintLink();
    dlg.node.hidden = false;
    track('share_open', { kind: dlg.kind, focus: focus ? 1 : 0, existing: dlg.share ? 1 : 0 });
    (dlg.share ? dlg.copyBtn : dlg.titleInput).focus();
  }
  function closeShareDialog() {
    gen++; // an open still reading storage is void too
    if (!dlg || dlg.node.hidden) return;
    dlg.node.hidden = true;
    dlg.entry = null;
    dlg.sessionId = null;
    if (opener && typeof opener.focus === 'function') { try { opener.focus(); } catch { /* gone */ } }
    opener = null;
  }
  function paintLink() {
    const s = dlg.share;
    const shareHref = s ? shareUrlOf(s.id) : null;
    dlg.linkRow.hidden = !shareHref;
    dlg.linkNote.hidden = !shareHref;
    dlg.deleteBtn.hidden = !shareHref;
    dlg.submitBtn.textContent = t(shareHref ? 'share_update' : 'share_create');
    clear(dlg.openSlot);
    if (!shareHref) return;
    dlg.linkUrl.value = shareHref;
    dlg.openSlot.appendChild(ctx.link(shareHref, t('share_open'), 'cmp-btn cmp-btn-sm'));
    // The page is a copy taken when it was shared — the conversation may have gone on since.
    dlg.linkNote.textContent = dlg.snapshot && s.sig && snapshotSig(dlg.snapshot) !== s.sig ? t('share_behind') : t('share_current');
  }

  // ── the preview: the snapshot, drawn ──
  function repaintPreview() {
    if (!dlg || !dlg.entry) return;
    const built = build(dlg.entry, dlg.titleInput.value, dlg.focus);
    clear(dlg.preview);
    dlg.snapshot = built.error ? null : built.snapshot; // what 「링크 만들기 / 업데이트」 sends — exactly this
    dlg.submitBtn.disabled = busy || !!built.error;
    if (built.error) { setError(built.error); return; }
    setError(null);
    const snap = built.snapshot;
    dlg.kind = snap.kind;
    dlg.titleInput.placeholder = firstQuestion(snap).split('\n')[0].slice(0, SHARE_TITLE_INPUT_MAX);
    const who = authorMode() === SHARE_AUTHOR_ANON ? t('share_preview_anon') : (dlg.nameInput.value.trim() || t('share_preview_named'));
    const card = el('div', 'cmp-share-card');
    card.appendChild(el('span', 'cmp-share-card-host', 'claudetuner.com'));
    card.appendChild(el('span', 'cmp-share-card-title', snap.title || firstQuestion(snap)));
    card.appendChild(el('span', 'cmp-share-card-by', who));
    dlg.preview.appendChild(card);
    const byKey = Object.fromEntries(snap.columns.map((c) => [c.key, c]));
    const colName = (c) => (c.model ? `${PROVIDER_META[c.provider].label} ${c.model}` : PROVIDER_META[c.provider].label);
    let focusNode = null;
    const bubble = (cls, name, text, markdown, state) => {
      const b = el('div', `cmp-share-msg ${cls}`);
      b.appendChild(el('div', 'cmp-share-msg-who', name));
      // An answer is drawn with the page's own answer typography (lists, code, tables).
      const body = el('div', markdown ? 'cmp-share-msg-body cmp-turn-assistant' : 'cmp-share-msg-body');
      if (markdown) {
        try { body.appendChild(renderAnswer(text, doc, { cut: state !== 'ok' }).fragment); } catch { body.textContent = text; }
      } else body.textContent = text;
      b.appendChild(body);
      if (state === 'partial' || state === 'error') b.appendChild(el('p', 'cmp-share-note', t(state === 'error' ? 'share_state_error' : 'share_state_partial')));
      dlg.preview.appendChild(b);
      return b;
    };
    if (snap.kind === 'compare') {
      snap.rounds.forEach((r, i) => {
        dlg.preview.appendChild(el('p', 'cmp-share-round', r.kind === 'summary' ? t('share_round_summary') : t('share_round', i + 1)));
        const q = bubble('is-me', who, r.q + (r.qImages ? `\n${t('share_images', r.qImages)}` : ''), false, 'ok');
        if (snap.focus && snap.focus.round === i && !snap.focus.col) focusNode = q;
        for (const c of snap.columns) {
          const a = r.answers[c.key];
          if (!a) continue;
          const n = bubble('', colName(c), a.text, true, a.state);
          if (snap.focus && snap.focus.round === i && snap.focus.col === c.key) focusNode = n;
        }
      });
    } else {
      const d = snap.debate;
      d.timeline.forEach((it, i) => {
        const c = byKey[it.who];
        const name = it.who === 'user' ? who : `${d.aliases[it.who] || colName(c)}${it.role === 'mod' ? ` · ${t('debate_role_moderator')}` : ''}`;
        const n = bubble(it.who === 'user' ? 'is-me' : '', name, it.text, it.who !== 'user', it.state || 'ok');
        if (snap.focus && snap.focus.t === i) focusNode = n;
      });
    }
    if (focusNode) {
      focusNode.classList.add('is-focus');
      try { focusNode.scrollIntoView({ block: 'center' }); } catch { /* no layout (tests) */ }
    }
  }
  const firstQuestion = (snap) => (snap.kind === 'compare' ? snap.rounds[0].q : (snap.debate.timeline[0] || {}).text || '');

  // ── create / update / delete ──
  /**
   * `fn` under ONE cross-tab lock for every share write of this browser (Codex U3b 2R): two tabs of
   * the same conversation could both find no link and both mint one, and the map kept only the
   * second. Every compare tab is the chrome-extension:// origin, so a Web Lock serialises them —
   * the same tool history.js uses. A wait that exceeds SHARE_LOCK_WAIT_MS gives up (the user
   * retries) rather than running unserialised. Without navigator.locks (a test env) it runs directly.
   */
  async function underShareLock(fn) {
    const locks = ctx.nav && ctx.nav.locks && typeof ctx.nav.locks.request === 'function' ? ctx.nav.locks : null;
    if (!locks) return fn();
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? clock.setTimeout(() => { try { ac.abort(); } catch { /* settled */ } }, SHARE_LOCK_WAIT_MS) : null;
    try {
      return await locks.request(SHARE_LOCK_NAME, ac ? { signal: ac.signal } : {}, fn);
    } catch (e) {
      if (ac && ac.signal.aborted) return { error: 'generic' };
      throw e;
    } finally {
      if (timer != null) clock.clearTimeout(timer);
    }
  }
  /**
   * Under the lock: the map as it is NOW decides create vs 「another tab already made it」, the
   * request goes out, and its link is recorded before the lock is let go — so no other tab can
   * decide from a map that does not have it yet.
   */
  async function writeShare(sessionId, asked, snapshot, mode, authorName) {
    await loadShares();
    const current = shareFor(sessionId);
    if (!asked && current) return { exists: current };
    const res = await sendMessage(chrome, {
      type: SHARE_MSG_TYPE, op: asked ? SHARE_OP_UPDATE : SHARE_OP_CREATE, ...(asked ? { id: asked.id } : {}),
      snapshot, author: mode, ...(authorName ? { authorName } : {}),
    });
    if (!res || res.ok !== true) {
      const code = res && typeof res.code === 'string' ? res.code : 'network_error';
      // The link was deleted elsewhere (「내 공유 링크」, another browser): forget it here too.
      const gone = !!asked && (code === 'share_deleted' || code === 'not_found');
      if (gone) await forgetShareId(asked.id);
      return { error: code, gone };
    }
    // 🔴 Recorded whatever became of the dialog: the link EXISTS on the server now, and closing the
    // dialog mid-request must not leave it unreachable from this conversation (「업데이트 / 삭제」).
    const record = { id: res.id, title: snapshot.title, updatedAt: clock.now(), kind: snapshot.kind, sig: snapshotSig(snapshot) };
    await updateShares((map) => { map[sessionId] = record; });
    await writeKey(SHARE_AUTHOR_PREF_KEY, mode);
    const settled = res.author && SHARE_AUTHOR_MODES.includes(res.author.mode) ? res.author.mode : SHARE_AUTHOR_ANON;
    track(asked ? 'share_update' : 'share_create', { kind: snapshot.kind, author: mode, settled, focus: snapshot.focus ? 1 : 0 });
    return { record, settled };
  }
  async function submit() {
    // 🔴 The snapshot the preview drew, as it is — see the header.
    const snapshot = dlg.snapshot;
    const entry = dlg.entry;
    if (busy || !entry || !snapshot) return;
    if (state.sessionId !== entry.id) { closeShareDialog(); return; } // the page moved to another conversation
    const my = gen;
    const here = () => my === gen; // still this dialog (not closed / reopened)
    const mode = authorMode();
    const authorName = mode !== SHARE_AUTHOR_ANON ? dlg.nameInput.value.trim() : '';
    // 🔴 Every input of the write is taken NOW, at the click — never read inside the lock callback,
    // which may run seconds later over ANOTHER conversation's dialog (Codex U3b 3R: A's content went
    // up as an update of B's link).
    const asked = dlg.share;
    busy = true;
    dlg.submitBtn.disabled = true;
    lockInputs(true);
    setError(null);
    let out;
    try {
      out = await underShareLock(() => writeShare(entry.id, asked, snapshot, mode, authorName));
    } catch {
      out = { error: 'generic' };
    } finally {
      busy = false;
      lockInputs(false);
      // Whichever dialog is open NOW — this one, or one reopened while the request ran (Codex U3b
      // 2R: it opened with the button disabled by `busy` and nothing gave it back).
      if (!dlg.node.hidden) dlg.submitBtn.disabled = !dlg.snapshot;
    }
    syncShareButton();
    if (!here()) return;
    if (out.exists) { dlg.share = out.exists; paintLink(); setError('exists'); return; }
    if (out.error) {
      if (out.gone) { dlg.share = null; paintLink(); }
      setError(out.error);
      return;
    }
    dlg.share = out.record;
    // The author the SERVER published (no usable name → anonymous): the dialog shows that, not the ask.
    for (const m of SHARE_AUTHOR_MODES) dlg.radios[m].checked = m === out.settled;
    syncNameInput();
    paintLink();
    if (out.settled !== mode) dlg.linkNote.textContent = t('share_author_fallback');
    repaintPreview();
    dlg.copyBtn.focus();
  }
  async function removeShare(id, from) {
    if (busy || !id || !SHARE_ID_RE.test(id)) return;
    busy = true;
    setError(null);
    // Under the same lock as every create / update (Codex U3b 3R): an update in another tab records
    // its link only after its request, so a delete that forgot the link meanwhile saw it come back.
    // 404 = not ours / already gone: either way nothing is left to delete.
    let res;
    try {
      res = await underShareLock(async () => {
        const r = await sendMessage(chrome, { type: SHARE_MSG_TYPE, op: SHARE_OP_DELETE, id });
        if (r && (r.ok === true || r.code === 'not_found')) await forgetShareId(id);
        return r;
      });
    } catch {
      res = null;
    } finally {
      busy = false;
      // A conversation dialog opened while the delete ran came up locked by `busy` (share-ON batch
      // review 2R): give its inputs and button back, as submit's own finally does.
      if (dlg && !dlg.node.hidden && dlg.entry) { lockInputs(false); dlg.submitBtn.disabled = !dlg.snapshot; }
    }
    if (!res || (res.ok !== true && res.code !== 'not_found')) {
      setError(res && typeof res.code === 'string' ? res.code : res && res.error ? res.error : 'network_error');
      dlg.confirmRow.hidden = true;
      dlg.actions.hidden = false;
      return;
    }
    track('share_delete', { from });
    if (dlg.share && dlg.share.id === id) { dlg.share = null; paintLink(); }
    dlg.confirmRow.hidden = true;
    dlg.actions.hidden = false;
    if (from === 'dialog') dlg.submitBtn.focus();
    if (from === 'mine') renderMine();
    syncShareButton();
  }

  // ── 「내 공유 링크」: the server's list (a share outlives the history entry it came from) ──
  async function toggleMine() {
    if (!dlg.mine.hidden) { dlg.mine.hidden = true; return; }
    dlg.mine.hidden = false;
    await renderMine();
  }
  let mineSeq = 0; // every list request is numbered: only the NEWEST answer is drawn
  async function renderMine() {
    // Not the opening (gen) but the request (share-ON batch review 3R): a list asked before a delete
    // that answers after the post-delete list would bring the deleted link back.
    const my = ++mineSeq;
    clear(dlg.mine);
    dlg.mine.appendChild(el('p', 'cmp-share-note', t('share_mine_loading')));
    const res = await sendMessage(chrome, { type: SHARE_MSG_TYPE, op: SHARE_OP_LIST });
    if (my !== mineSeq || dlg.node.hidden || dlg.mine.hidden) return;
    clear(dlg.mine);
    if (!res || res.ok !== true) { dlg.mine.appendChild(el('p', 'cmp-share-error', t('share_err_generic'))); return; }
    if (!res.shares.length) { dlg.mine.appendChild(el('p', 'cmp-share-note', t('share_mine_empty'))); return; }
    for (const s of res.shares) {
      // The link is spelled here from the id (the SW's `url` is not trusted as an href).
      const shareHref = shareUrlOf(s.id);
      if (!shareHref) continue;
      const row = el('div', 'cmp-share-mine-row');
      row.appendChild(ctx.link(shareHref, s.title || t(s.kind === 'debate' ? 'share_kind_debate' : 'share_kind_compare'), 'cmp-share-mine-title'));
      const date = new Date(s.createdAt);
      row.appendChild(el('span', 'cmp-share-mine-meta', [Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(), t('share_views', s.views)].filter(Boolean).join(' · ')));
      const del = el('button', 'cmp-btn cmp-btn-sm cmp-share-delete', t('share_delete'));
      del.type = 'button';
      // Two presses (the list has no room for a confirm row): the first arms it for a few seconds.
      del.addEventListener('click', () => {
        if (del.dataset.armed === '1') { removeShare(s.id, 'mine'); return; }
        del.dataset.armed = '1';
        del.textContent = t('share_delete_yes');
        clock.setTimeout(() => { del.dataset.armed = ''; del.textContent = t('share_delete'); }, COPY_FEEDBACK_MS * 2);
      });
      row.appendChild(del);
      dlg.mine.appendChild(row);
    }
  }

  Object.assign(ctx, { shareOn, shareFor, loadShares, syncShareButton, syncTurnShareButtons, shareTurnButton, openShareDialog, closeShareDialog, openMyShares, syncMySharesEntry });
}
