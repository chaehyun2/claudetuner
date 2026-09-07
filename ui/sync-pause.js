// The footer pause/resume control for server sync (#1119).
// Moved verbatim out of popup.js (#1126); only the `export` keywords and these imports are new.
import { noteSurface } from '../bg/block-state.js';
import { extTokenSrc } from '../bg/ext-token-claims.js';
import { isServerSyncPaused, setServerSyncPaused } from '../bg/storage.js';
import { state } from './state.js';

/**
 * Every call site goes through here so a render failure can never be silent: this widget is the
 * ONLY way back for a gated user whose token expired. The call sites used to be `.catch(() => {})`,
 * and from the outside a swallowed exception is indistinguishable from "the function never ran" —
 * that ambiguity cost a full debugging cycle in #788. Still non-throwing, just no longer mute.
 */
// ── #1119: 동기화 일시중단 (the footer "Sign out" this REPLACES) ─────────────────────────────
//
// WHAT THE OLD CONTROL DID. `chrome.storage.local.remove(['independentAccount', 'extToken',
// 'needsReauth'])` — two things at once, and only the first was asked for:
//   1. stop sending to the server                    ← what the user wanted
//   2. destroy the credential                        ← what they got as well
// Under API_KEY_INGEST_ENABLED=enforce (live 2026-09-01) step 2 is not reversible. A PROVEN_SRC
// token (bg/storage.js) leaves `everHadProvenToken` set for good, so serverSyncWithheldReason()
// answers 'token_lost' and withholds even the shared-api_key fallback; enforce means no new TOFU
// token is minted; and removing `independentAccount` takes away the re-auth widget's own
// precondition. Collection stopped permanently, from a control labelled "log out", with no
// surface left to undo it (#1119).
//
// 🔴 THE RESUME CONTROL IS NOT GATED ON THE CONTROL THAT OFFERS THE PAUSE. `state.isIndependent`
// is derived from `collectedOrgs` and can flip to false while paused (one Claude org arriving is
// enough — the local-only path still writes collectedOrgs). Gating both on it would put the user
// back in a state they cannot leave, which is the entire bug this replaces. So: pausing is
// offered where the sign-out used to be; resuming is offered whenever the pause is on, full stop.
//
// 🔴 AND IT IS OFFERED TO A CLAIMED (`dash_claim`) INSTALL TOO. #1109 hid the footer control from
// that population because the ACTION was destructive; it is not any more, and hiding it left them
// with no way to stop sending at all.
let _syncPauseSeq = 0;

async function renderSyncPauseWidget() {
  const link = document.getElementById('sync-pause-toggle');
  const panel = document.getElementById('sync-pause-panel');
  const msg = document.getElementById('sync-pause-msg');
  const go = document.getElementById('sync-pause-go');
  const cancel = document.getElementById('sync-pause-cancel');
  if (!link || !panel || !msg || !go || !cancel) return;
  // Same stale-render protection as the re-auth and claim-switch widgets: this awaits before it
  // touches the DOM, and the dangerous direction is a stale HIDE of the resume button.
  const seq = ++_syncPauseSeq;
  const paused = await isServerSyncPaused();
  if (seq !== _syncPauseSeq) return;

  if (!paused && !state.isIndependent) { link.classList.add('hidden'); panel.classList.add('hidden'); return; }

  // The KEY moves with the label, not just the text — a live language change re-applies every
  // [data-i18n] from the markup, which would otherwise restore "Pause sync" onto the resume role
  // and offer to pause an already-paused install.
  const cta = paused ? 'sync_resume_cta' : 'sync_pause_cta';
  link.setAttribute('data-i18n', cta);
  link.textContent = t(cta) || (paused ? 'Resume sync' : 'Pause sync');
  link.classList.remove('hidden');

  if (paused) {
    // State AND remedy in the same place: the panel says what is happening and carries the button
    // that ends it. One click, no re-login — the token was never touched.
    msg.textContent = t('sync_paused_msg')
      || 'Sync is paused. Collection keeps running but stays in this browser, and the usage from this stretch will not be filled in on the dashboard or team report after you resume. What you have already sent stays there.';
    go.textContent = t('sync_resume_cta') || 'Resume sync';
    cancel.classList.add('hidden');
    panel.classList.remove('hidden');
    noteSurface('sync_paused');
  } else {
    panel.classList.add('hidden');
  }

  if (link.dataset.pauseBound) return;
  link.dataset.pauseBound = '1';

  // One place, both directions: the message carries no payload, because the service worker reads
  // the live flag itself (bg/collect.js reportSyncPauseState). A payload here would be a second
  // copy of the state, and the two could disagree.
  const notifyPauseChanged = async () => {
    try { await chrome.runtime.sendMessage({ type: 'SYNC_PAUSE_CHANGED' }); }
    catch (_) { /* no receiver / worker asleep — the next heartbeat carries the same value */ }
  };

  const doPause = async () => {
    // 🔴 ONE BOOLEAN, AND NOTHING ELSE. No token write, no identity write — see
    // bg/storage.js setServerSyncPaused and test/sync-pause-guard.mjs.
    await setServerSyncPaused(true);
    const { extToken = null } = await chrome.storage.local.get(['extToken']);
    // `src` says WHICH population reaches for this — the dash_claim installs #1109 had to hide the
    // old control from are the ones we most need to see using the safe one.
    sendGAEvent('sync_pause_click', { src: extTokenSrc(extToken) || 'none' });
    // Tell the server, so its "collection stopped" reminders — the third of which goes to the ORG
    // ADMIN — stop reporting this choice as a fault. Awaited so the request is actually issued
    // before location.reload() tears this page down.
    await notifyPauseChanged();
    location.reload();
  };

  const doResume = async () => {
    await setServerSyncPaused(false);
    sendGAEvent('sync_resume_click', {});
    // 🔴 THE CLEAR SIDE MATTERS MORE THAN THE SET SIDE. A server left believing this install is
    // paused would stay silent when its collection really does break. (The hourly heartbeat carries
    // the live flag too, and every reminder query requires a recent heartbeat, so a lost report
    // here cannot cause that silence — this just makes it immediate rather than eventual.)
    await notifyPauseChanged();
    // Resume means resume NOW. Without this the next POST waits for the poll alarm (up to the
    // configured interval), so a user who just pressed the button watches an unchanged dashboard
    // and concludes it did not work — the reason they reach for a reinstall.
    try { chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' })?.catch?.(() => {}); } catch (_) { /* no receiver */ }
    location.reload();
  };

  link.addEventListener('click', async (e) => {
    e.preventDefault();
    // Resume is ONE CLICK — there is nothing to warn about, and a confirm on the way back would
    // make the reversible half feel as heavy as the destructive control this replaces.
    if (await isServerSyncPaused()) { await doResume(); return; }
    // Pausing asks first: the "this stretch is not backfilled later" fact lives in this sentence
    // and nowhere else, so a first click that just paused would never show it.
    msg.textContent = t('sync_pause_confirm')
      || 'While paused, usage collected from now on does not reach the dashboard or team report, and that stretch is not filled in after you resume. What you have already sent stays there, and you stay signed in — one tap on "Resume sync" starts sending again.';
    go.textContent = t('sync_pause_go') || 'Pause';
    cancel.textContent = t('sync_pause_cancel') || 'Cancel';
    cancel.classList.remove('hidden');
    panel.classList.remove('hidden');
    panel.scrollIntoView({ block: 'nearest' });
  });
  // Read the live state rather than closing over `paused`: this handler is bound once, and after a
  // confirm-then-cancel-then-pause the captured value would be stale.
  go.addEventListener('click', async () => {
    if (await isServerSyncPaused()) await doResume();
    else await doPause();
  });
  cancel.addEventListener('click', () => { renderSyncPause(); });
}

export function renderSyncPause() {
  return renderSyncPauseWidget().catch((e) => console.error('[Claude Tuner] sync pause render failed', e));
}
