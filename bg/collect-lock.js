// Collection ↔ account-switch lock (#2210).
//
// The footer account switch (popup.js) drops the ext_token and re-arms the server-sync gate. If a
// collection is mid-flight at that moment it has already decided "authenticated, not withheld":
// it can then POST with the shared X-API-Key (→ 401) and write a lastStatus that paints "synced"
// after the switch said "local only". Reordering the switch's own writes cannot close that — the
// collect's decision was made before the switch started.
//
// So the two are mutually exclusive, via the Web Locks API (one lock manager per extension origin,
// shared by the service worker and the popup):
//   · every collection ENTRY POINT holds the lock in SHARED mode — collections still overlap with
//     each other exactly as before;
//   · the switch takes it EXCLUSIVE — it waits for every in-flight collection to finish, and a
//     collection that starts meanwhile queues behind it (Web Locks grants in request order).
// Entry points, not inner helpers: a nested shared request of the same name queued behind a
// pending exclusive would deadlock against its own outer hold.
//
// No navigator.locks (never expected in supported Chrome) → run unlocked rather than not at all.

export const COLLECT_LOCK_NAME = 'ct-collect';

// The Claude snapshot POST is fire-and-forget (bg/collect.js — the popup must not wait on the
// server), so it outlives the collect call that started it, token read and response handling
// (which may write a token) included. Such sends register here, and the shared hold below is
// kept until they settle. Capped: simplePost has no timeout of its own, and a hung request must
// not wedge the account switch forever. Past the cap the hold is released WITHOUT cancelling the
// request, so the residual race is: a send still unsettled after PENDING_SEND_CAP_MS whose late
// token read / response handling then overlaps a switch. The set is global to the service worker,
// so overlapping collects wait for each other's sends too — slower switch, never a wrong one.
export const PENDING_SEND_CAP_MS = 30_000;
const _pendingSends = new Set();

export function trackPendingSend(promise) {
  let entry;
  entry = Promise.resolve(promise).catch(() => {}).finally(() => _pendingSends.delete(entry));
  _pendingSends.add(entry);
  return promise;
}

async function drainPendingSends(capMs = PENDING_SEND_CAP_MS) {
  const deadline = Date.now() + capMs;
  while (_pendingSends.size > 0) {
    const left = deadline - Date.now();
    if (left <= 0) return;
    await Promise.race([
      Promise.allSettled([..._pendingSends]),
      new Promise((r) => setTimeout(r, left)),
    ]);
  }
}

/**
 * Run a collection under the shared lock. Resolves with fn's result as soon as fn finishes (callers
 * keep today's latency), but the lock itself is held until the sends fn started have settled.
 */
export function withCollectLock(fn) {
  const locks = globalThis.navigator?.locks;
  if (!locks) return fn();
  return new Promise((resolve, reject) => {
    locks.request(COLLECT_LOCK_NAME, { mode: 'shared' }, async () => {
      try { resolve(await fn()); } catch (e) { reject(e); }
      await drainPendingSends();
    }).catch(reject);
  });
}

export function withSwitchLock(fn) {
  const locks = globalThis.navigator?.locks;
  if (!locks) return fn();
  return locks.request(COLLECT_LOCK_NAME, { mode: 'exclusive' }, () => fn());
}
