// Popup theme toggle: resolves the stored preference and paints the button.
// Moved verbatim out of popup.js (#1126); only the `export` keywords and these imports are new.

// === Theme ===
const THEME_ICONS = { light: '\u2600\uFE0F', dark: '\uD83C\uDF19', system: '\uD83D\uDCBB' };
export function initPopupTheme() {
  chrome.storage.local.get({ 'ct-theme': 'system' }, (r) => {
    const pref = r['ct-theme'];
    const resolved = pref === 'system'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : pref;
    document.documentElement.setAttribute('data-theme', resolved);
    updateThemeBtn(pref);
  });
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      chrome.storage.local.get({ 'ct-theme': 'system' }, (r) => {
        const order = ['system', 'light', 'dark'];
        const cur = r['ct-theme'] || 'system';
        const next = order[(order.indexOf(cur) + 1) % order.length];
        const resolved = next === 'system'
          ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : next;
        chrome.storage.local.set({ 'ct-theme': next });
        document.documentElement.setAttribute('data-theme', resolved);
        updateThemeBtn(next);
      });
    });
  }
}
export function updateThemeBtn(mode) {
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    const svg = btn.querySelector('svg');
    if (svg) svg.style.display = 'none';
    btn.textContent = THEME_ICONS[mode] || THEME_ICONS.system;
    btn.style.fontSize = '14px';
  }
}
