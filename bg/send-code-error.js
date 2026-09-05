// One place that turns a failed "email me a verification code" request into user-facing copy.
//
// WHY THIS MODULE EXISTS (#1172)
// ------------------------------
// Four surfaces ask the server to email a 6-digit code — the popup's reauth widget, claim-switch,
// the login CTA, and the Claude email-link flow in ui/render.js. All four kept their own result
// handling, and all four collapsed everything that was not a rate limit into ONE sentence:
// "Could not send the code. Please try again."
//
// So these were indistinguishable, to the user AND to us:
//   - the request never left the browser (a `serverUrl` pointing at a blackhole, offline, blocked)
//   - the server was reached but the mail transport refused the recipient (503)
//   - a 5xx
//   - the popup → service worker message channel never completed (chrome.runtime.lastError,
//     which no caller even read)
//
// Diagnosing one real report cost over half an hour of server-side elimination — worker tail
// filtered to the reporter's IP, D1 `magic_links` inspection, CORS preflight checks — before a
// hand-run fetch in the service-worker console revealed `serverUrl = "http://127.0.0.1:9"`, the
// value docs/EXTENSION.md hands out for offline testing. Every one of those checks was answered by
// the message this module now produces.
//
// 🔴 ONE MAPPING, FOUR CALLERS. The defect existed four times because the handling was copied four
// times; fixing the four copies in place would rebuild exactly that. Callers classify — they hold
// different evidence, a background-mediated response vs. a direct fetch — and this module owns the
// reason → copy step, which is the part that kept drifting. Pinned by
// test/code-send-error-guard.mjs.

/**
 * Why a code request failed. Named after the existing bg/api.js failure vocabulary
 * (`err_network` / `err_server` / `err_rate_limit`) so the two read as one language, but kept
 * separate because that vocabulary's copy is Claude.ai-specific ("Couldn't reach Claude.ai").
 */
export const SEND_CODE_REASON = {
  /** The request never reached our server: bad `serverUrl`, offline, blocked by the network. */
  NETWORK: 'network',
  /** Server reached; it could not hand the mail to the transport (503). */
  MAIL: 'mail',
  /**
   * Something answered, but it was not our API: a 2xx whose body is not the success contract.
   * 🔴 This is a REACHABLE state, not a theoretical one — `claudetuner.com` serves 200 + HTML for
   * any unknown path (Pages SPA fallback), so a `serverUrl` missing the `api.` prefix lands here.
   * Without it a tolerant JSON parse turns that into "Code sent" and parks the user on a code
   * screen for a code that was never sent (Codex DEPLOY-BLOCKER on the first cut of #1172).
   */
  BAD_RESPONSE: 'bad_response',
  /** 429 — the per-email throttle in worker/src/routes/auth.ts. */
  RATE: 'rate_limit',
  /** The server rejected the address itself (400). */
  BAD_EMAIL: 'bad_email',
  /** A 5xx. Deliberately NOT "any non-2xx" — see sendCodeReasonFromStatus. */
  SERVER: 'server',
  /** popup → service worker message never completed (chrome.runtime.lastError, or no response). */
  EXT: 'ext',
  /** Classified as nothing above — keeps the old catch-all sentence rather than inventing one. */
  UNKNOWN: 'unknown',
};

// reason → [i18n key, English fallback]. RATE, BAD_EMAIL and UNKNOWN reuse keys that already exist
// and already read correctly; the states that had no words of their own got new copy.
const COPY = {
  // 🔴 NO "check the server address in the options" — `server-url` is a HIDDEN input
  // (options.html), so that sentence sends the user to a field they cannot see, which is the #967
  // misdirection this change is supposed to be removing. The server address belongs in the
  // console.error next to the failure, where the person who can act on it will look. (Codex.)
  [SEND_CODE_REASON.NETWORK]: ['code_err_network', "Couldn't reach the server. Please check your internet connection."],
  [SEND_CODE_REASON.MAIL]: ['code_err_mail', "The server couldn't send the email. Please try again in a few minutes."],
  [SEND_CODE_REASON.BAD_RESPONSE]: ['code_err_bad_response', 'The server sent an unexpected response. Please try again in a few minutes.'],
  [SEND_CODE_REASON.RATE]: ['reauth_error_rate', 'Too many requests. Please wait a few minutes and try again.'],
  [SEND_CODE_REASON.BAD_EMAIL]: ['login_cta_bad_email', 'Enter a valid email.'],
  [SEND_CODE_REASON.SERVER]: ['code_err_server', 'The server returned an error. Please try again in a few minutes.'],
  [SEND_CODE_REASON.EXT]: ['code_err_ext', "The extension couldn't send the request. Reload it at chrome://extensions and try again."],
  [SEND_CODE_REASON.UNKNOWN]: ['reauth_error', 'Could not send the code. Please try again.'],
};

/**
 * Classify an HTTP outcome. `status` is the response status, or a non-number when the request
 * threw before producing one (which is the NETWORK case, not a server one).
 *
 * 🔴 503 is split out from the rest of 5xx on purpose: it is the ONLY status the mail path
 * returns for "reached us, could not send" (both `Email service unavailable` and
 * `Failed to send email` in worker/src/routes/auth.ts), and it is the one where "try again in a
 * few minutes" is true advice rather than a shrug.
 */
export function sendCodeReasonFromStatus(status, serverError) {
  if (serverError === 'network') return SEND_CODE_REASON.NETWORK;
  if (!Number.isFinite(status)) return SEND_CODE_REASON.NETWORK;
  if (status === 429 || serverError === 'rate_limited') return SEND_CODE_REASON.RATE;
  if (status === 503) return SEND_CODE_REASON.MAIL;
  if (status === 400) return SEND_CODE_REASON.BAD_EMAIL;
  if (status >= 500) return SEND_CODE_REASON.SERVER;
  // 🔴 A 4xx we have no dedicated copy for is NOT a server fault. The distinction is load-bearing
  // on the verify step, where SERVER overrides the "invalid or expired code" default: calling
  // verify's 404 (unknown user) or 409 (code already used) a server error would replace the right
  // sentence with a wrong one. Falling through to the catch-all is the honest answer — we do not
  // know, and we do not claim to.
  return SEND_CODE_REASON.UNKNOWN;
}

/**
 * Classify the reply to a `chrome.runtime.sendMessage` that the service worker fulfils.
 *
 * 🔴 `lastError` MUST be passed in by the caller, read inside its own callback. It is the only
 * evidence that the message never reached a listener, Chrome clears it after the callback
 * returns, and reading it also suppresses the "Unchecked runtime.lastError" console noise. Every
 * caller used to ignore it, so a dead message channel and a server outage produced the same
 * sentence.
 *
 * @param {{success?: boolean, status?: number, error?: string}|undefined} res
 * @param {{message?: string}|undefined} lastError  chrome.runtime.lastError, read by the caller
 * @returns {string|null} a SEND_CODE_REASON, or null when the request succeeded
 */
export function sendCodeReasonFromMessage(res, lastError) {
  if (lastError || !res) return SEND_CODE_REASON.EXT;
  if (res.success) return null;
  // The service worker sometimes knows more than the status can express — a throw that was not
  // the network, or a 2xx that was not our API. When it says so, believe it rather than
  // re-deriving a weaker answer from `status`.
  if (res.reason) return res.reason;
  return sendCodeReasonFromStatus(res.status, res.error);
}

/**
 * Classify something that was THROWN at a caller's catch.
 *
 * 🔴 "It threw, so it is the network" is too broad, and the copy it selects tells the user to go
 * check their connection and their server address when neither is at fault. `fetch()` rejects with
 * a TypeError when the request never completed; everything else that can reach these catches
 * (chrome.storage rejecting inside _authedFetch, a body read failing) reached the server first.
 * (Codex follow-up on the first cut of #1172.)
 */
export function sendCodeReasonFromThrown(err) {
  return err instanceof TypeError ? SEND_CODE_REASON.NETWORK : SEND_CODE_REASON.UNKNOWN;
}

/**
 * reason → the copy to paint. Returns the i18n key plus the English fallback the call sites
 * already pass to `t(key) || fallback`, so this stays a drop-in for what it replaced.
 */
export function sendCodeErrorCopy(reason) {
  const [key, fallback] = COPY[reason] || COPY[SEND_CODE_REASON.UNKNOWN];
  return { key, fallback };
}

/**
 * The same job for the VERIFY step, which has a different default.
 *
 * 🔴 "Invalid or expired code" is the RIGHT answer for a verify failure — that is what a rejected
 * code is — so it stays the default. Only the states that are not about the code at all may
 * override it. Without this split, the verify callbacks either keep saying "invalid code" when the
 * request never reached the server (the bug, one step later), or start telling a user who
 * genuinely mistyped six digits to go check their internet. (Codex follow-up on #1172.)
 */
const VERIFY_OVERRIDES = new Set([
  SEND_CODE_REASON.EXT,           // the message never reached the service worker
  SEND_CODE_REASON.NETWORK,       // the request never reached the server
  SEND_CODE_REASON.BAD_RESPONSE,  // something answered, but not our API
  SEND_CODE_REASON.SERVER,        // a 5xx — the code was never judged
  SEND_CODE_REASON.RATE,          // throttled, not wrong
]);

export function verifyCodeErrorCopy(res, lastError) {
  const reason = sendCodeReasonFromMessage(res, lastError);
  if (reason && VERIFY_OVERRIDES.has(reason)) return sendCodeErrorCopy(reason);
  return { key: 'reauth_error_invalid', fallback: 'Invalid or expired code. Request a new one.' };
}
