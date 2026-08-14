import type { AppBindings } from '../env';
import { reviewWithGoogle } from '../models/google';
import { reviewWithVertex } from '../models/vertex';
import { reviewWithCloudflare } from '../models/cloudflare';
import { reviewWithOpenAI } from '../models/openai';
import { reviewWithAnthropic } from '../models/anthropic';
import type { VerifyCandidate } from '../prompts/verify';
import type { RepoConfig } from '@codra/schema';
import type { TokenTracker } from '../core/token-tracker';
import type { ModelInput, ModelResponse } from '../models/types';
import { logger } from '../core/logger';
import { getResolvedModelConfig, type ResolvedModelConfig } from '@codra/db/model-configs';
import { decryptLlmApiKey } from '@server/core/llm-crypto';
import {
  isSchemaDroppedError,
  normalizeModel,
  uniqueModels,
} from './model-support';
import { ModelRateLimitBook } from './model-rate-limits';
import { ModelChainProgressStore } from './model-chain-progress';
import { type ModelChainContext, generateSummary, verifyFindings } from './model-chain-runner';
import { type ModelReviewContext, reviewFile, reviewFiles } from './model-review-file';
// Re-exported so test doubles can be typed against the real batched-review shape.
export type { BatchReviewOutcome } from './model-review-file';
import { pollReviewBatch, submitReviewBatch } from './model-review-batch';

// Re-exported: core/review.ts and two specs import these from '@server/services/model'.
export { RetryableModelError, isRetryableModelError, nextChainIndexOf } from './model-support';

// Re-exported so the batch-prompt budget test asserts against these constants, not a copy.
export { PROMPT_FIT_SAFETY_FACTOR, estimatePromptTokens } from './model-support';
// Re-exported so its unit spec can reach it without a sibling import (no-restricted-imports).
export { ModelChainProgressStore } from './model-chain-progress';
// Same reason: the 429-parsing spec asserts against the real implementation, not a copy.
export { isPlausibleTokenBucket, parseRateLimitFromError } from './model-support';

const PROVIDER_UNAVAILABLE_TTL_SECONDS = 24 * 60 * 60;
export class ModelService {
  // Caches the in-flight PROMISE (not just the result), so concurrent calls for a model await one request.
  private readonly resolvedModelCache = new Map<string, Promise<ResolvedModelConfig | null>>();

  // Rate-limit learning plus the connection/token gates, keyed by MODEL, not provider.
  // Backed by chainProgress so learned cool-offs outlive the invocation; assigned in the constructor
  // because it depends on it.
  private readonly rateLimits: ModelRateLimitBook;

  // Provider-unavailable markers live in KV and can't flip set-to-unset within one invocation, so cache them per instance.
  private readonly providerUnavailableCache = new Map<string, Promise<boolean>>();

  // Models proven this invocation not to support async batching, so later files skip the probe.
  private readonly asyncUnsupportedModels = new Set<string>();

  // Same idea for constrained decoding: `(provider, model, grammar)` triples that were refused, keyed by grammar so one oversized bin doesn't disable the single-file grammar too.
  private readonly schemaUnsupportedModels = new Set<string>();

  // How far down the chain each file already got, so a deferral resumes instead of replaying.
  private readonly chainProgress: ModelChainProgressStore;

  constructor(
    private env: AppBindings,
    private tracker?: TokenTracker,
    private options: { jobId?: string } = {},
  ) {
    this.chainProgress = new ModelChainProgressStore(env, options.jobId, tracker);
    this.rateLimits = new ModelRateLimitBook(this.chainProgress);
  }

  private providerUnavailableKey(providerId: string) {
    return this.options.jobId ? `jobs:${this.options.jobId}:provider-unavailable:${providerId}` : null;
  }

  private isProviderUnavailable(providerId: string): Promise<boolean> {
    const key = this.providerUnavailableKey(providerId);
    if (!key) return Promise.resolve(false);

    let pending = this.providerUnavailableCache.get(providerId);
    if (!pending) {
      pending = (async () => {
        try {
          this.tracker?.incrementSubrequests(1);
          return (await this.env.APP_KV.get(key)) !== null;
        } catch (error) {
          logger.warn(`Failed to read unavailable provider marker for ${providerId}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      })();
      this.providerUnavailableCache.set(providerId, pending);
    }
    return pending;
  }

  private async markProviderUnavailable(providerId: string, reason: string) {
    const key = this.providerUnavailableKey(providerId);
    if (!key) return;

    // Keep the in-invocation cache consistent with what we just wrote.
    this.providerUnavailableCache.set(providerId, Promise.resolve(true));

    try {
      this.tracker?.incrementSubrequests(1);
      await this.env.APP_KV.put(
        key,
        JSON.stringify({
          reason,
          markedAt: new Date().toISOString(),
        }),
        { expirationTtl: PROVIDER_UNAVAILABLE_TTL_SECONDS },
      );
    } catch (error) {
      logger.warn(`Failed to write unavailable provider marker for ${providerId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private selectModel(params: {
    totalLineCount: number;
    config: RepoConfig;
  }): { primary: string; fallbacks: string[] } {
    const { model: modelCfg } = params.config;
    const thresholdBase = params.totalLineCount;

    let selectedModel = modelCfg?.main ? normalizeModel(modelCfg.main) : null;
    let fallbackModels = (modelCfg?.fallbacks || []).map(normalizeModel);

    if (modelCfg?.size_overrides && modelCfg.size_overrides.length > 0) {
      const sortedOverrides = modelCfg.size_overrides.toSorted((a, b) => a.max_lines - b.max_lines);
      const matched = sortedOverrides.find(o => thresholdBase <= o.max_lines);
      if (matched) {
        selectedModel = normalizeModel(matched.model);
        fallbackModels = (matched.fallbacks || fallbackModels).map(normalizeModel);
      }
    }

    const chain = uniqueModels([...(selectedModel ? [selectedModel] : []), ...fallbackModels]);
    if (chain.length === 0) {
      throw new Error('No review model strategy is configured. Choose a global model strategy in Settings, or configure this repository.');
    }

    selectedModel = chain[0];
    fallbackModels = chain.slice(1);

    return { primary: selectedModel, fallbacks: fallbackModels };
  }

  private async resolveModel(model: string) {
    const normalized = normalizeModel(model);
    let pending = this.resolvedModelCache.get(normalized);
    if (!pending) {
      // Cache the DB answer, including a null "not configured", so it isn't re-queried per file.
      pending = getResolvedModelConfig(this.env, normalized);
      this.resolvedModelCache.set(normalized, pending);
      // Don't let a transient DB error poison the cache; drop it so the next call retries.
      pending.catch(() => this.resolvedModelCache.delete(normalized));
    }
    const resolved = await pending;
    if (!resolved) {
      throw new Error(`Model ${normalized} is not configured. Add it in Settings before using it in a route.`);
    }

    if (!resolved.providerEnabled) {
      throw new Error(`Provider ${resolved.providerName} is disabled.`);
    }

    return resolved;
  }

  private async decryptApiKey(config: ResolvedModelConfig) {
    if (!config.encryptedApiKey) {
      throw new Error(`Provider ${config.providerName} does not have a saved API key.`);
    }
    return decryptLlmApiKey(this.env, config.encryptedApiKey);
  }

  private async callResolvedModel(
    config: ResolvedModelConfig,
    input: ModelInput,
    timeoutMs?: number,
    // Reports queue time so a caller budgeting wall clock can exclude it.
    onGateWait?: (waitedMs: number) => void,
  ): Promise<ModelResponse> {
    // Resolve credentials BEFORE taking a gate slot, so slow KV/crypto work never occupies one.
    if (config.apiFormat === 'cloudflare-workers-ai') {
      return this.rateLimits.runGated(config, onGateWait, () =>
        reviewWithCloudflare(this.env, config.modelName, input, this.tracker, config.providerName, { timeoutMs }),
      );
    }

    if (config.apiFormat === 'gemini') {
      const apiKey = await this.decryptApiKey(config);
      const schemaKey = `${config.providerId}|${config.modelName}|${input.responseSchema?.name ?? 'none'}`;
      let response: ModelResponse;
      try {
        response = await this.rateLimits.runGated(config, onGateWait, () => {
          // Read inside the gate: hoisted, the opening wave would all see "not yet known" and probe.
          const gatedInput = this.schemaUnsupportedModels.has(schemaKey)
            ? { ...input, responseSchema: undefined }
            : input;
          return reviewWithGoogle(
            { apiKey, baseUrl: config.baseUrl, providerName: config.providerName, timeoutMs },
            config.modelName,
            gatedInput,
            this.tracker,
          );
        });
      } catch (error) {
        // Latch on failure too: the probe already proved the grammar is refused, and without this a
        // schema-dropped attempt that then 429s re-pays the 400 plus a full prompt on the next call.
        if (isSchemaDroppedError(error)) this.schemaUnsupportedModels.add(schemaKey);
        throw error;
      }
      if (response.degraded === 'schema-dropped') {
        this.schemaUnsupportedModels.add(schemaKey);
      }
      return response;
    }

    if (config.apiFormat === 'vertex') {
      const apiKey = await this.decryptApiKey(config);
      return this.rateLimits.runGated(config, onGateWait, () =>
        reviewWithVertex(
          { apiKey, baseUrl: config.baseUrl, providerName: config.providerName, timeoutMs },
          config.modelName,
          input,
          this.tracker,
        ),
      );
    }

    if (config.apiFormat === 'openai') {
      const apiKey = await this.decryptApiKey(config);
      return this.rateLimits.runGated(config, onGateWait, () =>
        reviewWithOpenAI(
          {
            apiKey,
            baseUrl: config.baseUrl || 'https://api.openai.com/v1',
            providerName: config.providerName,
            timeoutMs,
          },
          config.modelName,
          input,
          this.tracker,
        ),
      );
    }

    const apiKey = await this.decryptApiKey(config);
    return this.rateLimits.runGated(config, onGateWait, () =>
      reviewWithAnthropic(
        { apiKey, baseUrl: config.baseUrl, providerName: config.providerName, timeoutMs },
        config.modelName,
        input,
        this.tracker,
      ),
    );
  }

  private async callModel(model: string, input: ModelInput, timeoutMs?: number): Promise<ModelResponse> {
    return this.callResolvedModel(await this.resolveModel(model), input, timeoutMs);
  }

  // chainCtx() plus the review flow's extra per-invocation state.
  private reviewCtx(): ModelReviewContext {
    return {
      ...this.chainCtx(),
      env: this.env,
      rateLimits: this.rateLimits,
      asyncUnsupportedModels: this.asyncUnsupportedModels,
      chainProgress: this.chainProgress,
    };
  }

  async reviewFile(params: Parameters<typeof reviewFile>[1]) {
    return reviewFile(this.reviewCtx(), params);
  }

  // Several small files in one call; `batch.missing` files must not be recorded as reviewed.
  async reviewFiles(params: Parameters<typeof reviewFiles>[1]) {
    return reviewFiles(this.reviewCtx(), params);
  }

  async submitReviewBatch(params: Parameters<typeof submitReviewBatch>[1]) {
    return submitReviewBatch(this.reviewCtx(), params);
  }

  async pollReviewBatch(params: Parameters<typeof pollReviewBatch>[1]) {
    return pollReviewBatch(this.reviewCtx(), params);
  }

  // Hands the extracted flows the private model-chain surface. Built per call; holds no state.
  private chainCtx(): ModelChainContext {
    return {
      selectModel: (params) => this.selectModel(params),
      resolveModel: (model) => this.resolveModel(model),
      isProviderUnavailable: (providerId) => this.isProviderUnavailable(providerId),
      markProviderUnavailable: (providerId, reason) => this.markProviderUnavailable(providerId, reason),
      callResolvedModel: (resolved, input, timeoutMs, onGateWait) =>
        this.callResolvedModel(resolved, input, timeoutMs, onGateWait),
      tracker: this.tracker,
      jobId: this.options.jobId,
    };
  }

  async generateSummary(params: {
    prTitle: string | null;
    verdict: 'approve' | 'comment';
    fileSummaries: Array<{ path: string; summary: string; verdict: string }>;
    config: RepoConfig;
  }) {
    return generateSummary(this.chainCtx(), params);
  }

  async verifyFindings(params: { candidates: VerifyCandidate[]; config: RepoConfig }): Promise<ModelResponse> {
    return verifyFindings(this.chainCtx(), params);
  }
}
