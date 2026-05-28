/**
 * Test: Can MV3 service worker fetch gemini.google.com with credentials: 'include'
 * and have .google.com cookies (like __Secure-1PSID) automatically included?
 *
 * HOW TO RUN:
 * 1. Open chrome://extensions → Claude Tuner → "Service Worker" link
 * 2. In the DevTools console, paste the content of this file and run it
 * 3. Make sure you're logged into Google in Chrome (but Gemini tab NOT required)
 *
 * EXPECTED: If credentials: 'include' works, we should get:
 *   - Step 1: Full HTML with SNlM0e token (not a login redirect)
 *   - Step 2: Valid batchexecute response with usage data
 */
(async function testGeminiFetchWithCredentials() {
  const BASE = 'https://gemini.google.com';
  const log = (label, ...args) => console.log(`[GeminiTest] ${label}`, ...args);
  const sep = () => console.log('─'.repeat(60));
  sep();
  log('START', 'Testing service worker fetch with credentials: include');
  log('INFO', 'Close all Gemini tabs to ensure this is a pure SW test');
  sep();
  // === Step 1: Fetch page HTML to extract AT token ===
  log('STEP 1', 'Fetching gemini.google.com/app with credentials...');
  let html, atToken;
  try {
    const resp = await fetch(`${BASE}/app`, {
      credentials: 'include',
      headers: {
        'User-Agent': navigator.userAgent,
      },
    });
    log('STEP 1', `Status: ${resp.status}, Redirected: ${resp.redirected}, URL: ${resp.url}`);
    // Check if redirected to login
    if (resp.url.includes('accounts.google') || resp.url.includes('signin')) {
      log('FAIL', 'Redirected to login → cookies NOT included in fetch');
      log('INFO', 'This means credentials: include does NOT carry .google.com cookies from SW');
      return;
    }
    html = await resp.text();
    log('STEP 1', `HTML length: ${html.length} chars`);
    // Check for SNlM0e token
    const snMatch = html.match(/"SNlM0e":"([^"]+)"/);
    if (snMatch) {
      atToken = snMatch[1];
      log('PASS ✓', `SNlM0e token found (${atToken.length} chars): ${atToken.slice(0, 20)}...`);
    } else {
      log('WARN', 'SNlM0e not found in HTML');
      // Check if page loaded but token is missing
      const hasWiz = html.includes('WIZ_global_data');
      const hasApp = html.includes('gemini') || html.includes('Gemini');
      log('INFO', `Has WIZ_global_data: ${hasWiz}, Has Gemini content: ${hasApp}`);
      log('INFO', 'First 500 chars:', html.slice(0, 500));
      if (!hasWiz) {
        log('FAIL', 'Page did not load properly - likely not authenticated');
        return;
      }
    }
  } catch (e) {
    log('ERROR', 'Fetch failed:', e.message);
    return;
  }
  if (!atToken) {
    log('SKIP', 'Cannot proceed to Step 2 without AT token');
    return;
  }
  sep();
  // === Step 2: Call batchexecute with credentials ===
  log('STEP 2', 'Calling jSf9Qc RPC via batchexecute with credentials...');
  try {
    const rpcId = 'jSf9Qc';
    const innerReq = JSON.stringify([[[rpcId, '[]', null, 'generic']]]);
    const body = `f.req=${encodeURIComponent(innerReq)}&at=${encodeURIComponent(atToken)}&`;
    const url = `${BASE}/_/BardChatUi/data/batchexecute?rpcids=${rpcId}&source-path=%2Fusage&rt=c`;
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Same-Domain': '1',
      },
      body,
    });
    log('STEP 2', `Status: ${resp.status}`);
    if (!resp.ok) {
      const errBody = await resp.text();
      log('FAIL', `HTTP ${resp.status}:`, errBody.slice(0, 500));
      return;
    }
    const text = await resp.text();
    log('STEP 2', `Response length: ${text.length} chars`);
    // Parse batchexecute response
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === ")]}'") continue;
      if (/^\d+$/.test(trimmed)) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) continue;
        for (const row of parsed) {
          if (Array.isArray(row) && row[0] === 'wrb.fr' && row[1] === rpcId) {
            const data = JSON.parse(row[2]);
            log('PASS ✓', 'Usage data received!');
            log('DATA', JSON.stringify(data, null, 2));
            // Interpret
            const planId = data[0];
            const plans = { 1: 'Free', 2: 'Business', 4: 'Plus', 5: 'AI Pro' };
            log('PLAN', `${plans[planId] || `Unknown(${planId})`}`);
            if (Array.isArray(data[1])) {
              for (const w of data[1]) {
                if (!Array.isArray(w)) continue;
                const pct = w[1];
                const wType = w[2] === 1 ? '5h' : w[2] === 2 ? '7d' : `?${w[2]}`;
                log('USAGE', `${wType}: ${Math.round(pct * 100)}%`);
              }
            }
            sep();
            log('SUCCESS', 'Service worker fetch with credentials: include WORKS!');
            log('NEXT', 'Can replace chrome.cookies fallback with this approach');
            return;
          }
        }
      } catch { /* skip non-JSON lines */ }
    }
    log('WARN', 'Could not parse usage data from response');
    log('RAW', text.slice(0, 1000));
  } catch (e) {
    log('ERROR', 'batchexecute failed:', e.message);
  }
  sep();
  // === Bonus: Compare with chrome.cookies ===
  log('BONUS', 'Checking chrome.cookies.getAll for comparison...');
  try {
    const cookies = await chrome.cookies.getAll({ url: BASE });
    log('COOKIES', `Found ${cookies.length} cookies via chrome.cookies.getAll:`);
    for (const c of cookies) {
      log('  ', `${c.name} (domain: ${c.domain}, httpOnly: ${c.httpOnly})`);
    }
    const has1PSID = cookies.some(c => c.name === '__Secure-1PSID');
    log('INFO', `__Secure-1PSID via chrome.cookies: ${has1PSID ? 'FOUND' : 'NOT FOUND (expected - .google.com domain)'}`);
  } catch (e) {
    log('ERROR', 'chrome.cookies check failed:', e.message);
  }
})();