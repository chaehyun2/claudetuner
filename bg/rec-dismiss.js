// "Not now" / "Don't show this again" — the user's own suppression of a plan recommendation.
//
// 🔴 WHY THIS EXISTS AT ALL: dismissing used to hide the card and nothing else. The server recorded
// the dismissal correctly (rec_dismissed_at + an escalating 3/7/14-day cooldown), but the popup
// re-renders from `lastStatus.recommendation`, which the dismissal never touched — so closing and
// reopening the popup brought the card straight back, with no server round-trip involved (#1004).
// A cooldown only the server knows about cannot suppress a card only the client draws.
//
// So the window is now shared: the server returns `cooldown_until` from the SAME formula it
// enforces with (dismissCooldownUntilMs in worker/src/services/snapshot-service.ts) and the client
// stores it verbatim. Client and server suppress for exactly the same span; neither invents one.
//
// Claude-only, like the buttons that write it: both popup handlers refuse to run unless
// state.recProvider === 'claude', so a Claude dismissal must never silence a ChatGPT rec.

import { getLastStatus, setStatus } from './storage.js';

/** chrome.storage.local key holding the active dismissal, or absent when there is none. */
export const REC_DISMISS_KEY = 'recDismiss';

// Local floor used ONLY when the server did not confirm a window — offline, a rejected request, or
// an UPDATE that matched no row. Deliberately much shorter than the server's own 3-day minimum:
// the server in that case still believes the recommendation is live and will keep serving it, so a
// long local window would be the client lying about a suppression that does not exist. A day is
// long enough that "it came back in an hour" cannot recur, short enough to self-heal.
export const REC_DISMISS_FALLBACK_MS = 24 * 3600 * 1000;

// === REC DISMISS SUPPRESSION: BEGIN (pinned by test/rec-dismiss-guard.mjs) ===
// Is a stored dismissal still in force? Pure and side-effect free so the popup can call it inside
// a synchronous render predicate (ui/recommend.js) and the background can call it before it
// persists a fetched rec (bg/rec-fetch.js) — one rule, two callers, no second copy.
//
// A missing/!malformed record is NOT suppression: unknown must fail open, or a corrupt storage
// value would silence recommendations permanently with no way for the user to tell why.
export const recDismissActive = (d, now = Date.now()) =>
  !!d && (d.permanent === true || (typeof d.until === 'number' && now < d.until));
// === REC DISMISS SUPPRESSION: END ===

/**
 * Turn a dismiss response into the record we store.
 *
 * `permanent: true`      → never expires (the server holds rec_dismiss_count = -1 to match). Only
 *                          ever honoured when the CALLER asked to mute: a plain "not now" that
 *                          somehow came back with permanent:true would otherwise store a
 *                          suppression with no expiry and no UI to undo it.
 * `cooldown_until` set   → expires exactly when the server's cooldown does.
 * neither                → the dismissal did not stick server-side; fall back to the local floor
 *                          and mark it `local` so the distinction survives in storage.
 */
export function dismissFromServer(res, permanent = false, now = Date.now()) {
  if (permanent && res && res.permanent === true) return { permanent: true, at: now, src: 'server' };
  const until = res && res.cooldown_until ? Date.parse(res.cooldown_until) : NaN;
  if (Number.isFinite(until)) return { until, at: now, src: 'server' };
  if (permanent) return { permanent: true, at: now, src: 'local' };
  return { until: now + REC_DISMISS_FALLBACK_MS, at: now, src: 'local' };
}

/** The active dismissal, or null. */
export async function getRecDismiss() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [REC_DISMISS_KEY]: null }, (r) => resolve(r[REC_DISMISS_KEY] || null));
  });
}

/** Persist what the server told us (or the local floor) and hand the record back. */
export async function recordRecDismiss(res, permanent = false) {
  const record = dismissFromServer(res, permanent);
  await chrome.storage.local.set({ [REC_DISMISS_KEY]: record });
  return record;
}

/**
 * Drop the Claude recommendation the user just dismissed from storage.
 *
 * This is the half that actually makes the card go away NOW: every popup surface reads
 * `lastStatus.recommendation`, and the toolbar marker is derived from it too (bg/badge.js), so
 * leaving it in place means the next popup open — or the next paint — resurrects what the user
 * just dismissed.
 *
 * Only the Claude slot, and only when it holds a CLAUDE rec: bg/rec-fetch.js's GET path writes
 * `data.recommendation` through verbatim, provider and all, so that slot can legitimately hold a
 * ChatGPT rec (observed live 2026-08-27, see bg/rec-notice.js) — and a Claude dismissal has no
 * business deleting it.
 */
export async function clearDismissedClaudeRec() {
  const cur = await getLastStatus();
  const rec = cur && cur.recommendation;
  if (!rec || (rec.provider || 'claude') !== 'claude') return false;
  await setStatus(Object.assign({}, cur, { recommendation: null }));
  return true;
}
