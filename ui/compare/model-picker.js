// ui/compare/model-picker.js — the MODEL slice of mountComparePage() (compare.js): the column
// picker popover (Auto + the provider's catalog, re-keying a pre-session column), the model
// select and its hint, MODELS from the SW, and the `models` map / csv a send carries. The picker
// element and its keydown listener stay in compare.js (attached to ctx). Bodies are exactly as
// they were in compare.js; ctx contract: see ui/compare/history.js.

import { COMPARE_PROVIDERS, colIdOf, parseColId, PROVIDER_META, MODELS_CSV_AUTO, MODELS_CSV_ID_MAX, MODEL_ID_RE, MODEL_AUTO_VALUE } from './constants.js';

/** Installs the model-picker slice onto `ctx` (ctx contract: ui/compare/history.js header). */
export function installModelPicker(ctx) {
  const { t, state, track, el, clear, dot } = ctx;
  // The column whose picker is open, by REFERENCE: a pre-session pick re-keys the column's id, so an
  // id lookup at close time would miss the opener (aria-expanded / the picking class stuck — Codex
  // integration #3). `state.pickerFor` (its id) follows a re-key too, for the toggle.
  ctx.pickerCol = null; // a `let` shared with the outside-click listener in compare.js → a ctx field
  function closePicker() {
    const col = ctx.pickerCol;
    ctx.pickerCol = null;
    state.pickerFor = null;
    ctx.picker.hidden = true;
    clear(ctx.picker);
    if (ctx.picker.parentNode !== ctx.columnsBox) ctx.columnsBox.appendChild(ctx.picker); // back to its parking place
    if (col && col.pickerBtn) col.pickerBtn.setAttribute('aria-expanded', 'false');
    if (col && col.node.classList) col.node.classList.remove(ctx.PICKING_CLASS);
  }
  function togglePicker(colId) {
    if (state.pickerFor === colId) { closePicker(); return; }
    openPicker(colId);
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
  function openPicker(colId) {
    const col = state.columns.get(colId);
    if (!col || col.id !== colId || (state.sessionStarted && !col.modelKnown)) return;
    closePicker();
    state.pickerFor = colId;
    ctx.pickerCol = col;
    col.pickerBtn.setAttribute('aria-expanded', 'true');
    const inSession = state.sessionStarted;
    const choices = inSession ? sessionChoices(col) : ctx.columnChoices();
    let first = null;
    for (const p of inSession ? [col.provider] : COMPARE_PROVIDERS) {
      const group = el('div', 'cmp-col-picker-group');
      group.setAttribute('role', 'group');
      const title = el('div', 'cmp-col-picker-vendor');
      title.appendChild(dot(p));
      title.appendChild(el('span', null, PROVIDER_META[p].label));
      group.appendChild(title);
      for (const c of choices.filter((x) => x.provider === p)) {
        const opt = el('button', 'cmp-col-picker-opt', c.label);
        opt.type = 'button';
        opt.setAttribute('role', 'option');
        opt.setAttribute('data-choice', c.id);
        const current = inSession ? c.value === col.modelSelect.value : c.id === col.id;
        opt.setAttribute('aria-selected', current ? 'true' : 'false');
        opt.disabled = c.present && !current; // a combo the page already shows
        if (c.present && !current) opt.title = t('col_picker_dup');
        opt.addEventListener('click', () => {
          if (opt.disabled) return;
          const picked = inSession ? (pickSessionModel(state.pickerFor, c.value), true) : ctx.chooseColumn(state.pickerFor, c);
          if (!picked) return;
          closePicker();
          // Focus returns to the picker button of the column now carrying the choice (the same column
          // re-keyed, or the fresh one that replaced it on a provider swap).
          const landed = state.columns.get(c.id);
          if (landed && landed.id === c.id) ctx.focusQuietly(landed.pickerBtn);
        });
        group.appendChild(opt);
        if (!first && !opt.disabled) first = opt;
      }
      ctx.picker.appendChild(group);
    }
    // Under the column's head, inside the page (the columns grid is the reference).
    if (typeof col.node.appendChild === 'function') col.node.appendChild(ctx.picker);
    if (col.node.classList) col.node.classList.add(ctx.PICKING_CLASS); // the card stops clipping so the list can hang below it
    ctx.picker.hidden = false;
    if (first) ctx.focusQuietly(first);
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
    // The stored per-provider choice (`compareModels`, written by the SW from the FIRST column of the
    // provider on each send) seeds the provider's FIRST column only (a later column was added with
    // its own model). The LAYOUT is authoritative (Codex integration #2): when the page already has an
    // explicit column for that provider+model, seeding the `auto` column with it would send the same
    // request twice (bad_request at the SW) — the seed is skipped and the column stays Auto.
    let stored = st.selectedModels && Object.hasOwn(st.selectedModels, col.provider) && ctx.firstColumnOf(col.provider) === col ? st.selectedModels[col.provider] : undefined;
    if (stored != null) { const seeded = state.columns.get(colIdOf(col.provider, String(stored))); if (seeded && seeded !== col && seeded.id === colIdOf(col.provider, String(stored))) stored = undefined; }
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
    const current = col.modelTouched || state.sessionStarted || (explicit && col.model != null) ? col.model : undefined;
    if (current !== undefined && known.has(toValue(current))) value = toValue(current);
    // An intentional Auto (null — the user's pick, or 「Auto로 바꿔 다시 보내기」) on a catalog that has no
    // Auto entry reconciles to the catalog's DEFAULT, never back to the stored model that was just
    // rejected (Codex batch-1 #1).
    else if (current === null) value = toValue(fallback.id);
    else if (stored !== undefined && known.has(toValue(stored))) value = toValue(stored);
    else value = toValue(fallback.id);
    clear(sel);
    for (const m of list) {
      const o = el('option', null, String(m.label || m.id || ''));
      o.value = toValue(m.id);
      o.setAttribute('value', toValue(m.id));
      if (o.value === value) o.setAttribute('selected', 'selected');
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
    closePicker, togglePicker, pickSessionModel, applyModelPick, sessionChoices, openPicker, renderPickerLabel, setColumnModel,
    renderModelSelect, syncModelHint, applyModels, hasAutoOption, modelsFor, columnsFor, modelsCsv, gaCol,
    servedModelId,
  });
}
