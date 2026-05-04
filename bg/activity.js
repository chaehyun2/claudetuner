// === Activity State Management ===
// Tracks whether the user is actively using Claude.ai (tab focused + visible),
// has it open in the background, or has no Claude.ai tabs open.
// Used to adjust the poll alarm frequency for local UI freshness.

const ACTIVITY_STATES = { ACTIVE: 'active', BACKGROUND: 'background', IDLE: 'idle' };

let _activityState = ACTIVITY_STATES.IDLE;

// Restore from storage on service worker restart
chrome.storage.local.get({ _activityState: ACTIVITY_STATES.IDLE }, (r) => {
  _activityState = r._activityState;
});

export function getActivityState() {
  return _activityState;
}

export async function setActivityState(state) {
  if (_activityState === state) return false; // no change
  const prev = _activityState;
  _activityState = state;
  await chrome.storage.local.set({ _activityState: state });
  console.log(`[Claude Tuner] Activity: ${prev} → ${state}`);
  return true; // changed
}

export { ACTIVITY_STATES };
