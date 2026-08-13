import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRetryableModelError, ModelService } from '@server/services/model';


import { createTestEnv, saveTestProviderApiKey } from '../helpers';
import { defaultRepoConfig } from '@codra/schema';
import { TokenTracker } from '@server/core/token-tracker';

// Walking the model chain: fallback, the two subrequest-budget breakers, and marking a provider
// unavailable. The inline retry ladder lives in service-retries.spec.ts.
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
    // The primary makes 3 attempts before failing over; the fallback succeeds on the 4th call.
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

  // Parse lives inside the per-model try: an unreadable 200 is that model's failure.
  it('falls through to the next model when the primary returns an unparseable body', async () => {
    const geminiText = (text: string) => new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(geminiText('I am unable to review this diff.'))
      .mockResolvedValueOnce(geminiText('{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9}'));

    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = new ModelService(env);

    const response = await service.reviewFile({
      file: { path: 'src/app.ts', lineCount: 1, hunks: [], isDeleted: false, isBinary: false, isNew: false, previousPath: null },
      prTitle: 'Test',
      prDescription: null,
      config: {
        ...defaultRepoConfig,
        model: { main: 'gemini-3.1-pro-preview', fallbacks: ['gemini-2.5-pro'], size_overrides: [] },
      },
      totalLineCount: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.modelUsed).toBe('gemini-2.5-pro');
  });

  // Three `continue` paths can leave the loop with `lastError` undefined, which matches no retry
  // predicate and fails the file permanently.
  it('defers rather than throwing undefined when every model is skipped', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = new ModelService(env);
    // A learned bucket below the prompt size makes skipReason refuse every model.
    (service as unknown as { rateLimits: { skipReason: () => string } }).rateLimits.skipReason = () => 'prompt too large for its bucket';

    const promise = service.reviewFile({
      file: { path: 'src/app.ts', lineCount: 1, hunks: [], isDeleted: false, isBinary: false, isNew: false, previousPath: null },
      prTitle: 'Test',
      prDescription: null,
      config: {
        ...defaultRepoConfig,
        model: { main: 'gemini-3.1-pro-preview', fallbacks: ['gemini-2.5-pro'], size_overrides: [] },
      },
      totalLineCount: 1,
    });

    await expect(promise).rejects.toThrow(/No configured review model was attempted/);
    await promise.catch((error) => expect(isRetryableModelError(error)).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Regression: the tail of the chain used to be exempt from the timeout breaker entirely, so a model
  // that had never once answered on a job still cost every unit a full per-call budget -- 20 batches
  // and 15 minutes of wall clock in production, all of it spent to re-learn the tally's verdict.
  it('drops even the last candidate once it has never answered on this job', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const env = createTestEnv();
    await saveTestProviderApiKey(env);

    // Six strikes: past the tail's higher bar, which a merely-slow model does not reach.
    await env.APP_KV.put(
      'jobs:job-tail-drop:chain-progress',
      JSON.stringify({ timeouts: { 'gemini-3.1-pro-preview': 6, 'gemini-2.5-pro': 6 } }),
    );
    const service = new ModelService(env, undefined, { jobId: 'job-tail-drop' });

    const promise = service.reviewFile({
      file: { path: 'src/app.ts', lineCount: 1, hunks: [], isDeleted: false, isBinary: false, isNew: false, previousPath: null },
      prTitle: 'Test',
      prDescription: null,
      config: {
        ...defaultRepoConfig,
        model: { main: 'gemini-3.1-pro-preview', fallbacks: ['gemini-2.5-pro'], size_overrides: [] },
      },
      totalLineCount: 1,
    });

    // Deferred, and the message says which of the two skip reasons applied.
    await expect(promise).rejects.toThrow(/No configured review model was attempted.*repeated timeouts/);
    await promise.catch((error) => expect(isRetryableModelError(error)).toBe(true));
    // The whole point: not one call was paid for.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The other side of the same rule: a merely-slow tail still gets its shot, because deferring with no
  // model attempted is the worse outcome when the model does sometimes answer.
  it('still tries the last candidate when it is only mid-chain slow', async () => {
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

    // Three strikes drops a model mid-chain but not at the tail.
    await env.APP_KV.put(
      'jobs:job-tail-slow:chain-progress',
      JSON.stringify({ timeouts: { 'gemini-3.1-pro-preview': 3, 'gemini-2.5-pro': 3 } }),
    );
    const service = new ModelService(env, undefined, { jobId: 'job-tail-slow' });

    const response = await service.reviewFile({
      file: { path: 'src/app.ts', lineCount: 1, hunks: [], isDeleted: false, isBinary: false, isNew: false, previousPath: null },
      prTitle: 'Test',
      prDescription: null,
      config: {
        ...defaultRepoConfig,
        model: { main: 'gemini-3.1-pro-preview', fallbacks: ['gemini-2.5-pro'], size_overrides: [] },
      },
      totalLineCount: 1,
    });

    // The struck primary is skipped, the tail is attempted anyway, and it answers.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/models/gemini-2.5-pro:generateContent');
    expect(response.modelUsed).toBe('gemini-2.5-pro');
  });

  it('surfaces a permanent config error rather than deferring', async () => {
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = new ModelService(env);

    const promise = service.reviewFile({
      file: { path: 'src/app.ts', lineCount: 1, hunks: [], isDeleted: false, isBinary: false, isNew: false, previousPath: null },
      prTitle: 'Test',
      prDescription: null,
      config: {
        ...defaultRepoConfig,
        model: { main: 'definitely-not-a-configured-model', fallbacks: [], size_overrides: [] },
      },
      totalLineCount: 1,
    });

    await expect(promise).rejects.toThrow(/is not configured/);
    await promise.catch((error) => expect(isRetryableModelError(error)).toBe(false));
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

  // The counterpart to the test above: the primary gets its shot at a merely-tight budget, but not at
  // one that cannot cover the call. Previously it transmitted the prompt regardless and the runtime
  // refused it, losing the unit AND the prompt -- three files' worth in one observed invocation.
  it('will not commit a prompt when the budget cannot cover the call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const tracker = new TokenTracker();
    // Leaves 5 of the 50-subrequest cap, under the headroom one call may need.
    tracker.incrementSubrequests(45);
    const service = new ModelService(env, tracker);

    const promise = service.reviewFile({
      file: { path: 'src/app.ts', lineCount: 1, hunks: [], isDeleted: false, isBinary: false, isNew: false, previousPath: null },
      prTitle: 'Test',
      prDescription: null,
      config: {
        ...defaultRepoConfig,
        model: { main: 'gemini-3.1-pro-preview', fallbacks: ['gemini-2.5-pro'], size_overrides: [] },
      },
      totalLineCount: 1,
    });

    // Deferred, not failed: a fresh invocation has a fresh budget.
    await expect(promise).rejects.toThrow(/retrying later/);
    await promise.catch((error) => expect(isRetryableModelError(error)).toBe(true));
    // The whole point -- nothing went over the wire.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips remaining fallback models (instead of spending more of the shared budget) once near the subrequest limit', async () => {
    // The primary retries internally, so return a fresh Response per call (a body reads once).
    // 503, not 500: only a genuinely transient failure produces a retryable deferral.
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

    // Only the primary model was attempted; the fallback was skipped rather than risking tipping
    // the shared invocation over Cloudflare's subrequest cap, deferring the file for a later retry.
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
