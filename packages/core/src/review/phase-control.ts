import { logger } from '../logger';
import type { PersistedReviewJob, ReviewGitHub, ReviewRuntime } from '../ports';


// JobSummary, which is exactly what mapJob returns; see the note on the port.
export type { PersistedReviewJob };

export const REVIEW_CHUNK_WALL_CLOCK_MS = 12 * 60 * 1000;
export const JOB_LEASE_SECONDS = 15 * 60;
export const BUSY_RETRY_SECONDS = 60;
export const RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS = [30, 2 * 60, 5 * 60];
export const FRESH_INVOCATION_YIELD_SECONDS = 8;
export const ASYNC_BATCH_POLL_DELAY_SECONDS = 20;
export const MAX_RETRYABLE_FILE_REVIEW_FAILURES = 6;
export const MAX_JOB_CONTINUATIONS = 20;
export const MAX_FINALIZE_CONTINUATIONS = 3;

export async function heartbeatAndCheckSuperseded(env: ReviewRuntime, jobId: string, leaseOwner: string) {
  await env.jobs.heartbeatJobLease(jobId, leaseOwner, JOB_LEASE_SECONDS);
  const currentJob = await env.jobs.getJobForProcessing(jobId);
  if (currentJob?.status === 'superseded') {
    throw new Error('JOB_SUPERSEDED');
  }
}

export class NextPhaseError extends Error {
  constructor(public phase: 'prepare' | 'review' | 'finalize', public delaySeconds: number) {
    super(`NextPhase: ${phase}`);
  }
}

export async function enqueueJobPhase(
  env: ReviewRuntime,
  jobId: string,
  phase: 'prepare' | 'review' | 'finalize',
  delaySeconds = 0,
) {
  await env.jobs.markJobContinuationQueued(jobId, delaySeconds);
  throw new NextPhaseError(phase, delaySeconds);
}

export function hasCompletedStep(job: PersistedReviewJob, stepName: string) {
  return job.steps.some((step) => step.name === stepName && step.status === 'done');
}

export async function failJobAndCheckRun(
  env: ReviewRuntime,
  job: Pick<PersistedReviewJob, 'id' | 'owner' | 'repo' | 'checkRunId'>,
  github: Pick<ReviewGitHub, 'updateCheckRun'>,
  message: string,
) {
  try {
    await env.jobs.failJob(job.id, message);
  } catch (dbError) {
    logger.error(`Critical: failed to mark job ${job.id} as failed in the DB; it may remain stuck until lease-expiry recovery reclaims it`, dbError);
    return;
  }

  try {
    const latest = await env.jobs.getJobForProcessing(job.id);
    const checkRunId = latest?.check_run_id ?? job.checkRunId;
    if (checkRunId) {
      await github.updateCheckRun(job.owner, job.repo, checkRunId, {
        status: 'completed',
        conclusion: 'failure',
        title: 'Review failed',
        summary: message,
      });
      await env.jobs.markJobCheckRunCompleted(job.id);
    }
  } catch (checkRunError) {
    logger.warn(`Failed to update GitHub check run for failed job ${job.id}; opportunistic maintenance will retry it`, checkRunError);
  }
}
