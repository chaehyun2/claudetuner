// Single source of truth for the fact lines shown under a usage gauge, in BOTH
// the detail tab (written into #gauge-{id}-reset by the DOM writers below) and the
// overview tab (embedded as a string by ui/overview.js). The pure build* helpers
// return HTML; the render* helpers just write it to the detail DOM. Keeping one
// builder is what stops the two tabs from drifting apart.
//
// Three states share the one slot:
//   • at risk → buildWaitFactsHtml(): wait-span headline + limit/reset evidence.
//   • normal  → buildResetFactsHtml(): a single reset line (absolute + relative).
//   • idle    → buildResetFactsHtml() with a window but no reset (Claude's 5h is
//               usage-anchored, so at 0% there is no reset time) → a quiet hint.
import { formatCountdown, formatResetAbsolute, formatDuration, isWithinRelativeDay } from './util.js';

// A wait block has two time rows (limit-hit + reset). Keep them in ONE format:
// relative-day (오늘/내일) only when BOTH are within ±1 day, else both as dates —
// so a 7d block (reset days out) never mixes "내일 17:07" with "8/4(화) 13:05".
function blockTimeOpts(...times) {
  return { absoluteDate: !times.every((t) => isWithinRelativeDay(t)) };
}

// A relative countdown ("2h 11m") earns its space only when the reset is near —
// past a day out, the absolute date is the more useful anchor. This is an
// information-value cut, not a width cut, so it holds in every language.
const RELATIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

function relativeIfNear(at) {
  const diff = new Date(at).getTime() - Date.now();
  return diff > 0 && diff < RELATIVE_WINDOW_MS ? formatCountdown(at) : '';
}

// One "label / value (+ optional relative)" row of the detail grid.
function factRow(label, absText, relText, hit) {
  const cls = hit ? ' r-hit' : '';
  const rel = relText ? ` <span class="gf-rel">${relText}</span>` : '';
  return `<span class="gf-k${cls}">${label}</span>` +
         `<span class="gf-v${cls}">${absText}${rel}</span>`;
}

// Normal / idle state. `hasWindow` = the gauge has a utilization value (so the
// window exists) even when `resetsAt` is absent. With a reset → the reset line;
// with a window but no reset → a quiet "no recent usage" hint (an idle Claude 5h
// window has no reset time); with neither → empty (caller may overwrite, e.g. the
// Free/Team no-7d message).
export function buildResetFactsHtml(resetsAt, hasWindow) {
  if (resetsAt) {
    return `<div class="gf-why">` +
      factRow(t('gauge_label_reset'), formatResetAbsolute(resetsAt), relativeIfNear(resetsAt), false) +
      `</div>`;
  }
  if (hasWindow) return `<div class="gf-idle">${t('gauge_reset_idle')}</div>`;
  return '';
}

// At-risk state: the window is projected to reach 100% before it resets. The wait
// span (limit-hit → reset) is the headline; the limit-hit and reset times are its
// evidence. `hoursTo100` / `hoursToReset` already come from calcPredictedAtReset().
// The wait is an estimate, so it's shown approximately (formatDuration rounds to
// the hour); the times are day-relative + 24h, so a limit-hit and reset that
// straddle midnight read "오늘 23:00 → 내일 2:00" with no date confusion. Falls back
// to the reset line when there is no reset or no positive wait to show.
export function buildWaitFactsHtml(resetsAt, hoursTo100, hoursToReset, hasWindow) {
  if (!resetsAt) return buildResetFactsHtml(resetsAt, hasWindow);
  const waitMs = (hoursToReset - hoursTo100) * 3600000;
  if (!(waitMs > 0)) return buildResetFactsHtml(resetsAt, hasWindow);
  const hitMs = Date.now() + hoursTo100 * 3600000;
  const fmt = blockTimeOpts(hitMs, resetsAt);

  return `<div class="gf-lead">${t('gauge_wait_lead', formatDuration(waitMs))}</div>` +
    `<div class="gf-why">` +
    // Limit-hit: absolute time only (the wait headline already conveys the gap).
    factRow(t('gauge_label_limit'), formatResetAbsolute(hitMs, fmt), '', true) +
    // Reset: absolute time + a countdown when it's near (relativeIfNear).
    factRow(t('gauge_label_reset'), formatResetAbsolute(resetsAt, fmt), relativeIfNear(resetsAt), false) +
    `</div>`;
}

// Already-capped state: the window is at 100% right now. Show when the cap was hit
// (a PAST time, estimated from history) and the total wait it implies (hit → reset).
// `hitMs` may be null when history doesn't cover the crossing → then just the reset
// line (with a "capped" note is overkill; the value already reads 100%).
export function buildCappedFactsHtml(resetsAt, hitMs, hasWindow) {
  if (!resetsAt) return buildResetFactsHtml(resetsAt, hasWindow);
  // The hit row and the wait headline are a pair: show them only when the hit time
  // is known AND sits before the reset (a positive wait). An unknown hit (null) or a
  // hit at/after the reset (stale reset / clock skew) → reset line alone, which still
  // answers "when am I back".
  const waitMs = hitMs != null ? new Date(resetsAt).getTime() - hitMs : 0;
  const showHit = waitMs > 0;
  // Same format for both rows when the hit row shows (else just the reset row, which
  // sets its own format per-timestamp).
  const fmt = showHit ? blockTimeOpts(hitMs, resetsAt) : undefined;
  return (showHit ? `<div class="gf-lead">${t('gauge_wait_capped', formatDuration(waitMs))}</div>` : '') +
    `<div class="gf-why">` +
    (showHit ? factRow(t('gauge_label_limit'), formatResetAbsolute(hitMs, fmt), '', true) : '') +
    factRow(t('gauge_label_reset'), formatResetAbsolute(resetsAt, fmt), relativeIfNear(resetsAt), false) +
    `</div>`;
}

// === Detail-tab DOM writers (thin wrappers over the builders above) ===
// `id` is the gauge suffix used by the popup DOM: '5h' or '7d'.

// Clears the container when there's nothing to show rather than leaving whatever a
// previously viewed org rendered — a window that lost its limit must not keep a
// stale countdown. `hasWindow` drives the idle hint (see buildResetFactsHtml).
export function renderGaugeReset(id, resetsAt, hasWindow) {
  const el = document.getElementById(`gauge-${id}-reset`);
  if (!el) return;
  el.innerHTML = buildResetFactsHtml(resetsAt, hasWindow);
}

export function renderGaugeCapped(id, resetsAt, hitMs, hasWindow) {
  const el = document.getElementById(`gauge-${id}-reset`);
  if (!el) return;
  el.innerHTML = buildCappedFactsHtml(resetsAt, hitMs, hasWindow);
}

export function renderGaugeWait(id, resetsAt, hoursTo100, hoursToReset, hasWindow) {
  const el = document.getElementById(`gauge-${id}-reset`);
  if (!el) return;
  el.innerHTML = buildWaitFactsHtml(resetsAt, hoursTo100, hoursToReset, hasWindow);
}
