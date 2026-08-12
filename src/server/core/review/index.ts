import { logger } from '../logger';
import { isSupportedGitHubWebhookEvent, type GitHubWebhookPayload, type PullRequestWebhookPayload } from '@codra/schema/github';
import { REVIEW_CONCURRENCY_LIMITS, type ReviewJobMessage } from '@codra/schema';
import type { AppBindings } from '@server/env';
import { getFileReviewsForJobs } from '@server/db/file-reviews';
import {
  claimJobLease,
  findExistingJobForHead,
  getJobForProcessing,
  getOtherRunningJobsCount,
  insertJob,
  mapJob,
  markJobContinuationQueued,
  resetJobContinuationCount,
  releaseJobLease,
  setJobWorkflowInstance,
  supersedeOlderJobs,
} from '@server/db/jobs';
import { extractReviewRequest } from './request';

// Re-exports below keep existing '@server/core/review' specifiers working for routes and specs.
export { getDiffFiles, getOrFetchRawDiffForCompletedJob } from './diff-cache';

export { budgetAwareFileLimit, estimatedSubrequestsPerFile } from './budget';

export {
  BIN_DIFF_CHAR_BUDGET,
  BIN_MAX_FILES,
  BIN_TARGET_DIFF_LINES,
  PACKABLE_MAX_DIFF_LINES,
  narrowUnit,
  planReviewUnits,
  unitFiles,
  type LedgerEntry,
  type ReviewUnit,
} from './pack';

export { proportionalSplit } from './bin-runner';

export { verifyFindings, type VerifyDrop, type VerifyOutcome } from '../finding-gates';

export { extractReviewRequest, type ReviewRequest } from './request';

// workflows/review.ts floors its inter-phase sleep here; the eslint barrel guard stops it
// importing phase-control directly.
export { FRESH_INVOCATION_YIELD_SECONDS } from './phase-control';

import { GitHubService } from '../../services/github';
import { GitHubClient } from '../github';
import { isRetryableModelError, ModelService } from '../../services/model';
import { FormatterService } from '../../services/formatter';
import { TokenTracker } from '../token-tracker';
import { loadRepoConfig } from '../config';
import { getWebhookDelivery } from '@server/db/webhook-deliveries';
import { getReviewSettings } from '@server/db/app-settings';
import {
  type PersistedReviewJob,
  BUSY_RETRY_SECONDS,
  FRESH_INVOCATION_YIELD_SECONDS,
  JOB_LEASE_SECONDS,
  MAX_FINALIZE_CONTINUATIONS,
  MAX_JOB_CONTINUATIONS,
  NextPhaseError,
  failJobAndCheckRun,
} from './phase-control';
import { getRetryableModelFailureDelaySeconds, isAwaitingAsyncReview, isSubrequestBudgetError } from './retry-policy';
import { persistFailedFileReview } from './file-runner';
import { runPreparePhase } from './prepare';
import { runReviewPhase } from './phase';
import { runFinalizePhase } from './finalize';

export { NextPhaseError, failJobAndCheckRun };

export type ReviewJobRunResult =
  | { action: 'ack' }
  | { action: 'retry'; delaySeconds: number }
  // jobId is resolved (mention-triggered jobs carry none). freshInstance starts a new Workflow instance: set on a subrequest deferral or the move into finalize.
  | { action: 'next_phase'; phase: 'prepare' | 'review' | 'finalize'; delaySeconds: number; jobId?: string; freshInstance?: boolean };

export async function runReviewJob(env: AppBindings, message: ReviewJobMessage): Promise<ReviewJobRunResult> {
  const resolved = await resolveQueuedJob(env, message);
  if (!resolved) {
    return { action: 'ack' };
  }

  // Admission only: re-gating a job already 'running' would retry forever and stale its lease.
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

  // Bind the Workflow instance id so stop/delete/rerun hit the right one; webhook jobs key theirs on deliveryId, so the earlier bind step cannot. Idempotent.
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
      // Finalize needs a fresh instance for a clean budget; other transitions hibernate instead.
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

    // Not a job failure: every phase is idempotent enough to resume on a fresh budget.
    if (isSubrequestBudgetError(error)) {
      // Only a long-enough sleep hibernates the workflow into the fresh invocation this needs.
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

// Records a same-phase continuation and enforces the ceiling. Completing any file resets the counter, so only a genuinely wedged job gets there.
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

  // Finalize fails fast instead of looping ~20 min; other phases make real per-file progress.
  const ceiling = phase === 'finalize' ? MAX_FINALIZE_CONTINUATIONS : MAX_JOB_CONTINUATIONS;

  if (continuationCount > ceiling) {
    if (phase === 'review') {
      // Must RETURN the transition: enqueueJobPhase() throws, and this runs inside a catch.
      logger.error(`Review job exceeded the continuation ceiling; degrading to a partial review: ${job.owner}/${job.repo} PR #${job.prNumber}`, {
        phase,
        continuationCount,
        reason,
      });
      // A file still awaiting an async batch would otherwise finalize as an empty 'successful'.
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
      // Finalize needs its own continuation budget: the counter is already past the ceiling.
      await resetJobContinuationCount(env, job.id);
      await releaseJobLease(env, job.id, leaseOwner);
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
  // A subrequest-limit deferral saturated THIS instance; a transient model deferral did not.
  const freshInstance = reason.includes('subrequest');
  return { action: 'next_phase', phase, delaySeconds, jobId: job.id, freshInstance };
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
