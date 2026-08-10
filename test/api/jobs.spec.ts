import { createApp } from '@server/app';
import { getJobForProcessing, insertJob } from '@server/db/jobs';
import { upsertFileReview } from '@server/db/file-reviews';

import { defaultRepoConfig, reviewJobMessageSchema } from '@shared/schema';
import type { JobDetailResponse, StatsResponse } from '@shared/api';
import { createTestEnv, uniqueName, uniqueRepo } from '../helpers';
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
      repo: uniqueRepo('api'),
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

    await upsertFileReview(env, job.id, {
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

  // Regression: `fingerprint_v2` was written on every insert but omitted from this projection
  // alone, so the dashboard never saw it even though suppression and gold-set labels key on it.
  it('returns both fingerprints on job detail comments', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'api-test-owner',
      repo: uniqueRepo('api'),
      prNumber: 44,
      prTitle: 'Fingerprint PR',
      prAuthor: 'tester',
      commitSha: 'c'.repeat(40),
      baseSha: 'd'.repeat(40),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });

    await upsertFileReview(env, job.id, {
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
        fingerprint: 'abc12345',
        fingerprintV2: 'def67890',
        anchorHash: 'anchor01',
        claimType: 'swallowed_error',
        contextSnippet: 'try {} catch {}',
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
    const comment = data.job.files[0].parsedComments[0];
    expect(comment.fingerprint).toBe('abc12345');
    expect(comment.fingerprintV2).toBe('def67890');
    expect(comment.anchorHash).toBe('anchor01');
    expect(comment.claimType).toBe('swallowed_error');
    expect(comment.contextSnippet).toBe('try {} catch {}');
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

  it('stops an ongoing job: marks it cancelled and terminates the workflow', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const job = await insertJob(env, {
      installationId: '123', owner: 'api-test-owner', repo: uniqueName('stop'), prNumber: 1,
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
      installationId: '123', owner: 'api-test-owner', repo: uniqueName('delete'), prNumber: 1,
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
