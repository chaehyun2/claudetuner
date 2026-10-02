// ui/compare/consent.js — the two consents about 「another AI's words kept in a provider's history」
// (#1985 §3.4, #1976 R4), in one place. They differ only in how long they live:
//   - `judge_history` (#1976 R4, moved here unchanged): per judge PROVIDER, STORED (chrome.storage.local
//     SUMMARY_CONSENT_KEY — summary.js loads / saves it). Means 「the summary popover may be skipped」.
//   - `cross` (#1985): per SESSION × (incognito provider → kept provider) pair, memory only
//     (`state.crossConsent`, a Set of consentKey strings). Means 「an incognito service's words may be kept
//     in this kept service's history」. R4 does NOT imply it.
//
// 🔴 ONE GATE. Every caller that carries another column's words (a summary and its retry, the fact chip a
// verdict made, a debate turn) passes `provenance` (the providers whose words ride the send) to beginSend,
// which refuses — sends NOTHING — while a pair is pending and hands the pairs back. The caller then asks
// with the card below. A gate per surface would let the next new surface go around it.
// See ui/compare/history.js for the ctx contract.

import { crossLeaks, pendingConsent, consentKey, SAVE_PROVIDERS } from './save-mode.js';
import { PROVIDER_META } from './constants.js';

// GA `cmp_cross_consent{surface, choice, pairs_n}` vocabularies.
export const CONSENT_SURFACES = Object.freeze(['summary_pop', 'summary_auto', 'chip', 'debate', 'retry']);
export const CONSENT_CHOICES = Object.freeze(['shown', 'agree', 'exclude', 'cancel']);

/**
 * 「다음부터 묻지 않고 바로 정리」 (#1976 R4): consent is per JUDGE PROVIDER (the account whose history
 * keeps the attached answers) and counts only when given where the history note was ON SCREEN —
 * a box ticked in an incognito session, which leaves nothing behind, is not consent to a kept one.
 * Returns the new consent map (never mutates `consent`); unticking where the note showed revokes.
 */
export function consentAfterSend(consent, provider, { noteShown, checked }) {
  const out = { ...(consent && typeof consent === 'object' ? consent : {}) };
  if (!noteShown || typeof provider !== 'string') return out;
  if (checked) out[provider] = true; else delete out[provider];
  return out;
}
/** May the round footer send a summary to `provider` without the popover? Only with its consent. */
export function mayDirectSummarize(consent, provider) {
  return !!(consent && typeof consent === 'object' && consent[provider] === true);
}

/** The cross pairs a send would leak and nobody agreed to yet (`from`/`to`: provider lists). */
export function crossPending({ saveBy, from, to, consents }) {
  return pendingConsent(crossLeaks({ saveBy, from, to }), consents);
}

/** Install the cross-consent state and helpers onto `ctx`. */
export function installConsent(ctx) {
  const { state, t, el, track } = ctx;
  state.crossConsent = new Set();
  const label = (p) => (PROVIDER_META[p] ? PROVIDER_META[p].label : p);
  const names = (ps) => SAVE_PROVIDERS.filter((p) => ps.includes(p)).map(label).join(t('provider_list_sep'));
  const providersOf = (colIds) => [...new Set((colIds || []).map((id) => (state.columns.get(id) || {}).provider).filter(Boolean))];

  /** Pending pairs for words from `provenance` (providers) sent to the columns `targets` (col ids). */
  function crossPendingFor(provenance, targets) {
    return crossPending({ saveBy: state.sessionSaveBy, from: provenance || [], to: providersOf(targets), consents: state.crossConsent });
  }
  function agreeCross(pairs) {
    for (const pair of pairs || []) state.crossConsent.add(consentKey(pair));
  }
  /** A new conversation / a history entry opened: nothing agreed carries over (a resume keeps them). */
  function resetCrossConsent() {
    state.crossConsent = new Set();
  }
  /** `key`'s sentence for `pairs`: {0} = the incognito services, {1} = the kept ones. */
  function crossConsentText(key, pairs) {
    return t(key, names(pairs.map((x) => x.from)), names(pairs.map((x) => x.to)));
  }
  /**
   * The card's buttons: 「동의하고 보내기」 · 「시크릿 … 빼고 보내기」 (only with `onExclude`) · 「취소」.
   * 🔴 The DEFAULT focus is 취소 — one Enter must never be consent. Each choice is reported once.
   */
  function crossConsentActions({ pairs, surface, agreeKey = 'cross_consent_agree', excludeKey = 'cross_consent_exclude', onAgree, onExclude = null, onCancel }) {
    const box = el('div', 'cmp-consent-actions');
    const report = (choice) => track('cross_consent', { surface, choice, pairs_n: pairs.length });
    const agree = el('button', 'cmp-btn cmp-btn-sm cmp-consent-agree', t(agreeKey));
    agree.type = 'button';
    agree.addEventListener('click', () => { report('agree'); agreeCross(pairs); onAgree(); });
    box.appendChild(agree);
    if (onExclude) {
      const ex = el('button', 'cmp-btn cmp-btn-sm cmp-consent-exclude', t(excludeKey));
      ex.type = 'button';
      ex.addEventListener('click', () => { report('exclude'); onExclude(); });
      box.appendChild(ex);
    }
    const cancel = el('button', 'cmp-btn cmp-btn-sm cmp-consent-cancel', t('cross_consent_cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', () => { report('cancel'); onCancel(); });
    box.appendChild(cancel);
    box.focusDefault = () => { try { cancel.focus(); } catch { /* detached */ } };
    return box;
  }
  /** The card in the notice slot (debate start, a retry, a paused debate turn). */
  function askCrossConsent({ pairs, bodyKey, extra = [], ...rest }) {
    const actions = crossConsentActions({
      pairs, ...rest,
      onAgree: () => { ctx.clearNotice(); rest.onAgree(); },
      onExclude: rest.onExclude ? () => { ctx.clearNotice(); rest.onExclude(); } : null,
      onCancel: () => { ctx.clearNotice(); rest.onCancel(); },
    });
    ctx.showNotice('warn', [crossConsentText(bodyKey, pairs), ...extra], actions);
    actions.focusDefault();
  }

  Object.assign(ctx, { crossPendingFor, agreeCross, resetCrossConsent, crossConsentText, crossConsentActions, askCrossConsent, providersOf });
}
