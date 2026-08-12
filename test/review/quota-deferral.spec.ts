import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRetryableModelError, ModelService } from '@server/services/model';
import { reviewWithGoogle } from '@server/models/google';
import { createTestEnv, saveTestProviderApiKey } from '../helpers';
import { defaultRepoConfig } from '@codra/schema';

const file = {
  path: 'src/app.ts',
  lineCount: 1,
  hunks: [],
  isDeleted: false,
  isBinary: false,
  isNew: false,
  previousPath: null,
};

// Mirrors the real Free-tier body: the cool-off is stated in the message, not only in a header.
function quotaResponse(retryInSeconds: number, model = 'gemini-3.1-pro-preview') {
  return new Response(
    JSON.stringify({
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message:
          'You exceeded your current quota, please check your plan and billing details. '
          + `* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 16000, model: ${model}`
          + `\nPlease retry in ${retryInSeconds}s.`,
      },
    }),
    { status: 429, headers: { 'content-type': 'application/json' } },
  );
}

describe('quota 429 handling', () => {
  afterEach(() => vi.restoreAllMocks());

  // Google asks for 30-60s while our in-call sleep caps at 5s, so retrying early only spends
  // subrequests on a guaranteed second 429.
  it('does not retry a 429 whose cool-off is longer than we are willing to wait', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => quotaResponse(56));

    await expect(
      reviewWithGoogle({ apiKey: 'k', providerName: 'Google' }, 'gemini-3.1-pro-preview', {
        systemPrompt: 's',
        userPrompt: 'u',
      }),
    ).rejects.toThrow(/429/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries a 429 whose cool-off it can actually honour', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => quotaResponse(1));

    await expect(
      reviewWithGoogle({ apiKey: 'k', providerName: 'Google' }, 'gemini-3.1-pro-preview', {
        systemPrompt: 's',
        userPrompt: 'u',
      }),
    ).rejects.toThrow(/429/);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  // The subrequest blowout: nine models x three attempts for one file. Each model has its own
  // bucket, so a couple of attempts are worth making, but past that the file must be deferred.
  it('stops walking a long fallback chain after two quota failures and defers the file', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => quotaResponse(56));
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = new ModelService(env);

    await expect(
      service.reviewFile({
        file,
        prTitle: 'Test',
        prDescription: null,
        totalLineCount: 1,
        config: {
          ...defaultRepoConfig,
          model: {
            main: 'gemini-3.1-pro-preview',
            fallbacks: ['gemini-2.5-pro', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'],
            size_overrides: [],
          },
        },
      }),
    ).rejects.toSatisfy(isRetryableModelError);

    // Two models attempted, one call each -- not five models at three calls apiece.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const attempted = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(attempted.some((url) => url.includes('gemini-3.1-pro-preview'))).toBe(true);
    expect(attempted.some((url) => url.includes('gemini-2.5-pro'))).toBe(true);
    // Only ids seeded in GOOGLE_TEST_MODEL_IDS are asserted: an unseeded id issues no fetch
    // regardless, so asserting on one would pass even with the break removed.
    expect(attempted.some((url) => url.includes('gemini-3.1-flash-lite'))).toBe(false);
  });
});

// A minimal successful review, in the shape the Google adapter unwraps.
function reviewResponse() {
  return new Response(
    JSON.stringify({
      candidates: [{
        content: { parts: [{ text: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok"}' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// ONE token-metered model at the head: with two, a file that 429s on both hits
// MAX_QUOTA_FAILURES_PER_FILE and defers before reaching the cheaper models, masking these tests.
const chain = {
  ...defaultRepoConfig,
  model: {
    main: 'gemini-3.1-pro-preview',
    fallbacks: ['gemini-3.1-flash-lite'],
    size_overrides: [],
  },
};

// Google's free tier meters INPUT TOKENS PER MINUTE (16,000), not requests, stating both bucket
// and cool-off in the 429 body. These cover the two ways that budget was burned on calls that
// could not succeed -- each wasted probe costing a subrequest against a budget of ~25.
describe('learning a provider rate limit from its own 429', () => {
  afterEach(() => vi.restoreAllMocks());

  function googleMock(onMetered: () => Response) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      return url.includes('pro-preview') ? onMetered() : reviewResponse();
    });
  }

  // A model that just reported a cool-off must not be re-probed by the NEXT file. The counter was
  // a local inside the per-file loop, so every file rediscovered the limit for one subrequest.
  it('skips a cooling-off model for subsequent files instead of re-probing it', async () => {
    const fetchMock = googleMock(() => quotaResponse(56));
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = new ModelService(env);
    const params = { prTitle: 'Test', prDescription: null, totalLineCount: 1, config: chain };

    // First file: the metered model 429s, then the fallback answers.
    await service.reviewFile({ ...params, file });
    const afterFirst = fetchMock.mock.calls.length;
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('pro-preview'))).toBe(true);

    // Second file: the cool-off is known, so it goes straight to the fallback -- one call.
    fetchMock.mockClear();
    await service.reviewFile({ ...params, file: { ...file, path: 'src/second.ts' } });

    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((url) => url.includes('pro-preview'))).toBe(false);
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(afterFirst).toBeGreaterThan(1);
  });

  // A prompt bigger than the whole bucket can never succeed, so once the size is known it must
  // not be spent on the 429 either.
  it('skips a model whose whole token bucket is smaller than the prompt', async () => {
    const fetchMock = googleMock(() => quotaResponse(1));
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = new ModelService(env);
    const params = { prTitle: 'Test', prDescription: null, totalLineCount: 1, config: chain };

    // Teach it the 16,000-token bucket with a small file, and let the cool-off lapse.
    await service.reviewFile({ ...params, file });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // ~300 long lines is well past 16,000 tokens once rendered, but under the 800-line chunk cap.
    const hugeFile = {
      ...file,
      path: 'src/huge.ts',
      lineCount: 300,
      hunks: [{
        header: '@@ -1,300 +1,300 @@',
        lines: Array.from({ length: 300 }, (_, i) => ({
          kind: 'add' as const,
          content: `const value${i} = ${'x'.repeat(240)};`,
          newLineNumber: i + 1,
          position: i + 1,
        })),
      }],
    };

    fetchMock.mockClear();
    await service.reviewFile({ ...params, file: hugeFile });

    // Cool-off has expired, so this is the size rule alone doing the work.
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((url) => url.includes('pro-preview'))).toBe(false);
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  // The book used to be in-memory on ModelService, so it died with the invocation. A job runs up to
  // 20 continuations, and each fresh invocation re-paid a full-prompt 429 to re-learn a cool-off the
  // previous one had already been told about -- the single largest source of wasted input tokens.
  it('carries a cool-off to the next invocation of the same job', async () => {
    const fetchMock = googleMock(() => quotaResponse(56));
    // MemoryKV persists across ModelService instances, standing in for a continuation handoff.
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const params = { prTitle: 'Test', prDescription: null, totalLineCount: 1, config: chain };

    const first = new ModelService(env, undefined, { jobId: 'job-continuation' });
    await first.reviewFile({ ...params, file });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('pro-preview'))).toBe(true);

    // A brand-new service, as a fresh invocation would build.
    fetchMock.mockClear();
    const next = new ModelService(env, undefined, { jobId: 'job-continuation' });
    await next.reviewFile({ ...params, file: { ...file, path: 'src/second.ts' } });

    // The metered model is never probed again: no 429, no wasted prompt.
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((url) => url.includes('pro-preview'))).toBe(false);
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it('keeps a cool-off scoped to its own job and model', async () => {
    const fetchMock = googleMock(() => quotaResponse(56));
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const params = { prTitle: 'Test', prDescription: null, totalLineCount: 1, config: chain };

    await new ModelService(env, undefined, { jobId: 'job-a' }).reviewFile({ ...params, file });

    // An unrelated job must not inherit it: each Gemini model meters per project, but a stale
    // cool-off leaking across jobs would silently narrow coverage with no re-probe path.
    fetchMock.mockClear();
    await new ModelService(env, undefined, { jobId: 'job-b' }).reviewFile({ ...params, file });

    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((url) => url.includes('pro-preview'))).toBe(true);
  });

  // Small files must still reach the stronger model once its cool-off lapses.
  it('returns to the primary model once its cool-off has expired', async () => {
    let meteredCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (!url.includes('pro-preview')) return reviewResponse();
      meteredCalls += 1;
      return meteredCalls === 1 ? quotaResponse(1) : reviewResponse();
    });

    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = new ModelService(env);
    const params = { prTitle: 'Test', prDescription: null, totalLineCount: 1, config: chain };

    await service.reviewFile({ ...params, file });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    fetchMock.mockClear();
    const second = await service.reviewFile({ ...params, file: { ...file, path: 'src/third.ts' } });

    expect(second.modelUsed).toContain('pro-preview');
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((url) => url.includes('pro-preview'))).toBe(true);
  });
});
