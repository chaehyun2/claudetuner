// Single decision point for "why is this install not syncing, and what should the user do about
// it". Today seven surfaces answer that question independently — the reauth widget, the login
// CTA, the error banner, the upgrade warning, the email-mismatch warning, the account-deleted
// block, and (since #941) the local-only status line — each with its own boolean expression over
// the same storage. Two consequences, both already paid for:
//
//   1. GAPS. Two surfaces can each decide the other one has it covered, and the user is left
//      blocked with no way back. That has happened twice (popup.js:86-96 and :353-367 are the
//      post-mortems, both caught as Codex DEPLOY-BLOCKERs). With N independent predicates the
//      combinations nobody checked grow as 2^N.
//   2. OVERLAP. `token_lost` + `claudeEmailMismatch` + an error banner can all render at once.
//      A user who cannot tell which one to act on reinstalls — and a reinstall is what drops an
//      existing account to `serverSyncGrandfathered:false` in the first place.
//
// 🔴 THIS MODULE CHANGES NOTHING YET. Stage 1 is shadow: resolveBlockState() is computed and
// reported alongside what the UI actually showed, so the combinations where the two disagree can
// be measured on real installs BEFORE any surface starts consuming it. Switching the surfaces
// over blind would risk removing a CTA that currently shows — the exact shape of the two past
// incidents. Stage 2 (#942) flips the consumers once the shadow data is in.

// Priority order, most-blocking first. The list IS the contract: resolveBlockState returns the
// first cause that applies, so reordering it changes which CTA a user sees.
export const BLOCK_CAUSES = [
  // Nothing else the user can do matters while the server considers the account gone.
  'account_deleted',
  // A stale client fails every other remedy it might attempt, so it must be told to update first.
  'upgrade_required',
  // Auth family. These are ordered by how specific the remedy is, not by severity: a scope
  // problem needs the SAME verify flow as a login but different copy, and `token_lost` needs the
  // reauth widget rather than the new-user CTA.
  'auth_blocked',
  'scope_insufficient',
  'token_lost',
  'login_first',
  // Authenticated, but the Claude identity behind the data is not the one we hold.
  'claude_email_mismatch',
  // Not our server at all — claude.ai session/cookies/Cloudflare. The remedy is "sign in to
  // claude.ai", which is precisely the case our support FAQ has been answering with "reinstall".
  'collect_error',
];

/**
 * PURE. Takes a plain snapshot of the relevant state and returns exactly one cause, or null when
 * nothing is blocking. Pure so the guard can execute it across the whole combination space —
 * "no combination yields null while something is blocking" is the gap invariant, and it is only
 * checkable by running it, not by reading it.
 *
 * @param {object} s
 * @param {boolean} s.accountDeleted     `account_deleted` (server answered 410)
 * @param {boolean} s.upgradeBlocked     bg/upgrade-gate.js isUpgradeBlocked()
 * @param {boolean} s.authBlocked        bg/storage.js AUTH_BLOCKED_CODE (shared-key 401)
 * @param {boolean} s.needsFullLogin     403 scope_insufficient
 * @param {boolean} s.hasExtToken        a token is present
 * @param {?string} s.withheldReason     serverSyncWithheldReason() → 'login_first'|'token_lost'|null
 * @param {boolean} s.emailMismatchActive claudeEmailMismatch, undismissed and unlinked
 * @param {?string} s.collectError       lastStatus.error when lastStatus.success === false
 */
export function resolveBlockState(s = {}) {
  if (s.accountDeleted === true) return 'account_deleted';
  if (s.upgradeBlocked === true) return 'upgrade_required';
  // Both auth flags are qualified by token presence, and the qualifiers are OPPOSITE — that
  // asymmetry is load-bearing, not an accident. `authBlocked` is reached by installs holding no
  // token (that is why the shared key was used); `needsFullLogin` is reached by installs that DO
  // hold one and were refused for scope. Dropping either qualifier makes one of them swallow the
  // other's population, which is how the widgets ended up hiding each other.
  if (s.authBlocked === true && !s.hasExtToken) return 'auth_blocked';
  if (s.needsFullLogin === true && s.hasExtToken) return 'scope_insufficient';
  if (s.withheldReason === 'token_lost') return 'token_lost';
  if (s.withheldReason === 'login_first') return 'login_first';
  if (s.emailMismatchActive === true) return 'claude_email_mismatch';
  if (s.collectError) return 'collect_error';
  return null;
}

/** Gathers the state resolveBlockState() needs. Keep IO here so the decision stays testable. */
export async function readBlockState(deps) {
  const { isUpgradeBlocked, serverSyncWithheldReason, getLastStatus } = deps;
  const raw = await chrome.storage.local.get({
    account_deleted: false, authBlocked: false, needsFullLogin: false, extToken: null,
    claudeEmailMismatch: null, claudeEmailMismatchDismissedTs: 0, claudeAliasLink: null,
    collectedOrgs: [], claudeNoticeDismissed: false, independentAccount: null, accountCache: null,
  });
  // Same activeness rule the warning itself uses (ui/render.js): a dismissed or already-linked
  // mismatch is not blocking. Duplicating the rule would let the two drift apart, so stage 2
  // must make render.js read THIS instead.
  const mm = raw.claudeEmailMismatch;
  const alreadyLinked = !!(raw.claudeAliasLink && mm && raw.claudeAliasLink.claudeEmail === mm.claudeEmail);
  const emailMismatchActive = !!(mm && mm.ts > (raw.claudeEmailMismatchDismissedTs || 0) && !alreadyLinked);
  const last = await getLastStatus();
  return {
    accountDeleted: raw.account_deleted === true,
    upgradeBlocked: await isUpgradeBlocked(),
    authBlocked: raw.authBlocked === true,
    needsFullLogin: raw.needsFullLogin === true,
    hasExtToken: !!raw.extToken,
    withheldReason: await serverSyncWithheldReason(),
    emailMismatchActive,
    collectError: last && last.success === false ? (last.error || 'unknown') : null,
    // Why the UI may legitimately show NOTHING for a collect_error. Without this the shadow data
    // is full of "verdict=collect_error, surfaces=none" rows that are working as designed —
    // ui/render.js hides the Claude failure UI entirely for Gemini/ChatGPT-only and independent
    // installs (:73), and hides the soft banner once dismissed (:158). Reporting the reason keeps
    // those separable from the disagreements this phase exists to find. (Codex, PR #943.)
    // NOT folded into the verdict: this is a UI-relevance rule, not a reason the install is
    // unblocked — stage 2 has to decide which of the two it should be.
    errorUiSuppressed: errorUiSuppression(raw),
  };
}

function errorUiSuppression(raw) {
  // Mirrors ui/render.js:73 EXACTLY — `state.isIndependent || _providerOnly`. Both limbs reduce
  // to the same fact: THIS INSTALL HAS NO CLAUDE ORG, so a Claude collection failure is not the
  // user's problem. (popup.js:790 folds `!hasClaudeOrg` into isIndependent itself.)
  //
  // 🔴 The first version of this classifier keyed `independent` off independentAccount.email
  // alone, which is a WIDER set: an independent-account user who DOES collect a Claude org would
  // have been labelled "suppressed" while the UI actually shows them the error. That mislabels
  // exactly the rows stage 2 reads to decide what is a real gap. Caught before any data was
  // collected (the extension has not shipped to CWS yet), so nothing has to be discarded.
  const orgs = Array.isArray(raw.collectedOrgs) ? raw.collectedOrgs : [];
  const hasClaude = orgs.some((o) => (o.provider || 'claude') === 'claude');
  const hasOther = orgs.some((o) => (o.provider || 'claude') !== 'claude');
  const independent = !(raw.accountCache && raw.accountCache.email)
    && !!(raw.independentAccount && raw.independentAccount.email) && !hasClaude;
  if (independent) return 'independent';
  if (!hasClaude && hasOther) return 'provider_only';
  // User muted the notice. Unlike the two above this is NOT a statement that nothing is blocking —
  // it is blocked and the user chose not to look. Stage 2 must keep the two apart.
  if (raw.claudeNoticeDismissed === true) return 'dismissed';
  return '';
}

// === Shadow-phase surface registry ===
// What the UI ACTUALLY un-hid this popup open, so the verdict can be compared against reality.
// Deliberately NOT noteCtaShown(): that one is a product metric with its own guard pinning
// exactly three call sites, and exposure-per-open is a different question from this one.
//
// 🔴 These three were DELETED by accident in PR #944 — a text replacement anchored on
// `errorUiSuppression` swallowed everything to the end of the file. popup.js and ui/render.js
// import `noteSurface`/`surfacesShown`, so their absence broke the popup's ENTIRE module graph:
// the popup rendered its static HTML and nothing else. Every guard passed, because they all read
// source patterns and nothing ever loaded the module graph. test/module-imports-guard.mjs now
// closes that hole.
const _surfaces = new Set();
export function noteSurface(name) { _surfaces.add(name); }
export function surfacesShown() { return [..._surfaces].sort(); }
export function _resetSurfaces() { _surfaces.clear(); }
