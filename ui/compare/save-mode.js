// ui/compare/save-mode.js — 「시크릿 대화」 per SERVICE (#1985). Imported by BOTH the compare page and
// the SW (bg/compare.js), so the session's per-provider history mode, its fold for code that only
// knows one boolean, and the stored preference's migration are read from one answer.
//
// A SaveBy is `{ claude, gemini, chatgpt }` of booleans, `true` = KEPT in that provider's own
// history (the wire's polarity, package `saveHistory`), `false` = incognito. Keyed by PROVIDER,
// not column: two columns of one provider ride the same site and account history.
//
// 🔴 Every fold to one boolean is PRIVACY-FIRST: `legacySaveHistory` is true only when every
// provider is kept, so code that cannot read the map (an old page/SW, an old device reading
// `compareIncognito`) treats a mixed session as incognito — it may keep less, never more.

import { COMPARE_PROVIDERS } from './constants.js';

export const SAVE_PROVIDERS = Object.freeze([...COMPARE_PROVIDERS]);

export const SAVE_MODE_KEPT = 'kept';
export const SAVE_MODE_INCOGNITO = 'incognito';
export const SAVE_MODE_MIXED = 'mixed';

// chrome.storage.sync keys. COMPARE_INCOGNITO_KEY is the pre-#1985 boolean (`true` = incognito),
// still written on every save because an OLD version on another device reads only it.
// COMPARE_INCOGNITO_BY_KEY is `{ [provider]: boolean (true = incognito), legacy: boolean }`,
// where `legacy` is the value written to COMPARE_INCOGNITO_KEY in the same set() call.
export const COMPARE_INCOGNITO_KEY = 'compareIncognito';
export const COMPARE_INCOGNITO_BY_KEY = 'compareIncognitoBy';

/** A frozen SaveBy: known providers only; a missing or non-boolean value is `fallback`. */
export function normalizeSaveBy(map, fallback) {
  const src = map && typeof map === 'object' ? map : {};
  const fb = fallback === true;
  return Object.freeze(Object.fromEntries(SAVE_PROVIDERS.map((p) => [p, typeof src[p] === 'boolean' ? src[p] : fb])));
}

/** The same value for every provider (what a boolean-only sender means). */
export function uniformSaveBy(saveHistory) {
  return normalizeSaveBy(null, saveHistory === true);
}

export function isSaveBy(v) {
  return !!v && typeof v === 'object' && SAVE_PROVIDERS.every((p) => typeof v[p] === 'boolean');
}

/** 'kept' (every provider kept) | 'incognito' (none) | 'mixed'. A non-map folds to incognito. */
export function foldSaveBy(saveBy) {
  if (!isSaveBy(saveBy)) return SAVE_MODE_INCOGNITO;
  const kept = SAVE_PROVIDERS.filter((p) => saveBy[p]).length;
  if (kept === SAVE_PROVIDERS.length) return SAVE_MODE_KEPT;
  return kept === 0 ? SAVE_MODE_INCOGNITO : SAVE_MODE_MIXED;
}

/** The one boolean for a reader that does not know the map: kept only when EVERY provider is. */
export function legacySaveHistory(saveBy) {
  return foldSaveBy(saveBy) === SAVE_MODE_KEPT;
}

/** Is `provider` kept in `saveBy`? Unknown provider / no map = not kept. */
export function keptFor(saveBy, provider) {
  return !!saveBy && typeof saveBy === 'object' && Object.hasOwn(saveBy, provider) && saveBy[provider] === true;
}

/**
 * Cross-provider leaks: text written by an INCOGNITO provider (`from`) carried into a conversation
 * of a KEPT provider (`to`) lands in that provider's history. → unique `[{from, to}]` pairs.
 */
export function crossLeaks({ saveBy, from = [], to = [] } = {}) {
  const out = [];
  const seen = new Set();
  for (const f of new Set(from)) {
    if (!SAVE_PROVIDERS.includes(f) || keptFor(saveBy, f)) continue;
    for (const t of new Set(to)) {
      if (t === f || !keptFor(saveBy, t)) continue;
      const key = consentKey({ from: f, to: t });
      if (!seen.has(key)) { seen.add(key); out.push({ from: f, to: t }); }
    }
  }
  return out;
}

export function consentKey({ from, to }) {
  return `${from}>${to}`;
}

/** The pairs not yet agreed to (`consents`: a Set of consentKey strings). */
export function pendingConsent(pairs, consents) {
  return (pairs || []).filter((pair) => !(consents && consents.has(consentKey(pair))));
}

/**
 * The stored preference → SaveBy (true = kept). `stored` is what storage.sync.get answered for
 * both keys. Rules (plan §3.1, Codex plan 1R/2R):
 *  - no map, or a damaged one (not an object, `legacy` not boolean) → the old boolean for all;
 *  - map → per provider `incognito = mapVal(p) || (old === true && legacy === false)`: the old key
 *    turned ON since we wrote it (an old device enabled incognito) wins as "all incognito"; it
 *    turned OFF since (old device disabled it, or sync delivered the map first) keeps the map —
 *    incognito is never released on a guess. `mapVal(p)` for a missing/non-boolean entry is the
 *    old key's value.
 */
export function readIncognitoPref(stored) {
  const old = stored?.[COMPARE_INCOGNITO_KEY] === true;
  const map = stored?.[COMPARE_INCOGNITO_BY_KEY];
  if (!map || typeof map !== 'object' || Array.isArray(map) || typeof map.legacy !== 'boolean') return uniformSaveBy(!old);
  const turnedOn = old && map.legacy === false;
  return Object.freeze(Object.fromEntries(SAVE_PROVIDERS.map((p) => {
    const incognito = (typeof map[p] === 'boolean' ? map[p] : old) || turnedOn;
    return [p, !incognito];
  })));
}

/** The one storage.sync.set payload for a SaveBy: both keys, the old one a BOOLEAN (any incognito → true). */
export function incognitoPrefWrite(saveBy) {
  const sb = isSaveBy(saveBy) ? saveBy : uniformSaveBy(false);
  const legacy = !legacySaveHistory(sb);
  return {
    [COMPARE_INCOGNITO_KEY]: legacy,
    [COMPARE_INCOGNITO_BY_KEY]: { ...Object.fromEntries(SAVE_PROVIDERS.map((p) => [p, !sb[p]])), legacy },
  };
}

/**
 * What a SEND carries → SaveBy, or null when it carries nothing. A map (`saveHistoryBy`) wins,
 * its gaps filled from the boolean (else `fallback`); a boolean alone applies to every provider
 * (an old page).
 */
export function saveByFromMessage(message, fallback) {
  const bool = typeof message?.saveHistory === 'boolean' ? message.saveHistory : null;
  const map = message?.saveHistoryBy;
  if (map && typeof map === 'object' && !Array.isArray(map)) return normalizeSaveBy(map, bool !== null ? bool : fallback);
  return bool !== null ? uniformSaveBy(bool) : null;
}
