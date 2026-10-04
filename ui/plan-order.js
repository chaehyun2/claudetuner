// Default display order of accounts: Claude, then ChatGPT, then Gemini; within a provider a
// personal plan precedes Team precedes Enterprise. Lower sorts first.
//
// Shared by the popup overview (ui/overview.js) and the mobile widget (worker/src/services/
// widget-cards.ts imports this file directly, like widget-forecast.ts imports prediction-core.js).
// A widget and a popup that list the same accounts in different orders is the small kind of wrong
// that makes a user distrust both — so the rule lives once (#2066; it was two hand copies).
//
// Keep this file free of imports and of DOM/chrome access: the worker bundles it.

const PROVIDER_BASE = { claude: 0, chatgpt: 100, gemini: 200 };

export function planOrderRank(provider, plan) {
  const base = PROVIDER_BASE[provider] ?? PROVIDER_BASE.claude;
  if (plan && /Enterprise/i.test(plan)) return base + 3;
  if (plan && /Team/i.test(plan)) return base + 2;
  return base + 1;
}
