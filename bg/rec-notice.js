// Whether the toolbar should be showing a "there is a recommendation" marker right now.
//
// 🔴 WHY THIS IS TRANSIENT AND NOT A STATE LIGHT (#994 unit 2). A corner dot on an extension icon
// is read, by everyone, as "there is something new you have not seen" — that is what OSes and apps
// have trained. A plan recommendation is the opposite of new: it is computed from usage patterns
// and persists for days or weeks, unchanged. A permanent dot for a persistent condition has two
// endings, and both lose the signal: the user habituates and stops seeing it, or it just annoys.
//
// So the marker follows the notification contract it borrows its shape from: it appears when the
// recommendation is NEW OR CHANGED, and it goes away once the user has looked. Same pattern #984
// used for the ★-move notice, for the same reason — dismissal is stored against the identity of
// the thing dismissed, so the NEXT one can still speak.
//
// The badge is untouched by any of this. It keeps showing the percentage, which is what people
// installed this for; the recommendation's actual content lives in the popup card, and (unit 3)
// a sentence in the tooltip.

/** Storage key holding the identity of the recommendation the user has already seen. */
export const REC_SEEN_KEY = '_recSeen';

/**
 * Storage key holding the identity of the recommendation the marker is CURRENTLY entitled to show,
 * or null. Derived — written whenever a recommendation is stored, read by the icon painter.
 *
 * 🔴 THIS KEY EXISTS TO KEEP THE PAINT PATH CHEAP (Codex). The icon decision first read the whole
 * `lastStatus` — a container holding the full snapshot plus both recommendation maps — on EVERY
 * badge paint: collection success, popup open, worker wake, provider refreshes, plan repaints,
 * explicit REFRESH_BADGE. This repo has a standing rule against adding reads to that path (#853).
 * Deciding at WRITE time costs the same read once per recommendation change instead of once per
 * paint, and it puts the decision where the provider context actually exists (see below).
 */
export const REC_NOTICE_KEY = '_recNotice';

/**
 * Stable identity of a recommendation, or null if it is not an actionable one.
 *
 * 🔴 NOT canonicalized on purpose. The obvious instinct is to run the plan name through
 * ui/recommend.js's `_canonPlan()` so "Plus" and "plus_monthly" collapse — but that helper lives in
 * the popup runtime, and copying it into the background runtime would create exactly the kind of
 * hand-maintained twin this repo keeps getting burned by. Identity does not need to be canonical,
 * only STABLE: the same server recommendation always produces the same string, and a server that
 * starts recommending something else produces a different one, which is precisely when the marker
 * should come back. A cosmetic change in how the server spells a plan re-arms the notice once —
 * a far cheaper failure than a second copy of the plan taxonomy drifting out of sync.
 */
export function recNoticeKey(rec) {
  if (!rec) return null;
  const type = rec.type || rec.rec_type;
  if (type !== 'upgrade' && type !== 'downgrade') return null;   // advisory-only recs say nothing
  const to = rec.to_plan || rec.toPlan || '';
  return `${rec.provider || 'claude'}:${type}:${to}`;
}

/**
 * Should the marker be on? True when there is an actionable recommendation whose identity is not
 * the one already seen.
 *
 * @param {object|null} rec   the recommendation from lastStatus
 * @param {string|null} seen  REC_SEEN_KEY's stored value
 */
export function shouldShowRecNotice(rec, seen) {
  const key = recNoticeKey(rec);
  if (!key) return false;
  return key !== seen;
}


/**
 * The identity the marker is entitled to show right now, or null for "show nothing".
 * Thin on purpose: the RULE is shouldNoticeRec() below, which is the pinned region.
 */
export function computeRecNotice(rec, snapshot, collectedOrgs) {
  return shouldNoticeRec(rec, snapshot, collectedOrgs) ? recNoticeKey(rec) : null;
}

// 🔴 MOVED HERE FROM bg/collect.js (#994 unit 2), NOT re-implemented. The recommendation left the
// badge for the icon, so the two call sites that used this vanished — and the cheap thing would
// have been to inline `!snapshot.subscription?.pending_plan` into the icon decision. That is the
// duplication #992 had just finished removing ("두 벌 복제돼 있어 shouldNoticeRec() 하나로 합쳤고").
// One definition, moved next to its only remaining consumer, with its guard pointed at the new
// home. The name changed because it no longer gates a badge; the rule did not.

// === REC NOTICE GATE: BEGIN (pinned by test/rec-pending-suppress-guard.mjs) ===
// Should this rec light the toolbar notice marker? Only actionable recs get a marker, and only when
// the user has not ALREADY scheduled a plan change — nagging about a change already booked is the
// defect #986 describes.
//
// 🔴 `snapshot` and `rec` must describe the SAME provider. Both call sites are on the Claude
// collection path (`snapshot` is the Claude snapshot, `rec` is the legacy org-less Claude slot —
// bg/rec-fetch.js keeps non-Claude recs in `recommendations_by_provider`, which never reaches this
// path), so reading Claude's `subscription.pending_plan` here is provider-consistent. It stops
// being consistent the moment a non-Claude rec is routed here; extract the provider's own
// pending plan first, the way ui/org-selector.js does for the card.
//
// This lived as two hand-copied conditions (the server-response path and the local-update path).
// One function so a change to the rule cannot land on only one of them.
/**
 * The pending plan belonging to the recommendation's OWN provider, or null.
 *
 * 🔴 #992 ASSERTED THIS WAS UNNECESSARY, AND THE LIVE DATA SAYS OTHERWISE. Its reasoning was that
 * the legacy `lastStatus.recommendation` slot only ever holds Claude recs, because the POST path
 * (bg/storage.js) routes non-Claude ones into `recommendations_by_provider`. True of that path —
 * but bg/rec-fetch.js's GET path writes `data.recommendation` through verbatim, provider and all.
 * Observed 2026-08-27 on a real account: `lastStatus.recommendation` held a ChatGPT Pro 5x → Plus
 * downgrade while `recommendations_by_provider` held the same rec. So comparing that rec against
 * CLAUDE's `subscription.pending_plan` compares two different providers, the Claude value is
 * usually null, and the suppression never fires — which is #986's symptom, still live on this
 * surface. That is the exact thing the user originally reported.
 *
 * Claude keeps its scheduled change on the snapshot; every other provider carries its own on its
 * `collectedOrgs` entry (bg/collect-chatgpt.js). Same two sources ui/org-selector.js reads.
 */
export function providerPendingPlan(rec, snapshot, collectedOrgs) {
  const provider = rec?.provider || 'claude';
  if (provider === 'claude') return snapshot?.subscription?.pending_plan || null;
  const org = (collectedOrgs || []).find((o) => (o.provider || 'claude') === provider && o.pendingPlan);
  return org ? org.pendingPlan : null;
}

export function shouldNoticeRec(rec, snapshot, collectedOrgs) {
  if (!rec || (rec.type !== 'upgrade' && rec.type !== 'downgrade')) return false;
  // A CLAUDE rec keeps its scheduled change on the snapshot, so a missing snapshot means the
  // pending state is UNKNOWN, not absent — and a marker for a change the user may already have
  // booked is exactly the nag #986 describes. Fail closed: stay quiet. A provider rec is judged
  // from collectedOrgs and needs no snapshot at all.
  if ((rec.provider || 'claude') === 'claude' && !snapshot) return false;
  return !providerPendingPlan(rec, snapshot, collectedOrgs);
}
// === REC NOTICE GATE: END ===
