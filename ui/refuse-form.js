// ui/refuse-form.js — the reason picker shown when a member refuses a plan change (#2435).
// Used by the auto-order card ([원치 않아요], with a 7/14-day pause) and the manual order banner ([거절],
// reason only). Built with DOM nodes + textContent only — no server or user text goes through innerHTML.
import { PA_LONG_TERM_REASONS, PA_NOTE_MAX, PA_PAUSE_DAYS } from '../bg/plan-auto.js';

let _seq = 0;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * Build the form. `opts`:
 *   reasons   — reason codes to offer (labels: t('pa_fb_' + code))
 *   withPause — show the 7/14-day pause choice (auto orders only)
 *   hint      — optional line under the title (e.g. "an applied upgrade is not undone")
 *   submitText
 *   onSubmit({ reason, note, pauseDays }) → Promise<string | null>  (an error message to show, or null = done)
 *   onCancel()
 * Returns the root element.
 */
export function buildRefuseForm(t, opts) {
  const id = `rf${++_seq}`;
  const root = el('div', 'refuse-form');
  root.appendChild(el('div', 'rf-title', t('pa_refuse_title')));
  if (opts.hint) root.appendChild(el('div', 'rf-hint', opts.hint));

  const list = el('div', 'rf-reasons');
  for (const code of opts.reasons) {
    const label = el('label', 'rf-reason');
    const input = document.createElement('input');
    input.type = 'radio'; input.name = `${id}-reason`; input.value = code;
    label.appendChild(input);
    label.appendChild(el('span', null, t('pa_fb_' + code)));
    list.appendChild(label);
  }
  root.appendChild(list);

  const longHint = el('div', 'rf-long hidden');
  longHint.appendChild(el('span', null, t('pa_refuse_long_hint') + ' '));
  const settings = el('a', null, t('pa_refuse_open_settings'));
  settings.href = '#';
  settings.onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
  longHint.appendChild(settings);
  root.appendChild(longHint);

  const note = document.createElement('textarea');
  note.className = 'rf-note';
  note.maxLength = PA_NOTE_MAX;
  note.rows = 2;
  note.placeholder = t('pa_refuse_note_ph');
  root.appendChild(note);

  let pause = null;
  if (opts.withPause) {
    pause = el('div', 'rf-pause');
    pause.appendChild(el('span', 'rf-pause-label', t('pa_refuse_pause_label')));
    PA_PAUSE_DAYS.forEach((d, i) => {
      const label = el('label', 'rf-pause-opt');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = `${id}-pause`; input.value = String(d); input.checked = i === 0;
      label.appendChild(input);
      label.appendChild(el('span', null, t('pa_refuse_days', d)));
      pause.appendChild(label);
    });
    root.appendChild(pause);
    root.appendChild(el('div', 'rf-hint', t('pa_refuse_pause_hint')));
  }

  const err = el('div', 'rf-error hidden');
  root.appendChild(err);
  const row = el('div', 'rf-actions');
  const send = el('button', 'rf-send', opts.submitText || t('pa_refuse_send'));
  send.type = 'button';
  const close = el('button', 'rf-close', t('pa_refuse_close'));
  close.type = 'button';
  row.appendChild(send); row.appendChild(close);
  root.appendChild(row);

  const selected = () => root.querySelector(`input[name="${id}-reason"]:checked`)?.value || null;
  list.addEventListener('change', () => {
    longHint.classList.toggle('hidden', !PA_LONG_TERM_REASONS.includes(selected()));
    err.classList.add('hidden');
  });
  close.onclick = () => opts.onCancel && opts.onCancel();
  send.onclick = async () => {
    const reason = selected();
    const text = note.value.trim();
    const showErr = (m) => { err.textContent = m; err.classList.remove('hidden'); };
    if (!reason) return showErr(t('pa_refuse_pick'));
    if (reason === 'other' && !text) return showErr(t('pa_refuse_note_required'));
    const pauseDays = pause ? Number(root.querySelector(`input[name="${id}-pause"]:checked`)?.value || PA_PAUSE_DAYS[0]) : null;
    send.disabled = true; close.disabled = true;
    const failure = await opts.onSubmit({ reason, note: text || null, pauseDays });
    send.disabled = false; close.disabled = false;
    if (failure) showErr(failure);
  };
  return root;
}
