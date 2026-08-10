// Bump whenever a default changes or a key is added OR REMOVED: loadRepoConfig returns the cached entry
// WITHOUT re-parsing it, so without a bump the stale value is served for up to 10 minutes after
// deploy. Parse-on-read supplies defaults for stored DB rows, so this needs no data migration.
//
// v3: `review.min_severity` default 'nit' -> 'P3'.
// v4: `review.min_confidence` default 0.6 -> 0, `review.deny_claim_types` added (migration 005, now folded into 003_grounding.sql).
// v5: a generator-restraint key, added then removed. Listed because versions are never reused.
// v6: `review.rules` added.
// v7: `review.batch_small_files` added.
export const REPO_CONFIG_CACHE_VERSION = 'v7';
