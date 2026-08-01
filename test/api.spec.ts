import { createApp } from '@server/app';
import { getJobForProcessing, insertJob } from '@server/db/jobs';
import { insertFileReview } from '@server/db/file-reviews';
import { queryRows } from '@server/db/client';
import { getRepoConfigRecord } from '@server/db/repo-configs';
import { loadRepoConfig, updateGlobalConfig } from '@server/core/config';
import { GitHubClient } from '@server/core/github';
import { syncUpdatesEmail } from '@server/core/updates-email';
import { defaultRepoConfig, reviewJobMessageSchema } from '@shared/schema';
import type {
  AccountResponse,
  AuthSessionResponse,
  JobDetailResponse,
  JobsResponse,
  ModelConfigsResponse,
  RepoConfigsResponse,
  StatsResponse,
  UpdatesEmailResponse,
} from '@shared/api';
import { createTestEnv, saveTestProviderApiKey } from './helpers';
import { vi } from 'vitest';

/**
 * `githubUserId` is parameterised so a test that mutates the persisted
 * account_settings row (display name, timezone) can use its own id and not leak
 * into tests asserting a pristine record — the tests share one database.
 */
function mockGitHubProfile(login = 'devarshishimpi', githubUserId = 42) {
  return {
    id: githubUserId,
    login,
    name: 'Devarshi Shimpi',
    avatar_url: `https://avatars.githubusercontent.com/u/${githubUserId}`,
    email: null,
  };
}

describe('Dashboard API Suite', () => {
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

  it('denies access to /api/jobs without a session', async () => {
    const env = createTestEnv();
    const response = await app.request('/api/jobs', {}, env);
    expect(response.status).toBe(401);
  });

  it('starts GitHub OAuth with the configured callback and scope', async () => {
    const env = createTestEnv();
    const response = await app.request('/auth/github', {}, env);

    expect(response.status).toBe(302);

    const location = response.headers.get('location');
    expect(location).toBeTruthy();

    const url = new URL(location!);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(env.GITHUB_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(env.AUTH_CALLBACK_URL);
    expect(url.searchParams.get('scope')).toBe('read:user');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('rejects GitHub users outside the allowlist', async () => {
    const env = createTestEnv({ DASHBOARD_ALLOWED_USERS: 'someoneelse' });
    const originalFetch = globalThis.fetch;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'oauth-access-token' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json(mockGitHubProfile('devarshishimpi'));
      }
      return originalFetch(input, init);
    });

    const authStart = await app.request('/auth/github', {}, env);
    const state = new URL(authStart.headers.get('location')!).searchParams.get('state');
    const response = await app.request(`/auth/github/callback?code=test-code&state=${state}`, {}, env);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login?error=not_allowed');
  });

  it('allows access to /api/jobs with a valid GitHub session', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const response = await app.request('/api/jobs', {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as JobsResponse;
    expect(Array.isArray(data.jobs)).toBe(true);
  });

  it('rejects authenticated state-changing API requests without the CSRF header', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/jobs/non-existent-id/retry', {
      method: 'POST',
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(403);
  });

  it('allows authenticated state-changing API requests with the CSRF header', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/jobs/non-existent-id/retry', {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
      },
    }, env);

    expect(response.status).toBe(404);
  });

  it('preserves omitted review settings when patching a single setting', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const headers = {
      Cookie: `codra_session=${token}`,
      'x-requested-with': 'XMLHttpRequest',
      'content-type': 'application/json',
    };

    try {
      const seed = await app.request('/api/settings', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ concurrencyLevel: 'low', maxComments: 5 }),
      }, env);
      expect(seed.status).toBe(200);

      const commentsOnly = await app.request('/api/settings', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ maxComments: 20 }),
      }, env);
      expect(commentsOnly.status).toBe(200);

      const afterCommentsOnly = await app.request('/api/settings', {
        headers: { Cookie: `codra_session=${token}` },
      }, env);
      expect(afterCommentsOnly.status).toBe(200);
      await expect(afterCommentsOnly.json()).resolves.toMatchObject({
        settings: { concurrencyLevel: 'low', maxComments: 20 },
      });

      const concurrencyOnly = await app.request('/api/settings', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ concurrencyLevel: 'high' }),
      }, env);
      expect(concurrencyOnly.status).toBe(200);

      const afterConcurrencyOnly = await app.request('/api/settings', {
        headers: { Cookie: `codra_session=${token}` },
      }, env);
      expect(afterConcurrencyOnly.status).toBe(200);
      await expect(afterConcurrencyOnly.json()).resolves.toMatchObject({
        settings: { concurrencyLevel: 'high', maxComments: 20 },
      });
    } finally {
      await app.request('/api/settings', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ concurrencyLevel: 'medium', maxComments: 10 }),
      }, env);
    }
  });

  it('returns 400 for malformed review settings JSON', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/settings', {
      method: 'PATCH',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json',
      },
      body: '{',
    }, env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'Invalid review settings.' });
  });

  it('falls back invalid stored review settings independently', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    try {
      await queryRows(
        env,
        `INSERT INTO global_settings (key, value) VALUES
          ('review_concurrency_level', 'turbo'),
          ('review_max_comments', '20')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );

      const invalidConcurrency = await app.request('/api/settings', {
        headers: { Cookie: `codra_session=${token}` },
      }, env);
      expect(invalidConcurrency.status).toBe(200);
      await expect(invalidConcurrency.json()).resolves.toMatchObject({
        settings: { concurrencyLevel: 'medium', maxComments: 20 },
      });

      await queryRows(
        env,
        `INSERT INTO global_settings (key, value) VALUES
          ('review_concurrency_level', 'high'),
          ('review_max_comments', '999')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );

      const invalidComments = await app.request('/api/settings', {
        headers: { Cookie: `codra_session=${token}` },
      }, env);
      expect(invalidComments.status).toBe(200);
      await expect(invalidComments.json()).resolves.toMatchObject({
        settings: { concurrencyLevel: 'high', maxComments: 10 },
      });
    } finally {
      await queryRows(
        env,
        `INSERT INTO global_settings (key, value) VALUES
          ('review_concurrency_level', 'medium'),
          ('review_max_comments', '10')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
    }
  });

  it('rejects logout without the CSRF header', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(403);
  });

  it('allows logout with a valid session and CSRF header', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
      },
    }, env);

    expect(response.status).toBe(200);
  });

  it('returns the authenticated GitHub session user', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/auth/session', {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as AuthSessionResponse;
    expect(data.user.login).toBe('devarshishimpi');
  });

  it('persists and returns a durable account record with a unique account id', async () => {
    const env = createTestEnv();
    // Own github_user_id: this asserts a pristine record, so it must not share a
    // row with the tests that rename it or set a timezone.
    const token = await getAuthCookie(env, 'devarshishimpi', 4300);

    const response = await app.request('/api/auth/account', {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as AccountResponse;
    expect(data.account.githubUserId).toBe(4300);
    expect(data.account.githubUsername).toBe('devarshishimpi');
    expect(data.account.accountName).toBe('Devarshi Shimpi');
    expect(typeof data.account.id).toBe('string');
    expect(data.account.id.length).toBeGreaterThan(0);
  });

  it('updates the editable account display name', async () => {
    const env = createTestEnv();
    // Own github_user_id: this test mutates the persisted row.
    const token = await getAuthCookie(env, 'devarshishimpi', 4303);

    const response = await app.request('/api/auth/account', {
      method: 'PATCH',
      headers: { Cookie: `codra_session=${token}`, 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
      body: JSON.stringify({ name: 'Renamed Codra User' }),
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as AccountResponse;
    expect(data.account.accountName).toBe('Renamed Codra User');
    expect(data.account.githubUserId).toBe(4303);

    // The change persists on subsequent reads.
    const followUp = await app.request('/api/auth/account', {
      headers: { Cookie: `codra_session=${token}` },
    }, env);
    const followUpData = await followUp.json() as AccountResponse;
    expect(followUpData.account.accountName).toBe('Renamed Codra User');
  });

  it('persists a display time zone and clears it back to the default', async () => {
    const env = createTestEnv();
    // Own github_user_id: this test mutates the persisted row.
    const token = await getAuthCookie(env, 'devarshishimpi', 4301);
    const headers = {
      Cookie: `codra_session=${token}`,
      'content-type': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
    };

    const set = await app.request('/api/auth/account', {
      method: 'PATCH', headers, body: JSON.stringify({ timezone: 'Asia/Kolkata' }),
    }, env);
    expect(set.status).toBe(200);
    expect(((await set.json()) as AccountResponse).account.timezone).toBe('Asia/Kolkata');

    // Persisted, not just echoed back.
    const read = await app.request('/api/auth/account', { headers }, env);
    expect(((await read.json()) as AccountResponse).account.timezone).toBe('Asia/Kolkata');

    // null means "follow the browser".
    const cleared = await app.request('/api/auth/account', {
      method: 'PATCH', headers, body: JSON.stringify({ timezone: null }),
    }, env);
    expect(((await cleared.json()) as AccountResponse).account.timezone).toBeNull();
  });

  it('rejects an unknown time zone', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/auth/account', {
      method: 'PATCH',
      headers: { Cookie: `codra_session=${token}`, 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
      body: JSON.stringify({ timezone: 'Mars/Olympus_Mons' }),
    }, env);

    expect(response.status).toBe(400);
  });

  it('keeps a user-set display name when the OAuth upsert runs again', async () => {
    const env = createTestEnv();
    // Own github_user_id: this test renames the persisted row.
    const token = await getAuthCookie(env, 'devarshishimpi', 4302);
    const headers = {
      Cookie: `codra_session=${token}`,
      'content-type': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
    };

    await app.request('/api/auth/account', {
      method: 'PATCH', headers, body: JSON.stringify({ name: 'My Chosen Name' }),
    }, env);

    // Signing in again re-runs upsertAccountSettings with the GitHub profile name.
    await getAuthCookie(env, 'devarshishimpi', 4302);

    const read = await app.request('/api/auth/account', { headers }, env);
    expect(((await read.json()) as AccountResponse).account.accountName).toBe('My Chosen Name');
  });

  it('rejects an empty account name', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/auth/account', {
      method: 'PATCH',
      headers: { Cookie: `codra_session=${token}`, 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
      body: JSON.stringify({ name: '   ' }),
    }, env);

    expect(response.status).toBe(400);
  });

  it('syncs an updates email only once per GitHub user', async () => {
    const env = createTestEnv();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));

    await expect(syncUpdatesEmail(env, 42, 'user@example.com')).resolves.toBe(true);
    await expect(syncUpdatesEmail(env, 42, 'user@example.com')).resolves.toBe(false);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('https://codra.run/api/emails', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'user@example.com' }),
    }));
  });

  it('returns pending updates email status before required setup email is saved', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/auth/updates-email', {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as UpdatesEmailResponse;
    expect(data).toMatchObject({
      status: 'pending',
      email: null,
      updatedAt: null,
    });
  });

  it('subscribes the user-entered updates email and persists it', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));

    const response = await app.request('/api/auth/updates-email', {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify({ email: 'typed@example.com' }),
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as UpdatesEmailResponse;
    expect(data.status).toBe('subscribed');
    expect(data.email).toBe('typed@example.com');
    expect(data.updatedAt).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledWith('https://codra.run/api/emails', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'typed@example.com' }),
    }));
  });

  it('returns 404 for non-existent job detail (invalid UUID)', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/jobs/non-existent-id', {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(404);
  });

  it('fetches job details accurately', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'api-test-owner',
      repo: 'api-test-repo',
      prNumber: 42,
      prTitle: 'API Test PR',
      prAuthor: 'tester',
      commitSha: 'sha123',
      baseSha: 'basesha',
      trigger: 'auto',
      headRef: 'main',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });

    const response = await app.request(`/api/jobs/${job.id}`, {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as JobDetailResponse;
    expect(data.job.id).toBe(job.id);
    expect(data.job.owner).toBe('api-test-owner');
    expect(data.job.prNumber).toBe(42);
    expect(data.job.files).toBeDefined();
  });

  it('fetches job details when stored comments have null code suggestions', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'api-test-owner',
      repo: `api-test-repo-${Date.now()}`,
      prNumber: 43,
      prTitle: 'Null suggestion PR',
      prAuthor: 'tester',
      commitSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });

    await insertFileReview(env, {
      jobId: job.id,
      filePath: 'src/lib/slug.ts',
      fileStatus: 'done',
      modelUsed: 'gemma-4-31b-it',
      modelProvider: 'google',
      diffLineCount: 5,
      diffInput: 'diff',
      rawAiOutput: '{}',
      parsedComments: [{
        path: 'src/lib/slug.ts',
        position: 1,
        severity: 'P2',
        category: 'quality',
        title: 'Example',
        body: 'Body',
        codeSuggestion: null,
      }],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 10,
      verdict: 'comment',
      fileSummary: 'summary',
      errorMessage: null,
    });

    const response = await app.request(`/api/jobs/${job.id}`, {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as JobDetailResponse;
    expect(data.job.files[0].parsedComments[0].codeSuggestion).toBeNull();
  });

  it('returns stats successfully', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/stats', {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as StatsResponse;
    expect(data.stats).toHaveProperty('totals');
    expect(data.stats).toHaveProperty('trend');
    expect(data.stats).toHaveProperty('topRepos');
  });

  it('rejects invalid model config writes', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/models/gemma-4-31b-it', {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        providerId: 'not-a-uuid',
        provider: 'unknown',
      }),
    }, env);

    expect(response.status).toBe(400);
  });

  it('returns model configs without refreshing remote provider catalogs', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    await saveTestProviderApiKey(env);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected catalog fetch'));
    fetchSpy.mockClear();

    const response = await app.request('/api/models', {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects enabling non-Cloudflare providers without a saved API key', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const createResponse = await app.request('/api/models/providers', {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'No Key Provider',
        apiFormat: 'openai',
        baseUrl: 'https://api.example.com/v1',
        enabled: true,
      }),
    }, env);
    expect(createResponse.status).toBe(400);

    const disabledCreateResponse = await app.request('/api/models/providers', {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: `Disabled No Key Provider ${Date.now()}`,
        apiFormat: 'openai',
        baseUrl: 'https://api.example.com/v1',
        enabled: false,
      }),
    }, env);
    expect(disabledCreateResponse.status).toBe(201);
    const { provider } = await disabledCreateResponse.json() as { provider: { id: string; name: string; apiFormat: string; baseUrl: string } };

    const updateResponse = await app.request(`/api/models/providers/${provider.id}`, {
      method: 'PATCH',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: provider.name,
        apiFormat: provider.apiFormat,
        baseUrl: provider.baseUrl,
        enabled: true,
      }),
    }, env);
    expect(updateResponse.status).toBe(400);
  });

  it('refreshes provider model catalogs on the explicit sync endpoint', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    await saveTestProviderApiKey(env);
    const discoveredModelName = `test-discovered-${Date.now()}`;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/ai/models/search')) {
        return Response.json({
          success: false,
          errors: [{ code: 10000, message: 'Authentication error' }],
          messages: [],
          result: null,
        }, { status: 403 });
      }
      return Response.json({
        models: [
          {
            name: `models/${discoveredModelName}`,
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      });
    });

    const response = await app.request('/api/models/sync', {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json',
      },
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as ModelConfigsResponse;
    const discoveredGoogleModel = data.configs.find(config => config.modelName === discoveredModelName);
    expect(discoveredGoogleModel).toMatchObject({ modelName: discoveredModelName, apiFormat: 'gemini' });
    expect(data.configs.some(config => config.providerName === 'Cloudflare' && config.modelName === '@cf/openai/gpt-oss-120b')).toBe(true);
    expect(data.syncErrors).toEqual([]);
  });

  it('tests models whose ids contain URL path separators', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const modelId = '@cf/zai-org/glm-4.7-flash';

    const response = await app.request(`/api/models/${encodeURIComponent(modelId)}/test`, {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
      },
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as { modelUsed: string; provider: string };
    expect(data.modelUsed).toBe(modelId);
    expect(data.provider).toBe('Cloudflare');
  });

  it('returns provider status codes for model test failures', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    await saveTestProviderApiKey(env);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
      error: {
        code: 429,
        message: 'Quota exceeded. Please retry later.',
        status: 'RESOURCE_EXHAUSTED',
      },
    }, { status: 429 }));

    const response = await app.request('/api/models/gemma-4-31b-it/test', {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
      },
    }, env);

    expect(response.status).toBe(429);
    const data = await response.json() as { error: string };
    expect(data.error).toContain('Quota exceeded');
    expect(data.error).not.toContain('"details"');
  });

  it('reports local Cloudflare Workers AI binding limitations clearly', async () => {
    const env = createTestEnv({
      AI: {
        async run() {
          throw new Error('Binding AI needs to be run remotely');
        },
      } as any,
    });
    const token = await getAuthCookie(env);

    const response = await app.request(`/api/models/${encodeURIComponent('@cf/zai-org/glm-4.7-flash')}/test`, {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
      },
    }, env);

    expect(response.status).toBe(400);
    const data = await response.json() as { error: string };
    expect(data.error).toContain('Cloudflare Workers AI is not available in local Wrangler');
  });

  it('maps upstream provider server errors to bad gateway after retry', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    await saveTestProviderApiKey(env);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
      error: {
        code: 500,
        message: 'Internal error encountered.',
      },
    }, { status: 500 }));
    fetchMock.mockClear();

    const response = await app.request('/api/models/gemma-4-31b-it/test', {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
      },
    }, env);

    expect(response.status).toBe(502);
    // GEMINI_MAX_RETRIES = 2, so a persistent 5xx is attempted 3 times before giving up.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const data = await response.json() as { error: string };
    expect(data.error).toContain('Internal error encountered.');
  });

  it('rejects invalid global model config writes', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/models/global', {
      method: 'PATCH',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        main: 'gemma-4-31b-it',
        fallbacks: 'not-an-array',
        size_overrides: {},
      }),
    }, env);

    expect(response.status).toBe(400);
  });

  it('rejects unknown fields in global model config writes', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/models/global', {
      method: 'PATCH',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        main: 'gemma-4-31b-it',
        fallbacks: [],
        unexpected: true,
      }),
    }, env);

    expect(response.status).toBe(400);
  });

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
    const repo = `invalid-config-${Date.now()}`;

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
          max_files: 0,
        },
      }),
    }, env);

    expect(response.status).toBe(400);
  });

  it('rejects string booleans in repository config patches', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = `invalid-enabled-${Date.now()}`;

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
    const repo = `global-inherit-${Date.now()}`;

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
    const repo = `retry-current-config-${Date.now()}`;

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

  it('stops an ongoing job: marks it cancelled and terminates the workflow', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const job = await insertJob(env, {
      installationId: '123', owner: 'api-test-owner', repo: `stop-${Date.now()}`, prNumber: 1,
      prTitle: 'Stop', prAuthor: 'author', commitSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
      trigger: 'auto', headRef: 'feature', baseRef: 'main',
    });

    const response = await app.request(`/api/jobs/${job.id}/stop`, {
      method: 'POST',
      headers: { Cookie: `codra_session=${token}`, 'x-requested-with': 'XMLHttpRequest' },
    }, env);

    expect(response.status).toBe(200);
    const body = await response.json() as { job: { status: string } };
    expect(body.job.status).toBe('cancelled');
    expect((env.REVIEW_WORKFLOW as any).terminated).toContain(job.id);

    const row = await getJobForProcessing(env, job.id);
    expect(row?.status).toBe('cancelled');

    // Stopping an already-terminal job is a 409.
    const second = await app.request(`/api/jobs/${job.id}/stop`, {
      method: 'POST',
      headers: { Cookie: `codra_session=${token}`, 'x-requested-with': 'XMLHttpRequest' },
    }, env);
    expect(second.status).toBe(409);
  });

  it('deletes a job (and it is gone afterwards)', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const job = await insertJob(env, {
      installationId: '123', owner: 'api-test-owner', repo: `delete-${Date.now()}`, prNumber: 1,
      prTitle: 'Delete', prAuthor: 'author', commitSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
      trigger: 'auto', headRef: 'feature', baseRef: 'main',
    });

    const response = await app.request(`/api/jobs/${job.id}`, {
      method: 'DELETE',
      headers: { Cookie: `codra_session=${token}`, 'x-requested-with': 'XMLHttpRequest' },
    }, env);

    expect(response.status).toBe(204);
    expect(await getJobForProcessing(env, job.id)).toBeNull();
  });

  it('reruns a job from start: creates a fresh job that does NOT inherit the parent (no retryOfJobId)', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const source = await insertJob(env, {
      installationId: '123', owner: 'api-test-owner', repo: `rerun-${Date.now()}`, prNumber: 1,
      prTitle: 'Rerun', prAuthor: 'author', commitSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
      trigger: 'auto', headRef: 'feature', baseRef: 'main',
    });

    const response = await app.request(`/api/jobs/${source.id}/rerun`, {
      method: 'POST',
      headers: { Cookie: `codra_session=${token}`, 'x-requested-with': 'XMLHttpRequest' },
    }, env);

    expect(response.status).toBe(202);
    const body = await response.json() as { job: { id: string } };
    expect(body.job.id).not.toBe(source.id);
    const fresh = await getJobForProcessing(env, body.job.id);
    // Rerun-from-start must not inherit parent file reviews, so retry_of_job_id stays null.
    expect(fresh?.retry_of_job_id ?? null).toBeNull();
  });

  it('accepts legacy jobId-only queue messages during schema transition', () => {
    const parsed = reviewJobMessageSchema.safeParse({
      jobId: crypto.randomUUID(),
      deliveryId: 'legacy-delivery',
      installationId: '123',
      owner: 'api-test-owner',
      repo: 'api-test-repo',
      prNumber: 42,
      commitSha: 'abc123',
      trigger: 'auto',
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts unsupported webhook events so old queue messages can be drained', () => {
    const parsed = reviewJobMessageSchema.safeParse({
      deliveryId: 'bad-event-delivery',
      eventName: 'check_suite',
    });

    expect(parsed.success).toBe(true);
  });
});
