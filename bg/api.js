import { CLAUDE_API_BASE } from './constants.js';

// === resets_at 정규화 (분 단위 반올림) ===
// Claude API가 59.xxx초 / 00.xxx초를 랜덤하게 반환하므로 같은 윈도우 비교가 깨짐
// 30초 이상이면 다음 분으로 올림, 서브초 제거
export function normalizeResetTime(t) {
  if (!t) return null;
  const d = new Date(t);
  if (isNaN(d.getTime())) return t;
  if (d.getUTCSeconds() >= 30) d.setUTCMinutes(d.getUTCMinutes() + 1);
  d.setUTCSeconds(0, 0);
  return d.toISOString().slice(0, 19) + '+00:00';
}

// === Claude.ai API 호출 헬퍼 (하이브리드: 탭 우선 → 쿠키 폴백) ===
export async function fetchClaudeApi(path, options = {}) {
  const fullUrl = `${CLAUDE_API_BASE}${path}`;

  // 1차: 탭 기반 (가장 안정적 — Cloudflare 우회됨)
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  let tabErrorMsg = '';

  if (tabs.length > 0) {
    try {
      return await fetchViaTab(tabs[0].id, fullUrl, options);
    } catch (tabError) {
      tabErrorMsg = tabError.message;
      console.warn('[Claude Tuner] Tab fetch failed, trying cookie fallback:', tabErrorMsg);
    }
  } else {
    tabErrorMsg = 'claude.ai 탭 없음';
    console.log('[Claude Tuner] No Claude.ai tab, using cookie fallback');
  }

  // 2차: 쿠키 기반 직접 호출
  try {
    const data = await fetchWithCookies(fullUrl, options);
    console.log(`[Claude Tuner] Cookie fallback succeeded for ${path}`);
    return data;
  } catch (cookieError) {
    const isRateLimit = tabErrorMsg.includes('err_rate_limit') || cookieError.message.includes('err_rate_limit');
    if (isRateLimit) {
      throw new Error('err_rate_limit');
    }
    // 쿠키 에러가 i18n 키이면 그대로 전파
    if (cookieError.message.startsWith('err_')) {
      throw cookieError;
    }
    throw new Error('err_collect_failed');
  }
}

// --- 탭 기반 호출 (executeScript 직접 실행 — content script 중계 불필요) ---
export async function fetchViaTab(tabId, fullUrl, options) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (url, method, body, headers) => {
      try {
        const opts = {
          method: method || 'GET',
          credentials: 'include',
          headers: { 'Accept': 'application/json', ...(headers || {}) },
        };
        if (body && method && method !== 'GET') {
          opts.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        const resp = await fetch(url, opts);
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          return { _err: true, status: resp.status, body: text.slice(0, 500) };
        }
        const ct = resp.headers.get('content-type') || '';
        let data;
        if (ct.includes('application/json')) {
          data = await resp.json();
        } else {
          const text = await resp.text();
          try { data = JSON.parse(text); } catch { data = { _raw: text, status: resp.status }; }
        }
        return { _err: false, data };
      } catch (e) {
        return { _err: true, status: 0, message: e.message };
      }
    },
    args: [fullUrl, options.method || 'GET', options.body || null, options.headers || {}],
  });

  const result = results?.[0]?.result;
  if (!result || result._err) {
    const status = result?.status || 'unknown';
    const body = result?.body || '';
    const msgText = result?.message || '';
    if (!options.quiet) {
      console.debug(`[Claude Tuner] Tab API fallback: url=${fullUrl}, status=${status}, message=${msgText}`);
    }

    if (status === 401 || status === 403) {
      throw new Error(`err_auth_failed:${status}`);
    }
    if (status === 429) {
      throw new Error('err_rate_limit');
    }
    throw new Error(msgText || `Claude API error (${status}): ${body}`);
  }

  return result.data;
}

// --- 쿠키 기반 직접 호출 (탭 없을 때 폴백) ---
export async function fetchWithCookies(url, options = {}) {
  const cookies = await chrome.cookies.getAll({ url: 'https://claude.ai' });
  if (!cookies.length) {
    throw new Error('err_no_cookies');
  }
  if (!cookies.some((c) => c.name === 'sessionKey')) {
    throw new Error('err_session_expired');
  }

  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const method = options.method || 'GET';
  const headers = {
    'Accept': 'application/json',
    'Cookie': cookieStr,
    'Referer': 'https://claude.ai/',
    'Origin': 'https://claude.ai',
    ...(options.headers || {}),
  };
  if (method !== 'GET' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const fetchOpts = { method, headers };
  if (options.body && method !== 'GET') {
    fetchOpts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }

  const resp = await fetch(url, fetchOpts);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (resp.status === 403) {
      throw new Error('err_cloudflare');
    }
    if (resp.status === 401) {
      throw new Error('err_session_expired');
    }
    if (resp.status === 429) {
      throw new Error('err_rate_limit');
    }
    throw new Error(`Claude API error (${resp.status}): ${text.slice(0, 500)}`);
  }

  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return resp.json();
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}
