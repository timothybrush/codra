import { runReviewJob } from '@server/core/review';
import { createTestEnv, generateMockDiff, hasConfiguredTestDatabaseUrl } from './helpers';
import { vi } from 'vitest';
import { findExistingJobForHead, getJobForProcessing, getTerminalJobsNeedingCheckRunCompletion, insertJob, updateJobFileCount, updateJobStep } from '@server/db/jobs';
import { getFileReviewsForJobs, upsertFileReview } from '@server/db/file-reviews';
import { defaultRepoConfig, type ParsedReviewComment } from '@shared/schema';
import { runWithDb, queryRows } from '@server/db/client';

const sha = (char: string) => char.repeat(40);

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    getOtherRunningJobsCount: vi.fn().mockResolvedValue(0),
  };
});

// Properly mock the services as real classes with prototype methods
vi.mock('@server/services/github', () => {
    class MockGitHubService {
        async getPullRequest() {
            return {
                title: 'Test PR',
                body: 'Test Body',
                head: { sha: 'headsha', ref: 'feature' },
                base: { sha: 'basesha', ref: 'main' },
                user: { login: 'author' },
            };
        }
        async getPullRequestDiff() {
            return generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]);
        }
        async createCheckRun() { return { id: 123 }; }
        async updateCheckRun() { return {}; }
        async createReview() { return { id: 456 }; }
        async findBotReviewForCommit() { return null; }
        async ensureLabel() { return {}; }
        async addIssueLabels() { return {}; }
        async removeIssueLabelsIfPresent() { return {}; }
        async removeIssueLabel() { return {}; }
    }
    return { GitHubService: MockGitHubService };
});

vi.mock('@server/services/model', () => {
    class MockModelService {
        // Return null so the review phase uses the synchronous reviewFile path these tests exercise.
        // (A real request_id here would route through the async batch submit/poll flow instead.)
        async submitReviewBatch() {
            return null;
        }
        async pollReviewBatch() {
            return { status: 'pending' as const };
        }
        async reviewFile() {
            return {
                parsed: {
                    comments: [{
                        path: 'src/app.ts',
                        line: 1,
                        position: 1,
                        severity: 'P2',
                        category: 'quality',
                        title: 'Typo',
                        body: 'Fixed typo',
                    }],
                    verdict: 'comment',
                    fileSummary: 'Looks ok',
                    overallCorrectness: 'issues found',
                    confidenceScore: 0.9,
                    // Kept in step with parseFileReviewResponse: finalize sums these to decide whether
                    // an empty review means "nothing found" or "everything withheld".
                    evidenceStats: { total: 1, matched: 1, unmatched: 0, weak: 0, absent: 0 },
                    claimTypeCounts: { other: 1 },
                    deniedClaimCounts: {},
                    absenceCheckStats: { absenceShaped: 0, identifierExtracted: 0, refuted: 0 },
                },
                modelUsed: 'test-model',
                provider: 'test-provider',
                inputTokens: 10,
                outputTokens: 5,
                rawText: '{}',
                userPrompt: '',
            };
        }
        async generateSummary() {
            return {
                modelUsed: 'sum-model',
                provider: 'google',
                rawText: '{"summary": "test"}',
                inputTokens: 3,
                outputTokens: 2,
            };
        }
        // Keeps every finding. Without this the verifier throws, and although it fails open, the
        // warning masked genuine failures in this suite.
        async verifyFindings({ candidates }: { candidates: Array<{ index: number }> }) {
            return {
                modelUsed: 'verify-model',
                provider: 'test-provider',
                rawText: JSON.stringify({
                    results: candidates.map((c) => ({ index: c.index, reason: 'confirmed', verdict: 'keep' })),
                }),
                inputTokens: 1,
                outputTokens: 1,
            };
        }
    }
    return {
        ModelService: MockModelService,
        isRetryableModelError: (error: unknown) => Boolean(error && typeof error === 'object' && (error as any).retryable === true),
    };
});

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;
const REVIEW_FLOW_TIMEOUT_MS = 60_000;

dbDescribe('Review Flow Lifecycle', () => {
  const env = createTestEnv();

  async function runAndDrain(message: Parameters<typeof runReviewJob>[1]) {
    await runWithDb(env, async () => {
      let currentMessage: typeof message | null = message;
      let retries = 0;
      const MAX_RETRIES = 5;
      
      while (currentMessage) {
        const result = await runReviewJob(env, currentMessage);
        if (result.action === 'next_phase') {
          currentMessage = { ...currentMessage, phase: result.phase };
          retries = 0;
          // Phase/chunk transitions now yield long enough to hibernate into a fresh invocation,
          // which schedules the next delivery into the future (last_queue_message_at). In-process
          // we don't actually wait, so backdate it to simulate the delay elapsing -- otherwise the
          // next claim would report 'busy'.
          const jobId = (currentMessage as any).jobId;
          const repo = (currentMessage as any).payload?.repository?.name;
          if (jobId) {
            await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [jobId]);
          } else if (repo) {
            await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE repository_id IN (SELECT id FROM repositories WHERE repo = $1)`, [repo]);
          }
        } else if (result.action === 'retry') {
          if (++retries > MAX_RETRIES) throw new Error('Max retries exceeded');
          // In test environments, if we get throttled or told to retry, just break to prevent infinite loops.
          // Tests that expect a retry will assert on the direct return value instead of using runAndDrain.
          break;
        } else {
          currentMessage = null;
        }
      }
    });
  }

  it('completes a full review from pending job to finished', async () => {
    const repo = `test-repo-${Date.now()}-full`;
    const headSha = sha('a');
    const baseSha = sha('b');

    await runAndDrain({
      deliveryId: 'delivery-123',
      eventName: 'pull_request',
      payload: {
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
      }
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
      const { GitHubService } = await import('@server/services/github');
      const repo = `test-repo-${Date.now()}-supersede`;
      const headSha = sha('c');
      const baseSha = sha('d');

      // Spy on the prototype of our mocked class
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
        eventName: 'pull_request',
        payload: {
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
        }
      });

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
    const repo = `test-repo-${Date.now()}-admission`;
    const baseSha = sha('0');
    const base = {
      installationId: '123', owner: 'test-owner', repo, prAuthor: 'author',
      baseSha, trigger: 'auto' as const, headRef: 'feature', baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    };

    const queued = await insertJob(env, { ...base, prNumber: 30, prTitle: 'Admission Queued', commitSha: sha('c') });
    const running = await insertJob(env, { ...base, prNumber: 31, prTitle: 'Admission Running', commitSha: sha('d') });
    // Report far over any concurrency limit for the whole test. (The running case never calls this --
    // the gate is skipped by status -- so restore the module-mock default afterwards to avoid leaking.)
    vi.mocked(jobsMod.getOtherRunningJobsCount).mockResolvedValue(99);
    try {
      // A brand-new (queued) job IS gated at the limit -> retry (admission control).
      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: queued.id, deliveryId: 'delivery-adm-queued', phase: 'prepare' });
        expect(res.action).toBe('retry');
      });

      // A job already 'running' must NOT be re-gated on its continuations, even far over the limit --
      // that is the starvation bug (every in-flight job retries forever and gets lease-recovery-failed).
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
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-bulk-failed`,
      prNumber: 40, prTitle: 'Bulk failed', prAuthor: 'author', commitSha: sha('e'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    await bulkMarkFilesFailed(env, job.id, [
      { filePath: 'src/a.ts', diffLineCount: 10 },
      { filePath: 'src/b.ts', diffLineCount: 20 },
    ], { modelUsed: 'gemini-3.1-flash-lite', errorMessage: 'infra limit' });

    // Second call including an existing path must not duplicate or overwrite it (ON CONFLICT DO NOTHING).
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
    // Regression: the GitHub review is posted mid-finalize; if the subsequent (cosmetic) check-run
    // or label calls throw -- e.g. a large PR exhausting the invocation's subrequest budget -- the
    // job must still finish 'done' with review_id set, not be stranded 'failed' with the review
    // already live on the PR.
    const { GitHubService } = await import('@server/services/github');
    const checkRunSpy = vi.spyOn(GitHubService.prototype, 'updateCheckRun' as any)
      .mockRejectedValue(new Error('Too many subrequests by single Worker invocation'));

    const job = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-besteffort`,
      prNumber: 41, prTitle: 'Best effort', prAuthor: 'author', commitSha: sha('f'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    await runAndDrain({ jobId: job.id, deliveryId: 'delivery-besteffort' });

    const final = await getJobForProcessing(env, job.id);
    expect(final?.status).toBe('done');
    expect(final?.review_id).not.toBeNull();
    // The check-run update failed, so it must NOT be marked completed -- it stays pending so the
    // maintenance sweep can finish it (the check run always ends up 'completed', never stuck).
    expect(final?.check_run_completed_at).toBeNull();
    const pending = await getTerminalJobsNeedingCheckRunCompletion(env, 500);
    expect(pending.some((j) => j.id === job.id)).toBe(true);
    checkRunSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('marks the check-run completed on a successful finalize (no maintenance needed)', async () => {
    const job = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-checkrun-ok`,
      prNumber: 42, prTitle: 'Check run ok', prAuthor: 'author', commitSha: sha('a'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    await runAndDrain({ jobId: job.id, deliveryId: 'delivery-checkrun-ok' });

    const final = await getJobForProcessing(env, job.id);
    expect(final?.status).toBe('done');
    // The inline check-run update succeeded, so it's marked complete and won't be re-done by maintenance.
    expect(final?.check_run_completed_at).not.toBeNull();
    const pending = await getTerminalJobsNeedingCheckRunCompletion(env, 500);
    expect(pending.some((j) => j.id === job.id)).toBe(false);
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('marks "Reviewing Files" done at finalize even when a degrade path left it running', async () => {
    // Regression: continueOrFailWedgedJob's review->finalize degrade doesn't mark "Reviewing Files"
    // done, so a job that reached finalize that way stayed 'done' overall but showed the step stuck
    // "In progress". Finalize now defensively marks it done.
    const job = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-revstuck`,
      prNumber: 43, prTitle: 'Reviewing stuck', prAuthor: 'author', commitSha: sha('b'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });
    await upsertFileReview(env, job.id, {
      filePath: 'src/app.ts', fileStatus: 'done', modelUsed: 'test-model', modelProvider: 'test',
      diffLineCount: 1, diffInput: 'x', rawAiOutput: '{}', parsedComments: [], inputTokens: 1,
      outputTokens: 1, durationMs: 1, verdict: 'comment', fileSummary: 'ok', errorMessage: null,
    });

    await runWithDb(env, async () => {
      // Reach finalize with "Reviewing Files" left 'running', as the continuation-ceiling degrade does.
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
      await updateJobStep(env, job.id, 'Reviewing Files', { status: 'running' });
      await queryRows(env, `UPDATE jobs SET status = 'running', file_count = 1, lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`, [job.id]);
      await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-revstuck', phase: 'finalize' });
    });

    const final = await getJobForProcessing(env, job.id);
    expect(final?.status).toBe('done');
    const reviewingStep = (final?.steps as Array<{ name: string; status: string }>).find((s) => s.name === 'Reviewing Files');
    expect(reviewingStep?.status).toBe('done');
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('processes a pre-created retry job from a queue message', async () => {
    const repo = `test-repo-${Date.now()}-retry`;
    const sourceHeadSha = sha('1');
    const retryHeadSha = sha('2');
    const baseSha = sha('3');

    const source = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 3,
      prTitle: 'Retry Test',
      prAuthor: 'author',
      commitSha: sourceHeadSha,
      baseSha,
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });

    const retry = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 3,
      prTitle: 'Retry Test',
      prAuthor: 'author',
      commitSha: retryHeadSha,
      baseSha,
      trigger: 'retry',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
      retryOfJobId: source.id,
    });

    await runAndDrain({
      jobId: retry.id,
      deliveryId: 'delivery-retry',
    });

    const finalJob = await getJobForProcessing(env, retry.id);
    expect(finalJob?.status).toBe('done');
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('does not inherit parent file reviews from models outside the current retry strategy', async () => {
    const { ModelService } = await import('@server/services/model');
    const reviewSpy = vi.spyOn(ModelService.prototype, 'reviewFile');
    const repo = `test-repo-${Date.now()}-retry-model-filter`;
    const sourceHeadSha = sha('8');
    const retryHeadSha = sha('9');
    const baseSha = sha('0');

    const source = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 6,
      prTitle: 'Retry Model Filter',
      prAuthor: 'author',
      commitSha: sourceHeadSha,
      baseSha,
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

    await upsertFileReview(env, source.id, {
      filePath: 'src/app.ts',
      fileStatus: 'done',
      modelUsed: '@cf/zai-org/glm-4.7-flash',
      modelProvider: 'cloudflare',
      diffLineCount: 1,
      diffInput: 'old diff',
      rawAiOutput: '{}',
      parsedComments: [],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: 'approve',
      fileSummary: 'old',
      errorMessage: null,
    });

    const retry = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 6,
      prTitle: 'Retry Model Filter',
      prAuthor: 'author',
      commitSha: retryHeadSha,
      baseSha,
      trigger: 'retry',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: {
        ...defaultRepoConfig,
        model: {
          main: 'gemma-4-31b-it',
          fallbacks: ['gemma-4-26b-a4b-it'],
          size_overrides: [],
        },
      },
      retryOfJobId: source.id,
    });

    await runAndDrain({
      jobId: retry.id,
      deliveryId: 'delivery-retry-model-filter',
    });

    expect(reviewSpy).toHaveBeenCalled();
    const reviews = await getFileReviewsForJobs(env, [retry.id]);
    expect(reviews.find((review) => review.file_path === 'src/app.ts')?.model_used).toBe('test-model');
    reviewSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('inherits a parent review when the config model id is provider-prefixed but the stored model_used is bare', async () => {
    // Regression: file reviews persist the bare model id (e.g. `gemini-3.1-flash-lite`) while the
    // configured strategy stores the provider-qualified id (e.g. `google:gemini-3.1-flash-lite`).
    // Inheritance must match on the bare name; otherwise every retry re-reviews every file.
    const { ModelService } = await import('@server/services/model');
    const reviewSpy = vi.spyOn(ModelService.prototype, 'reviewFile');
    const repo = `test-repo-${Date.now()}-retry-prefix`;
    const sourceHeadSha = sha('a');
    const retryHeadSha = sha('b');
    const baseSha = sha('0');

    const prefixedConfig = {
      ...defaultRepoConfig,
      model: {
        main: 'google:gemini-3.1-flash-lite',
        fallbacks: ['google:gemini-2.5-flash-lite'],
        size_overrides: [],
      },
    };

    const source = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 7,
      prTitle: 'Retry Prefix Match',
      prAuthor: 'author',
      commitSha: sourceHeadSha,
      baseSha,
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: prefixedConfig,
    });

    await upsertFileReview(env, source.id, {
      filePath: 'src/app.ts',
      fileStatus: 'done',
      modelUsed: 'gemini-3.1-flash-lite', // bare, as the model service actually stores it
      modelProvider: 'google',
      diffLineCount: 1,
      diffInput: 'old diff',
      rawAiOutput: '{}',
      parsedComments: [{
        path: 'src/app.ts',
        line: 1,
        position: 1,
        severity: 'P2',
        category: 'quality',
        title: 'Inherited finding',
        body: 'This comment must survive inheritance',
      }],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: 'comment',
      fileSummary: 'inherited-summary',
      errorMessage: null,
    });

    const retry = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 7,
      prTitle: 'Retry Prefix Match',
      prAuthor: 'author',
      commitSha: retryHeadSha,
      baseSha,
      trigger: 'retry',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: prefixedConfig,
      retryOfJobId: source.id,
    });

    await runAndDrain({
      jobId: retry.id,
      deliveryId: 'delivery-retry-prefix-match',
    });

    // The file must be inherited verbatim (bare model id + parent summary preserved), not re-reviewed.
    expect(reviewSpy).not.toHaveBeenCalled();
    const reviews = await getFileReviewsForJobs(env, [retry.id]);
    const inherited = reviews.find((review) => review.file_path === 'src/app.ts');
    expect(inherited?.model_used).toBe('gemini-3.1-flash-lite');
    expect(inherited?.file_summary).toBe('inherited-summary');
    // The parent's comments must be carried over by the bulk-inherit copy, not lost.
    expect(inherited?.parsed_comments).toHaveLength(1);
    expect((inherited?.parsed_comments as ParsedReviewComment[])[0]?.title).toBe('Inherited finding');
    reviewSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('resumes an existing queued duplicate job instead of stranding it', async () => {
    const repo = `test-repo-${Date.now()}-duplicate`;
    const headSha = sha('4');
    const baseSha = sha('5');

    const existing = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 4,
      prTitle: 'Duplicate Test',
      prAuthor: 'author',
      commitSha: headSha,
      baseSha,
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });

    await runAndDrain({
      deliveryId: 'delivery-duplicate',
      eventName: 'pull_request',
      payload: {
        action: 'opened',
        installation: { id: 123 },
        repository: { owner: { login: 'test-owner' }, name: repo },
        pull_request: {
          number: 4,
          head: { sha: headSha, ref: 'feature' },
          base: { sha: baseSha, ref: 'main' },
          title: 'Duplicate Test',
          user: { login: 'author' },
          draft: false,
        },
      },
    });

    const finalJob = await getJobForProcessing(env, existing.id);
    expect(finalJob?.status).toBe('done');
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('schedules a delayed continuation instead of spending queue retries on transient model failures', async () => {
    const { ModelService } = await import('@server/services/model');
    const retryableError = Object.assign(new Error('Google API timed out after 45000ms'), { retryable: true });
    const reviewSpy = vi.spyOn(ModelService.prototype, 'reviewFile').mockRejectedValue(retryableError);
    const repo = `test-repo-${Date.now()}-transient`;
    const headSha = sha('6');
    const baseSha = sha('7');

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 5,
      prTitle: 'Transient Test',
      prAuthor: 'author',
      commitSha: headSha,
      baseSha,
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    await updateJobFileCount(env, job.id, 1);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

    await runWithDb(env, async () => {
      (env.REVIEW_QUEUE as any).sent.length = 0;
      const result = await runReviewJob(env, {
        jobId: job.id,
        deliveryId: 'delivery-transient',
        phase: 'review',
      });

      // Transient model failure (not a subrequest limit) -> stays in-instance, freshInstance false.
      expect(result).toEqual({ action: 'next_phase', phase: 'review', delaySeconds: 30, jobId: expect.any(String), freshInstance: false });
      expect(reviewSpy).toHaveBeenCalled();
      expect((env.REVIEW_QUEUE as any).sent).toHaveLength(0);
    });

    const finalJob = await getJobForProcessing(env, job.id);
    expect(finalJob?.status).toBe('running');
    expect(finalJob?.lease_owner).toBeNull();

    reviewSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('reviews files in a chunk concurrently', async () => {
    const { GitHubService } = await import('@server/services/github');
    const { ModelService } = await import('@server/services/model');
    const repo = `test-repo-${Date.now()}-concurrent`;
    const headSha = sha('8');
    const baseSha = sha('9');
    const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([
        { path: 'src/one.ts', content: 'console.log(1);' },
        { path: 'src/two.ts', content: 'console.log(2);' },
      ]),
    );
    let active = 0;
    let maxActive = 0;
    const reviewSpy = vi.spyOn(ModelService.prototype as any, 'reviewFile').mockImplementation(async (params: any) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return {
        parsed: {
          comments: [],
          verdict: 'approve',
          fileSummary: `Reviewed ${params.file.path}`,
          overallCorrectness: 'no issues',
          confidenceScore: 0.9,
        },
        modelUsed: 'test-model',
        provider: 'test-provider',
        inputTokens: 10,
        outputTokens: 5,
        rawText: '{}',
        userPrompt: '',
      };
    });

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 6,
      prTitle: 'Concurrent Test',
      prAuthor: 'author',
      commitSha: headSha,
      baseSha,
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    await updateJobFileCount(env, job.id, 2);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

    await runWithDb(env, async () => {
      (env.REVIEW_QUEUE as any).sent.length = 0;
      const result = await runReviewJob(env, {
        jobId: job.id,
        deliveryId: 'delivery-concurrent',
        phase: 'review',
      });

      // Finalize always yields long enough to hibernate into a fresh invocation (fresh subrequest
      // budget), so the delay is the hibernation yield, not 0.
      // Transitioning into finalize -> runs on a fresh instance for a clean subrequest budget.
      expect(result).toEqual({ action: 'next_phase', phase: 'finalize', delaySeconds: expect.any(Number), jobId: expect.any(String), freshInstance: true });
      expect(result.action === 'next_phase' && result.delaySeconds).toBeGreaterThan(0);
      expect(maxActive).toBe(2);
      expect((env.REVIEW_QUEUE as any).sent).toHaveLength(0);
    });

    const reviews = await getFileReviewsForJobs(env, [job.id]);
    expect(reviews.filter((review) => review.file_status === 'done')).toHaveLength(2);

    reviewSpy.mockRestore();
    getDiffSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('marks completed jobs with skipped files as partial reviews', async () => {
    const { GitHubService } = await import('@server/services/github');
    const { ModelService } = await import('@server/services/model');
    const repo = `test-repo-${Date.now()}-partial`;
    const headSha = sha('e');
    const baseSha = sha('f');
    const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([
        { path: 'src/app.ts', content: 'console.log(1);' },
        { path: 'src/failed.ts', content: 'console.log(2);' },
      ]),
    );

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 7,
      prTitle: 'Partial Test',
      prAuthor: 'author',
      commitSha: headSha,
      baseSha,
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    const summarySpy = vi.spyOn(ModelService.prototype as any, 'generateSummary');
    await updateJobFileCount(env, job.id, 2);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
    await upsertFileReview(env, job.id, {
      filePath: 'src/app.ts',
      fileStatus: 'done',
      modelUsed: 'test-model',
      modelProvider: 'test-provider',
      diffLineCount: 1,
      diffInput: 'diff',
      rawAiOutput: '{}',
      parsedComments: [],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: 'approve',
      fileSummary: 'ok',
      errorMessage: null,
    });
    await upsertFileReview(env, job.id, {
      filePath: 'src/failed.ts',
      fileStatus: 'failed',
      modelUsed: 'gemma-4-31b-it',
      modelProvider: 'google',
      diffLineCount: 1,
      diffInput: '',
      rawAiOutput: null,
      parsedComments: [],
      inputTokens: null,
      outputTokens: null,
      durationMs: 1,
      verdict: null,
      fileSummary: null,
      errorMessage: 'Review skipped after 3 repeated model provider outages.',
    });

    await runWithDb(env, async () => {
      (env.REVIEW_QUEUE as any).sent.length = 0;
      const result = await runReviewJob(env, {
        jobId: job.id,
        deliveryId: 'delivery-partial',
        phase: 'finalize',
      });
      expect(result).toEqual({ action: 'ack' });
    });

    const finalJob = await getJobForProcessing(env, job.id);
    expect(finalJob?.status).toBe('done');
    expect(finalJob?.error_msg).toContain('Partial review: 1 of 2 files');
    const steps = typeof finalJob?.steps === 'string' ? JSON.parse(finalJob.steps) : finalJob?.steps;
    expect(steps?.find((step: { name: string }) => step.name === 'Completing')?.status).toBe('done');
    expect(finalJob?.summary_markdown).toMatch(/^### Codra Review/);
    expect(finalJob?.summary_model).toBeNull();
    expect(summarySpy).not.toHaveBeenCalled();
    summarySpy.mockRestore();
    getDiffSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('reuses an already-posted review instead of double-posting when finalize re-runs past the posting stage', async () => {
    const { GitHubService } = await import('@server/services/github');
    const repo = `test-repo-${Date.now()}-doublepost`;
    const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
    );
    // A prior finalize attempt already posted this review (id 999) but died before recording it, so
    // the GitHub lookup finds it. Finalize must reuse it, not post a second review.
    const findSpy = vi.spyOn(GitHubService.prototype, 'findBotReviewForCommit').mockResolvedValue({ id: 999 });
    const createSpy = vi.spyOn(GitHubService.prototype, 'createReview');

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 8,
      prTitle: 'Double Post Test',
      prAuthor: 'author',
      commitSha: sha('a1'),
      baseSha: sha('b1'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    await updateJobFileCount(env, job.id, 1);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
    // A prior finalize attempt reached the posting stage -- this is the marker the guard keys on.
    await updateJobStep(env, job.id, 'Completing', { status: 'running' });
    await upsertFileReview(env, job.id, {
      filePath: 'src/app.ts',
      fileStatus: 'done',
      modelUsed: 'test-model',
      modelProvider: 'test-provider',
      diffLineCount: 1,
      diffInput: 'diff',
      rawAiOutput: '{}',
      parsedComments: [],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: 'approve',
      fileSummary: 'ok',
      errorMessage: null,
    });

    await runWithDb(env, async () => {
      const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-doublepost', phase: 'finalize' });
      expect(result).toEqual({ action: 'ack' });
    });

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).not.toHaveBeenCalled();
    const finalJob = await getJobForProcessing(env, job.id);
    expect(finalJob?.status).toBe('done');
    expect(Number(finalJob?.review_id)).toBe(999);

    findSpy.mockRestore();
    createSpy.mockRestore();
    getDiffSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('does not pay the existing-review lookup on a first-pass finalize', async () => {
    const { GitHubService } = await import('@server/services/github');
    const repo = `test-repo-${Date.now()}-firstpass`;
    const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
    );
    const findSpy = vi.spyOn(GitHubService.prototype, 'findBotReviewForCommit');
    const createSpy = vi.spyOn(GitHubService.prototype, 'createReview');

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 9,
      prTitle: 'First Pass Test',
      prAuthor: 'author',
      commitSha: sha('c1'),
      baseSha: sha('d1'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    await updateJobFileCount(env, job.id, 1);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
    // 'Completing' has never been started -> this is a first-pass finalize, no re-post risk.
    await upsertFileReview(env, job.id, {
      filePath: 'src/app.ts',
      fileStatus: 'done',
      modelUsed: 'test-model',
      modelProvider: 'test-provider',
      diffLineCount: 1,
      diffInput: 'diff',
      rawAiOutput: '{}',
      parsedComments: [],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: 'approve',
      fileSummary: 'ok',
      errorMessage: null,
    });

    await runWithDb(env, async () => {
      const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-firstpass', phase: 'finalize' });
      expect(result).toEqual({ action: 'ack' });
    });

    expect(findSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
    const finalJob = await getJobForProcessing(env, job.id);
    expect(finalJob?.status).toBe('done');

    findSpy.mockRestore();
    createSpy.mockRestore();
    getDiffSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);
});
