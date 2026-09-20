// The 3-org-cap banner (#capdrop-banner): read storage → decide what to say → paint. Everything
// popup.js's checkCapDrops() used to do inline, moved behind a factory so a guard can EXECUTE it
// with a storage stub and a mini DOM instead of pattern-matching popup.js (#1416: Codex reverted
// popup.js to the parent commit, kept the pure helper and its guard, and the guard stayed green
// with the user-visible bug back — the text axis checks the formatting you wrote, not the code).
//
// What the banner SAYS is still decided by bg/capdrop-view.js (pure, its own invariant and guard,
// #1408); this module owns the two things around it — the read, with its stale-read sequence,
// and the paint, with the dismissal's hide-first ordering — and does NOT touch that helper.
//
// TONE (#1419). A cap drop is not a fault: the server accepted the POST and stored nothing
// because the org is outside the 3 active orgs the user chose. It sat directly under
// #prov-err-banner ("ChatGPT could not be collected — open a tab") as an identical amber block,
// and a user with a real failure read the two as one story and chased the wrong one (문의
// 2026-09-11). The DOM order was already right (popup.html: actionable above, informational
// below); what was missing was the WEIGHT. This banner paints itself `perm-banner-info` — a
// neutral surface, no amber — and its copy says outright that nothing is broken.

import { buildCapDropView } from '../bg/capdrop-view.js';
import { CAP_DROP_KEY } from '../bg/constants.js';

export { CAP_DROP_KEY };
// The drop SET the user last waved away (#1408). Popup-only — written and read here and nowhere
// else — so unlike CAP_DROP_KEY it crosses no runtime boundary and needs no drift guard.
export const CAP_DROP_ACK_KEY = '_ct_cap_drop_ack';
// The tone class (#1419): informational, one step below .perm-banner's "action needed" amber.
export const CAPDROP_INFO_CLASS = 'perm-banner-info';
export const CAPDROP_SETTINGS_URL = 'https://claudetuner.com/dashboard/settings/#active-orgs-card';

/**
 * storage.local → what the view needs. A storage hiccup reads as "nothing dropped" — the banner
 * stays quiet rather than guessing.
 */
export async function readCapDropState(storage) {
  let orgs = [];
  let collectedOrgs = [];
  let ackSig = '';
  try {
    const stored = await storage.get({ [CAP_DROP_KEY]: null, [CAP_DROP_ACK_KEY]: null, collectedOrgs: [] });
    const cur = stored && stored[CAP_DROP_KEY];
    if (cur && Array.isArray(cur.orgs)) orgs = cur.orgs.filter(Boolean);
    // 🔑 The org NAMES live here. A dropped org is present in this list because the collect loop
    // records it "regardless of server POST result" (bg/collect.js) — the drop happens on the
    // server, after the client already knew the org.
    if (Array.isArray(stored?.collectedOrgs)) collectedOrgs = stored.collectedOrgs;
    const ack = stored && stored[CAP_DROP_ACK_KEY];
    if (ack && typeof ack.sig === 'string') ackSig = ack.sig;
  } catch { /* storage hiccup → treat as "nothing dropped" and stay quiet */ }
  return { orgs, collectedOrgs, ackSig };
}

/**
 * @param {object} deps
 * @param {{get: Function, set: Function}} deps.storage  chrome.storage.local (or a stub)
 * @param {Document} deps.doc
 * @param {(key: string, ...args: any[]) => string} deps.t
 * @param {Record<string, string>} deps.labels  PROVIDER_LABELS
 * @param {(url: string) => void} deps.openUrl  chrome.tabs.create({url}) in the popup
 * @param {string} [deps.bannerId]
 */
export function createCapDropBanner({ storage, doc, t, labels, openUrl, bannerId = 'capdrop-banner' }) {
  // 🔴 ONLY THE NEWEST READ MAY PAINT — the same rule the provider-error banner follows, and for a
  // sharper reason here: this check is re-run by a storage listener, so several reads are often in
  // flight at once, and the dismissal below bumps the sequence so a read that started before the
  // click cannot finish after it and reopen the banner.
  let seq = 0;
  // The in-memory copy of the last acknowledgement: the fallback for a write that did not land.
  // Read AFTER storage, and used only when storage has none — storage is the durable answer.
  let ackMemory = '';

  function paint(banner, view) {
    while (banner.firstChild) banner.removeChild(banner.firstChild);
    // 🪤 No `|| 'fallback'` on these t() calls. It reads like a safety net and is not one: t()
    // returns the KEY itself when a translation is missing (i18n.js), which is truthy, so the
    // right-hand side is unreachable. (Codex round 2, #1408.)
    let text;
    if (view.mode === 'count') {
      text = t('capdrop_banner_text_count', view.count);
    } else {
      const more = view.extra > 0 ? ' ' + t('capdrop_banner_more', view.extra) : '';
      text = t('capdrop_banner_text', view.names.join(', ') + more);
    }
    banner.appendChild(doc.createTextNode(text));

    const btn = doc.createElement('button');
    btn.textContent = t('capdrop_banner_btn');
    btn.addEventListener('click', () => openUrl(CAPDROP_SETTINGS_URL));
    banner.appendChild(btn);

    // 🔴 THE ESCAPE HATCH, AND WHY IT HAS TO EXIST. Self-clearing (applyCapDrop) needs a non-drop
    // 200 for the same stream — but the client keeps posting orgs it knows will be dropped (#855)
    // and the server keeps dropping them (#1180), so a full cap re-records the entry every cycle.
    // Without this the banner is permanent, and "Choose orgs" is not a way out: with the cap full,
    // choosing a different org only moves the drop.
    const dismiss = doc.createElement('button');
    dismiss.className = 'prov-err-dismiss';
    dismiss.textContent = t('capdrop_banner_dismiss');
    dismiss.title = t('capdrop_banner_dismiss_title');
    dismiss.addEventListener('click', async () => {
      // 🔴 HIDE FIRST, PERSIST SECOND — the order is the fix, not an optimisation.
      // Awaiting the write before hiding meant the hide landed on whatever the banner had become
      // by then: Codex reproduced render{A} → click → rerender{A,B} → write resolves → the {A,B}
      // banner vanishes, having acknowledged only {A}. Hiding synchronously binds the hide to the
      // render that was actually clicked, and no DOM is touched after the await — so a later
      // render simply rebuilds and re-shows the banner on its own terms.
      // Recorded in memory BEFORE the await, and bumping the sequence retires any read already in
      // flight — otherwise a check that started before the click finishes after it and reopens the
      // banner, which is what the user just told us not to do.
      ackMemory = view.sig;
      seq++;
      banner.classList.add('hidden');
      try {
        await storage.set({ [CAP_DROP_ACK_KEY]: { sig: view.sig } });
      } catch {
        // Storage hiccup: the acknowledgement did not persist, so this dismissal lasts exactly as
        // long as the popup does — `ackMemory` holds it, and it is gone on the next open.
        // Deliberately NOT re-shown here; overriding the click the user just made is worse than a
        // dismissal that does not outlive the session.
      }
    });
    banner.appendChild(dismiss);

    // The tone is part of what the banner says, so it is set here, where a test can see it — not
    // left to the markup (#1419).
    banner.classList.add(CAPDROP_INFO_CLASS);
    banner.classList.remove('hidden');
  }

  /** Re-read storage and repaint. Resolves after the paint (or the decision not to). */
  async function check() {
    const banner = doc.getElementById(bannerId);
    if (!banner) return;
    const mine = ++seq;
    const { orgs, collectedOrgs, ackSig } = await readCapDropState(storage);
    if (mine !== seq) return;      // a newer check started while this one was reading
    // What to SAY is decided by a pure function so it can be executed by a test rather than
    // pattern-matched — see bg/capdrop-view.js for the invariant it protects.
    const view = buildCapDropView(orgs, collectedOrgs, ackSig || ackMemory, labels);
    if (!view) { banner.classList.add('hidden'); return; }
    paint(banner, view);
  }

  return { check };
}
