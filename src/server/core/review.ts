import { logger } from './logger';
import { isSupportedGitHubWebhookEvent, type GitHubWebhookPayload, type PullRequestWebhookPayload } from '@shared/github';
import {
  defaultRepoConfig,
  normalizeModelId,
  REVIEW_CONCURRENCY_LIMITS,
  type FindingDisposition,
  type ParsedReviewComment,
  type RepoConfig,
  type ReviewJobMessage,
} from '@shared/schema';
import { isTimeoutMessage, matchesAnyTransientSubstring } from '@shared/transient-errors';
import type { AppBindings } from '@server/env';
import { bulkInheritFileReviews, bulkMarkFilesFailed, getFileReviewsForJobs, getSuppressedFindings, markCommentDispositions, markCommentsPosted, recordRetryableFileReviewFailure, upsertFileReview } from '@server/db/file-reviews';
import { getResolvedModelConfig } from '@server/db/model-configs';
import {
  claimJobLease,
  completeJob,
  completePreparationStep,
  failJob,
  findExistingJobForHead,
  getJobForProcessing,
  getOtherRunningJobsCount,
  heartbeatJobLease,
  insertJob,
  mapJob,
  markJobCheckRunCompleted,
  markJobContinuationQueued,
  resetJobContinuationCount,
  releaseJobLease,
  setJobPullRequestMeta,
  setJobWorkflowInstance,
  supersedeOlderJobs,
  updateJobCheckRun,
  updateJobStep,
} from '@server/db/jobs';
import { parseUnifiedDiff, type FileDiff } from './diff';
import { dedupeFindings } from './model-output';
import { extractReviewRequest } from './review-request';
import { shadowEvaluate, verifyFindings } from './verify-findings';
import { budgetAwareFileLimit } from './review-budget';
import { getDiffFiles } from './review-diff-cache';
import { ruleHitsToComments, scanFileForRuleHits, type RuleScanStats } from './rules/detect';
import { getRejectedExemplars, getRepositoryIdForJob } from '@server/db/learning';
import type { RejectedExemplar } from '@server/prompts/file-review';

// Re-exported so routes/api/jobs.ts and review-resilience.spec.ts keep their existing specifiers.
export { diffCacheKey, getDiffFiles, getOrFetchRawDiffForCompletedJob } from './review-diff-cache';

// Re-exported so chunk-concurrency.spec.ts keeps importing these from '@server/core/review'.
export { budgetAwareFileLimit, estimatedSubrequestsPerFile } from './review-budget';

// Re-exported so the specs and gold set keep importing these from '@server/core/review'.
export { verifyFindings, type VerifyDrop, type VerifyOutcome } from './verify-findings';

// Re-exported so `routes/webhook.ts` and the specs keep importing it from '@server/core/review'.
export { extractReviewRequest, type ReviewRequest } from './review-request';

import { GitHubService } from '../services/github';
import { GitHubClient } from './github';
import { isRetryableModelError, ModelService } from '../services/model';
import { FormatterService } from '../services/formatter';
import { TokenTracker } from './token-tracker';
import { loadRepoConfig } from './config';
import { getWebhookDelivery } from '@server/db/webhook-deliveries';
import { sendTelemetryEvent } from './telemetry';
import { getReviewSettings } from '@server/db/app-settings';

type PersistedReviewJob = ReturnType<typeof mapJob>;

export type ReviewJobRunResult =
  | { action: 'ack' }
  | { action: 'retry'; delaySeconds: number }
  // jobId is the RESOLVED job id, not the delivery id — mention-triggered jobs carry no jobId in the
  // queue message, so the workflow cannot otherwise know it.
  //
  // freshInstance runs the next phase in a BRAND-NEW workflow instance, whose first step always gets
  // a clean subrequest budget. Set when this instance can no longer get one: a subrequest deferral
  // (a long-lived instance has stopped hibernating) or the move into finalize (~20 at once).
  | { action: 'next_phase'; phase: 'prepare' | 'review' | 'finalize'; delaySeconds: number; jobId?: string; freshInstance?: boolean };

const REVIEW_CHUNK_WALL_CLOCK_MS = 12 * 60 * 1000;
const JOB_LEASE_SECONDS = 15 * 60;
const BUSY_RETRY_SECONDS = 60;
// Backoff between deferred retries of a file that hit a transient model/provider failure.
// Kept short at first: most observed failures are momentary provider load (Gemini 500/503
// "high demand") or self-inflicted connection queuing, both of which clear within seconds,
// so a long first delay just makes reviews grind. Later attempts back off harder in case the
// provider really is having an outage.
const RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS = [30, 2 * 60, 5 * 60];
// Sleep long enough to force the Workflow to HIBERNATE, so the next chunk resumes in a new
// invocation with a fresh 50-subrequest budget.
//
// The duration is the whole point. Cloudflare documents no minimum, but a short sleep keeps the
// instance warm in the SAME invocation: the real budget then accumulates across chunks while each
// chunk's TokenTracker restarts at zero and believes it is untouched, until the review loops on
// "Too many subrequests". That is what 2s produced. 8s keeps most of the speed win over the
// original 60s (~4 minutes on a 30-chunk review rather than ~30) and reliably parks the instance.
// Only applied when a fresh budget is actually needed, so single-invocation PRs stay fast.
const FRESH_INVOCATION_YIELD_SECONDS = 8;
// Delay between polls of an in-flight Workers AI async batch review. Batches typically complete
// within a few minutes, so poll on a short cadence; a stuck batch is bounded by the shared
// MAX_JOB_CONTINUATIONS ceiling (each poll reschedule counts as a no-progress continuation).
const ASYNC_BATCH_POLL_DELAY_SECONDS = 20;
const MAX_RETRYABLE_FILE_REVIEW_FAILURES = 3;
// Belt-and-suspenders ceiling on how many times a job may reschedule the *same* phase without
// completing a single file (see markJobContinuationQueued / resetJobContinuationCount). The
// per-file cap above is the primary bound and resets this counter on any progress, so a healthy
// job never approaches this; it only fires when a job is genuinely wedged (e.g. a provider is
// down for the whole backoff window) and stops it from churning for hours before finalizing.
const MAX_JOB_CONTINUATIONS = 20;
// Finalize gets a much lower reschedule ceiling than review. Unlike review (which makes real
// progress one file at a time and legitimately spans many continuations), finalize is a short,
// self-contained phase: on a fresh invocation it either fits the subrequest budget and posts, or
// it doesn't. Retrying it a few times covers a transient budget miss (a reschedule that lands on a
// genuinely fresh invocation), but if a saturated long-lived workflow instance can't give finalize
// a clean budget, more retries won't help -- so cap them low and fail fast (the check-run reconciler
// and an inheriting re-run recover) instead of churning ~20 min against the shared ceiling.
const MAX_FINALIZE_CONTINUATIONS = 3;
function isRetryableFileReviewErrorMessage(message: string | null | undefined) {
  if (!message) return false;
  const lower = message.toLowerCase();

  // Explicitly fail fast for timeouts so they don't loop endlessly, aligning with
  // isTransientModelFailure which prevents timeouts from being retried.
  if (isTimeoutMessage(lower)) {
    return false;
  }

  return (
    matchesAnyTransientSubstring(lower) ||
    lower.includes('all configured review models failed') ||
    lower.includes('retrying later') ||
    lower.includes('google request failed with 5') ||
    lower.includes('temporary') ||
    // Older jobs may have persisted subrequest-budget failures before budget exhaustion became
    // a pure chunk-level deferral. Keep retrying those rows instead of treating them as handled.
    lower.includes('subrequest')
  );
}

/**
 * Detects Cloudflare's per-invocation subrequest-limit error (Workers Free plan: 50
 * subrequests/invocation). Unlike a provider outage, this clears completely on the next
 * invocation, so the correct response is never to fail the whole job or permanently abandon
 * a file -- it is to persist whatever progress was made and reschedule the same phase, which
 * runs in a fresh invocation with a fresh budget. Because each review chunk reviews and
 * persists only a few files (see reviewChunkFileLimit), rescheduling reliably makes forward
 * progress and the review grinds to completion instead of dying mid-way.
 */
function isSubrequestBudgetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.toLowerCase().includes('subrequest');
}

function retryableModelFailureDelaySeconds(failureCount: number | null | undefined) {
  if (!failureCount || failureCount < 1) return RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS[0];
  const index = Math.min(failureCount - 1, RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS.length - 1);
  return RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS[index];
}

function getRetryableModelFailureDelaySeconds(error: unknown) {
  const record = error && typeof error === 'object' ? error as { retryAfterSeconds?: unknown } : null;
  const retryAfterSeconds =
    typeof record?.retryAfterSeconds === 'number'
      ? record.retryAfterSeconds
      : null;
  return retryAfterSeconds ?? RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS[0];
}

function shouldRetryExistingFileReview(review: { file_status: string; error_msg: string | null }) {
  return review.file_status === 'failed' && isRetryableFileReviewErrorMessage(review.error_msg);
}

function countsAsHandledFileReview(review: { file_status: string; error_msg: string | null }) {
  return !shouldRetryExistingFileReview(review);
}

/**
 * A file whose review was submitted to the Workers AI async batch queue and is still
 * queued/running. Such a row is persisted as 'pending' with the queue request_id; it is neither
 * "handled" (it must be polled to completion) nor a failure to retry from scratch.
 */
function isAwaitingAsyncReview(review: { file_status: string; async_request_id?: string | null }) {
  return review.file_status === 'pending' && !!review.async_request_id;
}

// Reduces a model identifier to its bare name, ignoring the optional `provider:` prefix.
// A completed file review stores the bare model id (e.g. `gemini-3.1-flash-lite`), while the
// configured strategy stores the provider-qualified id (e.g. `google:gemini-3.1-flash-lite`).
// Comparing the bare form on both sides is what lets a retry recognise an already-reviewed file
// as inheritable -- without it, no completed review ever matches the config and every retry
// re-reviews every file from scratch.
function bareModelId(model: string): string {
  const normalized = normalizeModelId(model);
  const colon = normalized.indexOf(':');
  return colon === -1 ? normalized : normalized.slice(colon + 1);
}

function configuredModelSet(config: RepoConfig) {
  const models = new Set<string>();
  const addModel = (model: string | null | undefined) => {
    if (model) models.add(bareModelId(model));
  };

  addModel(config.model?.main);
  for (const fallback of config.model?.fallbacks ?? []) {
    addModel(fallback);
  }
  for (const tier of config.model?.size_overrides ?? []) {
    addModel(tier.model);
    for (const fallback of tier.fallbacks ?? []) {
      addModel(fallback);
    }
  }

  return models;
}

function canInheritParentFileReview(config: RepoConfig, review: { model_used: string }) {
  return configuredModelSet(config).has(bareModelId(review.model_used));
}

async function resolveModelProviderName(env: Pick<AppBindings, 'HYPERDRIVE'>, modelId: string | null | undefined) {
  if (!modelId || modelId === 'unconfigured') return null;

  try {
    const resolved = await getResolvedModelConfig(env, normalizeModelId(modelId));
    return resolved?.providerName ?? null;
  } catch (error) {
    logger.warn(`Failed to resolve provider for model ${modelId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function runReviewJob(env: AppBindings, message: ReviewJobMessage): Promise<ReviewJobRunResult> {
  const resolved = await resolveQueuedJob(env, message);
  if (!resolved) {
    return { action: 'ack' };
  }

  // Concurrency admission control: only throttle a job that has NOT started yet (status 'queued').
  // A job that is already 'running' is mid-flight; re-gating its phase continuations would mean that
  // lowering the concurrency limit (or any transient over-count from the check-then-claim race)
  // makes every in-flight job retry forever -- that path returns before markJobContinuationQueued,
  // so MAX_JOB_CONTINUATIONS never trips, the lease goes stale, and recovery force-fails the job.
  // Gating only admission also avoids a second getReviewSettings fetch on review/finalize invocations.
  if (resolved.job.status === 'queued') {
    const { concurrencyLevel } = await getReviewSettings(env);
    const maxConcurrentJobs = REVIEW_CONCURRENCY_LIMITS[concurrencyLevel];
    const runningCount = await getOtherRunningJobsCount(env, resolved.job.id);
    if (runningCount >= maxConcurrentJobs) {
      logger.info(`Throttling admission of job ${resolved.job.id}: ${runningCount} other jobs are currently running.`);
      return { action: 'retry', delaySeconds: 30 };
    }
  }

  const leaseOwner = crypto.randomUUID();
  const claim = await claimJobLease(env, resolved.job.id, leaseOwner, JOB_LEASE_SECONDS);
  if (claim.status === 'missing') {
    logger.warn(`Job not found for processing: ${resolved.job.id}`);
    return { action: 'ack' };
  }
  if (claim.status === 'terminal') {
    logger.info(`Job ${resolved.job.id} is already terminal (${claim.row.status}), acking queue delivery.`);
    return { action: 'ack' };
  }
  if (claim.status === 'busy') {
    logger.info(`Job ${resolved.job.id} has a fresh lease; retrying queue delivery later.`);
    return { action: 'retry', delaySeconds: Math.min(BUSY_RETRY_SECONDS, claim.retryAfterSeconds) };
  }

  const job = mapJob(claim.row);

  // Bind this job row to the ACTUAL Workflow instance id so job control (stop/delete/rerun) can
  // terminate the right instance. The bind-workflow-id step can't do this for webhook-triggered
  // jobs -- their instance is keyed on deliveryId while the job row (created later, in prepare) has
  // a different id -- so we (re)bind here now that the real job is resolved. Cheap and idempotent.
  if (message.workflowInstanceId && job.workflowInstanceId !== message.workflowInstanceId) {
    try {
      await setJobWorkflowInstance(env, job.id, message.workflowInstanceId);
    } catch (error) {
      logger.warn(`Failed to bind workflow instance id for job ${job.id}`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  const phase = resolved.phase;
  const tracker = new TokenTracker();
  const github = new GitHubService(env, job.installationId, tracker);
  const model = new ModelService(env, tracker, { jobId: job.id });
  const formatter = new FormatterService(env.APP_URL);

  try {
    if (phase === 'prepare') {
      await runPreparePhase(env, job, leaseOwner, github);
    } else if (phase === 'finalize') {
      await runFinalizePhase(env, job, leaseOwner, github, formatter, model);
    } else {
      await runReviewPhase(env, job, leaseOwner, github, model, tracker);
    }

    await releaseJobLease(env, job.id, leaseOwner);
    return { action: 'ack' };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Unknown review failure';
    if (messageText === 'JOB_SUPERSEDED') {
      logger.info(`Job ${job.id} was superseded during execution, stopping.`);
      await releaseJobLease(env, job.id, leaseOwner);
      return { action: 'ack' };
    }

    if (error instanceof NextPhaseError) {
      await releaseJobLease(env, job.id, leaseOwner);
      // Finalize needs a fresh instance for a clean subrequest budget to post the review; other
      // phase transitions (e.g. the per-chunk review yield) stay in this instance and rely on the
      // normal step.sleep hibernation to reset the budget.
      return { action: 'next_phase', phase: error.phase, delaySeconds: error.delaySeconds, jobId: job.id, freshInstance: error.phase === 'finalize' };
    }

    if (isRetryableModelError(error)) {
      const delaySeconds = getRetryableModelFailureDelaySeconds(error);
      logger.warn(`Review job hit transient model/provider failure; scheduling delayed continuation: ${job.owner}/${job.repo} PR #${job.prNumber}`, {
        error: messageText,
        phase,
        delaySeconds,
      });
      return continueOrFailWedgedJob(env, job, github, leaseOwner, phase, delaySeconds, 'transient model/provider failures');
    }

    // Running out of this invocation's subrequest budget is not a job failure: every phase is
    // idempotent enough to resume on a fresh budget, so reschedule the same phase instead of
    // terminally failing the whole review. Prepare and review skip already-persisted files;
    // finalize re-derives its inputs and is guarded against double-posting the GitHub review
    // (see the findBotReviewForCommit guard in runFinalizePhase), so a finalize that exhausts the
    // budget mid-way -- which the large-PR degrade path genuinely can -- resumes rather than dying.
    if (isSubrequestBudgetError(error)) {
      // A fresh Worker invocation is what fixes budget exhaustion -- but only a long-enough sleep
      // actually hibernates the workflow into one. Yield long enough to force that hibernation.
      const record = error && typeof error === 'object' ? error as { retryAfterSeconds?: unknown } : null;
      const delaySeconds = typeof record?.retryAfterSeconds === 'number'
        ? record.retryAfterSeconds
        : FRESH_INVOCATION_YIELD_SECONDS;
      logger.warn(`Review job hit the per-invocation subrequest limit; rescheduling ${phase} on a fresh budget: ${job.owner}/${job.repo} PR #${job.prNumber}`, {
        error: messageText,
        phase,
        delaySeconds,
      });
      return continueOrFailWedgedJob(env, job, github, leaseOwner, phase, delaySeconds, 'per-invocation subrequest limits');
    }

    logger.error(`Review job failed: ${job.owner}/${job.repo} PR #${job.prNumber}`, error);
    await failJobAndCheckRun(env, job, github, messageText);
    await releaseJobLease(env, job.id, leaseOwner);
    return { action: 'ack' };
  }
}

// Records a same-phase continuation and enforces the MAX_JOB_CONTINUATIONS ceiling. As long as
// the job keeps completing files, resetJobContinuationCount() keeps this counter near zero; once
// it has rescheduled MAX_JOB_CONTINUATIONS times without a single file completing, the job is
// genuinely wedged (e.g. a provider is down for the entire backoff window), so we fail it
// terminally instead of letting it churn indefinitely.
async function continueOrFailWedgedJob(
  env: AppBindings,
  job: PersistedReviewJob,
  github: GitHubService,
  leaseOwner: string,
  phase: 'prepare' | 'review' | 'finalize',
  delaySeconds: number,
  reason: string,
): Promise<ReviewJobRunResult> {
  const continuationCount = await markJobContinuationQueued(env, job.id, delaySeconds);

  // Finalize burns its low ceiling fast so a saturated instance that can't post the review fails
  // within a few minutes instead of looping ~20 min against the review-sized ceiling; every other
  // phase keeps the generous ceiling because it makes real per-file progress.
  const ceiling = phase === 'finalize' ? MAX_FINALIZE_CONTINUATIONS : MAX_JOB_CONTINUATIONS;

  if (continuationCount > ceiling) {
    if (phase === 'review') {
      // Degrade to a partial review rather than throwing away the work done so far. NOTE: we must
      // RETURN the finalize transition here, not call enqueueJobPhase() -- that helper throws
      // NextPhaseError, and because continueOrFailWedgedJob runs inside runReviewJob's catch
      // block that throw would escape the function uncaught instead of being turned into a result.
      logger.error(`Review job exceeded the continuation ceiling; degrading to a partial review: ${job.owner}/${job.repo} PR #${job.prNumber}`, {
        phase,
        continuationCount,
        reason,
      });
      // Any file still awaiting an async batch result would otherwise be finalized as an empty
      // "successful" review (its 'pending' row isn't 'failed', so finalize maps it to verdict
      // 'comment'/'' with no findings). Mark them failed first -- mirrors the async-poll degrade path.
      const stillPending = (await getFileReviewsForJobs(env, [job.id])).filter(isAwaitingAsyncReview);
      for (const review of stillPending) {
        await persistFailedFileReview(env, job.id, {
          filePath: review.file_path,
          modelUsed: review.async_model ?? review.model_used,
          diffLineCount: review.diff_line_count,
          errorMessage: 'Async batch review did not complete before the job wedged.',
          clearAsync: true,
        });
      }
      // Hand finalize its own fresh continuation budget. Without this the counter is already past
      // MAX_JOB_CONTINUATIONS (that's what triggered this degrade), so the first time finalize hits
      // a subrequest-budget limit it would re-enter continueOrFailWedgedJob already over the ceiling
      // and fail terminally -- exactly the large-PR "Too many subrequests" failure this guards.
      await resetJobContinuationCount(env, job.id);
      await releaseJobLease(env, job.id, leaseOwner);
      // Finalize on a fresh instance/budget -- this instance is the one that hit the wall.
      return { action: 'next_phase', phase: 'finalize', delaySeconds: FRESH_INVOCATION_YIELD_SECONDS, jobId: job.id, freshInstance: true };
    } else {
      const message = `Review could not make progress after ${continuationCount} continuation attempts (${reason}). Failing the job to avoid an endless retry loop; re-run it once the underlying provider issue clears.`;
      logger.error(`Review job exceeded the continuation ceiling; failing terminally: ${job.owner}/${job.repo} PR #${job.prNumber}`, {
        phase,
        continuationCount,
        reason,
      });
      await failJobAndCheckRun(env, job, github, message);
      await releaseJobLease(env, job.id, leaseOwner);
      return { action: 'ack' };
    }
  }

  await releaseJobLease(env, job.id, leaseOwner);
  // A subrequest-limit deferral means THIS instance is saturated and won't get a fresh budget by
  // sleeping (a long-lived instance stops hibernating), so resume the phase in a brand-new instance.
  // A transient model/provider deferral is not budget-related, so it stays in this instance.
  const freshInstance = reason.includes('subrequest');
  return { action: 'next_phase', phase, delaySeconds, jobId: job.id, freshInstance }; // Resume same phase
}

async function resolveQueuedJob(
  env: AppBindings,
  message: ReviewJobMessage,
): Promise<{ job: PersistedReviewJob; phase: 'prepare' | 'review' | 'finalize' } | null> {
  if (message.jobId) {
    const row = await getJobForProcessing(env, message.jobId);
    return row ? { job: mapJob(row), phase: message.phase ?? 'review' } : null;
  }

  if (!message.eventName) {
    logger.warn('Queue message ignored: missing eventName');
    return null;
  }

  let eventName = message.eventName;
  let payload = message.payload as GitHubWebhookPayload | undefined;

  if (payload === undefined) {
    const delivery = await getWebhookDelivery(env, message.deliveryId);
    if (!delivery) {
      logger.warn(`Queue message ignored: webhook delivery not found: ${message.deliveryId}`);
      return null;
    }

    eventName = delivery.event_name;
    payload = delivery.payload as GitHubWebhookPayload;
  }

  if (!isSupportedGitHubWebhookEvent(eventName)) {
    logger.info(`Queue message ignored: unsupported GitHub event ${eventName}`);
    return null;
  }

  const installationId = String(payload.installation?.id ?? '');
  if (!installationId || !('repository' in payload) || !payload.repository) {
    logger.info('Queue message ignored: missing installation or repository info');
    return null;
  }

  const repoConfig = await loadRepoConfig(env, {
    installationId,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
  });

  if (repoConfig.enabled === false) {
    logger.info(`Job ignored: repository ${payload.repository.owner.login}/${payload.repository.name} is disabled`);
    return null;
  }

  const extracted = extractReviewRequest({
    eventName,
    payload,
    botUsername: env.BOT_USERNAME,
    config: repoConfig.parsedJson,
  });

  if (!extracted) {
    if (eventName === 'pull_request') {
      const prPayload = payload as PullRequestWebhookPayload;
      if (prPayload.action === 'closed' && repoConfig.parsedJson.review.labels !== false) {
        const labels = repoConfig.parsedJson.review.labels;
        const gh = new GitHubClient(env, installationId);
        await gh.removeIssueLabelsIfPresent(
          prPayload.repository.owner.login,
          prPayload.repository.name,
          prPayload.pull_request.number,
          [labels.p1, labels.p2, labels.p3],
        );
      }
    }
    return null;
  }

  let resolved = extracted;
  const githubClient = new GitHubClient(env, installationId);
  if (eventName === 'issue_comment') {
    const pr = await githubClient.getPullRequest(extracted.owner, extracted.repo, extracted.prNumber);
    resolved = {
      ...extracted,
      prTitle: pr.title,
      prAuthor: pr.user.login,
      commitSha: pr.head.sha,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
    };
  }

  const duplicateJob = await findExistingJobForHead(env, {
    owner: resolved.owner,
    repo: resolved.repo,
    prNumber: resolved.prNumber,
    commitSha: resolved.commitSha,
    trigger: resolved.trigger,
  });
  if (duplicateJob) {
    if (duplicateJob.status === 'queued' || duplicateJob.status === 'running') {
      logger.info(`Resuming duplicate in-flight job ${duplicateJob.id} for ${resolved.owner}/${resolved.repo} PR #${resolved.prNumber}.`);
      return { job: duplicateJob, phase: message.phase ?? 'prepare' };
    }

    logger.info(`Duplicate terminal job found for ${resolved.owner}/${resolved.repo} PR #${resolved.prNumber}, skipping.`);
    return null;
  }

  const job = await insertJob(env, {
    installationId: resolved.installationId,
    owner: resolved.owner,
    repo: resolved.repo,
    prNumber: resolved.prNumber,
    prTitle: resolved.prTitle,
    prAuthor: resolved.prAuthor,
    commitSha: resolved.commitSha,
    baseSha: resolved.baseSha,
    trigger: resolved.trigger,
    headRef: resolved.headRef,
    baseRef: resolved.baseRef,
    configSnapshot: repoConfig.parsedJson,
  });

  await supersedeOlderJobs(env, {
    installationId: resolved.installationId,
    owner: resolved.owner,
    repo: resolved.repo,
    prNumber: resolved.prNumber,
    newJobId: job.id,
  });

  return { job, phase: 'prepare' };
}

async function runPreparePhase(
  env: AppBindings,
  job: PersistedReviewJob,
  leaseOwner: string,
  github: GitHubService,
) {
  await updateJobStep(env, job.id, 'Preparation', { status: 'running' });
  const pr = await github.getPullRequest(job.owner, job.repo, job.prNumber);
  const config = (job.configSnapshot ?? defaultRepoConfig) as RepoConfig;

  // Refresh the cached PR title/author from the live PR: these are snapshotted at job creation and
  // copied onto retries, so a title edited on GitHub afterwards would otherwise stay stale.
  try {
    await setJobPullRequestMeta(env, job.id, {
      prTitle: pr.title ?? null,
      prAuthor: pr.user?.login ?? null,
    });
  } catch (error) {
    logger.warn(`Failed to refresh PR metadata for job ${job.id}`, error instanceof Error ? error : new Error(String(error)));
  }

  let checkRunId = job.checkRunId;
  if (!checkRunId) {
    const checkRun = await github.createCheckRun(job.owner, job.repo, {
      headSha: pr.head.sha,
      title: 'Review queued',
      summary: 'Codra has started reviewing this pull request.',
    });
    checkRunId = checkRun.id;
    await updateJobCheckRun(env, job.id, checkRun.id);
  }

  const { maxFiles } = await getReviewSettings(env);
  const { files } = await getDiffFiles(env, job, github, config, maxFiles);
  await completePreparationStep(env, job.id, files.length);
  await heartbeatJobLease(env, job.id, leaseOwner, JOB_LEASE_SECONDS);

  if (files.length === 0) {
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
    await enqueueJobPhase(env, job.id, 'finalize');
    return;
  }

  if (checkRunId) {
    // Best-effort progress cosmetics only (see runReviewPhase): don't let a failed check-run
    // update block enqueuing the review phase that does the actual work.
    try {
      await github.updateCheckRun(job.owner, job.repo, checkRunId, {
        title: `Reviewing (0/${files.length})`,
        summary: 'Codra is analyzing changed files.',
      });
    } catch (error) {
      logger.warn(`Failed to update initial progress check run for job ${job.id}; continuing to the review phase anyway`, error instanceof Error ? error : new Error(String(error)));
    }
  }
  await enqueueJobPhase(env, job.id, 'review');
}

/**
 * Negative few-shot exemplars for this repository, loaded once per review chunk.
 *
 * Best-effort in every direction: a DB hiccup here must not fail a review, and an empty result is
 * the normal case until someone has labelled something. Loaded per chunk rather than per file so it
 * costs one query, not one per file.
 */
async function loadRejectedExemplars(env: AppBindings, job: PersistedReviewJob): Promise<RejectedExemplar[]> {
  try {
    const repositoryId = await getRepositoryIdForJob(env, job.id);
    if (repositoryId === null) return [];
    const rows = await getRejectedExemplars(env, { repositoryId, limit: 5 });
    return rows.map((row) => ({ title: row.title, claimType: row.claim_type }));
  } catch (error) {
    logger.warn('Could not load rejected exemplars; reviewing without them', {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function runReviewPhase(
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
  // Cap this chunk's concurrency by the invocation's remaining subrequest budget so a run of
  // model/provider failures can't push it over Cloudflare's per-invocation cap (Workers Free
  // plan: 50) -- but sized (see budgetAwareFileLimit) so the configured concurrency level is
  // honored in full at a healthy budget and only throttled once the budget is actually spent.
  // Size the chunk against the configured fallback chain, not a fixed guess: a nine-model chain
  // costs far more per file than a one-model chain when the primary is rate-limited.
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
  // Counters shared across the concurrent review tasks below (single-threaded JS, so ++ is safe):
  // `terminalProgress` counts files that reached a terminal state this chunk (reviewed, inherited,
  // or permanently failed); `awaitingAsync` counts files still queued/running on the async batch.
  let terminalProgress = 0;
  let awaitingAsync = 0;

  // Fast path for retries: bulk-copy every reusable parent review in one cheap DB pass instead of
  // re-persisting them one-per-budget-slot through the throttled loop below. Only files with no row
  // yet in this job are bulk-inherited; anything with an existing row falls through to the loop
  // (which handles its own inherit/re-review decision). This lets a fully-inheritable retry finish
  // the whole review phase in a single invocation rather than crawling through ~12 hibernated chunks.
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
      // Mark the just-copied files handled so the loop below skips them (no per-file re-work).
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

  for (const file of files) {
    const existingReview = currentReviews.get(file.path);
    // An in-flight async submission must be polled (not skipped as "handled" and not resubmitted).
    const awaitingReview = existingReview && isAwaitingAsyncReview(existingReview) ? existingReview : null;
    if (existingReview && countsAsHandledFileReview(existingReview) && !awaitingReview) {
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
          // The batch errored/expired -- fall back to a synchronous review so the file still gets done.
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
    processedThisChunk += 1;

    if (processedThisChunk >= reviewChunkFileLimit || Date.now() - startedAt >= REVIEW_CHUNK_WALL_CLOCK_MS) {
      break;
    }
  }

  const results = await Promise.allSettled(reviewTasks);
  await heartbeatAndCheckSuperseded(env, job.id, leaseOwner);

  // Terminal progress means a file reached a terminal state this chunk (reviewed, inherited, or
  // marked permanently failed). Clear the no-progress continuation counter so a slow-but-advancing
  // job never trips the MAX_JOB_CONTINUATIONS safety net. A chunk that only *submitted* or *polled*
  // still-pending async batches made no terminal progress, so it must NOT reset the counter --
  // that's what bounds polling of a batch that never completes.
  if (terminalProgress > 0) {
    await resetJobContinuationCount(env, job.id);
  }

  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected.length > 0) {
    rejected.forEach((result, index) => {
      logger.error(`Review chunk task ${index + 1}/${rejected.length} failed`, result.reason);
    });
    
    // If any rejected task was a transient model error or a per-invocation subrequest-budget
    // hit, surface that single error so the job orchestrator reschedules the chunk on a fresh
    // budget, instead of failing the job with an AggregateError.
    const deferrableError = rejected.map(r => r.reason).find(r => isRetryableModelError(r) || isSubrequestBudgetError(r));
    if (deferrableError) {
      throw deferrableError;
    }

    throw rejected.length === 1
      ? rejected[0].reason
      : new AggregateError(rejected.map((result) => result.reason), `${rejected.length} review chunk tasks failed`);
  }

  const latestReviews = await getFileReviewsForJobs(env, [job.id]);
  // A file still awaiting its async batch result is NOT complete yet -- exclude it so the job
  // doesn't finalize with pending reviews.
  const reviewedPaths = new Set(
    latestReviews.filter((review) => countsAsHandledFileReview(review) && !isAwaitingAsyncReview(review)).map((review) => review.file_path),
  );
  const completedCount = files.filter((file) => reviewedPaths.has(file.path)).length;

  if (completedCount >= files.length) {
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
    // Finalize (post the GitHub review, labels, check run) needs its OWN fresh subrequest budget.
    // Always hibernate into a new invocation first: the review phase that just finished spent this
    // invocation's budget, and TokenTracker under-reports real usage (it doesn't see Hyperdrive/
    // GitHub subrequests), so a conditional yield let finalize run in the exhausted invocation and
    // die with "Too many subrequests". Unconditional yield trades a one-time delay for reliability.
    await enqueueJobPhase(env, job.id, 'finalize', FRESH_INVOCATION_YIELD_SECONDS);
    return;
  }

  // If the only thing left is in-flight async batches (no synchronous work remains to advance),
  // poll again after a short delay rather than immediately re-running. Bound the polling with the
  // shared continuation ceiling: markJobContinuationQueued returns the post-increment count, and
  // because a pending-only chunk never reset it (terminalProgress === 0), a batch that never
  // completes will eventually cross MAX_JOB_CONTINUATIONS and degrade to a partial review instead
  // of polling forever.
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
    // Best-effort progress cosmetics only: the file reviews for this chunk are already
    // persisted, so a failure here (e.g. this invocation's subrequest budget is spent) must
    // not stop us from enqueuing the next chunk that finishes the job.
    try {
      await github.updateCheckRun(job.owner, job.repo, job.checkRunId, {
        title: `Reviewing (${completedCount}/${files.length})`,
        summary: 'Codra is continuing this review in the next queue chunk.',
      });
    } catch (error) {
      logger.warn(`Failed to update progress check run for job ${job.id}; continuing to the next chunk anyway`, error instanceof Error ? error : new Error(String(error)));
    }
  }
  // More files remain -- the next chunk needs a fresh subrequest budget, so yield long enough to
  // force the workflow to hibernate into a new invocation rather than looping in this one (which
  // would accumulate subrequests across chunks until the cap is hit).
  await enqueueJobPhase(env, job.id, 'review', FRESH_INVOCATION_YIELD_SECONDS);
}

/**
 * Persist a completed review produced by the async batch poll path. Mirrors the success branch of
 * reviewAndPersistFile and clears the async bookkeeping columns so the row is terminal ('done').
 */
async function persistCompletedReview(
  env: AppBindings,
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
  await upsertFileReview(env, job.id, {
    filePath: file.path,
    fileStatus: 'done',
    modelUsed: response.modelUsed,
    modelProvider: response.provider,
    diffLineCount: file.lineCount,
    // Not persisted: reconstructed on demand from GitHub/KV (see getDiffFiles + the
    // /api/jobs/:id/diffs route) instead of storing the rendered prompt/diff in Postgres.
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

/**
 * Persist a file review as terminally 'failed' with the shared "mostly-null" shape. Collapses the
 * several near-identical failure upserts (transient-retry exhaustion, hard provider limit, async
 * batch giving up, finalize backfilling missing files) into one place. `clearAsync` wipes the
 * async batch bookkeeping columns for rows that had been submitted to the queue.
 */
async function persistFailedFileReview(
  env: AppBindings,
  jobId: string,
  input: {
    filePath: string;
    modelUsed: string;
    modelProvider?: string | null;
    diffLineCount: number;
    durationMs?: number | null;
    errorMessage: string;
    clearAsync?: boolean;
    /**
     * Deterministic findings for a file whose MODEL review failed. This is the case the rule channel
     * exists for: the file is marked failed and still contributes what a regex could establish.
     */
    parsedComments?: ParsedReviewComment[];
  },
) {
  await upsertFileReview(env, jobId, {
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

/**
 * Runs the deterministic rule channel over one file.
 *
 * Returns comments for rules that are live and stats for everything, including shadow hits. Never
 * throws: a bug in a regex must not fail a file review that the model completed successfully.
 */
function scanRuleChannel(
  file: FileDiff,
  config: RepoConfig,
): { comments: ParsedReviewComment[]; stats: RuleScanStats | null } {
  const rules = config.review.rules;
  if (!rules?.enabled) return { comments: [], stats: null };

  try {
    const result = scanFileForRuleHits(file, {
      disabledRuleIds: rules.disabled_rule_ids,
      shadowRuleIds: rules.shadow_rule_ids,
      // A rule whose claim type the repo denies must not produce a candidate the parser would
      // have thrown away had the model claimed it.
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

async function reviewAndPersistFile(
  env: AppBindings,
  job: PersistedReviewJob,
  file: ReturnType<typeof parseUnifiedDiff>[number],
  pr: Awaited<ReturnType<GitHubService['getPullRequest']>>,
  config: RepoConfig,
  totalLineCount: number,
  model: ModelService,
  resolveFailureModelProvider: () => Promise<string | null>,
  previousReview?: { transient_error_count: number },
  rejectedExemplars: readonly RejectedExemplar[] = [],
) {
  const startedAt = Date.now();
  const compactPrompt = (previousReview?.transient_error_count ?? 0) > 0;

  // Scanned BEFORE the model call, and used on both the success and failure paths. That ordering is
  // the entire recall argument for this channel: a deterministic hit still reaches finalize when the
  // model returns nothing, and when every model in the chain fails outright.
  const ruleScan = scanRuleChannel(file, config);

  try {
    const response = await model.reviewFile({
      file,
      prTitle: pr.title ?? null,
      prDescription: pr.body ?? null,
      config,
      totalLineCount,
      compactPrompt,
      rejectedExemplars,
    });

    await upsertFileReview(env, job.id, {
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
      durationMs: Date.now() - startedAt,
      verdict: response.parsed.verdict,
      fileSummary: response.parsed.fileSummary,
      overallCorrectness: response.parsed.overallCorrectness,
      confidenceScore: response.parsed.confidenceScore,
      errorMessage: null,
      // Persisted because these findings produce NO review_comments row -- they are dropped in the
      // parser, before a ParsedReviewComment exists. Without this, finalize cannot tell "the model
      // found nothing" from "everything it found was withheld", and would approve the PR either way.
      // Optional-chained because `parsed` is also assembled by hand on the chunk-merge path: a
      // missing counter must degrade the instrumentation, never fail the file review it describes.
      withheldCounts: {
        evidence: (response.parsed.evidenceStats?.unmatched ?? 0)
          + (response.parsed.evidenceStats?.absent ?? 0)
          + (response.parsed.evidenceStats?.weak ?? 0),
        claimDenied: Object.values(response.parsed.deniedClaimCounts ?? {}).reduce((sum, n) => sum + n, 0),
      },
    });

    // evidenceStats was computed and thrown away by every caller. It is the only per-file view of
    // how well the model grounds its claims, and `unmatched`/`absent`/`weak` climbing on a
    // particular model is the earliest available signal that its output has stopped being usable.
    logger.info(`File review parsed: ${file.path}`, {
      jobId: job.id,
      model: response.modelUsed,
      kept: response.parsed.comments.length,
      evidence: response.parsed.evidenceStats,
      claimTypes: response.parsed.claimTypeCounts,
      deniedClaims: response.parsed.deniedClaimCounts,
      // Shadow only. `refuted` staying 0 while `absenceShaped` climbs means the check is reaching
      // real claims but never resolving an identifier -- the extraction, not the idea, is the problem.
      absenceCheck: response.parsed.absenceCheckStats,
      ruleChannel: ruleScan.stats,
    });

    // `wasPromptTruncated` and `reviewedLineCount` were both computed by reviewFile and consumed by
    // nobody, which is what made truncation silent rather than merely lossy. A file reviewed in part
    // is not a clean file, and if this warns routinely the chunk cap -- not the model -- is the reason
    // findings are missing from large files.
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

    // Per-invocation subrequest pressure clears on the next Worker invocation, so do not count
    // it as a per-file provider outage. Let the job-level no-progress continuation ceiling bound
    // a genuinely wedged job while this file remains pending for the fresh-budget retry.
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

    // Transient model/provider outages count against the file so a single unrecoverable file
    // eventually becomes a partial-review failure instead of blocking the entire job forever.
    if (isRetryableModelError(error)) {
      const failureCount = await recordRetryableFileReviewFailure(env, job.id, {
        filePath: file.path,
        modelUsed: modelId,
        modelProvider,
        diffLineCount: file.lineCount,
        diffInput: null,
        durationMs: Date.now() - startedAt,
        errorMessage,
      });

      if (failureCount >= MAX_RETRYABLE_FILE_REVIEW_FAILURES) {
        const finalError = `Review skipped after ${failureCount} repeated model provider outages.`;
        await persistFailedFileReview(env, job.id, {
          filePath: file.path,
          modelUsed: modelId,
          modelProvider,
          diffLineCount: file.lineCount,
          durationMs: Date.now() - startedAt,
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

    // A genuine provider allocation exhaustion (e.g. Cloudflare Workers AI daily free
    // allocation, error 4006) won't clear by retrying within this job, so mark the file failed
    // and let the PR review complete as a partial review. (Per-invocation subrequest limits are
    // NOT hard limits -- they're handled as deferrals above and retried on a fresh budget.)
    const isHardLimit =
      errorMessage.includes('4006') ||
      errorMessage.toLowerCase().includes('allocation');

    if (isHardLimit) {
      logger.warn(`File review hit hard provider allocation limit for ${file.path}, marking as failed to allow partial PR review.`, { error: errorMessage });
      // We don't throw here; we just fall through and let it be marked as failed
      // so the PR review can continue and complete as a partial review.
    }

    await persistFailedFileReview(env, job.id, {
      filePath: file.path,
      modelUsed: modelId,
      modelProvider,
      diffLineCount: file.lineCount,
      durationMs: Date.now() - startedAt,
      errorMessage,
      parsedComments: ruleScan.comments,
    });
  }
}

/**
 * Assemble and fire the anonymous per-review telemetry event. The shared aggregate fields
 * (line/token counts, models, file extensions, duration) are computed once here; the three fields
 * that differ between the success and all-failed paths are passed as `overrides`. Never throws.
 *
 * Token and model data are aggregated from `done`-status reviews only, so that failed or
 * inherited reviews with null token counts don't deflate the reported totals.
 */
async function sendReviewTelemetry(
  env: AppBindings,
  job: PersistedReviewJob,
  files: Array<{ path: string; lineCount: number }>,
  reviews: Array<{ file_status: string; input_tokens: number | null; output_tokens: number | null; model_used: string }>,
  overrides: { findingsReported: number; verdict: string; severityDistribution: Record<string, number> },
  meta: { concurrencyLevel: string; retryCount: number },
) {
  try {
    // Only aggregate token/model data from successfully completed file reviews. Failed or
    // inherited reviews with null token counts would silently deflate the reported totals.
    const doneReviews = reviews.filter((r) => r.file_status === 'done');

    const cleanModels = Array.from(
      new Set(
        doneReviews
          .map((r) => bareModelId(r.model_used))
          .filter(Boolean)
          .filter((m) => !m.toLowerCase().includes('test')),
      ),
    );

    const extractExtension = (filePath: string): string => {
      const name = filePath.split('/').pop() || filePath;
      const dotIndex = name.lastIndexOf('.');
      if (dotIndex <= 0) return '';
      return name.slice(dotIndex + 1).toLowerCase();
    };

    await sendTelemetryEvent(env, {
      linesReviewed: files.reduce((sum, file) => sum + file.lineCount, 0),
      inputTokens: doneReviews.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0),
      outputTokens: doneReviews.reduce((sum, r) => sum + (r.output_tokens ?? 0), 0),
      modelsUsed: cleanModels,
      fileExtensions: Array.from(new Set(files.map((f) => extractExtension(f.path)).filter(Boolean))),
      triggerType: job.trigger,
      reviewDurationMs: Math.max(0, Date.now() - new Date(job.createdAt).getTime()),
      filesReviewed: files.length,
      concurrencyLevel: meta.concurrencyLevel,
      prTotalLinesChanged: files.reduce((sum, file) => sum + file.lineCount, 0),
      retryCount: meta.retryCount,
      ...overrides,
    });
  } catch (e) {
    logger.error('Failed to send telemetry', e instanceof Error ? e : new Error(String(e)));
  }
}

// How many top-ranked candidate findings to send to the verification pass. Anything below this
// cutoff is left untouched — it sits below the max_comments cap and would be truncated anyway, so
// spending prompt tokens verifying it is wasteful.
/**
 * Loads the fingerprints this job must not post, split by how they suppress.
 *
 * `posted` maps a fingerprint to the anchor hashes it was last seen at -- suppression requires BOTH
 * to match, so an edit to the flagged line correctly re-raises the finding. `rejected` (a human
 * deleted the comment) suppresses on fingerprint alone, repository-wide.
 *
 * Best-effort: suppression is an improvement, not a correctness requirement, and a DB hiccup here
 * must not fail a review that is otherwise ready to post.
 */
async function loadSuppressedFingerprints(env: AppBindings, jobId: string) {
  const posted = new Map<string, Set<string>>();
  const rejected = new Set<string>();
  // v2 already contains the anchor hash, so these need no companion anchor check -- membership alone
  // means "same file, same claim class, byte-identical line", and editing the line changes the key.
  const postedV2 = new Set<string>();
  const rejectedV2 = new Set<string>();

  try {
    for (const row of await getSuppressedFindings(env, jobId)) {
      if (!row.anchored) {
        if (row.fingerprint) rejected.add(row.fingerprint);
        if (row.fingerprint_v2) rejectedV2.add(row.fingerprint_v2);
        continue;
      }
      if (row.fingerprint_v2) postedV2.add(row.fingerprint_v2);
      if (!row.fingerprint || !row.anchor_hash) continue;
      const anchors = posted.get(row.fingerprint) ?? new Set<string>();
      anchors.add(row.anchor_hash);
      posted.set(row.fingerprint, anchors);
    }
  } catch (error) {
    logger.warn('Could not load suppressed findings; posting without cross-run dedupe', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { posted, rejected, postedV2, rejectedV2 };
}

async function runFinalizePhase(
  env: AppBindings,
  job: PersistedReviewJob,
  leaseOwner: string,
  github: GitHubService,
  formatter: FormatterService,
  model: ModelService,
) {
  await updateJobStep(env, job.id, 'Generating Summary', { status: 'running' });

  const pr = await github.getPullRequest(job.owner, job.repo, job.prNumber);
  const config = (job.configSnapshot ?? defaultRepoConfig) as RepoConfig;
  // Fetched here rather than further down so the same lookup supplies both the file ceiling
  // below and the comment cap used when the findings are gated.
  const reviewSettings = await getReviewSettings(env);
  const { files, skipped: filesOverCap } = await getDiffFiles(env, job, github, config, reviewSettings.maxFiles);
  let reviews = await getFileReviewsForJobs(env, [job.id]);

  if (reviews.length < files.length) {
    const reviewedPaths = new Set(reviews.map((r) => r.file_path));
    const missingFiles = files.filter((f) => !reviewedPaths.has(f.path));
    
    if (missingFiles.length > 0) {
      logger.warn(`Job ${job.id} reached finalize phase with ${missingFiles.length} missing file reviews. Forcing them to failed state.`);
      // Batch the backfill into one INSERT. Doing it per-file (a transaction each) scales the
      // subrequest cost with the number of missing files and, on a large/growing PR, exhausts the
      // per-invocation budget right before the review is posted (finalize can't safely hibernate --
      // it posts the GitHub review -- so it must stay within one invocation's budget).
      await bulkMarkFilesFailed(
        env,
        job.id,
        missingFiles.map((file) => ({ filePath: file.path, diffLineCount: file.lineCount })),
        { modelUsed: config.model?.main ?? 'unconfigured', errorMessage: 'This file was not reviewed before the review run completed.' },
      );

      // Refresh reviews list after inserting the missing ones
      reviews = await getFileReviewsForJobs(env, [job.id]);
    } else {
      await updateJobStep(env, job.id, 'Reviewing Files', { status: 'running' });
      // Bounce back to review on a fresh invocation/budget (finalize already spent this one).
      await enqueueJobPhase(env, job.id, 'review', FRESH_INVOCATION_YIELD_SECONDS);
      return;
    }
  }

  // Finalize is now committed to finishing, so the review phase is over. Defensively mark
  // "Reviewing Files" done: some paths into finalize (notably the continuation-ceiling degrade in
  // continueOrFailWedgedJob) don't set it, which otherwise leaves the step stuck showing
  // "In progress" on a job that's actually done. updateJobStep keeps the first finish time, so this
  // no-ops the timestamp when the review phase already marked it done.
  await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });

  const reviewedComments = reviews.flatMap((review) => review.parsed_comments as ParsedReviewComment[]);
  const fileSummaries = reviews.map((review) => ({
    path: review.file_path,
    summary: review.file_status === 'failed'
      ? `Review failed: ${review.error_msg ?? 'Unknown file review error'}`
      : (review.file_summary ?? ''),
    verdict: review.file_status === 'failed' ? 'failed' : (review.verdict ?? 'comment'),
  }));

  const { concurrencyLevel, maxComments: globalMaxComments } = reviewSettings;
  const effectiveMaxComments = Math.min(config.review.max_comments, globalMaxComments);
  // retryCount: how many times this job has been retried (0 = first run, 1 = first retry, etc.)
  // We store one level of retryOfJobId; deeper chains would need a dedicated column on jobs.
  const retryCount = job.retryOfJobId ? 1 : 0;

  if (fileSummaries.length > 0 && fileSummaries.every((file) => file.verdict === 'failed')) {
    await updateJobStep(env, job.id, 'Generating Summary', { status: 'failed', error: 'All files failed to review' });

    await sendReviewTelemetry(
      env,
      job,
      files,
      reviews,
      { findingsReported: 0, verdict: 'failed', severityDistribution: {} },
      { concurrencyLevel, retryCount },
    );

    throw new Error('All files failed to review');
  }

  const hasFailures = fileSummaries.some((file) => file.verdict === 'failed');
  const failedFileCount = fileSummaries.filter((file) => file.verdict === 'failed').length;
  const severityRanks: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };
  const minRank = severityRanks[config.review.min_severity] ?? 4;
  const minConfidence = config.review.min_confidence ?? 0;

  // 1. Severity + confidence gates. A finding whose confidence is below the threshold is dropped as
  //    too speculative. The parser now substitutes 0 for an omitted score on EVERY provider, so an
  //    omission can no longer sail past a threshold that a reported 0.1 would have failed -- which
  //    is what made this gate a no-op on the Google chain. Note `min_confidence` now defaults to 0
  //    (see the rationale on the schema): confidence is inversely correlated with correctness here,
  //    so the gate is repaired but deliberately inert unless an operator opts in.
  // Which stage ended each finding's life, keyed by fingerprint. `posted = false` on its own
  // conflates six outcomes, which is what made the historical corpus unusable for evaluation --
  // "P3 is never posted" turned out to be mostly P3 sorting last and the cap slicing from the end.
  // Attribution has to be captured where the decision is made; it cannot be reconstructed later.
  const dispositions = new Map<string, FindingDisposition>();
  // The verifier's own words, for kept findings as well as dropped ones. Parsed and discarded until
  // now; it is the only surface that explains WHY the Gatekeeper ruled the way it did, and a filter
  // nobody can inspect is a filter nobody can tune.
  const verifyReasons = new Map<string, string>();
  const recordDisposition = (comments: ParsedReviewComment[], stage: FindingDisposition) => {
    for (const comment of comments) {
      if (comment.fingerprint && !dispositions.has(comment.fingerprint)) {
        dispositions.set(comment.fingerprint, stage);
      }
    }
  };

  let finalComments = reviewedComments.filter((c) => {
    if ((severityRanks[c.severity] ?? 4) > minRank) {
      recordDisposition([c], 'severity');
      return false;
    }
    if (typeof c.confidenceScore === 'number' && c.confidenceScore < minConfidence) {
      recordDisposition([c], 'confidence');
      return false;
    }
    return true;
  });

  // 2. Cross-run suppression: don't re-post a finding this PR has already seen on an earlier
  //    commit (unless its line changed), or one a human deleted in this repo. Runs BEFORE dedupe
  //    so a suppressed finding can't be elected as the representative of a title group and take a
  //    genuinely-new sibling down with it -- and before verification, so we don't spend model
  //    tokens re-judging comments that will never be posted.
  const suppressed = await loadSuppressedFingerprints(env, job.id);
  const suppressedComments: ParsedReviewComment[] = [];
  const hasSuppressionData = suppressed.rejected.size > 0 || suppressed.posted.size > 0
    || suppressed.rejectedV2.size > 0 || suppressed.postedV2.size > 0;
  if (hasSuppressionData) {
    finalComments = finalComments.filter((c) => {
      // EITHER identity matching is enough. The v1-only version missed reworded repeats: measured on
      // PR #55, six of ten findings were re-reports of claims already posted on an earlier commit and
      // only one shared a v1 fingerprint, because v1 hashes the title and the model rewords it every
      // run. Note there is no `if (!c.fingerprint) return true` early-out any more -- a finding
      // carrying only a v2 key must still be matchable.
      const rejected = (c.fingerprint && suppressed.rejected.has(c.fingerprint))
        || (c.fingerprintV2 && suppressed.rejectedV2.has(c.fingerprintV2));

      // v1 additionally requires the anchored line to be unchanged, because the title alone says
      // nothing about the code. v2 needs no such check: the anchor is already part of the key, so an
      // edit to the line produces a different key and re-raises the finding by construction.
      const anchors = c.fingerprint ? suppressed.posted.get(c.fingerprint) : undefined;
      const alreadyPosted = (anchors && c.anchorHash && anchors.has(c.anchorHash))
        || (c.fingerprintV2 && suppressed.postedV2.has(c.fingerprintV2));

      if (rejected || alreadyPosted) {
        suppressedComments.push(c);
        return false;
      }
      return true;
    });
  }
  const droppedBySuppression = suppressedComments.length;
  recordDisposition(suppressedComments, 'suppression');

  // 3. Collapse duplicate findings repeated across files (e.g. the same "Use of any" N times).
  //    NOTE: dedupe elects one representative per normalized title across ALL files and runs
  //    BEFORE verification. If the elected representative is then dropped by the verifier, a
  //    genuine same-titled finding in another file is already gone. The disposition data below is
  //    what will finally make that visible.
  const beforeDedupe = finalComments;
  finalComments = dedupeFindings(finalComments);
  const survivedDedupe = new Set(finalComments);
  recordDisposition(beforeDedupe.filter((c) => !survivedDedupe.has(c)), 'dedupe');

  // 4. Order by severity (most severe first), then by confidence, so the max_comments cap keeps the
  //    strongest findings rather than whichever happened to be first in file order.
  finalComments.sort((a, b) => {
    const rankDiff = (severityRanks[a.severity] ?? 4) - (severityRanks[b.severity] ?? 4);
    if (rankDiff !== 0) return rankDiff;
    return (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0);
  });

  // 5. Verification pass: one consolidated model call re-checks the surviving candidates against the
  //    actual diff and subtracts what doesn't hold up. Best-effort — on any failure we keep the
  //    filtered set. It returns a subsequence, so the severity sort above survives into the cap.
  const beforeVerifyList = finalComments;
  const verify = await verifyFindings({ job, config, files, comments: finalComments, model, maxCandidates: effectiveMaxComments });
  finalComments = verify.comments;
  const droppedByVerification = verify.dropped.length;
  // Per-drop attribution rather than a set difference: this is what distinguishes "the model judged
  // this a drop" from "the verifier never answered" from "we could render no context for it".
  for (const drop of verify.dropped) recordDisposition([drop.comment], drop.disposition);
  for (const [comment, reason] of verify.reasons) {
    if (comment.fingerprint) verifyReasons.set(comment.fingerprint, reason);
  }

  const beforeCapList = finalComments;
  const beforeCap = finalComments.length;
  if (finalComments.length > effectiveMaxComments) {
    finalComments = finalComments.slice(0, effectiveMaxComments);
  }
  const droppedByCap = beforeCap - finalComments.length;
  recordDisposition(beforeCapList.slice(effectiveMaxComments), 'cap');
  const omittedCount = reviewedComments.length - finalComments.length;
  // Everything removed before verification, minus suppression: severity/confidence gates + dedupe.
  const droppedByFilters = omittedCount - droppedBySuppression - droppedByVerification - droppedByCap;

  // Findings the PARSER withheld. They never became review_comments rows, so `reviewedComments` has
  // never seen them and no disposition could be recorded -- which is why the count has to be carried
  // on the file_reviews row. Needed for the verdict below: without it, "the model found nothing" and
  // "everything it found was withheld" are the same state, and both get approved.
  const withheldByParser = reviews.reduce(
    (sum, review) => sum + (review.withheld_counts?.evidence ?? 0) + (review.withheld_counts?.claimDenied ?? 0),
    0,
  );

  // Per-claim-type counts, split by whether the finding survived. This is the number that matters:
  // a type that is repeatedly generated and never posted is a type to retire. It would have shown
  // `react_hook_missing_deps` at 0-posted-out-of-28 long before it produced six false positives in
  // a single review.
  const byClaimType: Record<string, { generated: number; posted: number }> = {};
  for (const comment of reviewedComments) {
    const key = comment.claimType ?? 'unlabelled';
    byClaimType[key] ??= { generated: 0, posted: 0 };
    byClaimType[key].generated += 1;
  }
  for (const comment of finalComments) {
    const key = comment.claimType ?? 'unlabelled';
    byClaimType[key] ??= { generated: 0, posted: 0 };
    byClaimType[key].posted += 1;
  }

  logger.info('Finding pipeline outcome', {
    jobId: job.id,
    parsed: reviewedComments.length,
    droppedByFilters,
    droppedBySuppression,
    droppedByVerification,
    droppedByCap,
    posted: finalComments.length,
    withheldByParser,
    byClaimType,
    // Partitioned by channel, because rule candidates occupy review_comments rows and count toward
    // every volume metric. Without this the numbers used to judge the LLM channel silently include
    // deterministic hits, which is the one thing that would make this experiment uninterpretable.
    byChannel: {
      llm: finalComments.filter((c) => c.source !== 'rule').length,
      rule: finalComments.filter((c) => c.source === 'rule').length,
    },
    // The retirement signal: `generated` high with `posted` at zero means the verifier always
    // rejects that rule, so delete or fix it rather than leaving it to add noise.
    byRule: reviewedComments.reduce<Record<string, number>>((acc, c) => {
      if (c.source === 'rule' && c.ruleId) acc[c.ruleId] = (acc[c.ruleId] ?? 0) + 1;
      return acc;
    }, {}),
    // Canaries. A review that posts nothing is not automatically wrong, but three in a row means
    // the filters have gone too far -- that is the signal to revert the most recent change.
    postedAny: finalComments.length > 0,
    postedPer100Files: files.length > 0
      ? Math.round((finalComments.length / files.length) * 1000) / 10
      : 0,
  });

  // Scored, not applied. Read this over ~20 reviews to decide whether any Phase-2 rule earns its
  // place; `wouldDropPosted` is the cost side, and it is the number that would have been invisible
  // if these rules had simply been switched on.
  logger.info('Shadow filter evaluation', {
    jobId: job.id,
    ...shadowEvaluate(beforeVerifyList, finalComments),
  });

  // Verdict is computed from the findings that are STILL OPEN on this PR, not just the ones being
  // posted right now. A finding suppressed because we already commented on it in an earlier commit
  // is still unaddressed -- approving the PR (and applying the green label) while an unresolved P0
  // comment sits on the diff would be actively misleading.
  const rawVerdict = formatter.summarizeVerdict([...finalComments, ...suppressedComments], hasFailures);

  // A PR whose every finding was withheld must not read as a clean one. The gates are strict and
  // deliberately so, but "we filtered all of it" and "there was nothing to find" are different
  // statements and only the second justifies a green approval. Downgrading to 'comment' also moves
  // the label off the approved one, which is the point: the reader should not infer a pass.
  const everythingWithheld = finalComments.length === 0
    && suppressedComments.length === 0
    && (withheldByParser > 0 || omittedCount > 0);
  const verdictSummary = everythingWithheld && rawVerdict.verdict === 'approve'
    ? { ...rawVerdict, verdict: 'comment' as const }
    : rawVerdict;
  await updateJobStep(env, job.id, 'Generating Summary', { status: 'done' });
  await heartbeatAndCheckSuperseded(env, job.id, leaseOwner);

  let formattedSummary = formatter.formatReviewOverview(pr.head.sha, env.BOT_USERNAME);

  // Say so when the pull request was larger than the file ceiling. Reviewing 100 of 106 files
  // and reporting it as a finished review is indistinguishable from having found nothing wrong
  // in the other six.
  if (filesOverCap > 0) {
    formattedSummary += `\n\n> [!WARNING]\n> **${filesOverCap} file${filesOverCap === 1 ? ' was' : 's were'} not reviewed.** This pull request has ${files.length + filesOverCap} reviewable files and the limit is ${reviewSettings.maxFiles}. Raise it in Settings to cover the whole diff.`;
  }

  if (omittedCount > 0) {
    // Attribute the drops to their actual cause. The old wording always blamed
    // "noise ... and the review is capped at max_comments", which read as though the
    // cap was the reason even when it never bound — e.g. 9 findings against a cap of
    // 10, where verification was what removed them.
    const reasons: string[] = [];
    if (droppedByFilters > 0) reasons.push(`${droppedByFilters} filtered as low-confidence, below the severity threshold, or duplicates`);
    if (droppedBySuppression > 0) reasons.push(`${droppedBySuppression} already reported on an earlier commit of this PR, or previously dismissed`);
    if (droppedByVerification > 0) reasons.push(`${droppedByVerification} dropped by the verification pass as unconfirmed against the diff`);
    if (droppedByCap > 0) reasons.push(`${droppedByCap} over the \`max_comments\` cap (${effectiveMaxComments})`);

    formattedSummary += `\n\n> [!NOTE]\n> **${omittedCount} finding${omittedCount === 1 ? ' was' : 's were'} omitted** — ${reasons.join('; ')}.`;
  }

  // Counted separately from `omittedCount`, which is derived from review_comments rows these findings
  // never got. Reported anyway: withholding an unverifiable claim is the right call, but doing it
  // silently is how a filtered review becomes indistinguishable from a clean one.
  if (withheldByParser > 0) {
    formattedSummary += `\n\n> [!NOTE]\n> **${withheldByParser} further claim${withheldByParser === 1 ? ' was' : 's were'} withheld** before review — either the quoted code could not be found in the diff, or the claim was of a kind that cannot be judged from a diff alone. They are listed per file below.`;
  }

  // If a prior finalize attempt already reached the posting stage (the 'Completing' step was
  // started) and then died before completeJob recorded the review id, the review may already be on
  // GitHub. Re-posting would duplicate it, so reuse the existing one. This GitHub read is only paid
  // on an actual finalize re-run, never on the common first pass.
  const finalizeRetriedPastPost = job.steps.some(
    (step) => step.name === 'Completing' && (step.status === 'running' || step.status === 'done'),
  );
  await updateJobStep(env, job.id, 'Completing', { status: 'running' });
  const existingReview: { id: number; postedIndices?: number[] } | null = finalizeRetriedPastPost
    ? await github.findBotReviewForCommit(job.owner, job.repo, job.prNumber, pr.head.sha, env.BOT_USERNAME)
    : null;
  const review = existingReview ?? await github.createReview(job.owner, job.repo, job.prNumber, {
    commitSha: pr.head.sha,
    event: formatter.toReviewEvent(verdictSummary.verdict),
    body: formattedSummary,
    // `line` is what the model actually reports (a file line number); `position`
    // (a diff offset) is nothing the pipeline computes, so sending only that meant
    // every inline comment was discarded before it reached GitHub.
    comments: finalComments.map(comment => ({
      path: comment.path,
      line: comment.line ?? undefined,
      side: 'RIGHT' as const,
      position: comment.position ?? undefined,
      body: formatter.formatInlineComment(comment),
    })),
  });

  // Record which findings GitHub actually accepted, so later commits on this PR can suppress them.
  // `postedIndices` -- not `finalComments` -- because the 422 fallback re-posts with zero inline
  // comments and unaddressable comments are dropped client-side; marking those posted would hide
  // them permanently without anyone having seen them. On the resume path we have no per-comment
  // correspondence at all, so we mark nothing and accept a possible duplicate over a silent loss.
  if (review.postedIndices && review.postedIndices.length > 0) {
    const postedFingerprints = review.postedIndices
      .map((index) => finalComments[index]?.fingerprint)
      .filter((fingerprint): fingerprint is string => Boolean(fingerprint));
    await markCommentsPosted(env, job.id, postedFingerprints);
  }

  // Record why every other finding did not make it. Best-effort: this is measurement, and a
  // failure here must never fail a review that is already on GitHub.
  try {
    // Union of the two maps: every finding with a disposition, plus every finding the verifier gave a
    // reason for (including the ones it KEPT, which have no disposition and must not clobber
    // 'posted' -- see the COALESCE in markCommentDispositions).
    const withReasons = new Map<string, { disposition: string | null; reason: string | null }>();
    for (const fingerprint of new Set([...dispositions.keys(), ...verifyReasons.keys()])) {
      withReasons.set(fingerprint, {
        disposition: dispositions.get(fingerprint) ?? null,
        reason: verifyReasons.get(fingerprint) ?? null,
      });
    }
    await markCommentDispositions(env, job.id, withReasons);
  } catch (error) {
    logger.warn('Could not record finding dispositions', {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const fileInputTokens = reviews.reduce((sum, review) => sum + (review.input_tokens ?? 0), 0);
  const fileOutputTokens = reviews.reduce((sum, review) => sum + (review.output_tokens ?? 0), 0);

  const severityDistribution: Record<string, number> = {};
  for (const comment of finalComments) {
    const sev = comment.severity || 'unknown';
    severityDistribution[sev] = (severityDistribution[sev] || 0) + 1;
  }

  const partialErrorMessage = hasFailures
    ? `Partial review: ${failedFileCount} of ${files.length} file${files.length === 1 ? '' : 's'} could not be reviewed.`
    : null;
  // Record the posted review and mark the job done IMMEDIATELY after createReview -- before the
  // best-effort cosmetics below. The review is already on GitHub at this point; if the remaining
  // label/check-run calls exhaust this invocation's subrequest budget (large PR), we must not leave
  // the job stranded as 'failed' with review_id null. This is the critical, must-not-lose write.
  await completeJob(env, job.id, {
    verdict: verdictSummary.verdict,
    fileCount: files.length,
    commentCount: finalComments.length,
    totalInputTokens: fileInputTokens,
    totalOutputTokens: fileOutputTokens,
    summaryMarkdown: formattedSummary,
    reviewId: review.id,
    summaryModel: null,
    errorMessage: partialErrorMessage,
  });
  logger.info(`Review job completed: ${job.owner}/${job.repo} PR #${job.prNumber}`);

  // The cached PR diff is intentionally left in KV (not deleted here): diff_input/prompts are no
  // longer persisted to Postgres, so the job detail UI reconstructs a file's diff on demand from
  // this same cache for as long as its 6h TTL lasts, falling back to GitHub after that (see
  // getDiffFiles below and the /api/jobs/:id/diffs route).

  // Cosmetics: labels and the check-run conclusion. Best-effort -- the review is posted and the job
  // is already 'done', so a failure here (e.g. subrequest budget spent, GitHub blip) must not fail
  // the job. completeTerminalCheckRuns / a re-run can reconcile a check run left un-updated.
  try {
    // Check-run conclusion first: it drives the PR's status badge, so it matters more than labels
    // if the budget only allows one of them.
    if (job.checkRunId) {
      await github.updateCheckRun(job.owner, job.repo, job.checkRunId, {
        status: 'completed',
        conclusion: hasFailures ? 'failure' : (verdictSummary.verdict === 'approve' ? 'success' : 'neutral'),
        title: hasFailures ? 'Review partially failed' : (verdictSummary.verdict === 'approve' ? 'LGTM' : 'Comments posted'),
        summary: `${finalComments.length} inline comments across ${files.length} files.${hasFailures ? ` ${failedFileCount} file${failedFileCount === 1 ? '' : 's'} could not be reviewed.` : ''}`,
      });
      // Only now is the check run genuinely completed -- record it so the maintenance sweep doesn't
      // redo it. If the update above threw, this line is skipped and completeTerminalCheckRuns will
      // finish the check run on a later invocation with a fresh budget.
      await markJobCheckRunCompleted(env, job.id);
    }

    if (config.review.labels !== false) {
      const labels = config.review.labels;
      const labelMap = {
        comment: { name: labels.p1, color: 'f79009' },
        approve: { name: labels.p2, color: '027a48' },
      } as const;
      const label = labelMap[verdictSummary.verdict];

      await github.removeIssueLabelsIfPresent(
        job.owner,
        job.repo,
        job.prNumber,
        [labels.p1, labels.p2, labels.p3].filter(possibleLabel => possibleLabel !== label.name),
      );

      await github.ensureLabel(job.owner, job.repo, label.name, label.color);
      await github.addIssueLabels(job.owner, job.repo, job.prNumber, [label.name]);
    }
  } catch (error) {
    logger.warn(`Post-review labels/check-run update failed for job ${job.id}; review is posted and job is completed, so leaving it best-effort`, error instanceof Error ? error : new Error(String(error)));
  }

  await sendReviewTelemetry(
    env,
    job,
    files,
    reviews,
    { findingsReported: finalComments.length, verdict: verdictSummary.verdict, severityDistribution },
    { concurrencyLevel, retryCount },
  );
}

async function heartbeatAndCheckSuperseded(env: AppBindings, jobId: string, leaseOwner: string) {
  await heartbeatJobLease(env, jobId, leaseOwner, JOB_LEASE_SECONDS);
  const currentJob = await getJobForProcessing(env, jobId);
  if (currentJob?.status === 'superseded') {
    throw new Error('JOB_SUPERSEDED');
  }
}

export class NextPhaseError extends Error {
  constructor(public phase: 'prepare' | 'review' | 'finalize', public delaySeconds: number) {
    super(`NextPhase: ${phase}`);
  }
}

async function enqueueJobPhase(
  env: AppBindings,
  jobId: string,
  phase: 'prepare' | 'review' | 'finalize',
  delaySeconds = 0,
) {
  await markJobContinuationQueued(env, jobId, delaySeconds);
  throw new NextPhaseError(phase, delaySeconds);
}

function hasCompletedStep(job: PersistedReviewJob, stepName: string) {
  return job.steps.some((step) => step.name === stepName && step.status === 'done');
}

export async function failJobAndCheckRun(
  env: AppBindings,
  job: Pick<PersistedReviewJob, 'id' | 'owner' | 'repo' | 'checkRunId'>,
  github: Pick<GitHubService, 'updateCheckRun'>,
  message: string,
) {
  // Marking the job failed in the DB is the critical, must-not-lose write: it's what
  // makes the job terminal so it stops being retried, and it's what makes it eligible
  // for completeTerminalCheckRuns() to pick up later if the GitHub call below fails.
  try {
    await failJob(env, job.id, message);
  } catch (dbError) {
    logger.error(`Critical: failed to mark job ${job.id} as failed in the DB; it may remain stuck until lease-expiry recovery reclaims it`, dbError);
    return;
  }

  // Updating the GitHub check run is best-effort here. If it fails (e.g. the Worker's
  // subrequest budget for this invocation is already exhausted from the review itself),
  // the job is still durably marked failed above, and the opportunistic maintenance sweep
  // (completeTerminalCheckRuns) will retry this update on a later invocation with a fresh budget.
  try {
    const latest = await getJobForProcessing(env, job.id);
    const checkRunId = latest?.check_run_id ?? job.checkRunId;
    if (checkRunId) {
      await github.updateCheckRun(job.owner, job.repo, checkRunId, {
        status: 'completed',
        conclusion: 'failure',
        title: 'Review failed',
        summary: message,
      });
      await markJobCheckRunCompleted(env, job.id);
    }
  } catch (checkRunError) {
    logger.warn(`Failed to update GitHub check run for failed job ${job.id}; opportunistic maintenance will retry it`, checkRunError);
  }
}
