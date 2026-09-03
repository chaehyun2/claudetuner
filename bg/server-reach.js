// "Is this install's data reaching the server right now?" — ONE definition.
//
// WHY THIS MODULE EXISTS
// ---------------------
// This question was answered three separate times, each time by naming whichever blocked state
// happened to be in view, and each time it was incomplete:
//
//   1. The dashboard nudge suppressed on `authBlocked` (401) only.
//   2. Review found `upgradeBlocked` (426) means the same thing — collect skips the POST while it
//      stands — so a version-blocked user saw "update the extension" and "go read your trends"
//      side by side.
//   3. Review then found `_serverBackoff` (5xx / network) is a third one, with the same effect.
//
// Three rounds of "fix half of it" is the signal that the predicate, not the call site, was
// missing. Anything that needs to know whether the server is currently seeing this install's data
// asks HERE, so the next state we add is added once.
//
// 🔴 Login-first gating IS in this list, and the argument for leaving it out was wrong. It went:
// "a gated install has never POSTed, so it cannot hold the server state the callers read." False —
// an install can sync happily, receive that state, and THEN be de-authed from the popup, which
// removes `extToken` but leaves `dashNudgeServer` behind. It is now gated while still holding
// stale server state, and the banner would render from it. (Codex.)
import { getUpgradeBlock } from './upgrade-gate.js';
import { isServerBackedOff } from './send-gate.js';
import { serverSyncWithheldReason, isServerSyncPaused } from './storage.js';
import { getCadence, isCollectionPaused } from './cadence-config.js';

/**
 * True while snapshots are NOT reaching the server for a reason the user could be told about.
 *
 * Reads the canonical source for each state rather than the raw keys: `getUpgradeBlock()` owns the
 * version-staleness recovery, `isServerBackedOff()` owns the backoff window. A second copy of
 * either rule would drift out of step with the recovery that clears it.
 */
export async function isServerSyncStalled() {
  const { authBlocked } = await chrome.storage.local.get(['authBlocked']);
  if (authBlocked === true) return true;      // 401 — account needs a login
  if (await getUpgradeBlock()) return true;   // 426 — extension too old to be accepted
  if (await isServerBackedOff()) return true; // 5xx / network — waiting out a backoff
  if (await serverSyncWithheldReason()) return true; // login-first OR token-lost — never POSTs until a login
  // #1119 — the user paused sending. Snapshots are genuinely not reaching the server, so this
  // answers true; what must NOT happen is the "reconnect" nudges treating a deliberate choice as a
  // fault. Callers of this function all read it as "do not raise a connection alarm".
  if (await isServerSyncPaused()) return true;
  // Server-driven collection pause — bg/collect.js skips the whole cycle while it stands.
  // 🔴 Via getCadence()/isCollectionPaused(), NOT a raw key read: `collectPauseUntil` lives INSIDE
  // the cadence object, so `storage.get(['collectPauseUntil'])` returns nothing and the check would
  // never fire. (First draft did exactly that — a check that can never matter.)
  if (isCollectionPaused(await getCadence())) return true;
  return false;
}
