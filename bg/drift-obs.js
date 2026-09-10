// Provider schema-drift observation — pure. No chrome.*, no fetch, no Date.now().
//
// WHY (#1322). When a provider changes its API shape, our only current detection path is a user
// inquiry. The obvious alternative — "spot it in the ingest payload we already receive" — does not
// work, because the information is destroyed BEFORE it reaches the server:
//
//   • additional_rate_limits is truncated to 5 while still on the client
//     (bg/parse-chatgpt.js MAX_ADDITIONAL_LIMITS, applied in parseAdditionalLimits)
//   • the observation rider carries a count + names summary, never the response
//   • 🔴 Gemini returns EARLY when the response shape is unreadable (bg/collect-gemini.js), so the
//     broken case disappears from the successful-ingest population entirely — the observation goes
//     blank at exactly the moment we most want it
//
// So this module summarises the response BEFORE any of that, in a form that is cheap to send and
// impossible to reconstruct a user's data from.
//
// 🔴 THIS FILE MUST STAY IMPORTABLE UNDER PLAIN NODE, and it imports NOTHING. That is what lets
// test/provider-contract-guard.mjs drive these functions from case files — the observation gets the
// same fixture treatment as the parsers it watches.
//
// 🔴 IT IS A SHAPE SUMMARY, NOT A RESPONSE DUMP. Nothing here may carry a value out of the
// response. Sizes, types, and the NAMES OF SCHEMA FIELDS only — never a field's contents, never a
// cookie or Authorization header (those are not in scope here and must never be added).

// ── Key filtering ────────────────────────────────────────────────────────────────────────────
//
// 🔴 THE REASON THIS IS AN ALLOWLIST AND NOT A DENYLIST. ChatGPT's accounts/check keys its
// `accounts` map BY ACCOUNT UUID (see parseAccountsRoster, which does
// `Object.keys(accounts).filter(k => k !== 'default')`). So "collect the keys we do not read" is
// one wrong turn away from shipping account UUIDs into an observation store — a user-data leak AND
// a cardinality explosion, in a place that is hard to walk back.
//
// Restricting to the TOP LEVEL happens to be safe today, but "it is top level so it is safe" is a
// property of the current response, not of this code. It would silently stop being true the first
// time someone descends one level. So the shape of the key is checked too, and a key has to look
// like a SCHEMA FIELD NAME to survive: a letter, then letters/digits/underscores, at most 40 chars.
// A UUID (`-`), an email (`@`), a `user-…` id (`-`) and a bare number all fail that on their own.
const SCHEMA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
// …and the two shapes that would slip through the rule above: a dashless hex id, and anything
// carrying a long digit run (numeric ids, epoch stamps).
const ID_SHAPED_RE = /^[0-9a-fA-F]{16,}$|\d{8,}/;

// 🔴 SHAPE ALONE CANNOT PROVE A KEY IS NOT AN IDENTIFIER, and pretending otherwise is the trap.
// Codex got all three of these past the rules above:
//     user_alice                              a username, indistinguishable from a field name
//     aaaaaaaa_bbbb_cccc_dddd_eeeeeeeeeeee    a UUID with underscores instead of dashes
//     clz9x8y7w6v5u4t3s2r1q0p9o               a cuid
// No code path reaches such a key today (the walk is depth-1 and no top-level response key is
// user-keyed), so this is not evidence of a live leak — it is proof that the filter is a heuristic
// and must be treated as one.
//
// So the rules below are tightened toward SCHEMA FIELD NAMES SPECIFICALLY rather than toward
// "not obviously an id", and anything that fails is still COUNTED. That keeps the signal this
// observation exists for — "something new appeared" — while only the NAME depends on the key
// looking unambiguously like schema. A withheld count is a weaker signal than a name; silently
// dropping the key would be no signal at all.
// 🔴 THE RESIDUAL IS CLOSED ON THE READER SIDE, NOT HERE (agreed 2026-09-08).
// `user_alice` passes every rule below and always will — nothing about its shape distinguishes it
// from `user_agent` or `user_email`. The mitigation is a QUERY rule, recorded here because a rule
// that lives only in the consumer's notes is one refactor away from being lost:
//
//     An unknown key name counts as a schema signal ONLY when it appears on >= 2 DISTINCT accounts.
//
// A schema change shows up across the fleet; a user's own name appears on exactly one account. So
// even if one leaked, it cannot become a signal. The account hash is already blob8, so the query
// can express this without any new field from us.
const MAX_SCHEMA_KEY_LEN = 32;
const MAX_SCHEMA_SEGMENTS = 4;
const MAX_SEGMENT_LEN = 14;
// A segment with no vowel and real length is base62/hex-ish, not a word: `clz9x8y7w6v5u4t3s2r1`.
const VOWELLESS_RE = /^[^aeiouAEIOU]{8,}$/;

/** @returns {boolean} true when a key is safe to report as a schema field NAME. */
export function isSchemaFieldName(key) {
  if (typeof key !== 'string') return false;
  if (!SCHEMA_KEY_RE.test(key) || ID_SHAPED_RE.test(key)) return false;
  if (key.length > MAX_SCHEMA_KEY_LEN) return false;
  const segs = key.split('_');
  if (segs.length > MAX_SCHEMA_SEGMENTS) return false;
  return segs.every((seg) => seg.length <= MAX_SEGMENT_LEN && !VOWELLESS_RE.test(seg));
}

/**
 * Top-level keys of `obj` that `known` does not list — the "provider added a field" signal.
 *
 * 🔴 DEPTH 1, HARD. It never recurses, and it must never be made to: one level down in
 * accounts/check is a map keyed by account UUID. Do not "improve" this by walking the tree, and do
 * not descend into a map whose keys are identifiers under any circumstances.
 *
 * Bounded to `max` names so a provider cannot grow the payload, sorted so the same set is one
 * group in the query regardless of the order it arrived in.
 */
export function unknownTopLevelKeys(obj, known, max = 5) {
  return unknownTopLevelKeyReport(obj, known, max).names;
}

/**
 * The same walk, reporting what was WITHHELD as well as what is named.
 *
 * 🔴 `withheld` is the honest half. A key that does not look unambiguously like a schema field is
 * not reported by name — but the fact that an unrecognised key APPEARED is still the signal this
 * observation exists for, and dropping it silently would turn a heuristic's caution into blindness.
 * A count says "something new is there, we would not name it"; the next step is a human looking.
 */
export function unknownTopLevelKeyReport(obj, known, max = 5) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { names: [], withheld: 0 };
  const knownSet = new Set(known);
  const unknown = Object.keys(obj).filter((k) => !knownSet.has(k));
  const names = unknown.filter(isSchemaFieldName).sort().slice(0, max);
  // 🔴 EVERYTHING UNKNOWN THAT WE DID NOT NAME, which includes the ones the CAP dropped.
  //
  // This used to count only the name-filter's rejects, so a response with 14 unknown keys reported
  // 5 names and `withheld: 0` — and `0` reads as "nothing was hidden". Measured on the live Claude
  // usage response (2026-09-10): exactly that, on every plan. The five names that fit are the
  // alphabetically first, and because the cut is alphabetical it is not even a random sample —
  // `nimbus_quill` (a usage window object with the same shape as `five_hour`) and `spend` sat
  // permanently on the wrong side of it while five all-null codenames were reported instead.
  //
  // The cap itself stays: bounding the payload is what stops a provider growing it without limit.
  // What was wrong is that the loss was invisible. A count cannot say WHICH key was dropped, but
  // "5 named, 9 withheld" tells the reader the names are a sample rather than the set — and that
  // is the difference between a lead and a false all-clear.
  return { names, withheld: unknown.length - names.length };
}

// ── Shape signature ──────────────────────────────────────────────────────────────────────────

/**
 * One character per value, so a fixed key list becomes a fixed-length string.
 *
 * 🔴 THE ALPHABET IS A CROSS-COMPONENT CONTRACT. AGREED 2026-09-08, DO NOT CHANGE UNILATERALLY:
 *
 *     s string · n number · b bool · a array · o object · 0 null · - absent · ? anything else
 *
 * 🪤 The producer (this file) and the consumer (the worker's AE writer/queries) were drafted
 * independently and picked CONFLICTING letters: one had `n`=null and `d`=number, the other
 * `n`=number and `0`=null. Both are "one char per key", both look right in isolation, and the same
 * stored string reads as a different response shape depending on which side you ask. Nothing would
 * have thrown — the drift signal would just have been wrong, in a store that cannot be rewritten.
 * A shared alphabet is the whole value of the signature; changing a letter on one side only is
 * indistinguishable from the provider changing its schema.
 *
 * 🔴 `-` (absent) and `0` (null) are DIFFERENT characters, for the same reason parseReachedType has
 * three states: "the provider stopped sending this field" and "the provider sent it as null" are
 * different events, and a drift signal that cannot tell them apart cannot say what changed.
 *
 * `?` is the escape hatch for a type nobody anticipated. Without it a new type collapses into some
 * existing letter and the change reads as "no change".
 */
export function typeChar(value, present) {
  if (!present) return '-';
  if (value === null) return '0';
  if (value === undefined) return '-';
  if (Array.isArray(value)) return 'a';
  switch (typeof value) {
    case 'object': return 'o';
    case 'string': return 's';
    case 'number': return 'n';
    case 'boolean': return 'b';
    default: return '?';
  }
}

/**
 * Resolve a dotted path, reporting whether the leaf was actually PRESENT as an own property
 * (as opposed to reachable-but-undefined). Array indices are numeric segments.
 */
function at(root, path) {
  let node = root;
  const segs = path.split('.');
  for (let i = 0; i < segs.length; i++) {
    if (node === null || node === undefined) return { present: false, value: undefined };
    if (typeof node !== 'object') return { present: false, value: undefined };
    const seg = segs[i];
    const key = Array.isArray(node) ? Number(seg) : seg;
    const present = Array.isArray(node)
      ? Number.isInteger(key) && key >= 0 && key < node.length
      : Object.prototype.hasOwnProperty.call(node, seg);
    if (!present) return { present: false, value: undefined };
    node = node[key];
  }
  return { present: true, value: node };
}

/** @returns {string} one char per path, in the given order. Stable length = groupable in a query. */
export function shapeSig(root, paths) {
  return paths.map((p) => {
    const { present, value } = at(root, p);
    return typeChar(value, present);
  }).join('');
}

// ── Per-provider shape summaries ─────────────────────────────────────────────────────────────
//
// 🔴 THE PATH LISTS MIRROR WHAT THE PARSERS READ, and they live here rather than beside each
// parser so that bg/parse-*.js keeps importing nothing but ./api.js (the contract runner's section
// [5] asserts exactly that, and it is what keeps those modules loadable under Node). The coupling
// is real: if a parser starts reading a new field and this list is not updated, the new field shows
// up as an "unknown key" instead of a tracked one — noisy, but not silent, which is the failure
// direction to prefer.

// 🔴 KEYSET IDS ARE APPEND-ONLY-BY-NEW-ID, NOT APPEND-ONLY-IN-PLACE.
//
// A signature is POSITIONAL: the third character means "rate_limit.secondary_window" only because
// that path is third in the list. Add a watched path and every signature already stored changes
// meaning — silently, retroactively, and in a store that cannot be rewritten. Yesterday's `oo0ao0ss`
// and today's are then different shapes wearing the same string.
//
// So the id travels WITH the signature, and changing a list means MINTING A NEW ID (cg1 → cg2),
// never editing an existing one. The old id keeps describing the old history correctly and the
// consumer can group by (keyset, sig) without straddling a redefinition.
//
// test/fixtures/provider/obs-keysets.json pins these lists exactly, so editing one in place fails
// the contract and the failure names this rule. That guard is the enforcement — the comment alone
// would not survive a hurried edit.
//
// 🔴 `source` distinguishes ENDPOINTS, not providers: ChatGPT alone answers on /wham/usage and on
// accounts/check, and their signatures share nothing. Grouping by provider would mix them into one
// meaningless population.
export const DRIFT_KEYSETS = {
  // ChatGPT /backend-api/wham/usage — read by parseAdditionalLimits/parseModelAvailability/…
  cg1: [
    'rate_limit',
    'rate_limit.primary_window',
    'rate_limit.secondary_window',
    'additional_rate_limits',
    'model_usage',
    'rate_limit_reached_type',
    'plan_type',
    'account_id',
  ],
  // Claude usage — read by parseClaudeUsageWindows/resolveScopedWeeklySlots/normalizeExtraUsage
  cl1: [
    'five_hour',
    'seven_day',
    'limits',
    'extra_usage',
    'seven_day_omelette',
    'seven_day_sonnet',
  ],
  // 🔴 cl2 = cl1 + the six keys the unknown-key cap was hiding. A NEW ID, not an edit to cl1:
  // a signature is positional, so appending to cl1 would silently redefine every cl1 row already
  // stored in a store that cannot be rewritten (test/fixtures/provider/obs-keysets.json exists to
  // fail if anyone tries). Old rows keep meaning what they meant, and a reader MUST group by
  // (keyset, sig) so it never straddles the seam.
  //
  // 🪤 That last sentence is a REQUIREMENT ON WHOEVER QUERIES THIS, not a description of something
  // the code does. There is no drift read path yet; the writer stores keyset and sig in separate
  // blobs and nothing joins them. An earlier draft of this comment said "the consumer groups by
  // (keyset, sig)" as though that were enforced — it is not, and stating an unbuilt defence as a
  // built one is how the account-blob rule went unnoticed in #1358.
  //
  // WHY THESE SIX. Claude stopped sending Free-plan accounts a `five_hour`/`seven_day` value on
  // 2026-08-21 17:00 UTC — the keys arrive as explicit `null` and `limits` as `[]` (821 weekly
  // active users, inquiry #198). Answering "is the usage available anywhere else in this response"
  // needs the rest of the payload watched, and these are the ones carrying data on a paid account:
  //   nimbus_quill        — {utilization, resets_at, limit_dollars, used_dollars, …}, i.e. the
  //                         SAME shape as five_hour. Live value observed on Max 20x.
  //   spend               — {used, limit, percent, severity, enabled, cap, …}
  //   seven_day_opus / _cowork / _oauth_apps / _breakdown — the window family
  // 🪤 Watching a key is NOT reading it: nothing here is parsed into a snapshot. This says only
  // "tell us its type", which is what the question needs and all it is entitled to.
  cl2: [
    'five_hour',
    'seven_day',
    'limits',
    'extra_usage',
    'seven_day_omelette',
    'seven_day_sonnet',
    'nimbus_quill',
    'spend',
    'seven_day_opus',
    'seven_day_cowork',
    'seven_day_oauth_apps',
    'seven_day_breakdown',
  ],
  // Gemini jSf9Qc — positional: [planId, [[remaining, percent, windowType, [[sec, nanos]]], …]]
  gm1: ['0', '1', '1.0', '1.0.1', '1.0.3'],
};

// 🔴 EVERY FIELD ANY OF OUR CODE READS, not just the ones whose TYPE we watch.
//
// `known` answers "do we recognise this field", which is a different question from the keyset
// paths above ("whose type do we track"). Conflating them broke the signal: `email` and `user_id`
// are read by collect-chatgpt.js but were absent here, so EVERY ChatGPT rider reported them as
// newly-appeared fields. A constant entry in `unknown_keys` does not make the signal noisy — it
// makes it USELESS, because "a new key appeared" is then always true and a real addition is
// indistinguishable from the permanent floor.
//
// 🪤 Include a field even when it is only read as a FALLBACK (`usage.account_id || usage.user_id`).
// The question is "do we know about it", not "do we depend on it".
//
// test/provider-contract-guard.mjs section [6] derives the read set from the source and fails if
// this list does not cover it — the two were hand-maintained copies, which is exactly how they
// drifted apart in the first place.
export const CHATGPT_USAGE_KNOWN = [
  'rate_limit', 'additional_rate_limits', 'model_usage', 'rate_limit_reached_type',
  'plan_type', 'account_id',
  'email', 'user_id',
];
export const CLAUDE_USAGE_KNOWN = [
  'five_hour', 'seven_day', 'limits', 'extra_usage', 'seven_day_omelette', 'seven_day_sonnet',
  // Watched by cl2 but not parsed. `known` answers "do we recognise this field", which is exactly
  // what watching its type makes true — and leaving them out would keep them in `unknown_keys`
  // forever, which is the permanent-floor failure the comment above describes: when "a new key
  // appeared" is always true, a real addition is indistinguishable from the floor.
  'nimbus_quill', 'spend', 'seven_day_opus', 'seven_day_cowork', 'seven_day_oauth_apps',
  'seven_day_breakdown',
];

/**
 * @returns {{keyset: string, source: string, sig: string, unknownKeys: string[],
 *            rawBuckets: number, rawModels: number}}
 * 🔴 `rawBuckets`/`rawModels` are counted BEFORE the 5-item cap the parsers apply, which is the
 * whole point: the capped list cannot answer "did the provider start sending more".
 */
export function chatgptUsageShape(usage) {
  const arr = usage && usage.additional_rate_limits;
  const mu = usage && usage.model_usage;
  return {
    keyset: 'cg1',
    source: 'wham_usage',
    sig: shapeSig(usage, DRIFT_KEYSETS.cg1),
    unknownKeys: unknownTopLevelKeyReport(usage, CHATGPT_USAGE_KNOWN).names,
    unknownWithheld: unknownTopLevelKeyReport(usage, CHATGPT_USAGE_KNOWN).withheld,
    rawBuckets: Array.isArray(arr) ? arr.length : -1,
    rawModels: mu && typeof mu === 'object' && !Array.isArray(mu) ? Object.keys(mu).length : -1,
  };
}

/** Gemini jSf9Qc. Positional, so there are no object keys that could carry an identifier. */
export function geminiUsageShape(data) {
  const windows = Array.isArray(data) ? data[1] : null;
  return {
    keyset: 'gm1',
    source: 'jSf9Qc',
    sig: shapeSig(data, DRIFT_KEYSETS.gm1),
    unknownKeys: [],  // an array response has no field names to report
    unknownWithheld: 0,
    rawBuckets: Array.isArray(windows) ? windows.length : -1,
    rawModels: -1,
  };
}

/** Claude usage. */
export function claudeUsageShape(usageData) {
  const limits = usageData && usageData.limits;
  return {
    keyset: 'cl2',
    source: 'claude_usage',
    sig: shapeSig(usageData, DRIFT_KEYSETS.cl2),
    unknownKeys: unknownTopLevelKeyReport(usageData, CLAUDE_USAGE_KNOWN).names,
    unknownWithheld: unknownTopLevelKeyReport(usageData, CLAUDE_USAGE_KNOWN).withheld,
    rawBuckets: Array.isArray(limits) ? limits.length : -1,
    rawModels: -1,
  };
}

// ── Plan, the axis the signature must be cut by ───────────────────────────────────────────────

/** No plan was available for this observation. */
export const DRIFT_PLAN_UNKNOWN = 'unknown';
/** A plan WAS present but is not a label we can put in a GROUP BY key. */
export const DRIFT_PLAN_INVALID = 'invalid';
const DRIFT_PLAN_MAX_LEN = 32;
// Existing display labels: 'Free' 'Go' 'Plus' 'Pro 5x' 'Pro 20x' 'Team' 'Business' 'Enterprise'
// 'Work' 'AI Pro' 'AI Plus' 'AI Ultra 5x' 'AI Ultra 20x' 'Advanced'. Spaces and digits are part of
// the vocabulary, so the charset has to allow them.
const DRIFT_PLAN_RE = /^[A-Za-z0-9][A-Za-z0-9 .+()-]*$/;

/**
 * The plan label this observation belongs to.
 *
 * 🔴 THE SIGNATURE IS MEANINGLESS UNCUT BY PLAN. Free and Go legitimately report a 30-DAY window
 * where Plus reports 7 days, so one provider carries several correct signatures at once. Without
 * this axis a shift in the PLAN MIX — a marketing push bringing in Free users — moves signature
 * share while the provider changed nothing, and the alarm fires on our own growth.
 *
 * 🔴 IT TAKES THE RAW SIGNAL, NOT JUST THE LABEL, AND THAT IS THE WHOLE POINT.
 *
 * The collectors' labels are built for DISPLAY, and display sensibly guesses: chatgptPlanName()
 * maps a missing `plan_type` to 'Free' (`CHATGPT_PLAN_NAMES[(code || 'free')…]`), and Gemini's
 * fallback produces the string 'Plan null'. Feeding those labels straight in was measured to put
 * every unreadable plan into the **Free** bucket — the one plan whose 30-day window is the reason
 * this cut exists. "We could not read the plan" would have been counted as evidence about Free.
 *
 * So presence and validity are judged on the SIGNAL the label was derived from, and the label is
 * only trusted once that signal is there. Each collector passes what its own label rests on; a
 * numeric signal (Gemini's planId) is stringified by the caller so this rule stays uniform.
 *
 * 🪤 The unit was correct in isolation and the COMPOSITION was not — the fourth time that gap
 * appeared in this feature. test/drift-carrier-guard.mjs drives the real collector labels through
 * this function for exactly that reason.
 *
 * Three states, for the same reason parseReachedType has three:
 *   'unknown' — no signal (a failure path, an unauthenticated cycle, a field the provider dropped)
 *   'invalid' — a signal was present but is not usable as a GROUP BY key
 *   the label  — spelled as the collectors spell it, so it joins the snapshot's own `plan` with no
 *                second mapping to keep in sync
 */
export function normalizeDriftPlan(label, raw) {
  if (raw === null || raw === undefined) return DRIFT_PLAN_UNKNOWN;
  // A non-string signal is a client bug, NOT an absence — `0` and `false` reached here as
  // `plan_type` and both used to become 'Free'.
  if (typeof raw !== 'string') return DRIFT_PLAN_INVALID;
  if (!raw.trim()) return DRIFT_PLAN_UNKNOWN;
  if (label === null || label === undefined || label === '') return DRIFT_PLAN_UNKNOWN;
  if (typeof label !== 'string') return DRIFT_PLAN_INVALID;
  const trimmed = label.trim();
  if (!trimmed) return DRIFT_PLAN_UNKNOWN;
  if (trimmed.length > DRIFT_PLAN_MAX_LEN) return DRIFT_PLAN_INVALID;
  if (!DRIFT_PLAN_RE.test(trimmed)) return DRIFT_PLAN_INVALID;
  // 🔴 A READABLE label that SPELLS a sentinel is unrepresentable, and it must not be returned as
  // a label. The reader's first cut on this field is `plan = 'unknown'` = "we could not read it",
  // so an account whose label trims to that string would be counted as a parse failure forever.
  //
  // It is reachable: the collectors capitalize their FALLBACK label, but `capitalizeFirst(' free')`
  // uppercases the leading SPACE and leaves the word lowercase — then the trim above turns
  // ' unknown' into exactly the sentinel. Found by Codex; capitalization is not a defence.
  //
  // `invalid` (not `unknown`) is the honest answer: the signal WAS readable, we simply cannot
  // encode it unambiguously — so it must not dilute the absent-signal bucket.
  //
  // Compared case-SENSITIVELY on purpose. Gemini deliberately title-cases an unrecognised tier so
  // a NEW tier surfaces in the data (parse-gemini.js), and 'Unknown' is a legitimate, unambiguous
  // label; folding it in here would delete exactly the signal that fallback exists to produce.
  if (trimmed === DRIFT_PLAN_UNKNOWN || trimmed === DRIFT_PLAN_INVALID) return DRIFT_PLAN_INVALID;
  return trimmed;
}

// ── Drift event buffer ───────────────────────────────────────────────────────────────────────
//
// 🔴 WHY A BUFFER AT ALL. A parse failure produces NO snapshot POST, so there is nothing for the
// observation to ride on — which is the structural hole #1322 names. Events are held locally and
// flushed onto requests that are ALREADY GOING OUT.
//
// 🔴 THE CARRIER INVARIANT, and it is the reason this is safe:
//
//     FIELDS ARE ADDED TO THE BODY OF REQUESTS THAT ALREADY FIRE.
//     WHICH REQUESTS FIRE, AND WHEN, IS NEVER CHANGED.
//
// The rider goes on the snapshot POST and on the heartbeat — both dual-carrier, so a Gemini
// failure still reports via a Claude success, and an install where everything fails still reports
// via the heartbeat. What must NOT happen is widening a send gate to get more coverage:
// postHeartbeat is gated on `accountCache?.email`, and installs that are silent today would then
// start heartbeating on the SHARED API KEY, enlarging the `hb_gate` shadow population that #758's
// pending HEARTBEAT_IDENTITY_ENFORCE decision rests on. collect.js says it directly — "Fixing one
// thing must not redefine the population another decision rests on". An observation that changes
// who is observed has broken the thing it was measuring.
//
// 🔴 AND WHY THEY EXPIRE. AE's writeDataPoint has NO timestamp parameter: every point is stamped
// at ingestion and cannot be backdated (worker/src/services/ae.ts header). So a drained event is
// recorded as happening NOW, whenever it was actually observed. Two consequences, both bad if
// ignored: an alarm fires today for an incident that ended days ago, and "when did the provider
// change" — the single most valuable output of drift detection — becomes unanswerable.
//
// So every event carries an AGE BUCKET computed at drain time, and anything older than the TTL is
// DISCARDED rather than sent. A stale event's information value is lower than its power to
// mislead, and a real provider change keeps producing fresh events anyway.

/** Events older than this are dropped at drain time rather than mis-stamped as current. */
export const DRIFT_EVENT_TTL_MS = 48 * 60 * 60 * 1000;
/** Distinct (provider, stage, code, sig) entries kept. Beyond this the oldest are dropped. */
export const DRIFT_BUFFER_MAX = 12;
/** Counters stop here; see noteDriftAttempt. */
export const DRIFT_COUNTER_MAX = 9999;

/**
 * Coarse age of an observation at the moment it is drained.
 * Coarse on purpose: the consumer needs "is this a fresh signal or a backlog" and nothing finer,
 * and a precise age would be one more value riding along for no decision.
 */
export function driftAgeBucket(observedAt, now) {
  const ageMs = now - observedAt;
  if (!(ageMs >= 0)) return 'fresh';           // clock went backwards; not worth a second bucket
  if (ageMs < 60 * 60 * 1000) return 'fresh';
  if (ageMs < 6 * 60 * 60 * 1000) return '6h';
  if (ageMs < 24 * 60 * 60 * 1000) return '24h';
  return '48h';
}

/**
 * Fold an event into the buffer, deduped on its identity.
 *
 * Dedup is what bounds this: a provider that fails every cycle for a day produces ONE entry with a
 * count, not 96 entries. The cap below is therefore a backstop for many DISTINCT failures, not for
 * a repeated one.
 *
 * @returns {Array} a new buffer (the input is not mutated).
 */
export function mergeDriftEvent(buffer, event, now) {
  // 🔴 Entries are COPIED, not just the array. `buffer.slice()` is shallow, so folding a repeat
  // into `found` would reach through and mutate the caller's own objects — and the caller here is
  // a chrome.storage read, so the "old" value and the "new" value would silently become the same
  // object and any before/after comparison would compare a thing to itself.
  const list = (Array.isArray(buffer) ? buffer : []).map((e) => ({ ...e }));
  const key = `${event.provider}|${event.stage}|${event.code}|${event.sig || ''}`;
  const foundAt = list.findIndex((e) => e.k === key);
  const found = foundAt >= 0 ? list[foundAt] : null;
  // 🔴 A RECURRENCE PAST THE TTL STARTS A NEW OBSERVATION; IT DOES NOT FOLD INTO THE DEAD ONE.
  //
  // Expiry is measured from `first`, so an entry older than the TTL is already un-drainable. Folding
  // a fresh occurrence into it (which only bumped `last`) inherited that dead `first` — so a failure
  // recurring every cycle for a week produced ONE entry that was permanently expired and never sent.
  // A PERSISTENT provider outage was the case least likely to be reported, which inverts the whole
  // point. Codex reproduced it: two drains, both `events_dropped: 1`, no event ever emitted.
  if (found && now - found.first >= DRIFT_EVENT_TTL_MS) {
    list.splice(foundAt, 1);
  } else if (found) {
    found.n = Math.min((found.n || 1) + 1, DRIFT_COUNTER_MAX);
    found.last = now;
    // 🔴 UNKNOWN KEYS ARE MERGED, NOT LEFT AT THE FIRST OCCURRENCE'S VALUE.
    //
    // The identity key is (provider, stage, code, sig), and `sig` describes only the WATCHED paths
    // — unknown keys are by definition not among them. So two occurrences that dedup together can
    // carry DIFFERENT new keys, and keeping the first one's set silently discards the second's.
    // That is the same "a new key appeared and nobody hears it" failure this field exists to
    // prevent, one level in.
    const union = new Set([...(found.keys || []), ...(Array.isArray(event.unknownKeys) ? event.unknownKeys : [])]);
    found.keys = [...union].sort().slice(0, 5);
    // The MAX, not the latest: the count is a floor on "how many unnamed new keys showed up", and
    // taking the latest would let one clean cycle erase what an earlier one saw.
    found.withheld = Math.max(found.withheld || 0, Number(event.unknownWithheld) || 0);
    return list;
  }
  list.push({
    k: key,
    provider: event.provider,
    stage: event.stage,
    code: event.code,
    sig: event.sig || '',
    keys: Array.isArray(event.unknownKeys) ? event.unknownKeys.slice(0, 5) : [],
    // 🔴 Carried per EVENT, not only per shape. The approval to send unknown key NAMES rested on
    // two things, and this is one of them: a key the filter rejects is still COUNTED, so "something
    // new appeared and we would not name it" never reads as "nothing appeared". Without it, a
    // response whose only new keys were filtered is indistinguishable on this path from one with no
    // new keys at all — the guarantee silently stops holding for every event-carried observation.
    withheld: Number(event.unknownWithheld) || 0,
    n: 1,
    first: now,
    last: now,
  });
  // Oldest-first eviction, by when the entry was FIRST seen: a long-running failure that keeps
  // getting folded into one entry should not be evicted by a burst of new distinct ones.
  if (list.length > DRIFT_BUFFER_MAX) {
    list.sort((a, b) => a.first - b.first);
    return list.slice(list.length - DRIFT_BUFFER_MAX);
  }
  return list;
}

/** Drop entries the TTL has expired. Exported so the storage layer can actually REMOVE them —
 * drainDriftBuffer only decides what to SEND, and an expired entry that is never deleted keeps
 * occupying a buffer slot and (before the fix in mergeDriftEvent) kept absorbing recurrences. */
export function purgeExpired(buffer, now) {
  return (Array.isArray(buffer) ? buffer : []).filter((e) => now - e.first < DRIFT_EVENT_TTL_MS);
}

/**
 * Split a buffer into what may be sent now and what must be kept.
 *
 * @returns {{events: Array, kept: Array, dropped: number}}
 *   `events` carries the age bucket and is ready for the payload; `kept` is always empty today
 *   (everything within the TTL is sent) but the shape leaves room for a future partial drain
 *   without changing callers. `dropped` counts TTL-expired entries, so "we discarded stale
 *   observations" is itself visible rather than silent.
 */
export function drainDriftBuffer(buffer, now) {
  const list = Array.isArray(buffer) ? buffer : [];
  const events = [];
  let dropped = 0;
  for (const e of list) {
    if (now - e.first >= DRIFT_EVENT_TTL_MS) { dropped++; continue; }
    events.push({
      provider: e.provider,
      stage: e.stage,
      code: e.code,
      sig: e.sig,
      ...(e.keys && e.keys.length ? { unknown_keys: e.keys } : {}),
      ...(e.withheld ? { unknown_keys_withheld: e.withheld } : {}),
      count: e.n,
      age: driftAgeBucket(e.first, now),
    });
  }
  return { events, kept: [], dropped };
}

/**
 * Fold one collection attempt into the per-provider counters.
 *
 * 🔴 COUNTERS SATURATE, THEY DO NOT WRAP OR RESET THEMSELVES. They are cleared when a report
 * actually lands; if reporting keeps failing they would otherwise grow without bound. At the cap
 * the install has gone a very long time without reporting, and `capped` says so — the consumer
 * reads attempts as a FLOOR from then on, rather than reading a wrapped number as a small one.
 *
 * @returns {object} a new counter record (the input is not mutated).
 */
// 🔴 THESE COUNTS ARE A FLOOR, NOT AN EXACT TALLY — say so wherever they are read.
// Two known sources of imprecision, both accepted deliberately (this feature detects SHAPE CHANGE,
// not exact rates): the storage record is read-modify-written without serialization, so a tab
// collection overlapping a scheduled one can lose an increment; and delivery is not exactly-once,
// so a lost 2xx re-sends on the next carrier. Anyone reading `successes / attempts` as a precise
// ratio — an alarm threshold especially — will be wrong in the direction of over-reacting.
export function noteDriftAttempt(counters, outcome) {
  const c = {
    attempts: 0, successes: 0, parse_fails: 0, capped: false,
    ...(counters && typeof counters === 'object' ? counters : {}),
  };
  const bump = (n) => Math.min(n + 1, DRIFT_COUNTER_MAX);
  const next = {
    attempts: bump(c.attempts),
    successes: outcome === 'success' ? bump(c.successes) : c.successes,
    parse_fails: outcome === 'parse_fail' ? bump(c.parse_fails) : c.parse_fails,
    capped: c.capped,
  };
  if (next.attempts >= DRIFT_COUNTER_MAX) next.capped = true;
  return next;
}

/** Quiet period between flushes for a provider whose signature has not moved. */
export const DRIFT_FLUSH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Should this provider's observation go out now?
 *
 * 🔴 TWO TRIGGERS, AND THEY ANSWER DIFFERENT QUESTIONS. A CHANGED SIGNATURE FLUSHES IMMEDIATELY —
 * that is the drift event itself, and delaying it by up to an hour would blunt the one signal the
 * whole feature exists for. An UNCHANGED signature flushes hourly, which is what keeps the volume
 * bounded: without it every collection cycle would carry a rider saying nothing changed.
 *
 * The first observation for a provider always flushes: there is no previous signature to compare,
 * and "we have never seen this install's shape" is worth knowing promptly.
 *
 * @returns {{flush: boolean, reason: string}} `reason` rides along so the consumer can tell a
 *   drift-triggered row from a routine heartbeat row — otherwise a burst of hourly rows and a
 *   burst of real changes look identical in the data.
 */
export function shouldFlushDrift(state, sig, now) {
  if (!state || typeof state !== 'object') return { flush: true, reason: 'first' };
  if (state.lastSig !== sig) return { flush: true, reason: 'sig_change' };
  const since = now - (typeof state.lastFlushAt === 'number' ? state.lastFlushAt : 0);
  if (!(since >= 0)) return { flush: true, reason: 'clock' };
  if (since >= DRIFT_FLUSH_INTERVAL_MS) return { flush: true, reason: 'interval' };
  return { flush: false, reason: 'quiet' };
}

/**
 * How long the counters being flushed have been accumulating.
 *
 * 🔴 THIS IS WHAT MAKES THE COUNTERS READABLE AT ALL. AE stamps every point at ingestion and cannot
 * backdate, so "12 attempts, 0 successes" carries no rate until you know whether it covers the last
 * hour or the last three days. With the window, the consumer divides; without it, a long-silent
 * install and a currently-failing one produce the same numbers.
 *
 * It does NOT replace dropping stale events — a mis-stamped OLD event is still wrong about when it
 * happened, and no window field fixes that. The two mechanisms cover different halves: the window
 * makes aggregate counters divisible, the TTL keeps individual events honest.
 */
export function flushWindowSeconds(state, now) {
  const start = state && typeof state.windowStart === 'number' ? state.windowStart : null;
  if (start === null) return 0;
  const secs = Math.round((now - start) / 1000);
  return secs > 0 ? secs : 0;
}

/** The state to persist after a flush actually lands. Pure; the caller does the storage write. */
export function nextDriftState(sig, now) {
  return { lastSig: sig, lastFlushAt: now, windowStart: now };
}
