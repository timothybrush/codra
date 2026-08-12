import type { ParsedReviewComment } from '@codra/schema';

// Per-file review persistence. Mirrors src/server/db/file-reviews{,-bulk,-findings}.ts minus `env`.

/**
 * A file_reviews row as returned by `getFileReviewsForJobs`, with the two JSON columns already
 * decoded. Defined here rather than imported because it is a raw-column shape with no schema
 * counterpart, and the review phase copies nearly every field through `upsertFileReview` when it
 * inherits a parent job's reviews.
 */
export type FileReviewRow = {
  id: string;
  job_id: string;
  file_path: string;
  file_status: 'pending' | 'done' | 'skipped' | 'failed';
  model_used: string;
  diff_line_count: number;
  diff_input: string | null;
  raw_ai_output: string | null;
  parsed_comments: ParsedReviewComment[];
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  verdict: 'approve' | 'comment' | null;
  file_summary: string | null;
  overall_correctness: string | null;
  confidence_score: number | null;
  error_msg: string | null;
  model_provider: string | null;
  transient_error_count: number;
  async_request_id: string | null;
  async_model: string | null;
  withheld_counts: { evidence?: number; claimDenied?: number };
  // NULL pre-batching; 1 reviewed alone, N for a packed bin.
  batch_size: number | null;
};

export type SuppressedFinding = {
  fingerprint: string | null;
  // Null for repo-wide rejections, which suppress regardless of what the code now says.
  anchor_hash: string | null;
  // Title-independent identity; already includes the anchor, so it needs no separate anchor check.
  fingerprint_v2: string | null;
  // True when this came from an earlier posted comment rather than from human rejection.
  anchored: boolean;
};

export type BulkFileReviewInput = {
  filePath: string;
  fileStatus: 'pending' | 'done' | 'skipped' | 'failed';
  modelUsed: string;
  modelProvider?: string | null;
  diffLineCount: number;
  rawAiOutput: string | null;
  parsedComments: ParsedReviewComment[];
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  verdict: 'approve' | 'comment' | null;
  fileSummary: string | null;
  overallCorrectness?: string | null;
  confidenceScore?: number | null;
  errorMessage: string | null;
  withheldCounts?: { evidence: number; claimDenied: number } | null;
  // 1 for a file reviewed alone, N for a file that shared a model call with N-1 others.
  batchSize: number;
};

/**
 * Per-file review rows, the findings attached to them, and their posted/rejected bookkeeping.
 *
 * A correct implementation must guarantee:
 *  - every write is IDEMPOTENT on (jobId, filePath). A phase that dies after reviewing a file
 *    re-reviews it on the next invocation, so a second upsert for the same path must replace the row
 *    rather than adding one. This is the property that makes the whole phase re-runnable.
 *  - `recordRetryableFileReviewFailure` and `bulkRecordRetryableFileReviewFailures` return the
 *    transient failure count AFTER this attempt, and must only increment it when
 *    `countsAsAttempt` is not false. That flag distinguishes "the provider is down again" from "we
 *    advanced one step down the model chain"; conflating them burns the retry budget on progress.
 *    The count must never reset on its own -- MAX_RETRYABLE_FILE_REVIEW_FAILURES depends on it.
 *  - `getFileReviewsForJobs` returns rows in stable creation order across calls, for every jobId
 *    given, with `parsed_comments` and `withheld_counts` already decoded (never raw JSON strings).
 *    Finalize reads it to assemble the review, so an unstable order reorders posted comments.
 *  - `bulkInheritFileReviews` returns only the paths it actually inserted, skipping any that already
 *    exist. The caller treats the returned list as "these are now done" and re-reviews the rest.
 *  - `markCommentsPosted` and `markCommentDispositions` are additive and idempotent: re-marking an
 *    already-marked fingerprint is a no-op, never an error. Cross-run suppression reads these, so a
 *    lost write re-posts a finding a human already dismissed.
 *  - an empty input array is a no-op that must not touch the database or throw.
 */
export interface FileReviewStore {
  upsertFileReview(jobId: string, input: {
    filePath: string;
    fileStatus: 'pending' | 'done' | 'skipped' | 'failed';
    modelUsed: string;
    modelProvider?: string | null;
    diffLineCount: number;
    diffInput: string | null;
    rawAiOutput: string | null;
    parsedComments: ParsedReviewComment[];
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number | null;
    verdict: 'approve' | 'comment' | null;
    fileSummary: string | null;
    overallCorrectness?: string | null;
    confidenceScore?: number | null;
    errorMessage: string | null;
    // Findings dropped in the PARSER have no review_comments row to carry a disposition; without this, "everything was withheld" is indistinguishable from clean.
    withheldCounts?: { evidence: number; claimDenied: number } | null;
    // Async batch bookkeeping: set on submit to the Workers AI queue, cleared once the batch completes.
    asyncRequestId?: string | null;
    asyncModel?: string | null;
  }): Promise<void>;

  recordRetryableFileReviewFailure(jobId: string, input: {
    filePath: string;
    modelUsed: string;
    modelProvider?: string | null;
    diffLineCount: number;
    diffInput: string | null;
    durationMs: number | null;
    errorMessage: string;
    countsAsAttempt?: boolean;
  }): Promise<number>;

  getFileReviewsForJobs(jobIds: string[]): Promise<FileReviewRow[]>;

  bulkInheritFileReviews(input: { jobId: string; parentJobId: string; filePaths: string[] }): Promise<string[]>;
  bulkUpsertFileReviews(jobId: string, inputs: BulkFileReviewInput[]): Promise<void>;
  bulkRecordRetryableFileReviewFailures(
    jobId: string,
    inputs: Array<{ filePath: string; modelUsed: string; diffLineCount: number; errorMessage: string }>,
    opts?: { countsAsAttempt?: boolean },
  ): Promise<Array<{ filePath: string; transientErrorCount: number }>>;
  bulkMarkFilesFailed(
    jobId: string,
    files: Array<{ filePath: string; diffLineCount: number }>,
    opts: { modelUsed: string; errorMessage: string },
  ): Promise<void>;

  getSuppressedFindings(jobId: string): Promise<SuppressedFinding[]>;
  markCommentsPosted(jobId: string, fingerprints: string[]): Promise<void>;
  markCommentDispositions(
    jobId: string,
    byFingerprint: Map<string, { disposition: string | null; reason: string | null }>,
  ): Promise<void>;
}
