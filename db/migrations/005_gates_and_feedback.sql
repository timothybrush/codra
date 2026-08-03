ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS verify_reason TEXT COMPRESSION lz4;
ALTER TABLE file_reviews    ADD COLUMN IF NOT EXISTS withheld_counts JSONB;

ALTER TABLE comment_feedback ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'github_webhook';
ALTER TABLE comment_feedback ALTER COLUMN github_comment_id DROP NOT NULL;
ALTER TABLE comment_feedback ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE comment_feedback ADD COLUMN IF NOT EXISTS labelled_by BIGINT;
ALTER TABLE comment_feedback ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS comment_feedback_dashboard_unique_idx
  ON comment_feedback (repository_id, fingerprint)
  WHERE source = 'dashboard';

CREATE INDEX IF NOT EXISTS comment_feedback_repo_fingerprint_idx
  ON comment_feedback (repository_id, fingerprint);

UPDATE repo_configs
SET parsed_json = to_jsonb(
      jsonb_set(
        (parsed_json #>> '{}')::jsonb,
        '{review,min_confidence}',
        '0'::jsonb,
        true
      )::text
    )
WHERE parsed_json IS NOT NULL
  AND ((parsed_json #>> '{}')::jsonb #>> '{review,min_confidence}') IS NOT NULL
  AND ((parsed_json #>> '{}')::jsonb #>> '{review,min_confidence}')::numeric <> 0;
