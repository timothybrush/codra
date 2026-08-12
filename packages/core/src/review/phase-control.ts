import { logger } from '../logger';
import type { PersistedReviewJob, ReviewGitHub, ReviewRuntime } from '../ports';

// Sibling of core/review.ts -- import from that barrel, not from here.
// THE LEAF OF THE REVIEW FAMILY: phase.ts and finalize.ts both need exports from here, so this module must import NOTHING from any other review-* sibling or import-x/no-cycle fires.

// Re-exported so the review family keeps its single source for the job type. It resolves to
// JobSummary, which is exactly what mapJob returns; see the note on the port.
export type { PersistedReviewJob };

export const REVIEW_CHUNK_WALL_CLOCK_MS = 12 * 60 * 1000;
export const JOB_LEASE_SECONDS = 15 * 60;
export const BUSY_RETRY_SECONDS = 60;
// Short first: most transient failures are momentary provider load or self-inflicted connection queuing, both of which clear in seconds.
export const RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS = [30, 2 * 60, 5 * 60];
// Must force HIBERNATE to buy a fresh 50-subrequest budget -- 2s did not, causing false "Too many subrequests" loops. Do not lower without re-checking that.
export const FRESH_INVOCATION_YIELD_SECONDS = 8;
// Poll cadence for an in-flight Workers AI async batch, bounded by MAX_JOB_CONTINUATIONS so a stuck batch cannot loop forever.
export const ASYNC_BATCH_POLL_DELAY_SECONDS = 20;
// A big bin now spends a whole invocation on ONE model (MODEL_FALLBACK_CHAIN_BUDGET_MS is only a little
// above the per-call ceiling), so this is also the ceiling on how DEEP into its fallback chain a file
// can ever get: the resume memo advances one entry per deferral. At 3 a chain longer than three models
// lost its tail no matter how healthy those entries were. Costs worst-case latency, not attempts --
// RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS tops out at 5 minutes per deferral.
export const MAX_RETRYABLE_FILE_REVIEW_FAILURES = 6;
// Ceiling on same-phase reschedules with no file completed; any progress resets it.
export const MAX_JOB_CONTINUATIONS = 20;
// Lower than review's: finalize either fits a fresh invocation's budget or it doesn't; the check-run reconciler recovers past that.
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
  // Must-not-lose write: marks the job terminal so it stops retrying, and eligible for completeTerminalCheckRuns if the GitHub call below fails.
  try {
    await env.jobs.failJob(job.id, message);
  } catch (dbError) {
    logger.error(`Critical: failed to mark job ${job.id} as failed in the DB; it may remain stuck until lease-expiry recovery reclaims it`, dbError);
    return;
  }

  // Best-effort: the job is already durably marked failed above, and completeTerminalCheckRuns retries this later.
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
