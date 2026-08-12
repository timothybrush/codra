import type { JobSummary, RepoConfig } from '@codra/schema';

// Job persistence. Method signatures mirror src/server/db/{jobs,jobs-leases,jobs-lifecycle}.ts
// exactly, minus the leading `env` parameter, which the adapter closes over.

/**
 * A job as the engine sees it.
 *
 * This is `JobSummary` rather than a hand-copied shape, and that is not a convenience: `mapJob` ends
 * in `jobSummarySchema.parse(...)`, and `.parse` strips unknown keys, so `ReturnType<typeof mapJob>`
 * IS this type. A field added to the mapper cannot widen it, and a field added to the schema widens
 * both sides together -- there is no channel for the two to drift. src/server/adapters/jobs-store.ts
 * carries a compile-time assertion pinning the equality.
 */
export type PersistedReviewJob = JobSummary;

/**
 * The raw jobs row, before `mapJob` decodes it.
 *
 * The engine reads exactly two columns off it -- `status`, to detect a job superseded mid-flight, and
 * `check_run_id`, to reconcile a check run on the failure path -- and otherwise only hands the row
 * straight back to `mapJob`. The index signature is what lets the db layer's own row type satisfy
 * this without core knowing the other forty columns exist.
 */
export type JobRow = {
  status: 'queued' | 'running' | 'done' | 'failed' | 'superseded' | 'cancelled' | 'stopped';
  check_run_id: number | null;
  [column: string]: unknown;
};

export type JobLeaseClaim =
  | { status: 'claimed'; row: JobRow }
  | { status: 'busy'; row: JobRow; retryAfterSeconds: number }
  | { status: 'terminal'; row: JobRow }
  | { status: 'missing' };

/**
 * Job rows and the lease that makes a phase safe to re-run.
 *
 * A correct implementation must guarantee:
 *  - `claimJobLease` is ATOMIC. Two concurrent callers for the same jobId must not both receive
 *    'claimed'; the loser gets 'busy'. Everything else here assumes the caller holds the lease, and
 *    a lease two workers can hold simultaneously means two workers reviewing and posting the same
 *    pull request. Claiming must also flip a 'queued' job to 'running' in the same operation.
 *  - `releaseJobLease` and `heartbeatJobLease` are no-ops when `leaseOwner` does not match the
 *    current holder. A phase that lost its lease to expiry-recovery must not be able to release the
 *    successor's claim.
 *  - `markJobContinuationQueued` returns the count AFTER incrementing, and never decreases for a
 *    given job except via `resetJobContinuationCount`. The two continuation ceilings are the only
 *    thing standing between a wedged job and an infinite reschedule loop, so an implementation that
 *    lost increments would loop forever.
 *  - every write is idempotent under retry. Each of these may be called twice for one logical step,
 *    because a phase that dies after the write is re-run from the top.
 *  - `insertJob` and `findExistingJobForHead` agree on identity: what insert stores under
 *    (owner, repo, prNumber, commitSha, trigger) is what find must return.
 *  - `mapJob` is pure and total for any row this store returned.
 * Ordering between calls is the caller's business; no method may reorder or batch across calls.
 */
export interface JobStore {
  mapJob(row: JobRow): PersistedReviewJob;

  getJobForProcessing(jobId: string): Promise<JobRow | null>;
  claimJobLease(jobId: string, leaseOwner: string, leaseSeconds: number): Promise<JobLeaseClaim>;
  heartbeatJobLease(jobId: string, leaseOwner: string, leaseSeconds: number): Promise<void>;
  releaseJobLease(jobId: string, leaseOwner: string): Promise<void>;
  markJobContinuationQueued(jobId: string, delaySeconds?: number): Promise<number>;
  resetJobContinuationCount(jobId: string): Promise<void>;
  getOtherRunningJobsCount(excludeJobId: string): Promise<number>;

  setJobWorkflowInstance(jobId: string, workflowInstanceId: string): Promise<void>;
  setJobPullRequestMeta(jobId: string, meta: { prTitle: string | null; prAuthor: string | null }): Promise<void>;
  insertJob(input: {
    installationId: string;
    owner: string;
    repo: string;
    prNumber: number;
    prTitle: string | null;
    prAuthor: string | null;
    commitSha: string;
    baseSha: string;
    trigger: 'auto' | 'mention' | 'retry';
    headRef: string | null;
    baseRef: string | null;
    configSnapshot?: RepoConfig | null;
    retryOfJobId?: string | null;
  }): Promise<PersistedReviewJob>;
  findExistingJobForHead(input: {
    owner: string;
    repo: string;
    prNumber: number;
    commitSha: string;
    trigger: 'auto' | 'mention';
  }): Promise<PersistedReviewJob | null>;

  updateJobCheckRun(jobId: string, checkRunId: number): Promise<void>;
  markJobCheckRunCompleted(jobId: string): Promise<void>;
  completePreparationStep(jobId: string, fileCount: number): Promise<void>;
  updateJobStep(jobId: string, stepName: string, update: {
    status: 'pending' | 'running' | 'done' | 'failed';
    startedAt?: string | null;
    finishedAt?: string | null;
    error?: string | null;
  }): Promise<void>;
  completeJob(jobId: string, input: {
    verdict: 'approve' | 'comment';
    fileCount: number;
    commentCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    summaryMarkdown: string;
    reviewId: number | null;
    summaryModel: string | null;
    overallConfidenceScore?: number | null;
    errorMessage?: string | null;
  }): Promise<void>;
  /**
   * Marks the job terminal. This is a MUST-NOT-LOSE write: it is what stops the queue redelivering
   * the job forever, and what makes it eligible for check-run reconciliation afterwards. An
   * implementation that can fail must fail loudly rather than silently no-op.
   */
  failJob(jobId: string, errorMessage: string): Promise<void>;
  /** Returns how many older jobs were superseded. Must not supersede `newJobId` itself. */
  supersedeOlderJobs(input: {
    installationId: string;
    owner: string;
    repo: string;
    prNumber: number;
    newJobId: string;
  }): Promise<number>;
}
