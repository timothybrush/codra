import type { AppBindings } from '@server/env';
import { withTimeout } from '@server/core/timeout';
import {
  GitHubError,
  GITHUB_TIMEOUT_MS,
  type GitHubRequestContext,
  encodeGitHubContentPath,
  repoApiPath,
  withRetry,
} from './http';
import {
  fetchAppInstallationUrl,
  fetchInstallationToken,
  fetchInstallations,
  readCachedInstallationToken,
  writeCachedInstallationToken,
} from './app-auth';
import { fetchCompareDiff, fetchPullRequestDiff } from './diff-fetch';
import { findBotReviewForCommit, postReview } from './review-post';
import { addIssueLabels, ensureLabel, listIssueLabels, removeIssueLabel } from './labels';
import type {
  GitHubInstallation,
  GitHubRepository,
  GitHubReviewComment,
  InstallationTokenCacheRecord,
  PullRequestRecord,
} from './types';

// This module is the mock seam: a spec replaces the whole GitHubClient class via
// vi.mock('@server/core/github', ...). The sibling modules in this folder are implementation detail --
// everything else must import from here, and eslint's no-restricted-imports enforces that.
export type { GitHubInstallation, GitHubRepository, GitHubReviewComment };
// Re-exported because it is the error every method below throws: without it on the barrel there is no
// legal way for a caller to write `instanceof GitHubError`, since ./http is a restricted sibling.
export { GitHubError };

const GITHUB_REPOSITORIES_PER_PAGE = 100;
const GITHUB_REPOSITORY_PAGE_LIMIT = 100;

export class GitHubClient {
  constructor(
    private readonly env: Pick<
      AppBindings,
      'APP_KV' | 'APP_PRIVATE_KEY' | 'GITHUB_APP_ID' | 'BOT_USERNAME'
    >,
    private readonly installationId: string,
    private readonly tracker?: { incrementSubrequests(count?: number): void },
  ) {}

  // Token cache scoped to this client (one Worker invocation). Without it every GitHub request
  // re-read the token from KV, a wasted subrequest per call, which pushed finalize toward the
  // 50-subrequest cap right before posting.
  private memoToken: InstallationTokenCacheRecord | null = null;

  async getInstallationToken(): Promise<string> {
    // Reuse the in-memory token while it's comfortably unexpired (invocations are < ~120s; tokens
    // last ~1h, so this holds for the whole invocation) -- no KV read, no network call.
    if (this.memoToken?.token && new Date(this.memoToken.expiresAt).getTime() > Date.now() + 60_000) {
      return this.memoToken.token;
    }

    const cached = await readCachedInstallationToken(this.env, this.installationId, this.tracker);
    if (cached?.token) {
      this.memoToken = cached;
      return cached.token;
    }

    return withRetry('getInstallationToken', async () => {
      const record = await fetchInstallationToken(this.env, this.installationId);
      await writeCachedInstallationToken(this.env, this.installationId, record, this.tracker);
      this.memoToken = record;

      return record.token;
    });
  }

  static async listInstallations(
    env: Pick<AppBindings, 'APP_PRIVATE_KEY' | 'GITHUB_APP_ID' | 'BOT_USERNAME'>,
  ): Promise<GitHubInstallation[]> {
    return fetchInstallations(env);
  }

  static async getAppInstallationUrl(
    env: Pick<AppBindings, 'APP_KV' | 'APP_PRIVATE_KEY' | 'GITHUB_APP_ID' | 'BOT_USERNAME' | 'GITHUB_APP_SLUG'>,
  ): Promise<string> {
    return fetchAppInstallationUrl(env);
  }

  async listRepositories(): Promise<GitHubRepository[]> {
    return withRetry('listRepositories', async () => {
      const repositories: GitHubRepository[] = [];

      for (let page = 1; page <= GITHUB_REPOSITORY_PAGE_LIMIT; page += 1) {
        const response = await this.requestAndCheck(`/installation/repositories?per_page=${GITHUB_REPOSITORIES_PER_PAGE}&page=${page}`);
        const data = (await response.json()) as { repositories: GitHubRepository[] };
        repositories.push(...data.repositories);

        if (data.repositories.length < GITHUB_REPOSITORIES_PER_PAGE) {
          return repositories;
        }
      }

      throw new Error(
        `GitHub repository listing exceeded ${GITHUB_REPOSITORY_PAGE_LIMIT} pages without a terminating page.`,
      );
    });
  }

  private async request(
    path: string,
    init: RequestInit = {},
    accept = 'application/vnd.github+json',
  ): Promise<Response> {
    const token = await this.getInstallationToken();

    if (this.tracker) this.tracker.incrementSubrequests(1);
    return withTimeout(`GitHub ${init.method ?? 'GET'} ${path}`, GITHUB_TIMEOUT_MS, (signal) =>
      fetch(`https://api.github.com${path}`, {
        ...init,
        signal,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': this.env.BOT_USERNAME ?? 'codra-bot',
          ...init.headers,
        },
      }),
    );
  }

  private async requestAndCheck(
    path: string,
    init: RequestInit = {},
    accept = 'application/vnd.github+json',
  ): Promise<Response> {
    const response = await this.request(path, init, accept);
    if (!response.ok) {
      const errText = await response.text();
      throw new GitHubError(
        response.status,
        errText,
        path,
        `GitHub API ${init.method ?? 'GET'} ${path} failed with ${response.status}: ${errText}`,
      );
    }
    return response;
  }

  // Hands the extracted helpers the authenticated-request surface without making `request` /
  // `requestAndCheck` public. Built per call; it holds no state of its own.
  private ctx(): GitHubRequestContext {
    return {
      request: (path, init, accept) => this.request(path, init, accept),
      requestAndCheck: (path, init, accept) => this.requestAndCheck(path, init, accept),
    };
  }

  // Single GraphQL call against api.github.com/graphql with the installation token.
  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    return withRetry('graphql', async () => {
      const token = await this.getInstallationToken();

      if (this.tracker) this.tracker.incrementSubrequests(1);
      const response = await withTimeout('GitHub GraphQL', GITHUB_TIMEOUT_MS, (signal) =>
        fetch('https://api.github.com/graphql', {
          method: 'POST',
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': this.env.BOT_USERNAME ?? 'codra-bot',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
        }),
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new GitHubError(
          response.status,
          errText,
          '/graphql',
          `GitHub GraphQL request failed with ${response.status}: ${errText}`,
        );
      }

      const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (payload.errors?.length) {
        throw new GitHubError(
          422,
          JSON.stringify(payload.errors),
          '/graphql',
          `GitHub GraphQL error: ${payload.errors[0].message}`,
        );
      }
      return payload.data as T;
    });
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number) {
    return withRetry(`getPullRequest ${owner}/${repo}#${pullNumber}`, async () => {
      const response = await this.requestAndCheck(`${repoApiPath(owner, repo)}/pulls/${pullNumber}`);
      return (await response.json()) as PullRequestRecord;
    });
  }

  async getPullRequestDiff(owner: string, repo: string, pullNumber: number) {
    return fetchPullRequestDiff(this.ctx(), owner, repo, pullNumber);
  }

  async getCompareDiff(owner: string, repo: string, base: string, head: string) {
    return fetchCompareDiff(this.ctx(), owner, repo, base, head);
  }

  async getRepoFileOrNull(owner: string, repo: string, path: string) {
    return withRetry(`getRepoFileOrNull ${owner}/${repo}/${path}`, async () => {
      const response = await this.request(`${repoApiPath(owner, repo)}/contents/${encodeGitHubContentPath(path)}`);
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        const errText = await response.text();
        throw new GitHubError(
          response.status,
          errText,
          path,
          `GitHub repo file fetch failed with ${response.status}: ${errText}`,
        );
      }

      const data = (await response.json()) as { content?: string; encoding?: string };
      if (!data.content) {
        return null;
      }

      return data.encoding === 'base64' ? atob(data.content.replace(/\n/g, '')) : data.content;
    });
  }

  async createCheckRun(
    owner: string,
    repo: string,
    input: { headSha: string; title: string; summary: string; detailsUrl?: string },
  ) {
    return withRetry(`createCheckRun ${owner}/${repo}`, async () => {
      const response = await this.requestAndCheck(`${repoApiPath(owner, repo)}/check-runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Codra',
          head_sha: input.headSha,
          status: 'in_progress',
          details_url: input.detailsUrl,
          output: {
            title: input.title,
            summary: input.summary,
          },
        }),
      });

      return (await response.json()) as { id: number };
    });
  }

  async updateCheckRun(
    owner: string,
    repo: string,
    checkRunId: number,
    input: {
      title: string;
      summary: string;
      status?: 'in_progress' | 'completed';
      conclusion?: 'success' | 'neutral' | 'failure' | 'cancelled';
    },
  ) {
    return withRetry(`updateCheckRun ${owner}/${repo} ${checkRunId}`, async () => {
      await this.requestAndCheck(`${repoApiPath(owner, repo)}/check-runs/${checkRunId}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          status: input.status ?? 'in_progress',
          conclusion: input.conclusion,
          completed_at: input.status === 'completed' ? new Date().toISOString() : undefined,
          output: {
            title: input.title,
            summary: input.summary,
          },
        }),
      });
    });
  }

  async createReview(
    owner: string,
    repo: string,
    pullNumber: number,
    input: {
      commitSha: string;
      event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
      body: string;
      comments: GitHubReviewComment[];
    },
  ) {
    return postReview(this.ctx(), owner, repo, pullNumber, input);
  }

  async findBotReviewForCommit(
    owner: string,
    repo: string,
    pullNumber: number,
    commitSha: string,
    botLogin: string,
  ): Promise<{ id: number } | null> {
    return findBotReviewForCommit(this.ctx(), owner, repo, pullNumber, commitSha, botLogin);
  }

  async ensureLabel(owner: string, repo: string, name: string, color: string) {
    return ensureLabel(this.ctx(), owner, repo, name, color);
  }

  async addIssueLabels(owner: string, repo: string, issueNumber: number, labels: string[]) {
    return addIssueLabels(this.ctx(), owner, repo, issueNumber, labels);
  }

  async listIssueLabels(owner: string, repo: string, issueNumber: number) {
    return listIssueLabels(this.ctx(), owner, repo, issueNumber);
  }

  // Case-insensitive, and removes using the label's ACTUAL casing as GitHub stores it -- the delete
  // endpoint is case-sensitive, so passing the caller's spelling would silently no-op on a 404.
  async removeIssueLabelsIfPresent(owner: string, repo: string, issueNumber: number, labels: string[]) {
    const currentLabels = await this.listIssueLabels(owner, repo, issueNumber);
    const currentByLowerName = new Map(currentLabels.map(label => [label.toLowerCase(), label]));

    const uniqueLabels = Array.from(new Set(labels.map(label => label.toLowerCase())));
    for (const label of uniqueLabels) {
      const currentLabel = currentByLowerName.get(label);
      if (currentLabel) {
        await this.removeIssueLabel(owner, repo, issueNumber, currentLabel);
      }
    }
  }

  async removeIssueLabel(owner: string, repo: string, issueNumber: number, label: string) {
    return removeIssueLabel(this.ctx(), owner, repo, issueNumber, label);
  }
}
