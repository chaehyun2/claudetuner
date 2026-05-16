// Synchronous theme bootstrap (FOUC prevention).
// Sets data-theme from system preference immediately; the actual stored
// preference is applied asynchronously once chrome.storage is available.
(function(){
  var mq = window.matchMedia('(prefers-color-scheme:dark)');
  document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
  // Apply stored preference as soon as possible
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({'ct-theme': 'system'}, function(r) {
      var pref = r['ct-theme'] || 'system';
      var resolved = pref === 'system'
        ? (mq.matches ? 'dark' : 'light')
        : pref;
      document.documentElement.setAttribute('data-theme', resolved);
    });
  }
})();
