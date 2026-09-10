// Builds the usage payload the in-page sidebar renders, and pushes it.
// Moved verbatim out of background.js (#1126); only the `export` keywords and these imports are new.
import { diurnalProject7dAdaptive } from '../ui/diurnal.js';
import { hasProviderPermission } from './providers.js';
import { getLastStatus, getUsageHistory } from './storage.js';

// === Sidebar Usage: build data for content script ===
export async function buildSidebarUsageData(reqOrgId, provider) {
  const wantProvider = provider || 'claude';
  const [status, history, local] = await Promise.all([
    getLastStatus(),
    getUsageHistory(),
    new Promise(r => chrome.storage.local.get({ collectedOrgs: [], sidebarLang: null }, r)),
  ]);

  const allOrgs = local.collectedOrgs || [];
  // The Claude snapshot only describes Claude data — never apply it to a
  // non-Claude provider's panel (ChatGPT/Gemini).
  const snapshot = wantProvider === 'claude' ? status?.snapshot : null;

  // Each provider's in-page panel only displays that provider's data.
  const collectedOrgs = allOrgs.filter(o => (o.provider || 'claude') === wantProvider);
  if (!snapshot && collectedOrgs.length === 0) return null;

  // Determine which org to show. Claude content scripts pass the active org id
  // (lastActiveOrg cookie) and we respect it strictly. Non-Claude panels pass
  // no org id — fall back to the pinned/first org of that provider.
  let orgData = null;
  if (reqOrgId && collectedOrgs.length > 0) {
    orgData = collectedOrgs.find(o => o.uuid === reqOrgId);
    // Requested org not collected: return null (don't fall back to another org)
    if (!orgData) return null;
  }
  if (!orgData && collectedOrgs.length > 0) {
    orgData = collectedOrgs.find(o => o.isPrimary) || collectedOrgs[0];
  }

  // Prefer snapshot when it's for the same org and is newer than collectedOrgs.
  // Between setStatus (updates snapshot) and collectedOrgs write (happens after multi-org
  // polling), collectedOrgs can be stale — use timestamp comparison to pick the fresher source.
  const snapshotOrgMatch = snapshot && orgData &&
    snapshot.claude_org_uuid === orgData.uuid &&
    snapshot.five_hour?.utilization != null;
  const useSnapshot = snapshotOrgMatch && status?.timestamp &&
    (!orgData.updatedAt || status.timestamp >= orgData.updatedAt);

  const h5 = useSnapshot ? snapshot.five_hour.utilization : (orgData?.h5 ?? snapshot?.five_hour?.utilization ?? null);
  const d7 = useSnapshot ? (snapshot.seven_day?.utilization ?? orgData?.d7 ?? null) : (orgData?.d7 ?? snapshot?.seven_day?.utilization ?? null);
  const r5 = useSnapshot ? (snapshot.five_hour?.resets_at ?? orgData?.resetsAt5h ?? null) : (orgData?.resetsAt5h ?? snapshot?.five_hour?.resets_at ?? null);
  const r7 = useSnapshot ? (snapshot.seven_day?.resets_at ?? orgData?.resetsAt7d ?? null) : (orgData?.resetsAt7d ?? snapshot?.seven_day?.resets_at ?? null);
  const plan = orgData?.plan || snapshot?.plan || null;

  // Extra usage
  const eu = orgData?.extraUsage;
  const euEnabled = !!(eu && eu.is_enabled);
  const euUsed = eu?.used_credits ?? null;
  const euLimit = eu?.monthly_limit ?? null;

  // Prediction calculation (reuse popup logic)
  const pred5h = calcSidebarPrediction(history, 'h5', h5, r5, reqOrgId || orgData?.uuid, wantProvider);
  const pred7d = calcSidebarPrediction(history, 'd7', d7, r7, reqOrgId || orgData?.uuid, wantProvider);

  // Language detection
  const lang = local.sidebarLang || (snapshot?.user_lang) || 'en';

  // No-limit plan (Gemini Workspace/Business/Enterprise): the collector sets this
  // by plan (these seats report 0% windows, not null), so trust the stored flag.
  const noLimits = !!orgData?.noLimits;

  // Per-feature buckets and provider-declared model gates ride along for the in-page panels.
  // 🔴 ChatGPT ONLY, by construction rather than by convention: the note the sidebar draws next to
  // these ("the percentage excludes text chat") is true for ChatGPT and false for Claude, whose
  // gauge really is all usage. `wantProvider` is the resolved provider, not a non-Claude catch-all
  // — the same distinction #1209's guard pins down on the dashboard, where gating on "not Claude"
  // would have put the note on Gemini.
  const isChatGPT = wantProvider === 'chatgpt';
  const addl = isChatGPT && Array.isArray(orgData?.additionalLimits) ? orgData.additionalLimits : null;
  const gates = isChatGPT && Array.isArray(orgData?.modelGates) ? orgData.modelGates : null;

  // 🔴 The reported window SPANS. They were already stored on the org (`w5s`/`w7s`, written by the
  // collectors) and simply never returned here, so every in-page widget labelled by SLOT instead —
  // "주간 사용률" on ChatGPT Free's 30-day window (inquiry #198). The popup got this right in #954
  // via ui/util.js; the content scripts could not, because the data stopped at this function.
  const w5s = orgData?.w5s ?? null;
  const w7s = orgData?.w7s ?? null;

  // 🔴 The provider answered and withheld the windows (inquiry #198). Distinct from "no data yet",
  // which is what every widget used to say in this situation — and saying "수집 중" about something
  // that will never arrive is how a provider policy change reads as our bug.
  //
  // 🔴 THE STORED FLAG IS NECESSARY, NOT SUFFICIENT. It records a fact about ONE response; the
  // values below are assembled from several sources (this org, a possibly fresher snapshot, an
  // adaptive-poll cache) by writers that do not all set it. Trusting it alone put the notice over
  // working gauges in three separate ways, all reproduced by Codex:
  //   · extra usage present — the notice returned before the spend branch and hid a live gauge
  //   · recovery — org-merge spreads the previous org, so a stale `true` outlived the withholding
  //     itself (`{noUsage: true, h5: 25}`)
  //   · the snapshot/org seam — gauges taken from the fresher snapshot, the flag from the older
  //     org (`{h5: 25, d7: 35, noUsage: true}`)
  // Requiring the SAME payload to be empty makes all three impossible by construction: whatever the
  // flag says, a notice can only appear when there is genuinely nothing on this panel to show.
  //
  // 🪤 The conjunction is deliberately one-directional. A missing flag means no notice (the old
  // blank/"수집 중" behaviour), which is a lost improvement; a wrong notice would be a false
  // statement about the user's account. Only one of those two is acceptable to get wrong.
  const nothingToShow = h5 == null && d7 == null && !euEnabled && euUsed == null && euLimit == null;
  const noUsage = !!orgData?.noUsage && nothingToShow;

  return {
    plan, h5, d7, r5, r7, w5s, w7s, noUsage, eu: euUsed, el: euLimit, euEnabled, pred5h, pred7d, lang, noLimits,
    addl: addl && addl.length ? addl : null,
    gates: gates && gates.length ? gates : null,
    // 🔴 `reachedType` is deliberately NOT returned. It is the most interesting field we now
    // collect — the provider's own answer to "is anything actually exhausted", which is the
    // question behind 문의 #195/#196 — but no panel reads it yet, and a populated field with no
    // reader is worse than an absent one: the next person assumes a consumer exists.
    //
    // It is also not ready to be shown. Every observation we have of it is `null` (n=1, the live
    // 2026-09-07 capture); we have never seen it carry a value in production. Telling a user at
    // 100% "nothing is blocked" on the strength of a field we have never seen populated is exactly
    // the kind of unvalidated claim this whole change exists to stop making. The AE `cg_obs`
    // stream collects it now — wire the UI once the readout says what values actually occur.
  };
}

// Lightweight prediction for sidebar (mirrors popup calcPredictedAtReset)
function calcSidebarPrediction(history, key, currentUtil, resetsAt, orgUuid, provider) {
  if (!resetsAt || currentUtil == null || !history || history.length < 3) return null;

  const now = Date.now();
  const hoursToReset = (new Date(resetsAt).getTime() - now) / 3600000;
  if (hoursToReset <= 0) return null;

  // Filter history for matching org. The legacy unscoped (no `org`) points are
  // pre-multi-org Claude samples — only fold them into Claude predictions, never
  // into a non-Claude provider's (which would skew ChatGPT/Gemini estimates).
  const allowUnscoped = (provider || 'claude') === 'claude';
  const orgHistory = orgUuid
    ? history.filter(p => p.org === orgUuid || (allowUnscoped && !p.org))
    : history;

  let rate = null;
  let hoursDiff = 0;

  if (key === 'd7') {
    // 7d: activity-normalized adaptive projection. Mirrors ui/prediction.js calcPredictedAtReset —
    // keep the CORE and this sidebar duplicate in sync (docs/DESIGN-rate-estimator.md).
    // EWMA burn rate over ~48h of activity time, projected through the user's personal
    // diurnal + weekly curve (global fallback when data is thin). Pass the org-scoped history
    // so the personal curve is built from this org's own samples.
    const samples = orgHistory
      .filter(p => p.d7 != null && p.r7)
      .map(p => ({ tMs: p.t, util: p.d7, resetMs: new Date(p.r7).getTime() }));
    const dp = diurnalProject7dAdaptive({ samples, currentUtil, resetMs: new Date(resetsAt).getTime(), nowMs: now });
    if (!dp || dp.rate <= 0 || dp.predicted - currentUtil < 3) return null;
    return Math.round(dp.predicted);
  } else {
    const lookbacks = [2 * 3600000, 6 * 3600000, Infinity];
    let valid = [];
    for (const lb of lookbacks) {
      valid = orgHistory.filter(p => p[key] != null && (lb === Infinity || p.t > now - lb));
      if (valid.length >= 2) break;
    }
    if (valid.length < 2) return null;
    const first = valid[0], last = valid[valid.length - 1];
    hoursDiff = (last.t - first.t) / 3600000;
    if (hoursDiff < 0.5) return null;
    rate = (last[key] - first[key]) / hoursDiff;
  }

  if (rate == null) return null;
  const predicted = currentUtil + (rate * hoursToReset);
  if (rate <= 0 || predicted - currentUtil < 3) return null;
  return Math.round(predicted);
}

// Notify in-page usage panels (Claude + provider) to re-fetch with their own
// orgId/provider. Each content script re-requests GET_SIDEBAR_USAGE on receipt.
export async function pushSidebarUsage() {
  // Query each origin independently: a tabs.query that includes an origin the
  // extension lacks host permission for (chatgpt.com is optional) can reject,
  // and a combined query would then drop the Claude refresh too. Claude is
  // always granted; ChatGPT only when its optional permission is present.
  const refresh = (tab) => chrome.tabs.sendMessage(tab.id, { type: 'SIDEBAR_USAGE_REFRESH' }).catch(() => {});
  try {
    const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    for (const tab of tabs) refresh(tab);
  } catch { /* content script may not be ready */ }
  try {
    if (await hasProviderPermission('chatgpt')) {
      const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
      for (const tab of tabs) refresh(tab);
    }
  } catch { /* no permission / not ready */ }
  try {
    if (await hasProviderPermission('gemini')) {
      const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
      for (const tab of tabs) refresh(tab);
    }
  } catch { /* no permission / not ready */ }
}
