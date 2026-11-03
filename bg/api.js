import { CLAUDE_API_BASE, SITE_TAB_PATTERNS } from './constants.js';
import { CLAUDE_SESSION_COOKIE, isUsableTab } from '../vendor-ai/sites.js';
import { normalizeResetTime } from './reset-time.js';

// normalizeResetTime moved verbatim to the pure ./reset-time.js (#2153 A0a) so bg/parse-*.js can
// load under plain Node; re-exported here so importers of './api.js' keep working unchanged.
export { normalizeResetTime };

// Accept for a binary download (any type). Built from pieces on purpose: a literal star-slash-star reads as the start of
// a block comment to the regex comment strippers our guards run over this file (test/claude-ga-reason-guard.mjs).
const ACCEPT_ANY = ['*', '/', '*'].join('');

// === Claude.ai API call helper (hybrid: tab-first, cookie fallback) ===
// options.binary = a byte cap: the body comes back as { base64, size } instead of JSON, or { tooLarge, size }
// when it is over the cap (a claude.ai `.skill` download, bg/skills-import.js).
// options.multipart = { field, base64, name, type, fields } sends a multipart form with one file built from `base64`
// (a claude.ai skill upload, bg/skills-import.js) — no JSON body and no Content-Type of ours (the form sets it).
// options.errorCode = an HTTP error throws `err_http:<status>:<code>` when claude.ai's body names an
// `error.details.error_code` (only that token — never the body text, same rule as below).
const CLAUDE_ERROR_CODE_RE = /^[a-z0-9_]{1,64}$/;

/** claude.ai's machine error code in an error body, or ''. */
export function claudeErrorCode(text) {
  try {
    const code = JSON.parse(text)?.error?.details?.error_code;
    return typeof code === 'string' && CLAUDE_ERROR_CODE_RE.test(code) ? code : '';
  } catch { return ''; }
}

function httpError(status, code) {
  if (status >= 500) return new Error(`err_server:${status}`);
  return new Error(code ? `err_http:${status}:${code}` : `err_http:${status}`);
}
/** A write pinned with `expectAccount` was not sent: claude.ai is signed in as another account (or could not say).
 *  The throws below spell it out — test/claude-ga-reason-guard.mjs reads literal codes. */
export const ERR_ACCOUNT_MISMATCH = 'err_account_mismatch';

export async function fetchClaudeApi(path, options = {}) {
  const fullUrl = `${CLAUDE_API_BASE}${path}`;

  // Primary: tab-based (most reliable — bypasses Cloudflare)
  // 🔴 A discarded/frozen tab has no document — injecting into it operates on nothing (and is the
  // package's browser-crash suspect). Only usable tabs are tried (vendor-ai `isUsableTab`, #2054);
  // none left = the fallback path, as with no tab at all.
  const tabs = (await chrome.tabs.query({ url: SITE_TAB_PATTERNS.claude })).filter(isUsableTab);
  let tabErrorMsg = '';

  if (tabs.length > 0) {
    try {
      return await fetchViaTab(tabs[0].id, fullUrl, options);
    } catch (tabError) {
      // A write tried on the tab is never retried on the cookie path: claude.ai may already have it (a 200 whose body
      // broke off reads as a network error — the retry would upload twice), and the retry's own failure (a Cloudflare
      // 403) would replace the real answer (`upload_skill_already_exists`). Codex R1-B3 · batch 1.56.14 R1-B2.
      // Every write, not only uploads: a DELETE's 404 (already removed) must reach the caller, not a retry's 403 (#2812 R1-B3).
      if (options.multipart || (options.method && options.method !== 'GET')) throw tabError;
      tabErrorMsg = tabError.message;
      console.warn('[Claude Tuner] Tab fetch failed, trying cookie fallback:', tabErrorMsg);
    }
  } else {
    tabErrorMsg = 'No claude.ai tab';
    console.log('[Claude Tuner] No Claude.ai tab, using cookie fallback');
  }

  // Fallback: cookie-based direct call. A write pinned to an account checks it first on this path too (R1-B1).
  if (options.expectAccount) {
    let who = null;
    try { who = (await fetchWithCookies(`${CLAUDE_API_BASE}/api/account`, {}))?.uuid || null; } catch (e) { who = null; }
    if (who !== options.expectAccount) throw new Error('err_account_mismatch');
  }
  try {
    const data = await fetchWithCookies(fullUrl, options);
    console.log(`[Claude Tuner] Cookie fallback succeeded for ${path}`);
    return data;
  } catch (cookieError) {
    const isRateLimit = tabErrorMsg.includes('err_rate_limit') || cookieError.message.includes('err_rate_limit');
    if (isRateLimit) {
      throw new Error('err_rate_limit');
    }
    // Propagate cookie errors that are i18n keys as-is
    if (cookieError.message.startsWith('err_')) {
      throw cookieError;
    }
    // 🔴 BOTH TRANSPORTS FAILED and the cookie path did not say why in a code we know. #1176 named
    // it instead of leaving it in the catch-all: after that issue every throw in this file carries
    // a code, so reaching here at all means something threw a shape we did not anticipate — and a
    // bucket that says so is worth more than one that says "collection failed".
    throw new Error('err_fallback_exhausted');
  }
}

// --- Tab-based call (direct executeScript — no content script relay needed) ---
export async function fetchViaTab(tabId, fullUrl, options) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (url, method, body, headers, binary, accept, multipart, expectAccount) => {
      try {
        const opts = {
          method: method || 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: { 'Accept': accept, ...(headers || {}) },
        };
        if (multipart && method && method !== 'GET') {
          // Runs in the page: the form is built here (a FormData cannot cross executeScript).
          const bin = atob(multipart.base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const form = new FormData();
          form.append(multipart.field, new File([bytes], multipart.name, { type: multipart.type }));
          for (const [k, v] of Object.entries(multipart.fields || {})) form.append(k, v);
          opts.body = form;
          // The claude.ai account, read here as the request just before the write — no background round trip or tab
          // re-pick in between (batch 1.56.15 R1-B1). Without a conditional write the race itself remains (§15-2 ⑦).
          if (expectAccount) {
            let who = null;
            try { const a = await fetch('/api/account', { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } }); who = a.ok ? (await a.json())?.uuid : null; } catch { who = null; }
            if (who !== expectAccount) return { _err: true, status: 0, accountMismatch: true };
          }
        } else if (body && method && method !== 'GET') {
          opts.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        const resp = await fetch(url, opts);
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          // The machine code is read here, from the whole body — `body` below is cut for the log.
          let code = '';
          try { code = JSON.parse(text)?.error?.details?.error_code || ''; } catch { /* not JSON */ }
          return { _err: true, status: resp.status, body: text.slice(0, 500), code: typeof code === 'string' ? code : '' };
        }
        if (binary) {
          // Runs in the page: bytesToBase64 below cannot be called from here, so the same loop is inlined.
          const declared = Number(resp.headers.get('content-length') || 0);
          if (declared > binary) return { _err: false, data: { tooLarge: true, size: declared } };   // not read at all
          const buf = new Uint8Array(await resp.arrayBuffer());
          if (buf.length > binary) return { _err: false, data: { tooLarge: true, size: buf.length } };
          let s = '';
          for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
          return { _err: false, data: { base64: btoa(s), size: buf.length } };
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
    args: [fullUrl, options.method || 'GET', options.body || null, options.headers || {}, options.binary || 0,
      options.binary ? ACCEPT_ANY : 'application/json', options.multipart || null, options.expectAccount || null],
  });

  const result = results?.[0]?.result;
  if (result && result.accountMismatch) throw new Error('err_account_mismatch');   // nothing was sent
  if (!result || result._err) {
    const status = result?.status || 'unknown';
    const body = result?.body || '';
    const msgText = result?.message || '';
    if (!options.quiet) {
      // `body` is logged here because it is no longer thrown: this line is the only place the
      // detail survives, and it stays local (console) rather than travelling to a user-facing
      // string or a GA dimension.
      console.debug(`[Claude Tuner] Tab API fallback: url=${fullUrl}, status=${status}, message=${msgText}, body=${String(body).slice(0, 300)}`);
    }

    if (status === 401 || status === 403) {
      throw new Error(`err_auth_failed:${status}`);
    }
    if (status === 429) {
      throw new Error('err_rate_limit');
    }
    // 🔴 A CODE, NOT THE BODY. This used to throw `msgText || "Claude API error (503): {…}"`, and
    // that string is what the popup SHOWS (ui/render.js translates `err_*` keys and falls through
    // to the raw text otherwise) and what the failure reason reports as (#1143). So a Claude API
    // response fragment was both user-facing copy and — before #1143 — a GA parameter value. It
    // also made the reason axis useless: 54% of Claude failures landed in the catch-all on the
    // first day it was readable (#1162). The detail is still on the console.debug line above.
    //
    // No finite status means the injected fetch itself failed (offline, DNS, TLS) — a network
    // fault, not an HTTP one, and the two need different copy: one says "check your connection",
    // the other "we will retry".
    // 🪤 TWO DIFFERENT "no status" CASES, and calling both `err_network` would be wrong. `!result`
    // means the injected script returned nothing at all (the tab navigated away, scripting was
    // denied); `result._err` with no status is the injected fetch REJECTING, which is the network
    // fault. #1176 gave the first its own code — it was sitting in the catch-all, which is exactly
    // the bucket we were trying to empty.
    if (!result) throw new Error('err_tab_no_result');
    const httpStatus = Number(status);
    if (!Number.isFinite(httpStatus)) throw new Error('err_network');
    const code = options.errorCode && CLAUDE_ERROR_CODE_RE.test(result.code || '') ? result.code : '';
    throw httpError(httpStatus, code);
  }

  return result.data;
}

/** Bytes → base64 in chunks (String.fromCharCode.apply has an argument-count limit). */
export function bytesToBase64(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** base64 → bytes. */
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- Cookie-based direct call (fallback when no tab available) ---
export async function fetchWithCookies(url, options = {}) {
  const cookies = await chrome.cookies.getAll({ url: CLAUDE_API_BASE });
  if (!cookies.length) {
    throw new Error('err_no_cookies');
  }
  if (!cookies.some((c) => c.name === CLAUDE_SESSION_COOKIE)) {
    throw new Error('err_session_expired');
  }

  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const method = options.method || 'GET';
  const headers = {
    'Accept': options.binary ? ACCEPT_ANY : 'application/json',
    'Cookie': cookieStr,
    'Referer': `${CLAUDE_API_BASE}/`,
    'Origin': CLAUDE_API_BASE,
    ...(options.headers || {}),
  };
  if (method !== 'GET' && !headers['Content-Type'] && !options.multipart) {
    headers['Content-Type'] = 'application/json';
  }

  // 🔴 `no-store` is not optional here — it is what makes this transport answer the same question
  // as the tab one (fetchViaTab sets it too). A snapshot's whole value is that it is a reading
  // taken NOW: collected_at is stamped after this call returns (bg/collect.js), so ANY stale body
  // arrives wearing a fresh timestamp and the chart goes backwards.
  //
  // What was actually observed live on 2026-09-05 is that symptom, not its mechanism: one install
  // re-posted its 2h-old 10/40/1 reading with collected_at=05:18 carrying a five_hour_resets_at of
  // 05:00 that had already expired — 7 minutes after another install of the same account had
  // correctly read the post-reset 0. The HTTP cache is one path that produces exactly that, and
  // the one this line closes; it was not proven to be the path taken. Upstream/CDN staleness is
  // not covered here, and a server-side guard is tracked separately.
  const fetchOpts = { method, headers, cache: 'no-store' };
  if (options.multipart && method !== 'GET') {
    const m = options.multipart;
    const form = new FormData();
    form.append(m.field, new File([base64ToBytes(m.base64)], m.name, { type: m.type }));
    for (const [k, v] of Object.entries(m.fields || {})) form.append(k, v);
    fetchOpts.body = form;
  } else if (options.body && method !== 'GET') {
    fetchOpts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }

  // A rejecting fetch (offline, DNS, TLS, aborted) threw a raw `TypeError: Failed to fetch`, which
  // then travelled the same two paths as the bodies above: shown to the user, and normalised to the
  // catch-all reason. It is one of the few failures the user can actually act on, so it gets its
  // own code.
  let resp;
  try {
    resp = await fetch(url, fetchOpts);
  } catch (e) {
    console.debug(`[Claude Tuner] cookie fetch failed: ${e && e.message}`);
    throw new Error('err_network');
  }

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
    // Same rule as the tab path above: a code, never `text.slice(0, 500)` of a Claude response.
    // 🔴 `text` is still READ — the await is what drains the body so the connection can be reused,
    // and dropping it would change fetch behaviour, not just logging. It is logged rather than
    // thrown so the detail survives for diagnosis without becoming user copy or a GA value.
    console.debug(`[Claude Tuner] cookie fetch ${resp.status}: ${String(text).slice(0, 300)}`);
    throw httpError(resp.status, options.errorCode ? claudeErrorCode(text) : '');
  }

  if (options.binary) {
    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared > options.binary) return { tooLarge: true, size: declared };
    const buf = new Uint8Array(await resp.arrayBuffer());
    return buf.length > options.binary ? { tooLarge: true, size: buf.length } : { base64: bytesToBase64(buf), size: buf.length };
  }
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return resp.json();
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}
