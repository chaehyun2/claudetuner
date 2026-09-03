// Gated-install beacon (#1122).
//
// An install held behind the login-first gate never POSTs anything, so the ~1,000 residents of
// that population are invisible to the server: we know how many installs are gated (the
// `collect_withheld` GA event, #1023) but nothing about WHO they are, what plan they are on, or
// how much they use. This module files the one report they are allowed to file.
//
// 🔴 EVERY FIELD HERE IS A CLAIM, NOT A FACT. The route takes no credentials by design (#764: the
// shared-key oracle that mints an ext_token for any email is still open, so a new authenticated
// surface would widen it), which means nothing in this payload has been verified by anybody. That
// is why the server columns carry the `claimed_` prefix and why the table may never be joined to
// `users` / `daily_usage` / `organizations`. Aggregate analysis and inbound-support lookups only —
// 🔴 never outreach.
//
// 🔴 IT MUST STOP THE MOMENT THE GATE OPENS. An install that logs in resumes normal ingest; if the
// beacon kept firing, the same install would be counted twice, once as a real user and once as a
// gated one, and every population number derived from this table would be wrong in a direction
// nobody could see. Hence the first statement of maybeSendInstallBeacon().

import { getConfig, getOrCreateInstallId, serverSyncWithheldReason } from './storage.js';

const BEACON_PATH = '/api/install-beacon';

/**
 * Pick the local record this beacon describes.
 *
 * `lastStatus.snapshot` is the Claude collector's last local collection — the richest local record
 * there is, and the one the withheld branch of bg/collect.js writes on every gated cycle. A
 * provider-only install (ChatGPT/Gemini, no Claude account) never writes it, so those fall back to
 * `collectedOrgs`, which every collector merges into regardless of whether the POST was withheld.
 *
 * 🔴 This is deliberately NOT the badge's pin rule (bg/badge.js getSelectedOrgUsage). That one
 * answers "which org does the user consider theirs", and it returns null for a Claude user with no
 * pin so the caller can fall back to the Claude snapshot. Here the Claude snapshot is the FIRST
 * choice, so reusing that rule would invert the intent. One beacon row describes one install, and
 * a multi-org install is summarised by whichever record it is actually looking at.
 */
function pickBeaconSource(lastStatus, collectedOrgs) {
  const snap = lastStatus && lastStatus.snapshot;
  if (snap) {
    return {
      // Constant, not guessed: `lastStatus.snapshot` is written only by the Claude collector.
      provider: 'claude',
      email: snap.user_email || null,
      orgUuid: snap.claude_org_uuid || null,
      orgName: snap.claude_org_name || null,
      plan: snap.plan || null,
      h5: snap.five_hour && snap.five_hour.utilization,
      d7: snap.seven_day && snap.seven_day.utilization,
      resets5h: (snap.five_hour && snap.five_hour.resets_at) || null,
      resets7d: (snap.seven_day && snap.seven_day.resets_at) || null,
      lastSeenMs: lastStatus.timestamp || null,
    };
  }
  const orgs = Array.isArray(collectedOrgs) ? collectedOrgs : [];
  const org = orgs.find((o) => o.isPrimary) || orgs[0];
  if (!org) return null;
  return {
    provider: org.provider || 'claude',
    email: org.email || null,
    orgUuid: org.uuid || null,
    orgName: org.name || null,
    plan: org.plan || null,
    h5: org.h5,
    d7: org.d7,
    resets5h: org.resetsAt5h || null,
    resets7d: org.resetsAt7d || null,
    lastSeenMs: org.updatedAt || null,
  };
}

/** Finite numbers only — a null/undefined/NaN utilization is absent, not zero. */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** ms epoch → ISO, or undefined. Never invents "now": an unknown time must stay unknown. */
function isoFromMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

/** Drop absent keys so the server stores NULL rather than a placeholder that reads as data. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

/**
 * Report this install's local state ONCE per alarm tick, without credentials.
 *
 * Best-effort by contract: the server answers 202 even when its own write fails, precisely so this
 * client stays dumb. 🔴 No retries, no backoff ladder, no error surfaced to the caller — a beacon
 * that retried would turn a server incident into a request storm from the exact population that
 * cannot be throttled by an auth failure.
 */
export async function maybeSendInstallBeacon() {
  const withheldReason = await serverSyncWithheldReason();
  if (!withheldReason) return;   // 🔴 gate open → normal ingest owns this install. Never both.

  try {
    const installId = await getOrCreateInstallId();
    if (!installId) return;      // the row's only identity; without it there is nothing to record

    const config = await getConfig();
    if (!config.serverUrl) return;

    const { lastStatus, collectedOrgs, installFirstSeenAt } = await chrome.storage.local.get({
      lastStatus: null, collectedOrgs: [], installFirstSeenAt: null,
    });
    const src = pickBeaconSource(lastStatus, collectedOrgs) || {};

    const payload = compact({
      install_id: installId,
      withheld_reason: withheldReason,
      claimed_user_email: src.email,
      claimed_org_uuid: src.orgUuid,
      claimed_org_name: src.orgName,
      plan: src.plan,
      provider: src.provider,
      five_hour_utilization: num(src.h5),
      five_hour_resets_at: src.resets5h,
      seven_day_utilization: num(src.d7),
      seven_day_resets_at: src.resets7d,
      // The version running RIGHT NOW, not the one stamped on the stored snapshot — a beacon
      // reports the client that sent it, and a stale snapshot would misattribute the fleet split.
      ext_version: chrome.runtime.getManifest().version,
      last_seen_at: isoFromMs(src.lastSeenMs),
      // Sent ONLY when the install actually recorded one, which is only true for installs created
      // on 1.29.57 or later (background.js, onInstalled 'install'). 🔴 There is deliberately no
      // fallback here — not `now()`, not the first beacon's date, not the oldest usage-history
      // point. Every install that predates this key must send NOTHING, because the NULL is the
      // signal: without it, MIN(received_at) is the only age proxy, and it dates a pre-existing
      // gated install to its adoption of this release rather than to its install. Retention and
      // conversion computed over that mixture are wrong in the way that looks right. An absent
      // value keeps the two cohorts separable; a synthesized one destroys the distinction
      // permanently and invisibly.
      first_seen_at: typeof installFirstSeenAt === 'string' ? installFirstSeenAt : undefined,
    });

    // 🔴 No credential of any kind. Plain JSON POST to a route that reads none — see the header
    // note. A guard test asserts this file carries no credential-header vocabulary at all.
    const res = await fetch(`${config.serverUrl}${BEACON_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    console.log(`[install-beacon] sent (${withheldReason}) → ${res.status}`);
  } catch (e) {
    // Swallowed on purpose: this runs inside an alarm handler shared with collection, and a throw
    // here would abort work that matters far more than telemetry.
    console.warn('[install-beacon] send failed:', e && e.message);
  }
}

/**
 * Stable 0..(period-1) minute offset for THIS install.
 *
 * 🔴 Not Math.random(). The offset has to survive service-worker restarts: a random phase would be
 * redrawn on every wake, and since a fleet-wide CWS update recreates everyone's alarms inside the
 * same short window, re-drawing collapses back toward that window instead of spreading away from
 * it. Hashing the install_id gives each install one permanent slot in the period.
 *
 * FNV-1a over the id, `>>> 0` at each step to stay in unsigned 32-bit range.
 */
export function beaconJitterMinutes(installId, periodMinutes) {
  let h = 0x811c9dc5;
  const s = String(installId || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % periodMinutes;
}
