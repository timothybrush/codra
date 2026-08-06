import { logger } from '@server/core/logger';
import { buildUnifiedDiffFromFiles, type GitHubDiffFileEntry } from '@server/core/diff';
import {
  type GitHubRequestContext,
  isDiffTooLargeError,
  repoApiPath,
  withRetry,
} from './http';

// Sibling of core/github.ts -- import from that barrel, not from here. Free functions over a
// GitHubRequestContext rather than methods, so the class stays the mockable seam.

const DIFF_FILES_PER_PAGE = 100;
// See fetchPullRequestDiffFromFiles: each page costs a subrequest, and 500 files is the maxFiles ceiling.
const MAX_DIFF_FILE_PAGES = 5;

// Rebuilds a pull request's diff from `GET /pulls/{n}/files`. The diff media type is capped at
// 20,000 lines and answers 406 `too_large` beyond it, permanently rather than transiently, so
// without this fallback a large PR simply cannot be reviewed.
async function fetchPullRequestDiffFromFiles(
  ctx: GitHubRequestContext,
  owner: string,
  repo: string,
  pullNumber: number,
) {
  const files: GitHubDiffFileEntry[] = [];

  // Bounded because each page is a subrequest against a budget of ~25. Five pages covers 500
  // files, the ceiling `maxFiles` allows, so the cap only bites on a PR already past reviewing.
  for (let page = 1; page <= MAX_DIFF_FILE_PAGES; page++) {
    const pageFiles = await withRetry(`getPullRequestFiles ${owner}/${repo}#${pullNumber} p${page}`, async () => {
      const response = await ctx.requestAndCheck(
        `${repoApiPath(owner, repo)}/pulls/${pullNumber}/files?per_page=${DIFF_FILES_PER_PAGE}&page=${page}`,
      );
      return (await response.json()) as GitHubDiffFileEntry[];
    });

    files.push(...pageFiles);
    if (pageFiles.length < DIFF_FILES_PER_PAGE) break;

    if (page === MAX_DIFF_FILE_PAGES) {
      logger.warn(
        `Stopped rebuilding the diff for ${owner}/${repo}#${pullNumber} at ${files.length} files; later files are not reviewed`,
      );
    }
  }

  return buildUnifiedDiffFromFiles(files);
}

export async function fetchPullRequestDiff(
  ctx: GitHubRequestContext,
  owner: string,
  repo: string,
  pullNumber: number,
) {
  try {
    return await withRetry(`getPullRequestDiff ${owner}/${repo}#${pullNumber}`, async () => {
      const response = await ctx.requestAndCheck(
        `${repoApiPath(owner, repo)}/pulls/${pullNumber}`,
        {},
        'application/vnd.github.v3.diff',
      );
      return response.text();
    });
  } catch (error) {
    if (!isDiffTooLargeError(error)) throw error;
    logger.warn(
      `Diff for ${owner}/${repo}#${pullNumber} exceeds GitHub's 20,000-line media-type cap; rebuilding it from the per-file endpoint`,
    );
    return fetchPullRequestDiffFromFiles(ctx, owner, repo, pullNumber);
  }
}

// Diff between two specific commits, not "current PR state", so it stays correct after the PR has
// moved on. Used to reconstruct a past job's diff once its KV cache has expired.
export async function fetchCompareDiff(
  ctx: GitHubRequestContext,
  owner: string,
  repo: string,
  base: string,
  head: string,
) {
  const comparePath = `${repoApiPath(owner, repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  try {
    return await withRetry(`getCompareDiff ${owner}/${repo} ${base}...${head}`, async () => {
      const response = await ctx.requestAndCheck(comparePath, {}, 'application/vnd.github.v3.diff');
      return response.text();
    });
  } catch (error) {
    if (!isDiffTooLargeError(error)) throw error;
    // Same 20,000-line cap. Note the compare endpoint returns at most 300 files and does NOT
    // paginate them, so this is best-effort -- it backs the dashboard's diff view, where a partial
    // reconstruction beats an error page.
    logger.warn(`Compare diff ${owner}/${repo} ${base}...${head} is over the line cap; rebuilding from the JSON file list`);
    return withRetry(`getCompareFiles ${owner}/${repo} ${base}...${head}`, async () => {
      const response = await ctx.requestAndCheck(comparePath);
      const payload = (await response.json()) as { files?: GitHubDiffFileEntry[] };
      return buildUnifiedDiffFromFiles(payload.files ?? []);
    });
  }
}
