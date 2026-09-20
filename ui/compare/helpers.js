// ui/compare/helpers.js — the module-level helpers of the compare page (compare.js): pure
// functions that take every platform object they touch as an argument (chrome, window, a
// textarea) and close over nothing of mountComparePage(). Bodies as they were in compare.js;
// compare.js re-exports the public ones (listenEmbedTheme, sendableTargets, localHHMM).

import { COMPARE_PROVIDERS, COMPOSER_MAX_HEIGHT, EMBED_THEME_LIGHT, EMBED_THEME_DARK } from './constants.js';

/** sendMessage as a promise, whether the fake/real runtime answers via callback or promise. */
export function sendMessage(chrome, msg) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const r = chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; done(res); });
      if (r && typeof r.then === 'function') r.then(done, () => done(undefined));
    } catch { done(undefined); }
  });
}

/** Local HH:MM for an ISO timestamp; '' when unparseable. */
export function localHHMM(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Vertical border of `el` in px (0 where there is no layout engine — mini-dom). */
export function borderY(el) {
  const view = el.ownerDocument && el.ownerDocument.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return 0;
  const cs = view.getComputedStyle(el);
  return (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
}

/**
 * Auto-grow a composer textarea to its content, capped by COMPOSER_MAX_HEIGHT (then it scrolls).
 * `scrollHeight` excludes the border while the height we set includes it (the page is
 * border-box, compare.css `*`), so the border is added back — without it the box ends 2px short
 * and multi-line text shows a scrollbar (Codex 2R #3).
 */
export function autoGrow(textarea) {
  // 🔴 Item 4 (contract H): a textarea laid out at ZERO WIDTH — the page mounted inside a frame the
  // shell has not sized yet — wraps its placeholder / `?q` one character per line, so scrollHeight
  // is the cap (measured: 198 → the 200px cap committed at load, 46px after the first keystroke).
  // A height measured without a width is not a measurement: leave the box alone (min-height
  // rules) and let watchComposerWidth() re-run this once the textarea has a width.
  if (textarea.clientWidth === 0) return;
  textarea.style.height = 'auto';
  const h = textarea.scrollHeight;
  if (Number.isFinite(h) && h > 0) textarea.style.height = `${Math.min(h + borderY(textarea), COMPOSER_MAX_HEIGHT)}px`;
}

/**
 * Re-run autoGrow whenever the textarea's WIDTH changes (a frame that gets its size after load, a
 * composer that becomes visible, a window resize) — wrapping, and so the right height, depends on
 * the width. ResizeObserver where the platform has one (gated on the width so the height it sets
 * never re-triggers it), else `window.resize`. mini-dom has neither: nothing is installed.
 */
export function watchComposerWidth(textarea, win) {
  const RO = win && typeof win.ResizeObserver === 'function' ? win.ResizeObserver : null;
  if (RO) {
    let lastWidth = -1;
    try {
      new RO((entries) => {
        const width = entries && entries[0] && entries[0].contentRect ? entries[0].contentRect.width : textarea.clientWidth;
        if (width === lastWidth) return;
        lastWidth = width;
        autoGrow(textarea);
      }).observe(textarea);
      return;
    } catch { /* observe() refused — fall through to the window event */ }
  }
  if (win && typeof win.addEventListener === 'function') win.addEventListener('resize', () => autoGrow(textarea));
}

/**
 * Composer keys, shared by the question card and the follow-up box: Enter sends, Shift+Enter
 * breaks the line. An Enter that ends IME composition (Korean / Japanese input) must not send —
 * `isComposing` (or legacy keyCode 229) marks it. `onInput` runs after every edit (auto-grow done).
 */
export function bindComposer(textarea, onSend, onInput, win) {
  textarea.addEventListener('input', () => { autoGrow(textarea); if (onInput) onInput(); });
  textarea.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    onSend();
  });
  watchComposerWidth(textarea, win);
}

/** Providers the page may send to: permitted + logged in, minus the source when excluded. */
/** The web shell origin ui/embed-ready.js resolved for this frame, or null (not framed / not an allowed host). */
export function embedHostOf(win) {
  return win && typeof win.__ctEmbedHost === 'string' ? win.__ctEmbedHost : null;
}

/**
 * Framed by the web shell: apply `{__ctTheme:'light'|'dark'}` posted by the HOST page. Installed at
 * module evaluation — synchronously, before the async storage read that mounts the page — because
 * the shell posts the theme on the iframe's `load` event, which fires after this module ran but
 * possibly before that callback. 🔴 Both the origin AND the source window are pinned: accepted from
 * the framing page only, never from a sibling frame or an opener. Not framed → nothing is installed.
 */
export function listenEmbedTheme(win, doc) {
  const host = embedHostOf(win);
  if (!host || typeof win.addEventListener !== 'function') return false;
  win.addEventListener('message', (e) => {
    if (e.origin !== host || e.source !== win.parent) return;
    const theme = e.data && e.data.__ctTheme;
    if (theme === EMBED_THEME_LIGHT || theme === EMBED_THEME_DARK) doc.documentElement.setAttribute('data-theme', theme);
  });
  return true;
}

export function sendableTargets(status, src, excludeSrc) {
  if (!status || !status.providers) return [];
  return COMPARE_PROVIDERS.filter((p) => {
    const s = status.providers[p];
    if (!s || !s.permitted || !s.loggedIn) return false;
    if (excludeSrc && p === src) return false;
    return true;
  });
}
