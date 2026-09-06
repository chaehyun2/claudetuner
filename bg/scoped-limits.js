// Pure projection of the model-scoped weekly slots into the popup's `additionalLimits` shape.
//
// A LEAF module on purpose. It started life inside bg/collect.js, but the local-only collection
// path (server sync withheld / boost mode) builds `collectedOrgs` through bg/org-merge.js instead,
// and that path silently lacked the field — the popup stayed empty for exactly the gated installs
// that cannot check the dashboard either (Codex DEPLOY-BLOCKER on PR for #1181). org-merge.js is
// imported BY collect.js, so the shared helper cannot live in collect.js without a cycle.
//
// One definition, two call sites, no copy.

/**
 * Project the two model-scoped weekly slots into the popup's `additionalLimits` shape.
 *
 * The popup already has a provider-neutral renderer for per-feature limits
 * (ui/org-selector.js `additional-limits-section`), but only collect-chatgpt.js was ever
 * feeding it — so Claude's scoped weekly limit (e.g. Fable) was collected, stored, charted
 * on the dashboard and named in reset notifications, yet invisible in the popup (#1181).
 *
 * Derived from the SAME slots the snapshot carries rather than re-parsing `usageData.limits`:
 * a second parse would be a copy of resolveScopedWeeklySlots that could drift from it, and the
 * slot assignment (which model lands in which slot) is exactly the part that must not diverge
 * between what we display and what we store.
 *
 * `windowSeconds` stays null on purpose. Anthropic reports the scoped limit's window as
 * `kind:'weekly_scoped'`, never as a span in seconds, and the popup renders a window suffix
 * only from a real reported number (ChatGPT reports one; Claude does not). Inventing 604800
 * here would print a figure the provider never sent — the exact mislabel #926 was about.
 *
 * A slot with no model name is dropped: an unnamed gauge is indistinguishable from the 7-day
 * one sitting right above it, which is the defect, not a lesser version of it. Same rule the
 * reset-notification path (background.js) and the dashboard's _scopedSlotLabel already apply.
 *
 * Pure — no I/O, so the guard test can drive it directly.
 */
export function scopedLimitsForDisplay(snapshot) {
  const out = [];
  for (const slot of [snapshot?.seven_day_omelette, snapshot?.seven_day_sonnet]) {
    if (!slot) continue;
    const model = typeof slot.model === 'string' ? slot.model.trim() : '';
    const used = slot.utilization;
    if (!model || typeof used !== 'number' || !isFinite(used)) continue;
    out.push({
      name: model.slice(0, 40),
      feature: null,
      used,
      resetsAt: slot.resets_at || null,
      windowSeconds: null,
    });
  }
  return out;
}
