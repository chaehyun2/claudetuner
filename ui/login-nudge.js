// Felt-need login nudge (#2420) — a soft, infrequent prompt shown to a NO-ACCOUNT install at the
// moment it is actually using the panel, not at the welcome step where value has not been felt yet.
//
// WHY THIS IS SEPARATE FROM login-cta.js. The login CTA (ui/login-cta.js) nags the FRESH, gated
// population (showLoginPrompt / needsFullLogin / authBlocked) with a persistent, never-fully-hidden
// card. That leaves the much larger silent population #2315 measured — grandfathered installs that
// collect fine but never created an account (47% of successful collectors) — with NO login signal
// at all, because they are not gated and so showLoginPrompt is never set for them. This nudge is
// aimed at exactly that gap, and ONLY that gap:
//
//   • it NEVER shows when any login-CTA condition is live (showLoginPrompt/needsFullLogin/authBlocked)
//     — those users already see the real card, and two prompts for one action is the duplication
//     the issue explicitly forbids;
//   • it NEVER shows to a logged-in install (extToken or independentAccount present);
//   • its single CTA does not re-implement login — it reveals the real login-CTA card and hands off.
//
// FELT-NEED, NOT ONBOARDING. The trigger is repeat use: a no-account install that has opened this
// panel (toolbar popup or side panel — both load popup.html) at least NUDGE_MIN_OPENS times has
// come back to its own usage/prediction/history enough to have felt the need the account unlocks.
//
// LOW INTRUSION. Dismissible; capped at NUDGE_MAX_SHOWS lifetime exposures; a cooldown between
// exposures so it never appears on consecutive opens. Once it is up in a session it stays up across
// re-renders (storage.onChanged) rather than flickering, and a dismiss keeps it down for the session.
import { renderLoginCta } from './login-cta.js';
import { state } from './state.js';

// Repeat-use threshold: show no earlier than the Nth eligible open. 3 = "came back twice after the
// first look" — enough signal that the panel is useful to them, short enough to catch them while
// the habit is forming.
const NUDGE_MIN_OPENS = 3;
// Lifetime cap on exposures. After this the nudge is done and open-counting stops too — a prompt
// that keeps returning forever is noise, not a nudge.
const NUDGE_MAX_SHOWS = 3;
// Minimum gap between exposures, also the quiet period after a dismiss. One week: long enough that
// a declined nudge is not nagging, short enough to still catch a continuing habit.
const NUDGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// ── Exposure / interaction telemetry ──────────────────────────────────────────────────────────
// Its OWN event, deliberately NOT folded into `login_cta_shown` (ui/auth-widgets.js). That metric
// is divided by `popup_open` to measure CTA reach for the gated population; this nudge targets a
// disjoint population and answers a different question, so merging them would silently corrupt a
// ratio every dashboard reads. Same safety discipline as noteCtaShown: a module-level dedupe set so
// 'shown' fires once per popup session (the panel re-renders on every storage change), feature-
// detect the classic global (absent in older builds / tests), and a try/catch so telemetry can
// never break the panel.
const _nudgeSent = new Set();
function noteNudge(action, opens) {
  if (action === 'shown') {
    if (_nudgeSent.has('shown')) return;
    _nudgeSent.add('shown');
  }
  try {
    if (typeof sendGAEvent === 'function') sendGAEvent('login_nudge', { action, opens: opens ?? null });
  } catch (_) { /* telemetry must never break the panel */ }
}

// Session-scoped display state. `_shownThisSession` keeps the card up across re-renders once it has
// been shown (otherwise the cooldown it just wrote would hide it on the very next storage change);
// `_dismissed` keeps it down after the user closes it without re-reading storage on each re-render.
let _shownThisSession = false;
let _dismissed = false;
// Same stale-render guard as renderLoginCta (#791/#2420 Codex follow-up): this renders off
// storage.onChanged, so two renders overlap. One that read "eligible" BEFORE a login landed could
// resume after a newer render that read "ineligible" and hid the nudge — and show it again next to
// the login-CTA. Each render is stamped and re-checked after the storage read, before any DOM write.
let _renderSeq = 0;

const ELIGIBILITY_DEFAULTS = {
  extToken: null, independentAccount: null,
  showLoginPrompt: false, needsFullLogin: false, authBlocked: false,
  loginNudgeOpens: 0, loginNudgeShows: 0, loginNudgeNextAt: 0,
};

// A no-account install that is NOT already covered by any login-CTA condition. Both the open
// counter and the render consult this, so the two can never disagree about who the nudge is for.
function eligible(s) {
  const hasAccount = !!(s.extToken || s.independentAccount?.email);
  const ctaLive = !!(s.showLoginPrompt || s.needsFullLogin || s.authBlocked);
  return !hasAccount && !ctaLive;
}

// Count ONE eligible open. Called exactly once per panel open (from popup.js DOMContentLoaded), never
// from a re-render, so the count means "times this no-account user came back", not "times the panel
// repainted". Stops counting once the lifetime cap is reached so the stored number cannot run away.
export async function recordLoginNudgeOpen() {
  const s = await chrome.storage.local.get(ELIGIBILITY_DEFAULTS);
  if (!eligible(s) || s.loginNudgeShows >= NUDGE_MAX_SHOWS) return;
  await chrome.storage.local.set({ loginNudgeOpens: (s.loginNudgeOpens || 0) + 1 });
}

// The card's imperative t() text — set on first show, and again on a live language switch
// (relabelLoginNudge) because a card already up this session skips the show path.
function applyNudgeText() {
  document.getElementById('login-nudge-title').textContent = t('login_nudge_title') || 'Bring your usage together in one account';
  document.getElementById('login-nudge-msg').textContent = t('login_nudge_msg')
    || 'Log in to merge your usage across devices into one account, with limit prediction, trends & recommendations.';
  document.getElementById('login-nudge-login').textContent = t('login_nudge_btn') || 'Log in';
  document.getElementById('login-nudge-close')?.setAttribute('aria-label', t('login_nudge_dismiss') || 'Maybe later');
}

export function relabelLoginNudge() {
  if (!_shownThisSession || !document.getElementById('login-nudge')) return;
  applyNudgeText();
  renderLoginNudgeSpark();
}

export async function renderLoginNudge() {
  const seq = ++_renderSeq;
  const widget = document.getElementById('login-nudge');
  if (!widget) return;
  const s = await chrome.storage.local.get(ELIGIBILITY_DEFAULTS);
  // Superseded while awaiting → a newer render holds the truth. Bail BEFORE touching the DOM.
  if (seq !== _renderSeq) return;

  // Logged in, or the real login-CTA is live → never this nudge. Checked on every re-render so the
  // nudge disappears the instant an account appears (e.g. a background login lands mid-session).
  if (!eligible(s)) { widget.classList.add('hidden'); _shownThisSession = false; return; }
  // Dismissed this session stays dismissed until the panel is reopened.
  if (_dismissed) { widget.classList.add('hidden'); return; }
  // Already up this session → keep it up without re-counting or re-reading the frequency gates (the
  // cooldown we wrote on first show would otherwise hide it on the next storage-driven re-render).
  if (_shownThisSession) { widget.classList.remove('hidden'); return; }

  // First render of the session: apply the frequency gates.
  if (s.loginNudgeShows >= NUDGE_MAX_SHOWS) { widget.classList.add('hidden'); return; } // done nudging
  if ((s.loginNudgeOpens || 0) < NUDGE_MIN_OPENS) { widget.classList.add('hidden'); return; } // not felt-need yet
  if (Date.now() < (s.loginNudgeNextAt || 0)) { widget.classList.add('hidden'); return; } // in cooldown

  _shownThisSession = true;
  widget.classList.remove('hidden');
  // 🔴 Fallbacks are account-framed too, not local-only: this population already syncs via the
  // shared key (serverSyncWithheldReason() is 'token_lost' or null, never withholding), so a
  // "saved on this browser only" fallback would reintroduce the exact falsehood the copy fixes
  // (#2420 Codex). t() returns the key when a translation is missing, so these are belt-and-braces.
  applyNudgeText();
  const loginBtn = document.getElementById('login-nudge-login');
  const closeBtn = document.getElementById('login-nudge-close');

  if (!loginBtn.dataset.bound) {
    loginBtn.dataset.bound = '1';
    loginBtn.addEventListener('click', async () => {
      noteNudge('login');
      _dismissed = true;
      widget.classList.add('hidden');
      // Hand off to the real login card instead of a second login form. showLoginPrompt only drives
      // the login-CTA's visibility (it is never read to gate server sync), so flipping it here is a
      // display action: it reveals the full card (Google one-click + email code + account
      // disclosure) that login-cta.js already builds. Clearing loginCtaCollapsed makes it open
      // expanded rather than as the collapsed mini bar.
      await chrome.storage.local.set({ showLoginPrompt: true, loginCtaCollapsed: false });
      renderLoginCta();
    });
  }
  if (closeBtn && !closeBtn.dataset.bound) {
    closeBtn.dataset.bound = '1';
    closeBtn.addEventListener('click', () => {
      noteNudge('dismiss');
      _dismissed = true;
      widget.classList.add('hidden');
    });
  }

  renderLoginNudgeSpark();

  // Record the exposure: bump the lifetime count and arm the cooldown so the next show is a week
  // out and the cap is enforced. Written AFTER the card is on screen, like the CTA telemetry, so a
  // superseded render cannot burn a show the user never saw.
  await chrome.storage.local.set({
    loginNudgeShows: (s.loginNudgeShows || 0) + 1,
    loginNudgeNextAt: Date.now() + NUDGE_COOLDOWN_MS,
  });
  noteNudge('shown', s.loginNudgeOpens || 0);
}

// ── "My weekly usage · last 7 days" sparkline inside the nudge ────────────────────────────────
// The user's OWN week, drawn from the history the panel already loaded (state.usageHistory, read
// once per open by popup.js) — this module never touches IndexedDB. One org only: points from two
// orgs on one line would draw a graph that is nobody's. Hidden unless there is enough of a week to
// be worth showing; the card itself is unaffected either way.
const HOUR_MS = 60 * 60 * 1000;
const SPARK_SPAN_MS = 7 * 24 * HOUR_MS;
const SPARK_MIN_POINTS = 12;
const SPARK_MIN_SPAN_MS = 24 * HOUR_MS;
const SPARK_W = 240;
const SPARK_H = 36;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The selected org's d7 over the last 7 days, the last point of each hour, oldest first — or null
 * when there is too little to draw (fewer than SPARK_MIN_POINTS hours, or under SPARK_MIN_SPAN_MS).
 */
export function buildNudgeSpark(points, org, nowMs) {
  if (!org) return null;
  const since = nowMs - SPARK_SPAN_MS;
  const byHour = new Map();
  for (const p of points || []) {
    if (!p || p.org !== org || !Number.isFinite(p.t) || p.t <= since || p.t > nowMs) continue;
    if (typeof p.d7 !== 'number' || !Number.isFinite(p.d7)) continue;
    const hour = Math.floor(p.t / HOUR_MS);
    const prev = byHour.get(hour);
    if (!prev || p.t >= prev.t) byHour.set(hour, { t: p.t, v: Math.min(100, Math.max(0, p.d7)) });
  }
  const pts = [...byHour.values()].sort((a, b) => a.t - b.t);
  if (pts.length < SPARK_MIN_POINTS || pts[pts.length - 1].t - pts[0].t < SPARK_MIN_SPAN_MS) return null;
  return pts;
}

// Computed once per (panel open, selected org): the history is already in memory, and the line does
// not follow storage-driven re-renders. Runs when the nudge is up AND the history and the selected
// org have both landed — popup.js calls it from each of those arrival points, whichever is last wins
// — and again when the viewed org changes (ui/org-selector.js selectOrg), so the line is never one
// org's week under another org's view (Codex 1R). The text is re-applied on every call, which is
// what a live language switch relies on.
let _sparkOrg = null;
export function renderLoginNudgeSpark() {
  if (!_shownThisSession || !state.historyLoaded || !state.selectedOrgId) return;
  const box = document.getElementById('login-nudge-spark');
  const chart = document.getElementById('login-nudge-spark-chart');
  if (!box || !chart) return;
  const label = t('login_nudge_spark_label') || 'My weekly usage · last 7 days';
  document.getElementById('login-nudge-spark-label').textContent = label;
  document.getElementById('login-nudge-spark-note').textContent = t('login_nudge_spark_note')
    || 'Right now you can only see this here. Log in to keep it in your account and pick it up on other devices and the dashboard.';
  chart.firstElementChild?.setAttribute('aria-label', label);
  if (_sparkOrg === state.selectedOrgId) return;
  _sparkOrg = state.selectedOrgId;
  const pts = buildNudgeSpark(state.usageHistory, state.selectedOrgId, Date.now());
  if (!pts) { box.classList.add('hidden'); chart.replaceChildren(); return; }
  const t0 = pts[0].t;
  const span = pts[pts.length - 1].t - t0;
  // Numbers only — built through the DOM API, nothing from the history reaches markup as text.
  const coords = pts.map((p) => `${((p.t - t0) / span * SPARK_W).toFixed(1)},${(SPARK_H - 1 - p.v / 100 * (SPARK_H - 2)).toFixed(1)}`).join(' ');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(SPARK_H));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', coords);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  line.style.stroke = 'var(--accent)';
  svg.appendChild(line);
  chart.replaceChildren(svg);
  box.classList.remove('hidden');
}

// One call for the panel-open path: count the open, then render. popup.js also wires renderLoginNudge
// into storage.onChanged so the nudge hides the moment a login lands.
export async function initLoginNudge() {
  await recordLoginNudgeOpen();
  await renderLoginNudge();
}
