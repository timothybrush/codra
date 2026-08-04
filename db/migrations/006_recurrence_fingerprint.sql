ALTER TABLE review_comments  ADD COLUMN IF NOT EXISTS fingerprint_v2 TEXT;
ALTER TABLE comment_feedback ADD COLUMN IF NOT EXISTS fingerprint_v2 TEXT;

CREATE INDEX IF NOT EXISTS review_comments_posted_fingerprint_v2_idx
  ON review_comments (file_review_id, fingerprint_v2)
  WHERE posted AND fingerprint_v2 IS NOT NULL;

CREATE INDEX IF NOT EXISTS comment_feedback_repo_fingerprint_v2_idx
  ON comment_feedback (repository_id, fingerprint_v2)
  WHERE fingerprint_v2 IS NOT NULL;
