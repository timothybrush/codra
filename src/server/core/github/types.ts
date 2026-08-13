// Both of these are part of the git-provider PORT contract, so @codra/core/ports owns them and
// this module re-exports: one definition, and the engine does not depend on this file.
export type { GitHubReviewComment, PullRequestRecord } from '@codra/core/ports';

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


export type InstallationTokenCacheRecord = {
  token: string;
  expiresAt: string;
};

export type GitHubAppRecord = {
  html_url?: string;
  slug?: string;
};


export type GitHubIssueLabel = {
  name?: string;
};
