// The way back from a cross-label attribution claim (#1109).
// Moved verbatim out of popup.js (#1126); only the `export` keywords and these imports are new.
import { noteSurface } from '../bg/block-state.js';
import { extTokenEmail, extTokenSrc } from '../bg/ext-token-claims.js';
import { sendCodeReasonFromMessage, sendCodeErrorCopy, verifyCodeErrorCopy } from '../bg/send-code-error.js';
import { noteCtaShown, bindCodeInput, mountGoogleButton } from './auth-widgets.js';

// ── #1109: the way back from a cross-label attribution claim ──────────────────────────────────
// A `dash_claim` handoff moves this install's collection to the account the dashboard was signed
// in as, and the server will happily move it back — /ext-google and /verify-code mint a `full`
// token for whoever authenticates, with no comparison against the collecting account. What was
// missing is a door: all three login surfaces in this popup are written around "no token", and a
// claimed install holds one. See the block comment on #claim-switch in popup.html for why this is
// a separate surface rather than a widened gate on any of them.
//
// 🔴 IT ONLY EVER ADDS A LOGIN. Clearing the token here would be the opposite of a fix: `dash_claim`
// is in PROVEN_SRC (bg/storage.js), so `everHadProvenToken` sticks, serverSyncWithheldReason()
// answers 'token_lost' and withholds even the shared-api_key fallback — and with
// API_KEY_INGEST_ENABLED=enforce nothing re-mints. That is collection stopped permanently, from a
// control the user reached for to fix something.
let _claimSwitchSeq = 0;

async function renderClaimSwitchWidget() {
  const box = document.getElementById('claim-switch');
  if (!box) return;
  // Same stale-render protection as the re-auth widget (#789/#791): this awaits before it touches
  // the DOM, and the dangerous direction is a stale HIDE — it would take away the only entry point
  // for the rest of the popup session.
  const seq = ++_claimSwitchSeq;
  const { extToken = null, claimPrevAccount = null, accountCache = null, independentAccount = null } =
    await chrome.storage.local.get({
      extToken: null, claimPrevAccount: null, accountCache: null, independentAccount: null,
    });
  if (seq !== _claimSwitchSeq) return;

  // THE GATE, and all of it. `src === 'dash_claim'` is the server's own record that the labels
  // differed and a human confirmed the take (worker/src/utils/ext-token.ts); it rides the token, so
  // this decides with no server round trip. Deliberately NOT and-ed with serverSyncGrandfathered:
  // that flag is stamped `true` on every install that existed before the login-first regime
  // (background.js), which is precisely why the footer switch is invisible to this population.
  // extTokenSrc reads the payload without verifying it and without looking at `exp`, so this still
  // identifies a claimed install after the token has expired — which is when it matters most.
  if (!extToken || extTokenSrc(extToken) !== 'dash_claim') { box.classList.add('hidden'); return; }
  // 🔴 AN EXPIRED TOKEN MUST STILL RENDER THIS (Codex DEPLOY-BLOCKER). The first draft required a
  // live extTokenEmail() and hid otherwise, on the reasoning that a dead token is the re-auth
  // widget's case. It is not: that widget hides whenever an extToken STRING exists (popup.js
  // renderReauthWidget), the login CTA does the same, and serverSyncWithheldReason() returns null
  // for any non-empty token (bg/storage.js) — so "expired but present" is treated as healthy
  // everywhere. Nothing in the popup does a server round trip either (POPUP_OPENED collects with
  // skipServer), so the dead token is not cleaned up while the user is looking at it. Hiding here
  // handed the user to a surface that does not exist, and the holder of an expired claim token is
  // exactly the person who needs to log in again.
  const live = extTokenEmail(extToken);
  // The account must still be NAMEABLE. `independentAccount` is written to the receiver by the
  // same handoff and does not expire; while `src` is still 'dash_claim' no later login can have
  // overwritten it (a login replaces the token, and with it the src), so it names the same
  // account the claim bound. Prefer the claim itself whenever it is readable.
  const receiver = live || independentAccount?.email || null;
  if (!receiver) { box.classList.add('hidden'); return; }

  // 🔴 NAME THE TARGET — AND ONLY WHEN IT IS A FACT. `claimPrevAccount` is written by the handoff
  // itself (background.js RECOVER_EXT_TOKEN) from the identity it was about to replace, so naming
  // it is honest. The provider address is a DIFFERENT fact: it is the account this browser is
  // signed in to at the provider, and the Tuner account it fed may carry another address. It is
  // therefore offered as a prefill and labelled as what it is, never asserted as "your previous
  // account" — a consent screen that names the wrong object is the defect this must not repeat
  // (#1035/#1067). An install claimed before this build shipped has no record: unknown branch.
  const prev = claimPrevAccount?.email
    && String(claimPrevAccount.email).toLowerCase() !== receiver.toLowerCase()
    ? String(claimPrevAccount.email) : null;
  const providerHint = accountCache?.email
    && String(accountCache.email).toLowerCase() !== receiver.toLowerCase()
    ? String(accountCache.email) : null;

  const link = document.getElementById('claim-switch-link');
  const panel = document.getElementById('claim-switch-panel');
  const status = document.getElementById('claim-switch-status');
  const emailInput = document.getElementById('claim-switch-email');
  const codeInput = document.getElementById('claim-switch-code');
  const sendBtn = document.getElementById('claim-switch-send');
  const verifyBtn = document.getElementById('claim-switch-verify');
  const resendBtn = document.getElementById('claim-switch-resend');
  const stepEmail = document.getElementById('claim-switch-step-email');
  const stepVerify = document.getElementById('claim-switch-step-verify');
  const hintEl = document.getElementById('claim-switch-hint');
  if (!link || !panel || !status || !emailInput || !codeInput || !sendBtn || !verifyBtn
      || !stepEmail || !stepVerify || !hintEl) { box.classList.add('hidden'); return; }

  // Text is (re)applied on every render, never only at bind time: a live language switch re-runs
  // this function, and imperative t() text has no data-i18n attribute to be re-applied for it.
  // With no live token nothing is reaching the server, and the collapsed row is the only thing
  // this install shows — so it says THAT rather than offering a switch, which would describe a
  // sync that is not happening.
  link.textContent = live
    ? (t('claim_switch_link') || 'Switch to another account')
    : (t('claim_switch_link_expired') || 'Login expired — sign in again');
  document.getElementById('claim-switch-title').textContent =
    t('claim_switch_title') || 'Switch the collecting account';
  document.getElementById('claim-switch-msg').textContent =
    `${live ? t('claim_switch_now', receiver) : t('claim_switch_now_expired', receiver)} ${prev
      ? t('claim_switch_back_known', prev)
      : t('claim_switch_back_unknown')}`;
  document.getElementById('claim-switch-keep').textContent = t('claim_switch_keep', receiver);
  emailInput.placeholder = t('login_cta_email_ph') || 'you@email.com';
  // Prefill with the best address available, and never overwrite what the user has typed.
  const prefill = prev || providerHint || '';
  if (!emailInput.value && prefill) emailInput.value = prefill;
  // The hint line explains where a prefill the user did not choose came from. With a recorded
  // previous account the sentence above already names it, so the line would be noise.
  if (!prev && providerHint) {
    hintEl.textContent = t('claim_switch_hint', providerHint);
    hintEl.style.display = '';
  } else {
    hintEl.textContent = '';
    hintEl.style.display = 'none';
  }
  sendBtn.textContent = t('login_cta_send') || 'Send code';
  verifyBtn.textContent = t('login_cta_verify') || 'Verify & log in';
  codeInput.placeholder = t('reauth_code_placeholder') || '6-digit code';
  if (resendBtn) resendBtn.textContent = t('code_resend') || 'Send a new code';
  document.getElementById('claim-switch-close').textContent = t('claim_switch_close') || 'Close';
  document.getElementById('claim-switch-or').textContent = t('login_cta_or') || 'or use an email code';
  mountGoogleButton(document.getElementById('claim-switch-google-slot'), {
    statusEl: status,
    successKey: 'claim_switch_success',
    successFallback: 'Switched — syncing to the new account will start shortly.',
  });

  box.classList.remove('hidden');
  noteSurface('claim_switch');
  // Exposure of the ENTRY POINT (the link), which is what is on screen at this moment. `reason`
  // splits the population by whether we can name the account being switched back to — the number
  // that says how much of the fleet the unknown branch has to serve.
  // `_expired` rides the same reason field: that population sees a different sentence and has no
  // other surface at all, so it has to be countable separately. Four values, still low-cardinality.
  noteCtaShown('claim_switch', `${prev ? 'prev_known' : 'prev_unknown'}${live ? '' : '_expired'}`);

  if (!link.dataset.bound) {
    link.dataset.bound = '1';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const opening = panel.classList.contains('hidden');
      panel.classList.toggle('hidden');
      if (!opening) return;
      panel.scrollIntoView({ block: 'nearest' });
      try {
        if (typeof sendGAEvent === 'function') {
          sendGAEvent('claim_switch_click', { named: link.dataset.prevKnown === '1' ? 'yes' : 'no' });
        }
      } catch (_) { /* telemetry must never break the popup */ }
    });
  }
  // Read at CLICK time, not captured at bind time — the handler is bound once and outlives the
  // render that created it.
  link.dataset.prevKnown = prev ? '1' : '0';

  // One send path, two entry points (initial button + "send a new code" on the verify step) —
  // same shape as the other two login surfaces, and for the same reason: the rejection copy says
  // "request a new one" while the send button lives on the step that is now hidden.
  const doSend = (btn, email) => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      status.textContent = t('login_cta_bad_email') || 'Enter a valid email.';
      return;
    }
    btn.disabled = true; btn.classList.add('loading'); status.textContent = '';
    codeInput.value = '';   // the old code is dead the moment a new one is asked for
    const lang = (localStorage.getItem('ct-lang') || (navigator.language || 'en').slice(0, 2));
    chrome.runtime.sendMessage({ type: 'REQUEST_MAGIC_LINK', email, purpose: 'login', lang }, (res) => {
      btn.disabled = false; btn.classList.remove('loading');
      if (res && res.success) {
        box.dataset.email = email;
        stepEmail.classList.add('hidden'); stepVerify.classList.remove('hidden');
        status.textContent = t('reauth_code_sent', email) || `Code sent to ${email}.`;
        codeInput.focus();
      } else {
        // See the re-auth widget above: lastError is read inside the callback, and the reason →
        // copy step lives in bg/send-code-error.js rather than here (#1172).
        const copy = sendCodeErrorCopy(sendCodeReasonFromMessage(res, chrome.runtime.lastError));
        status.textContent = t(copy.key) || copy.fallback;
      }
    });
  };
  if (!sendBtn.dataset.bound) {
    sendBtn.dataset.bound = '1';
    sendBtn.addEventListener('click', () => doSend(sendBtn, (emailInput.value || '').trim()));
  }
  if (resendBtn && !resendBtn.dataset.bound) {
    resendBtn.dataset.bound = '1';
    // From where the send stored it, never from the (hidden) email field the user can no longer
    // see or correct.
    resendBtn.addEventListener('click', () => doSend(resendBtn, box.dataset.email || ''));
  }
  if (!verifyBtn.dataset.bound) {
    verifyBtn.dataset.bound = '1';
    const doVerify = () => {
      if (verifyBtn.disabled) return;   // guard against Enter double-submit
      const code = (codeInput.value || '').trim();
      if (!/^\d{6}$/.test(code)) { status.textContent = t('reauth_error_code') || 'Enter the 6-digit code.'; return; }
      verifyBtn.disabled = true; verifyBtn.classList.add('loading'); status.textContent = '';
      chrome.runtime.sendMessage({ type: 'VERIFY_MAGIC_CODE', email: box.dataset.email, code }, (res) => {
        verifyBtn.disabled = false; verifyBtn.classList.remove('loading');
        if (res && res.success) {
          status.textContent = t('claim_switch_success') || 'Switched — syncing to the new account will start shortly.';
          // The token is replaced in place by VERIFY_MAGIC_CODE (setExtToken); POST now so the
          // switch shows up under the new account instead of waiting for the next alarm.
          chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' }).catch(() => {});
          setTimeout(() => location.reload(), 1200);
        } else {
          // The default is still "invalid or expired code" — that IS what a rejected code is. Only
          // the states that are not about the code (dead message channel, unreachable server, a
          // 2xx that was not our API) override it, decided in bg/send-code-error.js (#1172).
          const copy = verifyCodeErrorCopy(res, chrome.runtime.lastError);
          status.textContent = t(copy.key) || copy.fallback;
        }
      });
    };
    verifyBtn.addEventListener('click', doVerify);
    bindCodeInput(codeInput, doVerify);
  }
  const closeBtn = document.getElementById('claim-switch-close');
  if (!closeBtn.dataset.bound) {
    closeBtn.dataset.bound = '1';
    // Collapses back to the link — it does NOT dismiss the entry point. A dismissal would restore
    // exactly the "no door" state this exists to end.
    closeBtn.addEventListener('click', () => panel.classList.add('hidden'));
  }
}

/**
 * Same reasoning as renderReauth(): every call site goes through here so a render failure is
 * logged rather than swallowed. For a claimed install this is the ONLY entry point back.
 */
export function renderClaimSwitch() {
  return renderClaimSwitchWidget()
    .catch((e) => console.error('[Claude Tuner] claim switch render failed', e));
}
