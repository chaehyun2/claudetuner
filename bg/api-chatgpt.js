import { CHATGPT_API_BASE, CHATGPT_SESSION_COOKIE } from './constants.js';

// The HTTP status out of this layer's own prose throws, and NOTHING else.
//
// 🔴 The anchor and the 3-digit bound are the security boundary, not tidiness: the same message
// shape interpolates `text.slice(0, 500)` of an API response after the status, and this value ends
// up in a code that reaches claudetuner.com. Only digits in the one position this layer writes them
// may travel. (normalizeProviderError re-checks; this is the first of the two.)
const CHATGPT_HTTP_STATUS_RE = /^ChatGPT API error \((\d{3})\)/;
function chatgptHttpStatus(message) {
  const m = CHATGPT_HTTP_STATUS_RE.exec(typeof message === 'string' ? message : '');
  return m ? m[1] : '';
}

// === ChatGPT API call helper (hybrid: tab-first, cookie fallback) ===
// ChatGPT requires Authorization: Bearer <JWT> — obtained via /api/auth/session
export async function fetchChatGPTApi(path, options = {}) {
  const fullUrl = `${CHATGPT_API_BASE}${path}`;

  // Primary: tab-based (most reliable — runs in page context with full auth)
  // 🪤 A REJECTION HERE IS NOT "our collection logic threw". `chrome.tabs.query` can reject, and it
  // sits OUTSIDE every code-minting path — the raw message escaped to the collector, whose new
  // `unclassified` rule reads "no err_ prefix" as "our own logic". That would be wrong: this is the
  // browser-access layer. (Codex 후속.) Treating it as "no tab" is also the more robust reading —
  // the fallback path does not need the tab list to run.
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  } catch (e) {
    console.debug(`[Claude Tuner] chatgpt tabs.query rejected: ${e && e.message}`);
  }
  // 🔴 THE ERROR OBJECT, NOT A STRING NOBODY READS. This used to be `tabErrorMsg`, assigned on
  // all three branches and read only by the console.warn below — so every tab-path failure was
  // discarded and the throw at the bottom said `collect_failed` no matter what had happened. That
  // is why inquiry 2026-09-11 (wonkyung@backpac.kr) could not be diagnosed: the user was told to
  // open a chatgpt.com tab while a logged-in chatgpt.com tab was open on screen, and the one value
  // that would have named the real fault had been computed and thrown away.
  let tabError = null;

  if (tabs.length > 0) {
    try {
      return await fetchChatGPTViaTab(tabs[0].id, fullUrl);
    } catch (e) {
      tabError = e;
      console.warn('[Claude Tuner] ChatGPT tab fetch failed, trying cookie fallback:', e.message);
    }
  } else {
    console.log('[Claude Tuner] No ChatGPT tab, using cookie fallback');
  }

  // Fallback: cookie-based direct call
  try {
    return await fetchChatGPTWithCookies(fullUrl);
  } catch (cookieError) {
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
    const tabNamesDiagnosis = tabMsg.indexOf('err_') === 0 && tabMsg !== 'err_chatgpt_collect_failed';
    if (cookieError.message === 'err_chatgpt_network' && tabNamesDiagnosis) {
      throw tabError;
    }
    // Otherwise a fallback-path code is the most specific thing either path produced.
    if (cookieError.message.startsWith('err_')) {
      throw cookieError;
    }
    // Only now — with BOTH paths spent — may the tab path's fault be reported. Consulting it any
    // earlier would change which error wins on a request the cookie path went on to answer.
    // 🔑 A STATUS THE FALLBACK ACTUALLY OBSERVED BEATS "neither path named itself". This was
    // reachable only when there was no tab, so a statusless tab fault plus a fallback HTTP 500
    // reported `fallback_exhausted` and threw the 500 away (Codex 후속). The tab's own code still
    // wins first — it talked to the provider through the more reliable path.
    const status = chatgptHttpStatus(cookieError.message);
    if (tabError) {
      if (tabMsg.indexOf('err_') === 0) throw tabError;
      throw new Error(status ? `err_chatgpt_http:${status}` : 'err_chatgpt_fallback_exhausted');
    }
    // No tab was open, so `collect_failed`'s "open a chatgpt.com tab" copy is TRUE here. That
    // narrowing is the point: the sentence stays, and the population it is said to shrinks to the
    // one it fits.
    throw new Error(status ? `err_chatgpt_http:${status}` : 'err_chatgpt_collect_failed');
  }
}

// --- Tab-based fetch: 2-step auth in MAIN world ---
async function fetchChatGPTViaTab(tabId, fullUrl) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (url) => {
      try {
        // Step 1: Get Bearer token from session endpoint
        const sessionResp = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
        if (!sessionResp.ok) {
          return { _err: true, status: sessionResp.status, message: 'session_fetch_failed' };
        }
        const session = await sessionResp.json();
        if (!session?.accessToken) {
          return { _err: true, status: 401, message: 'no_access_token' };
        }

        // Step 2: Call actual API with Bearer token
        const resp = await fetch(url, {
          headers: {
            'Authorization': 'Bearer ' + session.accessToken,
            'Accept': 'application/json',
          },
          credentials: 'include',
          cache: 'no-store',
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          return { _err: true, status: resp.status, body: text.slice(0, 500) };
        }
        return { _err: false, data: await resp.json() };
      } catch (e) {
        return { _err: true, status: 0, message: e.message };
      }
    },
    args: [fullUrl],
  });

  const result = results?.[0]?.result;
  if (!result || result._err) {
    const status = result?.status || 'unknown';
    const msg = result?.message || '';
    if (status === 401 || status === 403) throw new Error(`err_chatgpt_auth_failed:${status}`);
    if (status === 429) throw new Error('err_chatgpt_rate_limit');
    // 🔴 THE CODE IS MINTED FROM `result.status`, NOT PARSED BACK OUT OF PROSE.
    //
    // The first cut of this split let the caller regex `ChatGPT API error (NNN)` out of the thrown
    // MESSAGE — and an anchored 3-digit pattern does not prove where the string came from. `msg`
    // below is page data (a caught exception from a MAIN-world `fetch` the page can override), so
    // `{_err:true, status:0, message:'ChatGPT API error (987): …'}` stored `err_chatgpt_http:987`:
    // a status the PAGE chose, shown to the user and carried into AE as if we had observed it.
    // (Codex 배포차단, #1418 — the ChatGPT twin shipped with the same hole in #1417.)
    //
    // `status` here is `result.status`, a field our own injected function fills from `resp.status`.
    // Taking it directly removes the parse, and with it the whole class.
    if (typeof status === 'number' && status >= 100 && status <= 599) {
      throw new Error(`err_chatgpt_http:${status}`);
    }
    // 🔴 `msg` IS THE PAGE'S OWN TEXT AND MAY NOT IMPERSONATE ONE OF OUR CODES. It is whatever the
    // MAIN-world script reported — `session_fetch_failed`, `no_access_token`, or a raw JS error
    // message from a page we do not control. The caller passes an `err_`-prefixed tab message
    // straight through, so a message that merely STARTS with `err_` would be read as a code and
    // carry its own tail: `err_chatgpt_http:private@example.com` normalises to a bare
    // `err_chatgpt_http` whose copy then renders a literal `{0}`, and
    // `err_chatgpt_fallback_exhausted:500` is 34 characters, which AE stores as `invalid`
    // (DRIFT_CODE_RE caps at 32). Neither is a leak — provider-state.js drops the non-numeric tail
    // and AE rejects the long one — but both are our vocabulary being written by the page.
    // (Codex 후속 4·5, 2026-09-11.) Codes are minted HERE, from the status, or not at all.
    // 🪤 LOGGED BEFORE IT IS REFUSED. Declining to adopt a page string as a code is right; throwing
    // it away entirely is a diagnostic regression — the parent put the raw text on the console.
    // (Codex 후속, #1418.)
    if (msg && msg.indexOf('err_') === 0) {
      console.warn('[Claude Tuner] ChatGPT tab reported a code-shaped message (not adopted):', msg.slice(0, 200));
    }
    throw new Error(msg && msg.indexOf('err_') !== 0 ? msg : `ChatGPT API error (${status})`);
  }
  return result.data;
}

// --- Cookie-based fallback: 2-step auth via cookies ---
async function fetchChatGPTWithCookies(url) {
  const cookies = await chrome.cookies.getAll({ url: 'https://chatgpt.com' });
  if (!cookies.length) {
    throw new Error('err_chatgpt_no_cookies');
  }
  const hasSession = cookies.some(c => c.name.startsWith(CHATGPT_SESSION_COOKIE));
  if (!hasSession) {
    throw new Error('err_chatgpt_session_expired');
  }

  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const commonHeaders = {
    'Cookie': cookieStr,
    'Referer': 'https://chatgpt.com/',
    'Origin': 'https://chatgpt.com',
  };

  // Step 1: Get Bearer token via session endpoint
  //
  // 🔴 A REJECTED FETCH IS ITS OWN FAILURE, NOT "collection failed". `fetch` rejects when the
  // request got no answer — offline, DNS, TLS, a proxy or security product refusing the connection,
  // another extension cancelling it.
  // 🪤 NOT ONLY CONNECTIVITY, which is why the copy is worded as troubleshooting rather than as a
  // diagnosis: `fetch` also rejects on invalid request options — a malformed Authorization header
  // built from a bad `accessToken` is refused before anything is sent (Codex 후속). "Check your
  // network or security software" is a reasonable first thing to try; it is not a claim about cause.
  // That message does not start with `err_`, so it
  // fell through every mapping below and became the catch-all. Measured 2026-09-12: 365 accounts on
  // v1.29.74 had `err_chatgpt_collect_failed` as their ONLY signal, none of them with a single
  // successful ChatGPT snapshot — this is the largest candidate for that mass. Claude already
  // splits it (`err_claude_network`, bg/api.js:184); ChatGPT did not. (#1415-adjacent, #1417 계열)
  let sessionResp;
  try {
    sessionResp = await fetch(`${CHATGPT_API_BASE}/api/auth/session`, {
      headers: { ...commonHeaders, 'Accept': 'application/json' },
      cache: 'no-store',
    });
  } catch (e) {
    console.debug(`[Claude Tuner] ChatGPT cookie session fetch rejected: ${e && e.message}`);
    throw new Error('err_chatgpt_network');
  }
  if (!sessionResp.ok) {
    if (sessionResp.status === 403) throw new Error('err_chatgpt_cloudflare');
    throw new Error('err_chatgpt_session_expired');
  }
  const session = await sessionResp.json();
  if (!session?.accessToken) {
    throw new Error('err_chatgpt_session_expired');
  }

  // Step 2: Call actual API with Bearer token
  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        ...commonHeaders,
        'Authorization': 'Bearer ' + session.accessToken,
        'Accept': 'application/json',
      },
      cache: 'no-store',
    });
  } catch (e) {
    console.debug(`[Claude Tuner] ChatGPT cookie api fetch rejected: ${e && e.message}`);
    throw new Error('err_chatgpt_network');
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (resp.status === 403) throw new Error('err_chatgpt_cloudflare');
    if (resp.status === 401) throw new Error('err_chatgpt_session_expired');
    if (resp.status === 429) throw new Error('err_chatgpt_rate_limit');
    throw new Error(`ChatGPT API error (${resp.status}): ${text.slice(0, 500)}`);
  }

  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return resp.json();
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

// === Check if user is logged into ChatGPT ===
// Two independent signals, EITHER of which counts as "plausibly logged in":
//   1. the session cookie is enumerable via chrome.cookies.getAll, OR
//   2. a chatgpt.com tab is open.
// The cookie (`__Secure-` prefixed, httpOnly) is not always enumerable in every
// Chromium build/profile — some browsers (e.g. Dia) intermittently return an empty
// set for it, which made this pre-check a false negative that silently aborted
// collection (collectChatGPT returns early with no log) even though the in-page
// tab fetch could read usage fine. This is only a cheap PRE-CHECK: the actual auth
// is validated authoritatively by the subsequent /api/auth/session fetch (tab path
// preferred, cookie path as fallback), so a genuinely logged-out session still
// yields no snapshot. Treating an open tab as a positive signal keeps collection
// working whenever the page itself can authenticate, regardless of cookie visibility.
export async function isChatGPTLoggedIn() {
  try {
    const cookies = await chrome.cookies.getAll({ url: 'https://chatgpt.com' });
    if (cookies.some(c => c.name.startsWith(CHATGPT_SESSION_COOKIE))) return true;
  } catch {
    // cookie enumeration unavailable — fall through to the tab signal
  }
  try {
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    return tabs.length > 0;
  } catch {
    return false;
  }
}
