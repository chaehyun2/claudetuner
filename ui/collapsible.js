// User-collapsible popup sections, with the choice remembered across popup opens.
//
// Why a shared module rather than a second copy of the extra-usage disclosure: that one
// (ui/render.js "Extra usage (collapsible)") keeps its open/closed state only in the DOM, so it
// re-expands every time the popup is reopened. That is fine for a transient detail panel and
// wrong for "I don't want to see this section" — a preference that resets is not a preference.
// Both sections here need the same behaviour, so it is written once.
//
// 🔴 State is applied SYNCHRONOUSLY from a cache primed once at popup start. Reading
// chrome.storage inside each render would paint the section expanded and then snap it shut,
// which reads as a glitch on every single popup open.
//
// 🪤 Object-form get with an explicit `false` default is correct HERE (two states, absent means
// expanded) — unlike the three-state reads that must use the array form, because
// chrome.storage.get({k: undefined}) swallows the key entirely (#785/#787).

const STORAGE_KEY = 'ct_collapsed_sections';

// key → true when the user collapsed it. Absent/false = expanded (the default: a section nobody
// has touched must look exactly as it did before this feature existed).
let _collapsed = {};
let _loaded = false;

/** Prime the cache. Call once during popup init and await it before the first render. */
export async function loadCollapseState() {
  const r = await chrome.storage.local.get({ [STORAGE_KEY]: {} });
  const v = r[STORAGE_KEY];
  _collapsed = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  _loaded = true;
}

export function isCollapsed(key) {
  return _collapsed[key] === true;
}

/**
 * Apply the remembered state to one section. Idempotent — safe to call on every render, which is
 * required: the sections are shown/hidden and re-rendered by their own logic, and a class set once
 * at init would be lost the moment innerHTML around it is rebuilt.
 */
export function applyCollapseState(sectionEl, key) {
  if (!sectionEl) return;
  const collapsed = isCollapsed(key);
  sectionEl.classList.toggle('ct-collapsed', collapsed);
  // aria-expanded has to follow the RESTORED state too, not just clicks. The markup ships
  // `aria-expanded="true"`, so without this a section restored collapsed is announced as expanded
  // — a screen-reader user is told the matrix is open while it is hidden, and stays told that
  // until they toggle it themselves.
  const head = sectionEl.querySelector('.ct-collapse-head');
  if (head) head.setAttribute('aria-expanded', String(!collapsed));
}

/** Compact text shown in the header IN PLACE of the body while collapsed (CSS decides). */
export function setCollapseSummary(sectionEl, text) {
  const el = sectionEl && sectionEl.querySelector('.ct-collapse-summary');
  if (el) el.textContent = text || '';
}

/**
 * Record and persist one section's state. Split out of the click listener so the state mutation is
 * reachable without a DOM: it is the step where a corrupt stored value actually bites. If
 * `_collapsed` were left as whatever was in storage, `_collapsed[key] = ...` on a STRING throws in
 * strict mode (ES modules are strict) — the first click would blow up instead of collapsing — and
 * on an ARRAY it would persist a corrupted shape that outlives the bad value that caused it.
 * That is why loadCollapseState insists on a plain object rather than merely a truthy one.
 */
export function setCollapsed(key, collapsed) {
  const next = collapsed === true;
  _collapsed[key] = next;
  // Read-merge-write, and merge only the ONE key that just changed.
  //
  // The popup and the side panel can both be open, each with its own `_collapsed` snapshot taken
  // at ITS open time. Writing the whole cached map would let the older document's stale value for
  // a key it never touched overwrite the other document's fresh choice. Writing `[key]: next` on
  // top of what is stored right now means a click can only ever change the thing it clicked.
  return Promise.resolve(chrome.storage.local.get({ [STORAGE_KEY]: {} })).then((r) => {
    const v = r && r[STORAGE_KEY];
    const stored = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    return chrome.storage.local.set({ [STORAGE_KEY]: { ...stored, [key]: next } });
  }).then(() => next).catch(() => next);
}

/**
 * Bind the headers. One delegated listener, so sections re-rendered later still work.
 *
 * 🔴 stopPropagation is load-bearing, not defensive: #fitness-section has a click handler on the
 * WHOLE card that opens the dashboard (popup.js ~L1556). Without this, clicking "collapse" would
 * navigate away instead — two behaviours on one surface, which is the shape of defect this repo
 * has shipped before (v1.29.57).
 */
function _toggleFrom(head, e) {
  const section = head.closest('.ct-collapsible');
  const key = head.dataset.collapse;
  if (!section || !key) return;
  e.stopPropagation();
  e.preventDefault();
  // Flip the UI from the local cache immediately — the persist is async and must never make the
  // user wait for storage to see their own click.
  const next = !isCollapsed(key);
  setCollapsed(key, next);
  section.classList.toggle('ct-collapsed', next);
  head.setAttribute('aria-expanded', String(!next));
}

export function initCollapsibles(root = document) {
  root.addEventListener('click', (e) => {
    const head = e.target.closest && e.target.closest('.ct-collapse-head');
    if (head && root.contains(head)) _toggleFrom(head, e);
  }, true); // capture: beat the card-level dashboard handler to the event
  // The header is role="button" tabindex="0", which PROMISES keyboard operation — a div with that
  // role and no key handler is worse than a plain div, because a screen reader announces a button
  // that cannot be pressed. Enter and Space are what button semantics require.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const head = e.target.closest && e.target.closest('.ct-collapse-head');
    if (head && root.contains(head)) _toggleFrom(head, e);
  }, true);
  if (!_loaded) console.warn('[Claude Tuner] initCollapsibles ran before loadCollapseState');
}
