import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRetryableModelError, ModelService } from '@server/services/model';
import { reviewWithCloudflare } from '@server/models/cloudflare';
import { reviewWithGoogle } from '@server/models/google';


import { buildReviewResponseSchema } from '@server/prompts/file-review';
import { createTestEnv, saveTestProviderApiKey } from '../helpers';
import { defaultRepoConfig } from '@shared/schema';

// The retry ladder: inline retries, Retry-After, and which exhausted runs report as retryable.
describe('ModelService: transient failures and the retry ladder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries Google once for transient 524 edge timeouts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 524, message: 'A timeout occurred.' } }),
          { status: 524, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9}' }] } }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const response = await reviewWithGoogle(
      { apiKey: 'test-key' },
      'gemini-3.1-pro-preview',
      { systemPrompt: 'system', userPrompt: 'user' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.rawText).toContain('"findings"');
  });

  it('honours a Retry-After it can actually wait out', async () => {
    // retry-after: 3s is inside GEMINI_MAX_RETRY_DELAY_MS (5s), so the retry fires at exactly 3s
    // -- the provider's own cool-off, not our default backoff.
    vi.useFakeTimers();
    try {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: { code: 429, message: 'Rate limited.' } }),
            { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9}' }] } }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );

      const promise = reviewWithGoogle(
        { apiKey: 'test-key' },
        'gemini-3.1-pro-preview',
        { systemPrompt: 'system', userPrompt: 'user' },
      );
      promise.catch(() => {});

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(2_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      const response = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(response.rawText).toContain('"findings"');
    } finally {
      vi.useRealTimers();
    }
  });

  // A cool-off we cannot honour isn't worth a retry: waking early earns the same 429.

  it('gives up immediately on a Retry-After longer than the in-call sleep cap', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 429, message: 'Rate limited.' } }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '56' } },
      ),
    );

    await expect(
      reviewWithGoogle({ apiKey: 'test-key' }, 'gemini-3.1-pro-preview', { systemPrompt: 'system', userPrompt: 'user' }),
    ).rejects.toThrow(/429/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The free-tier buckets are per-minute, so an unstated cool-off is ~60s by construction. Backing
  // off ~0.8s then ~1.6s bought two more 429s and two more full prompt transmissions for nothing.
  it('gives up immediately on a 429 that states no cool-off at all', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted.' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(
      reviewWithGoogle({ apiKey: 'test-key' }, 'gemini-3.1-pro-preview', { systemPrompt: 'system', userPrompt: 'user' }),
    ).rejects.toThrow(/429/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries a 5xx with no Retry-After, which is a genuinely transient blip', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 503, message: 'The model is overloaded.' } }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9}' }] } }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const response = await reviewWithGoogle(
      { apiKey: 'test-key' },
      'gemini-3.1-pro-preview',
      { systemPrompt: 'system', userPrompt: 'user' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.rawText).toContain('"findings"');
  });

  it('does not retry TypeErrors thrown after a successful Google response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => {
        throw new TypeError('parser exploded after response');
      },
    } as unknown as Response);

    await expect(
      reviewWithGoogle(
        { apiKey: 'test-key' },
        'gemini-3.1-pro-preview',
        { systemPrompt: 'system', userPrompt: 'user' },
      ),
    ).rejects.toThrow('parser exploded after response');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A 400 matches no transient pattern, so a grammar-rejecting endpoint fails permanently.
  describe('response-grammar rejection', () => {
    function geminiOk() {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9}' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    function gemini400(message: string) {
      return new Response(
        JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    const withGrammar = { systemPrompt: 'system', userPrompt: 'user', responseSchema: buildReviewResponseSchema(10) };

    it('drops the grammar and retries once when Gemini rejects responseJsonSchema', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(gemini400('Unknown name "responseJsonSchema" at \'generation_config\': Cannot find field.'))
        .mockResolvedValueOnce(geminiOk());

      const response = await reviewWithGoogle({ apiKey: 'test-key' }, 'gemini-3.1-pro-preview', withGrammar);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).generationConfig.responseJsonSchema).toBeDefined();
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).generationConfig.responseJsonSchema).toBeUndefined();
      expect(response.rawText).toContain('"findings"');
      // Surfaced so the "Test connection" preflight cannot call a grammar-incapable endpoint working.
      expect(response.degraded).toBe('schema-dropped');

      // The probe is not spent on an unrelated 400, nor when there was no grammar to drop.
      for (const [message, input] of [
        ['API key not valid. Please pass a valid API key.', withGrammar],
        ['Invalid value at generation_config.schema.', { systemPrompt: 'system', userPrompt: 'user' }],
      ] as Array<[string, any]>) {
        vi.restoreAllMocks();
        const guarded = vi.spyOn(globalThis, 'fetch').mockResolvedValue(gemini400(message));
        await expect(
          reviewWithGoogle({ apiKey: 'test-key' }, 'gemini-3.1-pro-preview', input),
        ).rejects.toThrow(/400/);
        expect(guarded).toHaveBeenCalledTimes(1);
      }
    });

    // The latch used to be set only when the schema-less retry SUCCEEDED. If that retry then 429'd,
    // the next call re-probed with the grammar -- a wasted 400 plus a second full prompt, every call.
    it('latches the grammar off even when the schema-less retry itself fails', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        // Grammar rejected, then the schema-less probe fails for an unrelated reason. Deliberately
        // not a 429: that would cool the model off and the second review would skip it entirely,
        // masking whether the latch held.
        .mockResolvedValueOnce(gemini400('Unknown name "responseJsonSchema" at \'generation_config\'.'))
        .mockResolvedValueOnce(gemini400('API key not valid. Please pass a valid API key.'))
        .mockResolvedValue(geminiOk());

      const env = createTestEnv();
      await saveTestProviderApiKey(env);
      const service = new ModelService(env);
      const params = {
        file: { path: 'src/app.ts', lineCount: 1, hunks: [], isDeleted: false, isBinary: false, isNew: false, previousPath: null },
        prTitle: 'Test',
        prDescription: null,
        config: {
          ...defaultRepoConfig,
          model: { main: 'gemini-3.1-pro-preview', fallbacks: [], size_overrides: [] },
        },
        totalLineCount: 1,
      };

      await expect(service.reviewFile(params)).rejects.toThrow();
      const callsAfterFirstReview = fetchMock.mock.calls.length;

      await service.reviewFile(params);

      // The second review goes straight out without the grammar: no re-probe, no wasted 400.
      const firstCallOfSecondReview = fetchMock.mock.calls[callsAfterFirstReview];
      expect(JSON.parse(String(firstCallOfSecondReview?.[1]?.body)).generationConfig.responseJsonSchema).toBeUndefined();
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirstReview + 1);
    });

    // Observed in production: Gemini 3.x sends a generic top-level message and puts the real reason
// in `details`. Without reading it the grammar rejection looked like an unrelated 400 and the model
    // was dropped from the chain entirely.
    it('reads the rejection reason out of error.details, not just the message', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(
          JSON.stringify({
            error: {
              code: 400,
              status: 'INVALID_ARGUMENT',
              message: 'Request contains an invalid argument.',
              details: [{
                '@type': 'type.googleapis.com/google.rpc.BadRequest',
                fieldViolations: [{
                  description: 'The specified schema produces a constraint that has too many states for serving.',
                }],
              }],
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ))
        .mockResolvedValueOnce(geminiOk());

      const response = await reviewWithGoogle({ apiKey: 'test-key' }, 'gemini-3.1-pro-preview', withGrammar);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).generationConfig.responseJsonSchema).toBeUndefined();
      expect(response.degraded).toBe('schema-dropped');
    });

    it('gives the attempt back for the probe, but only once', async () => {
      // The probe isn't a transient rung: without the give-back, a ladder spent on 5xx could never
      // drop the schema. The latch stops it looping.
      const gemini500 = () => new Response(JSON.stringify({ error: { code: 500, message: 'Internal error encountered.' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      const ladderSpent = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(gemini500())
        .mockResolvedValueOnce(gemini500())
        .mockResolvedValueOnce(gemini400('Unknown name "responseJsonSchema" at \'generation_config\'.'))
        .mockResolvedValueOnce(geminiOk());

      const response = await reviewWithGoogle({ apiKey: 'test-key' }, 'gemini-3.1-pro-preview', withGrammar);

      expect(ladderSpent).toHaveBeenCalledTimes(4);
      expect(JSON.parse(String(ladderSpent.mock.calls[3]?.[1]?.body)).generationConfig.responseJsonSchema).toBeUndefined();
      expect(response.degraded).toBe('schema-dropped');

      // mockImplementation, not mockResolvedValue: a retried call cannot re-read one Response body.
      vi.restoreAllMocks();
      const persistent = vi.spyOn(globalThis, 'fetch')
        .mockImplementation(async () => gemini400('Invalid JSON payload received. Unknown name "responseJsonSchema".'));

      await expect(
        reviewWithGoogle({ apiKey: 'test-key' }, 'gemini-3.1-pro-preview', withGrammar),
      ).rejects.toThrow(/400/);

      // Two, not three and not unbounded: one with the grammar, one without, then throw.
      expect(persistent).toHaveBeenCalledTimes(2);
    });

  });

  it('does not spend an extra queue slice retrying the same Cloudflare model inline', async () => {
    let attempts = 0;
    const env = createTestEnv({
      AI: {
        async run() {
          attempts++;
          throw new Error('temporary provider error');
        },
      } as any,
    });

    await expect(
      reviewWithCloudflare(env, '@cf/zai-org/glm-4.7-flash', {
        systemPrompt: 'system',
        userPrompt: 'user',
      }),
    ).rejects.toThrow('temporary provider error');
    expect(attempts).toBe(1);
  });

  it('aborts and fails fast (as a retryable timeout) when a Cloudflare model hangs past the timeout', async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      const env = createTestEnv({
        AI: {
          run(_model: string, _request: any, options?: { signal?: AbortSignal }) {
            capturedSignal = options?.signal;
            // Model never responds -- only the timeout can end this call.
            return new Promise(() => {});
          },
        } as any,
      });

      const promise = reviewWithCloudflare(env, '@cf/zai-org/glm-4.7-flash', {
        systemPrompt: 'system',
        userPrompt: 'user',
      });
      // Prevent an unhandled-rejection warning while the timer is still pending.
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(45_000);

      await expect(promise).rejects.toThrow('timed out after 45000ms');
      // The underlying Workers-AI request was actually cancelled, not just abandoned.
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies an exhausted run of Google 5xx failures as retryable (not a permanent file failure)', async () => {
    // A sustained 5xx outage defers rather than fails. Fresh Response per call: a body reads once.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({ error: { code: 500, message: 'Internal error encountered.', status: 'INTERNAL' } }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      ),
    );
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = new ModelService(env);

    await expect(
      service.reviewFile({
        file: { path: 'src/app.ts', lineCount: 1, hunks: [], isDeleted: false, isBinary: false, isNew: false, previousPath: null },
        prTitle: 'Test',
        prDescription: null,
        config: {
          ...defaultRepoConfig,
          model: { main: 'gemini-3.1-pro-preview', fallbacks: ['gemini-2.5-pro'], size_overrides: [] },
        },
        totalLineCount: 1,
      }),
    ).rejects.toSatisfy(isRetryableModelError);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('marks exhausted transient provider failures as retryable for the queue', async () => {
    const env = createTestEnv({
      AI: {
        async run() {
          throw new Error('[REDACTED]');
        },
      } as any,
    });

    const service = new ModelService(env);
    await expect(
      service.reviewFile({
        file: {
          path: 'test/setup.ts',
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
          review: {
            on: ['opened'],
            ignore_drafts: true,
            mention_trigger: '@codra-app',
            skip_files: [],
            batch_small_files: false,
            large_file_threshold_lines: 200,
            max_diff_lines_per_file: 800,
            max_total_diff_chars: 150_000,
            max_comments: 10,
            min_severity: 'nit',
            min_confidence: 0.6,
            focus: ['quality'],
            deny_claim_types: [],
            rules: { enabled: false, disabled_rule_ids: [], shadow_rule_ids: [] },
            custom_rules: [],
            labels: false,
            exec: {
              enabled: false,
              on_file_types: ['.ts'],
              command: 'npm run lint',
            },
          },
          model: {
            main: '@cf/zai-org/glm-4.7-flash',
            fallbacks: [],
            size_overrides: [],
          },
        },
        totalLineCount: 1,
      }),
    ).rejects.toSatisfy(isRetryableModelError);
  });
});
