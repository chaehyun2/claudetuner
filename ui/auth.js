// Authenticated fetch for the popup — a thin adapter over THE authedFetch (bg/storage.js, #2065).
// The popup is ESM and already imports bg/storage.js, so there is no runtime boundary to justify a
// copy; the copy that used to live here is how options.js drifted out of the 403 scope_insufficient
// branch. Only the API-key default stays local: popup callers may pass `apiKey: ''` (the SW never
// does), and the popup has always fallen back to CT_CONFIG (config.js, a classic script) for it.
import { authedFetch } from '../bg/storage.js';

export function _authedFetch(cfg, url, options = {}) {
  return authedFetch({ ...cfg, apiKey: cfg.apiKey || CT_CONFIG.DEFAULT_API_KEY }, url, options);
}
