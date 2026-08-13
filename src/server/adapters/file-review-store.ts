import type { FileReviewStore } from '@codra/core/ports';
import type { AppBindings } from '@server/env';
import {
  bulkInheritFileReviews,
  bulkMarkFilesFailed,
  bulkRecordRetryableFileReviewFailures,
  bulkUpsertFileReviews,
  getFileReviewsForJobs,
  getSuppressedFindings,
  markCommentDispositions,
  markCommentsPosted,
  recordRetryableFileReviewFailure,
  upsertFileReview,
} from '@server/db/file-reviews';

export function makeFileReviewStore(env: AppBindings): FileReviewStore {
  return {
    upsertFileReview: (jobId, input) => upsertFileReview(env, jobId, input),
    recordRetryableFileReviewFailure: (jobId, input) => recordRetryableFileReviewFailure(env, jobId, input),
    getFileReviewsForJobs: (jobIds) => getFileReviewsForJobs(env, jobIds),

    bulkInheritFileReviews: (input) => bulkInheritFileReviews(env, input),
    bulkUpsertFileReviews: (jobId, inputs) => bulkUpsertFileReviews(env, jobId, inputs),
    bulkRecordRetryableFileReviewFailures: (jobId, inputs, opts) => bulkRecordRetryableFileReviewFailures(env, jobId, inputs, opts),
    bulkMarkFilesFailed: (jobId, files, opts) => bulkMarkFilesFailed(env, jobId, files, opts),

    getSuppressedFindings: (jobId) => getSuppressedFindings(env, jobId),
    markCommentsPosted: (jobId, fingerprints) => markCommentsPosted(env, jobId, fingerprints),
    markCommentDispositions: (jobId, byFingerprint) => markCommentDispositions(env, jobId, byFingerprint),
  };
}
