// Synchronous theme bootstrap (FOUC prevention).
// Sets data-theme from system preference immediately; the actual stored
// preference is applied asynchronously once chrome.storage is available.
(function(){
  var mq = window.matchMedia('(prefers-color-scheme:dark)');
  document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
  // Framed by the claudetuner.com web shell (ui/embed-ready.js ran first and resolved the host):
  // the HOST owns the theme and posts {__ctTheme} to compare.js. Applying the stored preference
  // here would race that message — the storage callback lands after the host's first post on a
  // warm cache — and flip the frame to a theme the page around it is not wearing. Unset (popup,
  // options, a top-level compare tab) → unchanged behaviour.
  if (window.__ctEmbedHost) return;
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
  function applyStoredTheme() {
    chrome.storage.local.get({'ct-theme': 'system'}, function(r) {
      var pref = r['ct-theme'] || 'system';
      var resolved = pref === 'system'
        ? (mq.matches ? 'dark' : 'light')
        : pref;
      document.documentElement.setAttribute('data-theme', resolved);
    });
  }
  // Apply stored preference as soon as possible
  applyStoredTheme();
  // #1718: 'system' follows a live OS light<->dark switch, not only the scheme at load. The stored
  // preference is re-read on every change, so an explicit light/dark choice is never overridden.
  // This file is the first script on the popup/side panel, options and compare pages, so this one
  // listener covers every extension page.
  mq.addEventListener('change', applyStoredTheme);
})();
