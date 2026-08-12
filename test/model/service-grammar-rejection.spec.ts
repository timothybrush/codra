import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelService } from '@server/services/model';
import { reviewWithGoogle } from '@server/models/google';
import { buildReviewResponseSchema } from '@server/prompts/file-review';
import { createTestEnv, saveTestProviderApiKey } from '../helpers';
import { defaultRepoConfig } from '@shared/schema';

// Split out of service-retries.spec.ts: a 400 matches no transient pattern, so grammar rejection is
// its own ladder rung -- drop responseJsonSchema, retry once, latch it off -- not part of the
// transient-failure ladder those specs cover.
describe('ModelService: response-grammar rejection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  // Google sometimes 400s with nothing but "Request contains an invalid argument." and no
  // `error.details`, so none of the specific schema markers can fire. That used to fail the file on its
  // first 400 -- permanently, since a 400 is not transient -- with no grammar probe and no fallback.
  it('drops the response grammar and retries on a 400 that explains nothing', async () => {
    const bareInvalidArgument = () =>
      new Response(
        JSON.stringify({ error: { code: 400, message: 'Request contains an invalid argument.' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bareInvalidArgument())
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
      'gemini-3.1-flash-lite',
      {
        systemPrompt: 'system',
        userPrompt: 'user',
        responseSchema: buildReviewResponseSchema(5),
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The first attempt carried the grammar and the retry did not.
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const retryBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(firstBody.generationConfig.responseJsonSchema).toBeDefined();
    expect(retryBody.generationConfig.responseJsonSchema).toBeUndefined();
    // Still asks for JSON, or the schema-less attempt returns prose.
    expect(retryBody.generationConfig.responseMimeType).toBe('application/json');
    expect(response.rawText).toContain('"findings"');
  });

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
