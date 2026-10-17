// ui/compare/readiness-strip.js — the 「연결하기」 readiness strip of mountComparePage() (#2418).
//
// WHY. 57 % of the page opens met a ChatGPT / Gemini permission gate and 55 % of those never pressed
// it (87 % of those who did, granted): the gates sat in the RESULT area, two cold walls before the
// user had even typed. The strip moves that set-up above the composer, as one warm action: what is
// ready, what needs access (one 「모두 연결」 — the column gates' own batched prompt), what needs a
// sign-in, what could not be checked. It shows while fewer than two DISTINCT providers are ready
// (96 % of sends use 2+) and disappears by itself once two are.
//
// The facts are column-gate.js computeReadiness / readinessVisible, recomputed in ONE place
// (compare.js recomputeReadiness, at the end of updateControls) — this file only draws them.
// Built once per shape and updated in place (like the column gates): a status re-read fires on
// every focus and must not tear a login link out from under the user's focus.
//
// See ui/compare/history.js for the ctx contract.

import { PROVIDER_META, COMPARE_PROVIDERS, MAX_COLUMNS } from './constants.js';
import { storageGet } from './helpers.js';

// ── #2418 U5: the A/B holdout (plan §5). Half the installs see the strip and the nudge (`on`), half
// see today's page (`off`), so the open → send lift is measured, not guessed. The arm is a hash of the
// SW's per-profile `install_id` (bg/storage.js getOrCreateInstallId — the page only READS it, one
// creator) so a revisit, the extension tab and the web shell's iframe land in the same arm; never the
// email (switching accounts must not switch arms). No id yet → `none`: no strip, today's page.
export const ONBOARD_ARM_ON = 'on';
export const ONBOARD_ARM_OFF = 'off';
export const ONBOARD_ARM_NONE = 'none';
const INSTALL_ID_KEY = 'install_id';
// The arm read sits before the first status (compare.js boot): a storage call that never answers must not hold it.
export const ONBOARD_ARM_READ_TIMEOUT_MS = 1500;
// QA override in chrome.storage.local (`on` / `off`) — the preview mock sets it; never written by the extension.
export const ONBOARD_FORCE_KEY = 'cmpOnboardForce';
/**
 * FNV-1a (32-bit) of the install id; the arm is its TOP bit. 🪤 Not `h % 2`: multiplying by an odd prime
 * keeps the low bit, so FNV's lowest bit is only the parity of the characters' low bits — the top bit mixes all.
 */
export function onboardArm(installId) {
  if (typeof installId !== 'string' || !installId) return ONBOARD_ARM_NONE;
  let h = 0x811c9dc5;
  for (let i = 0; i < installId.length; i++) { h ^= installId.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 31) === 0 ? ONBOARD_ARM_ON : ONBOARD_ARM_OFF;
}
/** A page mount's id (12 hex) — joins `open`, `onboard_*` and `send` of ONE visit (the session id only exists after the first send). */
export function newVisitId(random = Math.random) {
  let out = '';
  for (let i = 0; i < 12; i++) out += Math.floor(random() * 16).toString(16);
  return out;
}

// Which primary action the strip offers — one per state, never a button with nothing to do (plan §3 CTA table).
export const READY_CTA_CONNECT = 'connect'; // ≥1 provider needs site access → 「모두 연결」
export const READY_CTA_LOGIN = 'login';     // only sign-ins left → per-row login links + 「다시 확인」
export const READY_CTA_RECHECK = 'recheck'; // only unknowns left → 「다시 확인」
export const READY_CTA_ADD = 'add';         // nothing gated, fewer than 2 providers on the page → 「다른 AI 추가하기」
const TITLE_KEY = Object.freeze({
  [READY_CTA_CONNECT]: 'ready_strip_title_connect',
  [READY_CTA_LOGIN]: 'ready_strip_title_login',
  [READY_CTA_RECHECK]: 'ready_strip_title_unknown',
  [READY_CTA_ADD]: 'ready_strip_title_add',
});
const ROW_READY = 'ready';
const ROW_PERMISSION = 'permission';
const ROW_LOGIN = 'login';
const ROW_UNKNOWN = 'unknown';
const ROW_KEY = Object.freeze({ [ROW_READY]: 'ready_row_ready', [ROW_PERMISSION]: 'ready_row_permission', [ROW_LOGIN]: 'ready_row_login', [ROW_UNKNOWN]: 'ready_row_unknown' });

/** The strip's primary action for a readiness (computeReadiness), by the plan's §3 table. */
export function readinessCta(r) {
  if (r.permissionGated.length) return READY_CTA_CONNECT;
  if (r.loginGated.length) return READY_CTA_LOGIN;
  if (r.unknown.length) return READY_CTA_RECHECK;
  return READY_CTA_ADD;
}
/** The rows, in column order (computeReadiness keeps it per bucket; the page's order is the columns'). */
export function readinessRows(r, order) {
  const kindOf = new Map();
  for (const p of r.ready) kindOf.set(p, ROW_READY);
  for (const p of r.permissionGated) kindOf.set(p, ROW_PERMISSION);
  for (const p of r.loginGated) kindOf.set(p, ROW_LOGIN);
  for (const p of r.unknown) kindOf.set(p, ROW_UNKNOWN);
  const seen = new Set();
  const out = [];
  for (const p of order) if (kindOf.has(p) && !seen.has(p)) { seen.add(p); out.push({ provider: p, kind: kindOf.get(p) }); }
  return out;
}
/**
 * 「다른 AI 추가하기」: the first trio provider the page does not use, and how to bring it in — a new
 * column below the cap (`add`), else REPLACE the last column of a provider that has two (`replace`,
 * colId). Never the source hidden by 「원본 제외」 (`excluded`): it is on the page but not in play, and
 * bringing it back would add nothing (Codex U2 1R). null when no provider can be brought in.
 */
export function addProviderPlan(inPlay, columns, excluded = null, maxColumns = MAX_COLUMNS) {
  const missing = COMPARE_PROVIDERS.find((p) => !inPlay.includes(p) && p !== excluded);
  if (!missing) return null;
  if (columns.length < maxColumns) return { action: 'add', provider: missing };
  const count = new Map();
  for (const c of columns) count.set(c.provider, (count.get(c.provider) || 0) + 1);
  const dup = [...columns].reverse().find((c) => count.get(c.provider) > 1);
  return dup ? { action: 'replace', provider: missing, colId: dup.id } : null;
}

/** Installs the readiness-strip slice onto `ctx`. */
export function installReadinessStrip(ctx) {
  const { state, t, el, clear, dot, track } = ctx;
  const visitId = newVisitId(ctx.random);
  let shownOnce = false; // `onboard_shown` once per visit
  const box = el('section', 'cmp-ready');
  box.id = 'cmp-ready';
  box.setAttribute('aria-label', t('ready_strip_aria'));
  box.hidden = true;
  let shape = ''; // what the box was last built for — the same shape is only re-synced, never rebuilt
  let checking = null; // the 「확인 중…」 line of the current build, if it has a re-check
  // 「그래도 보내기」 (plan §4): the ONE send it allows — this question to these columns — then spent.
  let bypassKey = null;
  const sendKey = (text, targets) => `${targets.join(',')}\n${text}`;

  /**
   * #2418 U4 — the cross-check's first send would go to ONE distinct provider (a "comparison" of one,
   * 3.8 % of sends): hold it once and say so in the strip, with 「그래도 보내기」 beside the strip's own
   * action. Called by compare.js sendNow at the send boundary — the targets are final there, the
   * permission prompt (sendInitial, #1838) already answered. Fail-open: only while the strip is
   * showing (it does whenever fewer than 2 providers are ready), never a hidden hold. true = held.
   */
  function holdSingleProviderSend(text, targets) {
    const providers = new Set(targets.map((id) => (state.columns.get(id) || {}).provider).filter(Boolean));
    if (providers.size !== 1 || !state.readinessShown) { state.nudging = false; return false; }
    const key = sendKey(text, targets);
    if (bypassKey === key) { bypassKey = null; state.nudging = false; return false; }
    bypassKey = null;
    state.nudging = { provider: [...providers][0], key };
    track('onboard_nudge', { visit_id: visitId, provider: state.nudging.provider });
    renderReadiness();
    if (ctx.revealNode) ctx.revealNode(box);
    return true;
  }
  function sendAnyway() {
    if (!state.nudging) return;
    bypassKey = state.nudging.key;
    track('onboard_nudge_send', { visit_id: visitId, provider: state.nudging.provider });
    state.nudging = false;
    ctx.sendNow(); // the same boundary: it re-reads text + targets and spends the bypass only if they still match
    // sendNow reaches the hold synchronously; a send stopped before it (quota, a busy tray…) must not
    // leave the bypass for a later press of 보내기 (Codex U4 1R 후속 1).
    bypassKey = null;
    renderReadiness();
  }

  function addAnotherProvider() {
    const cols = ctx.allColumns().filter((c) => !c.closed);
    const r = state.readiness;
    if (!r) return;
    const plan = addProviderPlan([...r.ready, ...r.permissionGated, ...r.loginGated, ...r.unknown], cols, state.excludeSrc ? ctx.src : null);
    if (!plan) return;
    track('onboard_add_click', { visit_id: visitId, provider: plan.provider, action: plan.action });
    if (plan.action === 'add') ctx.addColumnByUser();
    else ctx.chooseColumn(plan.colId, { provider: plan.provider, model: null });
  }

  function build(r, cta) {
    clear(box);
    checking = null;
    const nudge = state.nudging;
    const head = el('p', 'cmp-ready-title', nudge ? t('ready_nudge_title', PROVIDER_META[nudge.provider].label) : t(TITLE_KEY[cta]));
    if (nudge) box.setAttribute('data-nudge', '1'); else box.removeAttribute('data-nudge');
    box.appendChild(head);
    const list = el('ul', 'cmp-ready-rows');
    for (const row of readinessRows(r, ctx.allColumns().map((c) => c.provider))) {
      const li = el('li', 'cmp-ready-row');
      li.setAttribute('data-ready', row.kind);
      li.appendChild(dot(row.provider));
      li.appendChild(el('span', 'cmp-ready-name', PROVIDER_META[row.provider].label));
      li.appendChild(el('span', 'cmp-ready-state', t(ROW_KEY[row.kind])));
      if (row.kind === ROW_LOGIN) li.appendChild(ctx.providerLoginLink(row.provider, 'cmp-btn cmp-btn-sm cmp-btn-link cmp-ready-login'));
      list.appendChild(li);
    }
    box.appendChild(list);
    const actions = el('div', 'cmp-ready-actions');
    if (cta === READY_CTA_CONNECT) {
      const btn = el('button', 'cmp-btn cmp-btn-primary cmp-ready-connect', t('ready_strip_connect_all'));
      btn.type = 'button';
      const hint = el('p', 'cmp-ready-hint');
      hint.setAttribute('aria-live', 'polite');
      // The column gates' own path (#1838): one prompt for every gated provider, the gesture kept,
      // the web shell's extension-tab fallback. permissionGated[0] leads; the wrapper gathers the rest.
      btn.addEventListener('click', () => {
        // Before the request on purpose: the prompt must start in this click (requestProviderPermission's first await is the prompt).
        track('onboard_connect_click', { visit_id: visitId, providers_n: r.permissionGated.length });
        ctx.requestProviderPermission(r.permissionGated[0], btn, hint);
      });
      actions.appendChild(btn);
      actions.appendChild(hint);
    } else if (cta === READY_CTA_ADD) {
      const btn = el('button', 'cmp-btn cmp-btn-primary cmp-ready-add', t('ready_strip_add'));
      btn.type = 'button';
      btn.addEventListener('click', addAnotherProvider);
      actions.appendChild(btn);
    } else {
      // Sign-ins / unknowns: nothing the page can do but read the status again (auto-reconnect on focus does too).
      actions.appendChild(ctx.checkAgainButton());
      checking = el('span', 'cmp-ready-checking');
      checking.setAttribute('aria-live', 'polite');
      actions.appendChild(checking);
    }
    if (nudge) {
      const anyway = el('button', 'cmp-btn cmp-btn-sm cmp-ready-anyway', t('ready_nudge_send_anyway'));
      anyway.type = 'button';
      anyway.addEventListener('click', sendAnyway);
      actions.appendChild(anyway);
    }
    box.appendChild(actions);
  }

  /** Draws state.readiness / state.readinessShown — called by compare.js recomputeReadiness only. */
  function renderReadiness() {
    const r = state.readiness;
    // Gone (2+ ready, the session started, another tab…) → the hold is moot; a later send decides again.
    if (!state.readinessShown || !r) { box.hidden = true; state.nudging = false; return; }
    const cta = readinessCta(r);
    const order = ctx.allColumns().map((c) => c.provider).join(',');
    const next = JSON.stringify([cta, r, order, state.nudging ? state.nudging.provider : null]);
    if (next !== shape) { build(r, cta); shape = next; }
    if (checking) checking.textContent = state.checking ? t('gate_checking') : '';
    box.hidden = false;
    if (!shownOnce) {
      shownOnce = true;
      track('onboard_shown', { visit_id: visitId, ready_n: r.ready.length, gated_n: r.permissionGated.length, login_n: r.loginGated.length, unknown_n: r.unknown.length, cta });
    }
  }
  /** Reads the arm before the first status (compare.js boot) — never rejects; reports it once with the visit. */
  async function readOnboardArm() {
    // Late or never → `none` (today's page); the status is never held behind it (Codex U5 1R 후속 1).
    const got = await new Promise((resolve) => {
      const timer = ctx.clock.setTimeout(() => resolve(null), ONBOARD_ARM_READ_TIMEOUT_MS);
      storageGet(ctx.chrome, ctx.localStorageArea, [INSTALL_ID_KEY, ONBOARD_FORCE_KEY]).then((v) => { ctx.clock.clearTimeout(timer); resolve(v); });
    });
    const force = got && got[ONBOARD_FORCE_KEY];
    state.onboardArm = force === ONBOARD_ARM_ON || force === ONBOARD_ARM_OFF ? force : onboardArm(got && got[INSTALL_ID_KEY]);
    track('onboard_arm', { visit_id: visitId, arm: state.onboardArm, forced: !!force });
  }

  Object.assign(ctx, { readinessBox: box, renderReadiness, holdSingleProviderSend, readOnboardArm, visitId });
}
