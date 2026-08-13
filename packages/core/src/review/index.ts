import { logger } from '../logger';
import { isSupportedGitHubWebhookEvent, type GitHubWebhookPayload, type PullRequestWebhookPayload } from '@codra/schema/github';
import { REVIEW_CONCURRENCY_LIMITS, type ReviewJobMessage } from '@codra/schema';
import type { ReviewGitHub, ReviewRuntime } from '../ports';
import { extractReviewRequest } from './request';

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
export { FRESH_INVOCATION_YIELD_SECONDS } from './phase-control';

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
  | { action: 'next_phase'; phase: 'prepare' | 'review' | 'finalize'; delaySeconds: number; jobId?: string; freshInstance?: boolean };

/**
 * The engine's entrypoint. Runs EXACTLY ONE phase of a review job and returns what the caller should
 * do next; the caller owns the loop.
 *
 * Deliberately not a loop. Every `next_phase` result exists because the next phase needs a fresh
 * host invocation to get a clean subrequest budget, and only the driver can hibernate long enough to
 * produce one (see FRESH_INVOCATION_YIELD_SECONDS in ./phase-control). A loop in here would run the
 * next phase on the current one's spent budget while its TokenTracker restarted at zero -- the exact
 * failure that constant was introduced to fix.
 *
 * Contract for a driver:
 *  - 'ack': the job is finished or not ours. Stop.
 *  - 'retry': re-deliver the SAME message after `delaySeconds`. Admission was throttled or the lease
 *    is held elsewhere; no work happened.
 *  - 'next_phase': re-invoke with `{ jobId, phase }` after `delaySeconds`. `freshInstance` means the
 *    delay must be long enough to actually hibernate, not merely to wait.
 *
 * Safe to call repeatedly for the same job: it claims a lease first, and every phase is idempotent
 * enough to resume. It throws only on a programming error -- job failures are recorded and acked.
 */
export async function runReview(env: ReviewRuntime, message: ReviewJobMessage): Promise<ReviewJobRunResult> {
  const resolved = await resolveQueuedJob(env, message);
  if (!resolved) {
    return { action: 'ack' };
  }

  if (resolved.job.status === 'queued') {
    const { concurrencyLevel } = await env.settings.getReviewSettings();
    const maxConcurrentJobs = REVIEW_CONCURRENCY_LIMITS[concurrencyLevel];
    const runningCount = await env.jobs.getOtherRunningJobsCount(resolved.job.id);
    if (runningCount >= maxConcurrentJobs) {
      logger.info(`Throttling admission of job ${resolved.job.id}: ${runningCount} other jobs are currently running.`);
      return { action: 'retry', delaySeconds: 30 };
    }
  }

  const leaseOwner = env.ids.randomUUID();
  const claim = await env.jobs.claimJobLease(resolved.job.id, leaseOwner, JOB_LEASE_SECONDS);
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

  const job = env.jobs.mapJob(claim.row);

  if (message.workflowInstanceId && job.workflowInstanceId !== message.workflowInstanceId) {
    try {
      await env.jobs.setJobWorkflowInstance(job.id, message.workflowInstanceId);
    } catch (error) {
      logger.warn(`Failed to bind workflow instance id for job ${job.id}`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  const phase = resolved.phase;
  const tracker = env.createTokenTracker();
  const github = env.createGitHub(job.installationId, tracker);
  const model = env.createModel(job.id, tracker);
  const formatter = env.createFormatter();

  try {
    if (phase === 'prepare') {
      await runPreparePhase(env, job, leaseOwner, github);
    } else if (phase === 'finalize') {
      await runFinalizePhase(env, job, leaseOwner, github, formatter, model);
    } else {
      await runReviewPhase(env, job, leaseOwner, github, model, tracker);
    }

    await env.jobs.releaseJobLease(job.id, leaseOwner);
    return { action: 'ack' };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Unknown review failure';
    if (messageText === 'JOB_SUPERSEDED') {
      logger.info(`Job ${job.id} was superseded during execution, stopping.`);
      await env.jobs.releaseJobLease(job.id, leaseOwner);
      return { action: 'ack' };
    }

    if (error instanceof NextPhaseError) {
      await env.jobs.releaseJobLease(job.id, leaseOwner);
      return { action: 'next_phase', phase: error.phase, delaySeconds: error.delaySeconds, jobId: job.id, freshInstance: error.phase === 'finalize' };
    }

    if (env.modelErrors.isRetryableModelError(error)) {
      const delaySeconds = getRetryableModelFailureDelaySeconds(error);
      logger.warn(`Review job hit transient model/provider failure; scheduling delayed continuation: ${job.owner}/${job.repo} PR #${job.prNumber}`, {
        error: messageText,
        phase,
        delaySeconds,
      });
      return continueOrFailWedgedJob(env, job, github, leaseOwner, phase, delaySeconds, 'transient model/provider failures');
    }

    if (isSubrequestBudgetError(error)) {
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
    await env.jobs.releaseJobLease(job.id, leaseOwner);
    return { action: 'ack' };
  }
}

async function continueOrFailWedgedJob(
  env: ReviewRuntime,
  job: PersistedReviewJob,
  github: ReviewGitHub,
  leaseOwner: string,
  phase: 'prepare' | 'review' | 'finalize',
  delaySeconds: number,
  reason: string,
): Promise<ReviewJobRunResult> {
  const continuationCount = await env.jobs.markJobContinuationQueued(job.id, delaySeconds);

  const ceiling = phase === 'finalize' ? MAX_FINALIZE_CONTINUATIONS : MAX_JOB_CONTINUATIONS;

  if (continuationCount > ceiling) {
    if (phase === 'review') {
      logger.error(`Review job exceeded the continuation ceiling; degrading to a partial review: ${job.owner}/${job.repo} PR #${job.prNumber}`, {
        phase,
        continuationCount,
        reason,
      });
      const stillPending = (await env.fileReviews.getFileReviewsForJobs([job.id])).filter(isAwaitingAsyncReview);
      for (const review of stillPending) {
        await persistFailedFileReview(env, job.id, {
          filePath: review.file_path,
          modelUsed: review.async_model ?? review.model_used,
          diffLineCount: review.diff_line_count,
          errorMessage: 'Async batch review did not complete before the job wedged.',
          clearAsync: true,
        });
      }
      await env.jobs.resetJobContinuationCount(job.id);
      await env.jobs.releaseJobLease(job.id, leaseOwner);
      return { action: 'next_phase', phase: 'finalize', delaySeconds: FRESH_INVOCATION_YIELD_SECONDS, jobId: job.id, freshInstance: true };
    } else {
      const message = `Review could not make progress after ${continuationCount} continuation attempts (${reason}). Failing the job to avoid an endless retry loop; re-run it once the underlying provider issue clears.`;
      logger.error(`Review job exceeded the continuation ceiling; failing terminally: ${job.owner}/${job.repo} PR #${job.prNumber}`, {
        phase,
        continuationCount,
        reason,
      });
      await failJobAndCheckRun(env, job, github, message);
      await env.jobs.releaseJobLease(job.id, leaseOwner);
      return { action: 'ack' };
    }
  }

  await env.jobs.releaseJobLease(job.id, leaseOwner);
  const freshInstance = reason.includes('subrequest');
  return { action: 'next_phase', phase, delaySeconds, jobId: job.id, freshInstance };
}

async function resolveQueuedJob(
  env: ReviewRuntime,
  message: ReviewJobMessage,
): Promise<{ job: PersistedReviewJob; phase: 'prepare' | 'review' | 'finalize' } | null> {
  if (message.jobId) {
    const row = await env.jobs.getJobForProcessing(message.jobId);
    return row ? { job: env.jobs.mapJob(row), phase: message.phase ?? 'review' } : null;
  }

  if (!message.eventName) {
    logger.warn('Queue message ignored: missing eventName');
    return null;
  }

  let eventName = message.eventName;
  let payload = message.payload as GitHubWebhookPayload | undefined;

  if (payload === undefined) {
    const delivery = await env.webhooks.getWebhookDelivery(message.deliveryId);
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

  const repoConfig = await env.repoConfig.loadRepoConfig({
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
    botUsername: env.botUsername,
    config: repoConfig.parsedJson,
  });

  if (!extracted) {
    if (eventName === 'pull_request') {
      const prPayload = payload as PullRequestWebhookPayload;
      if (prPayload.action === 'closed' && repoConfig.parsedJson.review.labels !== false) {
        const labels = repoConfig.parsedJson.review.labels;
        const gh = env.githubClients.forInstallation(installationId);
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
  const githubClient = env.githubClients.forInstallation(installationId);
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

  const duplicateJob = await env.jobs.findExistingJobForHead({
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

  const job = await env.jobs.insertJob({
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

  await env.jobs.supersedeOlderJobs({
    installationId: resolved.installationId,
    owner: resolved.owner,
    repo: resolved.repo,
    prNumber: resolved.prNumber,
    newJobId: job.id,
  });

  return { job, phase: 'prepare' };
}
