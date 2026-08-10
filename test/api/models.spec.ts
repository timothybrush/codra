import { createApp } from '@server/app';

import type { ModelConfigsResponse } from '@shared/api';
import { createTestEnv, saveTestProviderApiKey, uniqueName } from '../helpers';
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

describe('Dashboard API: model and provider configuration', () => {
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
        name: uniqueName('Disabled No Key Provider'),
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
    const discoveredModelName = uniqueName('test-discovered');
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

    // Must be an id saveTestProviderApiKey seeds (GOOGLE_TEST_MODEL_IDS), or /test 404s before reaching the provider.
    const response = await app.request('/api/models/gemini-3.1-pro-preview/test', {
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

    const response = await app.request('/api/models/gemini-3.1-pro-preview/test', {
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

  // Guards route registration order: if `/:id` were ever registered before `/providers`, this
  // request would match it with id === 'providers' (modelIdSchema accepts any non-empty string)
  // and hit updateModelConfig instead of provider creation.
  it('routes POST /providers to provider creation, not the /:id model-config handler', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/models/providers', {
      method: 'POST',
      headers: {
        Cookie: `codra_session=${token}`,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: uniqueName('Route Order Provider'),
        apiFormat: 'openai',
        baseUrl: 'https://api.example.com/v1',
        enabled: false,
      }),
    }, env);

    expect(response.status).toBe(201);
    const body = await response.json() as { provider?: { id: string; apiFormat: string } };
    expect(body.provider?.apiFormat).toBe('openai');
  });
});
