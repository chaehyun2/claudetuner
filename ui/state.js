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
  claudeNoticeDismissed: false, // user dismissed the demoted Claude-disconnected notice (reset when Claude recovers)
  dashNudgeEvaluated: false, // one-time dashboard nudge already evaluated this popup open (avoid rebinding listeners)
  isIndependent: false, // signed in via email (no Claude account) — suppress all Claude-centric status/errors
  independentEmail: '', // independent account email (shown in the footer)
  lastRecommendation: null, // cached recommendation (restored when returning to primary org)
  planChangedTo: null, // plan we just changed to — suppresses same recommendation from re-rendering
  popupNoticeList: [],
  updateUITimer: null,
  lastUpdateUIStatus: null,
};


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
