// GA4 Measurement Protocol for Chrome Extension MV3
const GA_MEASUREMENT_ID = 'G-ZMWJBD64FQ';
const GA_API_SECRET = 'emqPWfUzSqOvqvLtbh8BuQ';
const GA_ENDPOINT = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;

async function getOrCreateClientId() {
  const { ga_client_id } = await chrome.storage.local.get('ga_client_id');
  if (ga_client_id) return ga_client_id;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ ga_client_id: id });
  return id;
}

export async function sendGAEvent(name, params = {}) {
  try {
    const clientId = await getOrCreateClientId();
    await fetch(GA_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        client_id: clientId,
        events: [{ name, params }],
      }),
    });
  } catch (_) {
    // GA 실패는 무시
  }
}
