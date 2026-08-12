import { createApp } from '@server/app';
import { getJobForProcessing, insertJob } from '@server/db/jobs';

import { getRepoConfigRecord } from '@server/db/repo-configs';
import { loadRepoConfig, updateGlobalConfig } from '@server/core/config';
import { GitHubClient } from '@server/core/github';

import { defaultRepoConfig } from '@codra/schema';
import type { RepoConfigsResponse } from '@codra/schema/api';
import { createTestEnv, uniqueName } from '../helpers';
import { vi } from 'vitest';

// `githubUserId` is parameterised so a test that mutates the persisted
// account_settings row (display name, timezone) can use its own id and not leak
// into tests asserting a pristine record; the tests share one database.
function mockGitHubProfile(login = 'devarshishimpi', githubUserId = 42) {
  return {
    id: githubUserId,
    login,
    name: 'Devarshi Shimpi',
    avatar_url: `https://avatars.githubusercontent.com/u/${githubUserId}`,
    email: null,
  };
}

describe('Dashboard API: repositories and repo config', () => {
  const app = createApp();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function getAuthCookie(env = createTestEnv(), login = 'devarshishimpi', githubUserId = 42) {
    const originalFetch = globalThis.fetch;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);

      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'oauth-access-token' });
      }

      if (url === 'https://api.github.com/user') {
        return Response.json(mockGitHubProfile(login, githubUserId));
      }

      return originalFetch(input, init);
    });

    const authStart = await app.request('/auth/github', {}, env);
    const authLocation = authStart.headers.get('location');
    expect(authStart.status).toBe(302);
    expect(authLocation).toBeTruthy();

    const state = authLocation ? new URL(authLocation).searchParams.get('state') : null;
    expect(state).toBeTruthy();

    const callback = await app.request(`/auth/github/callback?code=test-code&state=${state}`, {}, env);
    const cookieHeader = callback.headers.get('set-cookie') || '';
    const match = cookieHeader.match(/codra_session=([^;]+)/);

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/dashboard');

    return match ? match[1] : '';
  }

  it('returns repository list', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/repos', {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as RepoConfigsResponse;
    expect(Array.isArray(data.repos)).toBe(true);
  });

  it('redirects Manage Access to the configured GitHub App install page', async () => {
    const env = createTestEnv({ GITHUB_APP_SLUG: 'my-codra-install' });
    const token = await getAuthCookie(env);

    const response = await app.request('/api/repos/install', {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://github.com/apps/my-codra-install/installations/new');
  });

  it('rejects invalid repository config patches', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = uniqueName('invalid-config');

    await loadRepoConfig(env, {
      installationId: '123',
      owner: 'api-test-owner',
      repo,
    });

    const response = await app.request(`/api/repos/api-test-owner/${repo}/config`, {
      method: 'PATCH',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        review: {
          // Below reviewConfigSchema's minimum of 1.
          max_comments: 0,
        },
      }),
    }, env);

    expect(response.status).toBe(400);
  });

  it('rejects string booleans in repository config patches', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = uniqueName('invalid-enabled');

    await loadRepoConfig(env, {
      installationId: '123',
      owner: 'api-test-owner',
      repo,
    });

    const response = await app.request(`/api/repos/api-test-owner/${repo}/config`, {
      method: 'PATCH',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        enabled: 'false',
      }),
    }, env);

    expect(response.status).toBe(400);
  });

  it('preserves path separators when fetching nested GitHub contents', async () => {
    const env = createTestEnv();
    await env.APP_KV.put('install:123', JSON.stringify({
      token: 'cached-installation-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));

    let requestedUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      requestedUrl = String(input);
      return Response.json({
        content: Buffer.from('hello').toString('base64'),
        encoding: 'base64',
      });
    });

    const client = new GitHubClient(env, '123');
    const content = await client.getRepoFileOrNull('owner', 'repo', 'src/path with spaces/app.ts');

    expect(content).toBe('hello');
    expect(requestedUrl).toBe('https://api.github.com/repos/owner/repo/contents/src/path%20with%20spaces/app.ts');
  });

  it('keeps repo model settings inherited when loading global strategy', async () => {
    const env = createTestEnv();
    const repo = uniqueName('global-inherit');

    await updateGlobalConfig(env, {
      main: '@cf/zai-org/glm-4.7-flash',
      fallbacks: [],
      size_overrides: [],
    });

    const loaded = await loadRepoConfig(env, {
      installationId: '123',
      owner: 'api-test-owner',
      repo,
    });

    expect(loaded.parsedJson.model.main).toBe('@cf/zai-org/glm-4.7-flash');
    expect(loaded.parsedJson.model.fallbacks).toEqual([]);

    const record = await getRepoConfigRecord(env, 'api-test-owner', repo);
    expect(record?.mainModel).toBeNull();
    expect(record?.fallbackModels).toBeNull();
    expect(record?.sizeOverrides).toBeNull();

    await updateGlobalConfig(env, {
      main: 'gemma-4-26b-a4b-it',
      fallbacks: ['@cf/zai-org/glm-4.7-flash'],
      size_overrides: [],
    });

    const reloaded = await loadRepoConfig(env, {
      installationId: '123',
      owner: 'api-test-owner',
      repo,
    });

    expect(reloaded.parsedJson.model.main).toBe('gemma-4-26b-a4b-it');
  });

  it('uses the current global model strategy when retrying an older job', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = uniqueName('retry-current-config');

    const source = await insertJob(env, {
      installationId: '123',
      owner: 'api-test-owner',
      repo,
      prNumber: 12,
      prTitle: 'Retry Current Config',
      prAuthor: 'author',
      commitSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: {
        ...defaultRepoConfig,
        model: {
          main: 'gemma-4-31b-it',
          fallbacks: ['gemma-4-26b-a4b-it', '@cf/zai-org/glm-4.7-flash'],
          size_overrides: [],
        },
      },
    });

    await updateGlobalConfig(env, {
      main: 'gemma-4-31b-it',
      fallbacks: ['gemma-4-26b-a4b-it'],
      size_overrides: [
        {
          max_lines: 300,
          model: 'gemma-4-31b-it',
          fallbacks: ['gemma-4-26b-a4b-it'],
        },
      ],
    });

    const response = await app.request(`/api/jobs/${source.id}/retry`, {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
      },
    }, env);

    expect(response.status).toBe(202);
    const body = await response.json() as { job: { id: string } };
    const retry = await getJobForProcessing(env, body.job.id);
    const snapshot = typeof retry?.config_snapshot === 'string'
      ? JSON.parse(retry.config_snapshot)
      : retry?.config_snapshot;

    expect(snapshot.model).toEqual({
      main: 'gemma-4-31b-it',
      fallbacks: ['gemma-4-26b-a4b-it'],
      size_overrides: [
        {
          max_lines: 300,
          model: 'gemma-4-31b-it',
          fallbacks: ['gemma-4-26b-a4b-it'],
        },
      ],
    });
  });
});
