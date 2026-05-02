// 페이지의 MAIN world에서 실행 (document_start)
// window.fetch를 통해 호출하여 페이지의 인증 인터셉터를 거침
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

      // JSON 아닌 응답 처리 (예: 204 No Content)
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
