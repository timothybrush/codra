import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRetryableModelError, ModelService } from '@server/services/model';
import { reviewWithGoogle } from '@server/models/google';
import { createTestEnv, saveTestProviderApiKey } from './helpers';
import { defaultRepoConfig } from '@shared/schema';

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
function quotaResponse(retryInSeconds: number, model = 'gemma-4-31b') {
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

  // Google routinely asks for a 30-60s cool-off while our in-call sleep is capped at 5s. Retrying
  // early is guaranteed to hit the same 429, so it only spends subrequests we do not have.
  it('does not retry a 429 whose cool-off is longer than we are willing to wait', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => quotaResponse(56));

    await expect(
      reviewWithGoogle({ apiKey: 'k', providerName: 'Google' }, 'gemma-4-31b-it', {
        systemPrompt: 's',
        userPrompt: 'u',
      }),
    ).rejects.toThrow(/429/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries a 429 whose cool-off it can actually honour', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => quotaResponse(1));

    await expect(
      reviewWithGoogle({ apiKey: 'k', providerName: 'Google' }, 'gemma-4-31b-it', {
        systemPrompt: 's',
        userPrompt: 'u',
      }),
    ).rejects.toThrow(/429/);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  // The subrequest blowout: nine models x three attempts for one file, against a per-file budget
  // of a handful. Each model has its own quota bucket so a couple of attempts are worth making,
  // but past that the file must be deferred rather than walking the rest of the chain.
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
            main: 'gemma-4-31b-it',
            fallbacks: ['gemma-4-26b-a4b-it', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'],
            size_overrides: [],
          },
        },
      }),
    ).rejects.toSatisfy(isRetryableModelError);

    // Two models attempted, one call each -- not five models at three calls apiece.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const attempted = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(attempted.some((url) => url.includes('gemma-4-31b-it'))).toBe(true);
    expect(attempted.some((url) => url.includes('gemma-4-26b-a4b-it'))).toBe(true);
    expect(attempted.some((url) => url.includes('gemini'))).toBe(false);
  });
});

/** A minimal successful review, in the shape the Google adapter unwraps. */
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

/**
 * ONE token-metered model at the head, deliberately.
 *
 * With two (as the real chain has: gemma-4-31b then gemma-4-26b), a file that 429s on both hits
 * MAX_QUOTA_FAILURES_PER_FILE and is deferred BEFORE it ever reaches the cheaper models -- which the
 * test above already pins. That interaction would mask what these tests are about, so the chain here
 * keeps a single metered model so the fall-through is observable.
 *
 * Worth knowing in production terms: the skip logic below improves the two-gemma case for exactly
 * that reason. A skipped model records no quota failure, so later files keep their full failure
 * budget and reach a model that can answer on the first attempt instead of being deferred.
 */
const chain = {
  ...defaultRepoConfig,
  model: {
    main: 'gemma-4-31b-it',
    fallbacks: ['gemini-3.1-flash-lite'],
    size_overrides: [],
  },
};

/**
 * Google's free tier meters INPUT TOKENS PER MINUTE (16,000), not requests, and states both the
 * bucket size and the cool-off in its 429 body. These tests cover the two ways that budget was
 * being burned on calls that could not succeed -- which is what starved the stronger models and,
 * because each wasted probe costs a subrequest against a budget of ~25, is what actually produced
 * the "Too many subrequests" file failures.
 */
describe('learning a provider rate limit from its own 429', () => {
  afterEach(() => vi.restoreAllMocks());

  function googleMock(onGemma: () => Response) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      return url.includes('gemma') ? onGemma() : reviewResponse();
    });
  }

  // The behaviour that recovers subrequests: a model that has just reported a cool-off must not be
  // re-probed by the NEXT file. The quota-failure counter was a local inside the per-file loop, so
  // every file rediscovered the same limit at the cost of one subrequest each.
  it('skips a cooling-off model for subsequent files instead of re-probing it', async () => {
    const fetchMock = googleMock(() => quotaResponse(56));
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = new ModelService(env);
    const params = { prTitle: 'Test', prDescription: null, totalLineCount: 1, config: chain };

    // First file: both gemma models 429, then gemini answers.
    await service.reviewFile({ ...params, file });
    const afterFirst = fetchMock.mock.calls.length;
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('gemma'))).toBe(true);

    // Second file: the gemma cool-offs are known, so it goes straight to gemini -- one call.
    fetchMock.mockClear();
    await service.reviewFile({ ...params, file: { ...file, path: 'src/second.ts' } });

    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((url) => url.includes('gemma'))).toBe(false);
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(afterFirst).toBeGreaterThan(1);
  });

  // A prompt bigger than the entire per-minute bucket can never succeed no matter how long we wait,
  // so once the bucket size is known it must not be spent on the 429 either.
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
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((url) => url.includes('gemma'))).toBe(false);
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  // Small files must still reach the stronger model once its cool-off lapses -- the whole point is
  // to stop wasting the bucket, not to retire the model.
  it('returns to the primary model once its cool-off has expired', async () => {
    let gemmaCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (!url.includes('gemma')) return reviewResponse();
      gemmaCalls += 1;
      return gemmaCalls === 1 ? quotaResponse(1) : reviewResponse();
    });

    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = new ModelService(env);
    const params = { prTitle: 'Test', prDescription: null, totalLineCount: 1, config: chain };

    await service.reviewFile({ ...params, file });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    fetchMock.mockClear();
    const second = await service.reviewFile({ ...params, file: { ...file, path: 'src/third.ts' } });

    expect(second.modelUsed).toContain('gemma');
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((url) => url.includes('gemma'))).toBe(true);
  });
});
