// ui/compare/incognito-pop.js — 「시크릿 대화」 per service (#1985 stage 3, decision 2a): the small ▾
// beside the topbar switch opens one row per service, each its own incognito switch. The switch
// stays the ALL-services control (checked / unchecked / indeterminate = mixed, compare.js
// syncSaveHistory); this popover is where a mixed choice is made.
//
// Like the switch, it sets the NEXT conversation's map (`state.saveBy`, through ctx.setSaveBy — the
// one writer, which also drops a held link whose provider turns incognito) and is locked once a
// session exists (the session's map is fixed at its first SEND).
// See ui/compare/history.js for the ctx contract.

import { SAVE_PROVIDERS, keptFor } from './save-mode.js';
import { PROVIDER_META, SVG_NS } from './constants.js';

// Geometry: kept off the window edge, a small gap under the ▾.
const INCOG_POP_EDGE_PX = 8;
const INCOG_POP_GAP_PX = 6;

/** Installs the per-service incognito popover onto `ctx` (after the topbar's incognito label exists). */
export function installIncognitoPop(ctx) {
  const { doc, state, t, el, track } = ctx;
  const label = (p) => (PROVIDER_META[p] ? PROVIDER_META[p].label : p);

  const btn = el('button', 'cmp-btn cmp-btn-sm cmp-incog-more');
  btn.type = 'button';
  btn.title = t('incognito_per_provider');
  btn.setAttribute('aria-label', t('incognito_per_provider'));
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  const chevron = doc.createElementNS(SVG_NS, 'svg');
  chevron.setAttribute('viewBox', '0 0 12 12');
  chevron.setAttribute('aria-hidden', 'true');
  chevron.setAttribute('class', 'cmp-incog-more-icon');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M3 4.5l3 3 3-3');
  chevron.appendChild(path);
  btn.appendChild(chevron);

  const pop = el('div', 'cmp-incog-pop');
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('incognito_per_provider'));
  pop.appendChild(el('div', 'cmp-incog-pop-title', t('incognito_per_provider')));
  const inputs = {};
  for (const p of SAVE_PROVIDERS) {
    const row = el('label', 'cmp-check cmp-incog-row');
    row.setAttribute('data-provider', p);
    row.title = t('incognito_provider_tip', label(p));
    const input = el('input');
    input.type = 'checkbox';
    input.className = 'cmp-incog-input';
    input.setAttribute('data-provider', p);
    row.appendChild(input);
    row.appendChild(el('span', 'cmp-incog-name', label(p)));
    row.appendChild(el('span', 'cmp-incog-tip', t('incognito_provider_tip', label(p))));
    input.addEventListener('change', () => {
      ctx.setSaveBy({ ...state.saveBy, [p]: !input.checked });
      track('incognito_toggle', { on: !!input.checked, scope: 'provider', provider: p });
    });
    inputs[p] = input;
    pop.appendChild(row);
  }
  pop.appendChild(el('p', 'cmp-incog-pop-note', t('incog_cross_note')));

  const locked = () => !!(state.sessionStarted || state.sending);
  function syncIncognitoPop() {
    for (const p of SAVE_PROVIDERS) {
      inputs[p].checked = !keptFor(state.saveBy, p);
      inputs[p].disabled = locked();
    }
    btn.disabled = locked();
    if (locked()) closeIncognitoPop();
  }
  // Under the ▾, or above it when the window is too short below; never taller than the window (it scrolls).
  function place() {
    const r = btn.getBoundingClientRect();
    const vw = (ctx.win && ctx.win.innerWidth) || 0;
    const vh = (ctx.win && ctx.win.innerHeight) || 0;
    pop.style.maxHeight = `${Math.max(0, vh - 2 * INCOG_POP_EDGE_PX)}px`;
    const width = pop.offsetWidth || 0;
    const height = pop.offsetHeight || 0;
    const below = r.bottom + INCOG_POP_GAP_PX;
    const above = r.top - INCOG_POP_GAP_PX - height;
    const top = below + height <= vh - INCOG_POP_EDGE_PX || above < INCOG_POP_EDGE_PX ? below : above;
    pop.style.left = `${Math.round(Math.max(INCOG_POP_EDGE_PX, Math.min(r.left, vw - width - INCOG_POP_EDGE_PX)))}px`;
    pop.style.top = `${Math.round(Math.max(INCOG_POP_EDGE_PX, Math.min(top, vh - height - INCOG_POP_EDGE_PX)))}px`;
  }
  function openIncognitoPop() {
    if (locked()) return;
    syncIncognitoPop();
    pop.hidden = false;
    place(); // after unhiding: its width is measured
    btn.setAttribute('aria-expanded', 'true');
    inputs[SAVE_PROVIDERS[0]].focus();
  }
  function closeIncognitoPop() {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
  btn.addEventListener('click', () => (pop.hidden ? openIncognitoPop() : closeIncognitoPop()));
  doc.addEventListener('keydown', (e) => {
    if (!e || e.key !== 'Escape' || pop.hidden) return;
    e.preventDefault();
    closeIncognitoPop();
    btn.focus();
  });
  doc.addEventListener('pointerdown', (e) => {
    if (pop.hidden || !e.target || pop.contains(e.target) || btn.contains(e.target)) return;
    closeIncognitoPop();
  });
  // Re-placed while open (Codex stage 3 2R 후속): a window shrunk under it must not leave it off screen.
  if (ctx.win && typeof ctx.win.addEventListener === 'function') ctx.win.addEventListener('resize', () => { if (!pop.hidden) place(); });
  doc.addEventListener('scroll', () => { if (!pop.hidden) place(); }, true);
  ctx.root.appendChild(pop);
  Object.assign(ctx, { incognitoMoreBtn: btn, incognitoPop: pop, syncIncognitoPop, closeIncognitoPop });
  return btn;
}
