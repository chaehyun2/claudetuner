// Kept ChatGPT bearers, one per account, so an account can still be read after the user switches the
// web app to another one (#2620).
//
// WHY. /wham/usage answers only for the account its bearer names, and the bearer the browser holds is
// the ACTIVE account's. A bearer minted while account A was active keeps reading A after the switch,
// until it expires (~23h, measured 2026-10-27). Keeping it is the only way to read A that does not
// touch the `_account` cookie — which this extension must never set (memory chatgpt-multiorg: it once
// stranded a user on a deactivated workspace).
//
// 🔴 WHERE IT LIVES. `chrome.storage.session`: memory only, gone when the browser closes, readable by
// the service worker and extension pages but not content scripts (TRUSTED_CONTEXTS is the default
// access level). Never written to `storage.local`/`sync`, never sent to our server, never logged.
//
// 🔴 WHOSE IT IS. Each entry records the ChatGPT user it was minted for; a read uses it only while the
// browser is signed in as that same user (`usage.user_id`). Another person signing in on this browser
// must never have the previous person's accounts read and filed under their own identity.
import { decodeJwtExpiry } from './parse-chatgpt.js';

const STORE_KEY = 'ctChatgptKeptTokens';
// Stop using a token a little before it actually expires: a read that races the expiry costs a 401.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
// Bound the map: accounts beyond this are not worth a background read.
const MAX_KEPT = 8;

function sessionArea() {
  return chrome.storage && chrome.storage.session ? chrome.storage.session : null;
}

async function readAll() {
  const area = sessionArea();
  if (!area) return {};
  try {
    const r = await area.get({ [STORE_KEY]: {} });
    const v = r && r[STORE_KEY];
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Every read-modify-write runs one at a time: the collector keeps and forgets tokens for several
// accounts in one cycle, and two interleaved writes would silently drop one of them.
let _queue = Promise.resolve();
function serialized(fn) {
  const run = () => fn();
  const p = _queue.then(run, run);
  _queue = p.catch(() => {});
  return p;
}

async function writeAll(map) {
  const area = sessionArea();
  if (!area) return;
  try { await area.set({ [STORE_KEY]: map }); } catch { /* memory store unavailable — nothing kept */ }
}

/** Live entries only: unexpired (with margin) and well-formed. Pure. */
export function liveKeptTokens(map, now) {
  const out = {};
  for (const [key, e] of Object.entries(map && typeof map === 'object' ? map : {})) {
    if (!e || typeof e.token !== 'string' || typeof e.userId !== 'string' || !e.userId) continue;
    if (typeof e.exp !== 'number' || e.exp - EXPIRY_MARGIN_MS <= now) continue;
    out[key] = e;
  }
  return out;
}

/**
 * Keep the bearer that just read `orgKey`, for `userId`. A token whose expiry cannot be read is not
 * kept — without it there is no bound on how long a stale credential would be retried.
 */
export async function keepChatGPTToken(orgKey, token, userId, now = Date.now()) {
  if (typeof orgKey !== 'string' || !orgKey || typeof token !== 'string' || !token) return;
  if (typeof userId !== 'string' || !userId) return;
  const exp = decodeJwtExpiry(token);
  if (exp == null || exp - EXPIRY_MARGIN_MS <= now) return;
  return serialized(async () => {
  const map = liveKeptTokens(await readAll(), now);
  // Another ChatGPT user signed in: everything kept belongs to the previous one — drop it all.
  for (const [k, e] of Object.entries(map)) if (e.userId !== userId) delete map[k];
  const prev = map[orgKey];
  if (prev && prev.token === token) return;
  map[orgKey] = { token, exp, userId };
  const keys = Object.keys(map);
  if (keys.length > MAX_KEPT) {
    keys.sort((a, b) => map[a].exp - map[b].exp);
    for (const k of keys.slice(0, keys.length - MAX_KEPT)) delete map[k];
  }
  await writeAll(map);
  });
}

/** The live kept token for `orgKey` minted for `userId`, or null. */
export async function keptChatGPTToken(orgKey, userId, now = Date.now()) {
  const e = liveKeptTokens(await readAll(), now)[orgKey];
  return e && e.userId === userId ? e.token : null;
}

/** Drop `orgKey`'s token (it was refused, or no longer reads that account). */
export function forgetChatGPTToken(orgKey) {
  return serialized(async () => {
    const map = await readAll();
    if (!(orgKey in map)) return;
    delete map[orgKey];
    await writeAll(map);
  });
}
