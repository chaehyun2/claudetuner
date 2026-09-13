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
  noteDriftTotal, driftTotalsDue,
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
    // Cumulative lifetime counters, never drained — see noteDriftTotal. Deliberately a SEPARATE
    // map from `counters`: mixing a drained rate and a lifetime total in one record is how the
    // first attempt at this ended up clearing one while meaning the other.
    totals: stored?.totals && typeof stored.totals === 'object' ? stored.totals : {},
    state: stored?.state && typeof stored.state === 'object' ? stored.state : {},
  };
}

async function write(rec) {
  await chrome.storage.local.set({ [KEY]: rec });
}

/**
 * Serialize every read-modify-write of this record.
 *
 * 🔴 EVERY WRITE HERE REPLACES THE WHOLE RECORD, so two overlapping read→modify→write cycles lose
 * whatever the loser read stale — and review reproduced it without artificial delays: an attempt
 * recorded while a rider's commit was in flight was written, then overwritten back to its old value
 * by the commit's stale copy. A provider's FIRST attempt could be erased outright, and two
 * concurrent `noteDriftOutcome` calls could lose one provider's entry entirely.
 *
 * 🪤 THIS IS NOT NEW, AND THAT IS THE POINT — it predates the cumulative totals and applies just as
 * much to `counters` and `events`. Scheduled collection is sequential, but Gemini's tab-triggered
 * collection has its own guard (bg/providers.js) and can overlap another provider's cycle, and the
 * heartbeat commit is a third writer. Making the totals immune to CLEARING did not make the record
 * immune to REPLACEMENT; the first redesign confused the two.
 *
 * A promise chain is enough — one service worker, so this module is the only writer. Mirrors
 * `patch()` in bg/provider-state.js, which exists for exactly this failure on a different key.
 * 🔴 The chain must survive a rejection, or one failed transaction deadlocks every later one.
 */
/**
 * 🔴 THE QUEUE IS NOT RELEASED WHILE A WRITE MAY STILL LAND — and a watchdog that did was a
 * DATA-LOSS BUG, reproduced and reverted (#1430).
 *
 * The concern is real: a `chrome.storage` write that never settles holds this chain for the
 * service-worker lifetime, and every collector now queues here. I shipped a 10s watchdog that let
 * the SUCCESSOR proceed, reasoning that a bounded race beats unbounded silence. That reasoning was
 * wrong, and the difference is what the two failures destroy:
 *
 *   blocking      — loses observations that were never written. Bad, and self-limited: the worker
 *                   restarts and the counters that DID persist are all still there.
 *   the watchdog  — the held write still completes, and every write here replaces the WHOLE record
 *                   from a copy read before the successor ran. Reproduced: Gemini's write is held,
 *                   Claude's transaction proceeds after the timer and persists
 *                   `totals.claude.attempts = 1`, then Gemini's original write lands and the record
 *                   contains Gemini ONLY. An ALREADY-PERSISTED counter is erased.
 *
 * Destroying durable state to avoid a stall is the wrong trade for a module whose entire output is
 * cumulative counts. A promise cannot be cancelled, so once a stale whole-record write is in flight
 * there is nothing to do but wait for it — which is exactly what serialization is.
 *
 * 🪤 The watchdog also armed its timer at ENQUEUE rather than at execution, so a burst enqueued
 * together would lose serialization together. Both defects are gone with it.
 *
 * ⇒ The stall risk is a documented FOLLOW-UP, not something to trade durable data for. Closing it
 * properly needs writes that cannot clobber — per-provider storage keys, or a compare-and-set —
 * not a way to let two whole-record writers run at once.
 *
 * A promise chain is enough — one service worker, so this module is the only writer. Mirrors
 * `patch()` in bg/provider-state.js, which exists for exactly this failure on a different key.
 * 🔴 The chain must survive a rejection, or one failed transaction deadlocks every later one.
 */
let _txChain = Promise.resolve();
function tx(fn) {
  const run = async () => {
    const rec = await read();
    return fn(rec);
  };
  const next = _txChain.then(run, run);
  _txChain = next.then(() => {}, () => {});
  return next;
}


/**
 * The cumulative totals due to ride along, excluding `carrier` (pass null to exclude nothing).
 *
 * 🔴 ONE IMPLEMENTATION FOR BOTH RIDERS. The snapshot rider and the heartbeat rider both carry
 * these, and the heartbeat is the one that reaches the population with no successful snapshot at
 * all — so a second spelling here would be a rule that gets fixed once and stays broken in the
 * carrier that matters. `stampTotalsSent` is its mandatory partner: what is reported must be what
 * is stamped, or the throttle drifts from the report.
 */
/** Age of the last attempt, never trusting a stamp from the future — see the call site. */
function totalsAge(t, now) {
  const last = typeof t.lastAt === 'number' && t.lastAt <= now ? t.lastAt : t.since;
  return Math.max(0, Math.round((now - last) / 1000));
}

function dueTotals(rec, carrier, now) {
  const out = [];
  for (const [p, t] of Object.entries(rec.totals || {})) {
    if (p === carrier || !driftTotalsDue(t, now)) continue;
    out.push({
      provider: p,
      attempts: t.attempts,
      successes: t.successes,
      parse_fails: t.parse_fails,
      // Seconds since the FIRST observed attempt — the span these cumulative counts cover.
      // 🔴 Not the envelope's `flush_window_seconds`, which belongs to a different provider and a
      // different quantity. A reader must divide by this, or not divide at all.
      since_seconds: Math.max(0, Math.round((now - t.since) / 1000)),
      // 🔑 How long ago the LAST attempt was. Without it a cumulative count cannot distinguish
      // "still failing every cycle" from "ran once months ago and stopped" — both report the same
      // totals forever, and after saturation they are literally identical. Review raised this as
      // the limit of a max()-only reading; this is the field that answers it.
      // 🪤 `Math.max(0, …)` alone made a FUTURE `lastAt` read as age zero — an old observation
      // looking brand new, which is the opposite of what a recency field is for. A future stamp
      // means the clock moved, not that the collector just ran: fall back to `since`, which is the
      // oldest thing we know, so the answer degrades toward "stale" rather than toward "fresh".
      last_seconds: totalsAge(t, now),
      ...(t.capped ? { capped: true } : {}),
    });
  }
  return out;
}

/**
 * Mark the reported totals as sent — the ONLY mutation a commit makes to them.
 *
 * 🔴 Re-reads each record from the record being written (`fresh`), never from a copy captured at
 * build time: an attempt recorded between build and commit must survive. Spreading a stale copy is
 * exactly the loss review reproduced, and the serialized `tx` is what makes `fresh` current.
 */
function stampTotalsSent(fresh, reported, now) {
  for (const r of reported) {
    const prev = fresh.totals[r.provider];
    if (prev) fresh.totals[r.provider] = { ...prev, sentAt: now };
  }
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
  return tx(async (rec) => {
    rec.counters[provider] = noteDriftAttempt(rec.counters[provider], outcome);
  // 🔴 The cumulative twin, updated on the SAME call so the two can never disagree about whether an
  // attempt happened. This is the only place an attempt is observed, which is why the `since`
  // anchor belongs here — it must exist before the first flush, and for the population this feature
  // is about there is never a first flush.
    rec.totals[provider] = noteDriftTotal(rec.totals[provider], outcome, now);
    if (event) rec.events = mergeDriftEvent(rec.events, { provider, ...event }, now);
    await write(rec);
  });
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

  // 🔴 THE SAME HOLE AS THE EVENTS ABOVE, ONE FIELD OVER — and this one stayed open (#1430).
  //
  // The paragraph above widened EVENTS to every provider because "the only carrier for a Gemini
  // event was a Gemini SNAPSHOT, and a Gemini that fails never produces one". The counters below
  // are per-carrier for a stated reason: they are RATES, cleared each flush so the next report
  // divides fresh counts by a fresh window. A provider that never succeeds never flushes, so its
  // rate was never reported — and "the collector ran and bailed" and "it never ran" were the same
  // silence. Measured 2026-09-13 on live AE: of 2,226 accounts sending ANY snapshot on ext
  // 1.29.75, **1,322 (59%) produced no ChatGPT signal at all**.
  //
  // 🔴 WHAT RIDES HERE IS A DIFFERENT QUANTITY, NOT A WIDENED RATE, and that distinction is what
  // makes it safe. The first attempt carried the DRAINED counters with a per-entry window, and
  // review reproduced two failures in it that are inherent to draining something this rider does
  // not own: a LOSS (the carrier's commit zeroed increments recorded after the rider was built)
  // and a DUPLICATION (two carriers reporting the same window). Both stop being expressible here:
  //
  //   nothing is cleared   → no increment can be destroyed by another provider's commit
  //   value is cumulative  → two carriers carry the SAME snapshot, so the reader takes the MAX per
  //                          (install, provider). A duplicate is a copy, not a double count.
  //   `since` is anchored  → at the first attempt ever observed, not at the first flush. The
  //                          earlier design read the flush anchor, which does not exist until a
  //                          flush happens — so the never-succeeding provider, the whole point of
  //                          the feature, reported a zero-length window.
  //
  // 🔑 Throttled (DRIFT_TOTALS_MIN_INTERVAL_MS), which is safe for the same reason: a skipped
  // report loses nothing, because the next one carries everything. The drained design had no such
  // freedom and measured 48–144 extra AE rows per install per day; this is ≤4 per provider per day.
  const otherTotals = dueTotals(rec, provider, now);

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
    ...(otherTotals.length ? { other_totals: otherTotals } : {}),
  };

  // 🔴 The commit runs INSIDE the same serialized chain as every other writer, re-reading under the
  // lock rather than spreading a copy captured at build time. Without that, an attempt recorded
  // between build and commit is written and then reverted by this write (reproduced in review).
  const commit = async () => safe(() => tx(async (fresh) => {
    fresh.state[provider] = nextDriftState(sig, now);
    // Counters restart with the window they are divided by, or the next report's rate is computed
    // over the wrong span.
    fresh.counters[provider] = { attempts: 0, successes: 0, parse_fails: 0, capped: false };
    // 🔴 THE CARRIED TOTALS ARE NOT CLEARED — ONLY STAMPED AS SENT.
    //
    // This is the line the whole redesign turns on. Clearing another provider's counters from this
    // provider's commit is what produced the loss and the duplication review found: the rider does
    // not own them, and between build and commit they keep moving. A cumulative value needs no
    // clearing, so there is nothing to race over. `sentAt` only throttles the NEXT report, and
    // getting it wrong costs one redundant copy of a value that is idempotent by construction —
    // never a lost increment.
    //
    // 🪤 `since` and the counts are untouched here on purpose. Advancing either would turn this
    // back into a drained counter wearing a cumulative name.
    stampTotalsSent(fresh, otherTotals, now);
    // Clear exactly what shipped — keyed on the full identity INCLUDING the provider, so an event
    // that arrived after the rider was built is not swept out unreported. Expired entries are
    // purged in the same pass: leaving them costs a buffer slot and, worse, gave a recurring
    // failure something dead to fold into.
    const reported = new Set(drained.events.map((e) => `${e.provider}|${e.stage}|${e.code}|${e.sig}`));
    fresh.events = purgeExpired(fresh.events, now).filter(
      (e) => !reported.has(`${e.provider}|${e.stage}|${e.code}|${e.sig}`),
    );
    await write(fresh);
  }), undefined);
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
 * Events name their own provider, so widening the carrier does not blur attribution. The windowed
 * COUNTERS are still excluded, and the reason is unchanged: they are per-provider rates belonging to
 * that provider's flush window, and mixing them into a carrier with a different cadence would make
 * the window field — the thing that makes them divisible at all — mean nothing.
 *
 * 🔴 CUMULATIVE TOTALS *ARE* CARRIED HERE, AND THIS IS THE CARRIER THAT MATTERS MOST (#1430).
 * An install whose provider only ever fails produces no snapshot, so the snapshot rider never runs
 * for it — which is precisely the population the totals exist to make visible. Leaving them off
 * this carrier reproduced the original hole one layer up: review found an install that sends
 * failure heartbeats but no successful snapshots stays invisible indefinitely.
 *
 * Totals are immune to the objection that excludes counters: they are not a rate over the carrier's
 * window, they are a lifetime count with their own `since` anchor, so which request carries them
 * changes nothing about how they are read. Nothing is drained, so a heartbeat and a snapshot rider
 * carrying the same totals is a duplicate SNAPSHOT, not a split of one measurement.
 *
 * 🔑 This adds no new send: the heartbeat already goes out on the Claude failure path. Its
 * `accountCache?.email` gate is NOT widened (that is forbidden, #758) — the residual below stands.
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
  // 🔴 EVERY provider here — there is no carrier to exclude. `obs_provider` is 'all'.
  const totals = dueTotals(rec, null, now);
  // 🔴 Totals alone are enough to send. Gating on events would leave out exactly the install this
  // carrier was extended for: one whose only signal is a counter-only precheck failure, which
  // produces no event at all.
  if (!drained.events.length && !drained.dropped && !totals.length) {
    return { rider: null, commit: async () => {} };
  }
  const rider = {
    obs_provider: 'all',
    flush_reason: 'heartbeat',
    ...(drained.dropped ? { events_dropped: drained.dropped } : {}),
    ...(drained.events.length ? { drift_events: drained.events } : {}),
    ...(totals.length ? { other_totals: totals } : {}),
  };
  const commit = async () => safe(() => tx(async (fresh) => {
    const reported = new Set(drained.events.map((e) => `${e.provider}|${e.stage}|${e.code}|${e.sig}`));
    fresh.events = purgeExpired(fresh.events, now).filter(
      (e) => !reported.has(`${e.provider}|${e.stage}|${e.code}|${e.sig}`),
    );
    stampTotalsSent(fresh, totals, now);
    await write(fresh);
  }), undefined);
  return { rider, commit };
}
