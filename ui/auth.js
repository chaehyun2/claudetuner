// Authenticated fetch + auth-header helpers for the popup. Mirrors bg/storage.js#authedFetch.
// Self-contained: uses the global CT_CONFIG (config.js, a classic script) + chrome.storage.

async function _getAuthHeaders(cfg) {
  const { extToken } = await chrome.storage.local.get('extToken');
  if (extToken) return { 'Authorization': `Bearer ${extToken}` };
  return { 'X-API-Key': cfg.apiKey || CT_CONFIG.DEFAULT_API_KEY };
}

// fetch wrapper that injects auth headers and clears stale ext_token on 401.
// Guarded against late-401 race (only clears if stored token still matches the
// one we sent) and API_KEY fallback (no Bearer → never clear).
// Keep in sync with bg/storage.js#authedFetch.
export async function _authedFetch(cfg, url, options = {}) {
  const auth = await _getAuthHeaders(cfg);
  const sentToken = auth.Authorization?.startsWith('Bearer ')
    ? auth.Authorization.slice(7)
    : null;
  const headers = { ...(options.headers || {}), ...auth };
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && sentToken) {
    const { extToken: currentToken } = await chrome.storage.local.get('extToken');
    if (currentToken === sentToken) {
      await chrome.storage.local.remove('extToken');
      try {
        const path = new URL(url).pathname;
        console.log(`[Claude Tuner] ext_token cleared (401) at ${path}`);
      } catch { /* ignore */ }
    }
  }
  return response;
}
