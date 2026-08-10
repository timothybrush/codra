// Response shapes from the GitHub REST API, narrowed to the fields this app reads.
// Import these from @server/core/github, not from here: specs mock that barrel by replacing the whole GitHubClient class.

export type GitHubInstallation = {
  id: number;
};

export type GitHubRepository = {
  name: string;
  owner: {
    login: string;
  };
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

export type InstallationTokenCacheRecord = {
  token: string;
  expiresAt: string;
};

export type GitHubAppRecord = {
  html_url?: string;
  slug?: string;
};

export type PullRequestRecord = {
  number: number;
  title: string | null;
  body: string | null;
  draft: boolean;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  user: { login: string };
};

export type GitHubIssueLabel = {
  name?: string;
};
