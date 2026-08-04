import type { AppBindings } from '@server/env';
import { withTimeout } from '@server/core/timeout';
import { logger } from '@server/core/logger';
import { buildUnifiedDiffFromFiles, type GitHubDiffFileEntry } from '@server/core/diff';

const DIFF_FILES_PER_PAGE = 100;
/** See getPullRequestDiffFromFiles: each page costs a subrequest, and 500 files is the maxFiles ceiling. */
const MAX_DIFF_FILE_PAGES = 5;

export class GitHubError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/**
 * GitHub's unified-diff media type refuses any diff over 20,000 lines with 406 `too_large`.
 *
 * Matched narrowly on purpose: a 406 for any other reason, or any other status, must still surface as
 * a real failure rather than quietly taking the slower rebuild path.
 */
function isDiffTooLargeError(error: unknown): boolean {
  return error instanceof GitHubError
    && error.status === 406
    && /too_large|maximum number of lines/i.test(error.body ?? '');
}

async function withRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  maxRetries = 2,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error: any) {
      attempt++;
      const isSecondaryRateLimit = error instanceof GitHubError && 
        error.status === 403 && 
        error.body?.toLowerCase().includes('secondary rate limit');

      const isRetryable =
        isSecondaryRateLimit ||
        (error instanceof GitHubError && (error.status === 429 || error.status >= 500)) ||
        error.name === 'TimeoutError' ||
        error.message.includes('timeout');

      if (!isRetryable || attempt > maxRetries) {
        throw error;
      }

      const delay = isSecondaryRateLimit ? Math.pow(2, attempt) * 30000 : Math.pow(2, attempt) * 1000;
      logger.warn(`Retrying GitHub operation ${operation} (attempt ${attempt}/${maxRetries}) in ${delay}ms`, {
        status: error instanceof GitHubError ? error.status : undefined,
        error: error.message,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export type GitHubInstallation = {
  id: number;
};

export type GitHubRepository = {
  name: string;
  owner: {
    login: string;
  };
};

/** Default timeout for every GitHub API call (30 s). */
const GITHUB_TIMEOUT_MS = 30_000;
const GITHUB_APP_INSTALL_URL_CACHE_KEY = 'github:app_installation_url';
const GITHUB_REPOSITORIES_PER_PAGE = 100;
const GITHUB_REPOSITORY_PAGE_LIMIT = 100;

type InstallationTokenCacheRecord = {
  token: string;
  expiresAt: string;
};

type GitHubAppRecord = {
  html_url?: string;
  slug?: string;
};

type PullRequestRecord = {
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
  /**
   * Line number in the file to attach the comment to, paired with `side`. This is
   * the modern review-comment addressing scheme and the one the review pipeline
   * uses — the model reports file line numbers, never diff offsets.
   */
  line?: number;
  /** 'RIGHT' = the head (post-change) file, which is where findings live. */
  side?: 'LEFT' | 'RIGHT';
  /** Legacy diff-offset addressing. Kept for callers that already compute it. */
  position?: number;
  body: string;
};

type GitHubIssueLabel = {
  name?: string;
};

function installationCacheKey(installationId: string) {
  return `install:${installationId}`;
}

function normalizeGitHubAppSlug(slug: string | undefined) {
  const normalized = slug?.trim().replace(/\[bot\]$/i, '');
  return normalized || null;
}

function installUrlFromSlug(slug: string) {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

function encodeGitHubContentPath(path: string) {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function repoApiPath(owner: string, repo: string) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function pemToArrayBuffer(pem: string) {
  const base64 = pem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
    // Handle literal \n escape sequences (e.g. when the key is stored as a
    // single-line string with \n instead of real newlines in wrangler secrets)
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function base64UrlEncode(input: string) {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function createGitHubJwt(appId: string, privateKeyPem: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  );

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  const signatureString = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  return `${header}.${payload}.${signatureString}`;
}

async function readCachedInstallationToken(env: Pick<AppBindings, 'APP_KV'>, installationId: string, tracker?: { incrementSubrequests(count?: number): void }) {
  if (tracker) tracker.incrementSubrequests(1);
  const cached = await env.APP_KV.get(installationCacheKey(installationId), 'json');
  return cached as InstallationTokenCacheRecord | null;
}

async function writeCachedInstallationToken(
  env: Pick<AppBindings, 'APP_KV'>,
  installationId: string,
  record: InstallationTokenCacheRecord,
  tracker?: { incrementSubrequests(count?: number): void },
) {
  const expiresAt = new Date(record.expiresAt).getTime();
  const ttl = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000) - 300);
  if (tracker) tracker.incrementSubrequests(1);
  await env.APP_KV.put(installationCacheKey(installationId), JSON.stringify(record), { expirationTtl: ttl });
}

export class GitHubClient {
  constructor(
    private readonly env: Pick<
      AppBindings,
      'APP_KV' | 'APP_PRIVATE_KEY' | 'GITHUB_APP_ID' | 'BOT_USERNAME'
    >,
    private readonly installationId: string,
    private readonly tracker?: { incrementSubrequests(count?: number): void },
  ) {}

  // In-memory token cache scoped to this client instance (i.e. one Worker invocation). Without it,
  // every GitHub request re-read the token from KV -- a wasted subrequest per call. A finalize or
  // review invocation makes many GitHub calls, so that repeated KV read pushed the invocation toward
  // the Workers-Free 50-subrequest cap (finalize could tip over it right before posting the review).
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
      const jwt = await createGitHubJwt(this.env.GITHUB_APP_ID, this.env.APP_PRIVATE_KEY);

      const response = await withTimeout('GitHub installation token', GITHUB_TIMEOUT_MS, (signal) =>
        fetch(`https://api.github.com/app/installations/${this.installationId}/access_tokens`, {
          method: 'POST',
          signal,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${jwt}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': this.env.BOT_USERNAME ?? 'codra-bot',
          },
        }),
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new GitHubError(
          response.status,
          errText,
          '/app/installations/.../access_tokens',
          `GitHub installation token request failed with ${response.status}: ${errText}`,
        );
      }

      const data = (await response.json()) as { token: string; expires_at: string };
      const record: InstallationTokenCacheRecord = {
        token: data.token,
        expiresAt: data.expires_at,
      };
      await writeCachedInstallationToken(this.env, this.installationId, record, this.tracker);
      this.memoToken = record;

      return data.token;
    });
  }

  static async listInstallations(
    env: Pick<AppBindings, 'APP_PRIVATE_KEY' | 'GITHUB_APP_ID' | 'BOT_USERNAME'>,
  ): Promise<GitHubInstallation[]> {
    return withRetry('listInstallations', async () => {
      const jwt = await createGitHubJwt(env.GITHUB_APP_ID, env.APP_PRIVATE_KEY);
      const response = await withTimeout('GitHub list installations', GITHUB_TIMEOUT_MS, (signal) =>
        fetch('https://api.github.com/app/installations', {
          signal,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${jwt}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': env.BOT_USERNAME ?? 'codra-bot',
          },
        }),
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new GitHubError(
          response.status,
          errText,
          '/app/installations',
          `GitHub list installations failed with ${response.status}: ${errText}`,
        );
      }

      return (await response.json()) as GitHubInstallation[];
    });
  }

  static async getAppInstallationUrl(
    env: Pick<AppBindings, 'APP_KV' | 'APP_PRIVATE_KEY' | 'GITHUB_APP_ID' | 'BOT_USERNAME' | 'GITHUB_APP_SLUG'>,
  ): Promise<string> {
    const configuredSlug = normalizeGitHubAppSlug(env.GITHUB_APP_SLUG);
    if (configuredSlug) {
      return installUrlFromSlug(configuredSlug);
    }

    const cached = await env.APP_KV.get(GITHUB_APP_INSTALL_URL_CACHE_KEY);
    if (cached) {
      return cached;
    }

    return withRetry('getAppInstallationUrl', async () => {
      const jwt = await createGitHubJwt(env.GITHUB_APP_ID, env.APP_PRIVATE_KEY);
      const response = await withTimeout('GitHub app lookup', GITHUB_TIMEOUT_MS, (signal) =>
        fetch('https://api.github.com/app', {
          signal,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${jwt}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': env.BOT_USERNAME ?? 'codra-bot',
          },
        }),
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new GitHubError(
          response.status,
          errText,
          '/app',
          `GitHub app lookup failed with ${response.status}: ${errText}`,
        );
      }

      const app = (await response.json()) as GitHubAppRecord;
      const fallbackSlug = normalizeGitHubAppSlug(app.slug);
      const installUrl = app.html_url
        ? `${app.html_url.replace(/\/$/, '')}/installations/new`
        : fallbackSlug
          ? installUrlFromSlug(fallbackSlug)
          : null;

      if (!installUrl) {
        throw new Error('GitHub app lookup did not return a usable app URL.');
      }

      await env.APP_KV.put(GITHUB_APP_INSTALL_URL_CACHE_KEY, installUrl, { expirationTtl: 60 * 60 * 24 });
      return installUrl;
    });
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

  /** Single GraphQL call against api.github.com/graphql with the installation token. */
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
    try {
      return await withRetry(`getPullRequestDiff ${owner}/${repo}#${pullNumber}`, async () => {
        const response = await this.requestAndCheck(
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
      return this.getPullRequestDiffFromFiles(owner, repo, pullNumber);
    }
  }

  /**
   * Rebuilds a pull request's diff from `GET /pulls/{n}/files`.
   *
   * The `application/vnd.github.v3.diff` media type is capped at 20,000 lines server-side and answers
   * 406 `too_large` beyond it. That is permanent for the pull request, not transient -- `withRetry`
   * correctly declines to retry it -- so without this fallback a large PR simply cannot be reviewed.
   */
  private async getPullRequestDiffFromFiles(owner: string, repo: string, pullNumber: number) {
    const files: GitHubDiffFileEntry[] = [];

    // Bounded because each page is a subrequest against an invocation budget of ~25, and this runs
    // before the per-file chunking that would otherwise get to spend it. 5 pages covers 500 files,
    // which is the ceiling `maxFiles` itself allows, so the cap can only bite on a PR that is already
    // far past what would be reviewed.
    for (let page = 1; page <= MAX_DIFF_FILE_PAGES; page++) {
      const pageFiles = await withRetry(`getPullRequestFiles ${owner}/${repo}#${pullNumber} p${page}`, async () => {
        const response = await this.requestAndCheck(
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

  /**
   * Diff between two specific commits (not "current PR state"), so it stays correct
   * even after the PR has moved on, merged, or closed. Used to reconstruct a past
   * job's diff on demand once its short-lived KV cache has expired.
   */
  async getCompareDiff(owner: string, repo: string, base: string, head: string) {
    const comparePath = `${repoApiPath(owner, repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    try {
      return await withRetry(`getCompareDiff ${owner}/${repo} ${base}...${head}`, async () => {
        const response = await this.requestAndCheck(comparePath, {}, 'application/vnd.github.v3.diff');
        return response.text();
      });
    } catch (error) {
      if (!isDiffTooLargeError(error)) throw error;
      // Same 20,000-line cap. Note the compare endpoint returns at most 300 files and does NOT
      // paginate them, so this is best-effort -- it backs the dashboard's diff view, where a partial
      // reconstruction beats an error page.
      logger.warn(`Compare diff ${owner}/${repo} ${base}...${head} is over the line cap; rebuilding from the JSON file list`);
      return withRetry(`getCompareFiles ${owner}/${repo} ${base}...${head}`, async () => {
        const response = await this.requestAndCheck(comparePath);
        const payload = (await response.json()) as { files?: GitHubDiffFileEntry[] };
        return buildUnifiedDiffFromFiles(payload.files ?? []);
      });
    }
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
    return withRetry(`createReview ${owner}/${repo}#${pullNumber}`, async () => {
      // Address each comment by `line` + `side` (the file line the model reported),
      // falling back to a legacy diff `position` if a caller supplied one. Before
      // this, comments were kept ONLY when they had `position` — which nothing ever
      // computed — so every inline comment was silently dropped and reviews posted
      // with just the summary body.
      const mapped = input.comments.map((comment) => {
        if (typeof comment.line === 'number' && comment.line > 0) {
          return {
            path: comment.path,
            line: comment.line,
            side: comment.side ?? 'RIGHT',
            body: comment.body,
          };
        }
        if (typeof comment.position === 'number' && comment.position > 0) {
          return { path: comment.path, position: comment.position, body: comment.body };
        }
        return null;
      });

      // Track which of the caller's comments survived mapping. Only the caller knows what a
      // comment *means*, and it needs to know exactly which ones GitHub received -- marking a
      // finding as "posted" when it was silently dropped here would suppress it on every future
      // commit without it ever having been shown to anyone.
      let postedIndices = mapped.flatMap((c, index) => (c === null ? [] : [index]));

      const comments = mapped.filter((c): c is NonNullable<typeof c> => c !== null);
      const unaddressable = mapped.length - comments.length;
      if (unaddressable > 0) {
        logger.warn('Dropping review comments with no usable line/position', {
          owner,
          repo,
          pullNumber,
          unaddressable,
          total: mapped.length,
        });
      }

      const body = {
        commit_id: input.commitSha,
        event: input.event,
        body: input.body,
        comments,
      };

      const reviewPath = `${repoApiPath(owner, repo)}/pulls/${pullNumber}/reviews`;
      let response = await this.request(reviewPath, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (response.status === 422 && body.comments.length > 0) {
        // Log GitHub's reason: a 422 here almost always means a comment pointed at a
        // line that isn't part of the diff. Without the response text this failure
        // is invisible and the review silently loses every inline comment.
        const reason = await response.clone().text().catch(() => '<unreadable>');
        logger.warn(`GitHub review creation failed with 422, retrying without inline comments`, {
          owner,
          repo,
          pullNumber,
          droppedComments: body.comments.length,
          reason: reason.slice(0, 500),
        });
        response = await this.request(reviewPath, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            commit_id: input.commitSha,
            event: input.event,
            body: input.body,
            comments: [],
          }),
        });
        // The summary still posts, but not a single inline comment did.
        postedIndices = [];
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new GitHubError(
          response.status,
          errText,
          reviewPath,
          `GitHub review creation failed with ${response.status}: ${errText}`,
        );
      }

      const review = (await response.json()) as { id: number };
      return { id: review.id, postedIndices };
    });
  }

  // Returns a review this app already posted on the given commit, if one exists. Used by finalize
  // ONLY when re-running after a prior attempt reached the posting stage, to avoid double-posting a
  // review when the earlier invocation died in the narrow window between createReview() succeeding
  // and completeJob() recording the review id (e.g. a subrequest-budget error). One GET, first page
  // of 100 -- enough for the guard on any realistic PR (a PR with >100 reviews is pathological).
  async findBotReviewForCommit(
    owner: string,
    repo: string,
    pullNumber: number,
    commitSha: string,
    botLogin: string,
  ): Promise<{ id: number } | null> {
    return withRetry(`findBotReviewForCommit ${owner}/${repo}#${pullNumber}`, async () => {
      const response = await this.requestAndCheck(
        `${repoApiPath(owner, repo)}/pulls/${pullNumber}/reviews?per_page=100`,
      );
      const reviews = (await response.json()) as Array<{
        id: number;
        commit_id?: string | null;
        user?: { login?: string | null } | null;
      }>;
      const login = botLogin.toLowerCase();
      const match = reviews.find(
        (review) =>
          review.commit_id === commitSha &&
          (review.user?.login ?? '').toLowerCase().startsWith(login),
      );
      return match ? { id: match.id } : null;
    });
  }

  async ensureLabel(owner: string, repo: string, name: string, color: string) {
    return withRetry(`ensureLabel ${owner}/${repo} ${name}`, async () => {
      const listResponse = await this.request(`${repoApiPath(owner, repo)}/labels/${encodeURIComponent(name)}`);
      if (listResponse.ok) {
        return;
      }
      if (listResponse.status !== 404) {
        const errText = await listResponse.text();
        throw new GitHubError(
          listResponse.status,
          errText,
          name,
          `GitHub label lookup failed with ${listResponse.status}: ${errText}`,
        );
      }

      const createResponse = await this.request(`${repoApiPath(owner, repo)}/labels`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name, color }),
      });

      if (!createResponse.ok && createResponse.status !== 422) {
        const errText = await createResponse.text();
        throw new GitHubError(
          createResponse.status,
          errText,
          name,
          `GitHub label creation failed with ${createResponse.status}: ${errText}`,
        );
      }
    });
  }

  async addIssueLabels(owner: string, repo: string, issueNumber: number, labels: string[]) {
    return withRetry(`addIssueLabels ${owner}/${repo}#${issueNumber}`, async () => {
      await this.requestAndCheck(`${repoApiPath(owner, repo)}/issues/${issueNumber}/labels`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ labels }),
      });
    });
  }

  async listIssueLabels(owner: string, repo: string, issueNumber: number) {
    return withRetry(`listIssueLabels ${owner}/${repo}#${issueNumber}`, async () => {
      const response = await this.requestAndCheck(`${repoApiPath(owner, repo)}/issues/${issueNumber}/labels?per_page=100`);
      const labels = await response.json();
      if (!Array.isArray(labels)) {
        throw new Error('Expected an array of labels from GitHub API.');
      }
      return labels
        .map((label: GitHubIssueLabel) => label.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
    });
  }

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
    return withRetry(`removeIssueLabel ${owner}/${repo}#${issueNumber} ${label}`, async () => {
      const response = await this.request(
        `${repoApiPath(owner, repo)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
        {
          method: 'DELETE',
        },
      );

      if (!response.ok && response.status !== 404) {
        const errText = await response.text();
        throw new GitHubError(
          response.status,
          errText,
          label,
          `GitHub label removal failed with ${response.status}: ${errText}`,
        );
      }
    });
  }
}
