// ui/compare/column-gate.js — the column GATE slice of mountComparePage() (compare.js): what a
// column body shows before the provider can take part (permission prompt, sign-in, unknown),
// the provider plan line and the mini usage gauges under the column head. Provider facts, joined
// through col.provider. Bodies are exactly as they were in compare.js; ctx contract: see
// ui/compare/history.js.

import { PROVIDER_META, SECONDS_PER_HOUR, SECONDS_PER_DAY, GATE_PERMISSION, GATE_LOGIN, GATE_UNKNOWN, USAGE_FULL_PCT } from './constants.js';
// The popup's gauge palette (ui/util.js is dependency-free): the mini gauges here read like the
// overview cards — same thresholds, same colours (user request 2026-09-18).
import { gaugeColor } from '../util.js';

/** Installs the column-gate slice onto `ctx` (ctx contract: ui/compare/history.js header). */
export function installColumnGate(ctx) {
  const { chrome, t, state, clock, embedHost, track, el, clear, link, dot, src } = ctx;
  /** Which gate a provider's status calls for; null = sendable (no gate). */
  function gateKindFor(pstate) {
    if (!pstate || !pstate.permitted) return GATE_PERMISSION;
    if (pstate.loggedIn === true) return null;
    // The SW answers null only when not permitted, but a null under `permitted` must not read as
    // "signed out" — it is "unknown", with a re-check and no login prompt.
    return pstate.loggedIn === false ? GATE_LOGIN : GATE_UNKNOWN;
  }
  /** A quiet 「다시 확인」: a status re-read on demand (the manual path when auto-reconnect missed). */
  function checkAgainButton() {
    const btn = el('button', 'cmp-btn cmp-btn-sm cmp-gate-check', t('gate_check_again'));
    btn.type = 'button';
    btn.addEventListener('click', () => { ctx.refreshStatus(); });
    return btn;
  }
  /**
   * 「<Provider>에 로그인하기 ↗」: the provider site in a new tab (href from PROVIDER_META only); the
   * arrow says so visually, the aria-label in words. One builder for the column gate (primary,
   * `cmp-provider-login`) and the C3 action row (small, `cmp-action-login`).
   */
  function providerLoginLink(provider, className = 'cmp-btn cmp-btn-primary cmp-btn-link cmp-provider-login') {
    const meta = PROVIDER_META[provider];
    const login = link(meta.site, t('provider_login_link', meta.label), className);
    const arrow = el('span', 'cmp-ext-arrow', '↗');
    arrow.setAttribute('aria-hidden', 'true');
    login.appendChild(arrow);
    login.setAttribute('aria-label', t('provider_login_link_aria', meta.label));
    return login;
  }
  /**
   * The providers ONE prompt should cover when `provider`'s button is pressed: that provider first,
   * then every other provider on the page that still lacks site access (2026-09-26 — GA 09-21~25:
   * ~150 users met a gate per provider but only ~40 granted each; two separate prompts were the
   * funnel's widest leak). Only providers that are VISIBLE columns on this page — never a site the
   * user did not pick: 「원본 제외」 hides the source column but keeps it in the Map (Codex 1R), and a
   * column closed for this conversation (`col.closed`) is not one the user wants either.
   * Read from STATE, not `col.node.hidden`: renderColumns updates columns in order, so an earlier
   * column's label would see a later column's stale hidden flag (Codex 2R).
   * Chrome grants a multi-origin request all-or-nothing, in a single bubble.
   */
  function providersNeedingPermission(provider) {
    const out = [provider];
    for (const col of state.columns.values()) {
      if (out.includes(col.provider) || !PROVIDER_META[col.provider] || (state.excludeSrc && col.provider === src) || col.closed) continue; // closed = ✕ in the session / not in a loaded entry (1.36.0 batch review)
      const pstate = state.status && state.status.providers ? state.status.providers[col.provider] : null;
      if (gateKindFor(pstate) === GATE_PERMISSION) out.push(col.provider);
    }
    return out;
  }
  /**
   * A permission button's label: its own single-site words (`singleKey` — the gate's 「권한 허용」 or
   * the C3 action row's 「사이트 접근 허용」), or 「Gemini·ChatGPT 한 번에 허용」 when the prompt covers more.
   */
  function permissionButtonLabel(provider, singleKey = 'provider_permission_btn') {
    const providers = providersNeedingPermission(provider);
    if (providers.length < 2) return t(singleKey);
    return t('provider_permission_btn_many', providers.map((p) => PROVIDER_META[p].label).join(t('provider_list_sep')));
  }
  /**
   * 🔴 The ONLY chrome.permissions.request in the compare feature, and it runs from a click
   * handler: optional host permissions need a user gesture, which content scripts can never supply
   * (AC16). Two buttons share it — the column gate's 「권한 허용」 and the C3 action row's 「사이트 접근
   * 허용」 — so the call site count stays one. The request covers every column still gated on
   * permission (providersNeedingPermission), so one "allow" clears them all. After the prompt,
   * re-ask the SW so the columns flip to sendable/login (gate) or get their retry back (action
   * row, col.gateCleared). `hint` is where the "the prompt moved to an extension tab" line goes.
   */
  async function requestProviderPermission(provider, btn, hint) {
    if (state.disabled) return;
    const providers = providersNeedingPermission(provider);
    btn.disabled = true;
    let promptUnavailable = false;
    try {
      let granted = false;
      try { granted = (await chrome.permissions.request({ origins: providers.map((p) => PROVIDER_META[p].origin) })) === true; } catch {
        // Refused / unavailable. Inside the web shell's iframe Chrome may decline to SHOW the
        // prompt at all (the call rejects — a user's "no" resolves false and does not land here):
        // the extension's own tab is where the prompt is guaranteed, so open this page there with
        // the same query and say so. The button stays; a plain retry is still possible.
        promptUnavailable = !!embedHost;
      }
      // One event per provider the prompt covered, so the per-provider gate → grant funnel stays comparable.
      for (const p of providers) track('permission_result', { provider: p, granted });
      if (promptUnavailable) ctx.openInExtensionTab();
      hint.textContent = '';
      await ctx.refreshStatus();
      // The hint lives INSIDE the gate / the action row (both are kept in place across refreshes),
      // never in the notice box — it must not replace a consume error / the quota notice / the
      // extension-login notice (Codex b2 3R #1). A granted permission rebuilds the gate away.
      if (promptUnavailable) hint.textContent = t('provider_permission_tab_hint');
    } finally {
      // 🔴 The gate is updated in place across refreshes, so this is the SAME button the user
      // will press again after a "no": it must come back (Codex b2 2R #1).
      btn.disabled = false;
    }
  }
  /**
   * Column content for a provider that cannot be sent to — permission / login / unknown state —
   * or, mid-session, one that signed in too late to join (GATE_JOINED). Built ONCE per kind and
   * then updated in place: a status re-read (auto-reconnect fires on every focus) must not tear
   * the login link out from under the user's focus. Only a change of kind rebuilds.
   */
  function renderColumnGate(col, kind) {
    const meta = PROVIDER_META[col.provider];
    // The gate speaks through the body (title + action); the header pill stays empty so the same
    // words are not shown twice.
    ctx.setBadge(col, null);
    if (col.gate && col.gate.kind === kind && col.gate.box.parentNode === col.body) { syncGateStatus(col); return; }
    clear(col.body);
    const box = el('div', 'cmp-col-state');
    box.setAttribute('data-gate', kind);
    box.appendChild(dot(col.provider));
    const gate = { kind, box, status: null, hint: null, btn: null };
    if (kind === GATE_PERMISSION) {
      box.appendChild(el('p', 'cmp-col-state-title', t('provider_permission_required')));
      box.appendChild(el('p', 'cmp-col-state-desc', t('provider_permission_desc', meta.label)));
      const btn = el('button', 'cmp-btn cmp-btn-primary cmp-perm-btn', permissionButtonLabel(col.provider));
      btn.type = 'button';
      gate.btn = btn;
      btn.setAttribute('data-origin', meta.origin);
      // Where the "the prompt moved to an extension tab" hint goes (appended under the buttons below).
      const hint = el('p', 'cmp-col-state-hint');
      hint.setAttribute('aria-live', 'polite');
      // The prompt itself lives in requestProviderPermission (the one call site, AC16).
      btn.addEventListener('click', () => requestProviderPermission(col.provider, btn, hint));
      box.appendChild(btn);
      box.appendChild(checkAgainButton());
      box.appendChild(hint);
      gate.hint = hint;
    } else if (kind === GATE_LOGIN) {
      box.appendChild(el('p', 'cmp-col-state-title', t('provider_login_title', meta.label)));
      box.appendChild(el('p', 'cmp-col-state-desc', t('provider_login_desc', meta.label)));
      // Opens the provider site in a new tab (providerLoginLink — shared with the C3 action row).
      box.appendChild(providerLoginLink(col.provider));
      box.appendChild(checkAgainButton());
    } else if (kind === GATE_UNKNOWN) {
      box.appendChild(el('p', 'cmp-col-state-title', t('provider_state_unknown')));
      box.appendChild(checkAgainButton());
    } else {
      box.appendChild(el('p', 'cmp-col-state-desc cmp-col-joined', t('provider_joined_next')));
      box.appendChild(checkAgainButton());
    }
    // 「확인 중…」 while a status re-read is in flight — a line that changes, not a gate that flashes.
    const status = el('p', 'cmp-col-state-status');
    status.setAttribute('aria-live', 'polite');
    box.appendChild(status);
    gate.status = status;
    col.gate = gate;
    col.body.appendChild(box);
    syncGateStatus(col);
    track('gate_shown', { provider: col.provider, kind }); // once per gate build, not per refresh
  }

  /** Item 3: the plan label under the model pill, from the status answer; hidden when the SW has none. */
  function renderPlan(col) {
    const pstate = state.status && state.status.providers ? state.status.providers[col.provider] : null;
    const label = pstate && typeof pstate.plan === 'string' ? pstate.plan.trim() : '';
    col.plan.hidden = !label;
    col.plan.textContent = label;
    // The pill's tier tint: paid tiers (Pro / Max / Plus / Ultra / Team / Enterprise / Business …)
    // read as "paid", Free as quiet — a glance says which account is behind each column.
    col.plan.setAttribute('data-tier', /^free$/i.test(label) ? 'free' : (label ? 'paid' : ''));
    if (label) col.plan.title = t('col_plan_title', PROVIDER_META[col.provider].label);
    else col.plan.removeAttribute('title');
    renderUsage(col, pstate && pstate.usage && typeof pstate.usage === 'object' ? pstate.usage : null);
  }
  /** Whole hours/minutes until `iso`, as 「6h 29m」 / 「29m」 / 「6d 13h」; '' when unparseable or past. */
  function countdown(iso) {
    const ms = new Date(iso).getTime() - clock.now();
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d >= 1) return `${d}d ${h % 24}h`;
    if (h >= 1) return `${h}h ${m % 60}m`;
    return `${m}m`;
  }
  /** The 5h window's reset instant (ISO) when that gauge is full and the reset lies ahead (C3: explains a provider limit); null otherwise. */
  function usageResetAt(col) {
    const pstate = state.status && state.status.providers ? state.status.providers[col.provider] : null;
    const usage = pstate && pstate.usage && typeof pstate.usage === 'object' ? pstate.usage : null;
    if (!usage || !(typeof usage.h5 === 'number' && usage.h5 >= USAGE_FULL_PCT) || !usage.resetsAt5h) return null;
    return countdown(usage.resetsAt5h) ? usage.resetsAt5h : null;
  }
  /**
   * The gauge's window label from the reported span, like the popup's windowLabel(): ChatGPT
   * Free/Go report a 30-day second window (w7s = 2592000), which must not read 「7일」. Under a
   * day → hours, else days; no/garbage span → the slot's nominal label.
   */
  function windowText(spanSeconds, fallbackKey) {
    if (!(typeof spanSeconds === 'number' && Number.isFinite(spanSeconds) && spanSeconds > 0)) return t(fallbackKey);
    return spanSeconds < SECONDS_PER_DAY ? t('usage_window_hours', Math.round(spanSeconds / SECONDS_PER_HOUR)) : t('usage_window_days', Math.round(spanSeconds / SECONDS_PER_DAY));
  }
  /** One mini gauge: label · percent · a bar whose fill takes the popup's gauge colour (the number stays in text colour — AA on both themes). */
  function miniGauge(labelKey, pct, resetIso, spanSeconds) {
    const item = el('span', 'cmp-gauge');
    const head = el('span', 'cmp-gauge-head');
    const label = windowText(spanSeconds, labelKey);
    head.appendChild(el('span', 'cmp-gauge-label', label));
    const rounded = Math.round(pct);
    const value = el('span', 'cmp-gauge-value', `${rounded}%`);
    head.appendChild(value);
    item.appendChild(head);
    const bar = el('span', 'cmp-gauge-bar');
    const fill = el('span', 'cmp-gauge-fill');
    fill.style.width = `${Math.min(rounded, 100)}%`;
    fill.style.background = gaugeColor(rounded);
    bar.appendChild(fill);
    item.appendChild(bar);
    const left = resetIso ? countdown(resetIso) : '';
    item.title = left ? t('usage_resets_in', label, rounded, left) : t('usage_title', label, rounded);
    item.setAttribute('role', 'img');
    item.setAttribute('aria-label', item.title);
    return item;
  }
  /** The strip under the head: 5h + 7d gauges, or the no-limits note; hidden when nothing is known. */
  function renderUsage(col, usage) {
    clear(col.usageRow);
    if (!usage) { col.usageRow.hidden = true; return; }
    if (usage.noLimits && usage.h5 == null && usage.d7 == null) {
      col.usageRow.appendChild(el('span', 'cmp-gauge-note', t('usage_no_limits')));
      col.usageRow.hidden = false;
      return;
    }
    if (typeof usage.h5 === 'number') col.usageRow.appendChild(miniGauge('usage_5h', usage.h5, usage.resetsAt5h, usage.w5s));
    if (typeof usage.d7 === 'number') col.usageRow.appendChild(miniGauge('usage_7d', usage.d7, usage.resetsAt7d, usage.w7s));
    col.usageRow.hidden = !col.usageRow.firstChild;
  }
  function syncGateStatus(col) {
    if (col.gate && col.gate.status) col.gate.status.textContent = state.checking ? t('gate_checking') : '';
    // The gate is kept across status re-reads, so the label follows the set it would request now
    // (another column granted elsewhere / a column added or removed).
    if (col.gate && col.gate.btn) col.gate.btn.textContent = permissionButtonLabel(col.provider);
  }
  // Everything another file reaches (compare.js destructures the names it calls bare).
  Object.assign(ctx, {
    gateKindFor, checkAgainButton, providerLoginLink, permissionButtonLabel, requestProviderPermission, renderColumnGate, renderPlan, countdown, usageResetAt,
    windowText, miniGauge, renderUsage, syncGateStatus,
  });
}
