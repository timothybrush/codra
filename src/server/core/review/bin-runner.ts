import { logger } from '../logger';
import type { RepoConfig } from '@shared/schema';
import type { AppBindings } from '@server/env';
import {
  type BulkFileReviewInput,
  bulkRecordRetryableFileReviewFailures,
  bulkUpsertFileReviews,
} from '@server/db/file-reviews';
import type { FileDiff } from '../diff';
import { renderFileDiff, type RejectedExemplar } from '@server/prompts/file-review';
import { GitHubService } from '../../services/github';
import { isRetryableModelError, ModelService, nextChainIndexOf } from '../../services/model';
import { type PersistedReviewJob, FRESH_INVOCATION_YIELD_SECONDS, MAX_RETRYABLE_FILE_REVIEW_FAILURES } from './phase-control';
import { isSubrequestBudgetError, retryableModelFailureDelaySeconds } from './retry-policy';
import { scanRuleChannel } from './file-runner';
// One bin end to end: rule scan per file, one shared model call, then one row per file. Import from the core/review barrel, not here.

// Phrased to match isRetryableFileReviewErrorMessage ("retrying later"), so the file is re-queued and narrowUnit explodes the bin back onto the single-file path.
const MISSING_FILE_ERROR = 'Model omitted this file from a batched review; retrying later.';

// Splits a total across weights, summing exactly to it -- cost reporting sums these columns.
export function proportionalSplit(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];

  const sum = weights.reduce((a, b) => a + b, 0);
  // A degenerate bin (all diffs empty) splits evenly rather than dividing by zero.
  const parts = sum <= 0
    ? weights.map(() => Math.floor(total / weights.length))
    : weights.map((w) => Math.floor((total * w) / sum));

  // Flooring loses up to n-1 tokens; give the remainder to the heaviest weight.
  const assigned = parts.reduce((a, b) => a + b, 0);
  if (assigned < total) {
    const largest = weights.indexOf(Math.max(...weights));
    parts[largest === -1 ? 0 : largest] += total - assigned;
  }
  return parts;
}

// Reviews a packed bin in one model call, one row per file. Returns how many files reached a terminal state; re-queued files are excluded, or the wedge counter never advances.
export async function reviewAndPersistBin(
  env: AppBindings,
  job: PersistedReviewJob,
  files: FileDiff[],
  pr: Awaited<ReturnType<GitHubService['getPullRequest']>>,
  config: RepoConfig,
  totalLineCount: number,
  model: ModelService,
  resolveFailureModelProvider: () => Promise<string | null>,
  rejectedExemplars: readonly RejectedExemplar[] = [],
): Promise<number> {
  const startedAt = Date.now();

  // Scanned before the model call, so a rule hit reaches finalize even when the chain fails.
  const ruleScans = new Map(files.map((file) => [file.path, scanRuleChannel(file, config)]));

  // The catch-all skips these, or a later failure would re-mark committed files failed and
  // bulkUpsertFileReviews' comment DELETE would wipe their findings.
  const persisted = new Set<string>();
  let terminalCount = 0;

  // Failed rows keep rule-channel findings, produced before the model ran.
  const failedRow = (file: FileDiff, errorMessage: string, modelProvider?: string | null): BulkFileReviewInput => ({
    filePath: file.path,
    fileStatus: 'failed',
    modelUsed: config.model?.main ?? 'unconfigured',
    modelProvider: modelProvider ?? null,
    diffLineCount: file.lineCount,
    rawAiOutput: null,
    parsedComments: ruleScans.get(file.path)?.comments ?? [],
    inputTokens: null,
    outputTokens: null,
    durationMs: Date.now() - startedAt,
    verdict: null,
    fileSummary: null,
    errorMessage,
    batchSize: files.length,
  });

  try {
    const response = await model.reviewFiles({
      files,
      prTitle: pr.title ?? null,
      prDescription: pr.body ?? null,
      config,
      totalLineCount,
      rejectedExemplars,
    });

    const reviewed = files.filter((file) => response.batch.reviews.has(file.path));
    const weights = reviewed.map((file) => renderFileDiff(file).length);
    const inputSplit = proportionalSplit(response.inputTokens, weights);
    const outputSplit = proportionalSplit(response.outputTokens, weights);
    const durationMs = Date.now() - startedAt;

    const rows: BulkFileReviewInput[] = reviewed.map((file, index) => {
      const parsed = response.batch.reviews.get(file.path)!;
      const rules = ruleScans.get(file.path)!;
      return {
        filePath: file.path,
        fileStatus: 'done',
        modelUsed: response.modelUsed,
        modelProvider: response.provider,
        diffLineCount: file.lineCount,
        // The only debugging artifact left once 003 nulls diff_input and the KV cache expires.
        rawAiOutput: response.rawText,
        parsedComments: [...parsed.comments, ...rules.comments],
        inputTokens: inputSplit[index],
        outputTokens: outputSplit[index],
        // Wall clock, not cost: every file waited this long.
        durationMs,
        verdict: parsed.verdict,
        fileSummary: parsed.fileSummary,
        overallCorrectness: parsed.overallCorrectness,
        confidenceScore: parsed.confidenceScore,
        errorMessage: null,
        // Per file: a bin-wide total would let one noisy file mask four clean ones.
        withheldCounts: {
          evidence: (parsed.evidenceStats?.unmatched ?? 0)
            + (parsed.evidenceStats?.absent ?? 0)
            + (parsed.evidenceStats?.weak ?? 0),
          claimDenied: Object.values(parsed.deniedClaimCounts ?? {}).reduce((sum, n) => sum + n, 0),
        },
        batchSize: files.length,
      };
    });

    if (rows.length > 0) {
      await bulkUpsertFileReviews(env, job.id, rows);
      for (const row of rows) persisted.add(row.filePath);
      terminalCount += rows.length;
    }

    // Never done-and-clean (that approves unexamined code), and not terminal progress either.
    if (response.batch.missing.length > 0) {
      const counts = await bulkRecordRetryableFileReviewFailures(env, job.id, response.batch.missing.map((path) => ({
        filePath: path,
        modelUsed: response.modelUsed,
        diffLineCount: files.find((f) => f.path === path)?.lineCount ?? 0,
        errorMessage: MISSING_FILE_ERROR,
      })));
      for (const count of counts) persisted.add(count.filePath);

      // Otherwise a file omitted every time never terminates through this path.
      const exhausted = counts.filter((c) => c.transientErrorCount >= MAX_RETRYABLE_FILE_REVIEW_FAILURES);
      if (exhausted.length > 0) {
        await bulkUpsertFileReviews(env, job.id, exhausted.map((c) => failedRow(
          files.find((f) => f.path === c.filePath)!,
          `Review skipped after the model omitted this file ${c.transientErrorCount} times.`,
        )));
        terminalCount += exhausted.length;
      }
    }

    // Every batch counter below is zero in a healthy run; non-zero is the alarm.
    logger.info('Batched file review parsed', {
      jobId: job.id,
      model: response.modelUsed,
      binSize: files.length,
      binPaths: files.map((f) => f.path),
      binDiffLines: files.reduce((sum, f) => sum + f.lineCount, 0),
      durationMs,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      keptPerFile: rows.map((r) => ({ path: r.filePath, kept: r.parsedComments.length })),
      entriesReturned: response.batch.stats.entriesReturned,
      missingFiles: response.batch.missing,
      unroutableEntries: response.batch.stats.unroutableEntries,
      pathMismatchFindings: response.batch.stats.pathMismatchFindings,
      ambiguousAcrossBin: response.batch.stats.ambiguousAcrossBin,
      flatFallback: response.batch.stats.flatFallback,
      overCap: response.batch.stats.overCap,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown batched review error';
    const modelId = config.model?.main ?? 'unconfigured';
    const modelProvider = await resolveFailureModelProvider();

    // No DB write: with no row every file stays outstanding and the bin is re-planned.
    if (isSubrequestBudgetError(error)) {
      logger.warn('Batched review deferred; subrequest budget will retry in a fresh invocation', {
        jobId: job.id,
        paths: files.map((f) => f.path),
        error: errorMessage,
      });
      Object.defineProperty(error, 'retryAfterSeconds', { value: FRESH_INVOCATION_YIELD_SECONDS, configurable: true });
      throw error;
    }

    // Committed rows stay committed: re-marking them would delete correct findings.
    const outstanding = files.filter((file) => !persisted.has(file.path));

    // Error after everything was recorded: rethrowing would discard terminalCount and fail the job.
    if (outstanding.length === 0) {
      logger.warn('Batched review hit an error after every file was persisted; keeping the committed rows', {
        jobId: job.id,
        paths: files.map((f) => f.path),
        error: errorMessage,
      });
      return terminalCount;
    }

    if (isRetryableModelError(error)) {
      // Set when the chain still has untried models: the next invocation resumes at that index, so
      // this deferral is progress and must not spend one of the three allowed attempts. Keeping the
      // count also keeps the bin intact, which is what we want while only the model is changing.
      const advancedTo = nextChainIndexOf(error);
      const counts = await bulkRecordRetryableFileReviewFailures(env, job.id, outstanding.map((file) => ({
        filePath: file.path,
        modelUsed: modelId,
        diffLineCount: file.lineCount,
        errorMessage,
      })), { countsAsAttempt: advancedTo === null });

      const exhausted = counts.filter((c) => c.transientErrorCount >= MAX_RETRYABLE_FILE_REVIEW_FAILURES);
      if (exhausted.length > 0) {
        // Terminal, but rule-channel findings survive the model's failure.
        await bulkUpsertFileReviews(env, job.id, exhausted.map((c) => failedRow(
          files.find((f) => f.path === c.filePath)!,
          `Review skipped after ${c.transientErrorCount} repeated model provider outages.`,
          modelProvider,
        )));
        terminalCount += exhausted.length;
        logger.error('Files in a batched review failed permanently after transient retries', {
          jobId: job.id,
          paths: exhausted.map((c) => c.filePath),
          error: errorMessage,
        });
      }

      const stillRetrying = counts.filter((c) => c.transientErrorCount < MAX_RETRYABLE_FILE_REVIEW_FAILURES);
      if (stillRetrying.length === 0) return terminalCount;

      logger.warn('Batched review deferred; transient model/provider failure will retry later', {
        jobId: job.id,
        paths: stillRetrying.map((c) => c.filePath),
        error: errorMessage,
      });
      Object.defineProperty(error, 'retryAfterSeconds', {
        value: retryableModelFailureDelaySeconds(Math.max(...stillRetrying.map((c) => c.transientErrorCount))),
        configurable: true,
      });
      throw error;
    }

    logger.error('Batched review failed', { jobId: job.id, paths: outstanding.map((f) => f.path), error });

    await bulkUpsertFileReviews(env, job.id, outstanding.map((file) => failedRow(file, errorMessage, modelProvider)));
    terminalCount += outstanding.length;
  }

  return terminalCount;
}
