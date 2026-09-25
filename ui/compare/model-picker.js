// ui/compare/model-picker.js — the MODEL slice of mountComparePage() (compare.js): the column
// head's two popovers (2026-09-21 user decision, split by place — the SERVICE list behind the ▾
// after the name, pre-session, replacing the column; the MODEL list behind the 「Auto ▾」 face,
// Auto + the column's own provider's catalog, re-keying a pre-session column / moving only the
// model in session), the model select and its hint, MODELS from the SW, and the `models` map /
// csv a send carries. The ONE popover element and its keydown listener stay in compare.js
// (attached to ctx); `state.pickerKind` says which list it holds. ctx contract: see ui/compare/history.js.

import { COMPARE_PROVIDERS, colIdOf, parseColId, PROVIDER_META, MODELS_CSV_AUTO, MODELS_CSV_ID_MAX, MODEL_ID_RE, MODEL_AUTO_VALUE } from './constants.js';
import { CHATGPT_EFFORT_SEPARATOR, isChatgptWorkSlug, parseChatgptModelId } from '../../vendor-ai/models.js';
import { modelOptionText } from './helpers.js';

/** Installs the model-picker slice onto `ctx` (ctx contract: ui/compare/history.js header). */
export function installModelPicker(ctx) {
  const { t, state, track, el, clear, dot } = ctx;
  // The column whose picker is open, by REFERENCE: a pre-session pick re-keys the column's id, so an
  // id lookup at close time would miss the opener (aria-expanded / the picking class stuck — Codex
  // integration #3). `state.pickerFor` (its id) follows a re-key too, for the toggle.
  ctx.pickerCol = null; // a `let` shared with the outside-click listener in compare.js → a ctx field
  // The button that opened the list (the column's serviceBtn or pickerBtn, by REFERENCE too): the
  // outside-click closer treats it as inside, Escape / a pick hand the focus back to it.
  ctx.pickerOpener = null;
  const SERVICE_POP_CLASS = 'is-service'; // on the popover while it holds the service list (compare.css: narrower)
  function closePicker() {
    const col = ctx.pickerCol;
    const opener = ctx.pickerOpener;
    ctx.pickerCol = null;
    ctx.pickerOpener = null;
    state.pickerFor = null;
    state.pickerKind = null;
    ctx.picker.hidden = true;
    clear(ctx.picker);
    if (ctx.picker.classList) ctx.picker.classList.remove(SERVICE_POP_CLASS);
    if (ctx.picker.parentNode !== ctx.columnsBox) ctx.columnsBox.appendChild(ctx.picker); // back to its parking place
    if (opener) opener.setAttribute('aria-expanded', 'false');
    if (col && col.node.classList) col.node.classList.remove(ctx.PICKING_CLASS);
  }
  function togglePicker(colId) {
    if (state.pickerFor === colId && state.pickerKind === 'model') { closePicker(); return; }
    openPicker(colId);
  }
  function toggleServicePicker(colId) {
    if (state.pickerFor === colId && state.pickerKind === 'service') { closePicker(); return; }
    openServicePicker(colId);
  }
  /** The service ▾ after the name: pre-session only (a thread belongs to its conversation), inert while a send is in flight. */
  function syncServiceButton(col) {
    col.serviceBtn.hidden = state.sessionStarted;
    col.serviceBtn.disabled = state.sending;
  }
  /** Shared by both lists: the popover under `col`'s head, opened by `opener`, holding `kind`. */
  function showPicker(col, opener, kind, label) {
    closePicker();
    state.pickerFor = col.id;
    state.pickerKind = kind;
    ctx.pickerCol = col;
    ctx.pickerOpener = opener;
    opener.setAttribute('aria-expanded', 'true');
    ctx.picker.setAttribute('aria-label', label);
    if (kind === 'service' && ctx.picker.classList) ctx.picker.classList.add(SERVICE_POP_CLASS);
  }
  /** After the list is filled: under the column's head, inside the page (the columns grid is the reference); focus on `first`. */
  function placePicker(col, first) {
    if (typeof col.node.appendChild === 'function') col.node.appendChild(ctx.picker);
    if (col.node.classList) col.node.classList.add(ctx.PICKING_CLASS); // the card stops clipping so the list can hang below it
    ctx.picker.hidden = false;
    if (first) ctx.focusQuietly(first);
  }
  /**
   * The SERVICE list (2026-09-21): the three services, the column's own marked. Only the
   * (provider, model) PAIR is unique on the page — the service itself is always selectable (user
   * correction: 「Sonnet · Opus · Fable 비교」 = three Claude columns): choosing `p` lands on `p:auto`
   * when that is free, else on the FIRST catalog model of `p` not on the page yet (columnChoices
   * order; an alias of auto counts as present); only when every model of `p` is already a column
   * is the service disabled. The column is replaced in place (chooseColumn), the focus lands on
   * the fresh column's ▾.
   */
  function openServicePicker(colId) {
    const col = state.columns.get(colId);
    if (!col || col.id !== colId || state.sessionStarted) return;
    showPicker(col, col.serviceBtn, 'service', t('col_service_title'));
    const choices = ctx.columnChoices();
    let first = null;
    for (const p of COMPARE_PROVIDERS) {
      const own = choices.filter((c) => c.provider === p); // Auto first, then the catalog
      const target = own.find((c) => !c.present) || null; // `p:auto` when free, else the first free model
      const free = target !== null;
      const current = p === col.provider;
      const opt = el('button', 'cmp-col-picker-opt');
      opt.type = 'button';
      opt.setAttribute('role', 'option');
      opt.setAttribute('data-provider', p);
      opt.setAttribute('data-choice', current ? col.id : free ? target.id : colIdOf(p, null)); // what a pick would land on
      opt.appendChild(dot(p));
      opt.appendChild(el('span', 'cmp-col-picker-text', PROVIDER_META[p].label));
      opt.setAttribute('aria-selected', current ? 'true' : 'false');
      if (current) opt.classList.add('is-current');
      opt.disabled = !free && !current; // every (p, model) is already a column
      if (!free && !current) opt.title = t('col_picker_dup');
      opt.addEventListener('click', () => {
        if (opt.disabled) return;
        if (current) { closePicker(); ctx.focusQuietly(col.serviceBtn); return; } // the same service: nothing to change
        const from = col.provider;
        if (!ctx.chooseColumn(state.pickerFor, { provider: p, model: target.model })) return;
        closePicker();
        track('provider_change', { from, to: p, model: target.model == null ? '' : String(target.model) });
        const landed = state.columns.get(target.id);
        if (landed && landed.id === target.id) ctx.focusQuietly(landed.serviceBtn);
      });
      ctx.picker.appendChild(opt);
      if (!first && !opt.disabled) first = opt;
    }
    placePicker(col, first);
  }
  /**
   * 🔴 A ChatGPT conversation has a MODE, fixed when it is created (package v0.12.0, measured live
   * 2026-09-25): a Work model sent into a Chat conversation is answered by `gpt-5-6`, a Chat model
   * into a Work one by `gpt-5.6-sol-wm` — silently. So in session a column only offers models of
   * its own mode; the other mode needs a new conversation. (The package refuses the send too; this
   * is so the user never gets as far as an error.)
   */
  const isWorkValue = (v) => v != null && v !== MODEL_AUTO_VALUE && isChatgptWorkSlug(parseChatgptModelId(String(v)).slug);
  /**
   * The thread's mode is what ANSWERED — not the model the column asked for (Codex ext 1R): a
   * conversation continued from a link has no known mode, and a Work conversation asked with a
   * Chat model answers with `gpt-5.6-sol-wm`. Read from the latest answer turn that recorded its
   * model, not from `col.servedModel`: that one is reset every round, so a round that failed before
   * its model arrived would forget the mode (Codex ext 2R). Turns survive rounds and restores.
   * Before any answer, the column's own model is all there is.
   */
  function threadIsWork(col) {
    for (let i = col.turns.length - 1; i >= 0; i--) {
      const turn = col.turns[i];
      if (turn.role === 'assistant' && turn.model && turn.model.id != null) return isWorkValue(turn.model.id);
    }
    return isWorkValue(col.model);
  }
  function crossesMode(col, value) {
    return state.sessionStarted && col.provider === 'chatgpt' && isWorkValue(value) !== threadIsWork(col);
  }
  /**
   * 🔴 Put the column's model back in its thread's mode once the thread says which it is (1.35.0
   * batch review — #1661 × #1673): a conversation continued from a link can turn out to be Work
   * only when its answer arrives (asked with Pro, answered by `gpt-5.6-sol-wm`), and a restored one
   * only once its turns are back. The picker gate stops a new pick; this moves the pick the column
   * ALREADY holds, which would otherwise go out with the next follow-up.
   */
  function reconcileMode(col) {
    if (col && crossesMode(col, col.model == null ? MODEL_AUTO_VALUE : String(col.model))) renderModelSelect(col);
  }
  /** In-session pick = the model select's own change (the select is the state; the picker its face). */
  function pickSessionModel(colId, value) {
    const col = state.columns.get(colId);
    if (!col || col.id !== colId || !state.sessionStarted || col.modelSelect.disabled) return;
    if (![...col.modelSelect.querySelectorAll('option')].some((o) => o.value === value)) return;
    if (col.modelSelect.value === value) return;
    col.modelSelect.value = value;
    applyModelPick(col);
  }
  /** The user's own model pick on this page — from the select's change or the in-session picker. */
  function applyModelPick(col) {
    // Every in-session pick lands here (the popover and the select's own change): a pick across the
    // conversation's mode is put back, never applied.
    if (crossesMode(col, col.modelSelect.value)) {
      col.modelSelect.value = col.model == null ? MODEL_AUTO_VALUE : String(col.model);
      return;
    }
    col.modelTouched = true; // renderModelSelect keeps it over the stored seed
    setColumnModel(col, col.modelSelect.value === MODEL_AUTO_VALUE ? null : col.modelSelect.value);
    renderPickerLabel(col); // in-session: the id stays, the face follows the model
    if (state.sessionStarted) ctx.renderFollowupTargets(); // the routing box label = colLabel(col), which names the model
    col.autoRetried = false; ctx.renderColumnActions(col); // a new choice may be offered the Auto retry again (C3)
    track('model_change', { provider: col.provider, col: gaCol(col), model: col.model == null ? '' : String(col.model) });
  }
  /**
   * In-session face (cmp-columns §0): the column's own provider only, its catalog models as the
   * hidden model select lists them; a pick goes THROUGH the select's change handler (one path for
   * modelTouched / the Auto retry reset / GA), so the colId stays and only `model` moves.
   */
  function sessionChoices(col) {
    return [...col.modelSelect.querySelectorAll('option')].map((o) => ({ id: col.id, provider: col.provider, model: o.value === MODEL_AUTO_VALUE ? null : o.value, value: o.value, label: o.textContent, present: false }));
  }
  /**
   * The MODEL list: THIS column's provider only, in both phases (2026-09-21 — another service is
   * the service picker's job, so no vendor title above the single list). Pre-session the choices
   * are columnChoices() cut to the provider (`present` marks a (provider, model) the page already
   * shows; a pick re-keys through chooseColumn); in session the select's own options (a pick
   * moves only the model, pickSessionModel).
   */
  function openPicker(colId) {
    const col = state.columns.get(colId);
    if (!col || col.id !== colId || (state.sessionStarted && !col.modelKnown)) return;
    showPicker(col, col.pickerBtn, 'model', t('col_picker_title'));
    const inSession = state.sessionStarted;
    const choices = (inSession ? sessionChoices(col) : ctx.columnChoices()).filter((x) => x.provider === col.provider);
    let first = null;
    for (const c of choices) {
      const opt = el('button', 'cmp-col-picker-opt', c.label);
      opt.type = 'button';
      opt.setAttribute('role', 'option');
      opt.setAttribute('data-choice', c.id);
      const current = inSession ? c.value === col.modelSelect.value : c.id === col.id;
      opt.setAttribute('aria-selected', current ? 'true' : 'false');
      const otherMode = inSession && crossesMode(col, c.value);
      opt.disabled = (c.present && !current) || otherMode; // a combo the page already shows / the other mode
      if (c.present && !current) opt.title = t('col_picker_dup');
      else if (otherMode) opt.title = t('col_picker_other_mode');
      opt.addEventListener('click', () => {
        if (opt.disabled) return;
        const picked = inSession ? (pickSessionModel(state.pickerFor, c.value), true) : ctx.chooseColumn(state.pickerFor, c);
        if (!picked) return;
        closePicker();
        // Focus returns to the model face of the column now carrying the choice (the same column, re-keyed pre-session).
        const landed = state.columns.get(c.id);
        if (landed && landed.id === c.id) ctx.focusQuietly(landed.pickerBtn);
      });
      ctx.picker.appendChild(opt);
      if (!first && !opt.disabled) first = opt;
    }
    placePicker(col, first);
  }
  /** The picker button's face: dot-less (the head has the dot) — the model label, or 「Auto」. */
  function renderPickerLabel(col) {
    const caret = col.pickerBtn.querySelector('.cmp-col-picker-caret');
    clear(col.pickerBtn);
    col.pickerBtn.appendChild(el('span', 'cmp-col-picker-text', ctx.modelLabelOf(col.provider, col.model) || t('col_picker_auto')));
    if (caret) col.pickerBtn.appendChild(caret); else col.pickerBtn.appendChild(el('span', 'cmp-col-picker-caret', '▾'));
  }
  /**
   * A column's model changes. Before the session the column IS its (provider, model) — the id
   * follows (re-keyed in the map, the DOM attribute; the routing set is empty then); once the
   * session started the id is fixed (the SW keys its client by it) and only the model the next
   * send carries changes — as the model select always worked.
   */
  function setColumnModel(col, model) {
    col.model = model == null ? null : String(model);
    if (state.sessionStarted) return;
    const next = colIdOf(col.provider, col.model);
    if (next === col.id) return;
    if (state.columns.has(next) && state.columns.get(next) !== col) return; // a duplicate: the id stays — the picker refuses this before it gets here
    state.columns.delete(col.id);
    state.columnIds = state.columnIds.map((id) => (id === col.id ? next : id));
    if (state.pickerFor === col.id) state.pickerFor = next; // the open picker follows its column
    col.id = next;
    col.node.setAttribute('data-col', next);
    state.columns.set(next, col);
    renderPickerLabel(col);
    ctx.saveLayout();
  }
  /**
   * Model catalog for a column (addendum): options from status.models[provider]; the selected value
   * is the user's choice this page load, else status.selectedModels[provider], else the catalog's
   * default entry, else the first. No / empty catalog → the pill is hidden and no `models` entry is
   * sent for that provider (the SW uses the provider's default).
   */
  function renderModelSelect(col) {
    const st = state.status || {};
    const list = st.models && Array.isArray(st.models[col.provider]) ? st.models[col.provider].filter((m) => m && typeof m === 'object') : [];
    const sel = col.modelSelect;
    if (!list.length) {
      col.modelWrap.hidden = true;
      clear(sel);
      col.modelKnown = false;
      return;
    }
    const toValue = (id) => (id == null ? MODEL_AUTO_VALUE : String(id));
    const known = new Set(list.map((m) => toValue(m.id)));
    // 🔴 A model id from before the catalog carried power stops (package v0.11.0): a stored
    // `gpt-5-6-thinking` is no row any more — its rows are `gpt-5-6-thinking__standard` / `__extended`
    // / `__max`. Without this the user's Thinking choice fell back to the default (Instant),
    // silently. It is carried to the FIRST row of the same model, which in the site's slider order
    // is its lowest stop (Medium) — what the plain slug always sent (no effort = the site's default).
    const carry = (id) => {
      if (id == null || known.has(toValue(id))) return id;
      const prefix = `${String(id)}${CHATGPT_EFFORT_SEPARATOR}`;
      const row = list.find((m) => m.id != null && String(m.id).startsWith(prefix));
      return row ? row.id : id;
    };
    // The stored per-provider choice (`compareModels`, written by the SW from the FIRST column of the
    // provider on each send) seeds the provider's FIRST column only (a later column was added with
    // its own model). The LAYOUT is authoritative (Codex integration #2): when the page already has an
    // explicit column for that provider+model, seeding the `auto` column with it would send the same
    // request twice (bad_request at the SW) — the seed is skipped and the column stays Auto.
    let stored = st.selectedModels && Object.hasOwn(st.selectedModels, col.provider) && ctx.firstColumnOf(col.provider) === col ? carry(st.selectedModels[col.provider]) : undefined;
    // 🔴 Compared AFTER carry on both sides (Codex ext 1R): a layout restored from before the stops
    // holds `chatgpt:gpt-5-6-thinking` while the seed is now `…__standard` — looked up by the new id
    // the explicit column was missed and both columns sent the same model.
    if (stored != null) {
      for (const other of state.columns.values()) {
        if (other === col || other.provider !== col.provider) continue;
        const om = parseColId(other.id).model;
        if (om != null && String(carry(om)) === String(stored)) { stored = undefined; break; }
      }
    }
    const fallback = list.find((m) => m.default) || list[0];
    let value;
    // The column's own model: the user's pick on this page, or the model it was created with (a
    // non-auto colId); an `auto` column with nothing picked yet follows the stored seed / the default.
    // Pre-session that derived value is RE-DERIVED on every render (Codex 2R): a lone seeded auto
    // column keeps the seed, but once the user adds the same provider+model as an explicit column
    // the seed collides (skipped above) and the auto column goes back to Auto — one request each.
    // In-session the derived model is fixed (a later seed change must not move a live thread) —
    // INCLUDING a null one (Codex 3R): an auto column that started its thread on Auto (no seed at
    // the time) stays Auto when another compare tab later writes a seed for the provider.
    const explicit = parseColId(col.id).model != null;
    const current = col.modelTouched || state.sessionStarted || (explicit && col.model != null) ? carry(col.model) : undefined;
    if (current !== undefined && known.has(toValue(current))) value = toValue(current);
    // An intentional Auto (null — the user's pick, or 「Auto로 바꿔 다시 보내기」) on a catalog that has no
    // Auto entry reconciles to the catalog's DEFAULT, never back to the stored model that was just
    // rejected (Codex batch-1 #1).
    else if (current === null) value = toValue(fallback.id);
    else if (stored !== undefined && known.has(toValue(stored))) value = toValue(stored);
    else value = toValue(fallback.id);
    // 🔴 In session a ChatGPT thread keeps its mode even when the list no longer has its model (a
    // restore on the static list, a MODELS refresh — Codex ext 1R): falling back across the mode
    // would send a Chat model into a Work conversation, answered silently by the Work equivalent.
    // A same-mode row is taken if there is one; else the thread's own model is kept as an option.
    let kept = null;
    if (crossesMode(col, value) && current != null) {
      const same = list.find((m) => !crossesMode(col, toValue(m.id)));
      if (same) value = toValue(same.id);
      else { kept = toValue(current); value = kept; }
    }
    clear(sel);
    for (const m of list) {
      const o = el('option', null, modelOptionText(m, t));
      // The site's own one-liner, where it gives one (v0.10.2): 「리서치급 추론 능력」,
      // 「10월 14일 지원 종료」. 🔴 On the TITLE, not in the option text — it is written in the
      // SITE's language, which is usually but not always the reader's, and a mixed-language row
      // reads as broken. The visible line stays ours; this is the detail behind it.
      if (typeof m.explainer === 'string' && m.explainer) o.title = m.explainer;
      o.value = toValue(m.id);
      o.setAttribute('value', toValue(m.id));
      if (o.value === value) o.setAttribute('selected', 'selected');
      sel.appendChild(o);
    }
    if (kept != null && !known.has(kept)) {
      const o = el('option', null, ctx.modelLabelOf(col.provider, kept));
      o.value = kept;
      o.setAttribute('value', kept);
      o.setAttribute('selected', 'selected');
      sel.appendChild(o);
    }
    sel.value = value;
    col.modelKnown = true;
    // The resolved model rides the wire for this column; the column's ID follows it only when the
    // user picked it on THIS page (modelTouched) — a stored seed or the catalog default leaves an
    // `auto` column `auto` (the id says what the user chose in the layout, `model` what is sent).
    if (col.modelTouched) setColumnModel(col, value === MODEL_AUTO_VALUE ? null : value);
    else col.model = value === MODEL_AUTO_VALUE ? null : value;
    renderPickerLabel(col);
    col.modelWrap.hidden = false;
  }

  /** The hint under a pill: only while its list is still pending at the SW AND a send is in flight. */
  function syncModelHint(col) {
    const pending = Array.isArray(state.status?.modelsPending) && state.status.modelsPending.includes(col.provider);
    col.modelHint.hidden = !(pending && state.sending && !col.modelWrap.hidden);
  }

  /**
   * MODELS (#1452 refresh): the SW re-listed some providers' pickers now that their tabs exist.
   * Replace those catalogs (and the source/pending bookkeeping) and repopulate each affected
   * select — renderModelSelect keeps the current choice when the new list still has it, else the
   * stored one, else the catalog default. Never while a column's pill would change under a locked
   * send: the select is disabled while sending, and only its options move.
   */
  function applyModels(msg) {
    if (!state.status || !msg.models || typeof msg.models !== 'object') return;
    const st = state.status;
    st.models = { ...(st.models || {}) };
    st.modelsSource = { ...(st.modelsSource || {}) };
    for (const [provider, list] of Object.entries(msg.models)) {
      if (!COMPARE_PROVIDERS.includes(provider) || !ctx.firstColumnOf(provider) || !Array.isArray(list)) continue;
      st.models[provider] = list;
      if (msg.modelsSource && typeof msg.modelsSource[provider] === 'string') st.modelsSource[provider] = msg.modelsSource[provider];
      for (const col of ctx.allColumns()) if (col.provider === provider) renderModelSelect(col);
    }
    if (Array.isArray(msg.modelsPending)) {
      // The message speaks for the providers it re-listed; others keep their state.
      const listed = new Set(Object.keys(msg.models));
      st.modelsPending = [...(st.modelsPending || []).filter((p) => !listed.has(p)), ...msg.modelsPending.filter((p) => typeof p === 'string')];
    }
    for (const col of state.columns.values()) syncModelHint(col);
  }

  /** The built picker exposes an Auto (`id:null` → MODEL_AUTO_VALUE) option — read from the <select>, not from a provider list. */
  function hasAutoOption(col) {
    for (const o of col.modelSelect.querySelectorAll('option')) if (o.getAttribute('value') === MODEL_AUTO_VALUE) return true;
    return false;
  }
  /** `models` map for a send (colId → model id | null = Auto): every target whose pill is shown. */
  function modelsFor(targets) {
    const out = {};
    for (const id of targets) {
      const col = state.columns.get(id);
      if (col && !col.modelWrap.hidden && col.modelKnown) out[id] = col.model;
    }
    return out;
  }
  /** The wire's `columns` (cmp-columns contract §1): `{id, provider, model}` per target, in target order. */
  function columnsFor(targets) {
    return targets.map((id) => state.columns.get(id)).filter(Boolean).map((c) => ({ id: c.id, provider: c.provider, model: c.model }));
  }
  /**
   * Analytics `send.models`: 'claude:auto,gemini:<id>' from what goes on the wire (a target
   * without a choice = auto). Each raw id must pass MODEL_ID_RE first (an invalid one drops the
   * whole pair); a valid id is then cut to MODELS_CSV_ID_MAX chars.
   */
  function modelsCsv(targets, models) {
    const parts = [];
    for (const colId of targets) {
      const col = state.columns.get(colId);
      const p = col ? col.provider : colId;
      if (models[colId] == null) { parts.push(`${p}:${MODELS_CSV_AUTO}`); continue; }
      const id = String(models[colId]);
      if (MODEL_ID_RE.test(id)) parts.push(`${p}:${id.slice(0, MODELS_CSV_ID_MAX)}`);
    }
    return parts.join(',');
  }
  /** A column's id for analytics: the model part only when it is a model id (MODEL_ID_RE) — anything else reads as the provider's auto column. */
  const gaCol = (col) => (col.model == null || MODEL_ID_RE.test(String(col.model)) ? col.id : colIdOf(col.provider, null));
  /** The served model's id for analytics (`column_done.model`): the id only, and only when it is one. */
  function servedModelId(col) {
    const id = col.servedModel && col.servedModel.id != null ? String(col.servedModel.id) : '';
    return MODEL_ID_RE.test(id) ? id : '';
  }
  // Everything another file reaches (compare.js destructures the names it calls bare).
  Object.assign(ctx, {
    closePicker, togglePicker, toggleServicePicker, syncServiceButton, openServicePicker, pickSessionModel, applyModelPick, sessionChoices, openPicker, renderPickerLabel, setColumnModel,
    renderModelSelect, syncModelHint, applyModels, hasAutoOption, modelsFor, columnsFor, modelsCsv, gaCol,
    servedModelId, reconcileMode,
  });
}
