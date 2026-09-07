// Login primitives shared by the three auth surfaces in this popup.
// Moved verbatim out of popup.js (#1126); only the `export` keywords and these imports are new.

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
export function noteCtaShown(kind, reason) {
  if (_ctaShownSent.has(kind)) return;
  _ctaShownSent.add(kind);
  try {
    // Classic global from analytics.js (loads before this module). Absent in tests//older builds.
    if (typeof sendGAEvent === 'function') sendGAEvent('login_cta_shown', { kind, reason });
  } catch (_) { /* telemetry must never break the popup */ }
}
// Phase 2 단계 4 login-first CTA — shown to a FRESH, not-logged-in install (showLoginPrompt set
// by the gated collection). Additive: usage already renders locally; logging in unlocks the
// server-backed features (multi-browser merge, plan rec, trends, Wrapped, team). Unlike the
// re-auth widget it has no known email, so it collects one (pre-filled from the detected
// provider email when available). Dismiss = stay local-only (still gated, just no more nag).
// scopeCtaShownFor value used by the email-provider block (see below): a fixed marker, because
// that block is defined by the ABSENCE of a token and so has no token tail to fingerprint.
export const AUTH_BLOCKED_MARKER = 'auth-blocked';

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
export function bindCodeInput(input, doVerify) {
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
export function mountGoogleButton(slot, { statusEl, successKey, successFallback }) {
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
