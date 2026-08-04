-- The deterministic rule channel: a second finding source alongside the LLM.
--
-- `source` defaults to 'llm', which backfills history correctly by construction -- every existing
-- row WAS model-generated -- so per-channel precision is computable over the whole corpus with no
-- data migration. Everything that counts findings must partition on it, or the numbers used to
-- judge the LLM channel silently include deterministic hits.
--
-- `rule_id` is the retirement signal. A rule with many generated and no posted findings is one the
-- verifier always rejects: delete it or fix it, rather than leaving it to add noise.

ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS source  TEXT NOT NULL DEFAULT 'llm';
ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS rule_id TEXT;

-- Partial: rule findings are the rare case, and the queries that care are all "show me the non-LLM
-- ones". A full index would be almost entirely one repeated value.
CREATE INDEX IF NOT EXISTS review_comments_source_idx
  ON review_comments (source)
  WHERE source <> 'llm';
