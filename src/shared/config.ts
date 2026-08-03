// Bumped to v3 when the default `review.min_severity` moved from 'nit' to 'P3', so cached repo
// configs are re-read rather than serving the stale materialized value for up to 10 minutes.
//
// v4: `review.min_confidence` default moved 0.6 -> 0 and `review.deny_claim_types` was added
// (migration 005). Without this bump, cached configs would serve min_confidence 0.6 for up to 10
// minutes after deploy -- and that value has just become live for the first time on providers that
// ignore response schemas, so it would be actively filtering on an inverted signal.
export const REPO_CONFIG_CACHE_VERSION = 'v4';
