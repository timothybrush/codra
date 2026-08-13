
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
  line?: number;
  side?: 'LEFT' | 'RIGHT';
  position?: number;
  body: string;
};

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

export interface GitHubClientFactory {
  forInstallation(installationId: string): ReviewGitHub;
}
