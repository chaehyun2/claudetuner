// The Claude usage request path, and the remote switch for its reset-pass query (#2092 P0-1).
//
// `GET /api/organizations/<org>/usage?cedar_ember=1` answers every key the plain path does PLUS a
// top-level `cedar_ember` (the usage-limit reset passes the account holds) — same request count,
// one query parameter (docs/plans/usage-reset-passes.md §1.1). Both Claude `/usage` call sites in
// bg/collect.js (primary org, extra orgs) build their path here so they cannot disagree.
//
// 🔴 NEVER `skip_spend=1`. claude.ai's own settings screen sends it, and it drops `extra_usage` /
// `spend` from the answer — the fields our extra-usage gauge is built from.
//
// 🪤 `cedar_ember` is an UNDOCUMENTED provider flag. If the query ever starts costing us (4xx,
// latency), it is switched off without a release by `"claude_cedar_ember": false` in the same CDN
// flags.json the folders / compare dark launches read (claude-folders.js, bg/compare.js FLAGS_URL).
// Unlike those it is fail-OPEN: a missing field, an unreadable file or a dead CDN all keep the
// query ON, because only an explicit `false` is evidence that it should go. The read never blocks
// collection — a stale or absent cache answers immediately and refreshes in the background.
//
// No chrome.* at load: storage and fetch are injected (defaulting to chrome.storage.local and the
// global fetch at CALL time), so a Node guard can import this module directly.

import { CLAUDE_ORGS_PATH } from '../vendor-ai/sites.js';

export const CEDAR_EMBER_QUERY = 'cedar_ember=1';
export const FLAGS_URL = 'https://cdn.claudetuner.com/flags.json';
export const CEDAR_EMBER_FLAG_FIELD = 'claude_cedar_ember';
export const CEDAR_EMBER_FLAG_CACHE_KEY = 'ct_cedar_ember_flag';
export const CEDAR_EMBER_FLAG_TTL_MS = 60 * 60 * 1000;
// A cache row stamped further in the future than this was not written by us (same rule as
// bg/compare.js COMPARE_FLAG_FUTURE_SKEW_MS) and is treated as stale.
export const CEDAR_EMBER_FLAG_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const CEDAR_EMBER_FLAG_TIMEOUT_MS = 5000;
// The live flags.json is well under 1 KB; anything past this is not the file we mean.
export const CEDAR_EMBER_FLAG_MAX_BYTES = 4 * 1024;
// 🔴 Deadline on every storage call this module makes. collect.js AWAITS the answer before its
// /usage request, so a storage.get that never settles would stall collection itself (Codex 1R).
// Past it the answer is fail-open: the last value seen in this worker life, else ON.
export const CEDAR_EMBER_FLAG_STORAGE_TIMEOUT_MS = 400;

/** `/api/organizations/<org>/usage`, with the reset-pass query unless it is switched off. */
export function claudeUsagePath(orgId, withResetPasses = true) {
  const base = `${CLAUDE_ORGS_PATH}/${orgId}/usage`;
  return withResetPasses ? `${base}?${CEDAR_EMBER_QUERY}` : base;
}

/** The switch as flags.json states it: only an explicit `false` turns the query off. */
export function cedarEmberFlagFrom(json) {
  return !(json && typeof json === 'object' && json[CEDAR_EMBER_FLAG_FIELD] === false);
}

const defaultStorage = () => (typeof chrome !== 'undefined' ? chrome.storage?.local : null);
const defaultFetch = () => (typeof fetch === 'function' ? fetch : null);

let refreshInFlight = null;
// Last answer seen in this worker life (cache read or refresh) — the fallback when storage hangs.
let lastKnownOn = true;
const STORAGE_TIMED_OUT = Symbol('storage timed out');

/** `promise`, or STORAGE_TIMED_OUT once the storage deadline passes — whichever comes first. */
function withStorageDeadline(promise) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(STORAGE_TIMED_OUT), CEDAR_EMBER_FLAG_STORAGE_TIMEOUT_MS); });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimeout(timer));
}

/** The cached row, null when absent / unreadable, or STORAGE_TIMED_OUT. Never throws. */
async function readCache(storage) {
  try {
    const got = await withStorageDeadline(storage.get(CEDAR_EMBER_FLAG_CACHE_KEY));
    if (got === STORAGE_TIMED_OUT) return STORAGE_TIMED_OUT;
    const row = got?.[CEDAR_EMBER_FLAG_CACHE_KEY];
    if (row && typeof row.on === 'boolean' && typeof row.at === 'number') return row;
  } catch { /* unreadable cache = no cache */ }
  return null;
}

async function refresh(storage, fetchImpl, now, fallbackOn) {
  let on = fallbackOn;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CEDAR_EMBER_FLAG_TIMEOUT_MS);
  try {
    const res = await fetchImpl(FLAGS_URL, { signal: ac.signal, cache: 'no-store' });
    if (res && res.ok) {
      const text = await res.text();
      if (text.length <= CEDAR_EMBER_FLAG_MAX_BYTES) on = cedarEmberFlagFrom(JSON.parse(text));
    }
  } catch { /* network / parse failure keeps the last known answer */ } finally {
    clearTimeout(timer);
  }
  lastKnownOn = on;
  // Stamped even on failure, so a dead CDN is asked once per TTL rather than once per collection.
  // Deadlined too: a hung set must not pin refreshInFlight and block every later refresh.
  try { await withStorageDeadline(storage.set({ [CEDAR_EMBER_FLAG_CACHE_KEY]: { on, at: now } })); } catch { /* best effort */ }
  return on;
}

/**
 * Should this collection cycle append the reset-pass query? Answers from cache at once; a missing
 * or expired cache answers its last value (or ON) and starts one background refresh.
 */
export async function isCedarEmberQueryOn({ storage = defaultStorage(), fetchImpl = defaultFetch(), now = Date.now() } = {}) {
  if (!storage) return lastKnownOn;
  const cached = await readCache(storage);
  // Storage is not answering: do not wait on it and do not start a refresh that would write to it.
  if (cached === STORAGE_TIMED_OUT) return lastKnownOn;
  if (cached) lastKnownOn = cached.on;
  const lastOn = cached ? cached.on : lastKnownOn;
  const age = cached ? now - cached.at : Infinity;
  if (age < CEDAR_EMBER_FLAG_TTL_MS && age > -CEDAR_EMBER_FLAG_FUTURE_SKEW_MS) return lastOn;
  if (fetchImpl && !refreshInFlight) {
    refreshInFlight = refresh(storage, fetchImpl, now, lastOn).finally(() => { refreshInFlight = null; });
  }
  return lastOn;
}

/** Test seam: the pending background refresh, if any (resolves to the refreshed answer). */
export function pendingCedarEmberRefresh() {
  return refreshInFlight;
}
