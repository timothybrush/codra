import { logger } from '../logger';
import { defaultRepoConfig, type RepoConfig } from '@shared/schema';
import type { AppBindings } from '@server/env';
import {
  completePreparationStep,
  heartbeatJobLease,
  setJobPullRequestMeta,
  updateJobCheckRun,
  updateJobStep,
} from '@server/db/jobs';
import { getDiffFiles } from './diff-cache';
import { getRejectedExemplars, getRepositoryIdForJob } from '@server/db/learning';
import type { RejectedExemplar } from '@server/prompts/file-review';
import { GitHubService } from '../../services/github';
import { getReviewSettings } from '@server/db/app-settings';
import { type PersistedReviewJob, JOB_LEASE_SECONDS, enqueueJobPhase } from './phase-control';
// Sibling of core/review.ts -- import from that barrel, not from here. Several specs mock that
// specifier, and workflows/review.ts imports only runReviewJob from it.
//
// The prepare phase: fetch the PR, snapshot config, count files.

export async function runPreparePhase(
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

// Negative few-shot exemplars for this repository. Best-effort, and per chunk so it costs one query
// rather than one per file.
export async function loadRejectedExemplars(env: AppBindings, job: PersistedReviewJob): Promise<RejectedExemplar[]> {
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
