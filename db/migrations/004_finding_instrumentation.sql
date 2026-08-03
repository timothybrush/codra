ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS claim_type TEXT;
ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS context_snippet TEXT COMPRESSION lz4;
ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS disposition TEXT;

CREATE INDEX IF NOT EXISTS review_comments_claim_type_idx
  ON review_comments (claim_type)
  WHERE claim_type IS NOT NULL;
