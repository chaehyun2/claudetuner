// Pure org-list merge. Extracted from bg/collect.js so it can be TESTED rather than pattern-
// matched: the guard that used to cover this was a regex over the branch, which cannot tell an
// append that runs from an append sitting in dead code (Codex, PR #946).
//
// Why an upsert at all: the local-only branch (server sync withheld, or boost mode) used to
// refresh `collectedOrgs` with `prevOrgs.map(...)`, which updates a listed org and silently drops
// an unlisted one. A withheld install never reaches the server-sending path that BUILDS that list,
// so its Claude org was never listed — and with a Gemini/ChatGPT org present from the provider
// path, ui/render.js read `_providerOnly` as true forever and hid Claude from its own user.

import { scopedLimitsForDisplay } from './scoped-limits.js';

/** Fields this collection can refresh, shared by insert and update so the two cannot drift. */
function freshFields(snapshot, prev = {}, now, noUsage = false) {
  // Model-scoped weekly limits (#1181). MUST be here and not only on the multi-org merge path:
  // this function is the ONLY writer of collectedOrgs for a local-only install (sync withheld or
  // boost mode), and those are precisely the users who cannot fall back to the dashboard instead.
  //
  // 🔴 Deliberately does NOT fall back to `prev` the way h5/d7 do on the lines below. A scoped
  // limit is optional-presence data: the model rotates, a downgrade removes the bucket, and
  // `limits[]` is simply absent from some polls. Keeping the last value would leave a local-only
  // install asserting "Fable 100%" forever after the bucket went away, and — worse — would make
  // this writer disagree with the collect.js writer, which publishes the current observation.
  // That exact divergence between the two collectedOrgs writers is what hid this feature from
  // gated installs in the first place (Codex round 1). Latest observation wins, in both writers.
  const scoped = scopedLimitsForDisplay(snapshot);
  // 🔴 A SUCCESSFUL EMPTY RESPONSE IS CURRENT INFORMATION, so it must REPLACE the stored usage
  // rather than fall through `?? prev` to yesterday's numbers.
  //
  // The two collectedOrgs writers cleared usage differently: the synced path in collect.js writes
  // the current nulls, this one retained the previous values. Once the withheld observation was
  // added, that divergence became a contradiction between two of OUR OWN screens — an org left as
  // `{noUsage: true, h5: 25, d7: 35}` made the POPUP say "Claude isn't providing usage" (it reads
  // the empty snapshot) while the in-page WIDGET drew gauges at 25/35 (it reads the retained org).
  // Reproduced end to end by Codex on the 1.29.71 batch review.
  //
  // 🪤 SCOPED TO THE WITHHELD CASE ONLY. `?? prev` is deliberate for an ordinary poll — a partial
  // response must not blank a gauge — and widening this to every null would resurrect exactly that
  // flicker. What changed is that we can now TELL those two apart.
  if (noUsage) {
    return {
      additionalLimits: scoped.length ? scoped : null,
      h5: null, d7: null, resetsAt5h: null, resetsAt7d: null,
      extraUsage: snapshot.extra_usage ?? null,
      updatedAt: now,
    };
  }
  return {
    additionalLimits: scoped.length ? scoped : null,
    h5: snapshot.five_hour?.utilization ?? prev.h5 ?? null,
    d7: snapshot.seven_day?.utilization ?? prev.d7 ?? null,
    resetsAt5h: snapshot.five_hour?.resets_at ?? prev.resetsAt5h ?? null,
    resetsAt7d: snapshot.seven_day?.resets_at ?? prev.resetsAt7d ?? null,
    extraUsage: snapshot.extra_usage ?? prev.extraUsage ?? null,
    updatedAt: now,
  };
}

/**
 * Returns a NEW list with `bestOrg` refreshed, appending it when absent.
 *
 * 🔴 Never becomes primary on a list that already has entries. The full collection path resolves
 * the primary deliberately; here we only know this org exists. The first cut took primacy whenever
 * nobody held it — which is not "stealing", but it still CHANGED what the user sees: a gated
 * install whose provider org sits at `isPrimary:false` (the observed state) rendered Gemini as the
 * main org via the `find(isPrimary) || orgs[0]` fallback, and inserting a primary Claude silently
 * repointed the popup. Making an org visible and choosing the user's main org are different
 * decisions; this function is only allowed the first.
 *
 * ⚠️ So a gated multi-provider install can end up with NO primary at all. That is the state it was
 * already in before this function existed and the consumers tolerate it — ui/render.js falls back
 * to `orgs[0]`, overview just draws no pin. One consequence to know: org-selector.js:527 selects a
 * chip on `!selectedOrgId && org.isPrimary`, so with no primary and no selection nothing is
 * highlighted. Pre-existing, not introduced here.
 *
 * A null `bestOrg` returns the list untouched — no Claude org was resolved this round, and
 * inventing one would be worse than showing none.
 */
/**
 * @param noUsage  The RAW-response observation "the provider answered and served no usage"
 *   (bg/parse-claude.js claudeUsageWithheld). 🔴 Fifth, after `now`, because
 *   test/gated-org-upsert-guard.mjs already passes `now` fourth — inserting ahead of it would have
 *   silently bound a timestamp to this flag and made every gated org read as withheld.
 *
 * 🔴 WHY IT HAS TO COME THROUGH HERE. The local-only branch (Boost/skipServer, login-gated, paused
 * sync) writes collectedOrgs via this function and RETURNS before collect.js computes the flag for
 * the synced path. Without it those installs kept showing two unexplained N/As — and, on the
 * primary popup path, the stale "Free 플랜: 7일 사용률 제공 안 됨" (inquiry #198, Codex).
 */
export function upsertClaudeOrg(prevOrgs, bestOrg, snapshot, now = Date.now(), noUsage = false) {
  const list = Array.isArray(prevOrgs) ? prevOrgs : [];
  if (!bestOrg || !bestOrg.uuid) return list;
  if (list.some((o) => o.uuid === bestOrg.uuid)) {
    return list.map((o) => (o.uuid === bestOrg.uuid ? { ...o, ...freshFields(snapshot, o, now, !!noUsage), noUsage: !!noUsage } : o));
  }
  return [...list, {
    uuid: bestOrg.uuid,
    name: bestOrg.name,
    plan: snapshot.plan ?? null,
    provider: 'claude',
    isPrimary: list.length === 0,
    ...freshFields(snapshot, {}, now, !!noUsage),
    // 🪤 Written EXPLICITLY, not through freshFields' `?? prev` merge: the observation describes
    // THIS response. Carrying a previous `true` forward is how a notice outlives the withholding
    // it describes, which is the failure the in-page widgets shipped and had to be fixed (#1397).
    noUsage: !!noUsage,
  }];
}
