// ui/compare/usage-floor.js — 「is this service near its limit right now?」, the ONE place that answers it.
// Pure, no browser global, no import: the SW (bg/compare.js planLabels — the SW already imports
// ui/compare/attach-types.js the same way) and the compare page import it, and the Node guards run it as is.
// Readers: the debate's usage floor (#1971 §3.3 ②, over chrome.storage.local `collectedOrgs`) and the
// cross-check's judge ranking (#1976 R11, over COMPARE_STATUS `providers[p].usage` — usagePeak takes that
// shape as is: { h5, d7, resetsAt5h?, resetsAt7d?, noLimits? }).
// 「Cannot tell」 is never a floor: no number, a plan without limits, a reading older than the caller's bound,
// a failed read — all answer null / no hit (2026-10-02 user decision).

// The utilisation (%) at which a service counts as near its limit. Provisional (#1971 §11 ⑥).
export const USAGE_FLOOR_PCT = 90;
// A collected reading older than this says nothing about now (the floor ignores it).
export const USAGE_MAX_AGE_MS = 30 * 60 * 1000;

/** An entry without `provider` is a Claude one (like bg/badge.js reads it). */
const providerOf = (o) => (typeof o?.provider === 'string' && o.provider ? o.provider : 'claude');

/**
 * The collected entry that speaks for `provider`: for claude the `isPrimary` entry, else the first claude
 * entry; for the others the first entry of that provider. null when nothing was collected for it.
 * 🪤 With several accounts of one service this may not be the account a compare column uses (a known limit).
 */
// `orgUuid` (#2054): the entry of THAT org — the org a cross-check send uses — or null when the collector has none
// (an unpolled org: nothing known, never another org's numbers). Without it: Claude's primary, else the first.
export function pickProviderEntry(orgs, provider, orgUuid = null) {
  if (!Array.isArray(orgs)) return null;
  const mine = orgs.filter((o) => o && typeof o === 'object' && providerOf(o) === provider);
  if (orgUuid) return mine.find((o) => o.uuid === orgUuid) || null;
  return (provider === 'claude' ? mine.find((o) => o.isPrimary === true) : null) || mine[0] || null;
}

const pctOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null);
/** A window whose reset instant has passed says nothing about now (the collector has not looked since). */
const windowOver = (resetsAt, now) => {
  if (typeof resetsAt !== 'string' || !resetsAt) return false;
  const at = Date.parse(resetsAt);
  return Number.isFinite(at) && at <= now;
};

/**
 * The highest utilisation (0–100) among an entry's live windows (5h, 7d), or null when it has none to say:
 * no entry, a plan without limits (`noLimits`), no number, every window already reset, or —
 * with `maxAgeMs` — an entry collected longer ago than that (or with no `updatedAt` at all). Takes a
 * `collectedOrgs` entry or COMPARE_STATUS `providers[p].usage` alike; `null >= USAGE_FLOOR_PCT` is false.
 */
// `now` defaults to the clock: a caller that forgets it must not read a window that already reset as live (Codex 1R 후속).
export function usagePeak(entry, { now = Date.now(), maxAgeMs = null } = {}) {
  if (!entry || typeof entry !== 'object' || entry.noLimits === true) return null;
  if (maxAgeMs !== null) {
    const at = entry.updatedAt;
    if (!(typeof at === 'number' && Number.isFinite(at)) || now - at > maxAgeMs || at - now > maxAgeMs) return null;
  }
  const windows = [[entry.h5, entry.resetsAt5h], [entry.d7, entry.resetsAt7d]];
  let peak = null;
  for (const [v, resetsAt] of windows) {
    const p = pctOf(v);
    if (p === null || windowOver(resetsAt, now)) continue;
    if (peak === null || p > peak) peak = p;
  }
  return peak;
}

/**
 * The first service in `providers` at or past `pct` of a usage window (#1971 §3.3 ② — the floor the
 * debate stops at before its next send), as `{ provider, pct }` with the highest one, or null. A service
 * with nothing collected, no limits, or a reading older than `maxAgeMs` is skipped — never a stop on a
 * guess (2026-10-02 user decision: stale or unreadable = go on). `skip` = services the user already chose
 * to go on past. `orgOf[p]` = the org (or a list of orgs, #2054 ③ — every Claude column's send org) whose
 * entries speak for `p`; null / absent in it = the provider's default entry (pickProviderEntry). Any of them at
 * the floor is a hit.
 */
export function usageFloorHit({ orgs, providers, now, pct, maxAgeMs, skip = [], orgOf = {} }) {
  let hit = null;
  for (const p of new Set(providers || [])) {
    if (skip.includes(p)) continue;
    const want = orgOf ? orgOf[p] : null;
    for (const org of new Set(Array.isArray(want) ? (want.length ? want : [null]) : [want])) {
      const peak = usagePeak(pickProviderEntry(orgs, p, org || null), { now, maxAgeMs });
      if (peak !== null && peak >= pct && (!hit || peak > hit.pct)) hit = { provider: p, pct: peak };
    }
  }
  return hit;
}
