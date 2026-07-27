// popup.js is the ES-module orchestrator (see popup.html). Domains live in ui/*.js.
import { drawCharts, _switchChartTab, _startChartAutoRoll, _stopChartAutoRoll, _toggleChartAutoRoll, _toggleChartYAxis, isChartAutoRoll, isChartRolling } from './ui/charts.js';
import { renderStatusBanner, initRunner } from './ui/prediction.js';
import { state, _filteredHistory, isDetailHidden } from './ui/state.js';
import { extTokenEmail } from './bg/ext-token-claims.js';
import { dashboardUrl, refreshDashboardLinks } from './ui/util.js';
import { loadFitnessMatrix, checkReviewNudge, showRecFeedback } from './ui/recommend.js';
import { loadOrgSelector, selectOrg, showMultiOrgBadges } from './ui/org-selector.js';
import { enterOverview, enterDetail, renderOverview, isOverviewActive, exitOverview, syncViewTabs, isDragging } from './ui/overview.js';
import { _updateUICore, renderSyncAccountNote } from './ui/render.js';
import { loadPopupAnnouncements } from './ui/notices.js';

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
async function renderReauthWidget() {
  const widget = document.getElementById('reauth-widget');
  if (!widget) return;
  const { independentAccount = null, extToken = null, claudeLinkDone = false, serverSyncGrandfathered = undefined } =
    await chrome.storage.local.get({ independentAccount: null, extToken: null, claudeLinkDone: false, serverSyncGrandfathered: undefined });
  // Trapped only when an email account has NO valid token (expired/cleared) AND
  // hasn't already been upgraded to a Claude account (claudeLinkDone). After a
  // link-claude upgrade the API_KEY fallback works, so a transient missing token
  // is not a trap — don't flash the widget in that window.
  // EXCEPTION (Phase 2 단계 4, Fable review HIGH): on a GATED install (fresh regime,
  // serverSyncGrandfathered===false) the api_key fallback is deliberately blocked, so a linked
  // user whose token later expired has NO working sync and NO other login UI. Keep showing the
  // reauth widget in that case so they can re-mint a `full` token (login re-opens the gate).
  const gated = serverSyncGrandfathered === false;
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
  widget.classList.remove('hidden');

  if (!sendBtn.dataset.bound) {
    sendBtn.dataset.bound = '1';
    sendBtn.addEventListener('click', () => {
      sendBtn.disabled = true; sendBtn.classList.add('loading'); status.textContent = '';
      const lang = (localStorage.getItem('ct-lang') || (navigator.language || 'en').slice(0, 2));
      chrome.runtime.sendMessage(
        { type: 'REQUEST_MAGIC_LINK', email, purpose: 'login', lang },
        (res) => {
          sendBtn.disabled = false; sendBtn.classList.remove('loading');
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
    });
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
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerify(); });
  }
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

async function renderLoginCta() {
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

  // The CTA (verify prompt) — trapped independent accounts go to renderReauthWidget; this is the
  // new-user path. NEVER fully dismissed: "Use locally only" COLLAPSES to a persistent mini
  // reminder (like the permission card) so verify is always one tap away, just small.
  if (!blocked && (!showLoginPrompt || extToken || independentAccount?.email)) { widget.classList.add('hidden'); return; }
  widget.classList.remove('hidden');

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
    document.getElementById('login-cta-mini-msg').textContent = authIsBlocked
      ? (t('login_cta_authblocked_mini') || 'Log in — this browser\'s usage is no longer being saved to the server')
      : scopeBlocked
        ? (t('login_cta_scope_mini') || 'Log in to unlock plan recommendations & more')
        : (t('login_cta_mini') || 'Log in for multi-device sync & more');
    const miniBtn = document.getElementById('login-cta-mini-login');
    miniBtn.textContent = t('login_cta_mini_btn') || 'Log in';
    if (!miniBtn.dataset.bound) {
      miniBtn.dataset.bound = '1';
      miniBtn.addEventListener('click', async () => { await chrome.storage.local.set({ loginCtaCollapsed: false }); renderLoginCta(); });
    }
    return;
  }
  mini.style.display = 'none';
  full.classList.remove('hidden');

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

  const googleBtn = document.getElementById('login-cta-google');
  document.getElementById('login-cta-google-label').textContent = t('login_cta_google') || 'Continue with Google';
  document.getElementById('login-cta-or').textContent = t('login_cta_or') || 'or use an email code';
  if (googleBtn && !googleBtn.dataset.bound) {
    googleBtn.dataset.bound = '1';
    googleBtn.addEventListener('click', async () => {
      googleBtn.disabled = true; status.textContent = '';
      try {
        const res = await signInWithGoogle();
        if (res.ok) {
          // Same tail as the email-code path: we now hold a full Bearer token, so kick a POST
          // immediately (the server-sync gate just opened) and re-render off fresh storage.
          status.textContent = t('login_cta_success') || 'Logged in — server sync will start shortly.';
          chrome.runtime.sendMessage({ type: 'MANUAL_COLLECT' }).catch(() => {});
          setTimeout(() => location.reload(), 1200);
          return;
        }
        status.textContent = res.message;
      } finally {
        googleBtn.disabled = false;
      }
    });
  }

  if (!sendBtn.dataset.bound) {
    sendBtn.dataset.bound = '1';
    sendBtn.addEventListener('click', () => {
      const email = (emailInput.value || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { status.textContent = t('login_cta_bad_email') || 'Enter a valid email.'; return; }
      sendBtn.disabled = true; sendBtn.classList.add('loading'); status.textContent = '';
      const lang = (localStorage.getItem('ct-lang') || (navigator.language || 'en').slice(0, 2));
      chrome.runtime.sendMessage({ type: 'REQUEST_MAGIC_LINK', email, purpose: 'login', lang }, (res) => {
        sendBtn.disabled = false; sendBtn.classList.remove('loading');
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
    });
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
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerify(); });
  }

  if (!dismissBtn.dataset.bound) {
    dismissBtn.dataset.bound = '1';
    dismissBtn.addEventListener('click', async () => {
      // "Use locally only" = keep the gate (no server send) AND collapse to the persistent mini
      // reminder — never fully hidden, so login stays one tap away and keeps nudging.
      await chrome.storage.local.set({ loginCtaCollapsed: true });
      renderLoginCta();
    });
  }
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
  sendGAEvent('popup_open');

  // Request immediate local-only refresh if data is stale (>1 min)
  chrome.runtime.sendMessage({ type: 'POPUP_OPENED' }).catch(() => {});

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
    const { serverSyncGrandfathered: _gf, extToken: _tok } = await chrome.storage.local.get({ serverSyncGrandfathered: undefined, extToken: null });
    if (_gf === false && !!_ia?.email && !!_tok) {
      const signOut = document.getElementById('independent-signout');
      if (signOut) {
        signOut.textContent = t('login_cta_deauth') || 'Disconnect';
        signOut.classList.remove('hidden');
        if (!signOut.dataset.deauthBound) {
          signOut.dataset.deauthBound = '1';
          signOut.addEventListener('click', async (e) => {
            e.preventDefault();
            await chrome.storage.local.remove(['extToken', 'independentAccount', 'loginCtaCollapsed']);
            await chrome.storage.local.set({ showLoginPrompt: true });
            location.reload();
          });
        }
      }
    }
  }

  renderReauthWidget();
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
      renderReauthWidget();
      renderLoginCta();
      checkProviderPermissions();
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

  // Smart recommendation execute button — show confirmation modal
  document.getElementById('smart-rec-btn').addEventListener('click', () => {
    // Plan-change execution is Claude-only. The button is already hidden for other providers
    // (ui/recommend.js); this second check makes a stale/injected click a no-op rather than a
    // claude.ai plan change triggered by a ChatGPT recommendation.
    if ((state.recProvider || 'claude') !== 'claude') return;
    chrome.storage.local.get({ lastStatus: {} }, (result) => {
      const recommendation = result.lastStatus?.recommendation;
      if (!recommendation?.type) return;

      const isUpgrade = recommendation.type === 'upgrade';
      const modal = document.getElementById('smart-rec-confirm-modal');

      document.getElementById('src-modal-title').textContent = t(isUpgrade ? 'confirm_upgrade_title' : 'confirm_downgrade_title');
      document.getElementById('src-modal-plan').textContent = t('confirm_plan_change', recommendation.from_plan || '', recommendation.to_plan || '');

      const costEl = document.getElementById('src-modal-cost');
      if (recommendation.from_cost != null && recommendation.to_cost != null) {
        costEl.textContent = isUpgrade
          ? t('opt_cost_up', recommendation.from_cost, recommendation.to_cost, recommendation.cost_diff)
          : t('opt_cost_down', recommendation.from_cost, recommendation.to_cost, recommendation.cost_diff);
      } else {
        costEl.textContent = '';
      }

      document.getElementById('src-modal-timing').textContent = t(isUpgrade ? 'confirm_timing_immediate' : 'confirm_timing_renewal');
      document.getElementById('src-modal-warning').textContent = t('confirm_warning');

      const confirmBtn = document.getElementById('src-modal-confirm');
      confirmBtn.textContent = t(isUpgrade ? 'confirm_upgrade_btn' : 'confirm_downgrade_btn');
      confirmBtn.style.background = isUpgrade ? '#059669' : '#d97706';
      confirmBtn.disabled = false;

      document.getElementById('src-modal-cancel').textContent = t('confirm_cancel');

      modal.style.display = 'flex';
    });
  });

  // Confirmation modal — confirm button
  document.getElementById('src-modal-confirm').addEventListener('click', () => {
    const modal = document.getElementById('smart-rec-confirm-modal');
    const confirmBtn = document.getElementById('src-modal-confirm');
    confirmBtn.disabled = true;
    confirmBtn.classList.add('loading');
    confirmBtn.textContent = t('changing');

    const btn = document.getElementById('smart-rec-btn');
    btn.disabled = true;

    chrome.storage.local.get({ lastStatus: {} }, (result) => {
      const recommendation = result.lastStatus?.recommendation;
      if (!recommendation?.type) { modal.style.display = 'none'; return; }

      chrome.runtime.sendMessage({ type: 'EXECUTE_PLAN_CHANGE', recommendation }, (res) => {
        modal.style.display = 'none';
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
  });

  // Confirmation modal — cancel button
  document.getElementById('src-modal-cancel').addEventListener('click', () => {
    document.getElementById('smart-rec-confirm-modal').style.display = 'none';
  });

  // Confirmation modal — backdrop click to close
  document.getElementById('smart-rec-confirm-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  // Confirmation modal — ESC key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('smart-rec-confirm-modal');
      if (modal.style.display !== 'none') modal.style.display = 'none';
    }
  });

  // Render plan change order banner (Claude only)
  chrome.storage.local.get({ pendingPlanOrder: null, completedPlanOrder: null, collectedOrgs: [] }, (store) => {
    const primaryOrg = (store.collectedOrgs || []).find(o => o.isPrimary);
    const primaryProvider = primaryOrg?.provider || 'claude';
    if (primaryProvider !== 'claude') return; // plan orders are Claude-specific
    const po = store.pendingPlanOrder;
    const completed = store.completedPlanOrder;
    if (po) {
      const banner = document.getElementById('plan-order-banner');
      banner.classList.remove('hidden');
      banner.dataset.po = JSON.stringify(po);
      const COSTS = { 'Pro': 20, 'Max 5x': 100, 'Max 20x': 200 };
      document.getElementById('plan-order-body').innerHTML =
        `<strong>${po.org_name}</strong> ${t('plan_order_admin')}(${po.requested_by_name})<br>` +
        `<strong>${po.from_plan} → ${po.to_plan}</strong> ${t('plan_order_request')}`;
      if (po.reason) {
        const reasonEl = document.getElementById('plan-order-reason');
        reasonEl.classList.remove('hidden');
        reasonEl.textContent = '💬 ' + po.reason;
      }
      const fromCost = COSTS[po.from_plan] || 0;
      const toCost = COSTS[po.to_plan] || 0;
      const diff = toCost - fromCost;
      const diffStr = diff > 0 ? `+$${diff}` : `-$${Math.abs(diff)}`;
      document.getElementById('plan-order-cost').textContent = `$${fromCost}/${t('month_short')} → $${toCost}/${t('month_short')} (${diffStr})`;
    } else if (completed && Date.now() - completed.completedAt < 3600000) {
      // Order completed within the last hour — success notice
      const HIERARCHY = ['Pro', 'Max 5x', 'Max 20x'];
      const isUp = HIERARCHY.indexOf(completed.to_plan) > HIERARCHY.indexOf(completed.from_plan);
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

  // Plan change order accept/reject buttons
  document.getElementById('plan-order-accept').addEventListener('click', () => {
    const btn = document.getElementById('plan-order-accept');
    btn.disabled = true;
    btn.textContent = t('changing') || '변경 중...';
    // Save order info (referenced after response)
    const _po = (() => { try { return JSON.parse(document.getElementById('plan-order-banner').dataset.po || '{}'); } catch { return {}; } })();
    chrome.runtime.sendMessage({ type: 'RESPOND_PLAN_ORDER', action: 'accept' }, (res) => {
      if (res?.success) {
        const HIERARCHY = ['Pro', 'Max 5x', 'Max 20x'];
        const isUpgrade = HIERARCHY.indexOf(_po.to_plan) > HIERARCHY.indexOf(_po.from_plan);
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
  });
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

function showError(msg) {
  document.getElementById('status-indicator').className = 'status-dot red';
  // Translate if i18n key, otherwise display as-is
  const translated = msg && msg.startsWith('err_') ? t(msg) : msg;
  document.getElementById('status-text').textContent = translated;
}

function showSuccess(msg) {
  document.getElementById('status-indicator').className = 'status-dot green';
  document.getElementById('status-text').textContent = msg;
}


