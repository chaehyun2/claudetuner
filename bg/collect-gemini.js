import { fetchGeminiRpc, isGeminiLoggedIn, getGeminiUserInfo, listGeminiAccounts, invalidateGeminiAccounts } from './api-gemini.js';
import { platformField } from './platform.js';
// The plan-policy RPC (`otAQ7b`) — the same call the vendored client reads the model picker from
// (#2054), so its id is spelled once.
import { GEMINI_PICKER_RPC_ID } from '../vendor-ai/models.js';
// Pure response parsing lives in its own chrome-free module so the contract runner can import it
// (#1315). collectGemini() keeps every await: parse-gemini.js decides from parsed values and only
// REPORTS which stored state must then be consulted.
import { parseGeminiWindows, parseGeminiPolicy, resolveGeminiPlan, geminiUltraSubTier,
  geminiTierFromQuota } from './parse-gemini.js';
import { geminiUsageShape, unclassifiedCode } from './drift-obs.js';
import { noteDriftOutcome, buildDriftRider } from './drift-store.js';
import { getConfig, appendUsageHistory, getUsageHistory, postSnapshot, getOrCreateInstallId, recordGeminiMetered, rememberGeminiUltraTier, resolveIngestIdentity } from './storage.js';
import { gateProviderSnapshot, shouldForceProviderPost } from './send-gate.js';
import { noteProviderAttempt, noteProviderSuccess, noteProviderError,
         noteProviderSendError, noteProviderSendOk } from './provider-state.js';

// The in-band status bg/api-gemini.js attaches as `e.inBandCode` (a number, or `status`), recorded as
// the drift code `err_gemini_in_band:<it>` (≤28 chars — AE caps a drift code at 32).
const IN_BAND_CODE_RE = /^(?:\d{1,9}|status)$/;

/**
 * Collect Gemini usage data via jSf9Qc RPC.
 * Response: [planId, [[used, percent, windowType, [[resetSec, resetNano]]], ...], false]
 *   windowType 1 = 5-hour, windowType 2 = weekly
 * Returns { success, orgs: [{ uuid, name, plan, provider, isPrimary, h5, d7, ... }] }
 */
export async function collectGemini(force = false, userManual = false) {
  await noteProviderAttempt('gemini');
  const loggedIn = await isGeminiLoggedIn();
  if (!loggedIn) {
    // See the ChatGPT twin: the signed-out precheck returns before any API call, so it never
    // produced an `err_gemini_*` code and the commonest failure stayed invisible (#852).
    await noteProviderError('gemini', 'err_gemini_not_logged_in');
    // Counted, but with no event: there is no response to have a shape, and a precheck is not
    // schema drift. It still belongs in the denominator — otherwise a provider nobody is signed
    // into and a provider that broke look the same from the success rate alone.
    await noteDriftOutcome('gemini', 'error', null);
    return { success: false, orgs: [] };
  }

  // Every Google account signed in to this browser is its own Gemini account (#2709). A listing
  // that fails or finds none leaves the single-account path exactly as it was.
  let accounts = null;
  try {
    accounts = await listGeminiAccounts();
  } catch (e) {
    console.warn('[Claude Tuner] Gemini account listing failed:', e.message);
  }
  // Only an answer from the DEFAULT account (/u/0) may write the provider status here: when the
  // first tab shows /u/1, its success is not the default account's (Codex R1-B3).
  if (!accounts || accounts.length === 0) return collectGeminiAccount(undefined, { force, userManual, statusOnlyIfDefault: true });

  // The default account (/u/0) is collected LAST and is the only one that writes the provider's
  // status (error/success/send outcome): the popup's one Gemini status line describes it, and a
  // secondary account's failure must neither hide its success nor be hidden by it. Secondary
  // accounts send under the default account's identity, so a token-less install never turns one
  // browser into several users.
  const [primary, ...others] = accounts;
  const orgs = [];
  const gone = new Set();
  for (const acc of [...others, primary]) {
    const r = await collectGeminiAccount(acc.authuser, {
      force, userManual, expect: acc, quiet: acc !== primary, identityEmail: primary.email,
    });
    orgs.push(...r.orgs);
    if (r.gone) gone.add(acc.googleId);
  }
  orgs.sort((a, b) => a.authuser - b.authuser);
  // Listed accounts that did not come back this cycle (a failure, an overlapping collection) keep
  // their last stored org instead of vanishing from the list (Codex R1-B1) — except one shown to be
  // signed out (its /u/<n> redirects or answers as someone else): the cached listing still names it,
  // and keeping it would hold a signed-out account until the list expires (Codex R2-B2).
  const keepUuids = accounts.map((a) => a.googleId).filter((id) => id && !gone.has(id) && !orgs.some((o) => o.uuid === id));
  return { success: orgs.length > 0, orgs, keepUuids };
}

/**
 * Collect ONE Gemini account.
 * @param {number|undefined} authuser - the /u/<n> account; undefined = legacy single-account path.
 * @param {object} opts
 * @param {{googleId?: string|null, email?: string|null}} [opts.expect] - who the listing says /u/<n>
 *   is. If the account that ANSWERED is someone else (indices shift on sign-out), nothing is stored.
 * @param {boolean} [opts.quiet] - do not write the provider-level status (secondary accounts).
 * @param {string|null} [opts.identityEmail] - provider email used to resolve the server identity.
 * @param {boolean} [opts.statusOnlyIfDefault] - single-account path: become quiet once the answer
 *   turns out to come from a /u/<n> other than the default account.
 * Returns `{ success, orgs, gone? }` — `gone`: this account is shown to be signed out.
 */
async function collectGeminiAccount(authuser, { force = false, userManual = false, expect = null, quiet = false, identityEmail = null, statusOnlyIfDefault = false } = {}) {
  // Per-cycle send outcome — same rule as the ChatGPT twin.
  const sendOutcome = { failed: null, ok: 0 };
  try {
    // Where THIS answer came from — the identity below must name the same observation (R1-B1).
    const observe = {};
    const data = await fetchGeminiRpc('jSf9Qc', '[]', authuser, observe);
    if (statusOnlyIfDefault && Number.isInteger(observe.authuser) && observe.authuser !== 0) quiet = true;

    const shape = geminiUsageShape(data);
    const parsed = parseGeminiWindows(data);
    if (!parsed) {
      console.warn('[Claude Tuner] Gemini: unexpected jSf9Qc response');
      // Same silent shape #852 is about: no throw, so no code, so nothing to show. The ChatGPT
      // twin records this; leaving Gemini out would reopen the defect on one provider only
      // (Codex DEPLOY-BLOCKER).
      if (!quiet) await noteProviderError('gemini', 'err_gemini_collect_failed');
      // 🔴 THE HOLE #1322 IS ABOUT. This return produces no snapshot, so without the line below the
      // broken response never reaches the server at all — it vanishes from the successful-ingest
      // population, and the observation goes blank at precisely the moment the provider changed
      // something. The shape is computed on the RAW response above, before this give-up, and is
      // held until a request that is already going out can carry it.
      await noteDriftOutcome('gemini', 'parse_fail', {
        stage: 'parse', code: 'err_gemini_collect_failed',
        sig: shape.sig, unknownKeys: shape.unknownKeys, unknownWithheld: shape.unknownWithheld,
      });
      return { success: false, orgs: [] };
    }
    await noteDriftOutcome('gemini', 'success', null);

    const {
      planId, h5, d7, resetsAt5h, resetsAt7d,
      remaining5h, remaining7d, pct5hRaw, pct7dRaw, sawRawUsage,
    } = parsed;

    // Get user profile from page context (more reliable than o30O0e RPC)
    let email = null;
    let googleId = null;
    try {
      const userInfo = await getGeminiUserInfo(observe);
      email = userInfo.email;
      googleId = userInfo.googleId;
      if (!email && !googleId) console.warn('[Claude Tuner] Gemini: could not extract user info from page');
    } catch (e) {
      console.warn('[Claude Tuner] Gemini user info failed:', e.message);
    }

    // The listing named who /u/<n> is; the page that served the usage says who answered. A mismatch
    // means the indices moved since the listing (a sign-out) — storing would file one account's
    // usage under another's id, so this cycle stores nothing and the list is read again next time.
    // An answer we could not NAME (the tab closed before the identity read) is skipped too, but it
    // is no evidence of a sign-out — the account keeps its stored org (Codex R3-B1).
    if (expect && !googleId && !email) {
      console.warn('[Claude Tuner] Gemini: /u/' + authuser + ' answered but could not be identified — skipped');
      return { success: false, orgs: [] };
    }
    if (expect && expect.googleId && googleId && expect.googleId !== googleId) {
      console.warn('[Claude Tuner] Gemini: /u/' + authuser + ' answered as a different account — skipped');
      invalidateGeminiAccounts();
      return { success: false, orgs: [], gone: true };
    }

    const accountId = googleId || 'gemini-unknown';

    // Authoritative tier detection via the otAQ7b policy string. planId is unreliable
    // (observed 2=Workspace, 4=AI Plus, null=AI Pro) so it is only a fallback when the
    // policy RPC fails. See docs/DESIGN-gemini-policy-detection.md.
    let otResponse = null;
    let otOk = false;   // true only when otAQ7b returned a well-formed (array) response
    try {
      const otObserve = {};
      otResponse = await fetchGeminiRpc(GEMINI_PICKER_RPC_ID, '[]', authuser, otObserve);
      otOk = Array.isArray(otResponse);
      // 🔴 THE SAME ACCOUNT AS THE USAGE (deploy-1.56.8 B3): /u/<n> can move between the two RPCs
      // (an earlier account signs out) — a policy from another account would label this one.
      // Unnamed or different → the policy is not used (planId / quota decide, as for a failed RPC).
      if (otOk && Number.isInteger(authuser) && googleId) {
        const otWho = await getGeminiUserInfo(otObserve).catch(() => null);
        if (!otWho || otWho.googleId !== googleId) { otResponse = null; otOk = false; }
      }
    } catch (e) {
      console.warn('[Claude Tuner] Gemini otAQ7b failed:', e.message);
    }
    const { policies, geminiPolicy, tierWord } = parseGeminiPolicy(otResponse, otOk);

    // The plan LABEL is decided from parsed signals only (bg/parse-gemini.js); the two state
    // lookups it can ask for are performed here, where their awaits are visible.
    let { plan, noLimits, needsUltraSubTier, needsStickyMetered } =
      resolveGeminiPlan({ policies, tierWord, planId, otOk,
        quotaTier: geminiTierFromQuota(remaining7d, pct7dRaw, remaining5h, pct5hRaw) });

    // Ultra 5x vs 20x share one policy — refine the label by quota so planMultiplier can
    // apply 5x vs 20x (ChatGPT "Pro 5x"/"Pro 20x" pattern). The quota (remaining) signal is
    // OPTIONAL: if it's unavailable this cycle (or Google drops it entirely) we reuse the
    // last remembered sub-tier; if never determined, keep base 'AI Ultra' (multiplier 5).
    if (needsUltraSubTier) {
      const freshSub = geminiUltraSubTier(remaining7d, pct7dRaw, remaining5h, pct5hRaw);
      const sub = await rememberGeminiUltraTier(googleId || email || null, freshSub);
      if (sub) plan = sub;
    }

    // The planId-based Workspace guess is provisional: treat the account as metered the moment we
    // ever see real (>0) usage, and remember it (sticky) so a later 0% window doesn't re-hide a
    // consumer account. Genuine Workspace seats stay pinned at 0%, never get marked, keep noLimits.
    if (needsStickyMetered) {
      const meteredKey = googleId || email || null;
      let usageEver = sawRawUsage;
      if (!usageEver && meteredKey) {
        const hist = await getUsageHistory().catch(() => []);
        usageEver = hist.some(p => p.org === accountId && ((p.h5 > 0) || (p.d7 > 0)));
      }
      const everMetered = await recordGeminiMetered(meteredKey, usageEver);
      noLimits = !everMetered;
    }

    const org = {
      uuid: accountId,
      name: email || 'Gemini',
      email: email || null, // provider account email (shown in the popup footer)
      plan,
      provider: 'gemini',
      isPrimary: false,
      // The /u/<n> the usage was read from — the in-page panel shows the org of the account on screen.
      // Taken from the observation, so the single-account path (listing failed) tags the account it
      // actually read too, not only the listed ones (Codex R1-B3).
      ...(Number.isInteger(observe.authuser) ? { authuser: observe.authuser } : {}),
      h5,
      d7,
      resetsAt5h,
      resetsAt7d,
      noLimits,
      spendUsed: null,
      spendLimit: null,
      extraUsage: null,
      // Raw signals for server-side AE collection (not shown in the popup)
      geminiPolicy,
      remaining5h,
      remaining7d,
      pct5hRaw,
      pct7dRaw,
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
    // `plan` opts this gate into plan-change detection (send-gate.js): a Gemini tier change
    // (incl. Ultra 5x↔20x, which carries a different multiplier) must POST promptly rather than
    // batch with later usage and be zeroed by the server's plan-change delta guard.
    const gateValues = { h5: org.h5, d7: org.d7, extraUsed: null, resetsAt5h: org.resetsAt5h, resetsAt7d: org.resetsAt7d, plan: org.plan };
    const gate = await gateProviderSnapshot(org.uuid, gateValues, { force, provider: 'gemini', userManual });
    if (gate.send) {
      // Commit only on a confirmed-successful POST so a failed send leaves the
      // gate unadvanced and the next cycle retries (no silent drop of a change).
      // A plan change (incl. Ultra 5x↔20x, different multiplier) or a user-manual collect marks the
      // POST force so the server stores it instead of dropping it via usage-only dedup (which keys
      // on h5/d7/r7, not plan). Mirrors the ChatGPT collector; an unrelated Claude-triggered global
      // force does NOT force-store a flat Gemini snapshot (shouldForceProviderPost).
      // Riding an existing POST — this does not decide WHETHER to send, only what the body says.
      // `driftCommit` runs after a confirmed send, so a failed POST keeps the observation for the
      // next carrier instead of discarding it (an install whose sends fail is part of what this
      // measures, so losing its data on failure would eat the signal at its most interesting edge).
      const { rider: driftRider, commit: driftCommit } = await buildDriftRider('gemini', shape, {
        label: plan,
        raw: policies.length ? (tierWord || 'policy')
          : (planId === null || planId === undefined ? null : String(planId)),
      });
      const res = await sendGeminiSnapshot(org, email, plan, { identityEmail, force: shouldForceProviderPost(gate.reason, userManual), sendOutcome, driftRider, sendMeta: gate.meta }).catch(e => {
        console.warn('[Claude Tuner] Gemini snapshot send failed:', e.message);
        sendOutcome.failed = sendOutcome.failed || 'err_send_failed';
        return null;
      });
      if (res) { await gate.commit(); if (driftRider) await driftCommit(); }
    } else {
      console.log(`[Claude Tuner] Gemini delta-gate skip (${gate.reason})`);
    }

    if (!quiet) {
      await noteProviderSuccess('gemini', email);
      if (sendOutcome.failed) await noteProviderSendError('gemini', sendOutcome.failed);
      else if (sendOutcome.ok) await noteProviderSendOk('gemini');
    }
    return { success: true, orgs: [org] };
  } catch (e) {
    console.warn('[Claude Tuner] Gemini collection failed:', e.message);
    // A /u/<n> that redirects (err_gemini_not_logged_in, bg/api-gemini.js) is a signed-out account.
    const gone = !!(e && e.message === 'err_gemini_not_logged_in');
    if (gone) invalidateGeminiAccounts();
    if (quiet) {
      await noteDriftOutcome('gemini', 'error', { stage: 'collect', code: 'err_gemini_collect_failed' });
      return { success: false, orgs: [], gone };
    }
    const st = await noteProviderError('gemini', e);
    // 🔴 AN EVENT, NOT ONLY A COUNTER — and the reason is the HTTP STATUS.
    //
    // `noteDriftOutcome(p, 'error', null)` increments a counter, and counters ride ONLY that
    // provider's shape rider, which needs a snapshot to have gone out. A provider that NEVER
    // succeeds therefore emitted nothing on this axis at all: verified on a real account
    // (2026-09-11), zero chatgpt rows over a week of continuous failure while claude and gemini
    // rows flowed from the same install.
    //
    // GA does count the reason, so this is not the only channel — but `noteProviderError` sends
    // `baseReason(code)`, which DROPS the status on purpose, so GA can never say whether a failure
    // was a 404 or a 500. This event is the only carrier that keeps `:NNN`.
    //
    // 🪤 WRITTEN BEFORE THE SPLIT LANDED, AND IT WENT STALE INSIDE ITS OWN PR. This used to say
    // Gemini's catch-all was "NOT split yet" with `auth_failed` as its only status-bearing code —
    // and the very PR that added this comment then split it (#1418). Gemini now carries
    // `err_gemini_http:NNN` and `err_gemini_page_fetch:NNN` too, so what rides here is the specific
    // code far more often than the bare catch-all. (Caught by the pre-deploy batch review for
    // v1.29.74, which is what that review is for: a claim that was true when written and false by
    // the time the batch shipped.)
    //
    // 🪤 The PRECHECK path above is deliberately still counter-only. It is 5,185 install-days in
    // the 8 days to 2026-09-10 — the largest single reason — and it carries no status and nothing
    // we do not already know. Widening it would buy volume, not signal.
    // No shape: the throw may have come from the fetch, before there was a response to read.
    // 🔑 A FINER CODE FOR THE OBSERVATION ONLY — the stored, user-facing code is untouched above.
    //
    // The API layer converts everything it throws into an `err_gemini_*` code, so a message that
    // does NOT start with `err_` cannot have come from there: it is an exception out of OUR
    // collection logic (a parse, a field that was not the shape we assumed). Claude names that
    // `err_claude_unclassified` (bg/collect.js:1884) and it is the same question here — "is this
    // the provider or is this us" halves the search space.
    //
    // 🪤 It stays OUT of PROVIDER_ERROR_CODES on purpose. A user cannot act on "unclassified", and
    // the sentence they should read is the same one `collect_failed` already gives them. The split
    // is for the readout, so it lives only where the readout looks.
    // 🔑 Same for an IN-BAND STATUS (#2067, bg/api-gemini.js parseBatchExecuteResponse): Gemini
    // answered with a status row instead of a payload. It used to come back `null` and be filed as
    // `parse_fail` — schema drift, which it is not. The user still reads `collect_failed` (no new
    // copy to learn for a code they cannot act on); the observation keeps the code — digits or
    // `status`, nothing from the answer's text.
    const rawMsg = (e && e.message) || '';
    const storedCode = (st && st.lastError && st.lastError.code) || 'err_gemini_collect_failed';
    let driftCode = storedCode;
    if (storedCode === 'err_gemini_collect_failed' && e && e.inBand && IN_BAND_CODE_RE.test(String(e.inBandCode))) driftCode = `err_gemini_in_band:${e.inBandCode}`;
    else if (storedCode === 'err_gemini_collect_failed' && rawMsg.indexOf('err_') !== 0) driftCode = unclassifiedCode('err_gemini_unclassified', e);
    await noteDriftOutcome('gemini', 'error', { stage: 'collect', code: driftCode });
    return { success: false, orgs: [], gone };
  }
}

// Send Gemini snapshot to server (same /api/snapshots endpoint)
async function sendGeminiSnapshot(org, geminiEmail, plan, { identityEmail = null, force = false, sendOutcome = null, driftRider = null, sendMeta = null } = {}) {
  const config = await getConfig();
  if (!config.serverUrl) return;

  // Server identity — ONE rule for every collector, in bg/storage.js (see
  // docs/DESIGN-authenticated-attribution.md). The ext_token identity now wins: if this install
  // proved it is A, this provider's usage belongs to A even though the Gemini account is B.
  // `accountCache` is still read here for isExtraOrg below (a Claude account means this
  // provider is an extra org, which is a different question from identity).
  const { accountCache } = await chrome.storage.local.get({ accountCache: null });
  const serverEmail = await resolveIngestIdentity(identityEmail || geminiEmail);
  if (!serverEmail) {
    console.warn('[Claude Tuner] Gemini snapshot skipped: no email (no Claude/independent account and no Gemini email)');
    return;
  }

  // When there is no Claude account, this provider is the user's primary data,
  // so the snapshot must maintain the users row (current_plan, last_seen_at).
  // For Claude users it's an "extra org" that must not overwrite current_plan.
  const isExtraOrg = !!accountCache?.email;

  const extVersion = chrome.runtime.getManifest().version;

  const payload = {
    user_email: serverEmail,
    plan,
    collected_at: new Date().toISOString(),
    ext_version: extVersion,
    five_hour: {
      utilization: org.h5,
      resets_at: org.resetsAt5h,
      remaining_raw: org.remaining5h ?? null,
      percent_raw: org.pct5hRaw ?? null,
    },
    seven_day: {
      utilization: org.d7,
      resets_at: org.resetsAt7d,
      remaining_raw: org.remaining7d ?? null,
      percent_raw: org.pct7dRaw ?? null,
    },
    // Raw otAQ7b policy string (authoritative tier signal) — collected into AE.
    gemini_policy: org.geminiPolicy || null,
    claude_org_uuid: org.uuid,
    provider: 'gemini',
    provider_email: geminiEmail || null,
    is_extra_org: isExtraOrg,
    install_id: await getOrCreateInstallId(),
    // #1445 step B. 🔴 A CLAIM from the request BODY — the server stores it under `claimed_`
    // and never lets it overwrite what it derived from the request's own headers.
    // Spread, not assigned: an unreadable platform must be ABSENT, never `null`.
    ...(await platformField()),
    // Force = "store, don't dedup": the server's usage-only dedup keys on h5/d7/r7, so a plan
    // change with flat usage would otherwise be dropped. Set only on force/plan-change sends.
    ...(force ? { force: true } : {}),
    // 🔴 Observation only, and deliberately NOT part of the dedup signature — same rule the
    // ChatGPT rider follows. If a response shape changes while usage sits flat we would rather
    // lose that observation than start forcing a store on every heartbeat.
    ...(driftRider ? { drift_obs: driftRider } : {}),
    // #2333: is_heartbeat + send_reason (send-gate.js sendMeta) — observation, not a dedup input.
    ...(sendMeta || {}),
  };

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
