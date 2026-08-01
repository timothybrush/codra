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
  -- IANA zone (e.g. 'Asia/Kolkata') used to render timestamps in the dashboard.
  -- All timestamps are STORED as TIMESTAMPTZ (absolute, UTC) and this only affects
  -- presentation. NULL means "not chosen", which the dashboard renders as UTC.
  timezone        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Separate idempotent ALTER so a database that applied an earlier revision of this
-- migration (account_settings created without `timezone`) still picks the column up:
-- the runner tracks applied migrations by FILENAME, so editing this file alone would
-- otherwise be a no-op there. Harmless on a fresh database, where CREATE TABLE above
-- already made the column.
ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS timezone TEXT;
