import { runReviewJob } from '@server/core/review';
import { createTestEnv, dbDescribe, sha, uniqueName, uniqueRepo } from '../helpers';
import { afterAll, expect, vi } from 'vitest';
import { findExistingJobForHead, getJobForProcessing } from '@server/db/jobs';
import { getFileReviewsForJobs } from '@server/db/file-reviews';
import { runWithDb, queryRows } from '@server/db/client';


const { getOtherRunningJobsCountMock } = vi.hoisted(() => ({
  getOtherRunningJobsCountMock: vi.fn().mockResolvedValue(0),
}));

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return { ...mod, getOtherRunningJobsCount: getOtherRunningJobsCountMock };
});

// `global_settings` is a singleton, so reading it races the suites that write it once files run in
// parallel. This suite only needs some fixed concurrency, so pin the schema default.
const { getReviewSettingsMock } = vi.hoisted(() => ({ getReviewSettingsMock: vi.fn() }));

vi.mock('@server/db/app-settings', async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  const { reviewSettingsSchema } = await import('@codra/schema');
  getReviewSettingsMock.mockResolvedValue(reviewSettingsSchema.parse({}));
  return { ...mod, getReviewSettings: getReviewSettingsMock };
});

vi.mock('@server/services/github', async () => {
  const { makeGitHubServiceMock } = await import('../mocks/services');
  return { GitHubService: makeGitHubServiceMock() };
});

// Controllable async-batch model: submit hands back a request_id; the first poll is still
// pending, the second completes. reviewFile must NOT be called on the async path.
const pollCalls = { count: 0 };
const reviewFileSpy = vi.fn();
vi.mock('@server/services/model', async () => {
  class MockModelService {
    async submitReviewBatch() {
      return { requestId: 'req-async-1', model: '@cf/moonshotai/kimi-k2.6' };
    }
    async pollReviewBatch() {
      pollCalls.count += 1;
      if (pollCalls.count < 2) return { status: 'pending' as const };
      return {
        status: 'done' as const,
        response: {
          modelUsed: '@cf/moonshotai/kimi-k2.6',
          provider: 'Cloudflare',
          inputTokens: 11,
          outputTokens: 7,
          rawText: '{"findings":[]}',
          userPrompt: '',
          parsed: { comments: [], verdict: 'approve' as const, fileSummary: 'ok', overallCorrectness: 'patch is correct', confidenceScore: 0.9 },
        },
      };
    }
    async reviewFile() { reviewFileSpy(); throw new Error('sync reviewFile should not be called on the async path'); }
    async generateSummary() { return { modelUsed: 'm', provider: 'p', rawText: '{"summary":"s"}', inputTokens: 1, outputTokens: 1 }; }
  }
  const { nextChainIndexOfMock } = await import('../mocks/services');
  return { ModelService: MockModelService, isRetryableModelError: (e: unknown) => Boolean(e && typeof e === 'object' && (e as any).retryable === true), nextChainIndexOf: nextChainIndexOfMock };
});


dbDescribe('Async batch review flow', () => {
  // Tripwire: if runReviewJob ever stops importing getOtherRunningJobsCount from the
  // @server/db/jobs barrel, this mock silently stops applying and every test here still passes.
  afterAll(() => {
    expect(getOtherRunningJobsCountMock).toHaveBeenCalled();
    expect(getReviewSettingsMock).toHaveBeenCalled();
  });

  const env = createTestEnv();

  // A delayed reschedule sets last_queue_message_at into the future; claimJobLease refuses to
  // claim until then (in prod the workflow's step.sleep waits it out). Backdate it to simulate
  // that scheduled delay having elapsed so the next poll can claim immediately.
  async function simulateScheduledDelayElapsed(jobId: string) {
    await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
  }

  it('submits to the async queue, stays pending across polls, then completes and finalizes', async () => {
    pollCalls.count = 0;
    const repo = uniqueRepo('async');
    const headSha = sha('c');

    await runWithDb(env, async () => {
      // Phase 1: prepare (creates the job, enqueues review).
      const prep = await runReviewJob(env, {
        deliveryId: uniqueName('delivery-async'),
        eventName: 'pull_request',
        payload: {
          action: 'opened',
          installation: { id: 123 },
          repository: { owner: { login: 'test-owner' }, name: repo },
          pull_request: { number: 1, head: { sha: headSha, ref: 'feature' }, base: { sha: sha('d'), ref: 'main' }, title: 'Test PR', user: { login: 'author' }, draft: false },
        },
      } as any);
      expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });

      const job = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 1, commitSha: headSha, trigger: 'auto' });
      const jobId = job!.id;

      // Phase 2: first review invocation -> submits the async batch, persists a 'pending' row.
      // Prepare enqueues review with FRESH_INVOCATION_YIELD_SECONDS, so this transition is
      // delay-gated exactly like the polls below and needs the same simulated elapse.
      await simulateScheduledDelayElapsed(jobId);
      const submitResult = await runReviewJob(env, { jobId, phase: 'review' } as any);
      expect(submitResult).toMatchObject({ action: 'next_phase', phase: 'review' });
      let reviews = await getFileReviewsForJobs(env, [jobId]);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].file_status).toBe('pending');
      expect(reviews[0].async_request_id).toBe('req-async-1');

      // Phase 3: poll returns pending -> stays in review phase.
      await simulateScheduledDelayElapsed(jobId);
      const pollPending = await runReviewJob(env, { jobId, phase: 'review' } as any);
      expect(pollPending).toMatchObject({ action: 'next_phase', phase: 'review' });
      reviews = await getFileReviewsForJobs(env, [jobId]);
      expect(reviews[0].file_status).toBe('pending');

      // Phase 4: poll returns done -> persists 'done', clears async bookkeeping, moves to finalize.
      await simulateScheduledDelayElapsed(jobId);
      const pollDone = await runReviewJob(env, { jobId, phase: 'review' } as any);
      expect(pollDone).toMatchObject({ action: 'next_phase', phase: 'finalize' });
      reviews = await getFileReviewsForJobs(env, [jobId]);
      expect(reviews[0].file_status).toBe('done');
      expect(reviews[0].async_request_id).toBeNull();
      expect(reviews[0].model_used).toBe('@cf/moonshotai/kimi-k2.6');

      // The synchronous reviewFile path must never have been used.
      expect(reviewFileSpy).not.toHaveBeenCalled();
      // Sanity: the batch was polled until it completed.
      expect(pollCalls.count).toBeGreaterThanOrEqual(2);

      expect(await getJobForProcessing(env, jobId)).toBeTruthy();
    });
  }, 60_000);
});
