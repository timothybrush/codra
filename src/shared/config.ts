// Bumped to v3 when the default `review.min_severity` moved from 'nit' to 'P3', so cached repo
// configs are re-read rather than serving the stale materialized value for up to 10 minutes.
export const REPO_CONFIG_CACHE_VERSION = 'v3';
