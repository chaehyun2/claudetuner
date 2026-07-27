// Read-only claims off the ext_token JWT, WITHOUT verifying it.
//
// The token is a JWT (header.payload.sig) minted by the server
// (worker/src/utils/ext-token.ts); we only peek at claims for client-side UX decisions —
// the server is the sole authority that verifies the HMAC. Never gate anything that
// matters on these values.
//
// This is a LEAF module (zero imports) on purpose: the popup needs the same claims as the
// background, and importing bg/storage.js from the popup would drag in constants.js,
// send-gate.js and cadence-config.js just to base64-decode a string.

// Must match the `iss` the server signs (worker/src/utils/ext-token.ts).
const EXT_TOKEN_ISSUER = 'claudetuner-ext';

/**
 * Base64url-decode any JWT's payload. Signature-agnostic on purpose — every caller here is
 * making a CLIENT-side decision and the server remains the only thing that verifies. Exported
 * because background.js needs the same decode for Google's id_token (nonce check); a second
 * copy there would be the kind of duplicate this repo keeps getting bitten by.
 */
export function decodeJwtPayload(token) {
  try {
    let b64 = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Provenance scope (Phase 2 §4.1): 'ingest' = api_key TOFU/piggyback mint, 'full' = login
 * (inbox-proof) mint. Returns undefined for legacy tokens (no claim) or any parse failure.
 *
 * Deliberately does NOT check issuer/expiry the way extTokenEmail does. Its caller
 * (setExtTokenNoDowngrade in bg/storage.js) is deciding whether an incoming token would downgrade
 * a stored `full` one, and legacy tokens with no scope must keep parsing exactly as before;
 * rejecting on those grounds would silently change which tokens get persisted.
 */
export function extTokenScope(token) {
  return decodeJwtPayload(token)?.scope;
}

/**
 * The Tuner account this install actually syncs INTO — the `email` claim the server bound
 * the token to.
 *
 * This is NOT always the provider account email the popup footer shows. Changing your
 * claude.ai address makes the next snapshot carry the new address; the server rejects it
 * against the old token (403 Email mismatch), the token is cleared, and the next cycle
 * re-mints against the NEW address (worker snapshots.ts calls signExtToken with the
 * snapshot's user_email). The install therefore migrates to a different Tuner account with
 * no user-visible event — the mismatch warning even clears itself once collection succeeds
 * again. Surfacing this claim is what lets the UI say where the data is actually landing.
 *
 * Ignores a token that isn't ours or has expired. Not for security — the server verifies the
 * HMAC and the expiry itself, and nothing here is trusted for access. It is for CORRECTNESS of
 * the answer: this claim outranks accountCache wherever the sync identity is resolved, so a
 * token left behind by a long-dormant install would otherwise keep naming a dead account while
 * the cache holds the current one — a worse answer than not having the claim at all.
 *
 * Returns a lowercased email, or null when there is no token, no claim, a foreign issuer, or
 * the token has expired.
 */
export function extTokenEmail(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || payload.iss !== EXT_TOKEN_ISSUER) return null;
  // exp is seconds since epoch (worker/src/utils/ext-token.ts). A token with no numeric exp is
  // not one of ours in a usable state, so treat it as unusable rather than as never-expiring.
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
  const email = payload.email;
  return typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;
}
