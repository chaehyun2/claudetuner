// Site-access permission page for one provider (#2126).
//
// Why a page of its own: a web page cannot request an extension's host permission — only an
// extension page can, and only inside a user click. The welcome page sends OPEN_PERMISSION_PAGE
// (background.js), the SW opens this tab, and the ONE click here is the gesture
// chrome.permissions.request needs. On success it hands focus back to the tab that asked and
// closes itself, so the user lands where they were with the row already flipped to granted.
import { GRANTABLE, isGrantable } from './bg/grantable.js';

const GO_BACK_DELAY_MS = 900;

const params = new URLSearchParams(location.search);
const provider = params.get('p');
const fromTabId = Number(params.get('from'));

const $ = (id) => document.getElementById(id);

function setStatus(text, ok) {
  const el = $('grant-status');
  el.textContent = text;
  el.classList.toggle('ok', !!ok);
}

// Back to the page that sent us here. Both calls may fail (that tab was closed, or this tab was
// opened some other way) — the user then simply has the done message and closes it themselves.
async function goBack() {
  try {
    if (Number.isInteger(fromTabId) && fromTabId > 0) await chrome.tabs.update(fromTabId, { active: true });
  } catch { /* opener gone */ }
  try {
    const me = await chrome.tabs.getCurrent();
    if (me && Number.isInteger(me.id)) await chrome.tabs.remove(me.id);
  } catch { /* stay open */ }
}

function showGranted(label) {
  const btn = $('grant-btn');
  setStatus(t('grant_done', label), true);
  btn.textContent = t('grant_back');
  btn.disabled = false;
  btn.onclick = goBack;
}

async function init() {
  await initI18n();
  const btn = $('grant-btn');
  if (!isGrantable(provider)) {
    $('grant-title').textContent = t('grant_bad_title');
    btn.hidden = true;
    return;
  }
  const { label, origin, syncKey } = GRANTABLE[provider];
  document.title = t('grant_title', label);
  $('grant-title').textContent = t('grant_title', label);
  $('grant-desc').textContent = t('grant_desc', label);
  btn.textContent = t('grant_btn');

  if (await chrome.permissions.contains({ origins: [origin] })) { showGranted(label); return; }

  btn.onclick = async () => {
    btn.disabled = true;
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [origin] });
    } catch (e) {
      console.warn('[Claude Tuner] Permission request failed:', e && e.message);
    }
    if (!granted) {
      btn.disabled = false;
      setStatus(t('grant_denied'), false);
      return;
    }
    // Granting is asking to collect: a provider the user had switched off in Options would
    // otherwise stay silent with the permission in hand — the very "granted but nothing" state.
    await chrome.storage.sync.set({ [syncKey]: true });
    chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' }).catch(() => {});
    showGranted(label);
    setTimeout(goBack, GO_BACK_DELAY_MS);
  };
}

init();
