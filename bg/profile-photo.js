// The signed-in user's Google profile photo, for the debate room's own-message avatar (#1769).
//
// Source: the `picture` claim of the id_token the popup's Google sign-in already receives
// (scope `openid email profile`) — no extra permission, no server field. Only that sign-in path
// has it; everyone else gets the letter tile.
//
// Stored under its own key, bound to the email it belongs to: `independentAccount` has many readers
// and writers (claim switch, magic code, block-state), and a photo left behind by one account must
// never appear on another's page. The page shows it only when the stored email equals the account
// it resolves itself.
//
// LEAF module (zero imports): the service worker and the compare page both use it.

export const PROFILE_PHOTO_KEY = 'profilePhoto';

// Google serves profile photos from *.googleusercontent.com. Anything else — another host, http,
// a data: or javascript: URL — is not a photo this code set out to show.
const PHOTO_HOST_RE = /(^|\.)googleusercontent\.com$/;

/** `raw` if it is an https URL on Google's photo host, else null. */
export function profilePhotoUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  return u.protocol === 'https:' && PHOTO_HOST_RE.test(u.hostname) ? u.href : null;
}

/** The value to store for `email` + the id_token claims (`null` = remove the key). */
export function profilePhotoRecord(email, claims) {
  const url = profilePhotoUrl(claims && claims.picture);
  return email && url ? { email: String(email).toLowerCase(), url } : null;
}

/**
 * The photo URL from a stored record when EVERY one of `emails` is its owner, else null. A page
 * passes both the account it shows (accountCache wins over independentAccount there) and the
 * sign-in identity (independentAccount): a claim switch or a magic-code login moves the identity to
 * B while accountCache and the photo still say A — A's photo must not ride on B (Codex blocker).
 */
export function profilePhotoFor(record, ...emails) {
  if (!record || typeof record.email !== 'string' || !emails.length) return null;
  return emails.every((e) => typeof e === 'string' && e && e.toLowerCase() === record.email) ? profilePhotoUrl(record.url) : null;
}
