// Content Script (ISOLATED world): relays messages between background.js and page-script.js
// page-script.js is injected directly via manifest with world: MAIN

let reqId = 0;
const pending = new Map();

// Receive responses from page-script.js
window.addEventListener('__claude_tuner_res__', (event) => {
  const { id, ...result } = event.detail;
  const resolve = pending.get(id);
  if (resolve) {
    pending.delete(id);
    resolve(result);
  }
});

// Receive requests from background.js and forward to page-script.js
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
