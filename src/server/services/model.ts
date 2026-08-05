import type { AppBindings } from '../env';
import { reviewWithGoogle } from '../models/google';
import { reviewWithVertex } from '../models/vertex';
import { reviewWithCloudflare } from '../models/cloudflare';
import { reviewWithOpenAI } from '../models/openai';
import { reviewWithAnthropic } from '../models/anthropic';
import type { VerifyCandidate } from '../prompts/verify';
import type { RepoConfig } from '@shared/schema';
import type { TokenTracker } from '../core/token-tracker';
import type { ModelInput, ModelResponse } from '../models/types';
import { logger } from '../core/logger';
import { getResolvedModelConfig, type ResolvedModelConfig } from '@server/db/model-configs';
import { decryptLlmApiKey } from '@server/core/llm-crypto';
import {
  normalizeModel,
  uniqueModels,
} from './model-support';
import { ModelRateLimitBook } from './model-rate-limits';
import { type ModelChainContext, generateSummary, verifyFindings } from './model-chain-runner';
import { type ModelReviewContext, reviewFile } from './model-review-file';
import { pollReviewBatch, submitReviewBatch } from './model-review-batch';

// Re-exported: core/review.ts and two specs import these from '@server/services/model'.
export { RetryableModelError, isRetryableModelError } from './model-support';

const PROVIDER_UNAVAILABLE_TTL_SECONDS = 24 * 60 * 60;
export class ModelService {
  // resolveModel() runs once per file AND per fallback model; uncached, that is a counted
  // subrequest each time. Memoized per instance. Caches the in-flight PROMISE, so concurrent
  // calls for the same model await one request instead of each firing their own.
  private readonly resolvedModelCache = new Map<string, Promise<ResolvedModelConfig | null>>();

  // Rate-limit learning plus the connection/token gates. See model-rate-limits.ts -- keyed by
  // MODEL, not provider.
  private readonly rateLimits = new ModelRateLimitBook();

  // Provider-unavailable markers live in KV and every read is a counted subrequest. They can't
  // flip set-to-unset within one invocation, so cache per instance instead of re-reading KV.
  private readonly providerUnavailableCache = new Map<string, Promise<boolean>>();

  // Models proven this invocation not to support async batching. The first file probes; if it
  // fails, every later file in the chunk skips straight to the synchronous path instead of
  // paying for another failed submit attempt.
  private readonly asyncUnsupportedModels = new Set<string>();

  constructor(
    private env: AppBindings,
    private tracker?: TokenTracker,
    private options: { jobId?: string } = {},
  ) {}

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

    // Apply size overrides based on total PR lines
    if (modelCfg?.size_overrides && modelCfg.size_overrides.length > 0) {
      const sortedOverrides = [...modelCfg.size_overrides].sort((a, b) => a.max_lines - b.max_lines);
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
      // Cache the DB answer -- including a null "not configured" result -- so a missing or
      // repeatedly-used model isn't re-queried for every file in the chunk.
      pending = getResolvedModelConfig(this.env, normalized);
      this.resolvedModelCache.set(normalized, pending);
      // A failed lookup (e.g. a transient DB error) shouldn't poison the cache for the rest of
      // the invocation -- drop it so the next call retries instead of rejecting immediately.
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
    // Resolve credentials BEFORE taking a gate slot, so slow KV/crypto work never occupies one;
    // the provider's timeout starts only inside the gated call.
    if (config.apiFormat === 'cloudflare-workers-ai') {
      return this.rateLimits.runGated(config, onGateWait, () =>
        reviewWithCloudflare(this.env, config.modelName, input, this.tracker, config.providerName, { timeoutMs }),
      );
    }

    if (config.apiFormat === 'gemini') {
      const apiKey = await this.decryptApiKey(config);
      return this.rateLimits.runGated(config, onGateWait, () =>
        reviewWithGoogle(
          { apiKey, baseUrl: config.baseUrl, providerName: config.providerName, timeoutMs },
          config.modelName,
          input,
          this.tracker,
        ),
      );
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

  // Extends chainCtx() with the review flow's extra per-invocation state. See model-review-file.ts.
  private reviewCtx(): ModelReviewContext {
    return {
      ...this.chainCtx(),
      env: this.env,
      rateLimits: this.rateLimits,
      asyncUnsupportedModels: this.asyncUnsupportedModels,
    };
  }

  async reviewFile(params: Parameters<typeof reviewFile>[1]) {
    return reviewFile(this.reviewCtx(), params);
  }

  async submitReviewBatch(params: Parameters<typeof submitReviewBatch>[1]) {
    return submitReviewBatch(this.reviewCtx(), params);
  }

  async pollReviewBatch(params: Parameters<typeof pollReviewBatch>[1]) {
    return pollReviewBatch(this.reviewCtx(), params);
  }

  // Hands the extracted flows the private model-chain surface without making it public. Built per
  // call; it holds no state of its own.
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
