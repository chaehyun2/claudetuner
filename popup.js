// popup.js is the ES-module orchestrator (see popup.html). Domains live in ui/*.js.
import { drawCharts, _switchChartTab, _startChartAutoRoll, _stopChartAutoRoll, _toggleChartAutoRoll, _toggleChartYAxis, isChartAutoRoll, isChartRolling } from './ui/charts.js';
import { renderStatusBanner, initRunner } from './ui/prediction.js';
import { state, _filteredHistory, isDetailHidden } from './ui/state.js';
import { extTokenEmail } from './bg/ext-token-claims.js';
import { pinnedState } from './bg/analytics.js';
import { isServerSyncGated, serverSyncWithheldReason, getLastStatus } from './bg/storage.js';
import { readBlockState, resolveBlockState, noteSurface, surfacesShown } from './bg/block-state.js';
import { isUpgradeBlocked } from './bg/upgrade-gate.js';
import { PROVIDER_LABELS, PLAN_HIERARCHY, PLAN_MONTHLY_COST_USD } from './bg/constants.js';
import { dashboardUrl, refreshDashboardLinks, _isDark, applyGaugeWindowLabels } from './ui/util.js';
import { loadFitnessMatrix, checkReviewNudge, showRecFeedback } from './ui/recommend.js';
import { loadOrgSelector, selectOrg, showMultiOrgBadges } from './ui/org-selector.js';
import { enterOverview, enterDetail, renderOverview, isOverviewActive, exitOverview, syncViewTabs, isDragging } from './ui/overview.js';
import { _updateUICore, renderSyncAccountNote, renderUpgradeWarning } from './ui/render.js';
import { loadPopupAnnouncements } from './ui/notices.js';

// How long the width has to hold still before the detail charts re-rasterise to it. Long enough
// that dragging the side panel divider settles into a single redraw, short enough that the
// stretched frame is not read as the final rendering.
const RESIZE_REDRAW_MS = 120;

// True once the storage.onChanged listener has reported an ext_token, which makes state.syncEmail
// authoritative. The startup storage read then leaves it alone — the two are independent async
// operations and the read can return an OLDER token after a rotation has already been notified.
let _syncEmailLive = false;


// Re-auth widget for a trapped email (independent) account: its ext_token expired
// and email accounts can't use the shared-API_KEY fallback, so collection stalls
// with no self-recovery. Show a magic-code re-auth flow (mint a fresh ext_token);
// once collection resumes over Bearer, the server auto-upgrades email→claude
// (/api/auth/link-claude) so it can't recur. Also covers genuine provider-only
// (ChatGPT/Gemini) independent accounts whose token expired.
let _reauthRenderSeq = 0;

// ── CTA exposure telemetry (#772/#759) ────────────────────────────────────────────────────────
// THE QUESTION THIS ANSWERS. Every recovery route we ship is a login CTA in this popup, and until
// now we could only measure that we DECIDED to render one — not that a human ever had it in front
// of them. Those differ by a lot here: the icon is unpinned on ~57% of installs, so a badge alone
// reaches nobody, and 28-day popup reach is ~40%. Withholding sync from an install whose CTA is
// never seen is a silent block, which is the failure this whole area keeps producing.
//
// 🔴 FIRED WHERE THE ELEMENT IS ACTUALLY UN-HIDDEN, not where the decision is computed. A render
// can decide "show" and still be superseded before it touches the DOM (#789/#791), and counting
// decisions would report exposure that never happened.
//
// 🔴 ONCE PER POPUP OPEN, not per render. This popup re-renders on storage changes and on a
// language switch, so per-render counting would inflate the numerator against `popup_open` — the
// denominator this metric exists to be divided by — and the ratio would read above 100%.
const _ctaShownSent = new Set();
function noteCtaShown(kind, reason) {
  if (_ctaShownSent.has(kind)) return;
  _ctaShownSent.add(kind);
  try {
    // Classic global from analytics.js (loads before this module). Absent in tests//older builds.
    if (typeof sendGAEvent === 'function') sendGAEvent('login_cta_shown', { kind, reason });
  } catch (_) { /* telemetry must never break the popup */ }
}

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
        } else if (res && res.error === 'rate_limited') {
          status.textContent = t('reauth_error_rate') || 'Too many requests. Please wait a few minutes and try again.';
        } else {
          status.textContent = t('reauth_error') || 'Could not send the code. Please try again.';
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
          status.textContent = t('reauth_error_invalid') || 'Invalid or expired code. Request a new one.';
        }
      });
    };
    verifyBtn.addEventListener('click', doVerify);
    bindCodeInput(codeInput, doVerify);
  }
}

/**
 * Every call site goes through here so a render failure can never be silent: this widget is the
 * ONLY way back for a gated user whose token expired. The call sites used to be `.catch(() => {})`,
 * and from the outside a swallowed exception is indistinguishable from "the function never ran" —
 * that ambiguity cost a full debugging cycle in #788. Still non-throwing, just no longer mute.
 */
function renderReauth() {
  return renderReauthWidget().catch((e) => console.error('[Claude Tuner] reauth widget render failed', e));
}

// Phase 2 단계 4 login-first CTA — shown to a FRESH, not-logged-in install (showLoginPrompt set
// by the gated collection). Additive: usage already renders locally; logging in unlocks the
// server-backed features (multi-browser merge, plan rec, trends, Wrapped, team). Unlike the
// re-auth widget it has no known email, so it collects one (pre-filled from the detected
// provider email when available). Dismiss = stay local-only (still gated, just no more nag).
// scopeCtaShownFor value used by the email-provider block (see below): a fixed marker, because
// that block is defined by the ABSENCE of a token and so has no token tail to fingerprint.
const AUTH_BLOCKED_MARKER = 'auth-blocked';

/**
 * One-click login. Returns {ok} or {ok:false, message} — message '' means "user backed out",
 * which must stay silent (an error line for a deliberate cancel reads like a bug).
 *
 * The `identity` permission is OPTIONAL and requested HERE, not in the background: Chrome
 * requires a user gesture for chrome.permissions.request(), and a runtime message handler has
 * none. Everything after the grant (the auth window, the token exchange, storing ext_token)
 * happens in the background so the flow survives this popup closing — which it does the moment
 * the Google window takes focus. That is also why a lost sendMessage reply is not treated as
 * failure: storage.onChanged re-renders the CTA when the background stores the token.
 */
async function signInWithGoogle() {
  let granted = false;
  try {
    granted = await chrome.permissions.request({ permissions: ['identity'] });
  } catch {
    granted = false;
  }
  if (!granted) return { ok: false, message: t('login_cta_google_perm') || 'Permission needed for Google sign-in. Use the email code instead.' };

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'GOOGLE_SIGNIN' });
  } catch {
    // Popup closed mid-flow → the reply never arrived. The background may well have succeeded;
    // do not claim failure.
    return { ok: false, message: '' };
  }
  if (res?.success) return { ok: true };
  if (res?.error === 'cancelled') return { ok: false, message: '' };
  return { ok: false, message: t('login_cta_google_err') || 'Google sign-in failed. Use the email code instead.' };
}

/**
 * Wire a 6-digit code field: verify as soon as a complete code is present, and never re-send the
 * same one twice.
 *
 * Typing the last digit and then having to locate a button is a step nobody wants — and the field
 * is `autocomplete="one-time-code"`, so on macOS/iOS the code frequently ARRIVES already complete,
 * leaving the user staring at a filled box wondering what else is expected. That is the state this
 * fixes; it was never implemented, despite reading like a regression.
 *
 * Listens on `input`, not `keydown`: autofill and paste produce no key events, which is exactly the
 * path that lands a full code in one go. Enter stays bound for anyone who reaches for it.
 *
 * `lastTried` closes the loop a rejected code would otherwise create: the wrong digits stay in the
 * box, so the next input event (even deleting a character and retyping it) would re-submit them.
 * Editing to a DIFFERENT code always submits again, which is what someone correcting a typo wants.
 */
function bindCodeInput(input, doVerify) {
  if (!input || input.dataset.autoBound) return;
  input.dataset.autoBound = '1';
  let lastTried = '';
  const sanitizeAndMaybeVerify = () => {
    // Pasted codes arrive with spaces, hyphens, or a "code: " prefix from mail clients; reduce to
    // bare digits so the length test means what it says.
    //
    // 🔴 This is also why the field carries NO `maxlength`. The browser applies maxlength BEFORE
    // the input event fires, so "code: 123456" was cut to "code: " and then sanitised to "" — the
    // sanitiser could never see the digits it exists to rescue, and the paste path (the whole
    // point of this feature) silently ate the code. Length is enforced here instead, after the
    // full string has landed. (Codex.)
    const raw = (input.value || '').replace(/\D/g, '');
    const digits = raw.slice(0, 6);
    // Rewriting moves the caret to the end. Acceptable here: it only happens when the value held
    // something that is not a digit, and what remains is a complete code anyway.
    if (digits !== input.value) input.value = digits;
    // An empty field re-arms auto-submit: a resend clears it, and after that the user may well
    // enter the same digits again (the new mail had not arrived yet). Without this reset the
    // dedupe below would silently refuse, and auto-submit would look broken.
    if (!raw) { lastTried = ''; return; }
    // 🔴 Submit ONLY when the input was EXACTLY six digits. More than six means we had to choose
    // which ones the user meant — and a guessed code spends one of the server's 5 attempts on a
    // value nobody typed. Two real ways to get here: pasting a longer digit run, and pasting a
    // full code into a field that already holds some (value becomes "12" + "123456" → slice would
    // submit "121234"). Truncate for display, but make the user confirm. (Codex DEPLOY-BLOCKER.)
    if (raw.length !== 6 || digits === lastTried) return;
    lastTried = digits;
    doVerify();
  };
  input.addEventListener('input', (e) => {
    // Mid-composition text is not a code yet, and rewriting `value` here would erase what the user
    // is still composing.
    if (e.isComposing) return;
    sanitizeAndMaybeVerify();
  });
  // Chrome can fire the committing `input` with isComposing STILL true and never follow it with a
  // false one, so the guard above would swallow the only event that mattered — an IME user would
  // end up with six digits and no submit. compositionend always lands after the commit. (Codex.)
  input.addEventListener('compositionend', sanitizeAndMaybeVerify);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerify(); });
}

/**
 * Mount the shared Google button into `slot` and bind the one-click flow.
 *
 * ONE implementation on purpose. The login CTA and the re-auth widget need an identical tail —
 * request the optional `identity` permission, hand off to the background, then POST immediately
 * because the server-sync gate has just opened — and the ONLY thing that differs is the success
 * line. Forking this (or the brand SVG in popup.html) is what would drift; hence the template.
 *
 * Idempotent by contract: both callers re-render on every relevant storage change and on a live
 * language switch, so the label is refreshed on each call while the clone and the click listener
 * are installed exactly once.
 */
function mountGoogleButton(slot, { statusEl, successKey, successFallback }) {
  if (!slot) return;
  if (!slot.dataset.mounted) {
    const tpl = document.getElementById('google-btn-tpl');
    if (!tpl) return;
    slot.appendChild(tpl.content.cloneNode(true));
    slot.dataset.mounted = '1';
  }
  const btn = slot.querySelector('.google-btn');
  const label = slot.querySelector('.google-btn-label');
  if (!btn || !label) return;
  label.textContent = t('login_cta_google') || 'Continue with Google';
  if (btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', async () => {
    btn.disabled = true; statusEl.textContent = '';
    try {
      const res = await signInWithGoogle();
      if (res.ok) {
        // We hold a full Bearer token now and the gate just opened, so kick a POST immediately
        // instead of waiting for the next alarm, then re-render off fresh storage.
        // t() is called HERE, not at bind time: the language can change while the popup is open.
        statusEl.textContent = t(successKey) || successFallback;
        chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' }).catch(() => {});
        setTimeout(() => location.reload(), 1200);
        return;
      }
      statusEl.textContent = res.message;
    } finally {
      btn.disabled = false;
    }
  });
}

async function renderLoginCta() {
  // Copy for the collapsed reminder bar.
  //
  // 🔴 STATE first, benefits second, whenever sync is actually withheld. The collapsed bar is the
  // ONLY signal left for a user who dismissed the card, and the benefit-framed default ("verify for
  // multi-device sync…") never says the thing they do not know: nothing is reaching the server right
  // now. That gap matters most for a REINSTALLED user — a fresh install is not grandfathered
  // (background.js), so reinstalling to "fix" something silently drops the account into this state,
  // and the old copy read like an upsell they could keep ignoring. The sentence is equally true for
  // a genuinely new install, so it is not gated to reinstalls.
  //
  // Kept OUT of the collapsed branch on purpose: test/cta-shown-guard.mjs proves the exposure event
  // fires next to the code that actually shows the bar, and a long inline ternary pushes those two
  // apart until the proof no longer holds.
  function miniCtaMessage(authIsBlocked, scopeBlocked, withheld) {
    if (authIsBlocked) return t('login_cta_authblocked_mini') || "Log in — this browser's usage is no longer being saved to the server";
    if (scopeBlocked) return t('login_cta_scope_mini') || 'Log in to unlock plan recommendations & more';
    if (withheld) return t('login_cta_withheld_mini') || 'Saved on this browser only — verify to sync to the dashboard';
    return t('login_cta_mini') || 'Log in for multi-device sync & more';
  }

  const widget = document.getElementById('login-cta');
  if (!widget) return;
  const { showLoginPrompt = false, extToken = null, independentAccount = null, loginCtaCollapsed = false, accountCache = null, needsFullLogin = false, scopeCtaShownFor = null, authBlocked = false } =
    await chrome.storage.local.get({ showLoginPrompt: false, extToken: null, independentAccount: null, loginCtaCollapsed: false, accountCache: null, needsFullLogin: false, scopeCtaShownFor: null, authBlocked: false });

  // Phase 2 단계 5 consumer: a `ingest`-scoped token that hit a `full`-only endpoint gets a 403
  // scope_insufficient, which raises needsFullLogin (ui/auth.js, bg/storage.js, bg/collect.js).
  // Those users HOLD a token — and often an independentAccount too — so both guards below would
  // hide every login entry point and leave them with no way out of the block (the reauth widget
  // also requires !extToken). Treat needsFullLogin as an OVERRIDE: same verify flow, different
  // copy ("this feature is locked" rather than "turn on sync"). Requires the token to still be
  // present so a stale flag can't double up with the reauth widget after a 401 cleared it.
  const scopeBlocked = needsFullLogin === true && !!extToken;

  // email-provider block (bg/storage.js AUTH_BLOCKED_CODE): an auth_provider='email' account
  // POSTing with the shared api_key gets a 401 and its snapshot is DROPPED. The mirror image of
  // scopeBlocked — these users hold NO token (that is exactly why the api_key was used), so the
  // condition is !extToken. Every existing path left them invisible: showLoginPrompt is only set
  // by the fresh-install gate and these are old installs (serverSyncGrandfathered === true), and
  // the independentAccount?.email guard hides the widget from precisely the multi-provider users
  // most likely to be blocked (Codex). So this is an OVERRIDE too, for both guards.
  const authIsBlocked = authBlocked === true && !extToken;
  const blocked = scopeBlocked || authIsBlocked;
  // Sync is withheld right now (login_first / token_lost) — the collapsed bar says so instead of
  // pitching features. Read from the gate, not from `showLoginPrompt`, so a stale prompt flag
  // cannot make the bar claim a block that is over.
  const withheldMini = !!(await serverSyncWithheldReason());

  // The CTA (verify prompt) — trapped independent accounts go to renderReauthWidget; this is the
  // new-user path. NEVER fully dismissed: "Use locally only" COLLAPSES to a persistent mini
  // reminder (like the permission card) so verify is always one tap away, just small.
  if (!blocked && (!showLoginPrompt || extToken || independentAccount?.email)) { widget.classList.add('hidden'); return; }
  widget.classList.remove('hidden');
  noteSurface('login_cta');
  // WHY the CTA is up, so exposure can be split by cause rather than reported as one number.
  const _ctaReason = scopeBlocked ? 'scope_blocked' : authIsBlocked ? 'auth_blocked' : 'login_first';

  const full = document.getElementById('login-cta-full');
  const mini = document.getElementById('login-cta-mini');

  // An earlier "Use locally only" must not silently swallow a NEW scope block: auto-expand once
  // per blocked token, then honor further collapses as usual. The marker is the token's signature
  // tail (not the token — no second copy of a credential at rest) and self-clears: a fresh token
  // that gets blocked expands again.
  // The email-provider block has no token to fingerprint (that is its defining trait), so it uses
  // a fixed marker in the same slot — it is a per-account state, not a per-token one.
  let collapsed = loginCtaCollapsed;
  const scopeMarker = scopeBlocked ? extToken.slice(-16) : (authIsBlocked ? AUTH_BLOCKED_MARKER : null);
  if (blocked && scopeCtaShownFor !== scopeMarker) {
    collapsed = false;
    await chrome.storage.local.set({ scopeCtaShownFor: scopeMarker, loginCtaCollapsed: false });
  }

  // Collapsed → show only the compact reminder bar with a login button that re-expands.
  // NOTE: mini uses style.display (not .hidden) — its inline display would otherwise override the
  // .hidden class and leave BOTH mini + full visible in expanded mode (Codex re-review LOW).
  if (collapsed) {
    full.classList.add('hidden');
    mini.style.display = 'flex';
    document.getElementById('login-cta-mini-msg').textContent = miniCtaMessage(authIsBlocked, scopeBlocked, withheldMini);
    const miniBtn = document.getElementById('login-cta-mini-login');
    miniBtn.textContent = t('login_cta_mini_btn') || 'Log in';
    if (!miniBtn.dataset.bound) {
      miniBtn.dataset.bound = '1';
      miniBtn.addEventListener('click', async () => { await chrome.storage.local.set({ loginCtaCollapsed: false }); renderLoginCta(); });
    }
    // A SEPARATE kind, not folded into 'login_cta'. The collapsed reminder is one line of text —
    // treating it as the same exposure as the full card would report the CTA as "seen" for users
    // who only ever saw a mini nudge, which is the difference this metric exists to measure.
    noteCtaShown('login_cta_mini', _ctaReason);
    return;
  }
  mini.style.display = 'none';
  full.classList.remove('hidden');
  noteCtaShown('login_cta', _ctaReason);

  const emailInput = document.getElementById('login-cta-email');
  const codeInput = document.getElementById('login-cta-code');
  const sendBtn = document.getElementById('login-cta-send');
  const verifyBtn = document.getElementById('login-cta-verify');
  const dismissBtn = document.getElementById('login-cta-dismiss');
  const stepEmail = document.getElementById('login-cta-step-email');
  const stepVerify = document.getElementById('login-cta-step-verify');
  const status = document.getElementById('login-cta-status');

  // Scope-blocked users already sync (they hold an ingest token) — the pitch is the LOCKED
  // feature, not "turn on sync". Same verify flow underneath, so only the copy differs.
  // Three audiences, one verify flow — only the pitch differs. authBlocked users are NOT being
  // onboarded and are not missing an extra feature: their server sync has STOPPED, so the copy
  // says that plainly (local usage still renders, which is why nothing looked wrong to them).
  document.getElementById('login-cta-title').textContent = authIsBlocked
    ? (t('login_cta_authblocked_title') || 'Log in to resume server sync')
    : scopeBlocked
      ? (t('login_cta_scope_title') || 'Log in to unlock this feature')
      : (t('login_cta_title') || 'Turn on server sync');
  document.getElementById('login-cta-msg').textContent = authIsBlocked
    ? (t('login_cta_authblocked_msg') || 'Your usage is still recorded in this browser, but it is no longer being saved to the server — this account now requires a login. One email verification restores it:')
    : scopeBlocked
      ? (t('login_cta_scope_msg') || 'This browser is connected in collect-only mode, so features like plan recommendations are unavailable. One email verification enables them:')
      : (t('login_cta_msg') || 'Your usage is saved on this browser. Verify your email once to enable:');
  const feats = [t('login_cta_feat1'), t('login_cta_feat2'), t('login_cta_feat3')].filter(Boolean);
  const featsBox = document.getElementById('login-cta-feats');
  featsBox.textContent = ''; // build via DOM (no innerHTML sink)
  for (const f of feats) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:7px;align-items:flex-start;font-size:11.5px;line-height:1.4;color:var(--text-secondary)';
    const check = document.createElement('span');
    check.textContent = '✓';
    check.style.cssText = 'color:#22c55e;font-weight:800;flex-shrink:0';
    const txt = document.createElement('span');
    txt.textContent = f;
    row.appendChild(check); row.appendChild(txt);
    featsBox.appendChild(row);
  }
  document.getElementById('login-cta-prompt').textContent = t('login_cta_prompt') || 'Verify your email to start';
  emailInput.placeholder = t('login_cta_email_ph') || 'you@email.com';
  // Scope-blocked users usually already have a known identity (independentAccount) — prefill from
  // it when the provider cache is empty so re-login is one tap.
  const prefill = accountCache?.email || independentAccount?.email || '';
  if (!emailInput.value && prefill) emailInput.value = prefill;
  sendBtn.textContent = t('login_cta_send') || 'Send code';
  verifyBtn.textContent = t('login_cta_verify') || 'Verify & log in';
  codeInput.placeholder = t('reauth_code_placeholder') || '6-digit code';
  dismissBtn.textContent = t('login_cta_dismiss') || 'Use locally only';

  mountGoogleButton(document.getElementById('login-cta-google-slot'), {
    statusEl: status,
    successKey: 'login_cta_success',
    successFallback: 'Logged in — server sync will start shortly.',
  });
  document.getElementById('login-cta-or').textContent = t('login_cta_or') || 'or use an email code';

  // ONE send path, two entry points: the initial "send code" button and the "send a new code" link
  // on the verify step. The rejection copy has always said "request a new one" while offering no
  // way to do it — the send button lives in the email step, which is hidden by then, so the user
  // was told to take an action the UI had removed.
  const resendBtn = document.getElementById('login-cta-resend');
  const doSend = (btn, email) => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { status.textContent = t('login_cta_bad_email') || 'Enter a valid email.'; return; }
    btn.disabled = true; btn.classList.add('loading'); status.textContent = '';
    codeInput.value = '';   // same reasoning as the re-auth widget above
    const lang = (localStorage.getItem('ct-lang') || (navigator.language || 'en').slice(0, 2));
    chrome.runtime.sendMessage({ type: 'REQUEST_MAGIC_LINK', email, purpose: 'login', lang }, (res) => {
      btn.disabled = false; btn.classList.remove('loading');
      if (res && res.success) {
        widget.dataset.email = email;
        stepEmail.classList.add('hidden'); stepVerify.classList.remove('hidden');
        status.textContent = t('reauth_code_sent', email) || `Code sent to ${email}.`;
        codeInput.focus();
      } else if (res && res.error === 'rate_limited') {
        status.textContent = t('reauth_error_rate') || 'Too many requests. Please wait a few minutes and try again.';
      } else {
        status.textContent = t('reauth_error') || 'Could not send the code. Please try again.';
      }
    });
  };
  if (resendBtn) resendBtn.textContent = t('code_resend') || 'Send a new code';
  if (!sendBtn.dataset.bound) {
    sendBtn.dataset.bound = '1';
    sendBtn.addEventListener('click', () => doSend(sendBtn, (emailInput.value || '').trim()));
  }
  if (resendBtn && !resendBtn.dataset.bound) {
    resendBtn.dataset.bound = '1';
    // The address is already proven at this point — take it from where the send stored it, never
    // from the (hidden) email field, which the user can no longer see or correct.
    resendBtn.addEventListener('click', () => doSend(resendBtn, widget.dataset.email || ''));
  }

  if (!verifyBtn.dataset.bound) {
    verifyBtn.dataset.bound = '1';
    const doVerify = () => {
      if (verifyBtn.disabled) return;
      const code = (codeInput.value || '').trim();
      if (!/^\d{6}$/.test(code)) { status.textContent = t('reauth_error_code') || 'Enter the 6-digit code.'; return; }
      verifyBtn.disabled = true; verifyBtn.classList.add('loading'); status.textContent = '';
      chrome.runtime.sendMessage({ type: 'VERIFY_MAGIC_CODE', email: widget.dataset.email, code }, (res) => {
        verifyBtn.disabled = false; verifyBtn.classList.remove('loading');
        if (res && res.success) {
          status.textContent = t('login_cta_success') || 'Logged in — server sync will start shortly.';
          // Kick an immediate server POST now that we hold a full Bearer token (the gate is open).
          chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' }).catch(() => {});
          setTimeout(() => location.reload(), 1200);
        } else {
          status.textContent = t('reauth_error_invalid') || 'Invalid or expired code. Request a new one.';
        }
      });
    };
    verifyBtn.addEventListener('click', doVerify);
    bindCodeInput(codeInput, doVerify);
  }

  // Dismiss = keep the gate (no server send) AND collapse to the persistent mini reminder — never
  // fully hidden, so login stays one tap away and keeps nudging.
  //
  // TWO controls, ONE action. The text button states the consequence; the × states the gesture.
  // Users read "로컬만 사용" as a setting they do not understand, and reach for the × they expect
  // in a card's corner — which was not there, so there was no exit they recognised. Both bind to
  // the same handler: a second copy of the collapse logic is how the two would drift apart.
  const closeBtn = document.getElementById('login-cta-close');
  if (closeBtn) closeBtn.setAttribute('aria-label', t('login_cta_dismiss') || 'Maybe later');
  for (const btn of [dismissBtn, closeBtn]) {
    if (!btn || btn.dataset.bound) continue;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      await chrome.storage.local.set({ loginCtaCollapsed: true });
      renderLoginCta();
    });
  }
}

// Orgs the server is silently dropping at the 3-org cap (recorded by recordCapDrop in
// bg/cadence-config.js on every `skip_org` POST response).
//
// This is the only place the drop surfaces where the user actually is. The dashboard warns
// too, but a dropped org produces NO data — so nothing ever pulls that user to the dashboard
// to see the warning, which is exactly how the drop stayed invisible.
//
// ⚠️ Key literal is duplicated from bg/cadence-config.js (CAP_DROP_KEY): the popup is a
// classic script and cannot import that ESM module. Rename in BOTH or neither.
const CAP_DROP_KEY = '_ct_cap_drop';

async function checkCapDrops() {
  const banner = document.getElementById('capdrop-banner');
  if (!banner) return;
  let orgs = [];
  try {
    const stored = await chrome.storage.local.get(CAP_DROP_KEY);
    const cur = stored && stored[CAP_DROP_KEY];
    if (cur && Array.isArray(cur.orgs)) orgs = cur.orgs.filter(Boolean);
  } catch { /* storage hiccup → treat as "nothing dropped" and stay quiet */ }
  if (orgs.length === 0) { banner.classList.add('hidden'); return; }

  // Name the PROVIDERS, not the org uuids: a uuid means nothing to a user, and the provider
  // is the part they recognise ("my Gemini isn't being collected").
  const names = [...new Set(orgs.map(o => PROVIDER_LABELS[o.provider] || o.provider))].join(', ');
  banner.innerHTML = '';
  banner.appendChild(document.createTextNode(
    t('capdrop_banner_text', names) || names + ' is not being collected — active-org limit reached.',
  ));
  const btn = document.createElement('button');
  btn.textContent = t('capdrop_banner_btn') || 'Choose';
  btn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://claudetuner.com/dashboard/settings/#active-orgs-card' });
  });
  banner.appendChild(btn);
  banner.classList.remove('hidden');
}

// Check optional provider permissions and show banner if needed
async function checkProviderPermissions() {
  const banner = document.getElementById('perm-banner');
  if (!banner) return;
  const { collectChatGPT = true, collectGemini = true } = await chrome.storage.sync.get({ collectChatGPT: true, collectGemini: true });
  const missing = [];
  if (collectChatGPT) {
    const ok = await chrome.permissions.contains({ origins: ['https://chatgpt.com/*'] });
    if (!ok) missing.push({ label: 'ChatGPT', origins: ['https://chatgpt.com/*'] });
  }
  if (collectGemini) {
    const ok = await chrome.permissions.contains({ origins: ['https://gemini.google.com/*'] });
    if (!ok) missing.push({ label: 'Gemini', origins: ['https://gemini.google.com/*'] });
  }
  if (missing.length === 0) { banner.classList.add('hidden'); return; }
  const names = missing.map(m => m.label).join(', ');
  banner.innerHTML = '';
  banner.appendChild(document.createTextNode(t('perm_banner_text', names) || names + ' collection requires permission.'));
  const btn = document.createElement('button');
  btn.textContent = t('perm_banner_btn') || 'Grant';
  btn.addEventListener('click', async () => {
    try {
      const allOrigins = missing.flatMap(m => m.origins);
      const granted = await chrome.permissions.request({ origins: allOrigins });
      if (granted) {
        banner.classList.add('hidden');
        chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' }).catch(() => {});
      }
    } catch (e) {
      console.warn('[Claude Tuner] Permission request failed:', e.message);
    }
  });
  banner.appendChild(btn);
  banner.classList.remove('hidden');
}


// Auto org mode removed in v1.24.3 — see memory/auto-org-feature-archive.md for restoration

// Check if selected org is NOT the Claude primary org (used to skip Claude-only rendering)

// Hide provider-specific UI (fitness, privacy, pending plan, renewal) for an org that cannot
// support it. NOTE: currently unreferenced — the live gating lives in ui/org-selector.js §4-§7.
// Kept in sync with that policy so a future caller does not silently reintroduce a stale rule.
// recommendation-row / smart-rec-detail are deliberately NOT listed: recommendations now exist for
// ChatGPT too (docs/SPEC-chatgpt-plan-rec.md), and org-selector decides per provider.
function _hideClaudeOnlyUI() {
  const ids = ['fitness-section', 'privacy-row', 'pending-row'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  }
  const cancelWrap = document.getElementById('cancel-downgrade-wrap');
  if (cancelWrap) cancelWrap.style.display = 'none';
  const renewalGroup = document.getElementById('renewal-group');
  if (renewalGroup) renewalGroup.style.display = 'none';
}

// === Theme ===
const THEME_ICONS = { light: '\u2600\uFE0F', dark: '\uD83C\uDF19', system: '\uD83D\uDCBB' };
function initPopupTheme() {
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
function updateThemeBtn(mode) {
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    const svg = btn.querySelector('svg');
    if (svg) svg.style.display = 'none';
    btn.textContent = THEME_ICONS[mode] || THEME_ICONS.system;
    btn.style.fontSize = '14px';
  }
}

// Build auth headers for server requests (ext_token > API key fallback).
// Keep in sync with bg/storage.js#getAuthHeaders.


// Return only history matching the selected org

// === Announcements ===








// === Organization Selection ===

// === Plan Fitness Matrix ===



document.addEventListener('DOMContentLoaded', async () => {
  await initI18n();
  initPopupTheme();
  // 🔴 `pinned` rides THIS event so the two can be crossed for one install. They are already
  // reported separately (`extension_loaded` carries pinned, `popup_open` does not), and that shape
  // cannot answer "what share of installs are reachable at all" — GA has no way to join two events
  // to the same user, so the union of "pinned OR opens the popup" could only be bounded
  // (measured 2026-08-03: somewhere in 46–52%, which is too wide to decide anything on).
  // Carrying it here collapses that to a measurement.
  // 🔑 IMPORTED, not re-derived: pinnedState() owns the Chrome-91 'unknown' case, and folding a
  // missing API into 'no' would invent unpinned users (#798).
  sendGAEvent('popup_open', { pinned: await pinnedState() });

  // Request immediate local-only refresh if data is stale (>1 min)
  chrome.runtime.sendMessage({ type: 'POPUP_OPENED' }).catch(() => {});

  // === #942 stage 1: SHADOW ONLY ===
  // Compute the single-cause verdict and report it next to what the UI actually un-hid. Nothing
  // branches on it — the point is to find, on real installs, the combinations where the seven
  // independent predicates disagree with one resolver, BEFORE any surface starts consuming it.
  // Delayed because the surfaces render async: sampling at once would report an empty set and
  // manufacture a disagreement that never happened. Once per popup open (this handler runs once).
  setTimeout(() => {
    (async () => {
      const st = await readBlockState({ isUpgradeBlocked, serverSyncWithheldReason, getLastStatus });
      const verdict = resolveBlockState(st) || 'none';
      const surfaces = surfacesShown();
      if (typeof sendGAEvent === 'function') {
        // `surfaces` is a sorted, bounded join — a stable low-cardinality key GA can group by.
        sendGAEvent('block_state_shadow', {
          verdict,
          surfaces: surfaces.join('|') || 'none',
          n: surfaces.length,
          // Separates "the UI showed nothing because it is designed not to" from a real gap.
          err_suppressed: st.errorUiSuppressed || 'none',
        });
      }
    })().catch(() => { /* observation must never break the popup */ });
  }, 2000);
  // === end shadow === (the guard pins every resolver reference inside these two markers, so a
  // switch/ternary/alias cannot start consuming the verdict without the boundary moving)

  // Check for deleted account
  const { account_deleted } = await chrome.storage.local.get({ account_deleted: false });
  if (account_deleted) {
    document.getElementById('status-indicator').className = 'status-dot red';
    document.getElementById('status-text').textContent = t('account_deleted_msg') || 'Account deleted';
    const errorBanner = document.getElementById('error-banner');
    const errorMsg = document.getElementById('error-msg');
    errorMsg.innerHTML = (t('account_deleted_detail') || 'This account has been deleted. Data collection has stopped.')
      + '<br><a id="recover-link" href="#" style="display:inline-block;margin-top:8px;padding:6px 14px;background:#7c3aed;color:#fff;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none">'
      + (t('account_recover_btn') || 'Recover Account') + '</a>';
    errorBanner.classList.remove('hidden');
    noteSurface('account_deleted');
    // Hide hint area
    const hintEl = errorBanner.querySelector('.error-hint');
    if (hintEl) hintEl.style.display = 'none';
    document.getElementById('recover-link').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.storage.local.remove('account_deleted');
      chrome.tabs.create({ url: 'https://claudetuner.com/dashboard/settings/' });
    });
    return;
  }

  // === Independent Account: show email auth / re-auth / signed-in state ===
  const { accountCache: _ac, independentAccount: _ia, collectedOrgs: _co } =
    await chrome.storage.local.get({
      accountCache: null, independentAccount: null, collectedOrgs: [],
    });
  // Genuine independent = email account, no Claude session, AND no Claude org
  // data. The Claude-org check avoids a false positive (showing the independent
  // row + footer Claude email at once) while accountCache is still being
  // populated on a Claude user's first collection of the session.
  const _hasClaudeOrg = (_co || []).some(o => (o.provider || 'claude') === 'claude');
  const isIndependent = !_ac?.email && !!_ia?.email && !_hasClaudeOrg;
  state.isIndependent = isIndependent; // expose to _updateUICore (suppress Claude-centric UI)
  state.independentEmail = isIndependent ? (_ia.email || '') : ''; // shown in the footer
  // The in-popup email signup form was removed: with TOFU symmetric identity,
  // simply signing in to Claude/ChatGPT/Gemini auto-syncs usage — no signup
  // needed. The magic-link flow now only exists as a dashboard login fallback.
  // Existing independent (email) accounts still get the footer sign-out link.
  if (isIndependent) {
    const signOut = document.getElementById('independent-signout');
    if (signOut) {
      // One element, two roles (sign-out here, account switch below) — so each branch must OWN the
      // key. A live language change re-applies every [data-i18n] from the markup, which would
      // otherwise restore whichever label the HTML happens to carry.
      signOut.setAttribute('data-i18n', 'sign_out');
      signOut.textContent = t('sign_out') || 'Sign out';
      signOut.classList.remove('hidden');
      signOut.addEventListener('click', async (e) => {
        e.preventDefault();
        await chrome.storage.local.remove(['independentAccount', 'extToken', 'needsReauth']);
        location.reload();
      });
    }
  } else {
    // Phase 2 단계 4: a login-first (gated-regime) user who VERIFIED has a provider account, so
    // isIndependent is false — but they still need a subtle "인증 해제" (de-verify → local-only) in
    // the footer next to their email. Scoped to serverSyncGrandfathered===false so existing/
    // grandfathered users are untouched. No prominent banner (user feedback).
    const { serverSyncGrandfathered: _gf, extToken: _tok } = await chrome.storage.local.get(['serverSyncGrandfathered', 'extToken']);
    if (_gf === false && !!_ia?.email && !!_tok) {
      const signOut = document.getElementById('independent-signout');
      if (signOut) {
        // Named for the GOAL, not the mechanism. "인증 해제 / Disconnect" describes what the code
        // does; nobody wants to de-authenticate — they want to be on a different account, and had
        // to work out for themselves that it takes disconnect-then-log-in-again.
        //
        // 🔴 The KEY moves with the label, not just the text. This element is `data-i18n="sign_out"`
        // in the markup and a live language switch re-applies every [data-i18n] from source — which
        // silently relabelled this control "로그아웃 / Sign out", i.e. promised a reversible logout
        // for a switch that permanently splits the history. (Codex.)
        signOut.setAttribute('data-i18n', 'account_switch_cta');
        signOut.textContent = t('account_switch_cta') || 'Switch account';
        signOut.classList.remove('hidden');
        if (!signOut.dataset.deauthBound) {
          signOut.dataset.deauthBound = '1';
          const box = document.getElementById('account-switch-confirm');
          const go = document.getElementById('account-switch-go');
          const cancel = document.getElementById('account-switch-cancel');
          // Ask before switching. The data already collected stays under the CURRENT account and
          // the two are never merged (no merge exists — DESIGN-authenticated-attribution §7.4), so
          // this is not the reversible "log out" it looks like. Name the account that keeps the
          // history: that is the fact the user needs and cannot see anywhere else.
          const doSwitch = async () => {
            await chrome.storage.local.remove(['extToken', 'independentAccount', 'loginCtaCollapsed']);
            await chrome.storage.local.set({ showLoginPrompt: true });
            location.reload();
          };
          signOut.addEventListener('click', (e) => {
            e.preventDefault();
            // No confirm UI → do NOTHING. Switching unasked is the one outcome worth avoiding here
            // (it splits the history silently and nothing merges it back), so a missing element
            // fails closed: the user retries once the markup is fixed, having lost nothing.
            if (!box) return;
            document.getElementById('account-switch-msg').textContent =
              t('account_switch_confirm', _ia.email)
              || `Usage collected so far stays under ${_ia.email}. The new account starts from now, and the two are not merged.`;
            go.textContent = t('account_switch_go') || 'Switch account';
            cancel.textContent = t('account_switch_cancel') || 'Cancel';
            box.classList.remove('hidden');
            box.scrollIntoView({ block: 'nearest' });
          });
          go?.addEventListener('click', doSwitch);
          cancel?.addEventListener('click', () => box?.classList.add('hidden'));
        }
      }
    }
  }

  renderReauth();
  renderLoginCta();
  // showLoginPrompt is written by the first gated collect cycle, which can land AFTER this
  // initial render (POPUP_OPENED → collect). Re-render the CTA when it flips so the login
  // control appears on the FIRST popup open, not only the second (Fable review LOW).
  if (!window._loginCtaWatch) {
    window._loginCtaWatch = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      // needsFullLogin lands the same way (a 403 from a background collect or an in-popup
      // /fitness read), so it must re-render too or the CTA waits for the next popup open.
      // authBlocked lands the same way (a 401 from a background collect) and, unlike the others,
      // it can also be CLEARED mid-session by a recovering POST — re-render on both edges.
      if (area === 'local' && (changes.showLoginPrompt || changes.extToken || changes.needsFullLogin || changes.authBlocked)) renderLoginCta();
      // #789 — the re-auth widget needs the same treatment, on ITS inputs (independentAccount /
      // extToken / claudeLinkDone, plus the gate flag it asks isServerSyncGated about). Until now
      // its only callers were the initial render and a language switch, so a token cleared by a
      // background 401 mid-session hid BOTH recovery controls at once: renderLoginCta yields
      // whenever `independentAccount?.email` exists (it defers to this widget by design), and this
      // widget never re-ran. It healed on the next popup open — exactly one popup open too late,
      // and precisely while the user is watching sync stop.
      if (area === 'local' && (changes.extToken || changes.independentAccount
          || changes.claudeLinkDone || changes.serverSyncGrandfathered)) renderReauth();
      // Same reasoning for the 426 version block: it is raised (and cleared) by a background
      // POST that can land while the popup is open. Both edges matter — appearing late is the
      // silent-death case, and lingering after recovery would tell a fixed install it is broken.
      if (area === 'local' && changes.upgradeBlocked) renderUpgradeWarning();
      // A token rotation IS the event this note exists for: a provider account-email change
      // gets the old token rejected and a new one minted against the NEW address. The panel can
      // sit open across that, so re-read the account — otherwise the footer keeps naming the
      // previous account (or nothing) for the rest of the session, which is exactly the wrong
      // answer at exactly the wrong moment.
      if (area === 'local' && changes.extToken) {
        state.syncEmail = extTokenEmail(changes.extToken.newValue);
        // Mark the value as live so the startup read below can't roll it back: that read and
        // this notification are independent async operations, and POPUP_OPENED triggers a
        // collection that can rotate the token while the initial storage.get is still in
        // flight — landing an older token after the newer one.
        _syncEmailLive = true;
        renderSyncAccountNote();
      }
    });
  }

  loadPopupAnnouncements();
  // Side panel persists across hide/show: if the initial fetch never populated
  // the list, re-try when the panel becomes visible again (matches the "reopen
  // makes the bell appear" behavior, without a manual close/reopen).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.popupNoticeList.length === 0) loadPopupAnnouncements();
  });
  loadOrgSelector();
  checkProviderPermissions();
  checkCapDrops();
  loadFitnessMatrix();

  // Fitness table click opens dashboard (except link clicks)
  const fmSection = document.getElementById('fitness-section');
  if (fmSection) {
    fmSection.title = 'Dashboard';
    fmSection.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      chrome.tabs.create({ url: dashboardUrl(state.selectedOrgId) });
    });
  }

  // Announcement toggle button
  const noticeToggle = document.getElementById('notice-toggle-btn');
  const noticePanel = document.getElementById('ct-popup-notices');
  if (noticeToggle && noticePanel) {
    noticeToggle.addEventListener('click', () => {
      const visible = noticePanel.style.display !== 'none';
      noticePanel.style.display = visible ? 'none' : '';
    });
  }
  let _statusReady = false, _historyReady = false;

  // Status banner refresh (reflects rate-based prediction). Extracted because every
  // detail redraw site below needs the exact same guard + argument unpacking.
  function renderDetailBanner(hist) {
    const s = state.currentSnapshot;
    if (hist.length < 3 || !s) return;
    renderStatusBanner(s.five_hour?.utilization ?? null, s.seven_day?.utilization ?? null, hist, s.five_hour?.resets_at, s.seven_day?.resets_at);
  }

  // Redraw the detail view's chart + status banner from the current state. Three call sites
  // (language switch, background-collection update, manual collect) had grown byte-identical
  // copies of this block.
  //
  // Perf: both targets live inside #chart-section / #status-banner, which body.ct-view-overview
  // hides. A collection run writes lastStatus up to five times and appends usageHistory once per
  // org, and EVERY one of those writes lands here — so a user sitting on the overview paid a full
  // history scan plus a canvas redraw per write, for elements nobody can see. A hidden canvas
  // reports clientWidth 0, so `canvas.width = 0` reallocated the backing store and every one of
  // those draws was discarded anyway. Bailing out is safe because returning to the detail view
  // always goes through enterDetail() -> selectOrg(), which redraws both from scratch.
  function redrawDetail() {
    if (isDetailHidden()) return;
    const hist = _filteredHistory();
    if (hist.length >= 2) drawCharts(hist, state.currentPlan, state.currentSnapshot);
    renderDetailBanner(hist);
  }

  // The three detail charts allocate their canvas backing store from clientWidth at DRAW time
  // (ui/charts.js), so a width change after the draw stretches the old pixels instead of
  // re-rasterising. That never mattered while the body was a fixed 340px column: nothing could
  // change our width. It does now — popup.html lets the column grow with a dragged-out side
  // panel — and without this the charts stay blurry until some unrelated event redraws them.
  //
  // Trailing debounce, not rAF: a drag fires resize continuously and each redraw costs a full
  // history scan (the same cost that made collection feel sluggish, see queueStatusRender
  // below), so one redraw when the drag settles beats sixty on the way there.
  //
  // Routed through selectOrg() rather than redrawDetail() whenever an org is selected, because
  // redrawDetail() draws with state.currentPlan/currentSnapshot — and those track the PRIMARY
  // Claude org, not the org on screen (ui/org-selector.js builds a per-org snapshot instead, which
  // is what carries `provider` into the quota scale and the guide-line tiers). Its two existing
  // callers get away with it only because both are guarded by a
  // `selectedOrgId === snapshot.claude_org_uuid` check; an unguarded call here would repaint a
  // ChatGPT/Gemini org's charts on Claude's plan ladder. selectOrg() is storage-read plus render,
  // no network, so once per settled resize is cheap. Resizing on the overview needs nothing:
  // returning to the detail view goes through enterDetail() -> selectOrg() anyway.
  let _resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (isDetailHidden()) return;
      if (state.selectedOrgId) selectOrg(state.selectedOrgId);
      else redrawDetail();
    }, RESIZE_REDRAW_MS);
  });

  // Re-render everything that depends on lastStatus, coalesced to one pass per frame.
  //
  // A single collection run writes lastStatus up to five times (bg/collect.js) and appends a
  // usageHistory point per org, and each write fired its own storage.get + updateUI + chart
  // redraw. With several orgs that is a burst of full re-renders on the main thread, which is
  // what made the popup feel sluggish WHILE COLLECTING (and only then). lastStatus is a whole
  // snapshot, so collapsing a burst to its newest value lands on the same final UI that running
  // every write in sequence would have — just without the discarded intermediate renders.
  let _pendingStatus = null;
  let _statusRenderQueued = false;
  function queueStatusRender(status) {
    _pendingStatus = status;
    if (_statusRenderQueued) return;
    _statusRenderQueued = true;
    requestAnimationFrame(() => {
      _statusRenderQueued = false;
      const s = _pendingStatus;
      _pendingStatus = null;
      if (!s) return;
      chrome.storage.local.get({ usageHistory: [], collectedOrgs: [] }, (r) => {
        state.usageHistory = r.usageHistory || [];
        state.historyLoaded = true;
        state.collectedOrgs = r.collectedOrgs || [];
        updateUI(s);
        state.currentPlan = s?.snapshot?.plan || null;
        state.currentSnapshot = s?.snapshot || null;
        // updateUI handles early return for non-Claude orgs; only draw charts for Claude primary
        if (!state.selectedOrgId || state.selectedOrgId === s?.snapshot?.claude_org_uuid) {
          redrawDetail();
        }
        // No renderOverview() here on purpose: the cards read state.collectedOrgs, whose own
        // onChanged branch above already re-renders them. Adding a second trigger would only
        // duplicate work.
      });
    });
  }

  function tryDrawCharts() {
    if (!_statusReady || !_historyReady) return;
    const hist = _filteredHistory();
    const isUsageBasedEnt = (state.currentPlan || '').includes('Enterprise') && state.currentSnapshot?.five_hour?.utilization == null && state.currentSnapshot?.seven_day?.utilization == null;
    if (hist.length >= 2 || isUsageBasedEnt) {
      drawCharts(hist, state.currentPlan, state.currentSnapshot);
      if (isChartAutoRoll() && !isUsageBasedEnt) _startChartAutoRoll();
    }
    // Refresh banner after history load (reflects rate-based prediction)
    renderDetailBanner(hist);
  }

  // Load current status + history directly from chrome.storage
  // Restore pinned org from selectedOrgId (sync)
  chrome.storage.sync.get({ selectedOrgId: null, overviewOrder: [] }, (syncCfg) => {
    state.overviewOrder = syncCfg.overviewOrder || []; // user's saved overview card order
    chrome.storage.local.get({ lastStatus: null, usageHistory: [], collectedOrgs: [], claudeNoticeDismissed: false, onboardOrgName: null, lastView: 'overview', overviewHintDismissed: false, lastViewedOrgId: null, extToken: null }, (result) => {
      // Which Tuner account this install actually syncs into (see bg/ext-token-claims.js).
      // Skipped once the onChanged listener has already reported a token: this read was issued
      // earlier, so applying it now would replace a newer token with an older one.
      if (!_syncEmailLive) state.syncEmail = extTokenEmail(result.extToken);
      state.onboardOrgName = result.onboardOrgName || null;
      state.usageHistory = result.usageHistory || [];
      state.historyLoaded = true;
      state.claudeNoticeDismissed = result.claudeNoticeDismissed || false;
      state.lastView = result.lastView || 'overview';
      state.overviewHintDismissed = !!result.overviewHintDismissed;
      _historyReady = true;

      // Multi-org: restore pinned org or fall back to primary
      const cOrgs = result.collectedOrgs || [];
      if (cOrgs.length >= 1) {
        state.collectedOrgs = cOrgs;
        // Restore the user's last-viewed org (persisted by selectOrg) so reopening the
        // popup keeps their selection — including a non-Claude provider — instead of
        // snapping back to the pinned/primary (Claude) org. This is the popup VIEW only;
        // the toolbar badge / background still follow the pinned org (storage.sync).
        // Falls back to pinned → primary when there's no valid last-viewed org (e.g. that
        // org is gone, or first run).
        const lastViewed = result.lastViewedOrgId && cOrgs.find(o => o.uuid === result.lastViewedOrgId);
        if (lastViewed) {
          state.selectedOrgId = lastViewed.uuid;
        } else if (syncCfg.selectedOrgId) {
          const pinned = cOrgs.find(o => o.uuid === syncCfg.selectedOrgId);
          state.selectedOrgId = pinned ? pinned.uuid : (cOrgs.find(o => o.isPrimary)?.uuid || cOrgs[0]?.uuid || null);
        } else {
          const primary = cOrgs.find(o => o.isPrimary) || cOrgs[0];
          if (primary) state.selectedOrgId = primary.uuid;
        }
      }

      const status = result.lastStatus;
      updateUI(status);
      if (status) {
        state.currentPlan = status?.snapshot?.plan || null;
        state.currentSnapshot = status?.snapshot || null;
        loadFitnessMatrix();
      }
      // Render the selected provider org via selectOrg whenever a non-Claude org
      // is selected. This must run even when status is null/absent — independent
      // (email) users have no Claude lastStatus, so their gauge/charts would
      // otherwise never render.
      if (state.selectedOrgId && state.selectedOrgId !== status?.snapshot?.claude_org_uuid) {
        selectOrg(state.selectedOrgId, null);
      }
      // Initial primary-org render goes through _updateUICore (not selectOrg), so
      // point the static dashboard anchors at the org here too.
      refreshDashboardLinks(state.selectedOrgId);
      _statusReady = true;

      tryDrawCharts();
      initRunner();

      // Master-detail default view: multi-org/multi-provider users get the tab
      // switcher and land on their last-viewed screen (overview by default; detail
      // if that's where they left off). Single-account users see the detail view
      // directly with no tabs.
      const viewTabs = document.getElementById('view-tabs');
      if (state.collectedOrgs.length >= 2) {
        if (viewTabs) viewTabs.classList.remove('hidden');
        if (state.lastView === 'detail') {
          const orgId = (state.selectedOrgId && state.collectedOrgs.some(o => o.uuid === state.selectedOrgId))
            ? state.selectedOrgId
            : (state.collectedOrgs.find(o => o.isPrimary) || state.collectedOrgs[0]).uuid;
          enterDetail(orgId);
        } else {
          enterOverview();
        }
      } else if (viewTabs) {
        viewTabs.classList.add('hidden');
      }
    });
  });

  // Top tab switcher: 모아 보기 ↔ 자세히. The detail tab re-opens the last-viewed
  // org (or the primary) so it always has something to show.
  const tabOverview = document.getElementById('tab-overview');
  const tabDetail = document.getElementById('tab-detail');
  if (tabOverview) tabOverview.addEventListener('click', () => enterOverview());
  if (tabDetail) tabDetail.addEventListener('click', () => {
    const orgs = state.collectedOrgs || [];
    // Only honor selectedOrgId if it still exists — a live update may have removed
    // it, and entering a stale uuid would leave selectOrg() with no data to render.
    const valid = state.selectedOrgId && orgs.some(o => o.uuid === state.selectedOrgId);
    const orgId = valid ? state.selectedOrgId : (orgs.find(o => o.isPrimary) || orgs[0])?.uuid;
    if (orgId) enterDetail(orgId);
  });

  // Re-render popup immediately when language is changed in options
  chrome.storage.onChanged.addListener((changes, area) => {
    // Overview card order changed on another device (chrome.storage.sync): adopt it
    // and re-render the cards if the overview is currently visible.
    if (area === 'sync' && changes.overviewOrder) {
      state.overviewOrder = changes.overviewOrder.newValue || [];
      // Don't re-render mid-drag (would yank the card out from under the gesture);
      // dragend re-renders from the latest saved order anyway.
      if (isOverviewActive() && !isDragging()) renderOverview();
    }
    if (area === 'sync' && changes.lang) {
      setLang(changes.lang.newValue);
      // These set text imperatively via t() (not data-i18n), so re-render them on a live lang
      // switch (checkProviderPermissions rebuilds the banner via innerHTML='' — no double-bind).
      renderReauth();
      renderLoginCta();
      checkProviderPermissions();
      checkCapDrops();   // same reason — imperative t() text, rebuilt via innerHTML=''
      // Same reason: the sync-account note is imperative t() text with no data-i18n attribute.
      // It can't wait for the updateUI() below either — that only runs when lastStatus exists,
      // and provider-only (ChatGPT/Gemini) installs render from collectedOrgs with a null
      // lastStatus, so their note would keep the previous language until some other event.
      renderSyncAccountNote();
      // Full UI re-render including dynamically generated text
      chrome.storage.local.get({ lastStatus: null, usageHistory: [], collectedOrgs: [] }, (r) => {
        state.usageHistory = r.usageHistory || [];
        state.historyLoaded = true;
        if (r.lastStatus) {
          // Keep the currently-viewed org if it still exists (preserve a non-primary
          // detail target across a language change); otherwise fall back to primary.
          // A concrete uuid is required — null would mix multi-org histories.
          const cOrgs = r.collectedOrgs || [];
          if (cOrgs.length >= 1) state.collectedOrgs = cOrgs;
          const stillValid = state.selectedOrgId && state.collectedOrgs.some(o => o.uuid === state.selectedOrgId);
          const primary = state.collectedOrgs.find(o => o.isPrimary) || state.collectedOrgs[0];
          state.selectedOrgId = stillValid ? state.selectedOrgId : (primary ? primary.uuid : null);
          refreshDashboardLinks(state.selectedOrgId);
          updateUI(r.lastStatus);
          state.currentPlan = r.lastStatus?.snapshot?.plan || null;
          state.currentSnapshot = r.lastStatus?.snapshot || null;
          redrawDetail();
        }
        // Gauge window labels carry no data-i18n (ui/util.js applyGaugeWindowLabels strips it, or
        // applyI18n would put the static slot label back), so nothing above re-translates them:
        // _updateUICore() returns before the gauge branches for a selected non-primary/provider
        // org, redrawDetail() only redraws charts + banner, and a provider-only install has no
        // lastStatus at all so it never enters that branch. Re-apply from the org list, which is
        // the same source selectOrg() labels from. Outside the lastStatus block on purpose.
        const langSelOrg = (r.collectedOrgs || state.collectedOrgs || [])
          .find(o => o.uuid === state.selectedOrgId);
        if (langSelOrg) applyGaugeWindowLabels(langSelOrg.w5s, langSelOrg.w7s);
        // Re-render org chips too (reflects plan name translations, etc.)
        if (state.collectedOrgs.length >= 2) showMultiOrgBadges(state.collectedOrgs);
        // Re-render overview cards (title + countdown strings are i18n).
        if (isOverviewActive()) renderOverview();
        loadFitnessMatrix();
      });
      // Notices and ads are LANGUAGE-TARGETED, not merely translated: a notice carries a
      // `lang` field and an ad campaign targets a lang, so switching language changes WHICH
      // items are eligible — re-rendering the ones already picked is not enough.
      // loadPopupAnnouncements re-reads getLang() (setLang above already updated it) and
      // re-runs both selections. The three sidebars already do this via fetchAds() on the
      // same event; the popup was the one that didn't, so its ad stayed in the previous
      // language until the popup was reopened.
      loadPopupAnnouncements();
    }
  });

  // Auto-refresh on background collection success (while side panel/popup is open)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    // Sync theme when changed from options page
    if (changes['ct-theme']) {
      const pref = changes['ct-theme'].newValue || 'system';
      const resolved = pref === 'system'
        ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : pref;
      document.documentElement.setAttribute('data-theme', resolved);
      updateThemeBtn(pref);
    }

    // Team onboarding context updated from welcome page
    if (changes.onboardOrgName) {
      state.onboardOrgName = changes.onboardOrgName.newValue || null;
      updateUI(state.lastUpdateUIStatus);
    }

    // Immediately refresh org chips when collectedOrgs changes
    if (changes.collectedOrgs) {
      state.collectedOrgs = changes.collectedOrgs.newValue || [];
      const viewTabs = document.getElementById('view-tabs');
      if (state.collectedOrgs.length >= 2) {
        showMultiOrgBadges(state.collectedOrgs);
        if (viewTabs) viewTabs.classList.remove('hidden');
        // If the overview is on screen, re-render its cards with the fresh data;
        // otherwise just refresh the open detail view (without switching).
        if (isOverviewActive()) {
          renderOverview();
        } else if (state.selectedOrgId) {
          selectOrg(state.selectedOrgId, null);
        }
        // Tabs may have just been unhidden (single→multi) without going through
        // enter{Overview,Detail}; mark the active tab to match the visible view.
        syncViewTabs();
      } else {
        // Orgs dropped to single — leave the overview, remove stale chip DOM, reset to primary
        if (viewTabs) viewTabs.classList.add('hidden');
        const existingChips = document.getElementById('org-chips');
        if (existingChips) existingChips.remove();
        const existingBadge = document.getElementById('org-badge');
        if (existingBadge) existingBadge.remove();
        const primary = state.collectedOrgs[0];
        if (primary) {
          enterDetail(primary.uuid);
        } else {
          // Zero orgs (e.g. account reset / sign-out): leave the overview so the
          // no-data / onboarding shell rendered by updateUI() below is visible —
          // without this the body stays in overview mode and freezes the screen.
          exitOverview();
          refreshDashboardLinks(null); // no org → plain dashboard
        }
      }
      // Re-render the status UI with the newly-arrived org data. Without this,
      // a provider-only (e.g. Gemini) collection that completes while the panel
      // is open never re-runs the provider-only / demote / onboarding / footer-
      // email decisions in _updateUICore — they were evaluated on the first
      // paint when state.collectedOrgs was still empty, leaving a stale "Claude
      // collection failed" banner + onboarding + missing footer email until the
      // panel is reopened. The lastStatus handler below returns early when only
      // collectedOrgs changed, so this is the sole re-render trigger then.
      updateUI(state.lastUpdateUIStatus);
    }

    // Live-apply the extra-usage card visibility toggled from the Options page,
    // so the open side panel reflects it immediately (no reopen needed).
    if (changes.hiddenExtraUsage) {
      if (changes.hiddenExtraUsage.newValue) {
        // Hide instantly without a full re-render (non-disruptive).
        const sec = document.getElementById('extra-usage-section');
        if (sec) sec.style.display = 'none';
      } else if (state.collectedOrgs?.length >= 2 && state.selectedOrgId) {
        // Re-render the currently-viewed org so its card repopulates + shows.
        selectOrg(state.selectedOrgId, null);
      } else if (state.lastUpdateUIStatus) {
        updateUI(state.lastUpdateUIStatus);
      }
    }

    if (!changes.lastStatus) return;
    const status = changes.lastStatus.newValue;
    if (status) queueStatusRender(status);
  });

  // Manual collection button
  document.getElementById('collect-btn').addEventListener('click', () => {
    const btn = document.getElementById('collect-btn');
    btn.disabled = true;
    btn.classList.add('loading');
    btn.textContent = t('collecting');

    chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' }, (result) => {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.textContent = t('btn_collect');
      // Reset onboarding CTA
      const obBtn = document.getElementById('ob-collect-btn');
      if (obBtn) { obBtn.disabled = false; obBtn.textContent = t('ob_cta'); }

      if (chrome.runtime.lastError) {
        showError(t('cancel_fail'));
        return;
      }

      // Update UI with saved lastStatus — single callback to avoid race conditions
      chrome.storage.local.get({ lastStatus: null, usageHistory: [], collectedOrgs: [] }, (r) => {
        state.usageHistory = r.usageHistory || [];
        state.historyLoaded = true;
        state.collectedOrgs = r.collectedOrgs || [];
        const s = r.lastStatus;
        if (s) {
          updateUI(s);
          state.currentPlan = s?.snapshot?.plan || null;
          state.currentSnapshot = s?.snapshot || null;
        }

        // Refresh org chips
        if (result && result.success) {
          if (!state.orgList) loadOrgSelector();
          if (state.collectedOrgs.length >= 2) {
            showMultiOrgBadges(state.collectedOrgs);
          }
          chrome.storage.local.remove('fitnessCache', () => loadFitnessMatrix());
        }

        // Non-Claude org: selectOrg is called from collectedOrgs onChange; skip chart/banner
        if (!state.selectedOrgId || state.selectedOrgId === s?.snapshot?.claude_org_uuid) {
          redrawDetail();
        }
      });
    });
  });

  // Onboarding CTA button -> start collection
  document.getElementById('ob-collect-btn').addEventListener('click', () => {
    document.getElementById('collect-btn').click();
    const obBtn = document.getElementById('ob-collect-btn');
    obBtn.disabled = true;
    obBtn.textContent = t('ob_collecting');
  });

  // Side panel / popup mode switch
  const openTabBtn = document.getElementById('open-tab-btn');

  // Side panel pin hint (one-time)
  chrome.storage.local.get({ pinHintDismissed: false, preferSidePanel: true, lastStatus: null }, (ph) => {
    if (ph.preferSidePanel && !ph.pinHintDismissed) {
      const pinHint = document.getElementById('pin-hint');
      const pinText = document.getElementById('pin-hint-text');
      if (pinHint && pinText) {
        const pinSvg = '<svg width="14" height="14" viewBox="0 0 24 24" style="vertical-align:-3px"><path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" fill="none" stroke="#5b21b6" stroke-width="1.5"/></svg>';
        pinText.innerHTML = t('pin_hint_text_html').replace('{pin}', pinSvg);
        // Show badge with actual utilization
        const snap = ph.lastStatus?.snapshot;
        const badgeEl = document.getElementById('pin-hint-badge');
        if (badgeEl && snap) {
          const util = Math.round(Math.max(snap.five_hour?.utilization || 0, snap.seven_day?.utilization || 0));
          badgeEl.textContent = util + '%';
        }
        const beforeEl = document.getElementById('pin-hint-before');
        const afterEl = document.getElementById('pin-hint-after');
        if (beforeEl) beforeEl.textContent = t('pin_hint_before');
        if (afterEl) afterEl.textContent = t('pin_hint_after');
        pinHint.style.display = 'block';
        document.getElementById('pin-hint-close').addEventListener('click', () => {
          pinHint.style.display = 'none';
          chrome.storage.local.set({ pinHintDismissed: true });
        });
      }
    }
  });

  // Determine mode based on preferSidePanel
  chrome.storage.local.get({ preferSidePanel: true }, (r) => {
    if (r.preferSidePanel) {
      // Side panel mode: "Switch to popup" button
      openTabBtn.title = t('btn_back_popup') || 'Switch to popup';
      openTabBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm10 0v12h3V4h-3zM4 4v12h7V4H4z" clip-rule="evenodd"/></svg>';
      openTabBtn.addEventListener('click', async () => {
        await chrome.storage.local.set({ preferSidePanel: false });
        chrome.runtime.sendMessage({ type: 'SET_SIDE_PANEL_MODE', enabled: false });
        // Show toast, fade out, then close
        const toast = document.createElement('div');
        toast.textContent = t('toast_popup_next') || 'Next time it will open as a popup';
        toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#312e81;color:white;padding:10px 20px;border-radius:8px;font-size:12px;font-weight:600;z-index:9999;transition:opacity 0.5s;white-space:nowrap;';
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; }, 1200);
        setTimeout(() => { window.close(); }, 1800);
      });
    } else {
      // Popup mode: hide switch button if sidePanel API is unavailable (e.g. Arc)
      if (!(chrome.sidePanel && chrome.sidePanel.open)) {
        openTabBtn.style.display = 'none';
      } else {
        openTabBtn.addEventListener('click', async () => {
          try {
            const win = await chrome.windows.getCurrent();
            await chrome.sidePanel.open({ windowId: win.id });
            await chrome.storage.local.set({ preferSidePanel: true });
            chrome.runtime.sendMessage({ type: 'SET_SIDE_PANEL_MODE', enabled: true });
            window.close();
          } catch (e) {
            chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
          }
        });
      }
    }
  });

  // Open settings page
  document.getElementById('options-btn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Chart tab switching
  document.querySelectorAll('.chart-tab').forEach(tab => {
    if (tab.id === 'chart-autoroll-btn') {
      // Play/Pause toggle button
      tab.addEventListener('click', (e) => {
        e.stopPropagation();
        _toggleChartAutoRoll();
      });
    } else if (tab.id === 'chart-yaxis-btn') {
      // Y-axis auto / 100% toggle button
      tab.addEventListener('click', (e) => {
        e.stopPropagation();
        _toggleChartYAxis();
      });
    } else {
      // 5h/7d tab manual click
      tab.addEventListener('click', (e) => {
        e.stopPropagation();
        _switchChartTab(tab.dataset.tab);
        // Reset timer if auto-rolling on manual click
        if (isChartAutoRoll() && isChartRolling()) {
          _stopChartAutoRoll();
          _startChartAutoRoll();
        }
      });
    }
  });
  // Chart card click opens dashboard (deep-linked to the viewed org)
  document.getElementById('chart-section').addEventListener('click', () => {
    chrome.tabs.create({ url: dashboardUrl(state.selectedOrgId) });
  });

  // Smart recommendation dismiss button
  document.getElementById('smart-rec-dismiss').addEventListener('click', () => {
    // Dismiss/mute are Claude-only (the button is hidden for other providers in ui/recommend.js).
    // Guard the handler too, like the execute button below: a synthetic click, or a delayed
    // DISMISS callback landing after the user switched to a ChatGPT org, must not stamp
    // "current_plan_ok" onto the now-visible ChatGPT rec.
    if ((state.recProvider || 'claude') !== 'claude') return;
    chrome.runtime.sendMessage({ type: 'DISMISS_RECOMMENDATION' }, () => {
      document.getElementById('smart-rec-detail').classList.add('hidden');
      document.getElementById('smart-rec-mute').classList.add('hidden');
      document.getElementById('recommendation').textContent = t('current_plan_ok');
      document.getElementById('recommendation').style.color = 'var(--text-primary)';
      chrome.storage.local.get({ lastStatus: {} }, (r) => {
        const rt = r.lastStatus?.recommendation?.type;
        if (rt) showRecFeedback(rt);
      });
    });
  });

  // Smart recommendation permanent mute button
  document.getElementById('smart-rec-mute').addEventListener('click', () => {
    if ((state.recProvider || 'claude') !== 'claude') return; // Claude-only, same as dismiss above
    chrome.runtime.sendMessage({ type: 'MUTE_RECOMMENDATION' }, () => {
      document.getElementById('smart-rec-detail').classList.add('hidden');
      document.getElementById('smart-rec-mute').classList.add('hidden');
      document.getElementById('recommendation').textContent = t('current_plan_ok');
      document.getElementById('recommendation').style.color = 'var(--text-primary)';
    });
  });

  // The plan confirmation modal is shared by every surface that can trigger a Claude plan change,
  // because it is the ONLY surface that states an upgrade bills the card on the spot (#820, and
  // inquiry #182 before it). Callers supply the numbers and the action; the copy, the colours and
  // the direction logic live here once so the two entry points cannot drift apart.
  // `_planConfirmAction` is the pending caller's action — the single #src-modal-confirm listener
  // dispatches to it, so adding a third caller means calling openPlanConfirmModal(), never wiring
  // a new confirm handler.
  let _planConfirmAction = null;

  function openPlanConfirmModal({ fromPlan, toPlan, isUpgrade, fromCost, toCost, costDiff, onConfirm }) {
    document.getElementById('src-modal-title').textContent = t(isUpgrade ? 'confirm_upgrade_title' : 'confirm_downgrade_title');
    document.getElementById('src-modal-plan').textContent = t('confirm_plan_change', fromPlan || '', toPlan || '');

    const costEl = document.getElementById('src-modal-cost');
    if (fromCost != null && toCost != null) {
      costEl.textContent = isUpgrade
        ? t('opt_cost_up', fromCost, toCost, costDiff)
        : t('opt_cost_down', fromCost, toCost, costDiff);
    } else {
      costEl.textContent = '';
    }

    document.getElementById('src-modal-timing').textContent = t(isUpgrade ? 'confirm_timing_immediate' : 'confirm_timing_renewal');
    // Direction-specific, because only ONE of these two moves money. The shared line said the
    // plan would change but never that a card would be charged, which is what inquiry #182 hit:
    // an upgrade bills on the spot and is hard to unwind, a downgrade waits for the renewal and
    // bills nothing now. Red for the charging one, amber for the other — the severity IS the
    // difference between them, so it cannot be a constant.
    // Dark mode takes the lighter red (#dc2626 on the dark card is ~4:1 — the one line that must
    // not be skimmed should not be the hardest to read), matching how popup.html pairs its reds.
    const warnEl = document.getElementById('src-modal-warning');
    warnEl.textContent = t(isUpgrade ? 'confirm_warning_upgrade' : 'confirm_warning');
    warnEl.style.color = isUpgrade ? (_isDark() ? '#fca5a5' : '#dc2626') : '#d97706';

    const confirmBtn = document.getElementById('src-modal-confirm');
    confirmBtn.textContent = t(isUpgrade ? 'confirm_upgrade_btn' : 'confirm_downgrade_btn');
    confirmBtn.style.background = isUpgrade ? '#059669' : '#d97706';
    confirmBtn.disabled = false;
    confirmBtn.classList.remove('loading');

    document.getElementById('src-modal-cancel').textContent = t('confirm_cancel');

    _planConfirmAction = onConfirm;
    document.getElementById('smart-rec-confirm-modal').style.display = 'flex';
  }

  // Every dismissal path funnels here. Clearing the action matters: leaving it set would let a
  // later stray confirm click execute the plan change the user just backed out of.
  function closePlanConfirmModal() {
    document.getElementById('smart-rec-confirm-modal').style.display = 'none';
    _planConfirmAction = null;
  }

  // Smart recommendation execute button — show confirmation modal
  document.getElementById('smart-rec-btn').addEventListener('click', () => {
    // Plan-change execution is Claude-only. The button is already hidden for other providers
    // (ui/recommend.js); this second check makes a stale/injected click a no-op rather than a
    // claude.ai plan change triggered by a ChatGPT recommendation.
    if ((state.recProvider || 'claude') !== 'claude') return;
    chrome.storage.local.get({ lastStatus: {} }, (result) => {
      const recommendation = result.lastStatus?.recommendation;
      if (!recommendation?.type) return;

      openPlanConfirmModal({
        fromPlan: recommendation.from_plan,
        toPlan: recommendation.to_plan,
        isUpgrade: recommendation.type === 'upgrade',
        fromCost: recommendation.from_cost,
        toCost: recommendation.to_cost,
        costDiff: recommendation.cost_diff,
        onConfirm: () => _executeRecommendedPlanChange(),
      });
    });
  });

  // Confirmation modal — confirm button. Dispatches to whichever caller opened the modal; it must
  // stay a pure dispatcher so no execution path can bypass openPlanConfirmModal().
  document.getElementById('src-modal-confirm').addEventListener('click', () => {
    const action = _planConfirmAction;
    if (!action) return; // modal open with no pending action (stale/injected click) — do nothing
    const confirmBtn = document.getElementById('src-modal-confirm');
    confirmBtn.disabled = true;
    confirmBtn.classList.add('loading');
    confirmBtn.textContent = t('changing');
    action();
  });

  function _executeRecommendedPlanChange() {
    const confirmBtn = document.getElementById('src-modal-confirm');

    const btn = document.getElementById('smart-rec-btn');
    btn.disabled = true;

    chrome.storage.local.get({ lastStatus: {} }, (result) => {
      const recommendation = result.lastStatus?.recommendation;
      if (!recommendation?.type) { closePlanConfirmModal(); btn.disabled = false; return; }

      chrome.runtime.sendMessage({ type: 'EXECUTE_PLAN_CHANGE', recommendation }, (res) => {
        closePlanConfirmModal();
        confirmBtn.disabled = false;
        confirmBtn.classList.remove('loading');
        btn.disabled = false;
        if (res?.success) {
          // Hide entire recommendation section after successful plan change
          state.lastRecommendation = null;
          state.planChangedTo = recommendation.to_plan || recommendation.toPlan;
          document.getElementById('smart-rec-detail').classList.add('hidden');
          document.getElementById('smart-rec-btn').classList.add('hidden');
          document.getElementById('smart-rec-dismiss').classList.add('hidden');
          document.getElementById('smart-rec-mute').classList.add('hidden');
          document.getElementById('recommendation').textContent = t('change_done');
          document.getElementById('recommendation').style.color = '#059669';
          // Clear recommendation from storage so it won't reappear on popup reopen
          chrome.storage.local.get({ lastStatus: {} }, (s) => {
            const ls = s.lastStatus || {};
            delete ls.recommendation;
            chrome.storage.local.set({ lastStatus: ls });
          });
          showRecFeedback(recommendation.type);
        } else {
          btn.textContent = t('opt_execute');
          showError(res?.error || t('collect_fail'));
        }
      });
    });
  }

  // Confirmation modal — cancel button
  document.getElementById('src-modal-cancel').addEventListener('click', () => {
    closePlanConfirmModal();
  });

  // Confirmation modal — backdrop click to close
  document.getElementById('smart-rec-confirm-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePlanConfirmModal();
  });

  // Confirmation modal — ESC key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('smart-rec-confirm-modal');
      if (modal.style.display !== 'none') closePlanConfirmModal();
    }
  });

  // Render plan change order banner.
  //
  // Deliberately NOT gated on the primary org's provider. It used to be ("plan orders are
  // Claude-specific"), which was harmless only while the notification's Accept button executed the
  // order by itself. Now that Accept routes here (#820), that gate became a dead end: a user with a
  // ChatGPT/Gemini org pinned primary would get the notification, click Accept, land on a popup
  // that renders nothing, and have no way to accept or reject — the notification is already
  // cleared by then, and no result is ever reported to the server. (Codex.)
  //
  // The gate was also redundant. `pendingPlanOrder` is only ever set from a plan order the server
  // attached for THIS user (bg/collect.js), and orders are Claude-only, so its presence already
  // proves the user has a Claude org. The order itself is the signal — which provider happens to
  // be pinned primary in the popup is unrelated.
  chrome.storage.local.get({ pendingPlanOrder: null, completedPlanOrder: null }, (store) => {
    const po = store.pendingPlanOrder;
    const completed = store.completedPlanOrder;
    if (po) {
      const banner = document.getElementById('plan-order-banner');
      banner.classList.remove('hidden');
      banner.dataset.po = JSON.stringify(po);
      document.getElementById('plan-order-body').innerHTML =
        `<strong>${po.org_name}</strong> ${t('plan_order_admin')}(${po.requested_by_name})<br>` +
        `<strong>${po.from_plan} → ${po.to_plan}</strong> ${t('plan_order_request')}`;
      if (po.reason) {
        const reasonEl = document.getElementById('plan-order-reason');
        reasonEl.classList.remove('hidden');
        reasonEl.textContent = '💬 ' + po.reason;
      }
      const fromCost = PLAN_MONTHLY_COST_USD[po.from_plan] || 0;
      const toCost = PLAN_MONTHLY_COST_USD[po.to_plan] || 0;
      const diff = toCost - fromCost;
      const diffStr = diff > 0 ? `+$${diff}` : `-$${Math.abs(diff)}`;
      document.getElementById('plan-order-cost').textContent = `$${fromCost}/${t('month_short')} → $${toCost}/${t('month_short')} (${diffStr})`;
    } else if (completed && Date.now() - completed.completedAt < 3600000) {
      // Order completed within the last hour — success notice
      const isUp = PLAN_HIERARCHY.indexOf(completed.to_plan) > PLAN_HIERARCHY.indexOf(completed.from_plan);
      let dDesc = t('plan_downgrade_desc');
      if (!isUp && state.currentSnapshot?.subscription?.renewal_date) {
        const rd = new Date(state.currentSnapshot.subscription.renewal_date);
        dDesc = t('plan_downgrade_desc_date', `${rd.getMonth() + 1}/${rd.getDate()}`);
      }
      const el = document.getElementById('plan-order-completed');
      el.classList.remove('hidden');
      el.style.background = '#f0fdf4';
      el.style.borderColor = '#bbf7d0';
      document.getElementById('plan-order-completed-body').innerHTML =
        `<div style="font-size:13px;font-weight:600;margin-bottom:4px">✅ ${completed.to_plan}${isUp ? t('plan_changed_now') : t('plan_changed_scheduled')}</div>` +
        `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">${isUp ? t('plan_upgrade_desc') : dDesc}</div>` +
        `<a href="https://claude.ai/settings/billing" target="_blank" style="font-size:11px;color:var(--accent);text-decoration:none;font-weight:500">${t('plan_check_settings')} →</a>`;
    }
  });

  // Plan change order accept/reject buttons.
  // An admin-ordered upgrade calls the same upgrade_to_max as a recommendation-driven one and is
  // billed by Anthropic on the spot, so it goes through the same confirmation modal (#820). The
  // banner shows the cost, but showing a number is not the same as making the user acknowledge a
  // charge — the modal is the surface that says "you are being charged now".
  document.getElementById('plan-order-accept').addEventListener('click', () => {
    const _po = (() => { try { return JSON.parse(document.getElementById('plan-order-banner').dataset.po || '{}'); } catch { return {}; } })();
    if (!_po.to_plan || !_po.from_plan) return;
    const fromCost = PLAN_MONTHLY_COST_USD[_po.from_plan];
    const toCost = PLAN_MONTHLY_COST_USD[_po.to_plan];
    openPlanConfirmModal({
      fromPlan: _po.from_plan,
      toPlan: _po.to_plan,
      isUpgrade: PLAN_HIERARCHY.indexOf(_po.to_plan) > PLAN_HIERARCHY.indexOf(_po.from_plan),
      fromCost, toCost,
      // The i18n templates already carry the sign ('+${2}' / 'save ${2}'), so pass the magnitude.
      costDiff: (fromCost != null && toCost != null) ? Math.abs(toCost - fromCost) : null,
      onConfirm: () => _acceptPlanOrder(_po),
    });
  });

  function _acceptPlanOrder(_po) {
    const btn = document.getElementById('plan-order-accept');
    btn.disabled = true;
    btn.textContent = t('changing') || '변경 중...';
    chrome.runtime.sendMessage({ type: 'RESPOND_PLAN_ORDER', action: 'accept' }, (res) => {
      closePlanConfirmModal();
      if (res?.success) {
        const isUpgrade = PLAN_HIERARCHY.indexOf(_po.to_plan) > PLAN_HIERARCHY.indexOf(_po.from_plan);
        const banner = document.getElementById('plan-order-banner');
        // Switch banner to success notice
        const _isDk = document.documentElement.dataset.theme === 'dark';
        banner.style.background = _isDk ? '#052e16' : '#f0fdf4';
        banner.style.borderColor = _isDk ? '#166534' : '#bbf7d0';
        const body = document.getElementById('plan-order-body');
        let downgradeDesc = t('plan_downgrade_desc');
        if (!isUpgrade && state.currentSnapshot?.subscription?.renewal_date) {
          const rd = new Date(state.currentSnapshot.subscription.renewal_date);
          downgradeDesc = t('plan_downgrade_desc_date', `${rd.getMonth() + 1}/${rd.getDate()}`);
        }
        body.innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:4px">✅ ${_po.to_plan || ''}${isUpgrade ? t('plan_changed_now') : t('plan_changed_scheduled')}</div>` +
          `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">${isUpgrade ? t('plan_upgrade_desc') : downgradeDesc}</div>` +
          `<a href="https://claude.ai/settings/billing" target="_blank" style="font-size:11px;color:var(--accent);text-decoration:none;font-weight:500">${t('plan_check_settings')} →</a>`;
        // Hide buttons
        document.getElementById('plan-order-accept').style.display = 'none';
        document.getElementById('plan-order-reject').style.display = 'none';
        const reasonEl = document.getElementById('plan-order-reason');
        if (reasonEl) reasonEl.style.display = 'none';
        const costEl = document.getElementById('plan-order-cost');
        if (costEl) costEl.style.display = 'none';
        // Close banner after 10 seconds
        setTimeout(() => banner.classList.add('hidden'), 10000);
      } else if (res?.error === 'Plan already changed externally') {
        // Plan was already changed — hide the stale banner
        document.getElementById('plan-order-banner').classList.add('hidden');
        showError(t('plan_already_changed') || 'Plan already changed');
      } else {
        btn.disabled = false;
        btn.textContent = t('plan_order_accept');
        showError(res?.error || t('collect_fail'));
      }
    });
  }
  document.getElementById('plan-order-reject').addEventListener('click', () => {
    document.getElementById('plan-order-banner').classList.add('hidden');
    chrome.runtime.sendMessage({ type: 'RESPOND_PLAN_ORDER', action: 'reject' });
  });

  // Cancel downgrade button
  document.getElementById('cancel-downgrade-btn').addEventListener('click', () => {
    const btn = document.getElementById('cancel-downgrade-btn');
    btn.disabled = true;
    btn.textContent = t('cancelling');

    chrome.runtime.sendMessage({ type: 'CANCEL_DOWNGRADE' }, (res) => {
      if (chrome.runtime.lastError) {
        btn.disabled = false;
        btn.textContent = t('cancel_downgrade');
        showError(t('cancel_fail') + ': ' + chrome.runtime.lastError.message);
        return;
      }
      btn.disabled = false;
      if (res?.success) {
        document.getElementById('cancel-downgrade-wrap').style.display = 'none';
        document.getElementById('pending-row').classList.add('hidden');
        chrome.storage.local.remove('hiddenDowngradePlan');
        showSuccess(t('downgrade_cancelled'));
        chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' });
      } else {
        btn.textContent = t('cancel_downgrade');
        showError(res?.error || t('collect_fail'));
      }
    });
  });

  // Hide downgrade button (dismiss)
  document.getElementById('hide-downgrade-btn').addEventListener('click', (e) => {
    e.preventDefault();
    const pendingPlan = state.currentSnapshot?.subscription?.pending_plan;
    if (pendingPlan) {
      chrome.storage.local.set({ hiddenDowngradePlan: pendingPlan });
    }
    document.getElementById('cancel-downgrade-wrap').style.display = 'none';
  });

  // Privacy banner dismiss
  document.getElementById('privacy-dismiss').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.storage.local.set({ hiddenPrivacyBanner: true });
    document.getElementById('privacy-row').classList.add('hidden');
  });

  // Extra usage card hide (×) — restorable from Options
  const extraHideBtn = document.getElementById('extra-usage-hide');
  if (extraHideBtn) {
    extraHideBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.storage.local.set({ hiddenExtraUsage: true });
      const sec = document.getElementById('extra-usage-section');
      if (sec) sec.style.display = 'none';
      showSuccess(t('extra_usage_hidden_toast'));
    });
  }

  // Downgrade test button
  function setupDowngradeBtn(btnId, targetPlan) {
    document.getElementById(btnId).addEventListener('click', () => {
      const btn = document.getElementById(btnId);
      const statusEl = document.getElementById('plan-action-status');
      btn.disabled = true;
      statusEl.textContent = t('changing');
      statusEl.style.color = '#9a3412';

      chrome.runtime.sendMessage({ type: 'DOWNGRADE_TO', targetPlan }, (res) => {
        btn.disabled = false;
        if (chrome.runtime.lastError) {
          statusEl.textContent = t('cancel_fail');
          statusEl.style.color = '#dc2626';
          return;
        }
        if (res?.success) {
          statusEl.textContent = `${res.from} → ${res.to}`;
          statusEl.style.color = '#059669';
          setTimeout(() => {
            chrome.runtime.sendMessage({ type: 'GET_STATUS' }, updateUI);
          }, 2000);
        } else {
          statusEl.textContent = res?.error || t('collect_fail');
          statusEl.style.color = '#dc2626';
        }
      });
    });
  }
  setupDowngradeBtn('downgrade-5x-btn', 'max_5x_monthly');
  setupDowngradeBtn('downgrade-pro-btn', 'pro_monthly');

  // Review nudge check
  checkReviewNudge();
});

// === Review Nudge (server-based) ===


// === Recommendation Feedback Toast ===

// === Recommendation rendering helper (shared by updateUI + selectOrg) ===

// === UI Update ===

// One-time nudge toward the web dashboard, shown right after a successful
// collection. Dashboard reach is the strongest retention signal for new users
// (esp. overseas: reachers churn ~4.9% vs ~19% for non-reachers), but the popup
// hides its onboarding block on success, leaving no prominent path. Show this
// up to a few times, then stop; any interaction (open or dismiss) ends it.

// Debounced wrapper: collapses rapid-fire updateUI calls (e.g. lastStatus + collectedOrgs changes)
function updateUI(status) {
  state.lastUpdateUIStatus = status;
  if (state.updateUITimer) clearTimeout(state.updateUITimer);
  state.updateUITimer = setTimeout(() => {
    state.updateUITimer = null;
    _updateUICore(state.lastUpdateUIStatus);
    // Single call site on purpose: _updateUICore has six early returns (independent /
    // provider-only / no-data / error paths), so calling this from inside it would need a call
    // per branch and the next branch added would silently strand a stale note on screen.
    // Derives the account itself and hides itself when there is nothing to say.
    renderSyncAccountNote();
  }, 50);
}


// === Gauge prediction markers ===
// === Common prediction function: projected utilization at reset ===

// These two overwrite the status line from outside the render (action confirmations, failures),
// so they must drop the tooltip the render may have attached — otherwise a "취소되었습니다" toast
// keeps a hover that says the install is local-only. (Codex, PR #948.)
function showError(msg) {
  document.getElementById('status-indicator').className = 'status-dot red';
  // Translate if i18n key, otherwise display as-is
  const translated = msg && msg.startsWith('err_') ? t(msg) : msg;
  const el = document.getElementById('status-text');
  el.textContent = translated;
  el.title = '';
}

function showSuccess(msg) {
  document.getElementById('status-indicator').className = 'status-dot green';
  const el = document.getElementById('status-text');
  el.textContent = msg;
  el.title = '';
}


