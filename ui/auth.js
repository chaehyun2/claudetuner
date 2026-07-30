// Authenticated fetch + auth-header helpers for the popup. Mirrors bg/storage.js#authedFetch.
// Self-contained: uses the global CT_CONFIG (config.js, a classic script) + chrome.storage.

async function _getAuthHeaders(cfg) {
  const { extToken } = await chrome.storage.local.get('extToken');
  if (extToken) return { 'Authorization': `Bearer ${extToken}` };
  return { 'X-API-Key': cfg.apiKey || CT_CONFIG.DEFAULT_API_KEY };
}

// True only when the server says THIS ext_token failed verification.
// Keep in sync with bg/storage.js#isExtTokenRejected (drift guard: test/exttoken-invalid-code-guard.mjs).
async function _isExtTokenRejected(response) {
  try {
    const body = await response.clone().json();
    return !!body && body.code === 'ext_token_invalid';
  } catch {
    return false;
  }
}

// fetch wrapper that injects auth headers and clears the ext_token only on a 401 the server marked
// `ext_token_invalid`. A bare 401 is NOT enough: the extension also calls endpoints that never
// accept an ext_token (`/api/me*` → googleAuthMiddleware), so their 401 means "wrong credential for
// this door" and clearing on it deleted VALID tokens at ~620/hour (fixed in 1.29.21).
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
  if (response.status === 401 && sentToken && await _isExtTokenRejected(response)) {
    const { extToken: currentToken } = await chrome.storage.local.get('extToken');
    if (currentToken === sentToken) {
      await chrome.storage.local.remove('extToken');
      try {
        const path = new URL(url).pathname;
        console.log(`[Claude Tuner] ext_token cleared (401 ext_token_invalid) at ${path}`);
      } catch { /* ignore */ }
    }
  } else if (response.status === 403 && sentToken) {
    // Phase 2 scope_insufficient: an ingest-scoped token hit a full-required endpoint under
    // enforce. The token is VALID — do NOT clear it (clearing → API_KEY re-TOFU → another
    // ingest token → loop). Raise needsFullLogin so the popup surfaces the login CTA and the
    // feature (e.g. /fitness) degrades to a login prompt instead of a frozen call.
    try {
      const body = await response.clone().json();
      if (body && body.code === 'scope_insufficient') {
        await chrome.storage.local.set({ needsFullLogin: true });
        try {
          const path = new URL(url).pathname;
          console.log(`[Claude Tuner] scope_insufficient at ${path} — full login needed`);
        } catch { /* ignore */ }
      }
    } catch { /* not JSON — leave untouched */ }
  }
  return response;
}
