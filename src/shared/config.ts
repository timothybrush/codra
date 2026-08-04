// Bumped to v3 when the default `review.min_severity` moved from 'nit' to 'P3', so cached repo
// configs are re-read rather than serving the stale materialized value for up to 10 minutes.
//
// v4: `review.min_confidence` default moved 0.6 -> 0 and `review.deny_claim_types` was added
// (migration 005). Without this bump, cached configs would serve min_confidence 0.6 for up to 10
// minutes after deploy -- and that value has just become live for the first time on providers that
// ignore response schemas, so it would be actively filtering on an inverted signal.
//
// v5: `review.generator_profile` was added. loadRepoConfig returns the cached entry WITHOUT
// re-parsing it through repoConfigSchema, so an entry written before this key existed carries no
// `generator_profile` at all -- the prompt builder would fall back to strict for up to 10 minutes
// after deploy on exactly the repos that are busiest. Parse-on-read supplies the default for stored
// DB rows, so no data migration is needed; only the cache has to be invalidated.
//
// v6: `review.rules` was added. Same reason as v5 — loadRepoConfig returns the cached entry without
// re-parsing, so an entry written before this key existed would carry no `rules` and the channel
// would stay off for up to 10 minutes after deploy on exactly the busiest repos.
export const REPO_CONFIG_CACHE_VERSION = 'v6';
