// Client consumer for the server's MIN_INGEST_VERSION gate (worker/src/services/version-gate.ts).
//
// SERVER CONTRACT (read from the worker source, not assumed): under
// MIN_INGEST_VERSION_MODE=enforce, an ingest POST whose ext_version parses strictly and is BELOW
// MIN_INGEST_VERSION is answered with HTTP 426 and a JSON body `{ error, code:'upgrade_required' }`.
// No headers carry the decision. The gate is auth-method-agnostic and lives BEFORE any write, so
// a 426 means "nothing was stored, and nothing will be until this install updates".
//
// WHY THIS MODULE EXISTS
// ---------------------
// Without a consumer, a 426 falls through every branch in the POST handlers into the generic
// `!response.ok` warn — which means: no flag, no UI, no backoff. The install keeps scraping and
// POSTing every cycle forever, and the user sees usage rendering locally while the server has not
// received a row since the flip. That is the exact "조용히 사망" failure the email-provider 401
// produced (2026-07-27, 5+ users dead for 3 days), one status code over. MIN_INGEST_VERSION_MODE
// cannot be flipped to enforce until this exists.
//
// THREE INVARIANTS, all pinned by test/upgrade-426-guard.mjs:
//
//  1. NEVER clear ext_token on 426. The token is VALID — the extension is old. Clearing it →
//     api_key re-TOFU → a fresh ingest token → the same 426 → loop, and it would also drop a
//     logged-in user back to the api_key path the Phase 2 migration is trying to retire. This is
//     the same class of bug as bg/storage.js:574-577 (scope_insufficient must not clear either).
//     Structurally guaranteed here by never calling clearExtTokenIfMatches on this path.
//
//  2. STOP the infinite retry. A 426 cannot resolve until the USER updates the extension, so
//     retrying every ~10min is pure waste at both ends. Escalating backoff (BASE, 2×, 4×, … CAP)
//     suppresses the POST — mirroring the 5xx `_serverBackoff` pattern in send-gate.js rather
//     than inventing a second one.
//
//     Backoff, NOT a permanent stop, on purpose: the block is server-STATE, not a client fact.
//     MIN_INGEST_VERSION can be lowered or MIN_INGEST_VERSION_MODE set back to shadow at any time
//     (both are env knobs — a toml edit, no release). A permanent client-side stop would leave
//     those installs dead after the server had already forgiven them, with no way back short of a
//     reinstall. The capped probe is what makes a server-side rollback self-healing.
//
//  3. RECOVER automatically. Two independent paths, because the dangerous failure mode is an
//     extension that stays frozen AFTER the user did what we asked:
//       a. VERSION-KEYED: the record stores the ext version that was rejected. Any version change
//          (i.e. the update landed) makes the record stale → dropped on the next read, no probe,
//          no timer. This is the primary path and it is instant.
//       b. ACCEPTED POST: clearUpgradeBlocked() on a 2xx (bg/collect.js, bg/storage.js) covers the
//          server-rollback case. Unlike authBlocked — whose guard fails OPEN on a D1 timeout, so a
//          2xx there does NOT prove recovery — the version gate does no I/O at all: it is a pure
//          function of env + ext_version, so a 2xx is genuine proof the gate no longer rejects us.
//
// Storage shape (one key, `upgradeBlocked`):
//   { version, until, fails, ts }
//   version — the ext version the server rejected; the staleness key for (3a).
// The server's threshold is NOT stored: the 426 body carries it only inside the English prose
// `error` string (version-gate.ts), and there is no machine-readable field to read it from.
// Scraping that sentence would be a fake contract, so the UI says "update the extension" without
// naming a target version — which is also what the user actually acts on (CWS auto-updates; there
// is no per-version install action to offer).

// Imports are deliberately minimal (constants + the shared lock, nothing else): this module is
// also imported by the POPUP via ui/render.js, so anything pulled in here is pulled into the popup.
import { UPGRADE_BACKOFF_BASE_MS, UPGRADE_BACKOFF_CAP_MS } from './constants.js';
import { withStorageLock } from './serialize.js';

/**
 * Server contract: the code carried by the 426 body
 * (worker/src/services/version-gate.ts UPGRADE_REQUIRED_CODE). Deliberately NOT login_required —
 * the blocked user may be fully logged in, and sending them to a login screen for a version
 * problem is the mis-diagnosis the disconnection-mailer fix removed.
 */
export const UPGRADE_REQUIRED_CODE = 'upgrade_required';

const UPGRADE_BLOCK_KEY = 'upgradeBlocked';

/** The version this install actually runs — the staleness key for the auto-recovery in (3a). */
export function currentExtVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return null;
  }
}

/**
 * Read the block record, dropping it if it belongs to a DIFFERENT ext version — i.e. the user
 * updated and the block is over. Returns the live record or null.
 *
 * The drop happens on READ (not on an install event alone) so recovery does not depend on any
 * particular listener having fired: whichever surface asks first — badge, popup, send gate —
 * observes the recovery and clears it for everyone.
 */
export async function getUpgradeBlock() {
  const { [UPGRADE_BLOCK_KEY]: rec } = await chrome.storage.local.get({ [UPGRADE_BLOCK_KEY]: null });
  if (!rec || !rec.version) return null;
  const cur = currentExtVersion();
  // cur === null means the manifest was unreadable (should not happen in a real SW). Treat it as
  // "cannot prove the update landed" and KEEP the block rather than fabricating a recovery.
  if (cur !== null && rec.version !== cur) {
    await clearUpgradeBlocked();
    console.log(`[Claude Tuner] upgrade block cleared — extension updated ${rec.version} → ${cur}`);
    return null;
  }
  return rec;
}

/** True while this install is version-blocked by the server. Drives the badge + popup banner. */
export async function isUpgradeBlocked() {
  return (await getUpgradeBlock()) !== null;
}

/**
 * True while the POST must be skipped. Distinct from isUpgradeBlocked(): the UI stays visible for
 * the whole block, but the POST is only suppressed until the next probe window opens — invariant
 * (2)'s escalating backoff plus the capped re-probe that makes a server-side rollback recoverable.
 */
export async function isUpgradePostSuppressed(now = Date.now()) {
  const rec = await getUpgradeBlock();
  return !!(rec && rec.until && now < rec.until);
}

/**
 * Peek a 426 body (via clone, so the caller can still read it) for `upgrade_required` and, if
 * present, raise/extend the block. Mirrors noteAuthBlocked/noteScopeInsufficient: never throws,
 * NEVER touches ext_token. Returns true when the block was recorded so callers can return early.
 *
 * Serialized on the same lock as the 5xx backoff (send-gate.js): the primary org and each extra
 * org POST concurrently in one SW cycle, so without it two 426s both read fails=0, both write
 * fails=1, and the escalation is lost.
 */
export async function noteUpgradeRequired(response, url, now = Date.now()) {
  let body = null;
  try {
    body = await response.clone().json();
  } catch {
    return false; // not JSON — not our contract, leave it to the generic !ok path
  }
  if (!body || body.code !== UPGRADE_REQUIRED_CODE) return false;
  const version = currentExtVersion();
  await withStorageLock(async () => {
    const { [UPGRADE_BLOCK_KEY]: prev } = await chrome.storage.local.get({ [UPGRADE_BLOCK_KEY]: null });
    // Only escalate within ONE version's block. A record from a previous version is a different
    // (already-over) block, so it must not inherit its fail count.
    const fails = (prev && prev.version === version ? (prev.fails || 0) : 0) + 1;
    const capped = Math.min(UPGRADE_BACKOFF_BASE_MS * Math.pow(2, fails - 1), UPGRADE_BACKOFF_CAP_MS);
    // ±15% jitter from the first wait on — unlike the 5xx backoff there is no "one-off blip"
    // case to imitate (every 426 is the same deterministic verdict), and an unjittered fleet
    // would re-probe the threshold in lockstep.
    const wait = Math.round(capped * (0.85 + Math.random() * 0.3));
    await chrome.storage.local.set({
      [UPGRADE_BLOCK_KEY]: { version, until: now + wait, fails, ts: now },
    });
  });
  try {
    console.log(`[Claude Tuner] upgrade_required (426) at ${new URL(url).pathname} — extension ${version} is below the server minimum; sync paused until this extension updates`);
  } catch { /* ignore URL parse errors */ }
  return true;
}

/**
 * Drop the block after a POST the server actually accepted (invariant 3b). Also the single writer
 * used by the version-change recovery, so the key name lives in exactly one place.
 */
export async function clearUpgradeBlocked() {
  await chrome.storage.local.remove(UPGRADE_BLOCK_KEY);
}
