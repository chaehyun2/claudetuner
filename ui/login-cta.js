// The login call-to-action card and its collapsed reminder bar.
// Moved verbatim out of popup.js (#1126); only the `export` keywords and these imports are new.
import { noteSurface } from '../bg/block-state.js';
import { getProviderState, collectingAccounts } from '../bg/provider-state.js';
import { sendCodeReasonFromMessage, sendCodeErrorCopy, verifyCodeErrorCopy } from '../bg/send-code-error.js';
import { serverSyncWithheldReason } from '../bg/storage.js';
import { noteCtaShown, AUTH_BLOCKED_MARKER, bindCodeInput, mountGoogleButton } from './auth-widgets.js';

export async function renderLoginCta() {
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
  // 🔴 Name the account that is about to be attributed. Logging in here does NOT ask which
  // provider account to take — the server mints for whoever authenticates and, per THE RULE in
  // bg/storage.js, everything this install collects then belongs to them. That is right for the
  // owner of the machine and wrong for a shared one, where the Claude session may be someone
  // else's. The page-initiated handoff asks a question in that case; the popup cannot (a login
  // that interrogates you is worse than the gate it exists to lift), so it discloses instead.
  const attribEl = document.getElementById('login-cta-attrib');
  if (attribEl) {
    // 🔴 EVERY provider being collected, named at COLLECTION time (#1038). This used to read
    // `accountCache?.email` — an 8-hour Claude profile cache — which was wrong three ways at once:
    // it went stale across an account switch, it was empty on a fresh install that had already
    // started collecting, and it could only ever say "Claude" while a login absorbs ChatGPT and
    // Gemini too. The disclosure exists so a login does not take accounts the user was never told
    // about, so naming a subset is the same failure as naming the wrong one.
    // bg/provider-state.js owns the freshness rule; a provider that is not currently collecting is
    // omitted rather than guessed at.
    // 🔴 INTERSECTED WITH "would we still collect it". A recorded success survives its provider
    // being switched off or having its host permission revoked, so for up to COLLECTING_TTL_MS the
    // store still says "chatgpt: collecting" about a provider that no longer is — and the sentence
    // this feeds is present tense (Codex round 4). Claude has no toggle and no optional permission,
    // so only the two optional providers are filtered.
    const sync = await chrome.storage.sync.get({ collectChatGPT: true, collectGemini: true });
    const stillOn = { claude: true, chatgpt: sync.collectChatGPT !== false, gemini: sync.collectGemini !== false };
    const ORIGINS = { chatgpt: ['https://chatgpt.com/*'], gemini: ['https://gemini.google.com/*'] };
    const accounts = [];
    for (const a of collectingAccounts(await getProviderState())) {
      if (!stillOn[a.provider]) continue;
      if (ORIGINS[a.provider]) {
        // A revoked host permission stops collection just as hard as the toggle does.
        const granted = await chrome.permissions.contains({ origins: ORIGINS[a.provider] }).catch(() => true);
        if (!granted) continue;
      }
      accounts.push(a);
    }
    if (accounts.length) {
      // Built as DOM NODES, not a string — the addresses get their own colour so the sentence can
      // be scanned for "which accounts" without reading it whole (four lines of dense text was
      // hard to parse). 🔴 `innerHTML` is not an option here: these addresses come from the
      // providers, i.e. off the wire, and this box is the one place we deliberately show them.
      // Every value goes in through textContent/createTextNode, so there is no markup path at all
      // — which also means no `{0}` string interpolation to hijack (the sibling prompt in
      // site/shared/ext-detect.js had exactly that bug).
      attribEl.textContent = '';
      const parts = (t('login_cta_attrib') || '').split('{0}');
      const add = (txt, css) => {
        if (!txt) return;
        if (!css) { attribEl.appendChild(document.createTextNode(txt)); return; }
        const el = document.createElement('span');
        el.textContent = txt;
        el.style.cssText = css;
        attribEl.appendChild(el);
      };
      add(parts[0]);
      accounts.forEach((a, i) => {
        if (i) add(' · ', 'color:var(--text-muted)');
        add(`${a.label} `);
        // --accent is defined for BOTH themes (light #4f46e5 / dark #818CF8), so this stays
        // readable on the subtle grey box either way. A hard-coded hue would not.
        add(a.account, 'color:var(--accent);font-weight:600');
      });
      // A copy without the placeholder would otherwise silently drop the account list. Falls back
      // to appending it, so a bad translation loses the sentence shape but never the disclosure.
      add(parts.length > 1 ? parts.slice(1).join('{0}') : '');
      attribEl.style.display = '';
    } else {
      attribEl.style.display = 'none';
    }
  }
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
      } else {
        // See the re-auth widget above: lastError is read inside the callback, and the reason →
        // copy step lives in bg/send-code-error.js rather than here (#1172).
        const copy = sendCodeErrorCopy(sendCodeReasonFromMessage(res, chrome.runtime.lastError));
        status.textContent = t(copy.key) || copy.fallback;
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
