import { runReviewJob } from '@server/core/review';
import { createTestEnv, dbDescribe, generateMockDiff, sha, uniqueRepo } from '../helpers';
import { afterAll, vi } from 'vitest';
import { findExistingJobForHead, getJobForProcessing, insertJob } from '@server/db/jobs';
import { getFileReviewsForJobs } from '@server/db/file-reviews';
import { defaultRepoConfig } from '@codra/schema';
import { runWithDb, queryRows } from '@server/db/client';
import { normalizeGitHubWebhook } from '@codra/provider-github';
import { makeRunAndDrain, REVIEW_FLOW_TIMEOUT_MS } from '../mocks/review-harness';

const { getOtherRunningJobsCountMock } = vi.hoisted(() => ({
  getOtherRunningJobsCountMock: vi.fn().mockResolvedValue(0),
}));

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return { ...mod, getOtherRunningJobsCount: getOtherRunningJobsCountMock };
});

// `global_settings` is a singleton, so reading it races the suites that write it once files run
// in parallel, and unique row names can't isolate a single-row table. This suite only needs some
// fixed concurrency, so pin the schema default; the suites that test the table take a lock.
const { getReviewSettingsMock } = vi.hoisted(() => ({ getReviewSettingsMock: vi.fn() }));

vi.mock('@server/db/app-settings', async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  const { reviewSettingsSchema } = await import('@codra/schema');
  getReviewSettingsMock.mockResolvedValue(reviewSettingsSchema.parse({}));
  return { ...mod, getReviewSettings: getReviewSettingsMock };
});

vi.mock('@codra/provider-github', async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  const { makeGitHubServiceMock } = await import('../mocks/services');
  return { ...mod, GitHubService: makeGitHubServiceMock() };
});

vi.mock('@server/services/model', async () => {
  const { makeModelServiceMock, isRetryableModelErrorMock, nextChainIndexOfMock } = await import('../mocks/services');
  return { ModelService: makeModelServiceMock(), isRetryableModelError: isRetryableModelErrorMock, nextChainIndexOf: nextChainIndexOfMock };
});

// Whether the maintenance sweep would pick THIS job up, mirroring its predicate exactly. Asserted
// against the job's own row rather than by scanning `getTerminalJobsNeedingCheckRunCompletion`:
// that query is `ORDER BY ... ASC LIMIT n`, so on a shared database a fresh job falls outside the
// window and fails for a reason unrelated to the behaviour.
async function needsCheckRunCompletion(env: Parameters<typeof queryRows>[0], jobId: string) {
  const rows = await queryRows<{ id: string }>(
    env,
    `SELECT id FROM jobs
      WHERE id = $1::uuid
        AND status IN ('done', 'failed', 'superseded', 'cancelled')
        AND check_run_id IS NOT NULL
        AND check_run_completed_at IS NULL`,
    [jobId],
  );
  return rows.length > 0;
}

dbDescribe('Review flow: lifecycle and finalize', () => {
  // Tripwire: if a refactor rewires runReviewJob to import getOtherRunningJobsCount from a
  // sibling rather than the @server/db/jobs barrel, the mock stops applying and every test here
  // still passes while asserting nothing.
  afterAll(() => {
    expect(getOtherRunningJobsCountMock).toHaveBeenCalled();
    expect(getReviewSettingsMock).toHaveBeenCalled();
  });

  const env = createTestEnv();
  const runAndDrain = makeRunAndDrain(env);

  it('completes a full review from pending job to finished', async () => {
    const repo = uniqueRepo('full');
    const headSha = sha('a');
    const baseSha = sha('b');

    await runAndDrain({
      deliveryId: 'delivery-123',
      ...normalizeGitHubWebhook('pull_request', {
        action: 'opened',
        installation: { id: 123 },
        repository: { owner: { login: 'test-owner' }, name: repo },
        pull_request: {
          number: 1,
          head: { sha: headSha, ref: 'feature' },
          base: { sha: baseSha, ref: 'main' },
          title: 'Test PR',
          user: { login: 'author' },
          draft: false,
        }
      }) as any
    });

    const finalJob = await findExistingJobForHead(env, {
      owner: 'test-owner',
      repo,
      prNumber: 1,
      commitSha: headSha,
      trigger: 'auto',
    });
    expect(finalJob?.status).toBe('done');
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('stops processing if the job is superseded mid-way', async () => {
      const { GitHubService } = await import('@codra/provider-github');
      const repo = uniqueRepo('supersede');
      const headSha = sha('c');
      const baseSha = sha('d');

      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff');
      
      getDiffSpy.mockImplementationOnce(async () => {
          const { getDb } = await import('@server/db/client');
          const sql = getDb(env);
          await sql.query(
            `
              UPDATE jobs j
              SET status = 'superseded'
              FROM repositories r
              WHERE j.repository_id = r.id
                AND r.owner = $1
                AND r.repo = $2
                AND j.pr_number = $3
            `,
            ['test-owner', repo, 2],
          );
          return generateMockDiff([{ path: 'test.ts', content: 'a' }]);
      });

      await runAndDrain({
        deliveryId: 'delivery-456',
        ...normalizeGitHubWebhook('pull_request', {
          action: 'opened',
          installation: { id: 123 },
          repository: { owner: { login: 'test-owner' }, name: repo },
          pull_request: {
            number: 2,
            head: { sha: headSha, ref: 'feature' },
            base: { sha: baseSha, ref: 'main' },
            title: 'Supersede Test',
            user: { login: 'author' },
            draft: false,
          }
        })
      } as any);

      const finalJob = await findExistingJobForHead(env, {
        owner: 'test-owner',
        repo,
        prNumber: 2,
        commitSha: headSha,
        trigger: 'auto',
      });
      expect(finalJob?.status).toBe('superseded');
      expect(finalJob?.verdict).toBeNull();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('throttles a new (queued) job at the concurrency limit but never a running continuation', async () => {
    const jobsMod = await import('@server/db/jobs');
    const repo = uniqueRepo('admission');
    const baseSha = sha('0');
    const base = {
      installationId: '123', owner: 'test-owner', repo, prAuthor: 'author',
      baseSha, trigger: 'auto' as const, headRef: 'feature', baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    };

    const queued = await insertJob(env, { ...base, prNumber: 30, prTitle: 'Admission Queued', commitSha: sha('c') });
    const running = await insertJob(env, { ...base, prNumber: 31, prTitle: 'Admission Running', commitSha: sha('d') });
    // Far over any concurrency limit. Restored afterwards so the module mock doesn't leak.
    vi.mocked(jobsMod.getOtherRunningJobsCount).mockResolvedValue(99);
    try {
      // A brand-new (queued) job IS gated at the limit -> retry (admission control).
      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: queued.id, deliveryId: 'delivery-adm-queued', phase: 'prepare' });
        expect(res.action).toBe('retry');
      });

      // A 'running' job must NOT be re-gated on its continuations: that is the starvation bug,
      // where every in-flight job retries forever and gets lease-recovery-failed.
      await runWithDb(env, async () => {
        await queryRows(env, `UPDATE jobs SET status = 'running' WHERE id = $1`, [running.id]);
        const res = await runReviewJob(env, { jobId: running.id, deliveryId: 'delivery-adm-running', phase: 'review' });
        expect(res.action).not.toBe('retry');
      });
    } finally {
      vi.mocked(jobsMod.getOtherRunningJobsCount).mockResolvedValue(0);
    }
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('bulk-marks missing files failed in a single pass without clobbering existing rows', async () => {
    const { bulkMarkFilesFailed } = await import('@server/db/file-reviews');
    const job = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: uniqueRepo('bulk-failed'),
      prNumber: 40, prTitle: 'Bulk failed', prAuthor: 'author', commitSha: sha('e'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    await bulkMarkFilesFailed(env, job.id, [
      { filePath: 'src/a.ts', diffLineCount: 10 },
      { filePath: 'src/b.ts', diffLineCount: 20 },
    ], { modelUsed: 'gemini-3.1-flash-lite', errorMessage: 'infra limit' });

    // A second call including an existing path must not duplicate or overwrite it.
    await bulkMarkFilesFailed(env, job.id, [
      { filePath: 'src/a.ts', diffLineCount: 10 },
      { filePath: 'src/c.ts', diffLineCount: 5 },
    ], { modelUsed: 'other-model', errorMessage: 'second call' });

    const reviews = await getFileReviewsForJobs(env, [job.id]);
    expect(reviews).toHaveLength(3);
    expect(reviews.every((r) => r.file_status === 'failed')).toBe(true);
    // a.ts keeps its first values (not clobbered by the second call).
    expect(reviews.find((r) => r.file_path === 'src/a.ts')?.error_msg).toBe('infra limit');
    expect(reviews.find((r) => r.file_path === 'src/c.ts')?.error_msg).toBe('second call');
  });

  it('completes the job with the review recorded even if post-review check-run/label updates fail', async () => {
    // Regression: the review is posted mid-finalize, so if the cosmetic check-run or label calls
    // throw, the job must still finish 'done' with review_id set rather than stranded 'failed'.
    const { GitHubService } = await import('@codra/provider-github');
    const checkRunSpy = vi.spyOn(GitHubService.prototype, 'updateCheckRun' as any)
      .mockRejectedValue(new Error('Too many subrequests by single Worker invocation'));

    const job = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: uniqueRepo('besteffort'),
      prNumber: 41, prTitle: 'Best effort', prAuthor: 'author', commitSha: sha('f'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    await runAndDrain({ jobId: job.id, deliveryId: 'delivery-besteffort' });

    const final = await getJobForProcessing(env, job.id);
    expect(final?.status).toBe('done');
    expect(final?.review_id).not.toBeNull();
    // The update failed, so it stays pending for the maintenance sweep to finish.
    expect(final?.check_run_completed_at).toBeNull();
    expect(await needsCheckRunCompletion(env, job.id)).toBe(true);
    checkRunSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

});
