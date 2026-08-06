CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
    CREATE TYPE job_trigger AS ENUM ('auto', 'mention', 'retry');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE job_status AS ENUM ('queued', 'running', 'done', 'failed', 'superseded');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE job_verdict AS ENUM ('approve', 'comment');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE file_status_enum AS ENUM ('pending', 'done', 'skipped', 'failed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS repositories (
  installation_id BIGINT NOT NULL,
  id              SERIAL PRIMARY KEY,
  owner           TEXT   NOT NULL,
  repo            TEXT   NOT NULL,
  UNIQUE(owner, repo)
);

CREATE TABLE IF NOT EXISTS jobs (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  retry_of_job_id          UUID        REFERENCES jobs(id) ON DELETE SET NULL,

  check_run_id             BIGINT,
  review_id                BIGINT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at               TIMESTAMPTZ,
  finished_at              TIMESTAMPTZ,

  repository_id            INTEGER     NOT NULL REFERENCES repositories(id),
  pr_number                INTEGER     NOT NULL,
  total_input_tokens       INTEGER     DEFAULT 0,
  total_output_tokens      INTEGER     DEFAULT 0,
  file_count               INTEGER     DEFAULT 0,
  comment_count            INTEGER     DEFAULT 0,
  overall_confidence_score REAL,

  commit_sha               BYTEA       NOT NULL,
  base_sha                 BYTEA       NOT NULL,

  trigger                  TEXT        NOT NULL CHECK (trigger IN ('auto', 'mention', 'retry')),
  status                   TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'superseded')),
  verdict                  TEXT        CHECK (verdict IN ('approve', 'comment')),
  pr_title                 TEXT,
  pr_author                TEXT,
  head_ref                 TEXT,
  base_ref                 TEXT,
  summary_model            TEXT,
  overall_correctness      TEXT,
  error_msg                TEXT,
  summary_markdown         TEXT,
  config_snapshot          JSONB       COMPRESSION lz4,
  steps                    JSONB       COMPRESSION lz4 DEFAULT '[]'::jsonb
) WITH (fillfactor = 90);

CREATE INDEX IF NOT EXISTS jobs_repo_idx ON jobs (repository_id, pr_number);
CREATE INDEX IF NOT EXISTS jobs_active_idx ON jobs (status) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs USING brin (created_at);
CREATE INDEX IF NOT EXISTS jobs_head_sha_idx ON jobs (repository_id, pr_number, commit_sha, trigger);
CREATE INDEX IF NOT EXISTS jobs_correctness_idx ON jobs (overall_correctness);

CREATE TABLE IF NOT EXISTS file_reviews (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  diff_line_count     INTEGER,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  duration_ms         INTEGER,
  confidence_score    REAL,

  file_status         TEXT        NOT NULL CHECK (file_status IN ('pending', 'done', 'skipped', 'failed')),
  verdict             TEXT        CHECK (verdict IN ('approve', 'comment')),
  file_path           TEXT        NOT NULL,
  model_used          TEXT        NOT NULL,
  model_provider      TEXT,
  overall_correctness TEXT,
  file_summary        TEXT,
  error_msg           TEXT,
  diff_input          TEXT        COMPRESSION lz4,
  raw_ai_output       TEXT        COMPRESSION lz4
) WITH (fillfactor = 90);

CREATE INDEX IF NOT EXISTS file_reviews_job_idx ON file_reviews (job_id);
CREATE INDEX IF NOT EXISTS file_reviews_correctness_idx ON file_reviews (overall_correctness);
CREATE INDEX IF NOT EXISTS file_reviews_provider_idx ON file_reviews (model_provider);

CREATE TABLE IF NOT EXISTS review_comments (
  file_review_id   UUID    NOT NULL REFERENCES file_reviews(id) ON DELETE CASCADE,
  id               BIGSERIAL PRIMARY KEY,
  line             INTEGER,
  position         INTEGER,
  path             TEXT    NOT NULL,
  severity         TEXT    NOT NULL,
  category         TEXT    NOT NULL DEFAULT 'quality',
  title            TEXT    NOT NULL,
  body             TEXT    COMPRESSION lz4 NOT NULL,
  code_suggestion  TEXT    COMPRESSION lz4
);
CREATE INDEX IF NOT EXISTS review_comments_file_idx ON review_comments(file_review_id);

CREATE TABLE IF NOT EXISTS repo_configs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  repository_id   INTEGER     NOT NULL REFERENCES repositories(id),

  enabled         BOOLEAN     NOT NULL DEFAULT TRUE,

  main_model      TEXT,
  parsed_json     JSONB,
  fallback_models JSONB       DEFAULT '[]'::jsonb,
  size_overrides  JSONB,
  UNIQUE (repository_id)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  repository_id INTEGER     REFERENCES repositories(id),

  delivery_id   TEXT        NOT NULL UNIQUE,
  event_name    TEXT        NOT NULL,
  payload       JSONB       COMPRESSION lz4 NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_repo_idx ON webhook_deliveries (repository_id, received_at DESC);

CREATE TABLE IF NOT EXISTS model_configs (
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  rpm        INTEGER,
  tpm        INTEGER,
  rpd        INTEGER,

  model_id   TEXT PRIMARY KEY,
  provider   TEXT NOT NULL
);

DELETE FROM model_configs WHERE model_id = '@cf/moonshotai/kimi-k2.5';

CREATE OR REPLACE FUNCTION pg_temp.codra_replace_deprecated_model(input jsonb, old_value text, new_value text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE jsonb_typeof(input)
    WHEN 'string' THEN CASE WHEN input #>> '{}' = old_value THEN to_jsonb(new_value) ELSE input END
    WHEN 'array' THEN COALESCE(
      (
        SELECT jsonb_agg(pg_temp.codra_replace_deprecated_model(value, old_value, new_value) ORDER BY ord)
        FROM jsonb_array_elements(input) WITH ORDINALITY AS item(value, ord)
      ),
      '[]'::jsonb
    )
    WHEN 'object' THEN COALESCE(
      (
        SELECT jsonb_object_agg(key, pg_temp.codra_replace_deprecated_model(value, old_value, new_value))
        FROM jsonb_each(input)
      ),
      '{}'::jsonb
    )
    ELSE input
  END
$$;

UPDATE repo_configs
SET
  main_model = CASE WHEN main_model = '@cf/moonshotai/kimi-k2.5' THEN '@cf/moonshotai/kimi-k2.6' ELSE main_model END,
  fallback_models = CASE
    WHEN fallback_models IS NULL THEN NULL
    ELSE pg_temp.codra_replace_deprecated_model(fallback_models, '@cf/moonshotai/kimi-k2.5', '@cf/moonshotai/kimi-k2.6')
  END,
  size_overrides = CASE
    WHEN size_overrides IS NULL THEN NULL
    ELSE pg_temp.codra_replace_deprecated_model(size_overrides, '@cf/moonshotai/kimi-k2.5', '@cf/moonshotai/kimi-k2.6')
  END,
  parsed_json = CASE
    WHEN parsed_json IS NULL THEN NULL
    ELSE pg_temp.codra_replace_deprecated_model(parsed_json, '@cf/moonshotai/kimi-k2.5', '@cf/moonshotai/kimi-k2.6')
  END
WHERE main_model = '@cf/moonshotai/kimi-k2.5'
  OR fallback_models @> '["@cf/moonshotai/kimi-k2.5"]'::jsonb
  OR size_overrides @> '[{"model": "@cf/moonshotai/kimi-k2.5"}]'::jsonb
  OR size_overrides @> '[{"fallbacks": ["@cf/moonshotai/kimi-k2.5"]}]'::jsonb
  OR parsed_json::text LIKE '%@cf/moonshotai/kimi-k2.5%';

DROP FUNCTION IF EXISTS pg_temp.codra_replace_deprecated_model(jsonb, text, text);

DO $$
DECLARE
  has_old_job_repo_columns BOOLEAN;
  has_old_repo_config_columns BOOLEAN;
  has_old_webhook_repo_columns BOOLEAN;
  commit_sha_type TEXT;
  base_sha_type TEXT;
  null_repository_jobs INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'jobs'
      AND column_name IN ('installation_id', 'owner', 'repo')
    GROUP BY table_name
    HAVING COUNT(*) = 3
  ) INTO has_old_job_repo_columns;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'repo_configs'
      AND column_name IN ('installation_id', 'owner', 'repo')
    GROUP BY table_name
    HAVING COUNT(*) = 3
  ) INTO has_old_repo_config_columns;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'webhook_deliveries'
      AND column_name IN ('owner', 'repo')
    GROUP BY table_name
    HAVING COUNT(*) = 2
  ) INTO has_old_webhook_repo_columns;

  IF has_old_job_repo_columns THEN
    EXECUTE '
      INSERT INTO repositories (installation_id, owner, repo)
      SELECT DISTINCT
        CASE WHEN installation_id ~ ''^[0-9]+$'' THEN installation_id::bigint ELSE 0 END,
        owner,
        repo
      FROM jobs
      WHERE installation_id IS NOT NULL
        AND owner IS NOT NULL
        AND repo IS NOT NULL
      ON CONFLICT (owner, repo) DO UPDATE
      SET installation_id = EXCLUDED.installation_id
    ';
  END IF;

  IF has_old_repo_config_columns THEN
    EXECUTE '
      INSERT INTO repositories (installation_id, owner, repo)
      SELECT DISTINCT
        CASE WHEN installation_id ~ ''^[0-9]+$'' THEN installation_id::bigint ELSE 0 END,
        owner,
        repo
      FROM repo_configs
      WHERE installation_id IS NOT NULL
        AND owner IS NOT NULL
        AND repo IS NOT NULL
      ON CONFLICT (owner, repo) DO UPDATE
      SET installation_id = EXCLUDED.installation_id
    ';
  END IF;

  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS repository_id INTEGER;

  IF has_old_job_repo_columns THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS tmp_jobs_owner_repo_idx ON jobs(owner, repo)';
    EXECUTE '
      UPDATE jobs j
      SET repository_id = r.id
      FROM repositories r
      WHERE j.repository_id IS NULL
        AND r.owner = j.owner
        AND r.repo = j.repo
    ';
    EXECUTE 'DROP INDEX tmp_jobs_owner_repo_idx';
  END IF;

  SELECT data_type
  INTO commit_sha_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'jobs'
    AND column_name = 'commit_sha';

  IF commit_sha_type IS NOT NULL AND commit_sha_type <> 'bytea' THEN
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS commit_sha_bytea BYTEA;
    EXECUTE '
      UPDATE jobs
      SET commit_sha_bytea = CASE
        WHEN commit_sha ~ ''^[0-9a-fA-F]+$'' AND length(commit_sha) % 2 = 0 THEN decode(commit_sha, ''hex'')
        ELSE convert_to(commit_sha, ''UTF8'')
      END
      WHERE commit_sha_bytea IS NULL
    ';
    ALTER TABLE jobs DROP COLUMN commit_sha;
    ALTER TABLE jobs RENAME COLUMN commit_sha_bytea TO commit_sha;
  END IF;

  SELECT data_type
  INTO base_sha_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'jobs'
    AND column_name = 'base_sha';

  IF base_sha_type IS NOT NULL AND base_sha_type <> 'bytea' THEN
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS base_sha_bytea BYTEA;
    EXECUTE '
      UPDATE jobs
      SET base_sha_bytea = CASE
        WHEN base_sha ~ ''^[0-9a-fA-F]+$'' AND length(base_sha) % 2 = 0 THEN decode(base_sha, ''hex'')
        ELSE convert_to(base_sha, ''UTF8'')
      END
      WHERE base_sha_bytea IS NULL
    ';
    ALTER TABLE jobs DROP COLUMN base_sha;
    ALTER TABLE jobs RENAME COLUMN base_sha_bytea TO base_sha;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_repository_id_fkey'
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_repository_id_fkey
      FOREIGN KEY (repository_id) REFERENCES repositories(id);
  END IF;

  SELECT COUNT(*) INTO null_repository_jobs FROM jobs WHERE repository_id IS NULL;
  IF null_repository_jobs = 0 THEN
    ALTER TABLE jobs ALTER COLUMN repository_id SET NOT NULL;
  END IF;

  DROP INDEX IF EXISTS jobs_repo_idx;
  DROP INDEX IF EXISTS jobs_status_idx;
  DROP INDEX IF EXISTS jobs_created_idx;
  DROP INDEX IF EXISTS jobs_head_sha_idx;

  CREATE INDEX IF NOT EXISTS jobs_repo_idx ON jobs (repository_id, pr_number);
  CREATE INDEX IF NOT EXISTS jobs_active_idx ON jobs (status) WHERE status IN ('queued', 'running');
  CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs USING brin (created_at);
  CREATE INDEX IF NOT EXISTS jobs_head_sha_idx ON jobs (repository_id, pr_number, commit_sha, trigger);

  IF has_old_job_repo_columns THEN
    ALTER TABLE jobs DROP COLUMN IF EXISTS installation_id;
    ALTER TABLE jobs DROP COLUMN IF EXISTS owner;
    ALTER TABLE jobs DROP COLUMN IF EXISTS repo;
  END IF;
END $$;

DO $$
DECLARE
  has_old_columns BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'repo_configs'
      AND column_name IN ('installation_id', 'owner', 'repo')
    GROUP BY table_name
    HAVING COUNT(*) = 3
  ) INTO has_old_columns;

  ALTER TABLE repo_configs ADD COLUMN IF NOT EXISTS repository_id INTEGER;

  IF has_old_columns THEN
    EXECUTE '
      UPDATE repo_configs rc
      SET repository_id = r.id
      FROM repositories r
      WHERE rc.repository_id IS NULL
        AND r.owner = rc.owner
        AND r.repo = rc.repo
    ';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repo_configs_repository_id_fkey'
  ) THEN
    ALTER TABLE repo_configs
      ADD CONSTRAINT repo_configs_repository_id_fkey
      FOREIGN KEY (repository_id) REFERENCES repositories(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repo_configs_repository_id_key'
  ) THEN
    ALTER TABLE repo_configs ADD CONSTRAINT repo_configs_repository_id_key UNIQUE (repository_id);
  END IF;

  ALTER TABLE repo_configs DROP CONSTRAINT IF EXISTS repo_configs_owner_repo_key;
  ALTER TABLE repo_configs DROP COLUMN IF EXISTS installation_id;
  ALTER TABLE repo_configs DROP COLUMN IF EXISTS owner;
  ALTER TABLE repo_configs DROP COLUMN IF EXISTS repo;
  ALTER TABLE repo_configs DROP COLUMN IF EXISTS raw_yaml;
  ALTER TABLE repo_configs DROP COLUMN IF EXISTS config_missing;
END $$;

DO $$
DECLARE
  has_old_columns BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'webhook_deliveries'
      AND column_name IN ('owner', 'repo')
    GROUP BY table_name
    HAVING COUNT(*) = 2
  ) INTO has_old_columns;

  ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS repository_id INTEGER;

  IF has_old_columns THEN
    EXECUTE '
      UPDATE webhook_deliveries wd
      SET repository_id = r.id
      FROM repositories r
      WHERE wd.repository_id IS NULL
        AND r.owner = wd.owner
        AND r.repo = wd.repo
    ';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_deliveries_repository_id_fkey'
  ) THEN
    ALTER TABLE webhook_deliveries
      ADD CONSTRAINT webhook_deliveries_repository_id_fkey
      FOREIGN KEY (repository_id) REFERENCES repositories(id);
  END IF;

  DROP INDEX IF EXISTS webhook_deliveries_repo_idx;
  CREATE INDEX IF NOT EXISTS webhook_deliveries_repo_idx ON webhook_deliveries (repository_id, received_at DESC);

  ALTER TABLE webhook_deliveries DROP COLUMN IF EXISTS owner;
  ALTER TABLE webhook_deliveries DROP COLUMN IF EXISTS repo;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'file_reviews'
      AND column_name = 'parsed_comments'
  ) THEN
    INSERT INTO review_comments (
      file_review_id,
      path,
      line,
      position,
      severity,
      category,
      title,
      body,
      code_suggestion
    )
    SELECT
      fr.id,
      COALESCE(comment->>'path', fr.file_path),
      NULLIF(comment->>'line', '')::int,
      NULLIF(comment->>'position', '')::int,
      COALESCE(comment->>'severity', 'P3'),
      COALESCE(comment->>'category', 'quality'),
      COALESCE(comment->>'title', 'Code finding'),
      COALESCE(comment->>'body', ''),
      comment->>'codeSuggestion'
    FROM file_reviews fr
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fr.parsed_comments, '[]'::jsonb)) AS comment
    WHERE NOT EXISTS (
      SELECT 1 FROM review_comments rc WHERE rc.file_review_id = fr.id
    );

    ALTER TABLE file_reviews DROP COLUMN parsed_comments;
  END IF;
END $$;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS check_run_completed_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS recovery_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_queue_message_at TIMESTAMPTZ;
ALTER TABLE file_reviews ADD COLUMN IF NOT EXISTS transient_error_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS jobs_lease_expiry_idx
  ON jobs (lease_expires_at)
  WHERE status = 'running' AND lease_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS jobs_terminal_check_idx
  ON jobs (status, check_run_completed_at)
  WHERE check_run_id IS NOT NULL AND check_run_completed_at IS NULL;

CREATE INDEX IF NOT EXISTS jobs_unleased_running_idx
  ON jobs (last_queue_message_at, heartbeat_at)
  WHERE status = 'running' AND lease_expires_at IS NULL;

DELETE FROM file_reviews fr
USING (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY job_id, file_path ORDER BY created_at ASC, id ASC) AS row_number
  FROM file_reviews
) ranked
WHERE fr.id = ranked.id
  AND ranked.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS file_reviews_job_file_path_key
  ON file_reviews (job_id, file_path);

CREATE TABLE IF NOT EXISTS llm_providers (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL UNIQUE,
  api_format        TEXT        NOT NULL CHECK (api_format IN ('openai', 'anthropic', 'gemini', 'cloudflare-workers-ai', 'vertex')),
  base_url          TEXT,
  encrypted_api_key TEXT,
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

UPDATE llm_providers
SET name = 'Cloudflare', updated_at = now()
WHERE name = 'Cloudflare Workers AI';

UPDATE llm_providers
SET name = 'Google', updated_at = now()
WHERE name = 'Google Gemini';

INSERT INTO llm_providers (name, api_format, base_url, enabled)
VALUES
  ('Cloudflare', 'cloudflare-workers-ai', NULL, TRUE),
  ('Google', 'gemini', 'https://generativelanguage.googleapis.com/v1beta', FALSE),
  ('OpenAI', 'openai', 'https://api.openai.com/v1', FALSE),
  ('Anthropic', 'anthropic', 'https://api.anthropic.com/v1', FALSE),
  ('OpenRouter', 'openai', 'https://openrouter.ai/api/v1', FALSE),
  ('Vertex AI', 'vertex', NULL, FALSE)
ON CONFLICT (name) DO UPDATE SET
  api_format = EXCLUDED.api_format,
  base_url = EXCLUDED.base_url,
  updated_at = now();

ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS provider_id UUID;
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS model_name TEXT;

UPDATE model_configs mc
SET
  provider_id = provider_record.id,
  model_name = COALESCE(mc.model_name, mc.model_id)
FROM llm_providers provider_record
WHERE mc.provider_id IS NULL
  AND (
    (mc.provider = 'cloudflare' AND provider_record.name = 'Cloudflare')
    OR (mc.provider = 'gemini' AND provider_record.name = 'Google')
    OR (mc.provider = 'google' AND provider_record.name = 'Google')
    OR (mc.provider = 'openai' AND provider_record.name = 'OpenAI')
    OR (mc.provider = 'anthropic' AND provider_record.name = 'Anthropic')
  );

UPDATE model_configs mc
SET
  provider_id = provider_record.id,
  model_name = COALESCE(mc.model_name, mc.model_id),
  provider = 'cloudflare'
FROM llm_providers provider_record
WHERE mc.provider_id IS NULL
  AND provider_record.name = 'Cloudflare';

UPDATE model_configs
SET model_name = model_id
WHERE model_name IS NULL;

-- The CREATE TABLE above is IF NOT EXISTS, so on a database where model_configs already exists it did
-- nothing -- and a database created after rpm/tpm/rpd were retired has a model_configs without them.
-- The statements below still name those columns, so without this they fail with
-- `column "rpm" of relation "model_configs" does not exist` and roll back the whole migration.
-- These three are legacy and unread by the application; they are set here only to be nulled out below.
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS rpm INTEGER;
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS tpm INTEGER;
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS rpd INTEGER;

INSERT INTO model_configs (model_id, rpm, tpm, rpd, provider, provider_id, model_name, updated_at)
SELECT '@cf/moonshotai/kimi-k2.6', 10, 131072, 300, 'cloudflare', p.id, '@cf/moonshotai/kimi-k2.6', now()
FROM llm_providers p
WHERE p.name = 'Cloudflare'
ON CONFLICT (model_id) DO UPDATE SET
  rpm = EXCLUDED.rpm,
  tpm = EXCLUDED.tpm,
  rpd = EXCLUDED.rpd,
  provider = EXCLUDED.provider,
  provider_id = EXCLUDED.provider_id,
  model_name = EXCLUDED.model_name,
  updated_at = now();

INSERT INTO model_configs (model_id, rpm, tpm, rpd, provider, provider_id, model_name, updated_at)
SELECT '@cf/zai-org/glm-4.7-flash', 20, 131072, 600, 'cloudflare', p.id, '@cf/zai-org/glm-4.7-flash', now()
FROM llm_providers p
WHERE p.name = 'Cloudflare'
ON CONFLICT (model_id) DO UPDATE SET
  rpm = EXCLUDED.rpm,
  tpm = EXCLUDED.tpm,
  rpd = EXCLUDED.rpd,
  provider = EXCLUDED.provider,
  provider_id = EXCLUDED.provider_id,
  model_name = EXCLUDED.model_name,
  updated_at = now();

ALTER TABLE model_configs ALTER COLUMN provider_id SET NOT NULL;
ALTER TABLE model_configs ALTER COLUMN model_name SET NOT NULL;
ALTER TABLE model_configs ALTER COLUMN rpm DROP NOT NULL;
ALTER TABLE model_configs ALTER COLUMN tpm DROP NOT NULL;
ALTER TABLE model_configs ALTER COLUMN rpd DROP NOT NULL;

UPDATE model_configs
SET rpm = NULL, tpm = NULL, rpd = NULL, updated_at = now()
WHERE rpm = 1 AND tpm = 1 AND rpd = 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'model_configs_provider_id_fkey'
  ) THEN
    ALTER TABLE model_configs
      ADD CONSTRAINT model_configs_provider_id_fkey
      FOREIGN KEY (provider_id) REFERENCES llm_providers(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS model_configs_provider_id_idx ON model_configs (provider_id);
