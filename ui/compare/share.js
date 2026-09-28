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
//
// ONE-CLICK (SHARE_ONE_CLICK, the default — user request 2026-09-27): 「공유」 makes the link (or
// updates this conversation's link with what is on screen now) and copies it, in one click; a small
// non-modal popover by the button then offers the optional adjustments — a password (set / change /
// remove on the EXISTING link), who it shows as, delete. The snapshot is built once, at the click,
// and is exactly what goes up (the rule above, without a preview step). The dialog below stays for
// 「내 공유 링크」 and as the classic flow behind the constant.

import { buildShareSnapshot, shareModelLabel } from './share-snapshot.js';
import { renderAnswer } from '../md-render.js';
import {
  PROVIDER_META, COPY_FEEDBACK_MS, SHARE_MSG_TYPE, SHARE_OP_CREATE, SHARE_OP_UPDATE, SHARE_OP_DELETE, SHARE_OP_LIST, SHARE_OP_PASSWORD,
  SHARE_AUTHOR_ANON, SHARE_AUTHOR_NAME, SHARE_AUTHOR_NAME_PHOTO, SHARE_AUTHOR_MODES, SHARE_AUTHOR_DEFAULT, SHARE_AUTHOR_PREF_KEY, SHARE_AUTHOR_PREF_KEY_V1, SHARE_MAP_KEY, SHARE_MAP_MAX,
  SHARE_ID_RE, SHARE_TITLE_INPUT_MAX, SHARE_NAME_INPUT_MAX, SHARE_VIS_PUBLIC, SHARE_VIS_PRIVATE, SHARE_PASSWORD_MIN, SHARE_PASSWORD_INPUT_MAX, SHARE_LOCK_NAME, SHARE_LOCK_WAIT_MS, shareUrlOf,
} from './constants.js';
import { sendMessage } from './helpers.js';
import { bytesToBase64 } from './attachments.js';

/** Server / SW codes the dialog has its own sentence for; anything else reads share_err_generic. */
/** On the page root while it may share: the per-bubble buttons show (compare.css). */
const SHARE_CAN_CLASS = 'cmp-can-share';
/** Server / SW codes the dialog has its own sentence for — see SHARE_ERR_CODES below. */
const SHARE_ERR_CODES = ['stale', 'share_busy', 'bad_password', 'share_fixed', 'generic', 'exists', 'empty', 'too_many_columns', 'share_off', 'share_disabled', 'share_daily_limit', 'rate_limited', 'payload_too_large', 'account_deleted', 'scope_insufficient', 'ext_token_required', 'share_deleted', 'not_found', 'network_error'];

/**
 * The link-preview card of a PUBLIC share (#1784 U6, bg/compare.js shareRequest op 'image'). Drawn
 * and uploaded while the share lock is still held — so a later update of the same link cannot land
 * between and be followed by a card of the older content — but within this budget, so a hung
 * render / request never keeps every other tab's share write waiting.
 */
const SHARE_OP_IMAGE = 'image';
const SHARE_CARD_BUDGET_MS = 20000;

/**
 * One click = link made (or updated) + copied; the classic dialog (title · visibility · preview) is
 * kept behind this constant. A preview page can ask for the classic flow (`window.__ctShareClassic`,
 * test/compare-preview) so its tests keep covering it.
 */
export const SHARE_ONE_CLICK = true;
/** writeShare's `asked` meaning 「whatever link this conversation has when the lock is held」 (one-click). */
const SHARE_ASK_LATEST = Symbol('share-ask-latest');
/**
 * writeShare's `mode` for a one-click 「공유」: decide the author UNDER the lock, from the link the map holds
 * then (authorFor) — a decision taken before the lock would miss another tab making the link anonymous
 * meanwhile and widen it back to name + photo (Codex share-default 2R).
 */
const SHARE_AUTHOR_AUTO = Symbol('share-author-auto');
/** The popover's geometry: its width, the gutter it keeps to the window edges, its gap to the button. */
const POP_WIDTH_PX = 360;
const POP_GUTTER_PX = 16;
const POP_GAP_PX = 8;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Installs the share slice onto `ctx` (ctx contract: ui/compare/history.js header). */
export function installShare(ctx) {
  const { chrome, doc, state, t, el, clear, track, clock } = ctx;
  const shareOn = () => !!(state.status && state.status.shareOn === true);
  const storage = () => ctx.historyStorage || null;
  const oneClick = SHARE_ONE_CLICK && !(ctx.win && ctx.win.__ctShareClassic === true);
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
        out[sid] = { id: v.id, title: typeof v.title === 'string' ? v.title.slice(0, SHARE_TITLE_INPUT_MAX) : '', updatedAt: Number.isFinite(v.updatedAt) ? v.updatedAt : 0, kind: v.kind === 'debate' ? 'debate' : 'compare', sig: typeof v.sig === 'string' ? v.sig : '', ...(typeof v.label === 'string' && v.label ? { label: v.label.slice(0, SHARE_TITLE_INPUT_MAX) } : {}), ...(v.vis === 'private' ? { vis: 'private' } : {}), ...(SHARE_AUTHOR_MODES.includes(v.author) ? { author: v.author } : {}) };
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
  /** The conversation on screen as a normalised entry (null: no session). An incognito one too — see snapshotSession. */
  function currentEntry() {
    const snap = ctx.snapshotSession({ anyMode: true });
    return snap ? ctx.normalizeEntry(snap) : null;
  }
  /** The column's model in display words (share-snapshot.js shareModelLabel — never an internal id). */
  const modelLabel = (_id, stored) => shareModelLabel(stored, ctx.modelLabelOf);
  function build(entry, title, focus) {
    return buildShareSnapshot(entry, {
      lang: ctx.lang, title, focus, modelLabel,
      aliasOf: (id) => (ctx.debateNameOf ? ctx.debateNameOf(id) : ''),
      avatarOf: (id) => (ctx.debateEmojiOf ? ctx.debateEmojiOf(id) : ''),
      summaryQuestion: t('summary_md_q'),
    });
  }
  /** The button: offered while the flag is on and there is a conversation with an answer (incognito too). */
  function shareable() {
    // Not while a round is in flight: a streaming answer has no error / cut mark yet and would go up
    // as a complete one.
    // Never a frozen debate entry (history.js loadSession): shown as columns, it has no record to share.
    return shareOn() && !state.frozenDebate && state.sessionStarted && !!state.sessionId && !state.sending && [...state.columns.values()].some(ctx.columnHasAnswer);
  }
  const NUDGE_CLASS = 'is-nudge';
  const nudged = new Set(); // session ids whose 「공유하기」 has pulsed on this page
  let nudgeWired = null; // the button the calm-down listeners are on (the bar is built after install)
  function syncShareButton() {
    if (!ctx.shareBtn) return;
    if (nudgeWired !== ctx.shareBtn) {
      nudgeWired = ctx.shareBtn;
      const btn = ctx.shareBtn;
      const calm = () => btn.classList.remove(NUDGE_CLASS);
      btn.addEventListener('animationend', calm);
      btn.addEventListener('click', calm);
    }
    ctx.shareBtn.hidden = !shareOn() || !state.sessionStarted;
    ctx.shareBtn.disabled = !shareable();
    // An incognito conversation is shared like any other: the share is the user's own upload, while
    // incognito is about the sites' history and the local list (it stays out of both).
    ctx.shareBtn.title = t('share_btn_title');
    ctx.shareBtn.classList.toggle('is-shared', !!shareFor(state.sessionId));
    // The first moment a conversation can be shared, the button pulses (CSS, twice) — once per
    // conversation, and never for one that already has a link (2026-09-27: make sharing noticed).
    if (!ctx.shareBtn.disabled && !ctx.shareBtn.hidden && state.sessionId && !nudged.has(state.sessionId) && !shareFor(state.sessionId)) {
      nudged.add(state.sessionId);
      ctx.shareBtn.classList.add(NUDGE_CLASS);
    } else if (ctx.shareBtn.disabled || ctx.shareBtn.hidden || shareFor(state.sessionId)) {
      ctx.shareBtn.classList.remove(NUDGE_CLASS); // another conversation / a link made elsewhere: no leftover pulse (1R)
    }
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
    const btn = el('button', 'cmp-turn-share');
    btn.appendChild(ctx.linkIcon());
    btn.appendChild(el('span', null, t('share_turn')));
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

    // Who may open it (#1784 U5): anyone with the link, or only with a password (the server checks it).
    const visSet = el('fieldset', 'cmp-share-author cmp-share-vis');
    visSet.appendChild(el('legend', 'cmp-share-label', t('share_vis_label')));
    const vis = {};
    for (const v of [SHARE_VIS_PUBLIC, SHARE_VIS_PRIVATE]) {
      const lab = el('label', 'cmp-share-radio');
      const r = el('input');
      r.type = 'radio';
      r.name = 'cmp-share-vis';
      r.value = v;
      lab.appendChild(r);
      lab.appendChild(el('span', null, t(`share_vis_${v}`)));
      visSet.appendChild(lab);
      vis[v] = r;
    }
    const passwordInput = el('input', 'cmp-share-input cmp-share-name cmp-share-password');
    passwordInput.type = 'password';
    passwordInput.autocomplete = 'new-password';
    // No maxLength: it counts UTF-16 units and would silently cut a password the server accepts
    // (Codex U5c 1R) — the length is checked in code points at the click instead.
    passwordInput.placeholder = t('share_password_placeholder');
    passwordInput.setAttribute('aria-label', t('share_password_label'));
    visSet.appendChild(passwordInput);
    form.appendChild(visSet);

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
    for (const r of Object.values(vis)) r.addEventListener('change', () => { syncVisibility(); repaintPreview(); });
    return { snapshot: null, node, box, heading, form, warn, previewLabel, close, linkRow, linkUrl, copyBtn, openSlot, linkNote, titleInput, radios, nameInput, vis, visSet, passwordInput, authorSet, preview, error, actions, mineBtn, deleteBtn, submitBtn, confirmRow, mine, kind: 'compare', entry: null, focus: null, share: null, sessionId: null };
  }
  const authorMode = () => SHARE_AUTHOR_MODES.find((m) => dlg.radios[m].checked) || SHARE_AUTHOR_ANON;
  function syncNameInput() { dlg.nameInput.hidden = authorMode() === SHARE_AUTHOR_ANON; }
  const privateChosen = () => dlg.vis[SHARE_VIS_PRIVATE].checked;
  /**
   * Public / password (#1784 U5). A private share is anonymous (a name would show before the
   * password), so the author choice goes; the password field shows. A share that EXISTS keeps its
   * visibility (the server never changes it) — the choice is locked to it.
   */
  function syncVisibility() {
    const existing = dlg.share;
    const priv = existing ? existing.vis === 'private' : privateChosen();
    dlg.vis[SHARE_VIS_PRIVATE].checked = priv;
    dlg.vis[SHARE_VIS_PUBLIC].checked = !priv;
    for (const r of Object.values(dlg.vis)) r.disabled = !!existing;
    dlg.passwordInput.hidden = !priv || !!existing;
    dlg.authorSet.hidden = priv;
    dlg.warn.textContent = t(priv ? 'share_warn_private' : 'share_warn');
  }
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
    // The visibility and password too (#1784 U5) — and on release, the visibility stays locked to an
    // EXISTING share's (syncVisibility's rule), never re-opened by the unlock.
    dlg.passwordInput.disabled = on;
    for (const r of Object.values(dlg.vis)) r.disabled = on || !!dlg.share;
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
  function openShareDialog(focus = null, from = null) {
    return oneClick ? shareNow(focus, from) : openClassicDialog(focus, from);
  }
  async function openClassicDialog(focus, from) {
    if (!shareable()) return;
    if (!dlg) dlg = buildDialog();
    const my = ++gen;
    const entry = currentEntry();
    if (!entry) return;
    const current = () => my === gen && state.sessionId === entry.id; // not closed, not reopened, same conversation
    await loadShares();
    if (!current()) return;
    const [pref, legacyPref] = await Promise.all([readKey(SHARE_AUTHOR_PREF_KEY), readKey(SHARE_AUTHOR_PREF_KEY_V1)]);
    if (!current()) return;
    opener = from || ctx.shareBtn || null;
    dlg.entry = entry;
    dlg.focus = focus;
    dlg.sessionId = entry.id;
    dlg.share = shareFor(entry.id);
    dlg.titleInput.value = dlg.share ? dlg.share.title : '';
    const mode = authorFor(dlg.share, pref, legacyPref); // a new link: the pick, else name + photo; an existing one: as it is
    for (const m of SHARE_AUTHOR_MODES) dlg.radios[m].checked = m === mode;
    dlg.nameInput.value = '';
    syncNameInput();
    // Public unless the user picks the password each time — a password is never remembered.
    dlg.vis[SHARE_VIS_PUBLIC].checked = true;
    dlg.vis[SHARE_VIS_PRIVATE].checked = false;
    dlg.passwordInput.value = '';
    syncVisibility();
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
    closePop(false);
    if (!dlg || dlg.node.hidden) return;
    dlg.passwordInput.value = ''; // a password typed and abandoned must not stay in the page (Codex U5c 1R)
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
    // A private share is never edited (the server answers 409): delete it and make a new one.
    dlg.submitBtn.hidden = !!shareHref && s.vis === 'private';
    clear(dlg.openSlot);
    if (!shareHref) return;
    dlg.linkUrl.value = shareHref;
    dlg.openSlot.appendChild(ctx.link(shareHref, t('share_open'), 'cmp-btn cmp-btn-sm'));
    // The page is a copy taken when it was shared — the conversation may have gone on since.
    dlg.linkNote.textContent = s.vis === 'private' ? t('share_private_fixed') : dlg.snapshot && s.sig && snapshotSig(dlg.snapshot) !== s.sig ? t('share_behind') : t('share_current');
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
    const priv = dlg.share ? dlg.share.vis === 'private' : privateChosen();
    const who = priv || authorMode() === SHARE_AUTHOR_ANON ? t('share_preview_anon') : (dlg.nameInput.value.trim() || t('share_preview_named'));
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
  async function writeShare(sessionId, asked, snapshot, mode, authorName, password) {
    await loadShares();
    const current = shareFor(sessionId);
    // One-click: the link the map holds NOW (under the lock) is the one to update — another tab's included.
    const latest = asked === SHARE_ASK_LATEST;
    if (latest) asked = current;
    if (!asked && current) return { exists: current };
    const autoAuthor = mode === SHARE_AUTHOR_AUTO;
    if (autoAuthor) {
      const [pref, legacyPref] = await Promise.all([readKey(SHARE_AUTHOR_PREF_KEY), readKey(SHARE_AUTHOR_PREF_KEY_V1)]);
      mode = authorFor(asked, pref, legacyPref);
    }
    // `password` (#1784 U5): a NEW private share — handed to the SW once, kept nowhere here.
    const res = await sendMessage(chrome, {
      type: SHARE_MSG_TYPE, op: asked ? SHARE_OP_UPDATE : SHARE_OP_CREATE, ...(asked ? { id: asked.id } : {}),
      snapshot, ...(password ? { visibility: SHARE_VIS_PRIVATE, password } : { author: mode, ...(authorName ? { authorName } : {}) }),
    });
    if (!res || res.ok !== true) {
      const code = res && typeof res.code === 'string' ? res.code : 'network_error';
      // The link was deleted elsewhere (「내 공유 링크」, another browser): forget it here too.
      const gone = !!asked && (code === 'share_deleted' || code === 'not_found');
      if (gone) await forgetShareId(asked.id);
      // One click on a link deleted elsewhere makes a fresh one: the user asked for 「a link」, not that one.
      // A fresh link is a NEW link: an automatic author is decided again (the pick or the default), not the dead link's.
      if (gone && latest) return writeShare(sessionId, null, snapshot, autoAuthor ? SHARE_AUTHOR_AUTO : mode, authorName, password);
      return { error: code, gone };
    }
    // 🔴 Recorded whatever became of the dialog: the link EXISTS on the server now, and closing the
    // dialog mid-request must not leave it unreachable from this conversation (「업데이트 / 삭제」).
    // The visibility the server answered wins (a password set from another browser); else what was asked.
    const priv = res.visibility ? res.visibility === SHARE_VIS_PRIVATE : !!password || (!!asked && asked.vis === SHARE_VIS_PRIVATE);
    const settledAuthor = !priv && res.author && SHARE_AUTHOR_MODES.includes(res.author.mode) ? res.author.mode : SHARE_AUTHOR_ANON;
    // The record keeps who the link shows as: re-sharing an existing link keeps it (linkAuthor), never the new default.
    const record = { id: res.id, title: snapshot.title, updatedAt: clock.now(), kind: snapshot.kind, sig: snapshotSig(snapshot), author: settledAuthor, ...(priv ? { vis: SHARE_VIS_PRIVATE } : {}) };
    // A display name for 「내 공유 링크」 (a private share has no title on the server): the first question.
    const label = (snapshot.title || firstQuestion(snapshot)).split('\n')[0].slice(0, SHARE_TITLE_INPUT_MAX);
    await updateShares((map) => { map[sessionId] = label ? { ...record, label } : record; });
    // The author preference is NOT written here — only an explicit pick is remembered (rememberAuthor).
    const settled = res.author && SHARE_AUTHOR_MODES.includes(res.author.mode) ? res.author.mode : SHARE_AUTHOR_ANON;
    track(asked ? 'share_update' : 'share_create', { kind: snapshot.kind, author: priv ? SHARE_AUTHOR_ANON : mode, settled, focus: snapshot.focus ? 1 : 0, private: priv ? 1 : 0 });
    // A private share never gets a card (its link preview stays the fixed lock image).
    return { record, settled, askedMode: priv ? SHARE_AUTHOR_ANON : mode, author: res.author || { mode: SHARE_AUTHOR_ANON }, updated: !!asked, card: priv || !res.rev ? null : { id: res.id, rev: res.rev, snapshot, author: res.author || { mode: SHARE_AUTHOR_ANON } } };
  }
  /**
   * Best effort, never seen by the user: the share already exists, and without a card its link
   * preview is the fixed image. Drawn from the snapshot that was SENT and the author the server
   * CONFIRMED (never the ask). The renderer is imported lazily, so it failing to load cannot break
   * the dialog.
   */
  async function uploadCard({ id, rev, snapshot, author }) {
    let timer = null;
    const budget = new Promise((resolve) => { timer = clock.setTimeout(resolve, SHARE_CARD_BUDGET_MS); });
    const run = (async () => {
      const { renderShareCard } = await import('./share-card.js');
      const url = shareUrlOf(id);
      const avatarUrl = author.mode === SHARE_AUTHOR_NAME_PHOTO && url ? `${url}/avatar` : null;
      const blob = await renderShareCard(snapshot, { author, avatarUrl, lang: ctx.lang, focus: snapshot.focus });
      if (!blob) return;
      const png = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
      await sendMessage(chrome, { type: SHARE_MSG_TYPE, op: SHARE_OP_IMAGE, id, rev, png });
    })().catch((e) => {
      const con = ctx.con;
      if (con && typeof con.debug === 'function') { try { con.debug('[compare] share card skipped', e); } catch { /* logging is not the share */ } }
    });
    try { await Promise.race([run, budget]); } finally { clock.clearTimeout(timer); }
  }
  /**
   * `write` (a content / password write) under the share lock, the card upload it asks for right
   * after it in the same lock callback. Resolves on the WRITE — the caller settles on that and never
   * waits for the card.
   */
  function writeUnderLock(write) {
    let settle;
    const written = new Promise((resolve) => { settle = resolve; });
    const locked = underShareLock(async () => {
      const w = await write();
      settle(w);
      if (w.card) await uploadCard(w.card);
      return w;
    });
    locked.catch(() => {});
    return Promise.race([written, locked]);
  }
  /** A delete under the share lock (see removeShare); 404 = not ours / already gone — forgotten either way. */
  function deleteLocked(id) {
    return underShareLock(async () => {
      const r = await sendMessage(chrome, { type: SHARE_MSG_TYPE, op: SHARE_OP_DELETE, id });
      if (r && (r.ok === true || r.code === 'not_found')) await forgetShareId(id);
      return r;
    });
  }
  const deleted = (res) => !!res && (res.ok === true || res.code === 'not_found');
  const errCodeOf = (res) => (res && typeof res.code === 'string' ? res.code : res && res.error ? res.error : 'network_error');
  async function submit() {
    // 🔴 The snapshot the preview drew, as it is — see the header.
    const snapshot = dlg.snapshot;
    const entry = dlg.entry;
    if (busy || !entry || !snapshot) return;
    if (state.sessionId !== entry.id) { closeShareDialog(); return; } // the page moved to another conversation
    const my = gen;
    const here = () => my === gen; // still this dialog (not closed / reopened)
    // A private share is never edited (the server answers 409) — not only a hidden button.
    if (dlg.share && dlg.share.vis === 'private') { setError('share_fixed'); return; }
    // A new private share needs a password of SHARE_PASSWORD_MIN..SHARE_PASSWORD_INPUT_MAX code points
    // after NFC — the server's own rule; outside it nothing is sent (never cut to fit).
    const password = !dlg.share && privateChosen() ? dlg.passwordInput.value : '';
    const pwLen = Array.from(password.normalize('NFC')).length;
    if (!dlg.share && privateChosen() && (pwLen < SHARE_PASSWORD_MIN || pwLen > SHARE_PASSWORD_INPUT_MAX)) { setError('bad_password'); dlg.passwordInput.focus(); return; }
    const mode = password ? SHARE_AUTHOR_ANON : authorMode();
    const authorName = !password && mode !== SHARE_AUTHOR_ANON ? dlg.nameInput.value.trim() : '';
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
      // The dialog settles on the content write; the card follows inside the same lock callback.
      out = await writeUnderLock(() => writeShare(entry.id, asked, snapshot, mode, authorName, password));
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
    // Another tab's link is THE link — shown with ITS visibility (a public link must never look locked,
    // Codex U5c 1R), and the password typed for a share that will not be made goes.
    if (out.exists) { dlg.share = out.exists; dlg.passwordInput.value = ''; syncVisibility(); repaintPreview(); paintLink(); setError('exists'); return; }
    if (out.error) {
      if (out.gone) { dlg.share = null; paintLink(); }
      setError(out.error);
      return;
    }
    dlg.share = out.record;
    // The author the SERVER published (no usable name → anonymous): the dialog shows that, not the ask.
    for (const m of SHARE_AUTHOR_MODES) dlg.radios[m].checked = m === out.settled;
    syncNameInput();
    dlg.passwordInput.value = ''; // gone from the page the moment the share exists
    syncVisibility();
    paintLink();
    // The 「no name → anonymous」 note is about a PUBLIC share's author; a private one is anonymous by design.
    if (!password && out.settled !== mode) dlg.linkNote.textContent = t('share_author_fallback');
    if (!password) await rememberAuthor(mode); // the dialog's radios are the user's choice
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
      res = await deleteLocked(id);
    } catch {
      res = null;
    } finally {
      busy = false;
      // A conversation dialog opened while the delete ran came up locked by `busy` (share-ON batch
      // review 2R): give its inputs and button back, as submit's own finally does.
      if (dlg && !dlg.node.hidden && dlg.entry) { lockInputs(false); dlg.submitBtn.disabled = !dlg.snapshot; }
    }
    if (!deleted(res)) {
      setError(errCodeOf(res));
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

  // ── one-click share (SHARE_ONE_CLICK): the click makes / updates the link and copies it; the
  //    popover by the button is only the optional rest (password · author · delete) ──
  let pop = null;
  let popOpener = null; // the element (or {focus, anchor}) the popover belongs to
  function svgIcon(cls, paths) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', width: '14', height: '14', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: cls })) svg.setAttribute(k, v);
    for (const d of paths) {
      const path = doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }
  const lockIcon = () => svgIcon('cmp-sharepop-lock', ['M4.5 7.5h7a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z', 'M5.8 7.5V5.3a2.2 2.2 0 0 1 4.4 0v2.2']);
  function popButton(cls, label) {
    const b = el('button', cls, label);
    b.type = 'button';
    return b;
  }
  function buildPopover() {
    const node = el('div', 'cmp-sharepop');
    node.id = 'cmp-sharepop';
    node.hidden = true;
    node.tabIndex = -1;
    // Non-modal: the page stays usable around it (Esc / a click outside closes it).
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-modal', 'false');
    node.setAttribute('aria-labelledby', 'cmp-sharepop-status');

    const head = el('div', 'cmp-sharepop-head');
    const mark = el('span', 'cmp-sharepop-mark');
    mark.setAttribute('aria-hidden', 'true');
    const status = el('p', 'cmp-sharepop-status');
    status.id = 'cmp-sharepop-status';
    status.setAttribute('role', 'status');
    const close = popButton('cmp-sharepop-close', '×');
    close.setAttribute('aria-label', t('share_close'));
    close.title = t('share_close');
    head.appendChild(mark);
    head.appendChild(status);
    head.appendChild(close);
    node.appendChild(head);
    const sub = el('p', 'cmp-sharepop-sub');
    node.appendChild(sub);

    const linkRow = el('div', 'cmp-sharepop-link');
    const url = el('input', 'cmp-sharepop-url');
    url.type = 'text';
    url.readOnly = true;
    url.setAttribute('aria-label', t('share_link_label'));
    const copyBtn = popButton('cmp-btn cmp-btn-sm cmp-btn-primary cmp-sharepop-copy', t('share_copy'));
    const openSlot = el('span', 'cmp-sharepop-open-slot');
    linkRow.appendChild(url);
    linkRow.appendChild(copyBtn);
    linkRow.appendChild(openSlot);
    node.appendChild(linkRow);

    // 🔒 The password of THIS link: add (public) · change / remove (private).
    const pw = el('div', 'cmp-sharepop-sec cmp-sharepop-pw');
    const pwAdd = popButton('cmp-sharepop-pw-add', '');
    pwAdd.appendChild(lockIcon());
    pwAdd.appendChild(el('span', null, t('share_pw_set')));
    pwAdd.setAttribute('aria-expanded', 'false');
    const pwOn = el('div', 'cmp-sharepop-pw-on');
    const pwOnText = el('span', 'cmp-sharepop-pw-on-text');
    pwOnText.appendChild(lockIcon());
    pwOnText.appendChild(el('span', null, t('share_pw_on')));
    const pwChange = popButton('cmp-btn cmp-btn-sm', t('share_pw_change'));
    pwChange.setAttribute('aria-expanded', 'false');
    const pwRemove = popButton('cmp-btn cmp-btn-sm', t('share_pw_remove'));
    pwOn.appendChild(pwOnText);
    pwOn.appendChild(pwChange);
    pwOn.appendChild(pwRemove);
    const pwForm = el('form', 'cmp-sharepop-pw-form');
    pwForm.noValidate = true;
    const pwRow = el('div', 'cmp-sharepop-pw-row');
    const pwInput = el('input', 'cmp-share-input cmp-sharepop-pw-input');
    pwInput.type = 'password';
    pwInput.autocomplete = 'new-password';
    // No maxLength (it counts UTF-16 units — Codex U5c 1R): the length is checked in code points at save.
    pwInput.placeholder = t('share_password_placeholder');
    pwInput.setAttribute('aria-label', t('share_password_label'));
    const pwSave = el('button', 'cmp-btn cmp-btn-sm cmp-btn-primary', t('share_pw_save'));
    pwSave.type = 'submit';
    const pwCancel = popButton('cmp-btn cmp-btn-sm', t('share_delete_no'));
    pwRow.appendChild(pwInput);
    pwRow.appendChild(pwSave);
    pwRow.appendChild(pwCancel);
    pwForm.appendChild(pwRow);
    pwForm.appendChild(el('p', 'cmp-sharepop-hint', t('share_pw_hint')));
    pw.appendChild(pwAdd);
    pw.appendChild(pwOn);
    pw.appendChild(pwForm);
    node.appendChild(pw);

    // Who it shows as — a public link only (a private one is anonymous by design).
    const author = el('fieldset', 'cmp-sharepop-sec cmp-sharepop-author');
    author.appendChild(el('legend', 'cmp-sharepop-label', t('share_author_label')));
    const seg = el('div', 'cmp-sharepop-seg');
    const radios = {};
    const segLabel = { [SHARE_AUTHOR_ANON]: 'share_author_anon', [SHARE_AUTHOR_NAME]: 'share_author_short_name', [SHARE_AUTHOR_NAME_PHOTO]: 'share_author_short_name_photo' };
    for (const mode of SHARE_AUTHOR_MODES) {
      const lab = el('label', 'cmp-sharepop-seg-opt');
      const r = el('input');
      r.type = 'radio';
      r.name = 'cmp-sharepop-author';
      r.value = mode;
      lab.appendChild(r);
      lab.appendChild(el('span', null, t(segLabel[mode])));
      seg.appendChild(lab);
      radios[mode] = r;
    }
    author.appendChild(seg);
    const who = el('p', 'cmp-sharepop-note');
    author.appendChild(who);
    node.appendChild(author);

    const error = el('p', 'cmp-sharepop-error');
    error.setAttribute('role', 'alert');
    node.appendChild(error);

    const foot = el('div', 'cmp-sharepop-foot');
    const scope = el('p', 'cmp-sharepop-scope');
    const actions = el('div', 'cmp-sharepop-actions');
    const deleteBtn = popButton('cmp-sharepop-textbtn cmp-sharepop-delete', t('share_delete_link'));
    const mineBtn = popButton('cmp-sharepop-textbtn cmp-sharepop-mine', t('share_mine'));
    actions.appendChild(deleteBtn);
    actions.appendChild(mineBtn);
    const confirm = el('div', 'cmp-sharepop-confirm');
    confirm.appendChild(el('p', 'cmp-sharepop-confirm-text', t('share_delete_confirm_short')));
    const confirmNo = popButton('cmp-btn cmp-btn-sm', t('share_delete_no'));
    const confirmYes = popButton('cmp-btn cmp-btn-sm cmp-share-delete cmp-sharepop-delete-yes', t('share_delete_yes'));
    confirm.appendChild(confirmNo);
    confirm.appendChild(confirmYes);
    foot.appendChild(scope);
    foot.appendChild(actions);
    foot.appendChild(confirm);
    node.appendChild(foot);

    close.addEventListener('click', () => closePop(true));
    copyBtn.addEventListener('click', async () => {
      if (!url.value) return;
      const copied = await ctx.copyText(url.value);
      if (!copied) return;
      track('share_copy', { kind: pop.snapshot ? pop.snapshot.kind : 'compare', from: 'popover' });
      pop.statusKey = 'share_pop_copied';
      copyBtn.textContent = t('copied');
      clock.setTimeout(() => { copyBtn.textContent = t('share_copy'); }, COPY_FEEDBACK_MS);
      paintPop();
    });
    const editPassword = (on) => {
      pop.pwEditing = on;
      pwInput.value = '';
      setPopError(null);
      paintPop();
      if (on) pwInput.focus();
      else (pop.share && pop.share.vis === SHARE_VIS_PRIVATE ? pwChange : pwAdd).focus();
    };
    pwAdd.addEventListener('click', () => editPassword(true));
    pwChange.addEventListener('click', () => editPassword(true));
    pwCancel.addEventListener('click', () => editPassword(false));
    pwForm.addEventListener('submit', (e) => { e.preventDefault(); savePassword(pwInput.value); });
    pwRemove.addEventListener('click', () => savePassword(null));
    for (const r of Object.values(radios)) r.addEventListener('change', () => { if (r.checked) changeAuthor(r.value); });
    deleteBtn.addEventListener('click', () => { pop.confirming = true; paintPop(); confirmNo.focus(); });
    confirmNo.addEventListener('click', () => { pop.confirming = false; paintPop(); deleteBtn.focus(); });
    confirmYes.addEventListener('click', deletePop);
    mineBtn.addEventListener('click', () => { const from = popOpener; closePop(false); openMyShares(from); });
    // Esc backs out of an inline step first (password entry, delete confirm), then closes.
    doc.addEventListener('keydown', (e) => {
      if (!e || e.key !== 'Escape' || node.hidden) return;
      e.preventDefault();
      if (pop.confirming) { pop.confirming = false; paintPop(); deleteBtn.focus(); return; }
      if (pop.pwEditing) { editPassword(false); return; }
      closePop(true);
    });
    // A click outside closes it — except on its own 「공유」 button, whose click shares again.
    doc.addEventListener('pointerdown', (e) => {
      if (node.hidden || !e.target || node.contains(e.target)) return;
      const own = openerEl();
      if (own && own.contains(e.target)) return;
      closePop(false);
    });
    if (ctx.win && typeof ctx.win.addEventListener === 'function') ctx.win.addEventListener('resize', () => placePop());
    doc.addEventListener('scroll', () => placePop(), true);
    ctx.root.appendChild(node);
    return {
      node, mark, status, close, sub, linkRow, url, copyBtn, openSlot, pw, pwAdd, pwOn, pwChange, pwRemove, pwForm, pwInput, pwSave,
      author, radios, who, error, foot, scope, actions, deleteBtn, mineBtn, confirm, confirmYes,
      phase: 'working', statusKey: '', subKey: '', askedAuthor: null, share: null, sessionId: null, snapshot: null, settled: SHARE_AUTHOR_ANON, authorName: '', fallback: false, pwEditing: false, confirming: false,
    };
  }
  /** The element the popover hangs from: 「⋯」 while the bar is folded (shareOpener.anchor), else the button. */
  function anchorEl() {
    const a = popOpener && typeof popOpener.anchor === 'function' ? popOpener.anchor() : popOpener;
    return a && typeof a.getBoundingClientRect === 'function' ? a : null;
  }
  /** The 「공유」 button that opened it (a bubble's, or the topbar's). */
  const openerEl = () => (popOpener && typeof popOpener.getBoundingClientRect === 'function' ? popOpener : ctx.shareBtn || null);
  function setPopError(code) {
    pop.error.textContent = code ? t(SHARE_ERR_CODES.includes(code) ? `share_err_${code}` : 'share_err_generic') : '';
    pop.error.hidden = !code;
  }
  function paintPop() {
    if (!pop) return;
    const s = pop.phase === 'ready' ? pop.share : null;
    const href = s ? shareUrlOf(s.id) : null;
    const priv = !!s && s.vis === SHARE_VIS_PRIVATE;
    pop.node.dataset.phase = pop.phase;
    pop.node.setAttribute('aria-busy', String(busy));
    pop.status.textContent = pop.statusKey ? t(pop.statusKey) : '';
    pop.sub.textContent = pop.subKey ? t(pop.subKey) : '';
    pop.sub.hidden = !pop.subKey;
    pop.linkRow.hidden = !href;
    pop.url.value = href || '';
    clear(pop.openSlot);
    if (href) pop.openSlot.appendChild(ctx.link(href, t('share_open'), 'cmp-btn cmp-btn-sm'));
    pop.pw.hidden = !href;
    pop.pwAdd.hidden = priv || pop.pwEditing;
    pop.pwOn.hidden = !priv || pop.pwEditing;
    pop.pwForm.hidden = !pop.pwEditing;
    pop.pwAdd.setAttribute('aria-expanded', String(pop.pwEditing));
    pop.pwChange.setAttribute('aria-expanded', String(pop.pwEditing));
    pop.author.hidden = !href || priv;
    // While an author change is on the wire the choice shows what was picked; then what the server settled.
    const shownAuthor = busy && pop.askedAuthor ? pop.askedAuthor : pop.settled;
    for (const m of SHARE_AUTHOR_MODES) pop.radios[m].checked = m === shownAuthor;
    const whoText = pop.fallback ? t('share_author_fallback_pop') : pop.settled !== SHARE_AUTHOR_ANON && pop.authorName ? t('share_author_shown_as', pop.authorName) : '';
    pop.who.textContent = whoText;
    pop.who.hidden = !whoText;
    pop.foot.hidden = !href;
    pop.scope.textContent = t(priv ? 'share_scope_private' : 'share_scope_public');
    pop.actions.hidden = pop.confirming;
    pop.confirm.hidden = !pop.confirming;
    // Nothing is pressed twice while a write runs; the inputs of that write are already taken.
    for (const b of [pop.copyBtn, pop.pwAdd, pop.pwChange, pop.pwRemove, pop.pwSave, pop.pwInput, pop.deleteBtn, pop.confirmYes, ...Object.values(pop.radios)]) b.disabled = busy;
    placePop();
  }
  /** Fixed, under (or, without room, above) its button; clamped inside the window with a gutter. */
  function placePop() {
    const win = ctx.win;
    if (!pop || pop.node.hidden || !win) return;
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const width = Math.max(0, Math.min(POP_WIDTH_PX, vw - 2 * POP_GUTTER_PX));
    pop.node.style.width = `${width}px`;
    pop.node.style.maxHeight = `${Math.max(0, vh - 2 * POP_GUTTER_PX)}px`;
    const a = anchorEl();
    let r = a ? a.getBoundingClientRect() : null;
    // The button is off screen (a folded bar, a scrolled-away bubble): the top-right corner.
    if (!r || (!r.width && !r.height)) r = { top: POP_GUTTER_PX, bottom: POP_GUTTER_PX, right: vw - POP_GUTTER_PX };
    const h = pop.node.offsetHeight;
    const left = Math.min(Math.max(r.right - width, POP_GUTTER_PX), vw - width - POP_GUTTER_PX);
    let top = r.bottom + POP_GAP_PX;
    if (top + h > vh - POP_GUTTER_PX && r.top - POP_GAP_PX - h >= POP_GUTTER_PX) top = r.top - POP_GAP_PX - h;
    // Always inside the window — the button may be scrolled partly or wholly out of it.
    top = Math.min(Math.max(top, POP_GUTTER_PX), Math.max(POP_GUTTER_PX, vh - POP_GUTTER_PX - h));
    pop.node.style.left = `${Math.round(Math.max(POP_GUTTER_PX, left))}px`;
    pop.node.style.top = `${Math.round(top)}px`;
    pop.node.classList.toggle('is-above', top < r.top);
  }
  function showPop(from) {
    if (popOpener && popOpener !== from && typeof popOpener.setAttribute === 'function') popOpener.setAttribute('aria-expanded', 'false');
    popOpener = from || ctx.shareBtn || null;
    const own = openerEl();
    if (own) own.setAttribute('aria-expanded', 'true');
    const wasOpen = !pop.node.hidden;
    pop.node.hidden = false;
    if (!wasOpen) {
      // Replay the entrance each time it opens (CSS; prefers-reduced-motion turns it off).
      pop.node.classList.remove('is-in');
      void pop.node.offsetWidth;
      pop.node.classList.add('is-in');
    }
    paintPop();
    try { pop.node.focus({ preventScroll: true }); } catch { /* focus is a nicety */ }
  }
  function closePop(returnFocus) {
    if (!pop || pop.node.hidden) return;
    gen++; // a click still in flight settles into the map, never into a closed popover
    pop.pwInput.value = ''; // a password typed and abandoned must not stay in the page (Codex U5c 1R)
    pop.pwEditing = false;
    pop.confirming = false;
    pop.node.hidden = true;
    const own = openerEl();
    if (own) own.setAttribute('aria-expanded', 'false');
    if (returnFocus && popOpener && typeof popOpener.focus === 'function') { try { popOpener.focus(); } catch { /* gone */ } }
    popOpener = null;
  }
  /**
   * The click. 🔴 U3 invariants: every input of the write (conversation, focus, author) is taken
   * HERE; the create-or-update decision and the write run under the share lock (writeShare with
   * SHARE_ASK_LATEST reads the map there); the link is recorded in the map whatever became of the
   * popover.
   */
  async function shareNow(focus, from) {
    if (!shareable() || busy) return;
    if (!pop) pop = buildPopover();
    if (dlg && !dlg.node.hidden) closeShareDialog();
    const my = ++gen;
    const entry = currentEntry();
    if (!entry) return;
    const stillHere = () => gen === my && state.sessionId === entry.id; // not closed, not clicked again, same conversation
    // Both reads start at the click (the author preference another tab may change meanwhile — Codex ui 1R).
    const [, pref, legacyPref] = await Promise.all([loadShares(), readKey(SHARE_AUTHOR_PREF_KEY), readKey(SHARE_AUTHOR_PREF_KEY_V1)]);
    if (!stillHere()) return;
    const known = shareFor(entry.id);
    const mode = authorFor(known, pref, legacyPref); // a new link: the pick, else name + photo (2026-09-28); an existing one: as it is
    const built = build(entry, known ? known.title : '', focus);
    Object.assign(pop, { sessionId: entry.id, share: null, snapshot: built.error ? null : built.snapshot, settled: mode, authorName: '', fallback: false, pwEditing: false, confirming: false, subKey: '' });
    setPopError(null);
    if (built.error) {
      Object.assign(pop, { phase: 'error', statusKey: 'share_pop_failed' });
      showPop(from);
      setPopError(built.error);
      return;
    }
    const snapshot = built.snapshot;
    Object.assign(pop, { phase: 'working', statusKey: known ? 'share_pop_updating' : 'share_pop_working' });
    busy = true;
    showPop(from);
    track('share_open', { kind: snapshot.kind, focus: focus ? 1 : 0, existing: known ? 1 : 0, one_click: 1 });
    let out;
    try {
      out = await writeUnderLock(() => writeShare(entry.id, SHARE_ASK_LATEST, snapshot, SHARE_AUTHOR_AUTO, '', ''));
    } catch {
      out = { error: 'generic' };
    } finally {
      busy = false;
    }
    syncShareButton();
    if (gen !== my) return;
    if (out.error) {
      Object.assign(pop, { phase: 'error', statusKey: 'share_pop_failed' });
      paintPop();
      setPopError(out.error);
      return;
    }
    // The fallback note compares with the author decided under the lock, not the guess shown while waiting.
    Object.assign(pop, { phase: 'ready', share: out.record, settled: out.settled, authorName: out.author.name || '', fallback: out.askedMode !== SHARE_AUTHOR_ANON && out.settled !== out.askedMode });
    const copied = await ctx.copyText(shareUrlOf(out.record.id));
    if (gen !== my) return;
    if (copied) track('share_copy', { kind: snapshot.kind, from: 'one_click' });
    Object.assign(pop, { statusKey: copied ? 'share_pop_copied' : 'share_pop_made', subKey: out.updated ? 'share_pop_updated' : '' });
    const focusWasOnPop = doc.activeElement === pop.node;
    paintPop();
    // Copy failed (no clipboard access): the copy button is the next thing to press.
    if (focusWasOnPop && !copied) pop.copyBtn.focus();
  }
  /**
   * 🔒 Set / change (a string) or remove (null) the password of the popover's link. The typed
   * password is read once, handed to the SW, and cleared from the field before the request.
   */
  async function savePassword(password) {
    if (busy || !pop || !pop.share) return;
    if (password !== null) {
      const n = Array.from(String(password).normalize('NFC')).length;
      if (n < SHARE_PASSWORD_MIN || n > SHARE_PASSWORD_INPUT_MAX) { setPopError('bad_password'); pop.pwInput.focus(); return; }
    }
    pop.pwInput.value = '';
    const my = gen;
    // Taken at the click, never read inside the lock callback (U3).
    const { sessionId, share: base, snapshot } = pop;
    const wasPrivate = base.vis === SHARE_VIS_PRIVATE;
    busy = true;
    setPopError(null);
    paintPop();
    let out;
    try {
      out = await writeUnderLock(() => writePassword(sessionId, base, password, snapshot));
    } catch {
      out = { error: 'generic' };
    } finally {
      busy = false;
    }
    syncShareButton();
    if (gen !== my) return;
    if (out.error) {
      if (out.gone) Object.assign(pop, { phase: 'deleted', share: null, statusKey: 'share_pop_deleted', subKey: '', pwEditing: false });
      paintPop();
      setPopError(out.error);
      return;
    }
    const priv = out.vis === SHARE_VIS_PRIVATE;
    Object.assign(pop, {
      share: out.record, pwEditing: false, subKey: password === null ? 'share_pw_done_remove' : wasPrivate ? 'share_pw_done_change' : 'share_pw_done_set',
      // Either way the link is anonymous now (a private share always; a reopened one stays so until picked).
      settled: SHARE_AUTHOR_ANON, authorName: '', fallback: false,
    });
    paintPop();
    if (pop.node.contains(doc.activeElement) || doc.activeElement === doc.body) (priv ? pop.pwChange : pop.pwAdd).focus();
  }
  /**
   * Under the lock: has this conversation's link been written since `base` (the popover's record)?
   * Another tab's click — or the link gone / replaced. Read fresh from the map.
   */
  async function linkMovedOn(sessionId, base) {
    await loadShares();
    const cur = shareFor(sessionId);
    return !cur || !base || cur.id !== base.id || cur.updatedAt !== base.updatedAt;
  }
  /** Under the lock: the request, then the map. `base` = the popover's record at the click. */
  async function writePassword(sessionId, base, password, snapshot) {
    const { id } = base;
    // Only a snapshot that is still the link's content may become its card (see linkMovedOn).
    const cardSnapshot = snapshot && !(await linkMovedOn(sessionId, base)) ? snapshot : null;
    const r = await sendMessage(chrome, { type: SHARE_MSG_TYPE, op: SHARE_OP_PASSWORD, id, password });
    if (!r || r.ok !== true) {
      const code = errCodeOf(r);
      const gone = code === 'share_deleted' || code === 'not_found';
      if (gone) await forgetShareId(id);
      return { error: code, gone };
    }
    const vis = r.visibility === SHARE_VIS_PRIVATE ? SHARE_VIS_PRIVATE : SHARE_VIS_PUBLIC;
    const withVis = (rec) => {
      // Setting or removing a password leaves the link anonymous on the server (a reopened link stays so until picked).
      const next = { ...rec, author: SHARE_AUTHOR_ANON };
      if (vis === SHARE_VIS_PRIVATE) next.vis = vis;
      else delete next.vis;
      return next;
    };
    let record = null;
    await updateShares((map) => {
      for (const k of Object.keys(map)) if (map[k].id === id) record = map[k] = withVis(map[k]);
    });
    track('share_password', { action: password === null ? 'remove' : 'set', private: vis === SHARE_VIS_PRIVATE ? 1 : 0 });
    // Public again: the server dropped every card with the password, so this revision gets a fresh one.
    const card = vis === SHARE_VIS_PUBLIC && r.rev && cardSnapshot ? { id, rev: r.rev, snapshot: cardSnapshot, author: { mode: SHARE_AUTHOR_ANON } } : null;
    return { vis, card, record: record || withVis(base) };
  }
  /**
   * The author to send for this conversation's share: an EXISTING link keeps who it shows as now — the
   * record's author, or for a record from before it was kept, what the old preference said (that is what
   * re-sharing sent then), else anonymous. Only a NEW link takes the user's pick or the default. Re-sharing
   * never widens a link's exposure (Codex share-default 1R: a link anonymous after a password was set and
   * removed came back as name + photo on the next 「공유」).
   */
  function authorFor(known, pref, legacyPref) {
    if (known) {
      if (SHARE_AUTHOR_MODES.includes(known.author)) return known.author;
      return SHARE_AUTHOR_MODES.includes(legacyPref) ? legacyPref : SHARE_AUTHOR_ANON;
    }
    return SHARE_AUTHOR_MODES.includes(pref) ? pref : SHARE_AUTHOR_DEFAULT;
  }
  /** An author the user picked (not a default) is the one preselected next time. */
  const rememberAuthor = (mode) => (SHARE_AUTHOR_MODES.includes(mode) ? writeKey(SHARE_AUTHOR_PREF_KEY, mode) : Promise.resolve());
  /** Who the link shows as: the same link, updated with the snapshot of the click — the server settles the author. */
  async function changeAuthor(mode) {
    if (busy || !pop || !pop.share || !pop.snapshot || mode === pop.settled || !SHARE_AUTHOR_MODES.includes(mode)) return;
    const my = gen;
    const { sessionId, snapshot, share: base } = pop;
    busy = true;
    pop.askedAuthor = mode;
    setPopError(null);
    paintPop();
    let out;
    try {
      // The snapshot re-sent is the popover's — never over a newer write of the same link (another
      // tab's 「공유」 after a follow-up): its content would be rolled back (Codex ui 1R).
      out = await writeUnderLock(async () => (await linkMovedOn(sessionId, base)) ? { error: 'stale' } : writeShare(sessionId, SHARE_ASK_LATEST, snapshot, mode, '', ''));
    } catch {
      out = { error: 'generic' };
    } finally {
      busy = false;
      pop.askedAuthor = null;
    }
    syncShareButton();
    if (gen !== my) return;
    if (out.error) { paintPop(); setPopError(out.error); return; }
    Object.assign(pop, { share: out.record, settled: out.settled, authorName: out.author.name || '', fallback: mode !== SHARE_AUTHOR_ANON && out.settled !== mode, subKey: '' });
    await rememberAuthor(mode); // the popover's choice is the user's
    paintPop();
  }
  async function deletePop() {
    const id = pop && pop.share ? pop.share.id : null;
    if (busy || !id) return;
    const my = gen;
    busy = true;
    setPopError(null);
    paintPop();
    let res;
    try {
      res = await deleteLocked(id);
    } catch {
      res = null;
    } finally {
      busy = false;
    }
    syncShareButton();
    if (gen !== my) return;
    pop.confirming = false;
    if (!deleted(res)) { paintPop(); setPopError(errCodeOf(res)); return; }
    track('share_delete', { from: 'popover' });
    Object.assign(pop, { phase: 'deleted', share: null, statusKey: 'share_pop_deleted', subKey: '', pwEditing: false });
    paintPop();
    try { pop.node.focus({ preventScroll: true }); } catch { /* focus is a nicety */ }
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
    // A private share has no title on the server (it would show before the password): this browser's record names it.
    await loadShares();
    if (my !== mineSeq || dlg.node.hidden || dlg.mine.hidden) return;
    const localTitle = (id) => { const v = Object.values(state.shares).find((r) => r.id === id); return v ? v.title || v.label || '' : ''; };
    for (const s of res.shares) {
      // The link is spelled here from the id (the SW's `url` is not trusted as an href).
      const shareHref = shareUrlOf(s.id);
      if (!shareHref) continue;
      const row = el('div', 'cmp-share-mine-row');
      row.appendChild(ctx.link(shareHref, s.title || localTitle(s.id) || t(s.kind === 'debate' ? 'share_kind_debate' : 'share_kind_compare'), 'cmp-share-mine-title'));
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
