// The toolbar tooltip: one composer, one ladder, one writer.
//
// 🔴 WHY A COMPOSER AND NOT "ANOTHER setTitle CALL" (#994 unit 3). The tooltip is about to carry
// what several states want to say — an unacknowledged ★ move, a plan order in flight, a plan
// recommendation — and `chrome.action.setTitle` is a single slot with no stacking. Adding a writer
// per state reproduces, in the tooltip, the exact defect this work removed from the badge and then
// from the icon: two authorities, no ordering, and the toolbar showing whichever ran last. That
// defect is what made a user report `45⚠` as an error and cost a session to diagnose.
//
// So: every state hands its sentence to this module, the ladder here decides, and bg/badge.js
// makes exactly one call.
//
// WHY THE TOOLTIP CARRIES WHAT IT CARRIES
// ---------------------------------------
// The badge is four characters and the icon is a coloured dot — neither can say "you could drop to
// Plus and save $100/mo". The tooltip is free, holds a sentence, and takes no pixels from the
// number people installed this for. It is the only surface in the toolbar where an explanation
// fits, which is why the answer to "how do we signal X" kept being "not the badge".

/**
 * Notice kinds, most urgent first. The order mirrors bg/badge.js's icon ladder on purpose: a user
 * reading the tooltip and a user glancing at the icon must not be told about different things.
 *
 * `block` — nothing is reaching the server. Tops the ladder because the badge and icon are both
 *           already saying so; a tooltip about anything else would have the same button telling
 *           two stories (Codex DEPLOY-BLOCKER — a blocked install was offered a pending-order
 *           sentence under a red `!`).
 * `order` — the user asked for a plan change and it is in flight. Nothing to do but wait, which is
 *           why it takes neither badge nor icon (#994 unit 1) and only speaks here.
 * `pin`   — the ★ primary organization moved (#966). Already acknowledged-able from the popup.
 * `rec`   — advice. Lowest, because it is the least time-sensitive thing in the list.
 */
export const NOTICE_ORDER = ['block', 'order', 'pin', 'rec'];

/**
 * Pick the single notice to show. Null when nothing is active.
 * @param {Record<string, string|null>} notices  kind → sentence (falsy = inactive)
 */
export function pickNotice(notices) {
  for (const kind of NOTICE_ORDER) {
    const text = notices?.[kind];
    if (text) return { kind, text };
  }
  return null;
}

/**
 * Build the tooltip.
 *
 * Line 1 is the product name plus, when known, BOTH utilization windows — which is the one thing
 * the badge structurally cannot show, since it has room for a single number. Line 2 is the winning
 * notice. Both parts are optional; the name alone is a valid tooltip.
 *
 * @param {{name?: string, usage?: string|null, notices?: Record<string,string|null>}} state
 */
export function composeToolbarTitle(state) {
  // 🪤 A default parameter does not cover an explicit null — `composeToolbarTitle(null)` threw, and
  // the guard's null case had been written as `bad ?? undefined`, which quietly turned it into the
  // undefined case that the default DOES cover. Two mistakes hiding each other.
  const { name = 'Claude Tuner', usage = null, notices = null } = state || {};
  const head = usage ? `${name} — ${usage}` : name;
  const notice = pickNotice(notices);
  return notice ? `${head}\n${notice.text}` : head;
}

/**
 * The usage half of line 1, or null when there is nothing trustworthy to show.
 *
 * 🔴 Both windows or the one that exists — never a bare number. "25%" in a tooltip is the same
 * ambiguity that made `25↓` meaningless on the badge: a percentage of WHAT. The window label is
 * what makes it a sentence rather than a decoration.
 */
export function formatUsage(util5h, util7d, labels) {
  const parts = [];
  if (Number.isFinite(util7d)) parts.push(`${labels.d7} ${Math.round(util7d)}%`);
  if (Number.isFinite(util5h)) parts.push(`${labels.h5} ${Math.round(util5h)}%`);
  return parts.length ? parts.join(' · ') : null;
}
