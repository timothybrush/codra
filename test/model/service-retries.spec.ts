import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRetryableModelError, ModelService } from '@server/services/model';
import { reviewWithCloudflare } from '@server/models/cloudflare';
import { reviewWithGoogle } from '@server/models/google';


import { createTestEnv, saveTestProviderApiKey } from '../helpers';
import { defaultRepoConfig } from '@shared/schema';

// The transient-failure retry ladder: which errors are retried inline, how Retry-After is honoured,
// and which exhausted runs are reported to the queue as retryable rather than as a permanent file
// failure. Chain fallback and provider-unavailable marking live in model-service-fallbacks.spec.ts.
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
      reviewWithGoogle({ apiKey: 'test-key' }, 'gemini-3.1-pro-preview', { systemPrompt: 'system', userPrompt: 'user' }),
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
        'gemini-3.1-pro-preview',
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
