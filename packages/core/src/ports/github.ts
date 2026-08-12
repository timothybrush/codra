// The git-provider port. Named for what the engine needs, not for GitHub's API: the ten methods here
// are the entire surface the review engine touches, out of a much larger service. A second provider
// implements these ten and nothing else.
//
// The two record types are owned here and re-exported by src/server/core/github/types.ts, so there is
// exactly one definition of each.

export type PullRequestRecord = {
  number: number;
  title: string | null;
  body: string | null;
  draft: boolean;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  user: { login: string };
};

export type GitHubReviewComment = {
  path: string;
  // File line to attach the comment to, paired with `side`. The model reports file lines, never diff offsets.
  line?: number;
  // 'RIGHT' = the head (post-change) file, which is where findings live.
  side?: 'LEFT' | 'RIGHT';
  // Legacy diff-offset addressing. Kept for callers that already compute it.
  position?: number;
  body: string;
};

/**
 * Reads a pull request's contents and writes the review back.
 *
 * Retry-safety is NOT uniform here, and callers depend on knowing which is which:
 *  - `getPullRequest`, `getPullRequestDiff`, `getCompareDiff` are pure reads and freely retryable.
 *    `getCompareDiff` must resolve the diff for the two commits GIVEN, not the current head, because
 *    its caller reconstructs a finished job's diff after the pull request has moved on.
 *  - `createCheckRun` is not idempotent; the caller stores the returned id and passes it to
 *    `updateCheckRun` thereafter. `updateCheckRun` IS idempotent and may be called repeatedly,
 *    including to re-complete an already-completed run.
 *  - `createReview` is NOT retry-safe: it posts. A caller that may have already posted must first ask
 *    `findBotReviewForCommit` and reuse what it finds. It must return `postedIndices` naming which of
 *    the submitted comments were actually accepted -- when the provider rejects inline comments and
 *    the review falls back to a body-only post, that list is empty, and reporting all of them as
 *    posted would suppress those findings forever.
 *  - `findBotReviewForCommit` must scope to the given commit sha AND bot login, and return null
 *    rather than throwing when there is none.
 *  - `ensureLabel`, `addIssueLabels`, `removeIssueLabelsIfPresent` are idempotent. Removing a label
 *    that is absent must succeed, not 404.
 * Every method may throw; the engine classifies transient failures and reschedules.
 */
export interface ReviewGitHub {
  getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestRecord>;
  getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string>;
  getCompareDiff(owner: string, repo: string, base: string, head: string): Promise<string>;
  createCheckRun(owner: string, repo: string, params: { headSha: string; title: string; summary: string }): Promise<{ id: number }>;
  updateCheckRun(owner: string, repo: string, checkRunId: number, params: {
    title: string;
    summary: string;
    status?: 'in_progress' | 'completed';
    conclusion?: 'success' | 'neutral' | 'failure' | 'cancelled';
  }): Promise<unknown>;
  createReview(owner: string, repo: string, prNumber: number, params: {
    commitSha: string;
    event: 'APPROVE' | 'COMMENT';
    body: string;
    comments: GitHubReviewComment[];
  }): Promise<{ id: number; postedIndices?: number[] }>;
  findBotReviewForCommit(owner: string, repo: string, prNumber: number, commitSha: string, botLogin: string): Promise<{ id: number } | null>;
  ensureLabel(owner: string, repo: string, name: string, color: string): Promise<unknown>;
  addIssueLabels(owner: string, repo: string, prNumber: number, labels: string[]): Promise<unknown>;
  removeIssueLabelsIfPresent(owner: string, repo: string, prNumber: number, labels: string[]): Promise<unknown>;
}

/**
 * Builds a provider client for an installation whose job row does not exist yet.
 *
 * Needed because webhook resolution -- label cleanup on a closed pull request, and looking up the
 * pull request behind an issue comment -- happens before any job is inserted, so there is no job to
 * take the installation id from. A correct implementation must be cheap enough to call per webhook
 * and must not perform I/O until one of the returned methods is called.
 */
export interface GitHubClientFactory {
  forInstallation(installationId: string): ReviewGitHub;
}
