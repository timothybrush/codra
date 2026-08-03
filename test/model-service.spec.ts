import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRetryableModelError, ModelService } from '@server/services/model';
import { reviewWithCloudflare } from '@server/models/cloudflare';
import { reviewWithGoogle } from '@server/models/google';
import { buildReviewResponseSchema } from '@server/prompts/file-review';
import { VERIFY_RESPONSE_SCHEMA } from '@server/prompts/verify';
import { createTestEnv, saveTestProviderApiKey } from './helpers';
import { defaultRepoConfig } from '@shared/schema';
import { TokenTracker } from '@server/core/token-tracker';

describe('ModelService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes legacy Kimi K2.5 ids to Kimi K2.6 for new Cloudflare requests', async () => {
    let requestedModel = '';
    const env = createTestEnv({
      AI: {
        async run(model: string) {
          requestedModel = model;
          return { response: '{"findings":[]}', usage: { prompt_tokens: 1, completion_tokens: 1 } };
        },
      } as any,
    });

    const service = new ModelService(env);
    const response = await (service as any).callModel('@cf/moonshotai/kimi-k2.5', {
      systemPrompt: 'system',
      userPrompt: 'user',
    });

    expect(requestedModel).toBe('@cf/moonshotai/kimi-k2.6');
    expect(response.modelUsed).toBe('@cf/moonshotai/kimi-k2.6');
  });

  it('preserves an explicitly empty fallback chain', () => {
    const service = new ModelService(createTestEnv());
    const selected = (service as any).selectModel({
      totalLineCount: 500,
      config: {
        ...defaultRepoConfig,
        model: {
          main: 'gemma-4-31b-it',
          fallbacks: [],
          size_overrides: [],
        },
      },
    });

    expect(selected).toEqual({
      primary: 'gemma-4-31b-it',
      fallbacks: [],
    });
  });

  it('fails clearly when no model strategy is configured', () => {
    const service = new ModelService(createTestEnv());

    expect(() => (service as any).selectModel({
      totalLineCount: 1,
      config: defaultRepoConfig,
    })).toThrow('No review model strategy is configured');
  });

  it('fails (throws) on a Cloudflare reasoning-only response instead of faking an inconclusive review', async () => {
    const env = createTestEnv({
      AI: {
        async run() {
          return {
            choices: [
              {
                message: {
                  content: null,
                  reasoning: 'Long reasoning that consumed the completion budget.',
                },
                finish_reason: 'length',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 4096 },
          };
        },
      } as any,
    });

    // The file was not actually reviewed, so this must surface as a failure (to be marked failed
    // after the fallback chain), not a synthesized "inconclusive" pass.
    await expect(
      reviewWithCloudflare(env, '@cf/moonshotai/kimi-k2.6', { systemPrompt: 'system', userPrompt: 'user' }),
    ).rejects.toThrow(/no reviewable output.*reasoning-only/i);
  });

  it('throws when Cloudflare final content is missing (does not parse reasoning as review JSON)', async () => {
    const env = createTestEnv({
      AI: {
        async run() {
          return {
            choices: [
              {
                message: {
                  content: null,
                  reasoning: 'Reasoning mentioned an object like {"foo":"bar"} but never produced final JSON.',
                },
                finish_reason: 'length',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 8192 },
          };
        },
      } as any,
    });

    await expect(
      reviewWithCloudflare(env, '@cf/zai-org/glm-4.7-flash', { systemPrompt: 'system', userPrompt: 'user' }),
    ).rejects.toThrow(/no reviewable output/i);
  });

  it('asks Cloudflare chat models for strict review JSON', async () => {
    let inputs: any;
    const env = createTestEnv({
      AI: {
        async run(_model: string, request: any) {
          inputs = request;
          return {
            choices: [
              {
                message: {
                  content: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9}',
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      } as any,
    });

    await reviewWithCloudflare(env, '@cf/zai-org/glm-4.7-flash', {
      systemPrompt: 'system',
      userPrompt: 'user',
      responseSchema: buildReviewResponseSchema(10),
    });

    expect(inputs.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'codra_file_review',
        strict: true,
      },
    });
    expect(inputs.response_format.json_schema.schema.properties.findings.maxItems).toBe(10);
    expect(inputs.messages[0].content).toContain('Return only the JSON object');
    expect(inputs.max_completion_tokens).toBe(8192);
    expect(inputs.chat_template_kwargs).toBeUndefined();
    expect(inputs.reasoning_effort).toBeUndefined();
  });

  // The grammar is per-call. Forcing the file-review schema onto every Workers AI request made the
  // verification pass structurally impossible to satisfy, so it silently dropped nothing.
  it('sends no response_format when the caller supplies no schema', async () => {
    let inputs: any;
    const env = createTestEnv({
      AI: {
        async run(_model: string, request: any) {
          inputs = request;
          return {
            choices: [{ message: { content: '{"results":[]}' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      } as any,
    });

    await reviewWithCloudflare(env, '@cf/zai-org/glm-4.7-flash', {
      systemPrompt: 'system',
      userPrompt: 'user',
    });

    expect(inputs.response_format).toBeUndefined();
  });

  it('honors a non-review schema, so the verify pass is not forced to emit a file review', async () => {
    let inputs: any;
    const env = createTestEnv({
      AI: {
        async run(_model: string, request: any) {
          inputs = request;
          return {
            choices: [{ message: { content: '{"results":[]}' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      } as any,
    });

    await reviewWithCloudflare(env, '@cf/zai-org/glm-4.7-flash', {
      systemPrompt: 'system',
      userPrompt: 'user',
      responseSchema: VERIFY_RESPONSE_SCHEMA as any,
    });

    expect(inputs.response_format.json_schema.name).toBe('codra_verify_findings');
    expect(inputs.response_format.json_schema.schema.properties.results).toBeDefined();
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
      'gemma-4-31b-it',
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
        'gemma-4-31b-it',
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

  // The counterpart: a cool-off we cannot honour is not worth a retry. Waking early just earns
  // the same 429 and spends another subrequest out of the invocation's 50.
  it('gives up immediately on a Retry-After longer than the in-call sleep cap', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 429, message: 'Rate limited.' } }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '56' } },
      ),
    );

    await expect(
      reviewWithGoogle({ apiKey: 'test-key' }, 'gemma-4-31b-it', { systemPrompt: 'system', userPrompt: 'user' }),
    ).rejects.toThrow(/429/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
        'gemma-4-31b-it',
        { systemPrompt: 'system', userPrompt: 'user' },
      ),
    ).rejects.toThrow('parser exploded after response');

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
          main: 'gemma-4-31b-it',
          fallbacks: ['gemma-4-26b-a4b-it', '@cf/zai-org/glm-4.7-flash'],
          size_overrides: [],
        },
      },
      totalLineCount: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/models/gemma-4-31b-it:generateContent');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/models/gemma-4-31b-it:generateContent');
    expect(String(fetchMock.mock.calls[2][0])).toContain('/models/gemma-4-31b-it:generateContent');
    expect(String(fetchMock.mock.calls[3][0])).toContain('/models/gemma-4-26b-a4b-it:generateContent');
    expect(cloudflareCalls).toBe(0);
    expect(response.modelUsed).toBe('gemma-4-26b-a4b-it');
  });

  it('classifies an exhausted run of Google 5xx failures as retryable (not a permanent file failure)', async () => {
    // A sustained upstream 5xx outage across every configured model must be deferred and retried on
    // a fresh budget, not marked permanently failed. Regression guard for isTransientModelFailure
    // dropping 5xx / "internal error" detection.
    // Fresh Response per call -- a Response body can only be read once, so a shared instance would
    // make the 2nd+ fetch fail on an already-consumed body instead of on the 500 under test.
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
          model: { main: 'gemma-4-31b-it', fallbacks: ['gemma-4-26b-a4b-it'], size_overrides: [] },
        },
        totalLineCount: 1,
      }),
    ).rejects.toSatisfy(isRetryableModelError);
    expect(fetchMock).toHaveBeenCalled();
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
          main: 'gemma-4-31b-it',
          fallbacks: ['gemma-4-26b-a4b-it'],
          size_overrides: [],
        },
      },
      totalLineCount: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.modelUsed).toBe('gemma-4-31b-it');
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
            main: 'gemma-4-31b-it',
            fallbacks: ['gemma-4-26b-a4b-it'],
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
      expect(String(call[0])).toContain('/models/gemma-4-31b-it:generateContent');
    }
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
            large_file_threshold_lines: 200,
            max_diff_lines_per_file: 800,
            max_total_diff_chars: 150_000,
            max_comments: 10,
            min_severity: 'nit',
            min_confidence: 0.6,
            focus: ['quality'],
            deny_claim_types: [],
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
        fallbacks: ['gemma-4-31b-it'],
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

  it('splits an oversized Gemma diff into capped chunks and reviews each in its own call', async () => {
    const requestBodies: any[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9}' }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = new ModelService(env);
    const largeFile = {
      path: 'src/large.ts',
      previousPath: null,
      isNew: false,
      isDeleted: false,
      isBinary: false,
      lineCount: 900,
      hunks: [
        {
          header: '@@ -1,900 +1,900 @@',
          lines: Array.from({ length: 900 }, (_, index) => ({
            kind: 'add' as const,
            content: `const value${index} = ${index};`,
            newLineNumber: index + 1,
            position: index + 1,
          })),
        },
      ],
    };

    const response = await service.reviewFile({
      file: largeFile,
      prTitle: 'Test',
      prDescription: null,
      config: {
        ...defaultRepoConfig,
        model: {
          main: 'gemma-4-31b-it',
          fallbacks: [],
          size_overrides: [],
        },
      },
      totalLineCount: 500,
    });

    // A 900-line file with the configured 800-line cap is split into two chunks (800 + 100)
    // and each chunk is reviewed in its own model call instead of the tail being truncated away.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const body of requestBodies) {
      expect(body.generationConfig.maxOutputTokens).toBe(8192);
    }
    const firstPrompt = requestBodies[0].contents[0].parts[0].text as string;
    expect(firstPrompt).toContain('const value799 = 799;');
    expect(firstPrompt).not.toContain('const value800 = 800;');
    const secondPrompt = requestBodies[1].contents[0].parts[0].text as string;
    expect(secondPrompt).toContain('const value800 = 800;');
    expect(secondPrompt).toContain('const value899 = 899;');
    // The whole file is covered across the chunks, so nothing is dropped as truncated.
    expect(response.reviewedLineCount).toBe(900);
    expect(response.wasPromptTruncated).toBe(false);
  });

  it('applies the compact Gemma prompt cap by producing smaller chunks after a prior transient failure', async () => {
    const requestBodies: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9}' }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = new ModelService(env);
    const largeFile = {
      path: 'src/large.ts',
      previousPath: null,
      isNew: false,
      isDeleted: false,
      isBinary: false,
      lineCount: 900,
      hunks: [
        {
          header: '@@ -1,900 +1,900 @@',
          lines: Array.from({ length: 900 }, (_, index) => ({
            kind: 'add' as const,
            content: `const value${index} = ${index};`,
            newLineNumber: index + 1,
            position: index + 1,
          })),
        },
      ],
    };

    const response = await service.reviewFile({
      file: largeFile,
      prTitle: 'Test',
      prDescription: null,
      config: {
        ...defaultRepoConfig,
        model: {
          main: 'gemma-4-31b-it',
          fallbacks: [],
          size_overrides: [],
        },
      },
      totalLineCount: 900,
      compactPrompt: true,
    });

    // compactPrompt lowers the per-call cap to COMPACT_REVIEW_PROMPT_LINE_CAP (400), so the
    // 900-line file is split into three chunks (400 + 400 + 100) rather than the two chunks
    // the full 800-line cap would produce -- the first chunk stops exactly at the compact cap.
    expect(requestBodies.length).toBe(3);
    const firstPrompt = requestBodies[0].contents[0].parts[0].text as string;
    expect(firstPrompt).toContain('const value399 = 399;');
    expect(firstPrompt).not.toContain('const value400 = 400;');
    expect(response.reviewedLineCount).toBe(900);
    expect(response.wasPromptTruncated).toBe(false);
  });
});
