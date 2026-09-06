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
function freshFields(snapshot, prev = {}, now) {
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
export function upsertClaudeOrg(prevOrgs, bestOrg, snapshot, now = Date.now()) {
  const list = Array.isArray(prevOrgs) ? prevOrgs : [];
  if (!bestOrg || !bestOrg.uuid) return list;
  if (list.some((o) => o.uuid === bestOrg.uuid)) {
    return list.map((o) => (o.uuid === bestOrg.uuid ? { ...o, ...freshFields(snapshot, o, now) } : o));
  }
  return [...list, {
    uuid: bestOrg.uuid,
    name: bestOrg.name,
    plan: snapshot.plan ?? null,
    provider: 'claude',
    isPrimary: list.length === 0,
    ...freshFields(snapshot, {}, now),
  }];
}
