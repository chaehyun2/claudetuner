// Shared, mutable popup view-state — single source of truth across the popup UI modules.
// Exported as one object so extracted modules (charts/org-selector/prediction/...) can both read
// AND mutate it: ES modules can't reassign an imported binding, but object property mutation works.
// Migrated from the top-level `let _*` vars in popup.js (refactor/popup-state).

export const state = {
  currentPlan: null,
  usageHistory: [],
  historyLoaded: false, // usage history fetched at least once (gate the day-1 forecast teaser to avoid a flash before load)
  currentSnapshot: null,
  orgList: null, // cached org list
  selectedOrgId: null, // selected org UUID (multi-org view)
  collectedOrgs: [], // cached collectedOrgs (for _filteredHistory, selectOrg, etc.)
  overviewOrder: [], // user's saved overview card order (uuid list, chrome.storage.sync)
  lastView: 'overview', // last-viewed multi-account screen ('overview' | 'detail'), restored on open
  overviewHintDismissed: false, // user dismissed the one-time "click a card for detail" hint
  claudeNoticeDismissed: false, // user dismissed the demoted Claude-disconnected notice (reset when Claude recovers)
  dashNudgeEvaluated: false, // one-time dashboard nudge already evaluated this popup open (avoid rebinding listeners)
  isIndependent: false, // signed in via email (no Claude account) — suppress all Claude-centric status/errors
  independentEmail: '', // independent account email (shown in the footer)
  providerEmail: null, // The provider account this browser is signed in to (accountCache). NOT the
                       // identity — see bg/storage.js THE RULE. Held only so the footer can say
                       // when the two differ; a fresh install has no token and no provider email
                       // yet, which is exactly when nothing can be compared.
  syncEmail: null, // Tuner account the ext_token binds to = where collected data actually LANDS.
                   // Diverges from the provider email after a provider account-email change
                   // (see bg/ext-token-claims.js). null until a token exists.
  lastRecommendation: null, // cached Claude recommendation (restored when returning to primary org)
  recProvider: 'claude', // provider of the rec currently ON SCREEN — gates plan-change execution,
                         // which only Claude supports (see ui/recommend.js)
  planChangedTo: null, // plan we just changed to — suppresses same recommendation from re-rendering
  recDismiss: null, // active "not now"/"don't show again" record (bg/rec-dismiss.js), loaded on open
  popupNoticeList: [],
  popupAds: [], // selected in-house ad banners (design §3.2) rendered alongside promos
  updateUITimer: null,
  lastUpdateUIStatus: null,
};


// === PRIMARY PLAN BORROW RULE: BEGIN (pinned by test/plan-borrow-guard.mjs) ===
// Who may read `state.currentPlan`. It is the CLAUDE plan and nothing else: render.js and popup.js
// refresh it from the PRIMARY Claude snapshot, and org-selector does not touch it when a provider
// org is selected. Lending it to a non-Claude org is a CATEGORY ERROR, not a stale value — the
// plan NAME is fed into that provider's own multiplier ladder (ui/util.js planToMultiplier), where
// Claude's "Pro" scores the ChatGPT Pro 20x tier and divides that org's real utilization by 20.
// Observed: a ChatGPT org at 80% drew as 4% (#1433 ②), and the rec card degraded a real upgrade
// recommendation to "current plan ok" (#1433 ④). The server already refuses the same borrow
// (`users.current_plan` is never lent to a non-Claude org, PR #1432); this is the client half.
//
// 🔴 Callers pass the PROVIDER, not a pre-resolved plan. `orgPlan || state.currentPlan` cannot
// express this rule, because "this provider org reports no plan" and "the Claude bootstrap has not
// loaded a plan yet" are different facts that both look falsy. The provider is the thing that
// decides, so the provider is what this takes.
//
// 🔑 Why these branches are newly reachable: until #1431/#1434, an unknown plan was fabricated as
// 'Free' before it ever got here, so the borrow could not fire. Making "unknown" honest (null) is
// what exposed it — the borrow paths were dead code, and the fix that revived them is elsewhere.
//
// Returns null for a non-Claude org, meaning "unknown". planToMultiplier scores null as 1x, the
// same as every other unrecognized label, so history entries carrying no plan of their own are not
// rebased at all — which is the correct treatment of an unknown scale. Note the alternative is
// worse, not neutral: a fabricated plan REBASES real numbers by a wrong factor.
export function primaryPlanFor(provider) {
  // `|| null` so "absent" has ONE spelling. Every assignment to state.currentPlan already writes
  // `... || null`, so a blank never reaches here today — but the dashboard twin normalizes and the
  // cross-runtime guard compares them, and a contract that holds only by upstream accident is one
  // the next writer can break silently.
  return (provider || 'claude') === 'claude' ? (state.currentPlan || null) : null;
}
// === PRIMARY PLAN BORROW RULE: END ===


// Body class that hides every detail section (see popup.html `body.ct-view-overview`).
export const OVERVIEW_CLASS = 'ct-view-overview';

// True when the overview (master) screen is covering the detail view, i.e. every detail
// section is display:none. Render paths that only touch hidden sections use this to bail out.
//
// It reads the body class rather than a mirrored boolean so there is exactly one source of
// truth, and it lives HERE — a leaf module importing nothing — rather than in ui/overview.js,
// which would put charts.js -> overview.js -> org-selector.js -> charts.js in an import cycle.
export function isDetailHidden() {
  return document.body.classList.contains(OVERVIEW_CLASS);
}


// Usage history filtered to the selected org (a computed view of state). Legacy org-less rows are
// included only when a Claude primary org is selected.
export function _filteredHistory() {
  if (!state.selectedOrgId) return state.usageHistory;
  // Include legacy history (without org field) only when a Claude primary org is selected
  const selOrg = state.collectedOrgs.find(o => o.uuid === state.selectedOrgId);
  const includeLegacy = selOrg?.isPrimary && (selOrg?.provider || 'claude') === 'claude';
  return state.usageHistory.filter(p =>
    p.org === state.selectedOrgId || (!p.org && includeLegacy)
  );
}


// True when the selected org is a non-Claude (provider) org rather than the Claude primary.
export function _isNonClaudePrimarySelected() {
  if (!state.selectedOrgId || !state.currentSnapshot) return false;
  return state.selectedOrgId !== state.currentSnapshot.claude_org_uuid;
}
