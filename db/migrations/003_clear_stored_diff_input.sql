-- diff_input (the rendered review prompt, which embeds that file's diff) is no longer
-- persisted going forward -- it's reconstructed on demand from KV/GitHub instead (see
-- getOrFetchRawDiffForCompletedJob / GET /api/jobs/:id/diffs). This clears out the old
-- values already sitting in file_reviews to reclaim storage. One-way: the exact original
-- prompt wording for past jobs is gone; their diffs can still be reconstructed from GitHub
-- as long as the underlying commits still exist.
UPDATE file_reviews SET diff_input = NULL WHERE diff_input IS NOT NULL;
