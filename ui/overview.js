// Overview ("모아 보기") — the master screen of the popup's master-detail flow.
// Renders one compact card per collected org/provider, each surfacing the 5h and 7d
// windows with their projected-at-reset value and countdown. Clicking a card drills
// into the existing detail view via selectOrg().
//
// Design note: this module deliberately REUSES the detail view's visual language
// (gauge bars + gaugeColor) and the exact projected-at-reset math (calcPredictedAtReset)
// rather than re-implementing them. The detail renderer itself is left untouched — the
// overview only hides the detail sections via a body class, so removing that class
// restores each section to whatever its own logic last set (zero regression risk).
import { escHtml, gaugeColor, formatCountdown, formatResetAbsolute, _isDark, refreshDashboardLinks, planDisplayName } from './util.js';
import { state, OVERVIEW_CLASS, isDetailHidden } from './state.js';
import { calcPredictedAtReset, NEAR_LIMIT_PCT } from './prediction.js';
import { selectOrg } from './org-selector.js';

// Drag-reorder state (module-level so the cross-device onChanged handler can tell a
// drag is in progress and skip a re-render that would yank the card mid-gesture).
let _dragSrc = null;   // the card element currently being dragged
let _dropped = false;  // a successful drop landed inside the container this gesture

export function isDragging() {
  return _dragSrc !== null;
}

// Brand logomarks (canonical simple-icons paths) so each card is identifiable at a
// glance. Brand colors: Claude orange, ChatGPT teal, Gemini blue.
const PROVIDER_LOGOS = {
  claude: '<svg viewBox="0 0 24 24" width="14" height="14" fill="#D97757"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.323.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.365-.462-.158-1.008.656-.722.881.06.225.061 2.213 1.71 1.296.957 1.74 1.282.247.157.099-.07.012-.05-.112-.187-.927-1.674-.987-1.703-.44-.705-.116-.424a2.04 2.04 0 0 1-.071-.504l.749-1.016.412-.135.997.135.42.364.62 1.413 1.004 2.233 1.557 3.038.456.9.243.832.091.255h.158v-.146l.128-1.71.237-2.099.231-2.701.08-.76.376-.91.747-.492.583.28.48.685-.067.444-.286 1.851-.559 2.902-.364 1.946h.213l.243-.243.987-1.31 1.655-2.07.73-.821.851-.906.547-.43h1.033l.76 1.13-.34 1.165-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.84-.315.834.388.09.395-.327.81-1.967.486-2.305.461-3.435.81-.043.03.05.06 1.547.146.66.037h1.62l3.017.224.79.523.473.638-.08.486-1.215.62-1.64-.389-3.83-.912-1.314-.328h-.182v.11l1.094 1.07 2.008 1.81 2.514 2.34.128.578-.323.455-.34-.049-2.2-1.654-.848-.746-1.918-1.616h-.128v.17l.443.648 2.336 3.51.121 1.077-.169.351-.606.212-.666-.121-1.37-1.922-1.414-2.166-1.14-1.94-.14.08-.674 7.253-.316.37-.728.28-.606-.461-.323-.747.323-1.48.39-1.927.315-1.533.286-1.9.171-.63-.012-.043-.14.018-1.434 1.967-2.18 2.945-1.725 1.845-.414.164-.717-.37.067-.662.401-.589 2.387-3.037 1.44-1.882 1.16-1.357 1.06-1.16-.006-.024-.085.018-.085-.007-2.337 1.967-2.18 2.945-.728 1.357-.414.164-.717-.37.067-.662.401-.589 2.387-3.037.99-1.293.93-1.083-.006-.024-.085.018-1.067-.012-2.166.225-.7.024-.738-.054-.673-.473-.394-.589-.32-1.062.45-.722Z"/></svg>',
  chatgpt: '<svg viewBox="0 0 24 24" width="14" height="14" fill="#10A37F"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7637-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.5245 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.1419.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
  gemini: '<svg viewBox="0 0 24 24" width="14" height="14" fill="#4285F4"><path d="M12 2C12 7.523 7.523 12 2 12c5.523 0 10 4.477 10 10 0-5.523 4.477-10 10-10-5.523 0-10-4.477-10-10z"/></svg>',
};

function _providerLogo(provider) {
  const svg = PROVIDER_LOGOS[provider] || PROVIDER_LOGOS.claude;
  return `<span class="ov-logo">${svg}</span>`;
}

// Per-org usage-history slices — mirrors state._filteredHistory() but for ALL orgs at
// once (we compute projections for every card, not just the selected one).
//
// Perf: state.usageHistory is one flat list of up to 30 days of points for every org.
// Slicing it with one .filter() per card was O(orgs x history) — a full scan per card on
// every render. Bucket the whole list in a SINGLE pass instead, and memoize the result so
// consecutive renders of unchanged data reuse the same slices instead of re-allocating
// tens of thousands of entries on every storage event.
let _bucketCache = { src: null, len: 0, sig: '', map: null };

// Cheap identity of the org set as far as bucketing is concerned (uuid + the two fields
// that decide who owns legacy org-less rows).
function _orgsSignature(orgs) {
  let sig = '';
  for (const o of orgs) sig += `${o.uuid}${o.isPrimary ? 1 : 0}${o.provider || 'claude'}`;
  return sig;
}

// uuid -> that org's history points, in the original chronological order.
function _historyByOrg(orgs) {
  const src = state.usageHistory || [];
  const sig = _orgsSignature(orgs);
  const c = _bucketCache;
  // Cache key: array identity + length + the org signature. Identity alone covers the
  // normal path (every reload assigns a fresh array from chrome.storage); the length check
  // is a cheap extra guard so an in-place append could never serve stale buckets.
  if (c.map && c.src === src && c.len === src.length && c.sig === sig) return c.map;

  const map = new Map();
  for (const org of orgs) map.set(org.uuid, []);
  // Legacy rows carry no .org and belong to the Claude primary org — the same rule the
  // per-org filter applied. Collected as a list so a (malformed) multi-primary org set
  // still gives every primary the legacy rows, exactly like the old per-org filter did.
  const legacyBuckets = [];
  for (const org of orgs) {
    if (org.isPrimary && (org.provider || 'claude') === 'claude') legacyBuckets.push(map.get(org.uuid));
  }
  for (const p of src) {
    if (p.org) {
      const bucket = map.get(p.org);
      if (bucket) bucket.push(p);
    } else {
      for (const bucket of legacyBuckets) bucket.push(p);
    }
  }
  _bucketCache = { src, len: src.length, sig, map };
  return map;
}

// Sort: Claude (Personal > Team > Enterprise) > ChatGPT > Gemini — matches org chips.
function _planOrder(org) {
  const p = org.provider || 'claude';
  const base = p === 'gemini' ? 200 : p === 'chatgpt' ? 100 : 0;
  if (/Enterprise/i.test(org.plan)) return base + 3;
  if (/Team/i.test(org.plan)) return base + 2;
  return base + 1;
}

// The inline "▸ X%" prediction badge — mirrors renderGaugePrediction()'s detail-gauge
// badge exactly (gray/amber/red by projected level, "100%+", green "▸ —" when stable).
function _predictBadge(cur, pred) {
  if (!pred) return ''; // insufficient history → no badge (matches detail "collecting" minus the ⏳)
  const { rate, predicted } = pred;
  if (rate <= 0 || predicted - cur < 3) {
    const bg = _isDark() ? '#22c55e30' : '#22c55e18';
    return `<span class="gauge-predict-inline" style="display:inline;color:#22c55e;background:${bg}">▸ —</span>`;
  }
  const color = predicted >= 80 ? '#ef4444' : predicted >= 50 ? '#f59e0b' : '#9ca3af';
  const txt = predicted >= 100 ? '100%+' : `${Math.round(predicted)}%`;
  return `<span class="gauge-predict-inline" style="display:inline;color:${color}">▸ ${txt}</span>`;
}

// One window column (5h or 7d) rendered with the SAME gauge classes as the detail view:
// header (label + value% + ▸ badge), bar (current fill + striped projected extension),
// sub (countdown + absolute reset). Returns '' when the window is unavailable for this
// org/plan (Free/Team 7d, unused Gemini window).
function _gaugeRow(labelKey, current, pred, resetAt) {
  if (current === null || current === undefined) return '';
  const cur = Math.round(current);
  const valColor = gaugeColor(cur);
  let predFill = '';
  if (pred && pred.rate > 0 && pred.predicted - cur >= 3) {
    const pColor = pred.predicted >= 80 ? '#ef4444' : pred.predicted >= 50 ? '#f59e0b' : '#9ca3af';
    const target = Math.min(pred.predicted, 100);
    predFill = `<div class="gauge-predict-fill" style="display:block;left:${Math.min(cur, 100)}%;width:${Math.max(target - cur, 0)}%;color:${pColor}"></div>`;
  }
  const sub = resetAt
    ? `<div class="gauge-sub">⏱ ${formatCountdown(resetAt)}<br>↻ ${formatResetAbsolute(resetAt)}</div>`
    : '';
  // Limit forecast (mirrors the detail view): exact "한도 도달 예상 {time}" when the window is
  // projected to hit 100% before reset, else a "한도 근접 (~X%)" heads-up when it's near the cap.
  // Keeps the compact card quiet below the near-limit threshold.
  let limitLine = '';
  if (pred && pred.rate > 0 && current < 100) {
    if (pred.predicted >= 100) {
      const hoursTo100 = pred.hoursTo100 != null ? pred.hoursTo100 : (100 - current) / pred.rate;
      const limitTime = formatResetAbsolute(new Date(Date.now() + hoursTo100 * 3600000));
      limitLine = `<div class="gauge-sub" style="color:#ef4444;font-weight:600">⚠️ ${escHtml(t('predict_limit_at', limitTime))}</div>`;
    } else if (pred.predicted >= NEAR_LIMIT_PCT) {
      limitLine = `<div class="gauge-sub" style="color:#ef4444;font-weight:600">⚠️ ${escHtml(t('predict_near_limit', Math.floor(pred.predicted)))}</div>`;
    }
  }
  return '<div class="gauge-row">'
    + '<div class="gauge-header">'
    + `<span class="gauge-label">${t(labelKey)}</span>`
    + `<span class="gauge-value" style="color:${valColor}">${cur}%</span>`
    + _predictBadge(cur, pred)
    + '</div>'
    + '<div class="gauge-bar">'
    + `<div class="gauge-fill" style="width:${Math.min(cur, 100)}%;background:${valColor}"></div>`
    + predFill
    + '</div>'
    + sub
    + limitLine
    + '</div>';
}

// Usage-based Enterprise: a single spend-cap gauge row (no 5h/7d).
function _spendRow(org) {
  const used = Math.round((org.spendUsed || 0) / 100);
  const limit = Math.round(org.spendLimit / 100);
  const pct = Math.round((org.spendUsed || 0) / org.spendLimit * 100);
  const color = gaugeColor(pct);
  return '<div class="gauge-row">'
    + '<div class="gauge-header"><span class="gauge-label">Enterprise</span>'
    + `<span class="gauge-value" style="color:${color}">${pct}%</span></div>`
    + `<div class="gauge-bar"><div class="gauge-fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div></div>`
    + `<div class="gauge-sub">$${used} / $${limit}</div></div>`;
}

// `hist` is this org's pre-bucketed history slice (see _historyByOrg).
function _renderCard(org, hist) {
  const provider = org.provider || 'claude';
  const isEnterprise = /Enterprise/i.test(org.plan);
  const isUsageBased = isEnterprise && org.h5 == null && org.d7 == null;
  // No-limit Gemini plan (Workspace/Business/Enterprise): flagged by the collector
  // by plan (these seats report 0% windows). Show "no usage limits" not "0%".
  const isNoLimitGemini = provider === 'gemini' && !!org.noLimits;
  // The brand logo identifies the provider, so the plan name no longer needs a
  // "GPT "/"Gemini " text prefix.
  const beta = (provider === 'chatgpt' || provider === 'gemini') ? '<span class="org-chip-beta">Beta</span>' : '';
  const pin = org.isPrimary ? '<span class="ov-pin" title="primary">📌</span>' : '';

  let rows = '';
  if (isUsageBased) {
    // Usage-based Enterprise: spend cap instead of 5h/7d. Branch on isUsageBased
    // FIRST — without a spendLimit there are no 5h/7d values either, so falling
    // through to the h5/d7 branch would render a card with no rows at all.
    rows = org.spendLimit > 0
      ? _spendRow(org)
      // No spend cap configured: Enterprise unlimited fallback (mirrors selectOrg).
      : `<div class="gauge-row"><span class="ov-unlimited">${escHtml(t('enterprise_unlimited'))}</span></div>`;
  } else if (isNoLimitGemini) {
    // Gemini plan with no 5h/7d limits: single "no usage limits" row.
    rows = `<div class="gauge-row"><span class="ov-unlimited">${escHtml(t('gemini_no_limit'))}</span></div>`;
  } else {
    const p5 = calcPredictedAtReset(hist, 'h5', org.h5 ?? null, org.resetsAt5h);
    rows += _gaugeRow('usage_5h', org.h5, p5, org.resetsAt5h);
    const p7 = calcPredictedAtReset(hist, 'd7', org.d7 ?? null, org.resetsAt7d);
    rows += _gaugeRow('usage_7d', org.d7, p7, org.resetsAt7d);
  }

  return `<div class="ov-card${org.isPrimary ? ' primary' : ''}" data-org-id="${escHtml(org.uuid)}">`
    + '<div class="ov-head">'
    + `<span class="ov-grip" draggable="true" title="${escHtml(t('ov_reorder'))}" aria-label="${escHtml(t('ov_reorder'))}">⠿</span>`
    + _providerLogo(provider)
    + `<span class="ov-plan">${escHtml(planDisplayName(org.plan, provider))}</span>${beta}`
    + `<span class="ov-name">${escHtml(org.name || '')}</span>${pin}`
    + '<span class="ov-chevron" aria-hidden="true">›</span>'
    + '</div>'
    + `<div class="ov-gauges">${rows}</div>`
    + '</div>';
}

// Order cards by the user's saved drag order (state.overviewOrder, a list of uuids);
// orgs not in the saved order (newly added) fall back to the default _planOrder and
// sort after the explicitly-ordered ones.
function _orderedOrgs(orgs) {
  const saved = state.overviewOrder || [];
  const rank = uuid => {
    const i = saved.indexOf(uuid);
    return i === -1 ? Infinity : i;
  };
  return [...orgs].sort((a, b) => {
    const ra = rank(a.uuid), rb = rank(b.uuid);
    if (ra !== rb) return ra - rb;
    return _planOrder(a) - _planOrder(b);
  });
}

// Persist the current visual card order (DOM) to chrome.storage.sync (cross-device).
function _persistOrder(sec) {
  const ids = [...sec.querySelectorAll('.ov-card')].map(c => c.dataset.orgId);
  state.overviewOrder = ids;
  chrome.storage.sync.set({ overviewOrder: ids });
}

// Find the card the dragged element should be inserted before, based on cursor Y.
function _dragAfterElement(sec, y) {
  const cards = [...sec.querySelectorAll('.ov-card:not(.ov-dragging)')];
  let closest = { offset: -Infinity, el: null };
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el: card };
  }
  return closest.el;
}

// Every card handler lives on the container instead of on the N cards, so a re-render
// never rebinds anything. Assignment (not addEventListener) keeps it idempotent — the
// same trick the dragover/drop handlers already used.
function _bindDelegation(sec) {
  sec.onclick = e => {
    // One-time hint's ✕ (previously its own listener with stopPropagation).
    if (e.target.closest('#ov-hint-x')) {
      state.overviewHintDismissed = true;
      chrome.storage.local.set({ overviewHintDismissed: true });
      const h = sec.querySelector('#ov-hint');
      if (h) h.remove();
      return;
    }
    // The grip is a drag handle only — clicking it must NOT drill into the detail view
    // (this replaces the grip's stopPropagation listener).
    if (e.target.closest('.ov-grip')) return;
    const card = e.target.closest('.ov-card');
    if (card) enterDetail(card.dataset.orgId);
  };

  // Only grips are draggable=true, so dragstart/dragend can only originate there.
  sec.ondragstart = e => {
    const grip = e.target.closest('.ov-grip');
    if (!grip) return;
    const card = grip.closest('.ov-card');
    if (!card) return;
    _dragSrc = card;
    _dropped = false;
    card.classList.add('ov-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', card.dataset.orgId); } catch (_) { /* some browsers require a payload */ }
    if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(card, 16, 16);
  };
  sec.ondragend = () => {
    if (!_dragSrc) return;
    _dragSrc.classList.remove('ov-dragging');
    const dropped = _dropped;
    _dragSrc = null;
    _dropped = false;
    // Order is committed in the drop handler. If the drag was cancelled (Esc) or
    // released outside the container, no drop fired — revert the live dragover
    // shuffle by re-rendering from the last saved order.
    if (!dropped) renderOverview();
  };

  // Container-level dragover/drop reorder the dragged card live.
  sec.ondragover = e => {
    if (!_dragSrc) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const after = _dragAfterElement(sec, e.clientY);
    if (after == null) sec.appendChild(_dragSrc);
    else if (after !== _dragSrc) sec.insertBefore(_dragSrc, after);
  };
  // Persist only on a real drop inside the container (not on every dragend), so a
  // cancelled/outside drag never commits a half-shuffled order.
  sec.ondrop = e => {
    if (!_dragSrc) return;
    e.preventDefault();
    _dropped = true;
    _persistOrder(sec);
  };
}

// HTML of the last committed render, used to skip an identical DOM teardown.
let _lastHtml = null;

// True when the cards on screen are exactly `orgs`, in order. A cancelled drag leaves the
// DOM shuffled while the markup is byte-identical, so the skip below MUST check this —
// otherwise the revert re-render would be skipped and the shuffle would stick.
function _domInSync(sec, orgs) {
  const cards = sec.querySelectorAll('.ov-card');
  if (cards.length !== orgs.length) return false;
  for (let i = 0; i < orgs.length; i++) {
    if (cards[i].dataset.orgId !== orgs[i].uuid) return false;
  }
  return true;
}

// (Re)render the overview card list from state.collectedOrgs into #overview-section.
export function renderOverview() {
  const sec = document.getElementById('overview-section');
  if (!sec) return;
  const orgs = _orderedOrgs(state.collectedOrgs || []);
  const byOrg = _historyByOrg(orgs);
  // One-time hint teaching that a card click drills into the detail view (so users
  // migrating from the old single-view don't think the detail screen disappeared).
  const hint = state.overviewHintDismissed
    ? ''
    : `<div class="ov-hint" id="ov-hint"><span>💡 ${escHtml(t('ov_click_hint'))}</span>`
      + `<button class="ov-hint-x" id="ov-hint-x" aria-label="dismiss">✕</button></div>`;
  const html = hint + orgs.map(o => _renderCard(o, byOrg.get(o.uuid) || [])).join('');

  // renderOverview() re-runs on every storage change (background collection, cross-device
  // order sync, ...). When the markup is unchanged, skip the innerHTML teardown entirely —
  // that also preserves :hover/scroll state instead of rebuilding identical nodes.
  if (html !== _lastHtml || !_domInSync(sec, orgs)) {
    sec.innerHTML = html;
    _lastHtml = html;
  }

  _bindDelegation(sec);
}

// Reflect the active view in the top tab bar (모아 보기 | 자세히).
function _syncTabs(view) {
  const ov = document.getElementById('tab-overview');
  const dt = document.getElementById('tab-detail');
  if (ov) ov.classList.toggle('active', view === 'overview');
  if (dt) dt.classList.toggle('active', view === 'detail');
}

// Mark the tab matching the currently-visible view active. Used after live updates
// that unhide the tabs without going through enter{Overview,Detail} (e.g. a
// single→multi org transition while already in the detail view).
export function syncViewTabs() {
  _syncTabs(isOverviewActive() ? 'overview' : 'detail');
}

// Remember which view the user last looked at, so reopening the popup restores it
// (multi-account only — single-account users always land on detail).
function _saveLastView(view) {
  state.lastView = view;
  chrome.storage.local.set({ lastView: view });
}

// Perf instrumentation for the 자세히 → 모아 보기 transition. Marks/measures only (no
// logging, no visual effect); read them with
// performance.getEntriesByName('ct-overview-enter') from the popup devtools console.
const PERF_START = 'ct-overview-enter-start';
const PERF_HIDDEN = 'ct-overview-detail-hidden';
const PERF_TOTAL = 'ct-overview-enter';
const PERF_HIDE = 'ct-overview-hide-detail';
const PERF_RENDER = 'ct-overview-render';

// Show the master (overview) screen: hide detail sections, render cards.
export function enterOverview() {
  performance.mark(PERF_START);
  document.body.classList.add(OVERVIEW_CLASS);
  const sec = document.getElementById('overview-section');
  if (sec) sec.classList.remove('hidden');
  performance.mark(PERF_HIDDEN);
  renderOverview();
  performance.measure(PERF_HIDE, PERF_START, PERF_HIDDEN);
  performance.measure(PERF_RENDER, PERF_HIDDEN);
  performance.measure(PERF_TOTAL, PERF_START);
  performance.clearMarks(PERF_START);
  performance.clearMarks(PERF_HIDDEN);
  _syncTabs('overview');
  _saveLastView('overview');
  refreshDashboardLinks(null); // overview = all orgs → header link goes to plain dashboard
  window.scrollTo(0, 0);
}

// Drill into a specific org's detail view. Reuses the existing selectOrg() renderer.
export function enterDetail(orgId) {
  document.body.classList.remove(OVERVIEW_CLASS);
  const sec = document.getElementById('overview-section');
  if (sec) sec.classList.add('hidden');
  state.selectedOrgId = orgId;
  selectOrg(orgId, null);
  document.querySelectorAll('.org-chip').forEach(c => c.classList.toggle('selected', c.dataset?.orgId === orgId));
  _syncTabs('detail');
  _saveLastView('detail');
  window.scrollTo(0, 0);
}

// Leave the overview screen without drilling into a specific org. Used when the
// account count drops below 2 (overview is no longer applicable) — without this,
// a multi→zero-org transition would leave the body class set and strand the user
// on a frozen overview with no way back.
export function exitOverview() {
  document.body.classList.remove(OVERVIEW_CLASS);
  const sec = document.getElementById('overview-section');
  if (sec) sec.classList.add('hidden');
}

// True when the overview (master) screen is currently shown. Same predicate as
// state.isDetailHidden() — kept as the name the popup's view logic reads by.
export function isOverviewActive() {
  return isDetailHidden();
}
