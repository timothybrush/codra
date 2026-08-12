import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '@server/env';
import {
  createLlmProvider,
  deleteLlmProvider,
  deleteModelConfig,
  findLlmProviderByName,
  getLlmProvider,
  getResolvedModelConfig,
  listLlmProviderSecrets,
  listLlmProviders,
  listModelConfigs,
  updateLlmProvider,
  updateModelConfig,
  upsertDiscoveredModelConfigs,
} from '@server/db/model-configs';
import { jsonError } from '@server/core/http';
import { getGlobalConfig, updateGlobalConfig } from '@server/core/config';
import { encryptLlmApiKey, decryptLlmApiKey } from '@server/core/llm-crypto';
import { llmApiFormats } from '@codra/schema';
import { reviewWithCloudflare } from '@server/models/cloudflare';
import { reviewWithGoogle } from '@server/models/google';
import { reviewWithVertex } from '@server/models/vertex';
import { reviewWithOpenAI } from '@server/models/openai';
import { reviewWithAnthropic } from '@server/models/anthropic';
import { listProviderModels } from '@server/models/catalog';
import { ProviderRequestError, type ModelInput } from '@server/models/types';
import { buildReviewResponseSchema } from '@server/prompts/file-review';

// Per-attempt budget for "Test connection": a person is waiting, and a retry ladder multiplies it.
const PREFLIGHT_TIMEOUT_MS = 15_000;

const apiFormatSchema = z.enum(llmApiFormats);
const positiveIntegerSchema = z.number().int().positive().finite();
const modelIdSchema = z.string().trim().min(1);
const optionalUrlSchema = z.string().trim().url().nullable().optional();
const providerIdSchema = z.uuid();

const providerCreateSchema = z.strictObject({
  name: z.string().trim().min(1),
  apiFormat: apiFormatSchema,
  baseUrl: optionalUrlSchema,
  apiKey: z.string().optional(),
  enabled: z.boolean().default(true),
});

// `.extend()` carries the parent's strictness through, so no second `.strict()` is needed here.
const providerUpdateSchema = providerCreateSchema.extend({
  clearApiKey: z.boolean().optional(),
});

const modelConfigUpdateSchema = z.strictObject({
  providerId: providerIdSchema,
  modelName: z.string().trim().min(1),
});

const globalModelConfigSchema = z.strictObject({
  main: modelIdSchema.nullable().default(null),
  fallbacks: z.array(modelIdSchema).nullable().default([]),
  size_overrides: z
    .array(
      z.strictObject({
        max_lines: positiveIntegerSchema,
        model: modelIdSchema,
        fallbacks: z.array(modelIdSchema).optional(),
      }),
    )
    .nullable()
    .optional(),
});

function normalizedBaseUrl(apiFormat: z.infer<typeof apiFormatSchema>, baseUrl?: string | null) {
  if (apiFormat === 'cloudflare-workers-ai') return null;
  if (baseUrl) return baseUrl.replace(/\/+$/, '');
  if (apiFormat === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta';
  if (apiFormat === 'anthropic') return 'https://api.anthropic.com/v1';
  return 'https://api.openai.com/v1';
}

async function encryptedApiKeyFromBody(env: AppEnv['Bindings'], apiKey?: string, clearApiKey?: boolean) {
  if (clearApiKey) return null;
  if (apiKey === undefined) return undefined;
  const trimmed = apiKey.trim();
  if (!trimmed) return undefined;
  return encryptLlmApiKey(env, trimmed);
}

function isEncryptionConfigError(error: unknown) {
  return error instanceof Error && error.message.includes('LLM_CONFIG_ENCRYPTION_KEY');
}

function isUniqueNameError(error: unknown) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === '23505',
  );
}

function readModelIdParam(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function providerErrorStatus(error: ProviderRequestError) {
  return error.status >= 500 ? 502 : error.status;
}

function providerCanBeEnabled(apiFormat: z.infer<typeof apiFormatSchema>, encryptedApiKey: string | null | undefined) {
  return apiFormat === 'cloudflare-workers-ai' || Boolean(encryptedApiKey);
}

// Vertex embeds the caller's GCP project ID and region in the URL, so it must be supplied explicitly rather than falling back.
function requiresExplicitBaseUrl(apiFormat: z.infer<typeof apiFormatSchema>, baseUrl: string | null | undefined) {
  return apiFormat === 'vertex' && !baseUrl;
}

function optionalEnv(value: () => string) {
  try {
    const resolved = value().trim();
    return resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

async function syncProviderModelCatalog(env: AppEnv['Bindings']) {
  const providers = await listLlmProviderSecrets(env);
  const syncErrors: Array<{ providerId: string; providerName: string; error: string }> = [];

  await Promise.all(providers.map(async (provider) => {
    if (!provider.enabled) {
      return;
    }
    if (provider.apiFormat !== 'cloudflare-workers-ai' && !provider.encryptedApiKey) {
      return;
    }

    try {
      const apiKey = provider.encryptedApiKey
        ? await decryptLlmApiKey(env, provider.encryptedApiKey)
        : undefined;
      const modelNames = await listProviderModels({
        apiFormat: provider.apiFormat,
        baseUrl: provider.baseUrl,
        apiKey,
        cloudflareAccountId: optionalEnv(() => env.CF_ACCOUNT_ID),
        cloudflareApiToken: optionalEnv(() => env.CF_API_TOKEN),
      });
      await upsertDiscoveredModelConfigs(env, {
        providerId: provider.id,
        providerName: provider.name,
        apiFormat: provider.apiFormat,
        modelNames,
      });
    } catch (error) {
      syncErrors.push({
        providerId: provider.id,
        providerName: provider.name,
        error: error instanceof Error ? error.message : 'Could not refresh provider models.',
      });
    }
  }));

  return syncErrors;
}

export function createModelsRouter() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const [providers, configs] = await Promise.all([
      listLlmProviders(c.env),
      listModelConfigs(c.env),
    ]);
    return c.json({ providers, configs });
  });

  app.post('/sync', async (c) => {
    const syncErrors = await syncProviderModelCatalog(c.env);
    const [providers, configs] = await Promise.all([
      listLlmProviders(c.env),
      listModelConfigs(c.env),
    ]);
    return c.json({ providers, configs, syncErrors });
  });

  app.get('/global', async (c) => {
    const config = await getGlobalConfig(c.env);
    return c.json({ config });
  });

  app.patch('/global', async (c) => {
    const body = await c.req.json();
    const parsed = globalModelConfigSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError('Invalid global model config.', 400);
    }

    await updateGlobalConfig(c.env, parsed.data);
    return c.json({ ok: true });
  });

  app.post('/providers', async (c) => {
    const parsed = providerCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return jsonError('Invalid provider config.', 400);
    }

    const input = parsed.data;
    if (requiresExplicitBaseUrl(input.apiFormat, input.baseUrl)) {
      return jsonError('Vertex AI requires a base URL with your GCP project ID and region, e.g. https://us-central1-aiplatform.googleapis.com/v1/projects/YOUR_PROJECT_ID/locations/us-central1', 400);
    }

    const existing = await findLlmProviderByName(c.env, input.name);
    if (existing) {
      return jsonError(`Provider ${input.name} already exists. Update the existing provider instead.`, 409);
    }

    let encryptedApiKey: string | null;
    try {
      encryptedApiKey = input.apiFormat === 'cloudflare-workers-ai'
        ? null
        : (await encryptedApiKeyFromBody(c.env, input.apiKey)) ?? null;
    } catch (error) {
      if (isEncryptionConfigError(error)) {
        return jsonError(error instanceof Error ? error.message : 'LLM encryption is not configured.', 400);
      }
      throw error;
    }

    if (input.enabled && !providerCanBeEnabled(input.apiFormat, encryptedApiKey)) {
      return jsonError(`Provider ${input.name} needs an API key before it can be enabled.`, 400);
    }

    let provider;
    try {
      provider = await createLlmProvider(c.env, {
        name: input.name,
        apiFormat: input.apiFormat,
        baseUrl: normalizedBaseUrl(input.apiFormat, input.baseUrl),
        encryptedApiKey,
        enabled: input.enabled,
      });
    } catch (error) {
      if (isUniqueNameError(error)) {
        return jsonError(`Provider ${input.name} already exists. Update the existing provider instead.`, 409);
      }
      throw error;
    }

    return c.json({ provider }, 201);
  });

  app.patch('/providers/:id', async (c) => {
    const id = c.req.param('id');
    if (!providerIdSchema.safeParse(id).success) {
      return jsonError('Invalid provider id.', 400);
    }

    const parsed = providerUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return jsonError('Invalid provider config.', 400);
    }

    const input = parsed.data;
    if (requiresExplicitBaseUrl(input.apiFormat, input.baseUrl)) {
      return jsonError('Vertex AI requires a base URL with your GCP project ID and region, e.g. https://us-central1-aiplatform.googleapis.com/v1/projects/YOUR_PROJECT_ID/locations/us-central1', 400);
    }

    const existing = await getLlmProvider(c.env, id);
    if (!existing) return jsonError('Provider not found.', 404);

    let encryptedApiKey: string | null | undefined;
    try {
      encryptedApiKey = input.apiFormat === 'cloudflare-workers-ai'
        ? null
        : await encryptedApiKeyFromBody(c.env, input.apiKey, input.clearApiKey);
    } catch (error) {
      if (isEncryptionConfigError(error)) {
        return jsonError(error instanceof Error ? error.message : 'LLM encryption is not configured.', 400);
      }
      throw error;
    }

    const effectiveEncryptedApiKey = encryptedApiKey !== undefined
      ? encryptedApiKey
      : existing.encryptedApiKey;
    if (input.enabled && !providerCanBeEnabled(input.apiFormat, effectiveEncryptedApiKey)) {
      return jsonError(`Provider ${input.name} needs an API key before it can be enabled.`, 400);
    }

    let provider;
    try {
      provider = await updateLlmProvider(c.env, id, {
        name: input.name,
        apiFormat: input.apiFormat,
        baseUrl: normalizedBaseUrl(input.apiFormat, input.baseUrl),
        ...(encryptedApiKey !== undefined ? { encryptedApiKey } : {}),
        enabled: input.enabled,
      });
    } catch (error) {
      if (isUniqueNameError(error)) {
        return jsonError(`Provider ${input.name} already exists. Choose a different provider name.`, 409);
      }
      throw error;
    }

    if (!provider) return jsonError('Provider not found.', 404);
    return c.json({ provider });
  });

  app.delete('/providers/:id', async (c) => {
    const id = c.req.param('id');
    if (!providerIdSchema.safeParse(id).success) {
      return jsonError('Invalid provider id.', 400);
    }

    const result = await deleteLlmProvider(c.env, id);
    if (!result.deleted) {
      return jsonError(result.reason ?? 'Provider not found.', result.reason ? 409 : 404);
    }
    return c.json({ ok: true });
  });

  app.post('/:id/test', async (c) => {
    const modelId = readModelIdParam(c.req.param('id'));
    const parsedModelId = modelIdSchema.safeParse(modelId);
    if (!parsedModelId.success) {
      return jsonError('Invalid model id.', 400);
    }

    const config = await getResolvedModelConfig(c.env, parsedModelId.data);
    if (!config) return jsonError('Model not found.', 404);
    if (!config.providerEnabled) return jsonError('Provider is disabled.', 400);

    try {
      // Exercises the real review grammar so this preflight actually proves the model can honor a strict json_schema.
      const input: ModelInput = {
        systemPrompt: 'You are validating connectivity. Return only the JSON object.',
        userPrompt: 'Return an empty review: no findings, overall_correctness "patch is correct".',
        responseSchema: buildReviewResponseSchema(1),
      };
      let response;
      if (config.apiFormat === 'cloudflare-workers-ai') {
        response = await reviewWithCloudflare(c.env, config.modelName, input, undefined, config.providerName);
      } else {
        if (!config.encryptedApiKey) {
          return jsonError(`Provider ${config.providerName} does not have a saved API key.`, 400);
        }
        const apiKey = await decryptLlmApiKey(c.env, config.encryptedApiKey);
        
        switch (config.apiFormat) {
          case 'gemini':
            // Four attempts worst case, so the 45s default would be 180s -- past Cloudflare's 524.
            response = await reviewWithGoogle({ apiKey, baseUrl: config.baseUrl, providerName: config.providerName, timeoutMs: PREFLIGHT_TIMEOUT_MS }, config.modelName, input);
            break;
          case 'vertex':
            response = await reviewWithVertex({ apiKey, baseUrl: config.baseUrl, providerName: config.providerName }, config.modelName, input);
            break;
          case 'openai':
            response = await reviewWithOpenAI({
              apiKey,
              baseUrl: config.baseUrl || 'https://api.openai.com/v1',
              providerName: config.providerName,
            }, config.modelName, input);
            break;
          case 'anthropic':
            response = await reviewWithAnthropic({ apiKey, baseUrl: config.baseUrl, providerName: config.providerName }, config.modelName, input);
            break;
          default:
            return jsonError(`Unsupported API format: ${config.apiFormat}`, 400);
        }
      }

      return c.json({
        ok: true,
        modelUsed: response.modelUsed,
        provider: response.provider,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        // Reported, not swallowed: a plain `ok: true` would claim more than this verified.
        ...(response.degraded === 'schema-dropped'
          ? {
              degraded: response.degraded,
              warning: 'Connected, but this endpoint rejected the response grammar. Reviews will run without constrained decoding.',
            }
          : {}),
      });
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : 'Connection test failed.',
        error instanceof ProviderRequestError ? providerErrorStatus(error) : 502,
      );
    }
  });

  app.post('/:id', async (c) => {
    const modelId = readModelIdParam(c.req.param('id'));
    const parsedModelId = modelIdSchema.safeParse(modelId);
    if (!parsedModelId.success) {
      return jsonError('Invalid model id.', 400);
    }

    const body = await c.req.json();
    const parsed = modelConfigUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError('Invalid model config.', 400);
    }

    const saved = await updateModelConfig(c.env, {
      modelId: parsedModelId.data,
      ...parsed.data,
    });

    if (!saved) return jsonError('Provider not found.', 404);
    return c.json({ ok: true, config: saved });
  });

  app.delete('/:id', async (c) => {
    const modelId = readModelIdParam(c.req.param('id'));
    const parsedModelId = modelIdSchema.safeParse(modelId);
    if (!parsedModelId.success) {
      return jsonError('Invalid model id.', 400);
    }

    const deleted = await deleteModelConfig(c.env, parsedModelId.data);
    if (!deleted) return jsonError('Model not found.', 404);
    return c.json({ ok: true });
  });

  return app;
}
