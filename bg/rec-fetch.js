// === Plan recommendation fetch ===
// Pull plan recommendations from the worker on a slow timer instead of relying on the ingest
// POST response. The snapshot POST response used to carry `result.recommendation`, but that path
// is now cache-only and mostly null, so a dedicated GET is the authoritative delivery channel.
//
// The GET returns ALL of the user's recommendations at once:
//   { recommendation, recommendations_by_provider: { <provider>: { <orgUuid|'-'>: <rec> } } }
// `recommendation` is the Claude (org-less) legacy slot; `recommendations_by_provider` holds the
// non-Claude per-org recs. Both rec objects are already extension-formatted (same shape the ingest
// POST response `result.recommendation` carried), so the popup renderer reads them verbatim from
// `lastStatus.recommendation` and `lastStatus.recommendations_by_provider[provider][org||'-']`.

import { authedFetch, getLastStatus, setStatus } from './storage.js';

/**
 * Fetch plan recommendations from the worker and persist them into lastStatus.
 *
 * Replaces `recommendations_by_provider` WHOLESALE: the GET returns every pair the user has, so a
 * full replace also removes recs for orgs the user no longer belongs to (stale-org cleanup). Both
 * `recommendation` and `recommendations_by_provider` are passed explicitly to setStatus so its
 * preservation escape-hatch writes exactly what we computed rather than carrying the old map.
 *
 * Best-effort: never throws and never disrupts collection. On a bad token authedFetch already
 * clears it (401), so a non-ok response is a silent no-op here.
 */
export async function fetchRecommendations(config) {
  try {
    if (!config || !config.serverUrl) return;
    const response = await authedFetch(config, `${config.serverUrl}/api/recommendations`, { method: 'GET' });
    if (!response.ok) return; // authedFetch handles 401 token clearing; nothing else to do

    const data = await response.json().catch(() => null);
    if (!data) return;

    const recommendation = data.recommendation != null ? data.recommendation : null;
    const recommendations_by_provider = data.recommendations_by_provider || {};

    // Overwrite stored recs ONLY on a COMPLETE, non-empty result. The server sets `complete:false`
    // when any read/compute failed, and returns an empty body when latest_snapshot has no row yet
    // (a fetch racing the first ingest write, or a not-yet-backfilled user). In either case a
    // wholesale write here would WIPE recs already stored by the POST path or a prior complete
    // fetch — so leave the stored map untouched and let the next fetch retry.
    const hasAny = recommendation != null || Object.keys(recommendations_by_provider).length > 0;
    if (data.complete === false || !hasAny) return;

    const cur = (await getLastStatus()) || {};
    // Spread to preserve every other lastStatus field; both rec keys passed explicitly so
    // setStatus writes them as-is (own `recommendations_by_provider` key wins its escape-hatch).
    // `recommendations_by_provider` is replaced wholesale — safe here because a complete result is
    // authoritative over the user's full set of pairs (this is what removes stale orgs).
    await setStatus(Object.assign({}, cur, {
      recommendation,
      recommendations_by_provider,
    }));
  } catch (e) {
    console.warn('[rec-fetch] Failed to fetch recommendations:', e);
  }
}
