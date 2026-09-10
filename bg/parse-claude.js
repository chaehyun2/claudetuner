// Pure parsing for Claude's usage response — no chrome.*, no fetch, no Date.now().
//
// Same reason as bg/parse-chatgpt.js (#1315): bg/collect.js imports chrome-only siblings at the
// top, so these helpers were unreachable from anything but the extension itself, and the contract
// runner had to slice them out of the source text by signature string. Placement mirrors the
// ChatGPT side.
//
// 🔴 KEEP THIS FILE IMPORTABLE UNDER PLAIN NODE — bg/api.js's normalizeResetTime is the only
// dependency it may take.
//
// Extracted from bg/collect.js with NO behaviour change; verified against the #1316 contract's
// captured case outputs.
import { normalizeResetTime } from './api.js';

/** Normalize raw extra_usage API response into a consistent shape */
export function normalizeExtraUsage(raw) {
  if (!raw) return null;
  return {
    is_enabled: raw.is_enabled || false,
    monthly_limit: raw.monthly_limit ?? null,
    used_credits: raw.used_credits ?? null,
    utilization: raw.utilization ?? null,
  };
}

/**
 * Resolve the two model-scoped weekly slots from the usage response.
 *
 * Anthropic moved the per-model weekly limit out of the top-level
 * `seven_day_<model>` fields (now null) into the generic `limits[]` array:
 * entries with `kind === 'weekly_scoped'` carry `scope.model.display_name`
 * (e.g. "Fable") and a 0-100 `percent` on the same scale as the old
 * `.utilization`. We map each scoped entry into the two legacy numeric slots
 * (omelette / sonnet) so the entire server + chart pipeline keeps working
 * unchanged. The `model` sub-field is transient metadata: the server's epoch
 * observer reads it to label the slot; snapshot storage ignores it.
 *
 * Slot assignment is deterministic (sorted by model name) so a given model keeps
 * a stable slot — a single active scoped model always lands in the omelette slot.
 * Falls back to the legacy top-level fields when `limits[]` is absent/empty
 * (older API shape or a slot with no active scoped model).
 */
export function resolveScopedWeeklySlots(usageData) {
  const scoped = Array.isArray(usageData.limits)
    ? usageData.limits
        .filter((l) => l && l.kind === 'weekly_scoped' && l.scope?.model?.display_name)
        .map((l) => ({
          model: l.scope.model.display_name,
          utilization: l.percent ?? null,
          resets_at: l.resets_at ?? null,
        }))
        // Locale-independent (code-unit) order so slot assignment is deterministic
        // across browser locales — localeCompare could otherwise order two model names
        // differently per user and swap their slots.
        .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
    : [];

  const slotFrom = (entry, legacy) => entry
    ? {
        utilization: entry.utilization,
        resets_at: normalizeResetTime(entry.resets_at),
        model: entry.model,
      }
    : {
        utilization: legacy?.utilization ?? null,
        resets_at: normalizeResetTime(legacy?.resets_at),
        model: null,
      };

  return {
    omelette: slotFrom(scoped[0], usageData.seven_day_omelette),
    sonnet: slotFrom(scoped[1], usageData.seven_day_sonnet),
  };
}

/**
 * The provider-response half of a Claude usage snapshot.
 *
 * Split out of buildUsageFields() (#1315), which mixed these five fields with the user's timezone,
 * UI language and poll settings. Those four are environment, not response — they cannot be pinned
 * by a fixture and their presence is what kept this whole block out of reach of a contract. The
 * caller re-joins the two halves; the key order is preserved so the emitted payload is unchanged.
 *
 * 🔴 Deliberately NOT null-tolerant: it reads `usageData.five_hour` without optional chaining, the
 * same as resolveScopedWeeklySlots below it, so a null response throws here rather than producing
 * a snapshot of nulls that would look like a real reading of an idle account. Preserved from the
 * original; changing it is a decision, not a cleanup.
 */
/**
 * TRUE when Claude answered but told us nothing — every window null and no scoped limits.
 *
 * 🔴 THIS IS NOT "we have not collected yet", and the difference is the whole point. Anthropic
 * stopped giving Free-plan accounts their windows at 2026-08-21 17:00 UTC: the request still
 * returns 200 and the KEYS ARE STILL THERE, filled with explicit `null`, with `limits: []`
 * (verified against a live Free account 2026-09-10; 821 weekly active users). The widgets could
 * not tell that apart from a cold start, so they rendered "수집 중" or nothing at all and a user
 * reasonably concluded the extension was broken — which is what inquiry #198 actually was.
 *
 * 🪤 DELIBERATELY NOT A PLAN CHECK. Gating on `plan === 'Free'` would be a guess about WHY, would
 * miss any other plan this happens to, and would keep lying after Anthropic changes it back. The
 * response's own emptiness is the fact; the plan is a story about it.
 *
 * Returns false for a null/absent response: that is a FAILED read, which the error path already
 * describes and must not be relabelled as "the provider withheld it".
 */
export function claudeUsageWithheld(usageData) {
  if (!usageData || typeof usageData !== 'object' || Array.isArray(usageData)) return false;
  const empty = (w) => w == null || w.utilization == null;
  if (!empty(usageData.five_hour) || !empty(usageData.seven_day)) return false;
  if (!empty(usageData.seven_day_omelette) || !empty(usageData.seven_day_sonnet)) return false;
  // A scoped limit is still usage we can show, so its presence means nothing was withheld.
  if (Array.isArray(usageData.limits) && usageData.limits.length > 0) return false;
  // 🔴 THE WINDOWS WE WATCH BUT DO NOT RENDER COUNT TOO. cl2 (drift-obs.js) watches six more keys
  // because we could not answer "did the usage move somewhere else in this response". If it ever
  // does move there, the conventional windows go null and this predicate would have said "the
  // provider withheld it" — a FALSE statement while the provider is in fact serving usage we
  // simply cannot draw yet. Not drawing it is a gap; asserting it was not sent is a lie, and this
  // whole change exists to stop the widget saying untrue things.
  //
  // 🪤 SPELLED OUT, NOT LOOPED. `usageData[k]` slips past the read-set scan in
  // test/provider-contract-guard.mjs section [6], which derives "what this file reads" from
  // `usageData.<field>`. A bracket index makes that derivation blind, so the guard rejects it —
  // rightly: the point of the scan is that a field this file reads cannot become invisible.
  if (!empty(usageData.nimbus_quill)) return false;
  if (!empty(usageData.spend)) return false;
  if (!empty(usageData.seven_day_opus)) return false;
  if (!empty(usageData.seven_day_cowork)) return false;
  if (!empty(usageData.seven_day_oauth_apps)) return false;
  if (!empty(usageData.seven_day_breakdown)) return false;
  return true;
}

/**
 * The keys cl2 added over cl1 (bg/drift-obs.js DRIFT_KEYSETS). Exported so a guard can execute
 * both sides and prove this list has not drifted from the keyset — a silent divergence would put
 * the notice back over a window the provider actually served.
 */
export const CL2_WATCHED_WINDOWS = [
  'nimbus_quill', 'spend', 'seven_day_opus', 'seven_day_cowork',
  'seven_day_oauth_apps', 'seven_day_breakdown',
];

export function parseClaudeUsageWindows(usageData) {
  const scopedSlots = resolveScopedWeeklySlots(usageData);
  return {
    five_hour: {
      utilization: usageData.five_hour?.utilization ?? null,
      resets_at: normalizeResetTime(usageData.five_hour?.resets_at),
    },
    seven_day: {
      utilization: usageData.seven_day?.utilization ?? null,
      resets_at: normalizeResetTime(usageData.seven_day?.resets_at),
    },
    seven_day_omelette: scopedSlots.omelette,
    seven_day_sonnet: scopedSlots.sonnet,
    extra_usage: normalizeExtraUsage(usageData.extra_usage),
  };
}
