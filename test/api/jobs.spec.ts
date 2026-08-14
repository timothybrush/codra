import { createApp } from '@server/app';
import { getJobForProcessing, insertJob } from '@codra/db/jobs';

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

describe('Dashboard API: jobs, stats and queue messages', () => {
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

  it('reruns a job from start: creates a fresh job that does NOT inherit the parent (no retryOfJobId)', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const source = await insertJob(env, {
      installationId: '123', owner: 'api-test-owner', repo: uniqueName('rerun'), prNumber: 1,
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

});
