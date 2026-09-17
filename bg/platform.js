// What this browser actually is (#1445 step B).
//
// ── WHY THE CLIENT COLLECTS THIS WHEN THE SERVER ALREADY PARSES THE USER-AGENT ────────────────
// The server-side parse (worker/src/utils/client-env.ts) is trustworthy but blunt, because Chrome's
// UA reduction deliberately removed the detail. Measured in this extension's own service worker on
// one machine, at the same instant:
//
//     navigator.userAgent   →  "... Intel Mac OS X 10_15_7 ..."      ← frozen for EVERY Mac
//     getHighEntropyValues  →  platformVersion: "26.6.2"             ← what it actually runs
//
// 🔴 ONLY THE MAJOR IS KEPT: `26.6.2` is stored as `26`. The generation answers "which OS produced
// this data"; the patch level does not, and it would subdivide the formerly-frozen Mac population
// beside identifiers these same requests already carry. Collect the answer, not the resolution.
//
// Same for the brand: Brave and Vivaldi ship the stock Chrome UA on purpose, so the server counts
// them as Chrome and no server-side change can fix that. `userAgentData.brands` names them.
// That gap — real OS version, real brand — is the entire reason this file exists. Everything the
// UA CAN answer is left to the server, where it cannot be forged by the caller.
//
// 🔴 THIS IS A CLAIM, NOT A FACT, AND THE SERVER MUST TREAT IT THAT WAY. It travels in the request
// BODY, and the shared public API key means anyone can POST a body. 🔴 STATED AS A REQUIREMENT, NOT
// AS FACT: no server code reads this field yet (#1445 step B2). When one is written it must store
// these under `claimed_` and must never let them overwrite the values derived from the request's
// own headers. Same rule as bg/install-beacon.js. If you ever find yourself comparing a claimed
// value to a header-derived one and believing the claim, stop.
// 🪤 And do not over-read the header-derived side either: a non-browser caller can forge a
// User-Agent too. Server parsing is normalisation, not an authenticated machine fact.
//
// ── AVAILABILITY IS MEASURED, NOT ASSUMED ─────────────────────────────────────────────────────
// Both APIs were verified present in the MV3 service worker by driving the real extension under
// Playwright (test/ext-platform-probe.mjs). This matters because reasoning about runtime surfaces
// from source has been wrong repeatedly here. Still, every read below is individually guarded:
// `getHighEntropyValues` is Chromium-only and can reject, and a browser that removes it must
// degrade to "we don't know", never to a wrong answer or a thrown collection cycle.

/**
 * 🔴 A HARD DEADLINE ON THE WHOLE READ, NOT ON ONE CALL. Every source here returns a promise, and a
 * promise that never settles is not an error any `catch` can see: `getPlatformEnv()` simply stays
 * pending. It is awaited INSIDE the payload builders, above local-status handling and the send
 * gate, and Claude cycles are serialized behind `_collectChain` — so one non-settling
 * `getHighEntropyValues()` or `chrome.storage` call would stall collection for the whole session,
 * silently, with no error anywhere. A review reproduced exactly that by injecting
 * `new Promise(() => {})`. Service-worker termination is the same shape: the await never resolves
 * and the cycle disappears, which Chrome's lifecycle docs say to expect and survive.
 *
 * Telemetry may be absent. It may never be the reason a snapshot did not send.
 */
const READ_DEADLINE_MS = 1500;

/** Resolve to `fallback` if `p` has not settled in `ms`. Never rejects; always clears its timer. */
function withDeadline(p, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(p).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Cache key. One value per install; the platform does not change between polls. */
const CACHE_KEY = 'platform_env';
/**
 * How long a cached reading stands. Not "forever": an OS upgrade or a browser update changes these
 * and a permanently cached value would report the version the user installed on. A day is far
 * longer than the poll interval (so the cost is ~one read/day) and far shorter than the cadence of
 * OS upgrades.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Is this stored entry one WE wrote, recently, in the shape we write?
 *
 * 🔴 `Date.now() - at < TTL` alone is not a freshness test: a negative age passes it. An entry
 * written while the clock was a year fast survives for a year AND a day after the clock is
 * corrected — reproduced by a review, which watched a future-dated Windows/Edge reading served on a
 * Mac. A restored or copied profile is the same hazard by another route (this is `storage.local`,
 * so Chrome profile SYNC is not a path, but a roaming or restored profile is).
 *
 * The shape check is the other half: `{at, v: 'legacy-format'}` used to be returned verbatim, so a
 * future format change — or anything else writing this key — would flow straight into the payload.
 */
function isFreshEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.at !== 'number') return false;
  const age = Date.now() - e.at;
  if (!(age >= 0 && age < CACHE_TTL_MS)) return false;       // negative = clock moved; distrust it
  const v = e.v;
  // `!v` is the only necessary type test. Object.keys() throws on null/undefined but is harmless on
  // a string, a number or an array, and the allowlist below rejects every one of them — their keys
  // are indices, or there are none. A mutation deleting a separate `typeof v !== 'object'` clause
  // stayed GREEN for exactly that reason: it was redundant, not load-bearing. A guard nothing can
  // break is not a guard; it is a line that makes the real ones harder to find.
  if (!v) return false;
  const keys = Object.keys(v);
  if (!keys.length || !keys.every((k) => ['os', 'osMajor', 'browser'].includes(k))) return false;
  return keys.every((k) => typeof v[k] === 'string' && v[k].length > 0 && v[k].length <= 32);
}

/** Brands Chromium injects that name no product. `Not:A-Brand` varies its punctuation by design. */
function isRealBrand(brand) {
  return !!brand && !/not[^a-z0-9]*a[^a-z0-9]*brand/i.test(brand);
}

/**
 * Pick the product from a userAgentData brand list (the low-entropy `brands`).
 *
 * 🔴 `Chromium` is the ENGINE, not the product, and every fork reports it alongside its own name —
 * so taking the first real brand would label Brave, Edge and Vivaldi all as "Chromium" and throw
 * away exactly the distinction this file exists to capture. Prefer any non-Chromium brand; fall
 * back to Chromium only when it is the only thing on offer (plain Chromium builds, and the headless
 * build CI runs under, which is why the fallback is exercised rather than theoretical).
 */
// 🔴 Exported for test/ext-platform-probe.mjs. The live browser offers exactly ONE brand list, so
// every interesting branch here (a fork beside Chromium, an implausible version) is unreachable
// from the running environment — mutations to this function stayed GREEN until the probe could
// feed it synthetic lists. Exporting the real function is the alternative to the probe re-creating
// a copy of it, which would test the copy.
export function pickBrand(list) {
  const real = (Array.isArray(list) ? list : []).filter((b) => isRealBrand(b && b.brand));
  // 🔴 A DENYLIST, NOT A POSITION. Masking browsers report a BASE brand and add their own, and
  // Chromium shuffles the list order deliberately — so neither "the first non-Chromium entry" nor
  // "the last one" is reliable. Vivaldi masks as `Google Chrome` and appends `Vivaldi`; picking the
  // first non-Chromium entry returned `Google Chrome 140` and threw away the only thing that
  // identified the browser. Drop the generic bases whenever anything more specific is present.
  const GENERIC = /^(chromium|google chrome)$/i;
  const specific = real.filter((b) => !GENERIC.test(b.brand));
  const product = specific[0] || real.find((b) => /^google chrome$/i.test(b.brand)) || real[0];
  if (!product) return null;
  const major = String(product.version || '').split('.')[0];
  const n = Number(major);
  // Same bound as the server parser: a version we cannot believe is dropped rather than repeated,
  // and the brand alone is still useful. Keeps the stored label low-cardinality.
  return Number.isInteger(n) && n >= 1 && n <= 999 ? `${product.brand} ${n}` : product.brand;
}

/** Read everything, guarding each source separately so one failure does not lose the others. */
async function readPlatform() {
  const out = {};

  // chrome.runtime.getPlatformInfo: no permission required, and the ONLY source here that is not
  // derived from a UA string at all. 'mac' | 'win' | 'linux' | 'cros' | 'android' | 'openbsd' | ...
  try {
    const info = await chrome.runtime.getPlatformInfo();
    if (info && info.os) out.os = String(info.os).slice(0, 16);
  } catch { /* older/other runtimes: leave absent, never guess */ }

  try {
    const uad = typeof navigator !== 'undefined' ? navigator.userAgentData : null;
    if (uad) {
      // 🔴 THE BRAND COMES FROM THE LOW-ENTROPY LIST, ON PURPOSE. `brands` already carries the
      // product name and its MAJOR version, which is the whole label we keep — so asking
      // getHighEntropyValues for `fullVersionList` would buy nothing but full version strings we
      // immediately discard. Requesting data you then throw away is the part that is hard to
      // justify to a user, and it needs no promise and no permissions policy.
      const brand = pickBrand(uad.brands);
      if (brand) out.browser = brand.slice(0, 32);

      // The ONE thing no low-entropy source can answer, and the reason this file exists: the UA's
      // OS version is frozen (macOS is always `10_15_7`). 🔴 MAJOR ONLY — `26.6.2` becomes `26`.
      // The patch level would subdivide the formerly-frozen Mac population by release AND patch
      // beside identifiers these requests already carry, which is a fingerprinting increment with
      // no diagnostic use: "which OS generation produced this" is answered by the major alone.
      // 🪤 On Windows this is the UA-CH platform CONTRACT number, not a Windows version — Windows
      // 11 reports `13`. Read the field as "the platform generation this browser reports", and map
      // it before showing it to anyone. That is why it is named osMajor, not osVersion.
      if (typeof uad.getHighEntropyValues === 'function') {
        // 🔴 Its own try/catch. This await is the one call here documented to reject, and when the
        // rejection unwound to the outer catch it took the brand with it — the exact case the
        // low-entropy read above was written for. Fixed once; kept separate so it cannot regress.
        try {
          const hev = await uad.getHighEntropyValues(['platformVersion']);
          const major = Number(String((hev && hev.platformVersion) || '').split('.')[0]);
          if (Number.isInteger(major) && major >= 1 && major <= 999) out.osMajor = String(major);
        } catch { /* rejected or unavailable: the OS generation stays unknown, never guessed */ }
      }
    }
  } catch { /* unavailable: the fields stay absent */ }

  return out;
}

/**
 * This install's platform, cached.
 *
 * 🔴 NEVER THROWS AND NEVER BLOCKS A COLLECTION CYCLE. It is called from inside the payload
 * builders, so a rejection here would fail the snapshot POST that carries it — telemetry breaking
 * the thing it describes. Every failure path returns `null`, and `null` must reach the server as an
 * ABSENT field rather than an empty object, so that "we could not read it" stays distinguishable
 * from "there is nothing here".
 */
export async function getPlatformEnv() {
  // 🔴 The deadline wraps EVERYTHING, storage included — see READ_DEADLINE_MS. A timeout here is
  // indistinguishable from "unreadable", which is the correct reading: we do not know.
  return withDeadline(readCachedOrFresh(), READ_DEADLINE_MS, null);
}

async function readCachedOrFresh() {
  try {
    const cached = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY];
    if (isFreshEntry(cached)) return cached.v;
    const v = await readPlatform();
    if (!Object.keys(v).length) return null;   // nothing readable: do not cache an empty answer
    await chrome.storage.local.set({ [CACHE_KEY]: { at: Date.now(), v } });
    return v;
  } catch {
    return null;
  }
}

/**
 * The payload fragment, for spreading into a snapshot body.
 *
 * 🔴 ABSENT, NOT NULL. `platform: await getPlatformEnv()` serialized `{"platform": null}` whenever
 * the reading failed, which contradicts the contract every other optional field here follows and
 * which a server would have to special-case. "We could not read it" is expressed by the field not
 * being there — the same rule bg/install-beacon.js applies with compact().
 */
export async function platformField() {
  const p = await getPlatformEnv();
  return p ? { platform: p } : {};
}
