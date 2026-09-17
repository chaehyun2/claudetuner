// Embed bootstrap — a classic script and the FIRST <script> in compare.html, ahead of theme-init.js
// and the compare.js module (#1452 / #1453, ported from dowoo lib/embed-ready.js).
//
// When compare.html is framed by the claudetuner.com web shell (site/multiai/), tell the host page
// that the extension is installed, and which version. Running first — before the module and its
// imports — means a later module/import error cannot make an installed extension look "not
// installed": the host reveals the frame on this ping (and the user sees any in-page error) instead
// of falling back to its install CTA after a timeout.
//
// 🔴 targetOrigin is never '*'. Two hosts may frame this page (production + CF Pages previews), so
// the host origin is READ from the frame's ancestry — `location.ancestorOrigins[0]` is the
// immediate parent, unaffected by the host's Referrer-Policy (Chromium-only, which an extension
// page always is); `document.referrer` is the fallback — and accepted only when it matches one of
// the two patterns below. Anything else (another site framing us, a top-level open) posts nothing.
//
// The resolved origin is published as `window.__ctEmbedHost` (null when not embedded / not
// allowed) so compare.js filters the host's messages against the SAME allowlist without carrying a
// second copy of it, and theme-init.js leaves the theme to the host when it is set.
(function () {
  var PROD_HOST = 'https://claudetuner.com';
  var PREVIEW_HOST = /^https:\/\/[a-z0-9-]+\.claude-tuner-site-git\.pages\.dev$/;

  window.__ctEmbedHost = null;
  if (window.top === window.self) return; // not embedded — a normal extension tab

  var host = null;
  try { host = (location.ancestorOrigins && location.ancestorOrigins[0]) || null; } catch (_) { host = null; }
  if (!host) {
    try { host = document.referrer ? new URL(document.referrer).origin : null; } catch (_) { host = null; }
  }
  if (host !== PROD_HOST && !PREVIEW_HOST.test(host || '')) return;

  window.__ctEmbedHost = host;
  try {
    window.parent.postMessage({ __ctReady: true, version: chrome.runtime.getManifest().version }, host);
  } catch (_) { /* host gone */ }
})();
