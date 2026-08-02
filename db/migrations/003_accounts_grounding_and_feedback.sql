-- Consolidation of everything that landed after 002: account settings, the stored-prompt
-- cleanup, the xAI provider, and the finding-grounding / feedback work.
--
-- Replaces: 003_diff_accounts.sql, 004_xai_provider.sql,
--           005_review_comments_confidence_score.sql, 006_review_comment_grounding.sql,
--           007_comment_feedback.sql, 008_repo_config_min_severity.sql
--
-- ── Why the guards below exist ──────────────────────────────────────────────────────────
-- The runner tracks applied migrations by FILENAME. A database that already ran the six
-- files listed above has them recorded under those names, so this file -- a new name -- WILL
-- run again there. Every statement therefore has to be safe on a database that already has
-- all of it.
--
-- The DDL is naturally safe (IF NOT EXISTS everywhere). The three statements that MUTATE
-- USER DATA are not: re-running them would quietly undo deliberate changes made since --
-- resetting a repository someone intentionally set back to `nit`, or overwriting an xAI base
-- URL edited in the dashboard. Those three are wrapped in a guard that skips them when any
-- of the original migrations is already recorded, which is exactly "this is not a fresh
-- database, the backfill already happened."


-- ════════════════════════════════════════════════════════════════════════════════════════
-- Account settings                                            (was 003_diff_accounts.sql)
-- ════════════════════════════════════════════════════════════════════════════════════════

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
-- migration (account_settings created without `timezone`) still picks the column up.
ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS timezone TEXT;


-- ════════════════════════════════════════════════════════════════════════════════════════
-- Per-finding confidence, grounding and identity      (was 005_… and 006_review_comment_…)
-- ════════════════════════════════════════════════════════════════════════════════════════

-- The model's own confidence in a finding. Used to rank, and to gate below min_confidence.
ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS confidence_score REAL;

-- evidence     the verbatim line of code a finding claims to be about. Verified against the
--              diff before the comment is allowed to post, and handed to the verification
--              pass so it judges the claim against specific code rather than a window of
--              nearby lines.
-- fingerprint  stable identity (path + normalized title), so the same finding is
--              recognizable across re-reviews of the same pull request.
-- anchor_hash  hash of the anchored line's content. Identity alone cannot tell "same finding"
--              from "same finding, but the developer changed the code" -- when this differs
--              the finding is legitimately raised again.
-- posted       whether this specific comment actually reached GitHub. Distinct from "we
--              generated it": the 422 fallback re-posts a review with zero inline comments,
--              and comments with no usable line anchor are dropped client-side. Suppressing
--              against generated-but-never-shown findings would silently hide them forever.
ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS evidence TEXT COMPRESSION lz4;
ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS anchor_hash TEXT;
ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS posted BOOLEAN NOT NULL DEFAULT FALSE;

-- The cross-run suppression lookup is driven from jobs (repository_id, pr_number) down
-- through file_reviews, so jobs_repo_idx / file_reviews_job_idx / review_comments_file_idx
-- already cover the join. This partial index only narrows the final step to the rows that can
-- actually suppress.
CREATE INDEX IF NOT EXISTS review_comments_posted_fingerprint_idx
  ON review_comments (file_review_id, fingerprint)
  WHERE posted AND fingerprint IS NOT NULL;


-- ════════════════════════════════════════════════════════════════════════════════════════
-- Human feedback on posted findings                          (was 007_comment_feedback.sql)
-- ════════════════════════════════════════════════════════════════════════════════════════

-- Keyed by fingerprint rather than by review_comments.id: those rows are deleted and
-- re-inserted on every re-review of a file (upsertFileReview), so their ids are not stable
-- and cannot anchor anything long-lived.
--
-- outcome:
--   'posted'     we saw GitHub echo the comment back, which is how we learn its real id
--   'deleted'    a human removed the comment -- the only NEGATIVE signal, and the only one
--                that suppresses the finding on future reviews
--   'resolved'   the thread was resolved. Recorded, never used to suppress: resolving usually
--                means "I fixed it", i.e. the finding was GOOD.
--   'unresolved' the thread was reopened, so a prior 'resolved' should not be read as final
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

-- Webhook delivery is at-least-once and resolve/unresolve toggles freely, so every write is
-- an upsert against this key rather than an append.
CREATE UNIQUE INDEX IF NOT EXISTS comment_feedback_unique_idx
  ON comment_feedback (repository_id, github_comment_id, outcome);

-- Drives the repo-wide "this finding was rejected" half of the suppression lookup.
CREATE INDEX IF NOT EXISTS comment_feedback_repo_outcome_idx
  ON comment_feedback (repository_id, outcome);


-- ════════════════════════════════════════════════════════════════════════════════════════
-- Data backfills -- fresh databases only
-- ════════════════════════════════════════════════════════════════════════════════════════
-- Everything above is DDL and safe to re-run. Everything below writes to rows a user can
-- since have edited, so it runs only when no pre-consolidation migration is on record.
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

  -- diff_input (the rendered review prompt, which embeds that file's diff) is no longer
  -- persisted going forward -- it's reconstructed on demand from KV/GitHub instead (see
  -- getOrFetchRawDiffForCompletedJob / GET /api/jobs/:id/diffs). This clears out the old
  -- values already sitting in file_reviews to reclaim storage. One-way: the exact original
  -- prompt wording for past jobs is gone; their diffs can still be reconstructed from GitHub
  -- as long as the underlying commits still exist.
  UPDATE file_reviews SET diff_input = NULL WHERE diff_input IS NOT NULL;

  -- xAI, disabled until an API key is saved. DO UPDATE (rather than DO NOTHING) so a row
  -- seeded by an older revision picks up the correct api_format/base_url -- which is also why
  -- this must not re-run: it would overwrite a base URL edited in the dashboard.
  INSERT INTO llm_providers (name, api_format, base_url, enabled)
  VALUES ('xAI', 'openai', 'https://api.x.ai/v1', FALSE)
  ON CONFLICT (name) DO UPDATE SET
    api_format = EXCLUDED.api_format,
    base_url   = EXCLUDED.base_url,
    updated_at = now();

  -- Move existing repositories to the `review.min_severity` default of 'P3'.
  --
  -- syncRepoConfig writes the fully-materialized defaultRepoConfig into
  -- repo_configs.parsed_json the first time a repository is seen, and loadRepoConfig honors
  -- whatever is stored. Changing the Zod default therefore has NO effect on any repository
  -- that already exists -- without this backfill the new default would only ever apply to
  -- repositories added after the deploy.
  --
  -- Only rows still carrying the old default are touched, so a deliberate per-repo override
  -- (set via PATCH /api/repos/:owner/:repo/config) is preserved.
  UPDATE repo_configs
  SET parsed_json = jsonb_set(parsed_json, '{review,min_severity}', '"P3"'),
      updated_at = now()
  WHERE parsed_json->'review'->>'min_severity' = 'nit';
END
$backfill$;
