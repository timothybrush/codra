import type { AppBindings } from '@server/env';
import { reviewMaxFilesRange, type RepoConfig } from '@shared/schema';
import { filterReviewableFiles, parseUnifiedDiff, type FileDiff } from './diff';
import type { GitHubService } from '../services/github';
import { logger } from './logger';

const DIFF_CACHE_TTL_SECONDS = 6 * 60 * 60;

/**
 * KV-cached access to a job's raw diff. The two readers share one cache key, so they must stay
 * together: `getDiffFiles` serves the review phases and `getOrFetchRawDiffForCompletedJob` serves
 * the dashboard's diffs endpoint long after the job finished.
 */

export function diffCacheKey(jobId: string) {
  return `diff:${jobId}`;
}

/**
 * Returns the job's reviewable files, fetching and parsing the PR diff from
 * GitHub only once per job (cached in KV) instead of once per phase invocation.
 */
export async function getDiffFiles(
  env: AppBindings,
  job: { id: string; owner: string; repo: string; prNumber: number },
  github: Pick<GitHubService, 'getPullRequestDiff'>,
  config: RepoConfig,
  // Instance-wide file ceiling. Passed in rather than read here so a single settings lookup can
  // serve both this and the concurrency level in the same phase.
  maxFiles: number = reviewMaxFilesRange.default,
): Promise<{ files: FileDiff[]; skipped: number }> {
  const cacheKey = diffCacheKey(job.id);
  let rawDiff = await env.APP_KV.get(cacheKey);

  if (!rawDiff) {
    rawDiff = await github.getPullRequestDiff(job.owner, job.repo, job.prNumber);
    try {
      await env.APP_KV.put(cacheKey, rawDiff, { expirationTtl: DIFF_CACHE_TTL_SECONDS });
    } catch (error) {
      logger.warn(`Failed to cache PR diff for job ${job.id}; it will be re-fetched on the next phase`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  return filterReviewableFiles(parseUnifiedDiff(rawDiff, config.review), config.review, maxFiles);
}

/**
 * Reconstructs the raw PR diff for a job that has already finished, for the on-demand
 * "diff_input isn't stored in Postgres" reconstruction path (see /api/jobs/:id/diffs).
 * Reuses the same short-lived KV cache `getDiffFiles` writes during processing when it's
 * still warm (fast path, no GitHub call); once that 6h TTL has lapsed, re-derives the exact
 * same diff from GitHub via the job's own base/head commits (NOT the live PR diff, which may
 * have moved on since) and writes it back to the same cache key/TTL for subsequent requests.
 */
export async function getOrFetchRawDiffForCompletedJob(
  env: AppBindings,
  job: { id: string; owner: string; repo: string; baseSha: string; commitSha: string },
  github: Pick<GitHubService, 'getCompareDiff'>,
): Promise<string> {
  const cacheKey = diffCacheKey(job.id);
  const cached = await env.APP_KV.get(cacheKey);
  if (cached) return cached;

  const rawDiff = await github.getCompareDiff(job.owner, job.repo, job.baseSha, job.commitSha);
  try {
    await env.APP_KV.put(cacheKey, rawDiff, { expirationTtl: DIFF_CACHE_TTL_SECONDS });
  } catch (error) {
    logger.warn(`Failed to cache reconstructed diff for job ${job.id}`, error instanceof Error ? error : new Error(String(error)));
  }
  return rawDiff;
}
