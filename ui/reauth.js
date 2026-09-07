// The re-auth widget: the way back for an install whose token went stale.
// Moved verbatim out of popup.js (#1126); only the `export` keywords and these imports are new.
import { noteSurface } from '../bg/block-state.js';
import { sendCodeReasonFromMessage, sendCodeErrorCopy, verifyCodeErrorCopy } from '../bg/send-code-error.js';
import { serverSyncWithheldReason } from '../bg/storage.js';
import { noteCtaShown, bindCodeInput, mountGoogleButton } from './auth-widgets.js';

// Re-auth widget for a trapped email (independent) account: its ext_token expired
// and email accounts can't use the shared-API_KEY fallback, so collection stalls
// with no self-recovery. Show a magic-code re-auth flow (mint a fresh ext_token);
// once collection resumes over Bearer, the server auto-upgrades email→claude
// (/api/auth/link-claude) so it can't recur. Also covers genuine provider-only
// (ChatGPT/Gemini) independent accounts whose token expired.
let _reauthRenderSeq = 0;
async function renderReauthWidget() {
  const widget = document.getElementById('reauth-widget');
  if (!widget) return;
  // 🔴 This function awaits TWICE (the read below, then isServerSyncGated) and is now driven by
  // storage.onChanged, so two renders can overlap and the LOSER can land last with a stale snapshot.
  // The dangerous direction is "hide": renderLoginCta yields whenever `independentAccount?.email`
  // exists, so a stale hide leaves NO recovery UI for the rest of the popup session — the exact
  // dead-end this widget exists to prevent, arrived at silently. Concretely: a render reads a live
  // extToken, a background 401 clears it, the newer render shows the widget, then the older render
  // resumes and hides it again on the token it read before the 401. So stamp each render and let
  // only the newest touch the DOM. (Codex DEPLOY-BLOCKER.)
  //
  // Collapsing the two awaits into one read is NOT the fix: the gate must be ASKED
  // (isServerSyncGated), never re-derived here — a second copy of that rule is what drifted in #786.
  const seq = ++_reauthRenderSeq;
  const { independentAccount = null, extToken = null, claudeLinkDone = false } =
    await chrome.storage.local.get(['independentAccount', 'extToken', 'claudeLinkDone']);
  // Trapped only when an email account has NO valid token (expired/cleared) AND
  // hasn't already been upgraded to a Claude account (claudeLinkDone). After a
  // link-claude upgrade the API_KEY fallback works, so a transient missing token
  // is not a trap — don't flash the widget in that window.
  // EXCEPTION (Phase 2 단계 4, Fable review HIGH): on a GATED install the api_key fallback is
  // deliberately blocked, so a linked user whose token later expired has NO working sync and NO
  // other login UI. Keep showing the reauth widget so they can re-mint a `full` token.
  //
  // 🔴 ASK THE GATE, do not re-derive it. This read `serverSyncGrandfathered === false` — a second
  // copy of the rule — and it drifted the moment the real predicate became `!== true` (a MISSING
  // flag is gated too). The result: a tokenless gated install with `claudeLinkDone` saw NEITHER
  // recovery UI — this widget hid because it thought "not gated", and renderLoginCta hides
  // whenever `independentAccount?.email` exists. Blocked from syncing, with no way back. (Codex.)
  // 🔴 The REASON, not the boolean: `isServerSyncGated()` is true only for 'login_first', so a
  // 'token_lost' install would be withheld from syncing with NO recovery UI at all — this widget
  // hides on `claudeLinkDone && !gated`, and renderLoginCta hides whenever independentAccount
  // exists. Silent data loss from the user's side. (Codex DEPLOY-BLOCKER.)
  const gated = !!(await serverSyncWithheldReason());
  // Superseded while awaiting → a newer render holds the truth. Bail BEFORE touching the DOM.
  if (seq !== _reauthRenderSeq) return;
  if (!independentAccount?.email || extToken || (claudeLinkDone && !gated)) { widget.classList.add('hidden'); return; }

  const email = independentAccount.email;
  const stepReq = document.getElementById('reauth-step-request');
  const stepVer = document.getElementById('reauth-step-verify');
  const status = document.getElementById('reauth-status');
  const codeInput = document.getElementById('reauth-code');
  const sendBtn = document.getElementById('reauth-send');
  const verifyBtn = document.getElementById('reauth-verify');

  document.getElementById('reauth-title').textContent = t('reauth_title') || 'Reconnect to resume syncing';
  document.getElementById('reauth-msg').textContent =
    t('reauth_msg', email) || `Your session expired. Reconnect ${email} to keep syncing your usage.`;
  sendBtn.textContent = t('reauth_send') || 'Send code';
  verifyBtn.textContent = t('reauth_verify') || 'Verify & reconnect';
  codeInput.placeholder = t('reauth_code_placeholder') || '6-digit code';
  // Same one-click path as the login CTA. These users already have an account, so the fastest way
  // back in is the one that needs no inbox round trip; the email code stays the fallback.
  mountGoogleButton(document.getElementById('reauth-google-slot'), {
    statusEl: status,
    successKey: 'reauth_success',
    successFallback: 'Verified — server sync will resume shortly.',
  });
  document.getElementById('reauth-or').textContent = t('login_cta_or') || 'or use an email code';
  widget.classList.remove('hidden');
  noteSurface('reauth');
  // `gated` already carries the reason the send path used; report it so the two can be joined.
  noteCtaShown('reauth', gated ? 'withheld' : 'token_missing');

  // Same shape as the login CTA: ONE send path reached from the initial button and from the
  // "send a new code" link on the verify step. Without the second entry point the rejection copy
  // ("request a new one") pointed at a control the step transition had just hidden.
  const resendBtn = document.getElementById('reauth-resend');
  const doSend = (btn) => {
    btn.disabled = true; btn.classList.add('loading'); status.textContent = '';
    // Clear at request START, not on the response: the old code is dead the moment a new one is
    // asked for, and clearing in the callback would wipe digits the user had begun typing from the
    // previous email while the request was in flight. (Codex.)
    codeInput.value = '';
    const lang = (localStorage.getItem('ct-lang') || (navigator.language || 'en').slice(0, 2));
    chrome.runtime.sendMessage(
      { type: 'REQUEST_MAGIC_LINK', email, purpose: 'login', lang },
      (res) => {
        btn.disabled = false; btn.classList.remove('loading');
        if (res && res.success) {
          stepReq.classList.add('hidden');
          stepVer.classList.remove('hidden');
          status.textContent = t('reauth_code_sent', email) || `Code sent to ${email}.`;
          codeInput.focus();
        } else {
          // 🔴 `chrome.runtime.lastError` is read HERE, inside the callback — Chrome clears it on
          // return, and it is the only evidence that the message never reached the service worker.
          // All three send surfaces route through the same classifier so they cannot drift apart
          // again (#1172).
          const copy = sendCodeErrorCopy(sendCodeReasonFromMessage(res, chrome.runtime.lastError));
          status.textContent = t(copy.key) || copy.fallback;
        }
      }
    );
  };
  if (resendBtn) resendBtn.textContent = t('code_resend') || 'Send a new code';
  if (!sendBtn.dataset.bound) {
    sendBtn.dataset.bound = '1';
    sendBtn.addEventListener('click', () => doSend(sendBtn));
  }
  if (resendBtn && !resendBtn.dataset.bound) {
    resendBtn.dataset.bound = '1';
    resendBtn.addEventListener('click', () => doSend(resendBtn));
  }

  if (!verifyBtn.dataset.bound) {
    verifyBtn.dataset.bound = '1';
    const doVerify = () => {
      if (verifyBtn.disabled) return; // guard against Enter double-submit
      const code = (codeInput.value || '').trim();
      if (!/^\d{6}$/.test(code)) { status.textContent = t('reauth_error_code') || 'Enter the 6-digit code.'; return; }
      verifyBtn.disabled = true; verifyBtn.classList.add('loading'); status.textContent = '';
      chrome.runtime.sendMessage({ type: 'VERIFY_MAGIC_CODE', email, code }, (res) => {
        verifyBtn.disabled = false; verifyBtn.classList.remove('loading');
        if (res && res.success) {
          status.textContent = t('reauth_success') || 'Reconnected — syncing will resume shortly.';
          // Nudge an immediate server POST with the fresh Bearer token so sync
          // resumes now (and triggers the email→claude upgrade) instead of waiting
          // for the next alarm. POPUP_OPENED only does a local-only collect.
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
}
export function renderReauth() {
  return renderReauthWidget().catch((e) => console.error('[Claude Tuner] reauth widget render failed', e));
}
