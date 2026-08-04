-- withheld_counts was written via JSON.stringify(), which postgres.js encodes as a jsonb STRING
-- scalar rather than an object. The TypeScript reader tolerated it, so the bug was invisible until a
-- SQL aggregate over the column returned zero for a review that had withheld five findings.
--
-- Normalize the existing rows so the column has one shape and SQL can read it. Idempotent: rows that
-- are already objects are not matched.
UPDATE file_reviews
SET withheld_counts = (withheld_counts #>> '{}')::jsonb
WHERE withheld_counts IS NOT NULL
  AND jsonb_typeof(withheld_counts) = 'string';
