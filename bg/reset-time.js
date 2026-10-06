// resets_at normalization — pure, zero imports, no chrome.*, no fetch, no Date.now().
//
// WHY THIS IS ITS OWN MODULE (#2153 A0a). bg/parse-*.js must stay importable under plain Node
// (provider contract runner, desktop app main process). They used to import this function from
// bg/api.js, whose other exports are chrome-only and which pulls in vendor-ai/sites.js. Moved here
// verbatim; bg/api.js re-exports it under the same name, so its existing importers are unchanged.
//
// 🔴 KEEP THIS FILE IMPORT-FREE.

// === Normalize resets_at (round to minute) ===
// Claude API returns random 59.xxx / 00.xxx seconds, breaking same-window comparison
// Round up to next minute if seconds >= 30, strip sub-seconds
export function normalizeResetTime(t) {
  if (!t) return null;
  const d = new Date(t);
  if (isNaN(d.getTime())) return t;
  if (d.getUTCSeconds() >= 30) d.setUTCMinutes(d.getUTCMinutes() + 1);
  d.setUTCSeconds(0, 0);
  return d.toISOString().slice(0, 19) + '+00:00';
}
