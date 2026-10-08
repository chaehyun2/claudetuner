// Usage-limit reset passes in the popup detail view (#2092 P1-1 · P1-2 · P1-3).
//
// Three surfaces, one input — the viewed org's `resetPasses` summary (bg/reset-pass-model.js):
//   1. the holdings chip under the gauges — its HTML comes from usage-shared.js (CORE), the one
//      builder the in-page sidebars draw with too; this file only places it
//   2. the 「지금 풀 수 있어요 ↗」 suffix on the limit-reached headline — decided by
//      canClearNow() over EVERY window at its limit, never only the one the headline names
//   3. the 7d forecast guard: a held-pass note in the 「리셋 전 소진 예상」 state
//
// Loadable under plain Node (test/limit-eta-guard.mjs imports prediction.js, which imports this):
// no chrome.* / document access at module load. `t`/`getLang` are i18n.js globals.
import { _filteredHistory } from './state.js';
import { formatResetAbsolute, formatDuration } from './util.js';
import {
  canClearNow, clearNowCall, holdsAny, blockedSlotsOf, resetPassSiteUrl, resetPassHelpUrl, resetPassAdvice, pastWeeklyBlocks,
} from '../bg/reset-pass-model.js';
import { SITE_ORIGINS } from '../vendor-ai/sites.js';

const core = () => globalThis.__ctUsageCore || {};

// ── Which slots are blocked ──────────────────────────────────────────────────────────────────
/** Every account window at its limit right now, as slot names — bg/reset-pass-model.js
 *  blockedSlotsOf over the values THIS render is showing (the primary path reads the snapshot,
 *  which can be fresher than the org entry). A non-nominal span (ChatGPT Free/Go 30-day window)
 *  becomes a slot no pass clears. Scoped per-model limits are not account blocks. */
export function blockedSlots(util5h, util7d, span5h, span7d) {
  return blockedSlotsOf({ h5: util5h, d7: util7d, w5s: span5h ?? null, w7s: span7d ?? null });
}

/** The provider's usage-settings page (the only place a pass is spent), or null. */
export function resetPassLink(provider) {
  return resetPassSiteUrl(provider, SITE_ORIGINS);
}

const providerOf = (org) => (org && org.provider) || 'claude';

// ── 1. Holdings chip ─────────────────────────────────────────────────────────────────────────
// Drawn here but kept HIDDEN: the pass block (chip + advice) shows only when it matters — the user
// is blocked now, or a pass expires within RP_SHOW_EXPIRY_MS (user, 2026-10-05: three lines of
// 「초기화 패스 1장 · 전체 10/23 · 아직 아껴두세요」 on every calm day was too much). The overview
// badge is the always-on hint. renderResetPassAdvice (run after the gauges) makes it visible.
export function renderResetPassChip(org) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('reset-pass-chip');
  if (!el) return;
  const c = core();
  const html = org && typeof c.buildResetPassChipHtml === 'function'
    ? c.buildResetPassChipHtml(org.resetPasses, getLang(), Date.now(), providerOf(org), resetPassLink(providerOf(org)),
      '', resetPassHelpUrl(providerOf(org)))
    : '';
  // Compare against what WE wrote, not el.innerHTML (the parser re-serializes): an unchanged chip
  // must not be replaced, or a hovered tooltip disappears on every collection.
  if (el._rpHtml !== html) { el.innerHTML = html; el._rpHtml = html; }
  // Expiring soon is decidable here; 「blocked」 is not (the gauges render later), so
  // renderResetPassAdvice re-decides with the blocked windows. Paths that never reach it (usage-based
  // Enterprise has no 5h/7d) keep this answer (Codex 1R).
  el.classList.toggle('hidden', !html || !resetPassBlockShown(org, []));
  // The advice line belongs to this org's gauges: cleared here (every branch of both render paths
  // draws the chip) and redrawn by renderLimitReachedHeadline, which usage-based Enterprise skips.
  const adv = document.getElementById('reset-pass-advice');
  if (adv) { adv.innerHTML = ''; adv.classList.add('hidden'); }
}

// ── 2. Limit-reached headline suffix ─────────────────────────────────────────────────────────
/**
 * The link to append to the limit-reached headline, or null.
 *   · one pass usable now clears every blocked slot → 「초기화 패스로 지금 풀 수 있어요 ↗」
 *   · ChatGPT whose kinds are not known yet (summary only) but holds passes → holdings only,
 *     「초기화 패스 N장 보유 ↗」 — we cannot say it would help, only that it exists
 *   · a pass COULD clear it but clearNowCall says not now (the windows refill on their own within
 *     3h, or the advice says hold) → holdings only — the same call the overview badge and the
 *     sidebar line make, so no surface says 「clear it now」 beside 「아껴두세요」 (batch review 1.55.2)
 *   · anything else (a 5h pass while 7d is blocked too, unknown summary, 0 passes) → nothing
 */
export function resetPassHeadlineLink(org, blocked, resets5h = null, resets7d = null, nowMs = Date.now(), history = null) {
  const s = org && org.resetPasses;
  if (!holdsAny(s)) return null;
  const url = resetPassLink(providerOf(org));
  if (!url) return null;
  const title = resetPassTip(org);
  if (canClearNow(s, blocked)) {
    const hist = history || (typeof document === 'undefined' ? [] : _filteredHistory());
    if (clearNowCall(s, blocked, toMs(resets5h), toMs(resets7d), pastWeeklyBlocks(hist, nowMs), nowMs)) {
      return { text: t('rp_ui_clear_now'), url, title };
    }
    return { text: t('rp_ui_held_link', s.available), url, title };
  }
  if (providerOf(org) === 'chatgpt' && s.kinds_known !== true) return { text: t('rp_ui_held_link', s.available), url, title };
  return null;
}

/** Appends the link to the headline element (already filled by setPredictHeadline). */
export function appendResetPassHeadlineLink(headlineEl, link) {
  if (!headlineEl || !link || typeof document === 'undefined') return;
  const a = document.createElement('a');
  a.className = 'rp-headline-link';
  a.href = link.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = link.text;
  if (link.title) a.title = link.title;
  headlineEl.appendChild(a);
}

/** The shared hover text for an org's passes (usage-shared.js CORE), or '' when hidden. */
export function resetPassTip(org) {
  const c = core();
  return org && typeof c.resetPassDetailTip === 'function'
    ? c.resetPassDetailTip(org.resetPasses, getLang(), providerOf(org)) : '';
}

// ── 4. 「지금 쓰세요 / 아껴두세요」 advice line under the chip ───────────────────────────────────
//
// bg/reset-pass-model.js resetPassAdvice decides; this only feeds it what the popup is showing and
// draws one line. The 7d forecast it needs is the one renderGaugePrediction('7d') just computed —
// noted here (noteResetPassForecast) rather than recomputed, so the line can never disagree with
// the wait block above it. renderLimitReachedHeadline runs after both gauges and calls the render.
let _fc7d = null; // { resetsAt, hoursTo100 } of the last 7d forecast that projected a wall, else null

/** Called by renderGaugePrediction('7d'): the hours to 100% when a wall is forecast, else null. */
export function noteResetPassForecast(resetsAt, hoursTo100) {
  _fc7d = resetsAt && Number.isFinite(hoursTo100) ? { resetsAt, hoursTo100 } : null;
}

const toMs = (v) => { const x = v ? Date.parse(v) : NaN; return Number.isFinite(x) ? x : null; };

/** The advice for the viewed org with the values on screen, or null. Exported for the guard. */
export function resetPassAdviceFor(org, util5h, resets5h, util7d, resets7d, span5h, span7d, nowMs = Date.now()) {
  if (!org || !org.resetPasses) return null;
  const fc = _fc7d && resets7d && _fc7d.resetsAt === resets7d ? _fc7d.hoursTo100 : null;
  return resetPassAdvice({
    summary: org.resetPasses,
    blocked: blockedSlots(util5h, util7d, span5h, span7d),
    resets5hMs: toMs(resets5h),
    resets7dMs: toMs(resets7d),
    hoursTo100: fc,
    past: pastWeeklyBlocks(typeof document === 'undefined' ? [] : _filteredHistory(), nowMs),
    nowMs,
  });
}

/** The line's text and hover text for an advice object (t() keys rp_adv_*). */
export function resetPassAdviceText(adv, past) {
  if (!adv) return null;
  const dur = (h) => formatDuration(h * 3600000);
  const at = (ms) => formatResetAbsolute(ms, { absoluteDate: true });
  // 「평소 막힘」 as a range of the past blocks the comparison used (one value when they agree).
  const usual = Number.isFinite(adv.lo) && Number.isFinite(adv.hi)
    ? (dur(adv.lo) === dur(adv.hi) ? dur(adv.lo) : `${dur(adv.lo)}~${dur(adv.hi)}`) : '';
  let text, tone;
  switch (adv.verdict) {
    case 'use_now':
      tone = 'use';
      text = adv.reason === 'last' ? t('rp_adv_use_last')
        : adv.reason === 'five_hour' ? t('rp_adv_use_5h')
        : adv.reason === 'longer' ? t('rp_adv_use_longer', dur(adv.hours), usual)
        : t('rp_adv_use_no_weekly');
      break;
    case 'use_or_lose': tone = 'use'; text = t('rp_adv_use_or_lose', at(adv.expiresAt)); break;
    case 'similar': tone = 'neutral'; text = t('rp_adv_similar', dur(adv.hours), usual); break;
    case 'hold_for_wall':
      tone = 'hold';
      text = adv.reason === 'save_full' ? t('rp_adv_hold_save_full') : t('rp_adv_hold_longer', dur(adv.hours), usual);
      break;
    case 'hold_until_wall': tone = 'hold'; text = t('rp_adv_hold_until_wall', formatResetAbsolute(adv.at)); break;
    case 'hold_reset_soon': tone = 'hold'; text = t('rp_adv_hold_reset_soon', dur(adv.hours)); break;
    default: return null;
  }
  // The usual burn ends before this reset: spent now, the block returns. Said on the use/similar
  // lines only — a hold line already says to wait.
  if (Number.isFinite(adv.useAfter) && (adv.verdict === 'use_now' || adv.verdict === 'similar')) {
    text += ' ' + t('rp_adv_use_after', formatResetAbsolute(adv.useAfter));
  }
  const tip = [];
  if (past && past.seen > 0) tip.push(t('rp_adv_tip_past', past.seen, past.walled));
  if (Number.isFinite(adv.prob)) tip.push(t('rp_adv_tip_prob', Math.round(adv.prob * 100)));
  tip.push(t('rp_adv_tip_how'));
  return { text, tip: tip.join('\n'), tone };
}

const RP_SHOW_EXPIRY_MS = 3 * 24 * 3600000;


/** Whether the pass block is worth its space now: blocked, or a held pass expires within 3 days. */
export function resetPassBlockShown(org, blocked, nowMs = Date.now()) {
  const s = org && org.resetPasses;
  if (!holdsAny(s)) return false;
  if (Array.isArray(blocked) && blocked.length) return true;
  const exps = (Array.isArray(s.tickets) && s.tickets.length ? s.tickets.map((x) => x && x.expires_at) : [s.next_expires_at])
    .map((x) => (x ? Date.parse(x) : NaN)).filter((x) => Number.isFinite(x) && x > nowMs);
  return exps.some((x) => x - nowMs <= RP_SHOW_EXPIRY_MS);
}

export function renderResetPassAdvice(org, util5h, resets5h, util7d, resets7d, span5h, span7d) {
  if (typeof document === 'undefined') return;
  const shown = resetPassBlockShown(org, blockedSlots(util5h, util7d, span5h, span7d));
  const chip = document.getElementById('reset-pass-chip');
  if (chip) chip.classList.toggle('hidden', !shown || !chip._rpHtml);
  const el = document.getElementById('reset-pass-advice');
  if (!el) return;
  const adv = shown ? resetPassAdviceFor(org, util5h, resets5h, util7d, resets7d, span5h, span7d) : null;

  const past = adv ? pastWeeklyBlocks(_filteredHistory(), Date.now()) : null;
  const view = resetPassAdviceText(adv, past);
  el.innerHTML = '';
  el.classList.toggle('hidden', !view);
  if (!view) return;
  el.classList.toggle('is-use', view.tone === 'use');
  el.classList.toggle('is-neutral', view.tone === 'neutral');
  const url = resetPassLink(providerOf(org));
  // A link only where the line invites spending (use, or 「비슷해요 — 필요할 때 쓰세요」).
  const main = document.createElement(url && view.tone !== 'hold' ? 'a' : 'span');
  main.textContent = view.text;
  main.title = view.tip;
  if (main.tagName === 'A') {
    main.href = url;
    main.target = '_blank';
    main.rel = 'noopener noreferrer';
    main.className = 'rp-note-link';
  }
  el.appendChild(main);
}
