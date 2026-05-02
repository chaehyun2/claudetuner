import { BG_I18N } from './constants.js';

export async function bgLang() {
  const { lang } = await chrome.storage.sync.get({ lang: 'auto' });
  if (lang !== 'auto') return lang;
  // 서비스 워커에서는 navigator.language가 불안정 → chrome.i18n.getUILanguage() 사용
  try {
    const ui = (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || 'en';
    return ui.toLowerCase().startsWith('ko') ? 'ko' : 'en';
  } catch (e) { return 'en'; }
}

export async function bt(key, ...args) {
  const l = await bgLang();
  const dict = BG_I18N[l] || BG_I18N.en;
  let text = dict[key] || BG_I18N.en[key] || key;
  args.forEach((a, i) => { text = text.replace(`{${i}}`, a); });
  return text;
}
