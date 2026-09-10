// What the 3-org-cap drop banner should SAY — pure. No chrome.*, no DOM, no Date.now().
//
// WHY THIS IS ITS OWN MODULE (#1408). The banner used to be four lines inside popup.js:
//
//     const names = [...new Set(orgs.map(o => PROVIDER_LABELS[o.provider] || o.provider))]
//
// The drop record is per-ORG (`recordCapDrop` stores `claude|<uuid>`, bg/cadence-config.js), and
// that line folded it to per-PROVIDER. So an account with three Claude orgs — one selected and
// collecting, two dropped at the cap — was told "Claude 수집이 안 되고 있습니다" while its Claude
// gauge was live two centimetres below, on the same screen (문의 #198, xlos21@gmail.com).
//
// 🔴 THE INVARIANT: never name a provider as not-collected while one of its orgs IS collected.
// That is the whole defect, it is a property of (drops × collectedOrgs) rather than of either
// side alone, and it cannot be pattern-matched — so it lives in a function a test can execute.
//
// The original comment defending the fold said "a uuid means nothing to a user", which is true and
// was never the choice on offer: `collectedOrgs` carries the org's NAME, and the name is what the
// user recognises. Falling back to the provider label is only honest when the whole provider is
// down; when it is not, this returns a count instead of a name it cannot stand behind.

/**
 * The identity of a drop SET, used to decide whether a dismissal still applies.
 * Sorted so the same set is the same signature regardless of the order it accumulated in.
 */
export function capDropSignature(orgs) {
  const keys = (Array.isArray(orgs) ? orgs : [])
    .map((o) => (o && typeof o.key === 'string' ? o.key : ''))
    .filter(Boolean);
  // 🔴 A SET, ENCODED UNAMBIGUOUSLY — not `keys.sort().join(',')`, which was neither.
  // Duplicates made the same set produce two signatures, so an acknowledgement stopped
  // matching; and joining on a delimiter that can occur inside a key made two DIFFERENT sets
  // collide (`['a,b']` vs `['a','b']`), so acknowledging one silently suppressed the other.
  // Provider ids do not contain commas today — which is what makes it a latent bug rather than
  // a live one, and exactly the kind that outlives the assumption. (Codex review, #1408.)
  return JSON.stringify([...new Set(keys)].sort());
}

/**
 * `claude|<uuid>` → `<uuid>`; a key with no separator yields ''.
 * Private, and every caller has already filtered `key` to a non-empty string — so there is no
 * non-string branch here. (There was one; a mutation could not reach it. Codex round 2, #1408.)
 */
function uuidOf(key) {
  const i = key.indexOf('|');
  return i >= 0 ? key.slice(i + 1) : '';
}

/**
 * The provider-qualified identity of an org, used for BOTH sides of the drop-membership test.
 *
 * 🔴 THIS EXISTS BECAUSE THE FIRST CUT COMPARED BARE UUIDs, and that broke the one invariant this
 * module is for. A Gemini org being dropped marked its uuid as dropped for EVERY provider, so a
 * Claude org that happened to share the uuid was read as "also dropped" — `providerStillCollecting`
 * went false and the banner printed a bare "Claude" while Claude was collecting. The name lookup
 * already matched on provider; membership did not, and the asymmetry is what hid it.
 * (Codex DEPLOY-BLOCKER, #1408.)
 */
function identity(provider, uuid) {
  return `${provider || 'claude'}|${uuid}`;
}

const NAMES_SHOWN_MAX = 2;

/**
 * Decide what the banner renders.
 *
 * @param {Array<{key:string, provider:string}>} orgs   the `_ct_cap_drop` entries
 * @param {Array<{uuid:string, provider?:string, name?:string}>} collectedOrgs
 *        the popup's local org list. 🔑 A dropped org IS in here: the collect loop pushes to
 *        orgUsageMap/collectedOrgs "regardless of server POST result" (bg/collect.js), which is
 *        exactly why the name is available at all.
 * @param {string} ackSig  signature the user last dismissed ('' = nothing dismissed)
 * @param {Record<string,string>} providerLabels  PROVIDER_LABELS (injected: this module imports nothing)
 *
 * @returns {null | {mode:'names', names:string[], extra:number, sig:string}
 *                 | {mode:'count', count:number, sig:string}}
 *          null = render nothing.
 */
export function buildCapDropView(orgs, collectedOrgs, ackSig, providerLabels = {}) {
  // 🔴 DEDUPED BY KEY, and it is the COUNT that made this matter. The signature already
  // canonicalised to a set, so a record holding the same org twice produced one signature but
  // `count: 2` — the banner said "2 organizations" about one org, and the two numbers disagreed
  // inside the same object. applyCapDrop does not currently write duplicates, so this is
  // hardening rather than a live bug; the point is that the count and the signature now describe
  // the same set by construction instead of by coincidence. (Codex round 2, #1408.)
  const seenKeys = new Set();
  const entries = (Array.isArray(orgs) ? orgs : []).filter((o) => {
    if (!o || typeof o.key !== 'string' || !o.key) return false;
    if (seenKeys.has(o.key)) return false;
    seenKeys.add(o.key);
    return true;
  });
  if (entries.length === 0) return null;

  // Non-empty by construction: `entries` kept only truthy keys, so the signature has at least
  // one. That is what makes the bare comparison below safe — a default `ackSig` of '' can never
  // match. (An earlier cut wrote `sig && sig === ackSig`; the extra test was unreachable, and a
  // mutation run proved it: deleting it changed no result. Dead defence reads as live defence.)
  const sig = capDropSignature(entries);
  // 🔴 SIGNATURE, NOT A BOOLEAN. "The user dismissed this" has to mean "…this set of orgs".
  // A plain dismissed-flag would swallow the NEXT org to start dropping, which is a different
  // fact and the one the banner exists to deliver.
  if (sig === ackSig) return null;

  const known = Array.isArray(collectedOrgs) ? collectedOrgs : [];
  // 🪤 The emptiness test is on the PARSED UUID, not on the encoded identity's suffix.
  // `!id.endsWith('|')` looked equivalent and was not: an org whose uuid genuinely ends in `|`
  // encodes to `claude|x|`, which that test threw away — so a dropped org was read as still
  // collecting and the banner fell to count mode for no reason. Filtering the input, not the
  // encoding, cannot confuse "no uuid" with "a uuid that happens to end in the separator".
  // (Codex round 2, #1408.)
  const droppedIds = new Set(
    entries
      .map((e) => ({ provider: e.provider, uuid: uuidOf(e.key) }))
      .filter((e) => e.uuid)
      .map((e) => identity(e.provider, e.uuid)),
  );

  const names = [];
  // Set when we would have to print a bare provider label for an org we could not name, WHILE
  // that provider still has a collecting org. That is precisely the false sentence this module
  // exists to prevent, so the whole banner degrades to a count rather than emit it.
  let wouldMislead = false;

  for (const e of entries) {
    const provider = e.provider || 'claude';
    const label = providerLabels[provider] || provider;
    const uuid = uuidOf(e.key);
    const org = known.find((o) => o && o.uuid === uuid && (o.provider || 'claude') === provider);
    const name = org && typeof org.name === 'string' ? org.name.trim() : '';
    if (name) {
      // Same shape as ui/org-selector.js's orgLabel: the provider stays, because "Claude ·
      // account@dable.io's Organization" is what the settings screen calls this row too.
      names.push(`${label} · ${name}`);
      continue;
    }
    const providerStillCollecting = known.some(
      (o) => o && (o.provider || 'claude') === provider
        && !droppedIds.has(identity(o.provider, o.uuid)),
    );
    if (providerStillCollecting) wouldMislead = true;
    names.push(label);
  }

  if (wouldMislead) return { mode: 'count', count: entries.length, sig };

  const unique = [...new Set(names)];
  return {
    mode: 'names',
    names: unique.slice(0, NAMES_SHOWN_MAX),
    extra: Math.max(0, unique.length - NAMES_SHOWN_MAX),
    sig,
  };
}
