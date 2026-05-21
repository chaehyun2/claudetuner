import { CHATGPT_API_BASE, CHATGPT_SESSION_COOKIE } from './constants.js';

// === ChatGPT API call helper (hybrid: tab-first, cookie fallback) ===
// ChatGPT requires Authorization: Bearer <JWT> — obtained via /api/auth/session
export async function fetchChatGPTApi(path, options = {}) {
  const fullUrl = `${CHATGPT_API_BASE}${path}`;

  // Primary: tab-based (most reliable — runs in page context with full auth)
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  let tabErrorMsg = '';

  if (tabs.length > 0) {
    try {
      return await fetchChatGPTViaTab(tabs[0].id, fullUrl);
    } catch (tabError) {
      tabErrorMsg = tabError.message;
      console.warn('[Claude Tuner] ChatGPT tab fetch failed, trying cookie fallback:', tabErrorMsg);
    }
  } else {
    tabErrorMsg = 'No chatgpt.com tab';
    console.log('[Claude Tuner] No ChatGPT tab, using cookie fallback');
  }

  // Fallback: cookie-based direct call
  try {
    return await fetchChatGPTWithCookies(fullUrl);
  } catch (cookieError) {
    if (cookieError.message.startsWith('err_')) {
      throw cookieError;
    }
    throw new Error('err_chatgpt_collect_failed');
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
        const sessionResp = await fetch('/api/auth/session', { credentials: 'include' });
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
    throw new Error(msg || `ChatGPT API error (${status})`);
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
  const sessionResp = await fetch(`${CHATGPT_API_BASE}/api/auth/session`, {
    headers: { ...commonHeaders, 'Accept': 'application/json' },
  });
  if (!sessionResp.ok) {
    if (sessionResp.status === 403) throw new Error('err_chatgpt_cloudflare');
    throw new Error('err_chatgpt_session_expired');
  }
  const session = await sessionResp.json();
  if (!session?.accessToken) {
    throw new Error('err_chatgpt_session_expired');
  }

  // Step 2: Call actual API with Bearer token
  const resp = await fetch(url, {
    headers: {
      ...commonHeaders,
      'Authorization': 'Bearer ' + session.accessToken,
      'Accept': 'application/json',
    },
  });

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
export async function isChatGPTLoggedIn() {
  try {
    const cookies = await chrome.cookies.getAll({ url: 'https://chatgpt.com' });
    return cookies.some(c => c.name.startsWith(CHATGPT_SESSION_COOKIE));
  } catch {
    return false;
  }
}
