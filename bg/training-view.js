// What the popup's privacy row should say about ChatGPT's 「모델 개선을 위한 데이터 학습 허용」 (#1889) — pure.
// No chrome.*, no DOM, no Date.now(). The cache is written by bg/training.js (service worker); the popup
// reads it here so the storage shape is parsed in ONE place, without pulling the collector's imports into
// the popup.
//
// Cache shape (bg/training.js): { "<usageAccountId>|<planType>": { result, ok, ts } }, only the current
// account's entry kept; result = { allowed, orgUuid } | null (no personal account) | 'undecidable'.

export const TRAINING_CACHE_KEY_CHATGPT = 'trainingCacheChatgpt';

/**
 * The setting as it applies to ONE displayed ChatGPT org.
 * @returns {'on'|'off'|null}
 *   'on'  — the setting is ON and was read for exactly this org (the personal account) → show the row.
 *   'off' — the account's setting was read as OFF (it is account-level) → re-arm the dismiss.
 *   null  — nothing to say for this org (other workspace, undecidable, no personal account, no read).
 */
export function chatgptTrainingStateFor(cache, orgUuid) {
  if (!cache || typeof cache !== 'object') return null;
  let off = false;
  for (const entry of Object.values(cache)) {
    const r = entry?.result;
    if (!r || typeof r !== 'object') continue;              // null / 'undecidable' / never read
    if (r.allowed === true && orgUuid && r.orgUuid === orgUuid) return 'on';
    if (r.allowed === false) off = true;
  }
  return off ? 'off' : null;
}
