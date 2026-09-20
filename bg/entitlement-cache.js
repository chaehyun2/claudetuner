// The billing entitlement cache (`ct_entitlement`) — one shape, two writers, and since 1.32.0 a
// NEGATIVE entry as well. Extracted from background.js so test/entitlement-cache-guard.mjs can run
// it with a storage stub and a scripted fetch instead of pattern-matching the SW.
//
// Shape in storage.local: `{ plan: 'pro'|'free', at, email, stale?: true }`.
//   · a CONFIRMED entry (no `stale`) is the server's answer, trusted for ENTITLEMENT_TTL_MS (24h);
//   · a NEGATIVE entry (`stale: true`, always 'free') records that the last fetch FAILED — 401 for
//     an install without an ext_token, 5xx, network, a bad body — and is trusted for
//     ENTITLEMENT_NEG_TTL_MS (1h). Before it existed, every reader re-fetched on every call while
//     the failure lasted: the ad gate asks on every rotation tick (3 min, up to three sidebars) so
//     an install that can never be authenticated hammered /api/users/entitlement ~20–60×/hour
//     per sidebar (1.32.0 batch review). Either kind is valid only for the account it names.
//
// Readers: GET_ENTITLEMENT (folders gate, ad gate — CORE.isAdFree, which reads `plan` only: a
// negative entry is 'free' → ads as before, fail open). Writers: resolve() (its own fetch of
// /api/users/entitlement) and syncFromStatus() (the compare controller's write-through from
// GET /api/compare/status `pro`, plan compare-quota-premium §2).
//
// 🔴 A failure never demotes a confirmed Premium. The non-force path answers from a fresh
// confirmed entry before fetching, so only `force` can reach a failed fetch while one exists — and
// writeNegative() keeps it. A transient error is "no answer", not "free".

export const ENTITLEMENT_CACHE_KEY = 'ct_entitlement';
export const ENTITLEMENT_TTL_MS = 24 * 60 * 60 * 1000;
export const ENTITLEMENT_NEG_TTL_MS = 60 * 60 * 1000;

/**
 * @param {object} deps
 * @param {{get: Function, set: Function}} deps.storage  chrome.storage.local (or a stub)
 * @param {(email: string) => Promise<{ok: boolean, plan?: 'pro'|'free'}>} deps.fetchEntitlement
 *   the network step: resolves `{ok:false}` on a non-2xx, throws on transport/body failure.
 * @param {() => number} [deps.now]
 */
export function createEntitlementCache({ storage, fetchEntitlement, now = Date.now }) {
  // One fetch per account at a time: four surfaces asking on first load used to issue four
  // requests (the 1.5 s UI timeout does not cancel any of them). Later callers await the same one.
  // Keyed by account (Codex 1R #1): a single slot let X → Y → X start three fetches.
  const inflight = new Map(); // email → promise
  // Every cache WRITE goes through one queue (Codex 1R #2): writeNegative is read-check-write, and
  // a status write-through landing between its read and its write was overwritten by the failure.
  let writes = Promise.resolve();
  const serial = (fn) => { const p = writes.then(fn, fn); writes = p.catch(() => {}); return p; };

  async function readEntry() {
    try { return (await storage.get(ENTITLEMENT_CACHE_KEY))[ENTITLEMENT_CACHE_KEY] || null; } catch { return null; }
  }
  /** The entry when it belongs to `email` and is within ITS TTL (1h negative / 24h confirmed); null otherwise. */
  async function readFresh(email) {
    const cached = await readEntry();
    if (!cached || !email || cached.email !== email) return null;
    const ttl = cached.stale === true ? ENTITLEMENT_NEG_TTL_MS : ENTITLEMENT_TTL_MS;
    if (!(now() - (cached.at || 0) < ttl)) return null;
    return { plan: cached.plan === 'pro' ? 'pro' : 'free', stale: cached.stale === true };
  }
  function write(plan, email) {
    return serial(() => storage.set({ [ENTITLEMENT_CACHE_KEY]: { plan: plan === 'pro' ? 'pro' : 'free', at: now(), email } }));
  }
  /**
   * Record a failed fetch — unless a CONFIRMED answer for this account is still fresh (kept, pro
   * or free: a failure says nothing the server did not already say, and replacing a confirmed
   * free with a 1h negative one would only bring the next fetch forward — Codex 1R #3).
   */
  function writeNegative(email) {
    return serial(async () => {
      const fresh = await readFresh(email);
      if (fresh && !fresh.stale) return;
      await storage.set({ [ENTITLEMENT_CACHE_KEY]: { plan: 'free', at: now(), email, stale: true } });
    });
  }

  /**
   * The GET_ENTITLEMENT answer: `{plan, cached?, stale?}`. Fails CLOSED — never a 'pro' the server
   * did not confirm this call or within the confirmed TTL.
   */
  async function resolve({ email, force = false }) {
    if (!force) {
      const cached = await readFresh(email);
      if (cached) return { plan: cached.plan, cached: true, ...(cached.stale ? { stale: true } : {}) };
    }
    if (!email) return { plan: 'free', stale: true }; // no account to ask about — nothing to cache either
    if (!inflight.has(email)) {
      const promise = (async () => {
        try {
          const r = await fetchEntitlement(email);
          if (!r || r.ok !== true) { await writeNegative(email); return { plan: 'free', stale: true }; }
          const plan = r.plan === 'pro' ? 'pro' : 'free';
          await write(plan, email);
          return { plan };
        } catch {
          try { await writeNegative(email); } catch { /* storage unavailable: nothing to remember it with */ }
          return { plan: 'free', stale: true };
        } finally {
          if (inflight.get(email) === promise) inflight.delete(email);
        }
      })();
      inflight.set(email, promise);
    }
    return inflight.get(email);
  }

  /**
   * Write-through from a SUCCESSFUL compare status (its `pro` is the same isPro() the endpoint
   * reports): the cache takes it with a fresh timestamp when it disagrees, is missing / expired /
   * another account's — or is only a NEGATIVE entry (a confirmed answer outranks a remembered
   * failure). Never throws.
   */
  async function syncFromStatus(email, pro) {
    try {
      if (!email) return;
      const plan = pro === true ? 'pro' : 'free';
      const cached = await readFresh(email);
      if (cached && cached.plan === plan && !cached.stale) return; // already says so, confirmed, fresh
      await write(plan, email);
    } catch { /* the cache is a convenience; the status is not */ }
  }

  return { readFresh, write, writeNegative, resolve, syncFromStatus };
}
