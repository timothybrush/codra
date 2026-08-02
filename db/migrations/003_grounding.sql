CREATE TABLE IF NOT EXISTS account_settings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  github_user_id  BIGINT      NOT NULL UNIQUE,
  github_username TEXT        NOT NULL,
  account_name    TEXT,
  account_email   TEXT,

  timezone        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS timezone TEXT;

ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS confidence_score REAL;

ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS evidence TEXT COMPRESSION lz4;
ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS anchor_hash TEXT;
ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS posted BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS review_comments_posted_fingerprint_idx
  ON review_comments (file_review_id, fingerprint)
  WHERE posted AND fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS comment_feedback (
  id                BIGSERIAL PRIMARY KEY,
  repository_id     INTEGER     NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pr_number         INTEGER,
  fingerprint       TEXT        NOT NULL,
  anchor_hash       TEXT,
  github_comment_id BIGINT      NOT NULL,
  outcome           TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS comment_feedback_unique_idx
  ON comment_feedback (repository_id, github_comment_id, outcome);

CREATE INDEX IF NOT EXISTS comment_feedback_repo_outcome_idx
  ON comment_feedback (repository_id, outcome);

DO $backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE name IN (
      '003_clear_stored_diff_input.sql',
      '003_diff_accounts.sql',
      '004_account_timezone.sql',
      '004_xai_provider.sql',
      '005_review_comments_confidence_score.sql',
      '006_review_comment_grounding.sql',
      '007_comment_feedback.sql',
      '008_repo_config_min_severity.sql'
    )
  ) THEN
    RAISE NOTICE 'Pre-consolidation migrations already applied; skipping data backfills.';
    RETURN;
  END IF;

  UPDATE file_reviews SET diff_input = NULL WHERE diff_input IS NOT NULL;

  INSERT INTO llm_providers (name, api_format, base_url, enabled)
  VALUES ('xAI', 'openai', 'https://api.x.ai/v1', FALSE)
  ON CONFLICT (name) DO UPDATE SET
    api_format = EXCLUDED.api_format,
    base_url   = EXCLUDED.base_url,
    updated_at = now();
END
$backfill$;

UPDATE repo_configs
SET parsed_json = to_jsonb(
      jsonb_set((parsed_json #>> '{}')::jsonb, '{review,min_severity}', '"P3"')::text
    ),
    updated_at = now()
WHERE jsonb_typeof(parsed_json) = 'string'
  AND (parsed_json #>> '{}')::jsonb->'review'->>'min_severity' = 'nit';

UPDATE repo_configs
SET parsed_json = jsonb_set(parsed_json, '{review,min_severity}', '"P3"'),
    updated_at = now()
WHERE jsonb_typeof(parsed_json) = 'object'
  AND parsed_json->'review'->>'min_severity' = 'nit';

INSERT INTO global_settings (key, value) VALUES ('review_max_files', '200')
ON CONFLICT (key) DO NOTHING;

UPDATE repo_configs
SET parsed_json = to_jsonb(
      ((parsed_json #>> '{}')::jsonb #- '{review,max_files}')::text
    ),
    updated_at = now()
WHERE jsonb_typeof(parsed_json) = 'string'
  AND (parsed_json #>> '{}')::jsonb->'review' ? 'max_files';

UPDATE repo_configs
SET parsed_json = parsed_json #- '{review,max_files}',
    updated_at = now()
WHERE jsonb_typeof(parsed_json) = 'object'
  AND parsed_json->'review' ? 'max_files';
