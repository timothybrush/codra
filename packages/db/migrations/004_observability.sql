-- Observability for reviews that ran in a degraded mode but reported success.
--
-- `degraded` was computed by the model adapters and then only logged, so the two questions an operator
-- most needs answered after a bad review -- "did this run without a response grammar?" and "was the
-- answer truncated?" -- could not be asked of the database at all.
--
-- Values:
--   'schema-dropped'          the model refused the response grammar and answered unconstrained
--   'schema-dropped-catchall' same, but matched only the broad 400 heuristic, so it may not have been
--                             a grammar rejection at all -- kept separate so the heuristic's real
--                             hit rate is measurable rather than assumed
--   'truncated'               the last model in the chain ran out of output room and its partial
--                             answer was salvaged; findings may be missing
--   NULL                      clean
ALTER TABLE file_reviews ADD COLUMN IF NOT EXISTS degraded TEXT;

-- Partial: the overwhelming majority of rows are NULL, and every query against this column asks for
-- the ones that are not.
CREATE INDEX IF NOT EXISTS file_reviews_degraded_idx
  ON file_reviews (degraded)
  WHERE degraded IS NOT NULL;

-- Which reviewer produced a comment. NULL means the repo's primary model, which is every row today;
-- it only becomes meaningful once a secondary reviewer is configured. Recorded for display and
-- attribution only -- never for scoring, since agreement between models is anti-correlated with
-- correctness in the measured corpus.
ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS reviewer_model TEXT;
