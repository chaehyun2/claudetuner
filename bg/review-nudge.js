// The Chrome Web Store review nudge — ONE copy of its rules for every surface that shows it: the
// popup (ui/recommend.js checkReviewNudge), the options page banner (options.js) and the AI
// cross-check / debate page (ui/compare/review-nudge.js, #1966).
//
// State: chrome.storage.local `ct_review_nudge` = `{ clicked, dismiss_count, last_dismissed,
// first_seen_at }`, written from the server's snapshot response (bg/collect.js) and — so the other
// surfaces respect a click / dismiss before the next sync — by recordReviewNudgeAction here. The
// timestamps are D1 `datetime('now')` strings: UTC without a zone ('YYYY-MM-DD HH:MM:SS'), so they
// are parsed with a trailing 'Z' (without it they read as LOCAL time and every gate skews by the
// user's UTC offset).
//
// No chrome.* at module scope: the service worker (bg/compare.js), the popup / options pages and
// the compare page all import it, and the guards import it in node.

export const REVIEW_NUDGE_KEY = 'ct_review_nudge';
export const REVIEW_ACTION_CLICKED = 'clicked';
export const REVIEW_ACTION_DISMISSED = 'dismissed';
const REVIEW_ACTIONS = Object.freeze([REVIEW_ACTION_CLICKED, REVIEW_ACTION_DISMISSED]);
// Gates (product decision, unchanged since the popup nudge): five dismissals end it, a dismissal
// rests it this long, a new install is left alone this long, a nearly-spent limit is no moment to ask.
export const REVIEW_MAX_DISMISSALS = 5;
export const REVIEW_SNOOZE_DAYS = 14;
export const REVIEW_MIN_AGE_DAYS = 3;
export const REVIEW_MAX_UTILIZATION = 80;
// GA event names — the same three on every surface; `source` says which one.
export const REVIEW_EVENT_SHOWN = 'review_nudge_shown';
export const REVIEW_EVENT_CLICKED = 'review_nudge_clicked';
export const REVIEW_EVENT_DISMISSED = 'review_nudge_dismissed';
export const REVIEW_EVENTS = Object.freeze([REVIEW_EVENT_SHOWN, REVIEW_EVENT_CLICKED, REVIEW_EVENT_DISMISSED]);
// The compare page reports a click / dismiss through the service worker (it holds no token).
export const REVIEW_NUDGE_MSG_TYPE = 'REVIEW_NUDGE_ACTION';
export const CWS_REVIEW_URL = 'https://chromewebstore.google.com/detail/claude-tuner/ajnnckikagphjbgpicpoffockabnhond/reviews';
const REVIEW_NUDGE_PATH = '/api/snapshots/review-nudge';
const MS_PER_DAY = 86400000;

/** A D1 UTC timestamp → epoch ms (NaN when absent or malformed). */
const d1Ms = (s) => (typeof s === 'string' && s ? new Date(s + 'Z').getTime() : NaN);
/** Epoch ms → a D1 `datetime('now')` string, the shape the server writes. */
const d1Stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/**
 * Whether the review nudge may show now. `rn` is the stored `ct_review_nudge` (absent = the server
 * never said → no); `snapshot` the usage snapshot when the surface has one (its 5-hour / 7-day
 * utilization), else null. Pure.
 */
export function reviewNudgeDue(rn, { now = Date.now(), snapshot = null } = {}) {
  if (!rn) return false;
  if (rn.clicked) return false;
  if ((rn.dismiss_count || 0) >= REVIEW_MAX_DISMISSALS) return false;
  const dismissed = d1Ms(rn.last_dismissed);
  if (Number.isFinite(dismissed) && now - dismissed < REVIEW_SNOOZE_DAYS * MS_PER_DAY) return false;
  const firstSeen = d1Ms(rn.first_seen_at);
  if (Number.isFinite(firstSeen) && now - firstSeen < REVIEW_MIN_AGE_DAYS * MS_PER_DAY) return false;
  if (snapshot) {
    const maxUtil = Math.max(snapshot.five_hour?.utilization ?? 0, snapshot.seven_day?.utilization ?? 0);
    if (maxUtil >= REVIEW_MAX_UTILIZATION) return false;
  }
  return true;
}

/** The stored state after `action` at `now` — what the server will answer once it has the PATCH. Pure. */
export function markReviewNudge(rn, action, now = Date.now()) {
  const base = { clicked: false, dismiss_count: 0, last_dismissed: null, first_seen_at: null, ...(rn || {}) };
  if (action === REVIEW_ACTION_CLICKED) return { ...base, clicked: true };
  if (action === REVIEW_ACTION_DISMISSED) return { ...base, dismiss_count: (base.dismiss_count || 0) + 1, last_dismissed: d1Stamp(now) };
  return base;
}

/**
 * Record a click / dismiss: the local state at once (every surface reads it), then PATCH the
 * server for the signed-in account. `storage` = chrome.storage.local (promise API), `getConfig`
 * → `{ serverUrl, … }` as `authedFetch(config, url, init)` takes it. Never throws; false = an
 * unknown action or a failed local write — a failed local write still sends the PATCH (the
 * server is what every later sync restores from; the per-surface copies always sent it).
 */
export async function recordReviewNudgeAction(action, { storage, getConfig, authedFetch, now = () => Date.now() }) {
  if (!REVIEW_ACTIONS.includes(action)) return false;
  let got = null;
  try { got = await storage.get({ [REVIEW_NUDGE_KEY]: null, lastStatus: null }); } catch { /* no email → no PATCH below */ }
  let wrote = false;
  // An unread state is not overwritten (a fresh one would drop the stored count until the next sync).
  if (got) {
    try {
      await storage.set({ [REVIEW_NUDGE_KEY]: markReviewNudge(got[REVIEW_NUDGE_KEY], action, now()) });
      wrote = true;
    } catch { /* the PATCH still goes */ }
  }
  const email = got?.lastStatus?.snapshot?.user_email || null;
  if (!email) return wrote;
  try {
    const cfg = await getConfig();
    if (!cfg?.serverUrl) return wrote;
    await authedFetch(cfg, cfg.serverUrl + REVIEW_NUDGE_PATH, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_email: email, action }),
    });
  } catch { /* the local state already holds it; the next click / dismiss tries the server again */ }
  return wrote;
}
