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
