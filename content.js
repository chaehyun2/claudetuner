// Content Script (ISOLATED world): background.js ↔ page-script.js 메시지 중계
// page-script.js는 manifest에서 world: MAIN으로 직접 주입됨

let reqId = 0;
const pending = new Map();

// page-script.js로부터 응답 수신
window.addEventListener('__claude_tuner_res__', (event) => {
  const { id, ...result } = event.detail;
  const resolve = pending.get(id);
  if (resolve) {
    pending.delete(id);
    resolve(result);
  }
});

// background.js로부터 요청 수신 → page-script.js로 전달
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'FETCH_CLAUDE_API') {
    const id = ++reqId;

    const timeout = setTimeout(() => {
      pending.delete(id);
      sendResponse({ _err: true, status: 0, message: 'Request timeout' });
    }, 15000);

    pending.set(id, (result) => {
      clearTimeout(timeout);
      sendResponse(result);
    });

    window.dispatchEvent(
      new CustomEvent('__claude_tuner_req__', {
        detail: { id, url: message.url, method: message.method, body: message.body, headers: message.headers },
      })
    );

    return true;
  }
});
