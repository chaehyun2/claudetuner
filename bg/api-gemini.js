import { GEMINI_API_BASE } from './constants.js';

// === Gemini batchexecute RPC helper (hybrid: tab-first, SW credentials fallback) ===

/**
 * Call a Gemini batchexecute RPC.
 * @param {string} rpcId - RPC method name (e.g. 'jSf9Qc')
 * @param {string} [params='[]'] - JSON-encoded RPC parameters
 * @returns {Promise<*>} Parsed RPC response data
 */
export async function fetchGeminiRpc(rpcId, params = '[]') {
  // Primary: tab-based (most reliable — runs in page context with full auth)
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  let tabErrorMsg = '';

  if (tabs.length > 0) {
    try {
      const viaTab = await fetchGeminiViaTab(tabs[0].id, rpcId, params);
      _lastFetchTabId = tabs[0].id;
      return viaTab;
    } catch (tabError) {
      tabErrorMsg = tabError.message;
      console.warn('[Claude Tuner] Gemini tab fetch failed, trying SW fallback:', tabErrorMsg);
    }
  } else {
    tabErrorMsg = 'No gemini.google.com tab';
    console.log('[Claude Tuner] No Gemini tab, using SW credentials fallback');
  }

  // Fallback: service worker fetch with credentials: 'include'
  // .google.com cookies are automatically included via HTTP standard
  try {
    const viaCreds = await fetchGeminiWithCredentials(rpcId, params);
    _lastFetchTabId = null;   // this usage came from the DEFAULT cookie account, not a tab
    return viaCreds;
  } catch (credError) {
    if (credError.message.startsWith('err_')) {
      throw credError;
    }
    throw new Error('err_gemini_collect_failed');
  }
}

// --- Tab-based fetch: execute batchexecute in MAIN world ---
async function fetchGeminiViaTab(tabId, rpcId, params) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (rpcId, params) => {
      try {
        // Extract AT token (XSRF) from page — required by batchexecute
        let atToken = '';
        try {
          // WIZ_global_data.SNlM0e holds the AT token in Gemini pages
          atToken = window.WIZ_global_data?.SNlM0e || '';
        } catch { /* ignore */ }
        if (!atToken) {
          // Fallback: extract from page HTML
          const match = document.documentElement.innerHTML.match(/"SNlM0e":"([^"]+)"/);
          if (match) atToken = match[1];
        }

        // Build batchexecute request body
        const innerReq = JSON.stringify([[[rpcId, params, null, 'generic']]]);
        let body = `f.req=${encodeURIComponent(innerReq)}&`;
        if (atToken) body += `at=${encodeURIComponent(atToken)}&`;

        const url = `/_/BardChatUi/data/batchexecute?rpcids=${rpcId}&source-path=%2Fusage&rt=c`;

        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'X-Same-Domain': '1',
          },
          body,
          credentials: 'include',
          cache: 'no-store',
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          return { _err: true, status: resp.status, body: text.slice(0, 500) };
        }

        const text = await resp.text();
        return { _err: false, data: text };
      } catch (e) {
        return { _err: true, status: 0, message: e.message };
      }
    },
    args: [rpcId, params],
  });

  const result = results?.[0]?.result;
  if (!result || result._err) {
    const status = result?.status || 'unknown';
    const msg = result?.message || result?.body?.slice(0, 200) || '';
    if (status === 401 || status === 403) throw new Error(`err_gemini_auth_failed:${status}`);
    if (status === 429) throw new Error('err_gemini_rate_limit');
    throw new Error(msg || `Gemini API error (${status})`);
  }
  return parseBatchExecuteResponse(result.data, rpcId);
}

// --- Service worker fallback: fetch with credentials: 'include' ---
// .google.com domain cookies (like __Secure-1PSID) are automatically included
// in fetch requests to gemini.google.com via HTTP standard cookie propagation.
// No need for chrome.cookies API or *.google.com host_permissions.
async function fetchGeminiWithCredentials(rpcId, params) {
  // Step 1: Fetch page HTML to extract AT token (SNlM0e)
  const pageResp = await fetch(`${GEMINI_API_BASE}/app`, {
    credentials: 'include',
  });

  if (pageResp.redirected && (pageResp.url.includes('accounts.google') || pageResp.url.includes('signin'))) {
    throw new Error('err_gemini_not_logged_in');
  }
  if (!pageResp.ok) {
    throw new Error(`err_gemini_page_fetch:${pageResp.status}`);
  }

  const html = await pageResp.text();

  // Cache HTML for getGeminiUserInfo to extract email/googleId without extra fetch
  _lastPageHtml = html;
  _lastPageHtmlTs = Date.now();

  const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
  if (!atMatch) {
    throw new Error('err_gemini_no_at_token');
  }
  const atToken = atMatch[1];

  // Step 2: Call batchexecute with credentials
  const innerReq = JSON.stringify([[[rpcId, params, null, 'generic']]]);
  const body = `f.req=${encodeURIComponent(innerReq)}&at=${encodeURIComponent(atToken)}&`;
  const url = `${GEMINI_API_BASE}/_/BardChatUi/data/batchexecute?rpcids=${rpcId}&source-path=%2Fusage&rt=c`;

  const resp = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'X-Same-Domain': '1',
    },
    body,
  });

  if (!resp.ok) {
    if (resp.status === 403) throw new Error('err_gemini_cloudflare');
    if (resp.status === 401) throw new Error('err_gemini_session_expired');
    if (resp.status === 429) throw new Error('err_gemini_rate_limit');
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Gemini API error (${resp.status}): ${errBody.slice(0, 200)}`);
  }

  const text = await resp.text();
  return parseBatchExecuteResponse(text, rpcId);
}

// Cached page HTML from SW fallback (reused by getGeminiUserInfo when no tab)
// WHICH observation the last usage RPC came from: a tab id, or null for the service-worker
// credentials fallback. getGeminiUserInfo() has to answer for the SAME account that produced the
// usage — see the note there.
let _lastFetchTabId = null;
let _lastPageHtml = null;
let _lastPageHtmlTs = 0;
const PAGE_HTML_TTL_MS = 60_000; // 1 min

/**
 * Parse Google batchexecute response format.
 * Format: ")]}\'\n<length>\n<json-array>\n..."
 * Returns the parsed data for the given rpcId.
 */
function parseBatchExecuteResponse(text, rpcId) {
  // Split by lines, skip the ")]}'" prefix and length lines
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === ")]}'") continue;
    if (/^\d+$/.test(trimmed)) continue; // length line

    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) continue;

      // batchexecute wraps response as: [["wrb.fr", rpcId, dataString, ...], ...]
      // Multiple rows possible — iterate all to find our rpcId
      for (const row of parsed) {
        if (!Array.isArray(row)) continue;
        if (row[0] === 'wrb.fr' && row[1] === rpcId) {
          const dataStr = row[2];
          if (dataStr) return JSON.parse(dataStr);
          return null;
        }
      }
    } catch {
      // not a JSON line, skip
    }
  }
  throw new Error('err_gemini_collect_failed');
}

// === Extract user info from Gemini page (MAIN world) or cached HTML ===
export async function getGeminiUserInfo() {
  // 🔴 THE LABEL MUST COME FROM THE SAME PLACE AS THE USAGE. This used to query tabs on its own,
  // independently of how `fetchGeminiRpc` actually got the numbers — and those two can be different
  // Google accounts, which is not exotic: multi-account (/u/0, /u/1) is ordinary. Concretely, a tab
  // fetch that fails falls back to service-worker credentials, i.e. the DEFAULT cookie account B,
  // while this function then read the still-open tab's DOM and reported A. The usage is B's and the
  // name shown is A's.
  //
  // That mattered less while this only fed `provider_email`; #1038 puts it on screen as the answer
  // to "which accounts does logging in absorb", so a mismatched name is now a false statement to
  // the user. Same root as the three Claude defects on this branch: an email that LOOKS like the
  // provider account but came from a different observation.
  //
  // `_lastFetchTabId === null` means the credentials fallback served the usage → the only honest
  // source is the HTML that fallback itself fetched. Untouched when no usage fetch has run yet
  // (the id starts null and the cached HTML is null too, so it degrades to "unknown").
  const tabs = _lastFetchTabId === null
    ? []
    : (await chrome.tabs.query({ url: 'https://gemini.google.com/*' })).filter((t) => t.id === _lastFetchTabId);
  if (tabs.length > 0) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        world: 'MAIN',
        func: () => {
          try {
            const wizData = window.WIZ_global_data || {};
            const userEmail = wizData.oPEP7c || null;

            let email = userEmail;
            if (!email) {
              const accountBtn = document.querySelector('[data-ogsr-up]');
              const ariaLabel = accountBtn?.getAttribute('aria-label') || '';
              const emailMatch = ariaLabel.match(/[\w.-]+@[\w.-]+\.\w+/);
              if (emailMatch) email = emailMatch[0];
            }
            if (!email) {
              const profileEl = document.querySelector('[data-email]');
              if (profileEl) email = profileEl.getAttribute('data-email');
            }

            const googleId = wizData.S06Grb || null;
            return { email, googleId };
          } catch {
            return { email: null, googleId: null };
          }
        },
      });
      const info = results?.[0]?.result;
      if (info?.email || info?.googleId) return info;
    } catch { /* fall through to HTML extraction */ }
  }

  // Fallback: extract from cached page HTML (set by fetchGeminiWithCredentials)
  return extractUserInfoFromHtml(_lastPageHtml);
}

// Parse WIZ_global_data values from raw HTML string
function extractUserInfoFromHtml(html) {
  if (!html) return { email: null, googleId: null };
  const emailMatch = html.match(/"oPEP7c"\s*:\s*"([^"]+)"/);
  const idMatch = html.match(/"S06Grb"\s*:\s*"([^"]+)"/);
  return {
    email: emailMatch?.[1] || null,
    googleId: idMatch?.[1] || null,
  };
}

// === Check if user is logged into Gemini ===
// Uses lightweight HEAD request with credentials when no tab is open.
export async function isGeminiLoggedIn() {
  try {
    // Fast check: open Gemini tab implies logged in
    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    if (tabs.length > 0) return true;

    // SW check: HEAD request with credentials — redirect to login means not logged in
    const resp = await fetch(`${GEMINI_API_BASE}/app`, {
      method: 'HEAD',
      credentials: 'include',
      redirect: 'manual',
    });
    // 200 = logged in, 0 (opaque redirect) or 3xx = not logged in
    return resp.status === 200;
  } catch {
    return false;
  }
}
