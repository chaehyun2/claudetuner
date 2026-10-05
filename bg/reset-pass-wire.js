// When to attach per-pass detail to an outbound snapshot (#2092 P3) — the stateful half of
// bg/reset-pass-payload.js, which stays import-free and pure.
//
// Attached at the moment a snapshot is POSTed (after the send gate), and recorded as SENT only
// when the SERVER says it stored it: `commit(responseBody)` checks `reset_pass_stored === true`.
// A gate-skipped snapshot, a POST withheld by postSnapshot's own gates (pause, auth block), a
// failed POST, and a 2xx that did not store (shared-key identity, `skip_org`) all leave the mark
// untouched, so the next send carries the detail again (Codex P3 1R/2R).
import { addResetPassTickets, resetPassDetailDue, resetPassDetailSig } from './reset-pass-payload.js';

const SENT_KEY = 'resetPassDetailSent'; // { "<ingest email>|<provider>|<org uuid>": { sig, at } }
const NOOP = async () => {};

/**
 * Attach `tickets` to `payload.reset_pass` when the holdings changed or the daily refresh is due.
 * Mutates `payload`; returns `commit(responseBody)` for the caller to hand the server's reply
 * (a no-op when nothing was attached, or when the reply does not confirm the store). Never throws — the summary-only payload is always a valid send.
 *
 * Keyed by the IDENTITY the snapshot is sent under as well as provider + org: the server stores
 * per account, so a mark left by account A must not suppress account B's first detail (Codex 1R).
 */
export async function attachResetPassDetail(payload, summary, nowMs = Date.now()) {
  try {
    if (!payload || !payload.reset_pass) return NOOP;
    const sig = resetPassDetailSig(summary);
    if (!sig) return NOOP;
    const id = `${payload.user_email || ''}|${payload.provider || 'claude'}|${payload.claude_org_uuid || ''}`;
    const { [SENT_KEY]: sent = {} } = await chrome.storage.local.get(SENT_KEY);
    if (!resetPassDetailDue(sig, sent[id], nowMs)) return NOOP;
    addResetPassTickets(payload.reset_pass, summary);
    return async (reply) => {
      if (!reply || reply.reset_pass_stored !== true) return;
      try {
        const { [SENT_KEY]: cur = {} } = await chrome.storage.local.get(SENT_KEY);
        await chrome.storage.local.set({ [SENT_KEY]: { ...cur, [id]: { sig, at: nowMs } } });
      } catch { /* the next send re-attaches */ }
    };
  } catch (e) {
    console.warn('[Claude Tuner] reset-pass detail skipped:', e && e.message);
    return NOOP;
  }
}
