-- diff_input (the rendered review prompt, which embeds that file's diff) is no longer
-- persisted going forward -- it's reconstructed on demand from KV/GitHub instead (see
-- getOrFetchRawDiffForCompletedJob / GET /api/jobs/:id/diffs). This clears out the old
-- values already sitting in file_reviews to reclaim storage. One-way: the exact original
-- prompt wording for past jobs is gone; their diffs can still be reconstructed from GitHub
-- as long as the underlying commits still exist.
UPDATE file_reviews SET diff_input = NULL WHERE diff_input IS NOT NULL;

-- Persistent per-user account settings, keyed by the GitHub user id.
-- The session (KV) still holds the live sign-in snapshot; this table is the
-- durable record surfaced on the account page. `id` is a stable, unique
-- account identifier independent of the GitHub user id.
CREATE TABLE IF NOT EXISTS account_settings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  github_user_id  BIGINT      NOT NULL UNIQUE,
  github_username TEXT        NOT NULL,
  account_name    TEXT,
  account_email   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
