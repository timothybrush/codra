ALTER TABLE jobs ADD COLUMN IF NOT EXISTS workflow_instance_id UUID;
CREATE INDEX IF NOT EXISTS idx_jobs_workflow_instance_id ON jobs(workflow_instance_id);

CREATE TABLE IF NOT EXISTS global_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO global_settings (key, value) VALUES
  ('review_concurrency_level', 'medium'),
  ('review_max_comments', '10')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE model_configs DROP COLUMN IF EXISTS rpm;
ALTER TABLE model_configs DROP COLUMN IF EXISTS tpm;
ALTER TABLE model_configs DROP COLUMN IF EXISTS rpd;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS continuation_count INT NOT NULL DEFAULT 0;

ALTER TABLE file_reviews ADD COLUMN IF NOT EXISTS async_request_id TEXT;
ALTER TABLE file_reviews ADD COLUMN IF NOT EXISTS async_model TEXT;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('queued', 'running', 'done', 'failed', 'superseded', 'cancelled', 'stopped'));
