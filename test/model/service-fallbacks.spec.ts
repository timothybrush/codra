import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRetryableModelError, ModelService } from '@server/services/model';


import { createTestEnv, saveTestProviderApiKey } from '../helpers';
import { defaultRepoConfig } from '@shared/schema';
import { TokenTracker } from '@server/core/token-tracker';

// Walking the configured model chain: falling back to a smaller model, the two subrequest-budget
// breakers that stop the chain early, and marking a provider unavailable for the rest of a job.
// The inline retry ladder lives in model-service-retries.spec.ts.
describe('ModelService: chain fallback, budget breakers and provider availability', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tries the smaller Google fallback after the primary Google model fails', async () => {
    let cloudflareCalls = 0;
    const gemini500 = () =>
      new Response(
        JSON.stringify({ error: { code: 500, message: 'Internal error encountered.', status: 'INTERNAL' } }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      );
    // GEMINI_MAX_RETRIES = 2, so the primary model makes 3 attempts (initial + 2 retries) before
    // failing over; then the smaller fallback succeeds on the 4th call.
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(gemini500())
      .mockResolvedValueOnce(gemini500())
      .mockResolvedValueOnce(gemini500())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9}' }] } }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const env = createTestEnv({
      AI: {
        async run() {
          cloudflareCalls++;
          return {
            response: JSON.stringify({
              findings: [],
              overall_correctness: 'patch is correct',
              overall_explanation: 'ok',
              overall_confidence_score: 0.9,
            }),
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      } as any,
    });
    await saveTestProviderApiKey(env);
    const service = new ModelService(env);

    const response = await service.reviewFile({
      file: {
        path: 'src/app.ts',
        lineCount: 1,
        hunks: [],
        isDeleted: false,
        isBinary: false,
        isNew: false,
        previousPath: null,
      },
      prTitle: 'Test',
      prDescription: null,
      config: {
        ...defaultRepoConfig,
        model: {
          main: 'gemini-3.1-pro-preview',
          fallbacks: ['gemini-2.5-pro', '@cf/zai-org/glm-4.7-flash'],
          size_overrides: [],
        },
      },
      totalLineCount: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/models/gemini-3.1-pro-preview:generateContent');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/models/gemini-3.1-pro-preview:generateContent');
    expect(String(fetchMock.mock.calls[2][0])).toContain('/models/gemini-3.1-pro-preview:generateContent');
    expect(String(fetchMock.mock.calls[3][0])).toContain('/models/gemini-2.5-pro:generateContent');
    expect(cloudflareCalls).toBe(0);
    expect(response.modelUsed).toBe('gemini-2.5-pro');
  });

  it('still tries the primary model even when the shared job budget is already near the subrequest limit', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9}' }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const tracker = new TokenTracker();
    tracker.incrementSubrequests(40); // above the near-limit threshold (MAX_SUBREQUESTS 50 - SAFE_MARGIN 25)
    const service = new ModelService(env, tracker);

    const response = await service.reviewFile({
      file: {
        path: 'src/app.ts',
        lineCount: 1,
        hunks: [],
        isDeleted: false,
        isBinary: false,
        isNew: false,
        previousPath: null,
      },
      prTitle: 'Test',
      prDescription: null,
      config: {
        ...defaultRepoConfig,
        model: {
          main: 'gemini-3.1-pro-preview',
          fallbacks: ['gemini-2.5-pro'],
          size_overrides: [],
        },
      },
      totalLineCount: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.modelUsed).toBe('gemini-3.1-pro-preview');
  });

  it('skips remaining fallback models (instead of spending more of the shared budget) once near the subrequest limit', async () => {
    // Google's client retries a 5xx once internally before giving up on a model, so the
    // primary model alone can issue more than one raw fetch call; return a fresh Response for
    // every call so retries do not reuse an already-consumed body. Use a 503/"unavailable"
    // (a genuinely transient failure) so the near-limit skip produces a retryable deferral --
    // a 500 "internal error" is now treated as a permanent failure and would not defer.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({ error: { code: 503, message: 'The model is overloaded and currently unavailable.', status: 'UNAVAILABLE' } }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ),
    );
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const tracker = new TokenTracker();
    tracker.incrementSubrequests(40); // above the near-limit threshold (MAX_SUBREQUESTS 50 - SAFE_MARGIN 25)
    const service = new ModelService(env, tracker);

    await expect(
      service.reviewFile({
        file: {
          path: 'src/app.ts',
          lineCount: 1,
          hunks: [],
          isDeleted: false,
          isBinary: false,
          isNew: false,
          previousPath: null,
        },
        prTitle: 'Test',
        prDescription: null,
        config: {
          ...defaultRepoConfig,
          model: {
            main: 'gemini-3.1-pro-preview',
            fallbacks: ['gemini-2.5-pro'],
            size_overrides: [],
          },
        },
        totalLineCount: 1,
      }),
    ).rejects.toSatisfy(isRetryableModelError);

    // Only the primary model was attempted (possibly with its own internal retry); the
    // fallback model was skipped rather than risking tipping the shared invocation over
    // Cloudflare's subrequest cap. The file is deferred for a later retry (via the
    // RetryableModelError) instead of being burned through here.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain('/models/gemini-3.1-pro-preview:generateContent');
    }
  });

  it('skips Cloudflare for the rest of a job after allocation is exhausted', async () => {
    let cloudflareCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"findings":[]}' }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const env = createTestEnv({
      AI: {
        async run() {
          cloudflareCalls++;
          throw new Error('Cloudflare daily free allocation exhausted (4006)');
        },
      } as any,
    });
    await saveTestProviderApiKey(env);
    const service = new ModelService(env, undefined, { jobId: 'job-provider-skip' });
    const file = {
      path: 'src/app.ts',
      lineCount: 1,
      hunks: [],
      isDeleted: false,
      isBinary: false,
      isNew: false,
      previousPath: null,
    };
    const config = {
      ...defaultRepoConfig,
      model: {
        main: '@cf/zai-org/glm-4.7-flash',
        fallbacks: ['gemini-3.1-pro-preview'],
        size_overrides: [],
      },
    };

    await service.reviewFile({
      file,
      prTitle: 'Test',
      prDescription: null,
      config,
      totalLineCount: 1,
    });
    await service.reviewFile({
      file: { ...file, path: 'src/other.ts' },
      prTitle: 'Test',
      prDescription: null,
      config,
      totalLineCount: 1,
    });

    expect(cloudflareCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
