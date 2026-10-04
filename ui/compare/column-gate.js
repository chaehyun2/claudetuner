// ui/compare/column-gate.js — the column GATE slice of mountComparePage() (compare.js): what a
// column body shows before the provider can take part (permission prompt, sign-in, unknown),
// the provider plan line and the mini usage gauges under the column head. Provider facts, joined
// through col.provider. Bodies are exactly as they were in compare.js; ctx contract: see
// ui/compare/history.js.

import { PROVIDER_META, SECONDS_PER_HOUR, SECONDS_PER_DAY, GATE_PERMISSION, GATE_LOGIN, GATE_UNKNOWN, USAGE_FULL_PCT } from './constants.js';
// The popup's gauge palette (ui/util.js is dependency-free): the mini gauges here read like the
// overview cards — same thresholds, same colours (user request 2026-09-18).
import { gaugeColor } from '../util.js';
// The plan tier rule (#2054 D) — one answer for the pill's tint, the judge's tie-break and the moderator seat.
import { planTier } from './debate-core.js';

// ── a column's account (#2054 ③): Claude may send each column to a different claude.ai org ──
/** The claude.ai org a Claude column's thread lives in (its continuation), or null (no thread yet / another provider). */
export function threadOrgOf(col) {
  const c = col && col.provider === 'claude' ? col.continuation : null;
  return c && typeof c === 'object' && typeof c.orgId === 'string' && c.orgId ? c.orgId : null;
}
const claudeStatusOf = (status) => (status && status.providers && status.providers.claude && typeof status.providers.claude === 'object' ? status.providers.claude : null);
/**
 * The claude.ai org a Claude column SENDS to: its thread's org once it has one (a resumed conversation
 * goes to ITS org), else the status' send org; null when neither is known (no claude.ai tab at the
 * status = the collector's primary) and for every other provider.
 */
export function columnSendOrg(status, col) {
  if (!col || col.provider !== 'claude') return null;
  const st = claudeStatusOf(status);
  return threadOrgOf(col) || (st && typeof st.orgUuid === 'string' && st.orgUuid ? st.orgUuid : null);
}
/**
 * Which account of its provider a column uses, as a key two columns compare: the send org for Claude
 * once the status names orgs (`orgUuid`), else null — one account per provider, as before (other
 * providers, an older SW, a status without Claude facts). Columns of one provider with the same key
 * share the plan pill, the gauges and the 「같은 계정」 chip; different keys each show their own.
 */
export function columnAccount(status, col) {
  const st = col && col.provider === 'claude' ? claudeStatusOf(status) : null;
  return st && typeof st.orgUuid === 'string' ? columnSendOrg(status, col) : null;
}
/**
 * The provider facts a column's head shows (#2054). Claude: those of the org the column SENDS to,
 * looked up in `providers.claude.orgs`; an org the status knows nothing about shows nothing, never
 * another org's plan or gauges. Other providers: the provider's facts as they are. The ONE place a
 * per-column reader (plan pill, gauges, a limit's reset time, the default judge) gets them from.
 */
export function columnFacts(status, col) {
  const pstate = col && status && status.providers ? status.providers[col.provider] : null;
  const org = columnAccount(status, col);
  if (!pstate || !org || org === pstate.orgUuid) return pstate || null;
  const facts = pstate.orgs && typeof pstate.orgs === 'object' && Object.prototype.hasOwnProperty.call(pstate.orgs, org) ? pstate.orgs[org] : null;
  return facts && typeof facts === 'object' ? facts : null;
}

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
    return permissionPendingProviders(provider);
  }
  /**
   * The same set without a pressed button (#1838): every visible column's provider still lacking
   * site access — what ONE prompt at 「보내기」 covers. `first` (a pressed gate's provider) leads
   * and is included even if the status has not caught up.
   */
  function permissionPendingProviders(first = null) {
    // No status yet = no facts: gateKindFor(null) reads as "permission", which would put every
    // column in a send-time prompt before the page even knows what is granted.
    if (!first && !(state.status && state.status.providers)) return [];
    const out = first ? [first] : [];
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
  /**
   * 🔴 THE ONLY chrome.permissions.request IN THE COMPARE FEATURE (AC16). Reached from a user
   * gesture only — the gate / action-row buttons (requestProviderPermission) and, since #1838, the
   * send button (compare.js sendInitial). The request is this function's FIRST statement, before
   * any await, so a caller that invokes it synchronously inside its click / keydown handler keeps
   * the gesture Chrome requires. `{ granted, unavailable }` — `unavailable`: inside the web shell's
   * iframe Chrome may decline to SHOW the prompt at all (the call rejects — a user's "no" resolves
   * false and does not land there). `via` tags the analytics event with the path that asked.
   */
  async function askSitePermission(providers, via = null) {
    let granted = false;
    let unavailable = false;
    try { granted = (await chrome.permissions.request({ origins: providers.map((p) => PROVIDER_META[p].origin) })) === true; } catch {
      unavailable = !!embedHost;
    }
    // One event per provider the prompt covered, so the per-provider gate → grant funnel stays comparable.
    for (const p of providers) track('permission_result', via ? { provider: p, granted, via } : { provider: p, granted });
    return { granted, unavailable };
  }
  /** The send path's 「the prompt moved to an extension tab」 line, in every column still waiting on access (#1838). */
  function notePermissionTabHint() {
    for (const col of state.columns.values()) {
      if (col.gate && col.gate.kind === GATE_PERMISSION && col.gate.hint) col.gate.hint.textContent = t('provider_permission_tab_hint');
    }
  }
  async function requestProviderPermission(provider, btn, hint) {
    if (state.disabled) return;
    const providers = providersNeedingPermission(provider);
    btn.disabled = true;
    try {
      // The extension's own tab is where the prompt is guaranteed when the iframe refused to show it:
      // open this page there with the same query and say so. The button stays; a retry is possible.
      const { unavailable: promptUnavailable } = await askSitePermission(providers);
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
    const pstate = columnFacts(state.status, col);
    const label = pstate && typeof pstate.plan === 'string' ? pstate.plan.trim() : '';
    // `org` (#2054): the workspace a send uses, named only when it could be mistaken (several orgs,
    // not the one Claude Tuner's popup shows) — the SW decides; one-org accounts never see it.
    const orgName = label && pstate && typeof pstate.org === 'string' ? pstate.org.trim() : '';
    col.plan.hidden = !label;
    col.plan.textContent = label;
    if (orgName) col.plan.appendChild(el('span', 'cmp-col-plan-org', `· ${orgName}`));
    // The pill's tier tint: paid tiers (Pro / Max / Plus / Ultra / Team / Enterprise / Business …)
    // read as "paid", Free as quiet — a glance says which account is behind each column.
    // A label no rule knows (`unknown`, Claude `API`, a new tier) is neither — no tint (#2054 D).
    const tier = label ? planTier(col.provider, label) : null;
    col.plan.setAttribute('data-tier', tier === 'unknown' || !tier ? '' : tier);
    if (orgName) col.plan.title = t('col_plan_org_title', PROVIDER_META[col.provider].label, orgName);
    else if (label) col.plan.title = t('col_plan_title', PROVIDER_META[col.provider].label);
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
    const pstate = columnFacts(state.status, col); // the org this column sent to (#2054 ③), not the provider's new-chat org
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
    gateKindFor, checkAgainButton, providerLoginLink, permissionButtonLabel, requestProviderPermission, permissionPendingProviders, askSitePermission, notePermissionTabHint, renderColumnGate, renderPlan, countdown, usageResetAt,
    windowText, miniGauge, renderUsage, syncGateStatus,
    // Per-column account facts over the live status (#2054 ③) — the module functions above, bound to state.
    columnFacts: (col) => columnFacts(state.status, col), columnSendOrg: (col) => columnSendOrg(state.status, col), columnAccount: (col) => columnAccount(state.status, col),
  });
}
