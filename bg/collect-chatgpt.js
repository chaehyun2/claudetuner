import { fetchChatGPTApi, isChatGPTLoggedIn } from './api-chatgpt.js';
// Pure response parsing lives in its own chrome-free module so the contract runner can import it
// (#1315). Names are unchanged on purpose: the call sites below are what several guards match on.
import {
  chatgptPlanName, unixToResetTime, parseAccountsRoster, windowSpan, classifyWindows,
  parseAdditionalLimits, parseModelAvailability, parseReachedType, summarizeLimitBuckets,
  pickScopedModel,
} from './parse-chatgpt.js';
import { chatgptUsageShape } from './drift-obs.js';
import { noteDriftOutcome, buildDriftRider } from './drift-store.js';
import { getConfig, appendUsageHistory, postSnapshot, getOrCreateInstallId, resolveIngestIdentity } from './storage.js';
import { gateProviderSnapshot, shouldForceProviderPost } from './send-gate.js';
import { noteProviderAttempt, noteProviderSuccess, noteProviderError,
         noteProviderSendError, noteProviderSendOk } from './provider-state.js';

// accounts/check exposes the full multi-workspace roster (one entry per account
// UUID plus a `default` alias for the session's active account) — and it's the
// only source of the next-billing ("renewal") date and any scheduled plan change,
// which /wham/usage omits.
//
// TTL is 1h (the send heartbeat floor), NOT the former 24h. That staleness bit us in
// practice (2026-07-22): the cache stores the PARSED roster, so it pinned a
// pre-scheduling / pre-parser-fix null-pending parse for a full day — every automatic
// send carried pending=null while the popup showed the change from an earlier good
// parse, and the scheduled change was never stored server-side before it applied.
// One authenticated GET per hour per browser is trivial (the ChatGPT webapp itself
// calls accounts/check far more often), so keep the roster no staler than a heartbeat.
const ROSTER_TTL_MS = 60 * 60 * 1000; // 1h — matches SEND_HEARTBEAT_FLOOR_MS
const ROSTER_CACHE_KEY = 'chatgptAccountsRoster';
// Bound how many extra workspaces we enumerate/send, so a profile signed into many
// accounts can't fan out unboundedly.
const MAX_EXTRA_WORKSPACES = 5;

// The roster's `defaultAccountId`/`defaultRenewal` and its active-account exclusion
// are all relative to whichever account was active when accounts/check was fetched.
// If the user switches ChatGPT account/workspace within the TTL, a cache keyed only
// by time would be stale: the now-active account (fresh in /wham/usage) would still
// be listed as an "extra" workspace (→ duplicate null-usage snapshot) and the primary
// org would carry the previous account's renewal date. So bust the cache whenever the
// active-account fingerprint (usage account id + plan) changes, not just on TTL.
//
// `forceRefresh` (a user-manual "수집" click) bypasses the cache entirely so a
// just-scheduled plan change — which does NOT move the account/plan fingerprint and so
// wouldn't otherwise bust the cache — is picked up on the same cycle instead of waiting
// out the TTL.
//
// The cache entry is stamped with the extension version (`extVer`): what's cached is the
// PARSED roster, so without the stamp a parser fix keeps serving the OLD code's output
// until the TTL expires — exactly how the scheduled-plan-change parse fix (PR#623) sat
// invisible behind a cached null-pending parse (2026-07-22 incident). A version mismatch
// forces a refetch so new parser code always takes effect on its first cycle.
async function getChatGPTAccountsRoster(activeAccountId, activePlanType, forceRefresh = false) {
  const extVer = chrome.runtime.getManifest().version;
  const cached = (await chrome.storage.local.get({ [ROSTER_CACHE_KEY]: null }))[ROSTER_CACHE_KEY];
  if (!forceRefresh
      && cached?.roster
      && cached.extVer === extVer
      && cached.activeAccountId === activeAccountId
      && cached.activePlanType === activePlanType
      && (Date.now() - cached.fetchedAt) < ROSTER_TTL_MS) {
    return cached.roster;
  }
  try {
    const data = await fetchChatGPTApi('/backend-api/accounts/check/v4-2023-04-27');
    // The active id is part of the cache fingerprint above, so a cached roster was always parsed
    // against the same active account it is served for — the exclusion cannot go stale here.
    const roster = parseAccountsRoster(data, activeAccountId);
    // One line per (at most hourly) refresh: what the LIVE response carried. This is the
    // signal that was missing while diagnosing the null-pending incident — it separates
    // "the API didn't return a scheduled change" from "we parsed/sent it wrong" at a glance.
    console.log(`[Claude Tuner] ChatGPT roster refreshed: pending=${roster.defaultPendingPlan || 'none'}${roster.defaultPendingChangeDate ? ` @ ${roster.defaultPendingChangeDate}` : ''}, renewal=${roster.defaultRenewal || 'none'}, workspaces=${roster.workspaces.length}`);
    await chrome.storage.local.set({
      [ROSTER_CACHE_KEY]: { roster, fetchedAt: Date.now(), extVer, activeAccountId, activePlanType },
    });
    return roster;
  } catch (e) {
    console.warn('[Claude Tuner] ChatGPT accounts roster fetch failed:', e.message);
    // Reuse a stale roster if we have one; otherwise report an empty roster so the
    // active account (collected separately via /wham/usage) still goes through. Pending is
    // `undefined` (UNKNOWN), NOT null: we couldn't read accounts/check, so we must not let the
    // send gate read a fetch failure as "pending cancelled" and force-store a spurious NULL over a
    // real scheduled change (send-gate.js treats undefined as unknown → no trigger).
    //
    // 🔴 BUT ONLY A ROSTER FOR THE ACCOUNT WE ARE ACTUALLY LOOKING AT. The cache-hit test above
    // checks the fingerprint; this fallback used to ignore it, so a cycle where the user had
    // switched to account B and `accounts/check` happened to fail would replay account A's
    // workspaces — and they are then sent with B's email and B's identity, to the local store and
    // to the server (Codex round 5). "Stale" is acceptable for the SAME account, where the only
    // cost is a late plan change; for a DIFFERENT one it is fabricated data. An empty roster keeps
    // the active org collecting and simply omits extra workspaces for this cycle.
    const sameAccount = cached?.roster
      && cached.extVer === extVer
      && cached.activeAccountId === activeAccountId
      && cached.activePlanType === activePlanType;
    if (!sameAccount && cached?.roster) {
      console.warn('[Claude Tuner] ChatGPT roster cache belongs to another account/plan — not reusing');
    }
    return (sameAccount ? cached.roster : null)
      || { defaultAccountId: null, defaultRenewal: null, defaultPendingPlan: undefined, defaultPendingChangeDate: undefined, workspaces: [] };
  }
}

/**
 * Collect ChatGPT usage data.
 * Returns { success, orgs: [{ uuid, name, plan, provider, isPrimary, h5, d7, ... }] }
 * Fails silently (returns empty orgs) if user is not logged into ChatGPT.
 */
export async function collectChatGPT(force = false, userManual = false) {
  await noteProviderAttempt('chatgpt');
  const loggedIn = await isChatGPTLoggedIn();
  if (!loggedIn) {
    // 🔴 Record it. This early return is the MOST COMMON failure — signed out of ChatGPT — and it
    // happens before any API call, so it never produced one of the `err_chatgpt_*` codes. Exposing
    // those codes without this would still leave the ordinary case invisible (#852).
    await noteProviderError('chatgpt', 'err_chatgpt_not_logged_in');
    // Counted only: a precheck has no response to have a shape, and being signed out is not drift.
    // It still belongs in the denominator, or "nobody uses it" and "it broke" read the same.
    await noteDriftOutcome('chatgpt', 'error', null);
    return { success: false, orgs: [] };
  }

  // Per-cycle send outcome. Applied once at the end, so a later workspace's success cannot erase
  // an earlier failure (see sendChatGPTSnapshot).
  const sendOutcome = { failed: null, ok: 0 };
  try {
    const usage = await fetchChatGPTApi('/backend-api/wham/usage');

    // 🔴 Computed on the RAW response, before the give-up below and before parseAdditionalLimits
    // truncates the bucket list to 5. Neither the early return nor the payload can answer "what did
    // the response actually look like" once those have happened.
    const shape = chatgptUsageShape(usage);

    if (!usage?.rate_limit) {
      console.warn('[Claude Tuner] ChatGPT: unexpected /wham/usage response');
      await noteProviderError('chatgpt', 'err_chatgpt_collect_failed');
      // Same early-return hole as the Gemini twin: no snapshot means no observation unless the
      // shape is held for a carrier that is already going out.
      await noteDriftOutcome('chatgpt', 'parse_fail', {
        stage: 'parse', code: 'err_chatgpt_collect_failed',
        sig: shape.sig, unknownKeys: shape.unknownKeys, unknownWithheld: shape.unknownWithheld,
      });
      return { success: false, orgs: [] };
    }
    await noteDriftOutcome('chatgpt', 'success', null);

    const { w5h, w7d } = classifyWindows(usage.rate_limit);
    const plan = chatgptPlanName(usage.plan_type);
    const accountId = usage.account_id || usage.user_id || 'unknown';
    const email = usage.email || null;

    // One accounts/check fetch (cached ~daily, but busted when the active account
    // changes) gives both the active account's renewal date and the full workspace
    // roster for multi-org enumeration. A user-manual "수집" refetches it now, so a
    // just-scheduled plan change lands on this cycle rather than waiting out the 24h roster TTL.
    // Only userManual busts the cache — NOT an automatic `force`, which for this provider comes
    // from an unrelated Claude trigger (e.g. a Claude 429) and shouldn't hit accounts/check.
    const roster = await getChatGPTAccountsRoster(accountId, usage.plan_type, userManual);
    const renewalDate = roster.defaultRenewal;

    const org = {
      uuid: accountId,
      name: email || 'ChatGPT',
      email: email || null, // provider account email (shown in the popup footer)
      plan: plan,
      provider: 'chatgpt',
      isPrimary: false,
      h5: w5h?.used_percent ?? null,
      d7: w7d?.used_percent ?? null,
      resetsAt5h: unixToResetTime(w5h?.reset_at),
      resetsAt7d: unixToResetTime(w7d?.reset_at),
      // Reported window lengths. `w7s` is 2592000 (30 days) for Free/Go and 604800 for everyone
      // else — the popup labels from this rather than assuming the slot's nominal length (#954).
      w5s: windowSpan(w5h),
      w7s: windowSpan(w7d),
      renewalDate, // next-billing date (accounts/check entitlement.renews_at); may be null
      // Scheduled plan change from accounts/check entitlement.scheduled_plan_change
      // (e.g. "changes to Plus on 7/22"); null when no downgrade/change is scheduled.
      pendingPlan: roster.defaultPendingPlan || null,
      pendingChangeDate: roster.defaultPendingChangeDate || null,
      spendUsed: null,
      spendLimit: null,
      extraUsage: null,
      // Per-feature limit buckets (e.g. Codex weekly) — display-only, popup gauges.
      additionalLimits: parseAdditionalLimits(usage),
      // Models the provider is currently gating (empty on a healthy account — see
      // parseModelAvailability: availability, NOT a usage percentage).
      modelGates: parseModelAvailability(usage),
      // Which limit the account actually ran into, per the provider. null = nothing exhausted,
      // which is the normal state even at 100% on the weekly window (chat is unmetered since 08-06).
      reachedType: parseReachedType(usage),
      // Raw-array census for server-side observation only — never rendered (#1184).
      bucketCensus: summarizeLimitBuckets(usage),
    };

    // Append to local usage history (for chart display)
    await appendUsageHistory({
      t: Date.now(),
      h5: org.h5,
      d7: org.d7,
      p: plan,
      r7: org.resetsAt7d,
      org: org.uuid,
      eu: null,
      el: null,
    });

    // Send snapshot to server — delta-gated (shared with Claude collectors).
    // Skip unchanged heartbeats the server would only dedup; local history above
    // is always kept so the popup chart stays continuous. Returned org is
    // unaffected, so popup/merge display is independent of the gate.
    // `plan` + `pendingPlan` + `pendingChangeDate` opt this gate into plan/pending-change detection
    // (send-gate.js): a scheduled plan change carries no usage delta, so without these it would only
    // ride the heartbeat and could be dropped by the server's usage-only dedup. The pending fields
    // come from the RAW roster (not org.*, which coerces `|| null`) so a fetch-failure roster's
    // `undefined` stays UNKNOWN and the gate doesn't read it as a cancellation.
    const gateValues = { h5: org.h5, d7: org.d7, extraUsed: null, resetsAt5h: org.resetsAt5h, resetsAt7d: org.resetsAt7d, plan: org.plan, pendingPlan: roster.defaultPendingPlan, pendingChangeDate: roster.defaultPendingChangeDate };
    const gate = await gateProviderSnapshot(org.uuid, gateValues, { force, provider: 'chatgpt', userManual });
    if (gate.send) {
      // Commit only on a confirmed-successful POST so a failed send leaves the
      // gate unadvanced and the next cycle retries (no silent drop of a change).
      // Rides an existing POST; does not decide whether one happens. Committed only on success.
      const { rider: driftRider, commit: driftCommit } = await buildDriftRider('chatgpt', shape, { label: plan, raw: usage.plan_type });
      const res = await sendChatGPTSnapshot(org, email, plan, { force: shouldForceProviderPost(gate.reason, userManual), sendOutcome, driftRider }).catch(e => {
        console.warn('[Claude Tuner] ChatGPT snapshot send failed:', e.message);
        sendOutcome.failed = sendOutcome.failed || 'err_send_failed';
        return null;
      });
      if (res) {
        await gate.commit();
        if (driftRider) await driftCommit();
        // Mirror the skip log for the sent case, WITH the subscription fields the payload
        // carried — a successful send being silent is what made the null-pending incident
        // undiagnosable from the SW console.
        console.log(`[Claude Tuner] ChatGPT snapshot sent (${gate.reason}, pending=${org.pendingPlan || 'none'})`);
      }
    } else {
      console.log(`[Claude Tuner] ChatGPT delta-gate skip (${gate.reason})`);
    }

    // Extra workspaces (Phase 1): enumerate every active, accessible workspace the
    // user belongs to beyond the active account. Per-workspace usage needs a
    // per-account token (/wham/usage is scoped to the JWT's active account), so
    // these carry plan + renewal only — usage stays null until a later phase.
    //
    // 🔴 The `ws.accountId !== org.uuid` filter is the invariant itself, stated where the two
    // sends are visible together: ONE CYCLE NEVER SENDS TWO SNAPSHOTS FOR THE SAME ORG KEY. The
    // roster already excludes the active account, but that exclusion depends on accounts/check
    // agreeing with /wham/usage about which account is active — and it is exactly that agreement
    // that failed in #1144. This check needs no such agreement: it compares the id the primary
    // snapshot was keyed by against the id each extra send would be keyed by. Keep both.
    const extraOrgs = roster.workspaces
      .filter((ws) => ws.accountId !== org.uuid)
      .slice(0, MAX_EXTRA_WORKSPACES).map((ws) => ({
      uuid: ws.accountId,
      name: ws.name || 'ChatGPT Workspace',
      email: email || null,
      plan: ws.plan,
      provider: 'chatgpt',
      isPrimary: false,
      h5: null,
      d7: null,
      resetsAt5h: null,
      resetsAt7d: null,
      // Usage is null for extra workspaces (per-account token needed), so there is no window
      // either — stated explicitly so org-merge does not carry a stale span forward.
      w5s: null,
      w7s: null,
      renewalDate: ws.renewal,
      pendingPlan: ws.pendingPlan || null,
      pendingChangeDate: ws.pendingChangeDate || null,
      spendUsed: null,
      spendLimit: null,
      extraUsage: null,
    }));

    for (const ex of extraOrgs) {
      // Gate per workspace uuid so unchanged workspaces only re-send on the
      // heartbeat floor (with usage null there's never a "changed" trigger).
      const exGate = await gateProviderSnapshot(
        ex.uuid,
        { h5: null, d7: null, extraUsed: null, resetsAt5h: null, resetsAt7d: null, plan: ex.plan, pendingPlan: ex.pendingPlan, pendingChangeDate: ex.pendingChangeDate },
        { force, provider: 'chatgpt', userManual },
      );
      if (!exGate.send) continue;
      // A workspace is never the user's primary data source, so force is_extra_org
      // even for ChatGPT-only users (must not overwrite the users row's plan). A
      // plan/pending change (or a user-manual collect) marks the POST force so the server
      // stores it rather than deduping this usage-null workspace heartbeat.
      const res = await sendChatGPTSnapshot(ex, email, ex.plan, { forceExtraOrg: true, force: shouldForceProviderPost(exGate.reason, userManual), sendOutcome }).catch((e) => {
        console.warn('[Claude Tuner] ChatGPT workspace snapshot send failed:', e.message);
        sendOutcome.failed = sendOutcome.failed || 'err_send_failed';
        return null;
      });
      if (res) await exGate.commit();
    }

    await noteProviderSuccess('chatgpt', email);
    // 🔴 ANY failed POST in this cycle keeps the send axis red, even if others succeeded. A
    // provider sends several snapshots (primary + extra workspaces); clearing per POST let a later
    // workspace 2xx erase the primary's failure (Codex DEPLOY-BLOCKER).
    if (sendOutcome.failed) await noteProviderSendError('chatgpt', sendOutcome.failed);
    else if (sendOutcome.ok) await noteProviderSendOk('chatgpt');
    return { success: true, orgs: [org, ...extraOrgs] };
  } catch (e) {
    console.warn('[Claude Tuner] ChatGPT collection failed:', e.message);
    // The reason dies here otherwise: the caller only sees `success:false`, and background.js
    // catches that again with `.catch(() => {})`. Store it before it is lost (#852).
    await noteProviderError('chatgpt', e);
    await noteDriftOutcome('chatgpt', 'error', null);
    return { success: false, orgs: [] };
  }
}

// Send ChatGPT snapshot to server (same /api/snapshots endpoint)
// Uses ext_token email (Claude email) as user_email for server identity,
// preserves ChatGPT email in provider_email for reference.
async function sendChatGPTSnapshot(org, chatgptEmail, plan, { forceExtraOrg = false, force = false, sendOutcome = null, driftRider = null } = {}) {
  const config = await getConfig();
  if (!config.serverUrl) return;

  // Server identity — ONE rule for every collector, in bg/storage.js (see
  // docs/DESIGN-authenticated-attribution.md). The ext_token identity now wins: if this install
  // proved it is A, this provider's usage belongs to A even though the ChatGPT account is B.
  // `accountCache` is still read here for isExtraOrg below (a Claude account means this
  // provider is an extra org, which is a different question from identity).
  const { accountCache } = await chrome.storage.local.get({ accountCache: null });
  const serverEmail = await resolveIngestIdentity(chatgptEmail);
  if (!serverEmail) {
    console.warn('[Claude Tuner] ChatGPT snapshot skipped: no email (no Claude/independent account and no ChatGPT email)');
    return;
  }

  // When there is no Claude account, this provider is the user's primary data,
  // so the snapshot must maintain the users row (current_plan, last_seen_at).
  // For Claude users it's an "extra org" that must not overwrite current_plan.
  // Extra ChatGPT workspaces are never primary data, so callers force this true.
  const isExtraOrg = forceExtraOrg || !!accountCache?.email;

  const extVersion = chrome.runtime.getManifest().version;

  const payload = {
    user_email: serverEmail,
    plan: plan,
    collected_at: new Date().toISOString(),
    ext_version: extVersion,
    // `window_seconds` is additive and OPTIONAL: today's server ignores it, and Phase 2 of
    // docs/DESIGN-window-span-preservation.md persists it. Sending it now means that when the
    // server side ships, the clients already updated are contributing spans immediately instead
    // of waiting out a second CWS review. Absent/null on old clients → NULL column, which every
    // consumer must read as "not reported" (§7 of that doc).
    five_hour: {
      utilization: org.h5,
      resets_at: org.resetsAt5h,
      window_seconds: org.w5s ?? null,
    },
    seven_day: {
      utilization: org.d7,
      resets_at: org.resetsAt7d,
      window_seconds: org.w7s ?? null,
    },
    claude_org_uuid: org.uuid,
    provider: 'chatgpt',
    provider_email: chatgptEmail || null,
    is_extra_org: isExtraOrg,
    install_id: await getOrCreateInstallId(),
    // Force = "store, don't dedup": the server's usage-only dedup (sig cache / D1) keys on
    // h5/d7/r7, so a plan/pending change with flat usage would otherwise be dropped. Set only on
    // plan/pending-change or user-manual sends (shouldForceProviderPost) — flat heartbeats stay dedupable.
    ...(force ? { force: true } : {}),
  };

  // Model-scoped limit (e.g. Codex 'GPT-5.3-Codex-Spark') rides the shared `seven_day_omelette`
  // slot — the same slot Claude reuses for its weekly_scoped model. The slot name says 7d for
  // historical reasons only; the row's `seven_day_omelette_window_seconds` says how long the
  // window actually is, which is why a 5h bucket may ride it now (#926). Only the primary org
  // carries additionalLimits; extra workspaces have none → slot stays unset.
  const scopedModel = pickScopedModel(org.additionalLimits);
  if (scopedModel) payload.seven_day_omelette = scopedModel;

  // Observation-only rider (#1184). The server writes this to Analytics Engine and stores NOTHING
  // in D1 — the hot path may not take on another D1 statement, read or write. Sent only when there
  // is something to say, so an ordinary heartbeat's body does not grow.
  //
  // 🔴 Deliberately NOT part of the dedup signature. The server's usage-only dedup keys on
  // h5/d7/r7, and that is correct here: if a bucket appears or a model gets gated while usage sits
  // flat, we would rather lose that observation than start forcing stores on every heartbeat.
  // The census is a population question ("which plans see which buckets"), not a per-account
  // timeline, so sampling it through whatever the dedup lets through is sufficient.
  // 🔴 `bucket_count` IS SENT WHEN IT IS ZERO. An earlier cut gated the whole rider on
  // "is there anything to say", counting 0 as nothing — which silently excluded the exact
  // population this rider exists to measure. #1184's open question is "when a Plus account has no
  // scoped bucket, is `additional_rate_limits[]` empty, or did pickScopedModel just not choose?"
  // Only a count-0 row answers that, and under the old gate the ordinary healthy account
  // ({ additional_rate_limits: [], model_usage: {...available...}, rate_limit_reached_type: null })
  // emitted no row at all. Its silence would then be indistinguishable from "not ChatGPT" /
  // "old client" / "dedup-skipped" / "flag off" — so the query in ae.ts would read
  // "no Plus account has an empty array", which is the opposite of what it means.
  //
  // Cost of always sending it: ~20 bytes, on ChatGPT snapshots that already passed the send gate.
  // The optional members below stay conditional — those really are "nothing to say" when absent.
  // 🔴 THREE states, not two, and every pair of them has been conflated at some point in this file:
  //
  //   key absent   — we never fetched /wham/usage for this org at all. EXTRA WORKSPACES are this:
  //                  the roster names them but usage needs a per-account token, so they arrive with
  //                  h5/d7 null and none of these fields set. They must emit NOTHING. Attaching an
  //                  empty rider would have AE record reached_type='none' + bucket_count=-1 for a
  //                  workspace we never looked at — phantom "healthy" rows contaminating the census.
  //   null         — we fetched, and the response had no `additional_rate_limits` field.
  //   object       — we fetched, and the field was there (count may legitimately be 0).
  //
  // `in` rather than a truthiness test precisely because null and undefined must part ways here:
  // the primary org always sets the key (to an object or to null), extra workspaces never set it.
  // 🔴 Separate from provider_obs below, which is a per-ACCOUNT census keyed to this snapshot.
  // This one is a per-INSTALL schema observation with its own flush cadence, and merging them
  // would tie a population question to a per-account dedup that drops most of its rows.
  if (driftRider) payload.drift_obs = driftRider;

  if ('bucketCensus' in org) {
    const census = org.bucketCensus;
    payload.provider_obs = {
      ...(census ? { bucket_count: census.count } : {}),
      ...(census && census.names.length ? { bucket_names: census.names } : {}),
      // `!== undefined` and NOT a truthiness test: null is a real, load-bearing value here
      // ("reported, nothing exhausted") and must survive into the payload as an explicit null.
      ...(org.reachedType !== undefined ? { reached_type: org.reachedType } : {}),
      ...(org.modelGates && org.modelGates.length
        ? { gated_models: org.modelGates.map((g) => g.model) }
        : {}),
    };
  }

  // Attach the next-billing date and any scheduled plan change so the server persists
  // them on this org's snapshot row (same `subscription` shape the Claude collector
  // uses). The server keeps `users.renewal_date`/`users.pending_plan` Claude-only, so
  // these never overwrite a Claude renewal/pending; the per-(org,provider) snapshot row
  // is what the dashboards read for ChatGPT.
  if (org.renewalDate || org.pendingPlan) {
    payload.subscription = {};
    if (org.renewalDate) payload.subscription.renewal_date = org.renewalDate;
    if (org.pendingPlan) {
      payload.subscription.pending_plan = org.pendingPlan;
      payload.subscription.pending_change_date = org.pendingChangeDate || null;
    }
  }

  // Shared helper handles auth recovery (401/403), account deletion (410),
  // and ext_token rotation — critical for independent accounts whose provider
  // snapshots are their only server contact. Returns the server result on
  // success, or null on any failure (caller uses this to gate the commit).
  // #1020: a send that never lands is invisible otherwise — the popup keeps showing local data
  // while the dashboard stays empty. `postSnapshot` only calls this for failures that have no
  // other surface; everything auth/upgrade/deletion related already raises its own popup state.
  //
  // 🔴 The outcome is ACCUMULATED for the whole cycle, not applied per POST. One provider can send
  // several snapshots (primary + extra workspaces); clearing on each success let a later workspace
  // 2xx erase the primary's failure, so the user was told everything was fine while their main
  // account never reached the server (Codex DEPLOY-BLOCKER).
  return await postSnapshot(config, payload, (code) => {
    if (!sendOutcome) return;
    if (code) sendOutcome.failed = sendOutcome.failed || code;
    else sendOutcome.ok += 1;
  });
}
