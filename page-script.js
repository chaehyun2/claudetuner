// Runs in the page's MAIN world (document_start)
// Uses window.fetch to go through the page's auth interceptors
if (!window.__claudeTunerBridge) {
  window.__claudeTunerBridge = true;

  window.addEventListener('__claude_tuner_req__', async (event) => {
    const { id, url, method, body, headers } = event.detail;
    try {
      const opts = {
        method: method || 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json', ...(headers || {}) },
      };
      if (body && method && method !== 'GET') {
        opts.body = typeof body === 'string' ? body : JSON.stringify(body);
      }

      const resp = await window.fetch(url, opts);

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        window.dispatchEvent(new CustomEvent('__claude_tuner_res__', {
          detail: { id, _err: true, status: resp.status, body: text.slice(0, 500) },
        }));
        return;
      }

      // Handle non-JSON responses (e.g., 204 No Content)
      const contentType = resp.headers.get('content-type') || '';
      let data;
      if (contentType.includes('application/json')) {
        data = await resp.json();
      } else {
        const text = await resp.text();
        try { data = JSON.parse(text); } catch { data = { _raw: text, status: resp.status }; }
      }

      window.dispatchEvent(new CustomEvent('__claude_tuner_res__', {
        detail: { id, _err: false, data },
      }));
    } catch (e) {
      window.dispatchEvent(new CustomEvent('__claude_tuner_res__', {
        detail: { id, _err: true, status: 0, message: e.message },
      }));
    }
  });
}
