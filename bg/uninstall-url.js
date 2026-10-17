// The uninstall-survey URL (#2427). ONE builder for every writer so the parameters cannot drift:
//  - the synced collect path passes email/plan (the server already holds them for this install);
//  - the local-only (withheld) collect path passes NEITHER — a gated install has not been allowed
//    to send its identity to the server, and an uninstall-page hit must not be the exception;
//  - both carry the what's-new arm and the instant it was drawn (`wn`/`wnd`), so the holdout's
//    uninstall rate is measurable (worker utils/uninstall-wn.ts parses them strictly).
// Before this, only the synced path set a URL at all — a withheld install's uninstall was never
// recorded (30 days of uninstalls: every row had an email).
import { DEFAULT_SERVER_URL } from './constants.js';
import { WN_ARM_KEY, WN_ARM_AT_KEY, WN_ARMS } from './whats-new.js';

const MS_PER_DAY = 86400000;

// 'YYYY-MM-DDTHH:MM:SSZ' — the one shape the worker accepts.
export function wnInstant(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 19)}Z` : null;
}

// Pure, so the guard runs it. `installDate` (ms) may be null → days 0, as before.
export function buildUninstallQuery({ email, plan, version, installDate, lang, wnArm, wnArmAt, now }) {
  const p = new URLSearchParams();
  if (email) p.set('email', email);
  if (plan) p.set('plan', plan);
  p.set('v', version || '');
  p.set('days', String(typeof installDate === 'number' && Number.isFinite(installDate)
    ? Math.max(0, Math.floor((now - installDate) / MS_PER_DAY)) : 0));
  if (lang) p.set('lang', lang);
  if (wnArm === WN_ARMS.SHOW || wnArm === WN_ARMS.HOLDOUT) {
    p.set('wn', wnArm);
    const at = wnInstant(wnArmAt);
    if (at) p.set('wnd', at);
  }
  return p;
}

// Thin chrome wrapper. Never throws — it rides the collect path.
export async function setUninstallUrl({ email = null, plan = null, lang = null, installDate = null } = {}) {
  try {
    const s = await chrome.storage.local.get([WN_ARM_KEY, WN_ARM_AT_KEY, 'ct_install_date', 'installFirstSeenAt']);
    const firstSeen = Date.parse(s.installFirstSeenAt || '');
    const q = buildUninstallQuery({
      email, plan, lang,
      version: chrome.runtime.getManifest().version,
      installDate: installDate ?? s.ct_install_date ?? (Number.isFinite(firstSeen) ? firstSeen : null),
      wnArm: s[WN_ARM_KEY], wnArmAt: s[WN_ARM_AT_KEY], now: Date.now(),
    });
    chrome.runtime.setUninstallURL(`${DEFAULT_SERVER_URL}/api/uninstall?${q}`);
  } catch { /* best-effort */ }
}
