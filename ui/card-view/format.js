// Pure card-view formatters — the display rules a usage card is drawn from (#2153).
//
// Shared by the extension popup (through the compatibility wrappers in ui/util.js) and the desktop
// app, which bundles this directory straight from the repo. That second consumer has no `chrome`,
// no popup DOM and no i18n.js, so this file must stay runtime-neutral:
//   • no `chrome.*`, no `document` / `window`, no network or storage;
//   • NO GLOBAL `t`. Every word comes in through a `labels` object (the same shape idea as the
//     Android widget's Presentation.Labels): a set of functions returning localized strings. The
//     popup builds its labels from i18n.js `t` (ui/util.js extLabels()); the desktop app from its
//     own dictionary.
// Pinned by test/prediction-core-purity-guard.mjs [6]/[7]. Imports must be equally neutral.
//
// Labels contract (every member is a function, read lazily at call time so a language switch
// needs no rebuild):
//   windowHours(n) / windowDays(n)  → a bare window unit: '5시간' / '30-Day'
//   usageWindow(unit)               → a gauge label around that unit: '30일 사용률'
//   countdownSoon()                 → the countdown once the reset time has passed
//   durM(m) / durH(h) / durD(d) / durDH(d, h) → an approximate wait span
//   agoJustNow() / agoMin() / agoHour() / agoDay() → "updated N ago" (suffixes after the number)

import { usageLevel } from '../usage-tiers.js';

// ── Usage-window labels (#954) ────────────────────────────────────────────────────────────────
//
// The 5h / 7d slots are SLOTS, not window lengths. ChatGPT Free and Go report a **30-day** window
// in the 7d slot (938 + 80 users; 98.5% / 99.9% of their rows, measured 2026-08-26), so
// "7일 사용률" is a false label for them. The provider's own `limit_window_seconds` is the truth
// and it rides every response; these helpers turn it into a label.
//
// 🔴 Do NOT derive the window from the provider or the plan name. Within ChatGPT alone Plus is 7
// days and Free is 30, so a provider test is wrong in BOTH directions — which is exactly how the
// team Race broke (#952). The span is a property of (plan, point in time); read it from the data.
//
// A null/absent span means "not reported" (an older client, or a provider that does not send one,
// e.g. Claude) → callers fall back to the static usage_5h / usage_7d labels, so nothing changes
// for anyone whose window really is the slot's nominal length.
const WINDOW_HOUR = 3600;
const WINDOW_DAY = 86400;

/** True when `seconds` is a usable span. Rejects 0 and negatives, not merely non-numbers. */
function isSpan(seconds) {
  return typeof seconds === 'number' && isFinite(seconds) && seconds > 0;
}

/**
 * Short slot label for a chart tab: '5h' / '7d' / '30d'.
 * Returns null when there is no span, so the caller keeps its existing hard-coded label.
 */
export function formatWindowShort(seconds) {
  if (!isSpan(seconds)) return null;
  if (seconds < WINDOW_DAY) return `${Math.round(seconds / WINDOW_HOUR)}h`;
  return `${Math.round(seconds / WINDOW_DAY)}d`;
}

/**
 * The reported window as a bare UNIT — '5시간' / '30일' / '5-Hour' / '30-Day' — or null when the
 * provider reported nothing. Split out of formatWindowLabel because the STATUS BANNER names the
 * window in a sentence and must use the same words as the gauge label above it: the banner used
 * static t('win_7d') while projecting from the real span, so a ChatGPT Free/Go user read a
 * "7일" verdict about a 30-day window (#978, caught in review).
 */
export function windowUnitLabel(seconds, labels) {
  if (!isSpan(seconds)) return null;
  return seconds < WINDOW_DAY
    ? labels.windowHours(Math.round(seconds / WINDOW_HOUR))
    : labels.windowDays(Math.round(seconds / WINDOW_DAY));
}

/**
 * Full gauge label: '30일 사용률' / '30-Day Usage'.
 * Returns null when there is no span (caller falls back to the slot's static label).
 */
export function formatWindowLabel(seconds, labels) {
  const unit = windowUnitLabel(seconds, labels);
  return unit == null ? null : labels.usageWindow(unit);
}

/**
 * THE way to label a usage gauge. Every caller goes through this rather than writing
 * `formatWindowLabel(x) || fallback` itself — one rule, one place to change.
 *
 * `fallback` is the slot's static label ('5시간 사용률' / '7-Day Usage'), used when the provider
 * reported no span. That keeps Claude and every pre-span stored org rendering exactly as before.
 * Pass the string, or a function returning it — the function is only called when it is needed, so
 * a caller translating it pays nothing on the common (span reported) path.
 */
export function windowLabel(spanSeconds, fallback, labels) {
  return formatWindowLabel(spanSeconds, labels) || (typeof fallback === 'function' ? fallback() : fallback);
}

// ── Colour ───────────────────────────────────────────────────────────────────────────────────

// The bar colour of a usage %: the shared 50/80 judgement (ui/usage-tiers.js usageLevel, #2067) on
// the popup's palette. usage-shared.js (content scripts) answers the same from its synced copy.
// No reading is the low shade, as before.
const GAUGE_LEVEL_COLORS = { high: '#ef4444', mid: '#f59e0b', low: '#06b6d4' };
export function gaugeColor(util) {
  return GAUGE_LEVEL_COLORS[usageLevel(util)] || GAUGE_LEVEL_COLORS.low;
}

// ── Time ─────────────────────────────────────────────────────────────────────────────────────

// Relative countdown, compact and language-neutral: "6h 29m" / "6d 13h" / "29m".
// Only the "resetting soon" word is localized; the units stay d/h/m so the popup
// and the three sidebars share one shape and the i18n surface stays tiny.
export function formatCountdown(resetAt, labels) {
  const diff = new Date(resetAt).getTime() - Date.now();
  if (diff <= 0) return labels.countdownSoon();
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) {
    const d = Math.floor(h / 24), rem = h % 24;
    return rem > 0 ? `${d}d ${rem}h` : `${d}d`;
  }
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}

// Approximate wait span for the headline ("약 3시간" reads as "3시간"; caller adds
// 약/예상). Rounded to the hour (the wait is an estimate — a limit-hit derived from
// a burn rate or a sampled history point), so no minute bucket: "3시간" / "4일 4시간".
export function formatDuration(ms, labels) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  if (totalMin < 60) return labels.durM(totalMin);
  const totalHours = Math.round(ms / 3600000);
  if (totalHours >= 24) {
    const days = Math.floor(totalHours / 24), rem = totalHours % 24;
    return rem > 0 ? labels.durDH(days, rem) : labels.durD(days);
  }
  return labels.durH(totalHours);
}

// "Updated N ago" for the last collection time.
export function formatTimeAgo(timestamp, labels) {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return labels.agoJustNow();
  if (minutes < 60) return `${minutes}${labels.agoMin()}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${labels.agoHour()}`;
  return `${Math.floor(hours / 24)}${labels.agoDay()}`;
}
