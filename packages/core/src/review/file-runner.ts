import { logger } from '../logger';
import { type ParsedReviewComment, type RepoConfig } from '@codraoss/schema';
import { parseUnifiedDiff, type FileDiff } from '../diff';
import { ruleHitsToComments, scanFileForRuleHits, type RuleScanStats } from '../rules/detect';
import type { RejectedExemplar } from '../prompts/file-review';
import type { PullRequestRecord, ReviewModel, ReviewRuntime } from '../ports';
import { type PersistedReviewJob } from './phase-control';
import { FRESH_INVOCATION_YIELD_SECONDS, MAX_RETRYABLE_FILE_REVIEW_FAILURES } from '../constants';
import { isSubrequestBudgetError, retryableModelFailureDelaySeconds } from './retry-policy';

export async function persistCompletedReview(
  env: Pick<ReviewRuntime, 'fileReviews'>,
  job: PersistedReviewJob,
  file: ReturnType<typeof parseUnifiedDiff>[number],
  response: {
    modelUsed: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    rawText: string;
    userPrompt: string;
    parsed: {
      comments: ParsedReviewComment[];
      verdict: 'approve' | 'comment';
      fileSummary: string;
      overallCorrectness?: string;
      confidenceScore?: number;
    };
  },
) {
  await env.fileReviews.upsertFileReview(job.id, {
    filePath: file.path,
    fileStatus: 'done',
    modelUsed: response.modelUsed,
    modelProvider: response.provider,
    diffLineCount: file.lineCount,
    diffInput: null,
    rawAiOutput: response.rawText,
    parsedComments: response.parsed.comments,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    durationMs: null,
    verdict: response.parsed.verdict,
    fileSummary: response.parsed.fileSummary,
    overallCorrectness: response.parsed.overallCorrectness,
    confidenceScore: response.parsed.confidenceScore,
    errorMessage: null,
    asyncRequestId: null,
    asyncModel: null,
  });
}

export async function persistFailedFileReview(
  env: Pick<ReviewRuntime, 'fileReviews'>,
  jobId: string,
  input: {
    filePath: string;
    modelUsed: string;
    modelProvider?: string | null;
    diffLineCount: number;
    durationMs?: number | null;
    errorMessage: string;
    clearAsync?: boolean;
    parsedComments?: ParsedReviewComment[];
  },
) {
  await env.fileReviews.upsertFileReview(jobId, {
    filePath: input.filePath,
    fileStatus: 'failed',
    modelUsed: input.modelUsed,
    modelProvider: input.modelProvider ?? null,
    diffLineCount: input.diffLineCount,
    diffInput: null,
    rawAiOutput: null,
    parsedComments: input.parsedComments ?? [],
    inputTokens: null,
    outputTokens: null,
    durationMs: input.durationMs ?? null,
    verdict: null,
    fileSummary: null,
    errorMessage: input.errorMessage,
    ...(input.clearAsync ? { asyncRequestId: null, asyncModel: null } : {}),
  });
}

export function scanRuleChannel(
  file: FileDiff,
  config: RepoConfig,
): { comments: ParsedReviewComment[]; stats: RuleScanStats | null } {
  const rules = config.review.rules;
  if (!rules?.enabled) return { comments: [], stats: null };

  try {
    const result = scanFileForRuleHits(file, {
      disabledRuleIds: rules.disabled_rule_ids,
      shadowRuleIds: rules.shadow_rule_ids,
      deniedClaimTypes: config.review.deny_claim_types,
    });
    return { comments: ruleHitsToComments(file, result), stats: result.stats };
  } catch (error) {
    logger.warn(`Rule scan failed for ${file.path}; continuing with LLM findings only`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return { comments: [], stats: null };
  }
}

export async function reviewAndPersistFile(
  env: ReviewRuntime,
  job: PersistedReviewJob,
  file: ReturnType<typeof parseUnifiedDiff>[number],
  pr: PullRequestRecord,
  config: RepoConfig,
  totalLineCount: number,
  model: ReviewModel,
  resolveFailureModelProvider: () => Promise<string | null>,
  previousReview?: { transient_error_count: number },
  rejectedExemplars: readonly RejectedExemplar[] = [],
  changelogExcerpt: string | null = null,
  fileContext: string | null = null,
) {
  const startedAt = env.clock.now();
  const compactPrompt = (previousReview?.transient_error_count ?? 0) > 0;

  const ruleScan = scanRuleChannel(file, config);

  try {
    const response = await model.reviewFile({
      file,
      fileContext,
      prTitle: pr.title ?? null,
      prDescription: pr.body ?? null,
      changelogExcerpt,
      config,
      totalLineCount,
      compactPrompt,
      rejectedExemplars,
    });

    await env.fileReviews.upsertFileReview(job.id, {
      filePath: file.path,
      fileStatus: 'done',
      modelUsed: response.modelUsed,
      modelProvider: response.provider,
      diffLineCount: file.lineCount,
      diffInput: null,
      rawAiOutput: response.rawText,
      parsedComments: [...response.parsed.comments, ...ruleScan.comments],
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      durationMs: env.clock.now() - startedAt,
      verdict: response.parsed.verdict,
      fileSummary: response.parsed.fileSummary,
      overallCorrectness: response.parsed.overallCorrectness,
      confidenceScore: response.parsed.confidenceScore,
      errorMessage: null,
      withheldCounts: {
        evidence: (response.parsed.evidenceStats?.unmatched ?? 0)
          + (response.parsed.evidenceStats?.absent ?? 0)
          + (response.parsed.evidenceStats?.weak ?? 0),
        claimDenied: Object.values(response.parsed.deniedClaimCounts ?? {}).reduce((sum, n) => sum + n, 0),
      },
    });

    logger.info(`File review parsed: ${file.path}`, {
      jobId: job.id,
      model: response.modelUsed,
      kept: response.parsed.comments.length,
      evidence: response.parsed.evidenceStats,
      claimTypes: response.parsed.claimTypeCounts,
      deniedClaims: response.parsed.deniedClaimCounts,
      absenceCheck: response.parsed.absenceCheckStats,
      ruleChannel: ruleScan.stats,
      degraded: response.degraded,
    });

    if (response.wasPromptTruncated) {
      logger.warn(`Reviewed only part of ${file.path}; findings from the remainder are missing.`, {
        jobId: job.id,
        model: response.modelUsed,
        reviewedLineCount: response.reviewedLineCount,
        diffLineCount: file.lineCount,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown file review error';
    const modelId = config.model?.main ?? 'unconfigured';
    const modelProvider = await resolveFailureModelProvider();

    if (isSubrequestBudgetError(error)) {
      logger.warn(`File review deferred for ${file.path}; subrequest budget will retry in a fresh invocation`, {
        error: errorMessage,
      });
      Object.defineProperty(error, 'retryAfterSeconds', {
        value: FRESH_INVOCATION_YIELD_SECONDS,
        configurable: true,
      });
      throw error;
    }

    if (env.modelErrors.isRetryableModelError(error)) {
      const failureCount = await env.fileReviews.recordRetryableFileReviewFailure(job.id, {
        filePath: file.path,
        modelUsed: modelId,
        modelProvider,
        diffLineCount: file.lineCount,
        diffInput: null,
        durationMs: env.clock.now() - startedAt,
        errorMessage,
        countsAsAttempt: env.modelErrors.nextChainIndexOf(error) === null,
      });

      if (failureCount >= MAX_RETRYABLE_FILE_REVIEW_FAILURES) {
        const finalError = `Review skipped after ${failureCount} repeated model provider outages.`;
        await persistFailedFileReview(env, job.id, {
          filePath: file.path,
          modelUsed: modelId,
          modelProvider,
          diffLineCount: file.lineCount,
          durationMs: env.clock.now() - startedAt,
          errorMessage: finalError,
          parsedComments: ruleScan.comments,
        });
        logger.error(`File review failed permanently for ${file.path} after transient retries`, {
          attempts: failureCount,
          error: errorMessage,
        });
        return;
      }

      logger.warn(`File review deferred for ${file.path}; transient model/provider failure will retry later`, {
        error: errorMessage,
        attempts: failureCount,
      });
      Object.defineProperty(error, 'retryAfterSeconds', {
        value: retryableModelFailureDelaySeconds(failureCount),
        configurable: true,
      });
      throw error;
    }

    logger.error(`File review failed for ${file.path}`, { error });

    const isHardLimit =
      errorMessage.includes('4006') ||
      errorMessage.toLowerCase().includes('allocation');

    if (isHardLimit) {
      logger.warn(`File review hit hard provider allocation limit for ${file.path}, marking as failed to allow partial PR review.`, { error: errorMessage });
    }

    await persistFailedFileReview(env, job.id, {
      filePath: file.path,
      modelUsed: modelId,
      modelProvider,
      diffLineCount: file.lineCount,
      durationMs: env.clock.now() - startedAt,
      errorMessage,
      parsedComments: ruleScan.comments,
    });
  }
}
