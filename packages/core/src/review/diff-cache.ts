import { reviewMaxFilesRange, type RepoConfig } from '@codra/schema';
import { filterReviewableFiles, parseUnifiedDiff, type FileDiff } from '../diff';
import type { ReviewGitHub, ReviewRuntime } from '../ports';
import { logger } from '../logger';

const DIFF_CACHE_TTL_SECONDS = 6 * 60 * 60;

// KV-cached access to a job's raw diff. The two readers below share one cache key, so they must stay together.
export function diffCacheKey(jobId: string) {
  return `diff:${jobId}`;
}

// Fetches and parses the PR diff from GitHub only once per job (cached in KV) instead of once per phase invocation.
export async function getDiffFiles(
  env: Pick<ReviewRuntime, 'kv'>,
  job: { id: string; owner: string; repo: string; prNumber: number },
  github: Pick<ReviewGitHub, 'getPullRequestDiff'>,
  config: RepoConfig,
  // Passed in rather than read here so a single settings lookup can serve both this and the concurrency level in the same phase.
  maxFiles: number = reviewMaxFilesRange.default,
): Promise<{ files: FileDiff[]; skipped: number }> {
  const cacheKey = diffCacheKey(job.id);
  let rawDiff = await env.kv.get(cacheKey);

  if (!rawDiff) {
    rawDiff = await github.getPullRequestDiff(job.owner, job.repo, job.prNumber);
    try {
      await env.kv.put(cacheKey, rawDiff, { expirationTtl: DIFF_CACHE_TTL_SECONDS });
    } catch (error) {
      logger.warn(`Failed to cache PR diff for job ${job.id}; it will be re-fetched on the next phase`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  return filterReviewableFiles(parseUnifiedDiff(rawDiff, config.review), config.review, maxFiles);
}

// Reconstructs the raw PR diff for a finished job (diff_input isn't stored in Postgres; see /api/jobs/:id/diffs). Reuses getDiffFiles' KV cache while warm; once the 6h TTL lapses, re-derives from GitHub via the job's own base/head commits (not the live PR diff, which may have moved on) and rewrites the cache.
export async function getOrFetchRawDiffForCompletedJob(
  env: Pick<ReviewRuntime, 'kv'>,
  job: { id: string; owner: string; repo: string; baseSha: string; commitSha: string },
  github: Pick<ReviewGitHub, 'getCompareDiff'>,
): Promise<string> {
  const cacheKey = diffCacheKey(job.id);
  const cached = await env.kv.get(cacheKey);
  if (cached) return cached;

  const rawDiff = await github.getCompareDiff(job.owner, job.repo, job.baseSha, job.commitSha);
  try {
    await env.kv.put(cacheKey, rawDiff, { expirationTtl: DIFF_CACHE_TTL_SECONDS });
  } catch (error) {
    logger.warn(`Failed to cache reconstructed diff for job ${job.id}`, error instanceof Error ? error : new Error(String(error)));
  }
  return rawDiff;
}
