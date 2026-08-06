import { afterEach, describe, expect, it } from 'vitest';
import { ModelService } from '@server/services/model';
import { reviewWithCloudflare } from '@server/models/cloudflare';

import { buildReviewResponseSchema } from '@server/prompts/file-review';
import { VERIFY_RESPONSE_SCHEMA } from '@server/prompts/verify';
import { createTestEnv } from '../helpers';
import { defaultRepoConfig } from '@shared/schema';


describe('ModelService: request shape and response handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Guards the model.ts split: resolveModel / callModel / selectModel are reached by three specs via
  // `(service as any)`, so they must stay methods on ModelService. If a refactor moves one onto a
  // sibling module, `(service as any).thatName` becomes `undefined` -- and an `undefined` spy reads
  // as a passing skip rather than a failure. These three assertions make that move fail loudly.
  it('keeps resolveModel, callModel and selectModel as methods on ModelService', () => {
    const service = new ModelService(createTestEnv());
    expect(typeof (service as any).resolveModel).toBe('function');
    expect(typeof (service as any).callModel).toBe('function');
    expect(typeof (service as any).selectModel).toBe('function');
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
          main: 'gemini-3.1-pro-preview',
          fallbacks: [],
          size_overrides: [],
        },
      },
    });

    expect(selected).toEqual({
      primary: 'gemini-3.1-pro-preview',
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
    // Twice the posted cap: the generator feeds the gates a candidate pool, and finalize does the
    // slicing. See generatorFindingCap.
    expect(inputs.response_format.json_schema.schema.properties.findings.maxItems).toBe(20);
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
});
