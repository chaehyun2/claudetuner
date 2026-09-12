import { GEMINI_API_BASE } from './constants.js';

// === Gemini batchexecute RPC helper (hybrid: tab-first, SW credentials fallback) ===

/**
 * Call a Gemini batchexecute RPC.
 * @param {string} rpcId - RPC method name (e.g. 'jSf9Qc')
 * @param {string} [params='[]'] - JSON-encoded RPC parameters
 * @returns {Promise<*>} Parsed RPC response data
 */
// The HTTP status out of this layer's own prose throws, and NOTHING else.
//
// 🔴 The anchor and the 3-digit bound are the security boundary. It matters MORE here than in the
// ChatGPT twin: fetchGeminiViaTab's `msg` falls back to `result?.body?.slice(0, 200)`, so a slice
// of the RESPONSE BODY is already inside the thrown message by construction. Only digits in the one
// position this layer writes them may travel. (normalizeProviderError re-checks; this is the first
// of the two.)
const GEMINI_HTTP_STATUS_RE = /^Gemini API error \((\d{3})\)/;
function geminiHttpStatus(message) {
  const m = GEMINI_HTTP_STATUS_RE.exec(typeof message === 'string' ? message : '');
  return m ? m[1] : '';
}

export async function fetchGeminiRpc(rpcId, params = '[]') {
  // Primary: tab-based (most reliable — runs in page context with full auth)
  // 🪤 A REJECTION HERE IS NOT "our collection logic threw". `chrome.tabs.query` can reject, and it
  // sits OUTSIDE every code-minting path — the raw message escaped to the collector, whose new
  // `unclassified` rule reads "no err_ prefix" as "our own logic". That would be wrong: this is the
  // browser-access layer. (Codex 후속.) Treating it as "no tab" is also the more robust reading —
  // the fallback path does not need the tab list to run.
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  } catch (e) {
    console.debug(`[Claude Tuner] gemini tabs.query rejected: ${e && e.message}`);
  }
  // 🔴 THE ERROR OBJECT, NOT A STRING NOBODY READS. This was `tabErrorMsg`, assigned on all three
  // branches and read only by the console.warn below — the same dead variable the ChatGPT twin had
  // (#1417). So every tab-path failure was discarded and the throw at the bottom said
  // `collect_failed` regardless, whose copy is "open a gemini.google.com tab and try again" —
  // advice that is false exactly when a tab was open and tried. (#1418)
  let tabError = null;

  if (tabs.length > 0) {
    try {
      const viaTab = await fetchGeminiViaTab(tabs[0].id, rpcId, params);
      _lastFetchTabId = tabs[0].id;
      return viaTab;
    } catch (e) {
      tabError = e;
      console.warn('[Claude Tuner] Gemini tab fetch failed, trying SW fallback:', e.message);
    }
  } else {
    console.log('[Claude Tuner] No Gemini tab, using SW credentials fallback');
  }

  // Fallback: service worker fetch with credentials: 'include'
  // .google.com cookies are automatically included via HTTP standard
  try {
    const viaCreds = await fetchGeminiWithCredentials(rpcId, params);
    _lastFetchTabId = null;   // this usage came from the DEFAULT cookie account, not a tab
    return viaCreds;
  } catch (credError) {
    // 🔴 `network` IS THE WEAKEST CODE, AND ORDER HAD TO LEARN THAT. It says one thing — this path
    // never got an answer. If the OTHER path DID get one, that observation is strictly better, and
    // returning "could not connect" instead would throw away a verified HTTP status. Adding the
    // network split without this made exactly that regression; the guard caught it.
    // 🪤 "NAMES A DIAGNOSIS" IS NARROWER THAN "STARTS WITH err_", AND THE FIRST CUT GOT IT WRONG.
    // The tab path can throw the CATCH-ALL itself — Gemini's `parseBatchExecuteResponse` does it for
    // a 200 whose RPC envelope is unreadable — and letting that outrank `network` trades an
    // actionable observation for the bucket we are trying to empty. Codex reproduced it (배포차단).
    // Only a code that says what the provider actually ANSWERED beats "we never reached them".
    const tabMsg = tabError ? tabError.message : '';
    const tabNamesDiagnosis = tabMsg.indexOf('err_') === 0 && tabMsg !== 'err_gemini_collect_failed';
    if (credError.message === 'err_gemini_network' && tabNamesDiagnosis) {
      throw tabError;
    }
    // Otherwise a fallback-path code is the most specific thing either path produced.
    if (credError.message.startsWith('err_')) {
      throw credError;
    }
    // Only now — with BOTH paths spent — may the tab path's fault be reported.
    // 🔑 A STATUS THE FALLBACK ACTUALLY OBSERVED BEATS "neither path named itself". This was
    // reachable only when there was no tab, so a statusless tab fault plus a fallback HTTP 500
    // reported `fallback_exhausted` and threw the 500 away (Codex 후속). The tab's own code still
    // wins first — it talked to the provider through the more reliable path.
    const status = geminiHttpStatus(credError.message);
    if (tabError) {
      if (tabMsg.indexOf('err_') === 0) throw tabError;
      throw new Error(status ? `err_gemini_http:${status}` : 'err_gemini_fallback_exhausted');
    }
    // No tab was open, so `collect_failed`'s "open a tab" copy is TRUE here.
    throw new Error(status ? `err_gemini_http:${status}` : 'err_gemini_collect_failed');
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
    // 🔴 `result.body` IS NOT A CANDIDATE FOR THE THROWN MESSAGE, AND REMOVING IT IS A FIX.
    //
    // The MAIN-world script returns `{_err, status, body}` (no `message`) for every non-ok HTTP
    // response, so `msg` used to BE a slice of the response body — and because `msg` wins below,
    // the body DISPLACED the `Gemini API error (<status>)` prose. The body can never travel (it is
    // untrusted page data), so the net effect was that a tab-path HTTP failure lost the one field
    // that could: the status. Every one of them collapsed to the catch-all.
    //
    // It is still worth SEEING, so it goes to the console, which is where an untrusted 500-byte
    // blob is actually useful. (Found by test/provider-fetch-diag-guard.mjs while porting the
    // ChatGPT split — the shared assertion passed for chatgpt and failed here. #1418)
    if (result?.body) {
      console.warn('[Claude Tuner] Gemini tab error body:', String(result.body).slice(0, 200));
    }
    const msg = result?.message || '';
    if (status === 401 || status === 403) throw new Error(`err_gemini_auth_failed:${status}`);
    if (status === 429) throw new Error('err_gemini_rate_limit');
    // 🔴 THE CODE IS MINTED FROM `result.status`, NOT PARSED BACK OUT OF PROSE.
    //
    // The first cut of this split let the caller regex `Gemini API error (NNN)` out of the thrown
    // MESSAGE — and an anchored 3-digit pattern does not prove where the string came from. `msg`
    // below is page data (a caught exception from a MAIN-world `fetch` the page can override), so
    // `{_err:true, status:0, message:'Gemini API error (987): …'}` stored `err_gemini_http:987`:
    // a status the PAGE chose, shown to the user and carried into AE as if we had observed it.
    // (Codex 배포차단, #1418 — the ChatGPT twin shipped with the same hole in #1417.)
    //
    // `status` here is `result.status`, a field our own injected function fills from `resp.status`.
    // Taking it directly removes the parse, and with it the whole class.
    if (typeof status === 'number' && status >= 100 && status <= 599) {
      throw new Error(`err_gemini_http:${status}`);
    }
    // 🔴 `msg` IS PAGE DATA AND MAY NOT IMPERSONATE ONE OF OUR CODES — and here it is not merely
    // "a runtime message we do not control": the expression above falls back to
    // `result?.body?.slice(0, 200)`, i.e. the RESPONSE BODY. The caller passes an `err_`-prefixed
    // tab message straight through, so a body that happens to begin `err_gemini_…` would be adopted
    // as a code and carry its own tail. Codes are minted HERE, from the status, or not at all.
    // (Same rule as the ChatGPT twin, #1417 Codex 후속 4·5.)
    // 🪤 LOGGED BEFORE IT IS REFUSED. Declining to adopt a page string as a code is right; throwing
    // it away entirely is a diagnostic regression — the parent put the raw text on the console.
    // (Codex 후속, #1418.)
    if (msg && msg.indexOf('err_') === 0) {
      console.warn('[Claude Tuner] Gemini tab reported a code-shaped message (not adopted):', msg.slice(0, 200));
    }
    throw new Error(msg && msg.indexOf('err_') !== 0 ? msg : `Gemini API error (${status})`);
  }
  return parseBatchExecuteResponse(result.data, rpcId);
}

// --- Service worker fallback: fetch with credentials: 'include' ---
// .google.com domain cookies (like __Secure-1PSID) are automatically included
// in fetch requests to gemini.google.com via HTTP standard cookie propagation.
// No need for chrome.cookies API or *.google.com host_permissions.
async function fetchGeminiWithCredentials(rpcId, params) {
  // Step 1: Fetch page HTML to extract AT token (SNlM0e)
  // 🔴 Same split as the ChatGPT twin: a REJECTED fetch never got an answer and is not the same
  // thing as "collection failed". See the note in bg/api-chatgpt.js.
  let pageResp;
  try {
    pageResp = await fetch(`${GEMINI_API_BASE}/app`, {
      credentials: 'include',
      cache: 'no-store',
    });
  } catch (e) {
    console.debug(`[Claude Tuner] Gemini page fetch rejected: ${e && e.message}`);
    throw new Error('err_gemini_network');
  }

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

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Same-Domain': '1',
      },
      body,
      cache: 'no-store',
    });
  } catch (e) {
    console.debug(`[Claude Tuner] Gemini rpc fetch rejected: ${e && e.message}`);
    throw new Error('err_gemini_network');
  }

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
      // A cached 200 here would report "logged in" for a signed-out user — this probe's
      // whole job is to read live auth state, so it is the last fetch that may be cached.
      cache: 'no-store',
    });
    // 200 = logged in, 0 (opaque redirect) or 3xx = not logged in
    return resp.status === 200;
  } catch {
    return false;
  }
}
