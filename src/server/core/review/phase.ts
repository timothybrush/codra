import { logger } from '../logger';
import { defaultRepoConfig, REVIEW_CONCURRENCY_LIMITS, type ParsedReviewComment, type RepoConfig } from '@shared/schema';
import type { AppBindings } from '@server/env';
import { bulkInheritFileReviews, getFileReviewsForJobs, upsertFileReview } from '@server/db/file-reviews';
import { markJobContinuationQueued, resetJobContinuationCount, updateJobStep } from '@server/db/jobs';
import { budgetAwareFileLimit } from './budget';
import { narrowUnit, planReviewUnits } from './pack';
import { reviewAndPersistBin } from './bin-runner';
import { getDiffFiles } from './diff-cache';
import { GitHubService } from '../../services/github';
import { isRetryableModelError, ModelService } from '../../services/model';
import { TokenTracker } from '../token-tracker';
import { getReviewSettings } from '@server/db/app-settings';
import {
  type PersistedReviewJob,
  ASYNC_BATCH_POLL_DELAY_SECONDS,
  FRESH_INVOCATION_YIELD_SECONDS,
  MAX_JOB_CONTINUATIONS,
  NextPhaseError,
  REVIEW_CHUNK_WALL_CLOCK_MS,
  enqueueJobPhase,
  hasCompletedStep,
  heartbeatAndCheckSuperseded,
} from './phase-control';
import {
  canInheritParentFileReview,
  countsAsHandledFileReview,
  isAwaitingAsyncReview,
  isSubrequestBudgetError,
  resolveModelProviderName,
} from './retry-policy';
import { loadRejectedExemplars, runPreparePhase } from './prepare';
import { persistCompletedReview, persistFailedFileReview, reviewAndPersistFile } from './file-runner';
// Import via the core/review.ts barrel, not from here: several specs mock that specifier.

export async function runReviewPhase(
  env: AppBindings,
  job: PersistedReviewJob,
  leaseOwner: string,
  github: GitHubService,
  model: ModelService,
  tracker: TokenTracker,
) {
  if (!hasCompletedStep(job, 'Preparation')) {
    await runPreparePhase(env, job, leaseOwner, github);
    return;
  }

  await updateJobStep(env, job.id, 'Reviewing Files', { status: 'running' });

  const rejectedExemplars = await loadRejectedExemplars(env, job);

  const pr = await github.getPullRequest(job.owner, job.repo, job.prNumber);
  const config = (job.configSnapshot ?? defaultRepoConfig) as RepoConfig;
  const failureModelId = config.model?.main ?? 'unconfigured';
  let failureModelProviderPromise: Promise<string | null> | null = null;
  const resolveFailureModelProvider = () => {
    failureModelProviderPromise ??= resolveModelProviderName(env, failureModelId);
    return failureModelProviderPromise;
  };
  const { concurrencyLevel, maxFiles } = await getReviewSettings(env);
  const { files } = await getDiffFiles(env, job, github, config, maxFiles);
  const totalLineCount = files.reduce((sum, file) => sum + file.lineCount, 0);
  const configuredChunkFileLimit = REVIEW_CONCURRENCY_LIMITS[concurrencyLevel];
  // Sized against the chain: a nine-model chain costs far more per file than a one-model one.
  const modelChainLength = 1 + (config.model.fallbacks?.length ?? 0);
  const reviewChunkFileLimit = budgetAwareFileLimit(
    tracker.remainingSafeBudget(),
    configuredChunkFileLimit,
    modelChainLength,
  );
  if (reviewChunkFileLimit <= 0) {
    throw new Error('Subrequest budget for this invocation was exhausted before starting the next review chunk.');
  }
  const startedAt = Date.now();
  let processedThisChunk = 0;

  const jobIdsToQuery = [job.id];
  if (job.retryOfJobId) jobIdsToQuery.push(job.retryOfJobId);
  const allExistingReviews = await getFileReviewsForJobs(env, jobIdsToQuery);
  const currentReviews = new Map(allExistingReviews.filter((review) => review.job_id === job.id).map((review) => [review.file_path, review]));
  const parentReviews = new Map(allExistingReviews.filter((review) => review.job_id !== job.id && review.file_status === 'done').map((review) => [review.file_path, review]));

  const reviewTasks: Array<Promise<void>> = [];
  // Single-threaded, so ++ is safe.
  let terminalProgress = 0;
  let awaitingAsync = 0;

  // Bulk-copy parent reviews in one DB pass, so a fully-inheritable retry finishes in one invocation.
  if (job.retryOfJobId && parentReviews.size > 0) {
    const inheritablePaths = files
      .filter((file) => {
        if (currentReviews.has(file.path)) return false;
        const parent = parentReviews.get(file.path);
        return Boolean(parent && canInheritParentFileReview(config, parent));
      })
      .map((file) => file.path);

    if (inheritablePaths.length > 0) {
      const inheritedPaths = await bulkInheritFileReviews(env, {
        jobId: job.id,
        parentJobId: job.retryOfJobId,
        filePaths: inheritablePaths,
      });
      // Mark copied files handled so the loop below skips them.
      for (const path of inheritedPaths) {
        const parent = parentReviews.get(path);
        if (parent) currentReviews.set(path, parent);
      }
      terminalProgress += inheritedPaths.length;
      if (inheritedPaths.length > 0) {
        logger.info(`Bulk-inherited ${inheritedPaths.length} parent file reviews for job ${job.id} in one pass`);
      }
    }
  }

  // Planned over the full file list so bins are stable across invocations (they aren't persisted),
  // then narrowed to files that still need a model call.
  const binnedPaths = new Set<string>();
  if (config.review.batch_small_files) {
    const ledger = new Map(files.map((file) => {
      const existing = currentReviews.get(file.path);
      const inheritable = parentReviews.get(file.path);
      return [file.path, {
        handled: Boolean((existing && countsAsHandledFileReview(existing)) || (inheritable && canInheritParentFileReview(config, inheritable))),
        transientErrorCount: existing?.transient_error_count ?? 0,
      }];
    }));

    const units = planReviewUnits(files, { enabled: true }).flatMap((unit) => narrowUnit(unit, ledger));
    const plannedBins = units.filter((unit) => unit.kind === 'bin');
    let binsDispatched = 0;
    let filesDispatchedInBins = 0;

    for (const unit of plannedBins) {
      // A bin is one unit (one model chain + one bulk write); counting its files would stop the chunk after a single bin.
      if (processedThisChunk >= reviewChunkFileLimit) break;
      if (Date.now() - startedAt >= REVIEW_CHUNK_WALL_CLOCK_MS) break;

      const binFiles = unit.kind === 'bin' ? unit.files : [];
      binFiles.forEach((file) => binnedPaths.add(file.path));
      reviewTasks.push((async () => {
        // Two statements, not `+= await …`: compound assignment reads the left side first, so concurrent bins would clobber each other.
        const terminal = await reviewAndPersistBin(env, job, binFiles, pr, config, totalLineCount, model, resolveFailureModelProvider, rejectedExemplars);
        terminalProgress += terminal;
      })());
      processedThisChunk += 1;
      binsDispatched += 1;
      filesDispatchedInBins += binFiles.length;
    }

    if (plannedBins.length > 0) {
      logger.info('Batched review plan', {
        jobId: job.id,
        binsPlanned: plannedBins.length,
        binsDispatched,
        filesInBins: filesDispatchedInBins,
        modelCallsSaved: filesDispatchedInBins - binsDispatched,
      });
    }
  }

  for (const file of files) {
    if (binnedPaths.has(file.path)) continue;

    const existingReview = currentReviews.get(file.path);
    // An in-flight async submission must be polled (not skipped as "handled" and not resubmitted).
    const awaitingReview = existingReview && isAwaitingAsyncReview(existingReview) ? existingReview : null;
    if (existingReview && countsAsHandledFileReview(existingReview) && !awaitingReview) {
      continue;
    }

    // `continue`, not `break`: async polls are exempt and must still be reached.
    if (!awaitingReview && processedThisChunk >= reviewChunkFileLimit) {
      continue;
    }

    const inherited = parentReviews.get(file.path);
    const reviewTask = async () => {
      // (0) Poll an already-submitted async batch review.
      if (awaitingReview) {
        const poll = await model.pollReviewBatch({
          model: awaitingReview.async_model ?? awaitingReview.model_used,
          requestId: awaitingReview.async_request_id!,
          file,
          config,
        });
        if (poll.status === 'pending') {
          awaitingAsync += 1;
          return;
        }
        if (poll.status === 'failed') {
          logger.warn(`Async batch poll failed for ${file.path}; falling back to synchronous review`, {
            error: poll.error instanceof Error ? poll.error.message : String(poll.error),
          });
          await reviewAndPersistFile(env, job, file, pr, config, totalLineCount, model, resolveFailureModelProvider, existingReview, rejectedExemplars);
          terminalProgress += 1;
          return;
        }
        await persistCompletedReview(env, job, file, poll.response);
        terminalProgress += 1;
        return;
      }

      if (!inherited) {
        // (1) Try the async batch queue first; on any unavailability fall back to sync review.
        const submitted = await model.submitReviewBatch({
          file,
          prTitle: pr.title ?? null,
          prDescription: pr.body ?? null,
          config,
          totalLineCount,
          compactPrompt: (existingReview?.transient_error_count ?? 0) > 0,
        });
        if (submitted) {
          await upsertFileReview(env, job.id, {
            filePath: file.path,
            fileStatus: 'pending',
            modelUsed: submitted.model,
            modelProvider: null,
            diffLineCount: file.lineCount,
            diffInput: null,
            rawAiOutput: null,
            parsedComments: [],
            inputTokens: null,
            outputTokens: null,
            durationMs: null,
            verdict: null,
            fileSummary: null,
            overallCorrectness: null,
            confidenceScore: null,
            errorMessage: null,
            asyncRequestId: submitted.requestId,
            asyncModel: submitted.model,
          });
          awaitingAsync += 1;
          return;
        }
        await reviewAndPersistFile(env, job, file, pr, config, totalLineCount, model, resolveFailureModelProvider, existingReview, rejectedExemplars);
        terminalProgress += 1;
        return;
      }

      if (!canInheritParentFileReview(config, inherited)) {
        logger.info(`Ignoring inherited review for ${file.path}; parent model ${inherited.model_used} is not in the current model strategy`);
        await reviewAndPersistFile(env, job, file, pr, config, totalLineCount, model, resolveFailureModelProvider, existingReview, rejectedExemplars);
        terminalProgress += 1;
      } else {
        await upsertFileReview(env, job.id, {
          filePath: file.path,
          fileStatus: 'done',
          modelUsed: inherited.model_used,
          modelProvider: inherited.model_provider,
          diffLineCount: inherited.diff_line_count,
          diffInput: inherited.diff_input,
          rawAiOutput: inherited.raw_ai_output,
          parsedComments: inherited.parsed_comments as ParsedReviewComment[],
          inputTokens: inherited.input_tokens,
          outputTokens: inherited.output_tokens,
          durationMs: inherited.duration_ms,
          verdict: inherited.verdict,
          fileSummary: inherited.file_summary,
          overallCorrectness: inherited.overall_correctness,
          confidenceScore: inherited.confidence_score,
          errorMessage: null,
        });
        currentReviews.set(file.path, inherited);
        terminalProgress += 1;
      }
    };

    reviewTasks.push(reviewTask());
    // A poll is one subrequest, not a review: charging it would strand every in-flight batch.
    if (!awaitingReview) processedThisChunk += 1;

    if (Date.now() - startedAt >= REVIEW_CHUNK_WALL_CLOCK_MS) {
      break;
    }
  }

  const results = await Promise.allSettled(reviewTasks);
  await heartbeatAndCheckSuperseded(env, job.id, leaseOwner);

  // Only terminal rows count as progress; a submit/poll-only chunk must not reset the counter.
  if (terminalProgress > 0) {
    await resetJobContinuationCount(env, job.id);
  }

  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected.length > 0) {
    rejected.forEach((result, index) => {
      logger.error(`Review chunk task ${index + 1}/${rejected.length} failed`, result.reason);
    });

    // Surface as a single error so the orchestrator reschedules instead of failing on AggregateError.
    const deferrableError = rejected.map(r => r.reason).find(r => isRetryableModelError(r) || isSubrequestBudgetError(r));
    if (deferrableError) {
      throw deferrableError;
    }

    throw rejected.length === 1
      ? rejected[0].reason
      : new AggregateError(rejected.map((result) => result.reason), `${rejected.length} review chunk tasks failed`);
  }

  const latestReviews = await getFileReviewsForJobs(env, [job.id]);
  // Exclude files awaiting async results so the job doesn't finalize with pending reviews.
  const reviewedPaths = new Set(
    latestReviews.filter((review) => countsAsHandledFileReview(review) && !isAwaitingAsyncReview(review)).map((review) => review.file_path),
  );
  const completedCount = files.filter((file) => reviewedPaths.has(file.path)).length;

  if (completedCount >= files.length) {
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
    // Finalize needs a fresh budget: TokenTracker under-reports usage, so a conditional yield let finalize die with "Too many subrequests".
    await enqueueJobPhase(env, job.id, 'finalize', FRESH_INVOCATION_YIELD_SECONDS);
    return;
  }

  // Only in-flight batches left: poll after a delay, degrading to a partial review if they never land.
  if (awaitingAsync > 0 && terminalProgress === 0) {
    const pollCount = await markJobContinuationQueued(env, job.id, ASYNC_BATCH_POLL_DELAY_SECONDS);
    if (pollCount > MAX_JOB_CONTINUATIONS) {
      logger.error(`Async batch reviews did not complete after ${pollCount} polls; degrading to a partial review: ${job.owner}/${job.repo} PR #${job.prNumber}`);
      for (const review of latestReviews.filter(isAwaitingAsyncReview)) {
        await persistFailedFileReview(env, job.id, {
          filePath: review.file_path,
          modelUsed: review.async_model ?? review.model_used,
          diffLineCount: review.diff_line_count,
          errorMessage: 'Async batch review did not complete in time.',
          clearAsync: true,
        });
      }
      await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
      throw new NextPhaseError('finalize', FRESH_INVOCATION_YIELD_SECONDS);
    }
    throw new NextPhaseError('review', ASYNC_BATCH_POLL_DELAY_SECONDS);
  }

  if (job.checkRunId) {
    // Cosmetic only: reviews are already persisted, so a failure must not block the next chunk.
    try {
      await github.updateCheckRun(job.owner, job.repo, job.checkRunId, {
        title: `Reviewing (${completedCount}/${files.length})`,
        summary: 'Codra is continuing this review in the next queue chunk.',
      });
    } catch (error) {
      logger.warn(`Failed to update progress check run for job ${job.id}; continuing to the next chunk anyway`, error instanceof Error ? error : new Error(String(error)));
    }
  }
  // Yield long enough to force hibernation, rather than accumulating subrequests in this invocation.
  await enqueueJobPhase(env, job.id, 'review', FRESH_INVOCATION_YIELD_SECONDS);
}
