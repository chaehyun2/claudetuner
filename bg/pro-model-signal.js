// ChatGPT Pro-model use signal (#2332 U8, step 1) — whether the member picks the models only a Pro plan
// offers, the evidence an automatic Pro → Plus downgrade must respect. The parsing (two booleans, never a
// model name) is parseChatGPTProModelSignal in bg/parse-chatgpt.js.
//
// Read at most once a day — the setting changes rarely and the server keeps one row per account per day —
// and sent on its own route (PUT /api/users/chatgpt-model-signal), not on the snapshot: the snapshot row
// is mirrored to two stores by position, and this is not usage. A failed read or a non-2xx answer is
// retried after an hour; nothing is cached but the send time.
//
// Filed under the ingest identity, like the training setting: settings/user answers for the chatgpt.com
// session, which is the account this cycle's snapshot is collected from. 🔴 Only while it still IS that
// account: the caller's /wham/usage id is compared again AFTER the settings read, so a ChatGPT login switch
// mid-read cannot file account B's signal under A's token (Codex 1R — same rule as bg/training.js).
import { fetchChatGPTApi } from './api-chatgpt.js';
import { parseChatGPTProModelSignal, CHATGPT_USAGE_PATH, chatgptUsageAccountId } from './parse-chatgpt.js';
import { authedFetch, getConfig } from './storage.js';
import { sendableIdentity, withTimeout } from './vat.js';

const CHATGPT_USER_SETTINGS_PATH = '/backend-api/settings/user';
const SIGNAL_SEND_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SIGNAL_RETRY_MS = 60 * 60 * 1000;
const SENT_KEY = 'cgProModelSignalSent';   // { email, ok, ts }

// Log a code only — a provider error message can carry part of the response body.
function errCode(e) {
  const m = typeof e?.message === 'string' ? e.message : '';
  return /^(err_|vat_|signal_)[a-z0-9_]+$/.test(m) ? m : 'error';
}

/** Whether a send is due for `email` given the stored marker. Pure. */
export function proModelSignalDue(sent, email, nowMs) {
  if (!sent || sent.email !== email) return true;
  return nowMs - (sent.ts || 0) >= (sent.ok ? SIGNAL_SEND_INTERVAL_MS : SIGNAL_RETRY_MS);
}

async function markSent(email, ok) {
  await chrome.storage.local.set({ [SENT_KEY]: { email, ok, ts: Date.now() } });
}

/** bg/collect-chatgpt.js. Checks the send conditions and the daily cadence BEFORE reading — a blocked,
 * paused or already-sent install does not touch the settings endpoint. Never throws. */
export async function syncChatGPTProModelSignal(activeUsageAccountId, ingestEmail) {
  try {
    const email = await sendableIdentity(ingestEmail);
    // No usable account id = the switch check below cannot tell two accounts apart ('unknown' on both
    // sides would match — Codex 2R): nothing is read or sent.
    if (!email || !activeUsageAccountId || activeUsageAccountId === 'unknown') return;
    const { [SENT_KEY]: sent } = await chrome.storage.local.get(SENT_KEY);
    if (!proModelSignalDue(sent, email, Date.now())) return;
    const config = await getConfig();
    if (!config?.serverUrl) return;
    // Claimed BEFORE the read: two overlapping cycles must not both read and send (Codex 1R). A send that
    // succeeds overwrites this with ok:true; anything else leaves the one-hour retry.
    await markSent(email, false);
    let signal;
    try {
      signal = parseChatGPTProModelSignal(await withTimeout(fetchChatGPTApi(CHATGPT_USER_SETTINGS_PATH)));
      if (signal) {
        const after = await withTimeout(fetchChatGPTApi(CHATGPT_USAGE_PATH));
        if (chatgptUsageAccountId(after) !== activeUsageAccountId) signal = undefined;   // session changed mid-read
      }
    } catch (e) {
      console.warn('[Claude Tuner] Pro model signal read failed (non-critical):', errCode(e));
    }
    if (!signal) return;   // failed / unreadable / switched read → retry in an hour
    // The value was read under `email`; authedFetch sends nothing if the token it attaches is another account's.
    const resp = await authedFetch(config, `${config.serverUrl}/api/users/chatgpt-model-signal`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'chatgpt', ...signal }),
    }, { requireTokenEmail: email });
    if (!resp) return;
    if (resp.ok) await markSent(email, true);
  } catch (e) {
    console.warn('[Claude Tuner] Pro model signal sync skipped:', errCode(e));
  }
}
