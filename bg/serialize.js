// Serialize read-modify-write of a shared chrome.storage.local record within this service-worker
// instance.
//
// Extracted from send-gate.js (2026-07-28) when bg/upgrade-gate.js needed the SAME guarantee for
// its own backoff record. Kept as its own module rather than exported from send-gate.js for two
// reasons: a second copy of a concurrency primitive is the last thing that should be duplicated,
// and upgrade-gate.js is imported by the POPUP (ui/render.js) — routing it through send-gate.js
// would drag cadence-config and the whole send-gate chain into the popup for one 5-line helper.
//
// Scope and limits, stated so nobody mistakes this for more than it is: ONE promise chain per SW
// instance. It orders the concurrent POST fan-out (primary org + N extra orgs + providers all
// answer in the same cycle), which is the race that actually loses backoff escalations. It does
// NOT order across SW restarts or across other extension contexts — chrome.storage has no CAS, so
// that would need a different mechanism, and no caller here needs one.

let _chain = Promise.resolve();

/**
 * Run `fn` after every previously-queued call has settled. Returns fn's promise, so callers can
 * still await their own result; a rejection does not break the chain for later callers.
 */
export function withStorageLock(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.then(() => {}, () => {});
  return run;
}
