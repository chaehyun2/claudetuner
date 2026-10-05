// Usage-limit reset pass summary → outbound snapshot field (#2092 P0b).
//
// 🔴 ZERO IMPORTS, NO chrome.* — bg/collect.js and bg/collect-chatgpt.js import it, and
// test/scoped-popup-display-guard.mjs [8] executes it under plain Node. The summary shape it reads
// is ResetPassSummary (bg/reset-pass-model.js); the count check is restated locally (one line) so
// this file stays import-free.
//
// The ONE place a summary becomes wire data. /privacy (section 2, "Usage-limit reset passes")
// promises exactly these fields and nothing else: counts, count per type, earliest expiry DAY,
// and — for Claude only — eligibility and its reason category. Service and plan already ride the
// snapshot itself (`provider` / `plan`), so they are not repeated here. Never: pass ids/keys,
// labels, org id/name, `unknown`-kind counts. Per-pass kind + expiry (`tickets`) ride only when
// resetPassDetail() says they are due (#2092 P3) — /privacy: "their type and expiry dates".
//
// Built field by field from scratch — never spread the summary — so a field added to
// ResetPassSummary later cannot reach the server by accident.

// Wire-safe shape of a provider's reason enum (a closed vocabulary is enforced server-side too).
const RESET_PASS_REASON_RE = /^[a-z_]{1,32}$/;
const RESET_PASS_REASON_OTHER = 'other';
const DAY_LEN = 10; // 'YYYY-MM-DD'

const isPassCount = (n) => Number.isInteger(n) && n >= 0;

function wireCount(n) {
  return isPassCount(n) ? n : 0;
}

function expiryDay(iso) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, DAY_LEN) : null;
}

/**
 * `{ reset_pass }` to spread into an outbound snapshot, or `{}` when there is nothing to report.
 * Sent when the summary is known, or when Claude said the account is NOT eligible (so the reason
 * distribution is observable). Pure; never throws.
 */
export function resetPassField(summary) {
  try {
    if (!summary || typeof summary !== 'object') return {};
    const claude = summary.provider === 'claude';
    const ineligible = claude && summary.eligible === false;
    if (summary.known !== true && !ineligible) return {};
    const out = {};
    if (summary.known === true) {
      const k = summary.by_kind || {};
      out.available = wireCount(summary.available);
      out.usable_now = isPassCount(summary.usable_now) ? summary.usable_now : null;
      out.by_kind = { full: wireCount(k.full), five_hour: wireCount(k.five_hour), weekly: wireCount(k.weekly) };
      out.next_expires_day = expiryDay(summary.next_expires_at);
    }
    if (claude && typeof summary.eligible === 'boolean') {
      out.eligible = summary.eligible;
      if (!summary.eligible) {
        const r = summary.ineligible_reason;
        out.ineligible_reason = typeof r === 'string' && RESET_PASS_REASON_RE.test(r) ? r : RESET_PASS_REASON_OTHER;
      }
    }
    return { reset_pass: out };
  } catch {
    return {};
  }
}

// ── Per-pass detail (#2092 P3) ──────────────────────────────────────────────────────────────────
// The server keeps each account's latest holdings (worker services/reset-pass-state.ts) for the
// mobile widget and the dashboards. Passes change a few times a month, so the detail rides a
// snapshot only when the holdings CHANGED or once a day — never on every POST.

/** Re-send unchanged holdings this often, so the server's copy is refreshed and self-heals. */
export const RESET_PASS_DETAIL_REFRESH_MS = 24 * 60 * 60 * 1000;
const TICKET_KINDS = new Set(['full', 'five_hour', 'weekly']);

/** Kind + expiry per held pass, nothing else (no id/key/label). */
function wireTickets(tickets) {
  return (Array.isArray(tickets) ? tickets : [])
    .filter((x) => x && TICKET_KINDS.has(x.kind) && typeof x.expires_at === 'string')
    .map((x) => ({ kind: x.kind, expires_at: x.expires_at }));
}

/**
 * Identity of the holdings worth storing, or null when there is nothing to store yet: unknown, or
 * held passes whose kinds are not read yet (ChatGPT before its detail GET — storing count-only
 * would overwrite good tickets with none). Zero held is a real state and IS stored (it clears the
 * server's copy after the last pass is used or expires).
 */
export function resetPassDetailSig(summary) {
  try {
    if (!summary || summary.known !== true || !isPassCount(summary.available)) return null;
    if (summary.available > 0 && summary.kinds_known !== true) return null;
    const k = summary.by_kind || {};
    return JSON.stringify([
      summary.available, isPassCount(summary.usable_now) ? summary.usable_now : null,
      wireCount(k.full), wireCount(k.five_hour), wireCount(k.weekly),
      wireTickets(summary.tickets).map((x) => `${x.kind}@${x.expires_at}`),
    ]);
  } catch {
    return null;
  }
}

/** Is the detail due? `prev` = { sig, at } recorded the last time it was attached. */
export function resetPassDetailDue(sig, prev, nowMs) {
  if (!sig) return false;
  if (!prev || prev.sig !== sig || !Number.isFinite(prev.at)) return true;
  return nowMs - prev.at >= RESET_PASS_DETAIL_REFRESH_MS || nowMs < prev.at;
}

/** Add `tickets` to an outbound `reset_pass` object in place. */
export function addResetPassTickets(resetPass, summary) {
  if (resetPass && typeof resetPass === 'object') resetPass.tickets = wireTickets(summary && summary.tickets);
}
