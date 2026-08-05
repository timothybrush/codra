import { logger } from '../logger';
import type { AppBindings } from '@server/env';
import {
  failJob,
  getJobForProcessing,
  heartbeatJobLease,
  mapJob,
  markJobCheckRunCompleted,
  markJobContinuationQueued,
} from '@server/db/jobs';
import type { GitHubService } from '../../services/github';

// Sibling of core/review.ts -- import from that barrel, not from here. Several specs mock that
// specifier, and workflows/review.ts imports only runReviewJob from it.
//
// THE LEAF OF THE REVIEW FAMILY. phase.ts and finalize.ts both need enqueueJobPhase /
// NextPhaseError / heartbeatAndCheckSuperseded, and review.ts imports both of those. This module
// must therefore import NOTHING from any other review-* sibling, or import-x/no-cycle (an error)
// fires. Add nothing here that reaches back into the family.

export type PersistedReviewJob = ReturnType<typeof mapJob>;

export const REVIEW_CHUNK_WALL_CLOCK_MS = 12 * 60 * 1000;
export const JOB_LEASE_SECONDS = 15 * 60;
export const BUSY_RETRY_SECONDS = 60;
// Short first: most transient failures are momentary provider load or self-inflicted connection
// queuing, both of which clear in seconds. Later attempts back off in case it is a real outage.
export const RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS = [30, 2 * 60, 5 * 60];
// Long enough to force HIBERNATE, which is what buys a fresh 50-subrequest budget. 2s did NOT
// hibernate: the real budget kept accumulating across chunks while TokenTracker restarted at zero
// each time, so the tracker reported headroom that did not exist and the review looped on "Too many
// subrequests". 8s also keeps most of the speed win over the original 60s -- roughly 4 minutes on a
// 30-chunk review rather than ~30. Do not lower this without re-checking both halves.
export const FRESH_INVOCATION_YIELD_SECONDS = 8;
// Poll cadence for an in-flight Workers AI async batch. Bounded by MAX_JOB_CONTINUATIONS (each
// poll reschedule counts as a no-progress continuation), so a stuck batch cannot loop forever.
export const ASYNC_BATCH_POLL_DELAY_SECONDS = 20;
export const MAX_RETRYABLE_FILE_REVIEW_FAILURES = 3;
// Ceiling on same-phase reschedules with no file completed. Any progress resets it, so only a
// genuinely wedged job (provider down for the whole backoff window) ever reaches it.
export const MAX_JOB_CONTINUATIONS = 20;
// Lower than review's: finalize either fits a fresh invocation's budget or it does not, so a
// few retries cover a transient miss and no more; the check-run reconciler recovers past that.
export const MAX_FINALIZE_CONTINUATIONS = 3;

export async function heartbeatAndCheckSuperseded(env: AppBindings, jobId: string, leaseOwner: string) {
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

export async function enqueueJobPhase(
  env: AppBindings,
  jobId: string,
  phase: 'prepare' | 'review' | 'finalize',
  delaySeconds = 0,
) {
  await markJobContinuationQueued(env, jobId, delaySeconds);
  throw new NextPhaseError(phase, delaySeconds);
}

export function hasCompletedStep(job: PersistedReviewJob, stepName: string) {
  return job.steps.some((step) => step.name === stepName && step.status === 'done');
}

export async function failJobAndCheckRun(
  env: AppBindings,
  job: Pick<PersistedReviewJob, 'id' | 'owner' | 'repo' | 'checkRunId'>,
  github: Pick<GitHubService, 'updateCheckRun'>,
  message: string,
) {
  // The critical, must-not-lose write: marks the job terminal so it stops retrying, and eligible
  // for completeTerminalCheckRuns to pick up if the GitHub call below fails.
  try {
    await failJob(env, job.id, message);
  } catch (dbError) {
    logger.error(`Critical: failed to mark job ${job.id} as failed in the DB; it may remain stuck until lease-expiry recovery reclaims it`, dbError);
    return;
  }

  // Best-effort: a budget-exhausted invocation can fail this, but the job is already durably
  // marked failed above, and completeTerminalCheckRuns retries it later.
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
