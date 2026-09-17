// Motion preference for the popup's runner animation, shared by the popup (ES module) and the
// options page (classic script). Neither can import from the other, so the resolution lives in
// one classic script both pages load instead of being kept in sync by hand.
//
// `runnerPaused` (chrome.storage.local) is the single source of truth. Both the popup's pause
// button and the options-page toggle write it:
//   null / undefined -> never chosen, so the OS "reduce motion" setting decides
//   true / false     -> an explicit user choice, which wins over the OS setting
//
// The runner is a requestAnimationFrame loop driving inline styles, so a CSS
// `prefers-reduced-motion` rule cannot stop it — the query has to be read from script.
const CT_REDUCE_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function ctPrefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia(CT_REDUCE_MOTION_QUERY).matches;
}

// true -> the runner must hold still. `== null` is deliberate: it covers both the absent key
// (never chosen) and an explicitly cleared one.
function ctRunnerMotionOff(runnerPaused) {
  return runnerPaused == null ? ctPrefersReducedMotion() : !!runnerPaused;
}
