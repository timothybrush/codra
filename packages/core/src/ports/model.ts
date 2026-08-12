// The model port. Implementations live in src/server/services/model.ts (and, later,
// packages/models) -- nothing here may reach for a provider SDK or an API key.
import type { RepoConfig } from '@codra/schema';
import type { FileDiff } from '../diff';
import type { BatchReviewResult, parseFileReviewResponse } from '../model-output';
import type { RejectedExemplar } from '../prompts/file-review';
import type { VerifyCandidate } from '../prompts/verify';

type ParsedFileReview = ReturnType<typeof parseFileReviewResponse>;

/**
 * One model call's result. `degraded: 'schema-dropped'` means the provider rejected the structured
 * output grammar and the call ran unconstrained but succeeded, so the caller must be prepared to
 * parse free-form text.
 */
export type ModelResponse = {
  rawText: string;
  inputTokens: number;
  outputTokens: number;
  modelUsed: string;
  provider: string;
  // Grammar rejected, so the call ran unconstrained but succeeded. Read by services/model.ts and `/models/:id/test`.
  degraded?: 'schema-dropped';
};

// Honored only by Workers AI and Google AI Studio -- not by `vertex`, despite it serving the same Gemini models.
export type ModelResponseSchema = {
  name: string;
  schema: Record<string, unknown>;
};

/** One file's review, as the runner receives it: the raw call plus the grounded parse. */
export type FileReviewOutcome = ModelResponse & {
  parsed: ParsedFileReview;
  reviewedLineCount: number;
  wasPromptTruncated: boolean;
  userPrompt: string;
};

/**
 * Runs review prompts against whatever model chain the host has configured.
 *
 * The engine deliberately knows nothing about model selection, fallback order, rate limits or
 * provider quirks -- all of that is the implementation's business. What it does depend on:
 *  - every method may throw, and the implementation must make transient failures DISTINGUISHABLE
 *    from permanent ones via `ModelErrorClassifier` below. Misclassifying a permanent failure as
 *    transient wedges the job until its continuation ceiling; the reverse fails a job that would
 *    have succeeded on retry.
 *  - `reviewFile` and `reviewFiles` must be safe to call again after a failure. They are pure
 *    request/response as far as the engine is concerned: no state carries between calls except
 *    whatever chain-resume bookkeeping the implementation keeps.
 *  - `reviewFiles` returns a result whose `batch.missing` names files the model did not answer for.
 *    Those must NOT be reported as reviewed; the caller re-runs them individually.
 *  - `submitReviewBatch` returns null when async batching is unusable for this model, and the caller
 *    falls back to `reviewFile`. Returning a requestId commits to `pollReviewBatch` being able to
 *    resolve it in a LATER Worker invocation -- the id is persisted, so it must not be tied to
 *    in-memory state.
 *  - `pollReviewBatch` must be safe to call repeatedly for the same requestId, returning 'pending'
 *    until the batch resolves. It must never block.
 *  - token counts on the response must reflect what the call actually consumed; the budget and the
 *    per-job totals are computed from them.
 */
export interface ReviewModel {
  reviewFile(params: {
    file: FileDiff;
    prTitle: string | null;
    prDescription: string | null;
    config: RepoConfig;
    totalLineCount: number;
    compactPrompt?: boolean;
    rejectedExemplars?: readonly RejectedExemplar[];
  }): Promise<FileReviewOutcome>;

  reviewFiles(params: {
    files: readonly FileDiff[];
    prTitle: string | null;
    prDescription: string | null;
    config: RepoConfig;
    totalLineCount: number;
    rejectedExemplars?: readonly RejectedExemplar[];
  }): Promise<ModelResponse & { batch: BatchReviewResult; userPrompt: string }>;

  submitReviewBatch(params: {
    file: FileDiff;
    prTitle: string | null;
    prDescription: string | null;
    config: RepoConfig;
    totalLineCount: number;
    compactPrompt?: boolean;
  }): Promise<{ requestId: string; model: string } | null>;

  pollReviewBatch(params: { model: string; requestId: string; file: FileDiff; config: RepoConfig }): Promise<
    | { status: 'pending' }
    | { status: 'done'; response: FileReviewOutcome }
    | { status: 'failed'; error: unknown }
  >;

  verifyFindings(params: { candidates: VerifyCandidate[]; config: RepoConfig }): Promise<ModelResponse>;
}

/**
 * Classifies a thrown model/provider error.
 *
 * Kept as a port rather than moved into the engine even though both functions are pure predicates:
 * five specs substitute them by mocking the '@server/services/model' specifier, and pulling them in
 * here would void those mocks silently while the tests kept passing.
 *
 * A correct implementation must be:
 *  - total: any value may be passed, including non-Errors, and neither method may throw.
 *  - deterministic for a given error. The retry-delay ladder and the chain-advance memo are both
 *    derived from these answers across separate invocations, so an answer that changed between calls
 *    would produce an inconsistent retry plan.
 *  - conservative about `isRetryableModelError`: only return true when a later attempt has a real
 *    chance of succeeding. `nextChainIndexOf` returns the index to resume the fallback chain at, or
 *    null when the failure says nothing about chain position.
 */
export interface ModelErrorClassifier {
  isRetryableModelError(error: unknown): boolean;
  nextChainIndexOf(error: unknown): number | null;
}
