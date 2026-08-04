-- One jsonb encoding, everywhere.
--
-- Migration 007 fixed file_reviews.withheld_counts, which was written via JSON.stringify() bound to a
-- `$n::jsonb` placeholder -- postgres.js types that as json and stores a jsonb STRING SCALAR, so every
-- SQL JSON operator silently reads nothing. The same bug was live at five more write sites, because
-- `parseJsonColumn` tolerates both shapes and therefore nothing ever broke loudly:
--
--   repo_configs.parsed_json          11 rows  -- forced 003 and 005 to branch around it
--   jobs.config_snapshot             204 rows
--   webhook_deliveries.payload     1,000 rows
--   repo_configs.fallback_models       0 rows  -- all NULL today; write path was still wrong
--   repo_configs.size_overrides        0 rows
--
-- The writers now bind `$n::text::jsonb`, which is correct for objects AND arrays (binding the raw
-- value is not: db/client.ts normalizeParam turns a JS array into a Postgres array literal, which
-- casts straight back to a string scalar). This normalizes the rows those writers already produced.
--
-- Idempotent by construction: rows that are already objects or arrays fail the jsonb_typeof predicate.

UPDATE repo_configs SET parsed_json = (parsed_json #>> '{}')::jsonb
WHERE parsed_json IS NOT NULL AND jsonb_typeof(parsed_json) = 'string';

UPDATE repo_configs SET fallback_models = (fallback_models #>> '{}')::jsonb
WHERE fallback_models IS NOT NULL AND jsonb_typeof(fallback_models) = 'string';

UPDATE repo_configs SET size_overrides = (size_overrides #>> '{}')::jsonb
WHERE size_overrides IS NOT NULL AND jsonb_typeof(size_overrides) = 'string';

UPDATE jobs SET config_snapshot = (config_snapshot #>> '{}')::jsonb
WHERE config_snapshot IS NOT NULL AND jsonb_typeof(config_snapshot) = 'string';

UPDATE webhook_deliveries SET payload = (payload #>> '{}')::jsonb
WHERE payload IS NOT NULL AND jsonb_typeof(payload) = 'string';
