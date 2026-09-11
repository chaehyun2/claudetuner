// Storage side of the provider schema-drift observation (#1322).
//
// Everything that DECIDES anything lives in bg/drift-obs.js, which is pure and under contract.
// This file is the thin part that cannot be: one chrome.storage record, read once per provider per
// cycle and written only when a report actually lands.
//
// 🔴 THE CARRIER INVARIANT. Repeated here because it is the constraint that makes this safe, and
// the place someone would break it is this file:
//
//     FIELDS ARE ADDED TO THE BODY OF REQUESTS THAT ALREADY FIRE.
//     WHICH REQUESTS FIRE, AND WHEN, IS NEVER CHANGED.
//
// Nothing here may introduce a request, and nothing may widen a send gate to get more coverage.
// postHeartbeat is gated on `accountCache?.email`; installs that are silent today would otherwise
// start heartbeating on the SHARED API KEY, enlarging the `hb_gate` shadow population that #758's
// pending HEARTBEAT_IDENTITY_ENFORCE decision rests on. bg/collect.js states the rule directly —
// "Fixing one thing must not redefine the population another decision rests on". An observation
// that changes who is observed has broken the thing it was measuring.
//
// 🔴 NO D1, NO SERVER READ, EVER. This is chrome.storage.local only. The ingest hot path may not
// take on another D1 statement — read OR write — and an observation is the last thing that should.
import {
  mergeDriftEvent, drainDriftBuffer, noteDriftAttempt,
  shouldFlushDrift, flushWindowSeconds, nextDriftState, DRIFT_EVENT_TTL_MS, purgeExpired,
  normalizeDriftPlan,
} from './drift-obs.js';

const KEY = 'driftObs';

// 🔴 EVERY EXPORT BELOW IS ERROR-ISOLATED, AND THAT IS PART OF THE CARRIER INVARIANT — not
// defensive habit. Codex proved the original code broke it two ways when a chrome.storage write
// failed:
//   • noteDriftOutcome() threw inside collectGemini's try block → the collector recorded a
//     collection error and returned early → THE SNAPSHOT WAS NEVER SENT. A healthy Gemini stopped
//     reporting usage because an OBSERVATION could not be written.
//   • the heartbeat's commit threw after a 2xx → `lastHeartbeatAt` was never stamped → the
//     heartbeat re-fired. Measured: 1 request became 3.
// Both are the same failure — the observation changing WHICH REQUESTS FIRE, which is exactly what
// this module promises never to do. An observation that cannot be recorded is an observation we
// lose; it is never a reason to change what the extension does.
//
// 🔴 Errors are swallowed, not rethrown and not surfaced. There is deliberately no callback and no
// popup state: nothing about drift observation is worth telling a user, and any path that reported
// it would be a path by which it could affect behaviour.
async function safe(fn, fallback) {
  try { return await fn(); } catch (e) {
    console.warn('[Claude Tuner] drift observation skipped:', e && e.message);
    return fallback;
  }
}
const NO_RIDER = { rider: null, commit: async () => {} };

/** @returns {Promise<{events: Array, counters: object, state: object}>} */
async function read() {
  const stored = (await chrome.storage.local.get({ [KEY]: null }))[KEY];
  return {
    events: Array.isArray(stored?.events) ? stored.events : [],
    counters: stored?.counters && typeof stored.counters === 'object' ? stored.counters : {},
    state: stored?.state && typeof stored.state === 'object' ? stored.state : {},
  };
}

async function write(rec) {
  await chrome.storage.local.set({ [KEY]: rec });
}

/**
 * Record one collection attempt for a provider.
 *
 * `outcome` is 'success' | 'parse_fail' | 'error'. A parse failure ALSO takes an event, because
 * the counter says how often and the event says what the response looked like — and it is the
 * second that tells you the provider changed rather than the network being down.
 *
 * 🔴 Called on the early-return paths too. Those are the ones that produce no snapshot at all, so
 * without this the broken case is missing from the successful-ingest population entirely — the
 * exact hole #1322 exists to close.
 */
export async function noteDriftOutcome(provider, outcome, event, now = Date.now()) {
  return safe(() => noteDriftOutcomeImpl(provider, outcome, event, now), undefined);
}
async function noteDriftOutcomeImpl(provider, outcome, event, now) {
  const rec = await read();
  rec.counters[provider] = noteDriftAttempt(rec.counters[provider], outcome);
  if (event) rec.events = mergeDriftEvent(rec.events, { provider, ...event }, now);
  await write(rec);
}

/**
 * Build the rider for a request that is ABOUT TO GO OUT ANYWAY, if this provider is due.
 *
 * @returns {Promise<{rider: object|null, commit: function}>}
 *   `commit` persists the new flush state and clears what was reported. It is deliberately
 *   separate: the caller runs it only after a CONFIRMED successful send, mirroring
 *   gateProviderSnapshot's commit. Committing at build time would drop the observation whenever the
 *   POST failed — and an install whose sends fail is exactly the population this is measuring, so
 *   that bias would eat the signal at its most interesting edge.
 */
// `plan` is { label, raw }: the display label AND the provider signal it was derived from.
// See normalizeDriftPlan — the label alone cannot tell a missing plan from a real Free account.
export async function buildDriftRider(provider, shape, plan, now = Date.now()) {
  return safe(() => buildDriftRiderImpl(provider, shape, plan, now), NO_RIDER);
}
async function buildDriftRiderImpl(provider, shape, plan, now) {
  const rec = await read();
  const sig = shape ? shape.sig : null;
  let decision = shouldFlushDrift(rec.state[provider], sig, now);
  // A pending drift event does not wait out the quiet hour. The cadence exists to stop UNCHANGED
  // shapes from riding every cycle; a PARSE event is by definition something that changed, and
  // holding it for up to an hour behind an unrelated provider's quiet window would blunt the same
  // signal the sig_change trigger exists to deliver promptly.
  //
  // 🔴 `stage === 'parse'` IS THE WHOLE CONDITION, AND THE NARROWING IS LOAD-BEARING. Collect-stage
  // errors recur IDENTICALLY every cycle (a signed-out or refusing provider fails the same way at
  // 10-minute intervals), and `commit` clears the buffer on each drain — so an unfiltered
  // `hasPending` would re-arm on the very next attempt and turn the hourly cadence into a
  // per-cycle flush for exactly the installs that are broken. That is a volume multiplier on the
  // largest failing population, not a signal: `err_chatgpt_collect_failed` alone was 4,566
  // install-days in the 8 days to 2026-09-10. A recurring error is not news; it still travels, on
  // the next natural flush and on the heartbeat rider, which are the cadences it belongs to.
  //
  // 🪤 THE COST IS NOT ZERO, AND IT IS NOT ONLY LATENCY. Codex reproduced a loss (2026-09-11):
  // shape committed at t=0, collect event at t=1m, an unchanged-shape carrier at t=10m that this
  // predicate now skips, and no further carrier before the 48h event TTL — the observation expires
  // and the next rider reports `events_dropped:1` with nothing in it. So this trades a rare loss on
  // installs whose carriers stop for a bounded write rate on every install whose provider is
  // broken. That is the right trade at today's numbers and it is a TRADE, not a free narrowing;
  // revisit it with a per-identity "already early-flushed" latch if the dropped counts say so.
  // (#1417)
  const hasPending = (Array.isArray(rec.events) ? rec.events : []).some(
    (e) => e.stage === 'parse' && now - e.first < DRIFT_EVENT_TTL_MS,
  );
  if (!decision.flush && hasPending) decision = { flush: true, reason: 'events' };
  if (!decision.flush) return { rider: null, commit: async () => {} };

  const drained = drainDriftBuffer(rec.events, now);
  // 🔴 EVERY provider's pending events ride this carrier, not just this provider's.
  //
  // This filtered on `e.provider === provider` at first, which looked like tidy attribution and
  // was a hole: the only carrier for a Gemini event was a Gemini SNAPSHOT, and a Gemini that fails
  // never produces one. Trace it — Gemini fails early, event buffered; ChatGPT's and Claude's
  // riders skip it as "not theirs"; the heartbeat drains everything but only fires on the CLAUDE
  // FAILURE path. So on the ordinary install where Claude works and Gemini is broken, the event sat
  // in the buffer until the 48h TTL discarded it. The exact population #1322 exists to see, silent.
  //
  // Attribution is not lost by widening the carrier: each event names its own provider, and
  // `obs_provider` below names whose SHAPE and COUNTERS the rider carries. Those two are different
  // questions and conflating them is what caused the hole.
  const counters = rec.counters[provider] || { attempts: 0, successes: 0, parse_fails: 0, capped: false };

  const rider = {
    obs_provider: provider,
    // 🔴 The axis the signature MUST be cut by. Free and Go legitimately report a 30-day window
    // where Plus reports 7, so one provider carries several correct signatures at once — and
    // without this field a shift in the PLAN MIX moves signature share while the provider changed
    // nothing. The alarm would fire on our own growth. It was agreed as blob9 and then simply never
    // sent, so the consumer deleted the rule rather than reference a field that did not exist.
    plan: normalizeDriftPlan(plan && plan.label, plan && plan.raw),
    flush_reason: decision.reason,
    flush_window_seconds: flushWindowSeconds(rec.state[provider], now),
    attempts: counters.attempts,
    successes: counters.successes,
    parse_fails: counters.parse_fails,
    ...(counters.capped ? { counters_capped: true } : {}),
    ...(drained.dropped ? { events_dropped: drained.dropped } : {}),
    ...(shape ? {
      keyset: shape.keyset,
      source: shape.source,
      shape_sig: shape.sig,
      raw_buckets: shape.rawBuckets,
      raw_models: shape.rawModels,
      ...(shape.unknownKeys && shape.unknownKeys.length ? { unknown_keys: shape.unknownKeys } : {}),
      // A key that appeared but did not look unambiguously like a schema field name. Counted, never
      // named — "something new is there and we would not name it" is a weaker signal than the name,
      // and a far better one than silence.
      ...(shape.unknownWithheld ? { unknown_keys_withheld: shape.unknownWithheld } : {}),
    } : {}),
    ...(drained.events.length ? { drift_events: drained.events } : {}),
  };

  const commit = async () => safe(async () => {
    const fresh = await read();
    fresh.state[provider] = nextDriftState(sig, now);
    // Counters restart with the window they are divided by, or the next report's rate is computed
    // over the wrong span.
    fresh.counters[provider] = { attempts: 0, successes: 0, parse_fails: 0, capped: false };
    // Clear exactly what shipped — keyed on the full identity INCLUDING the provider, so an event
    // that arrived after the rider was built is not swept out unreported. Expired entries are
    // purged in the same pass: leaving them costs a buffer slot and, worse, gave a recurring
    // failure something dead to fold into.
    const reported = new Set(drained.events.map((e) => `${e.provider}|${e.stage}|${e.code}|${e.sig}`));
    fresh.events = purgeExpired(fresh.events, now).filter(
      (e) => !reported.has(`${e.provider}|${e.stage}|${e.code}|${e.sig}`),
    );
    await write(fresh);
  }, undefined);
  return { rider, commit };
}

/**
 * The last-resort carrier: every provider's pending EVENTS, for the heartbeat.
 *
 * 🔴 THIS IS WHAT NARROWS THE GEMINI-ONLY HOLE. A snapshot rider only ships when that provider
 * produced a snapshot, so an install where a provider always fails has no carrier of its own. The
 * heartbeat fires on the Claude failure path regardless of which provider broke, so draining ALL
 * providers' events here reaches installs a per-provider rider cannot.
 *
 * Events name their own provider, so widening the carrier does not blur attribution. Counters are
 * deliberately NOT included: they are per-provider rates that belong with that provider's flush
 * window, and mixing them into a carrier with a different cadence would make the window field —
 * the thing that makes them divisible at all — mean nothing.
 *
 * 🔴 It does not close the hole entirely, and the residual is documented rather than papered over:
 * the heartbeat is itself gated on `accountCache?.email`, so an install with no Claude account AND
 * a permanently failing provider still reports nothing. Widening that gate is forbidden (#758).
 */
export async function buildDriftEventsRider(now = Date.now()) {
  return safe(() => buildDriftEventsRiderImpl(now), NO_RIDER);
}
async function buildDriftEventsRiderImpl(now) {
  const rec = await read();
  const drained = drainDriftBuffer(rec.events, now);
  if (!drained.events.length && !drained.dropped) return { rider: null, commit: async () => {} };
  const rider = {
    obs_provider: 'all',
    flush_reason: 'heartbeat',
    ...(drained.dropped ? { events_dropped: drained.dropped } : {}),
    ...(drained.events.length ? { drift_events: drained.events } : {}),
  };
  const commit = async () => safe(async () => {
    const fresh = await read();
    const reported = new Set(drained.events.map((e) => `${e.provider}|${e.stage}|${e.code}|${e.sig}`));
    fresh.events = purgeExpired(fresh.events, now).filter(
      (e) => !reported.has(`${e.provider}|${e.stage}|${e.code}|${e.sig}`),
    );
    await write(fresh);
  }, undefined);
  return { rider, commit };
}
