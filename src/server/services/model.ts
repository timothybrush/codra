import type { AppBindings } from '../env';
import { reviewWithGoogle } from '../models/google';
import { reviewWithCloudflare, submitCloudflareBatch, pollCloudflareBatch } from '../models/cloudflare';
import { reviewWithOpenAI } from '../models/openai';
import { reviewWithAnthropic } from '../models/anthropic';
import { buildFileReviewPrompts, buildReviewResponseSchema } from '../prompts/file-review';
import { buildSummaryPrompt, SUMMARY_SYSTEM_PROMPT } from '../prompts/summary';
import { buildVerifyPrompt, VERIFY_RESPONSE_SCHEMA, VERIFY_SYSTEM_PROMPT, type VerifyCandidate } from '../prompts/verify';
import { parseFileReviewResponse } from '../core/model-output';
import { truncateFileDiff, chunkFileDiff } from '../core/diff';
import type { RepoConfig } from '@shared/schema';
import type { TokenTracker } from '../core/token-tracker';
import { UnparseableModelResponseError, type ModelInput, type ModelResponse } from '../models/types';
import { logger } from '../core/logger';
import { normalizeModelId } from '@shared/schema';
import { isTimeoutMessage, matchesAnyTransientSubstring } from '@shared/transient-errors';
import { getResolvedModelConfig, type ResolvedModelConfig } from '@server/db/model-configs';
import { decryptLlmApiKey } from '@server/core/llm-crypto';
import { ModelCallGate, adaptiveModelTimeoutMs, MODEL_FALLBACK_CHAIN_BUDGET_MS } from '../models/limits';

const PROVIDER_UNAVAILABLE_TTL_SECONDS = 24 * 60 * 60;
const COMPACT_REVIEW_PROMPT_LINE_CAP = 400;
/**
 * How many models may report a quota/rate-limit failure for one file before the file is deferred
 * instead of continuing down the fallback chain.
 *
 * Two, because each model has its own quota bucket -- a Google 429 names the specific model
 * (`limit: 16000, model: gemma-4-31b`), so the next model in the chain genuinely has a fresh
 * allowance and often succeeds. Beyond two, the odds drop and each further attempt is a
 * subrequest spent learning nothing, on an invocation that only gets 50 of them.
 */
const MAX_QUOTA_FAILURES_PER_FILE = 2;
const MODEL_ALIASES: Record<string, string> = {
  'gemma-4-31b': 'gemma-4-31b-it',
  'gemma-4-26b': 'gemma-4-26b-a4b-it',
};

/** Sums per-key counters across a file's chunks. */
function mergeCounts(sources: Array<Record<string, number> | undefined>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const source of sources) {
    for (const [key, count] of Object.entries(source ?? {})) {
      merged[key] = (merged[key] ?? 0) + count;
    }
  }
  return merged;
}

export class RetryableModelError extends Error {
  readonly retryable = true;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RetryableModelError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: cause,
        writable: true,
        configurable: true,
      });
    }
  }
}

export function isRetryableModelError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'retryable' in error && error.retryable === true);
}

function normalizeModel(model: string) {
  return normalizeModelId(MODEL_ALIASES[model] ?? model);
}

function uniqueModels(models: string[]) {
  return Array.from(new Set(models.map(normalizeModel)));
}

function isCloudflareAllocationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('4006') || message.toLowerCase().includes('daily free allocation');
}

function isGoogleRateLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return false;
  }
  
  return lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota exceeded');
}

function isTransientModelFailure(error: unknown) {
  if (isRetryableModelError(error)) return true;
  // No reviewable output (reasoning-only / truncated / empty) is deterministic -- never retry it.
  if (error instanceof UnparseableModelResponseError) return false;
  if (isCloudflareAllocationError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  // Explicitly fail fast for timeouts so they don't loop endlessly
  if (isTimeoutMessage(lower)) {
    return false;
  }

  return (
    isGoogleRateLimitError(error) ||
    matchesAnyTransientSubstring(lower) ||
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('temporar') ||
    // Upstream 5xx (e.g. Gemini's frequent "request failed with 500: Internal error encountered")
    // is a transient server-side outage, not a deterministic client error. Without this a sustained
    // 5xx run makes every model in the chain throw a non-transient error, so the file is marked
    // permanently failed instead of being deferred and retried once the provider recovers.
    /\b50[0-9]\b/.test(lower) ||
    lower.includes('internal error')
  );
}

export class ModelService {
  // Model configs don't change during a single review invocation, but resolveModel() is called
  // once per file *and* once per fallback model. Left uncached that's a Hyperdrive round-trip
  // (a counted subrequest) for every one of those, which both burns the per-invocation
  // subrequest budget (shrinking how many files a chunk can review in parallel) and floods the
  // connection pool. Memoize per ModelService instance (one instance == one invocation/chunk)
  // so each distinct model is resolved from the DB at most once. Cache the in-flight promise
  // (not just the settled value) so concurrent resolveModel() calls for the same model made
  // before the first DB round-trip completes all await the same request instead of each firing
  // their own.
  private readonly resolvedModelCache = new Map<string, Promise<ResolvedModelConfig | null>>();

  // The Workers runtime allows only 6 simultaneous connections per invocation; anything beyond
  // that is queued without starting. When several files review in parallel, un-gated model
  // calls queue behind each other and burn their entire client timeout before the request is
  // even dispatched (observed as a provider "timing out" at exactly the configured timeout on
  // every attempt). Gate all outbound model calls for this invocation so a call's timeout only
  // starts once it actually has a connection slot.
  private readonly callGate = new ModelCallGate();

  // Provider-unavailable markers live in KV and every read is a counted subrequest. The marker
  // can't flip from set back to unset within one invocation, so cache lookups per instance
  // (one instance == one invocation) instead of re-reading KV for every file in the chunk.
  private readonly providerUnavailableCache = new Map<string, Promise<boolean>>();

  // Models proven (this invocation) not to support the async batch queue. try-async-then-fallback
  // means the first file probes async; if that fails, every later file in the same chunk skips the
  // probe and goes straight to the synchronous path, so a non-async model isn't charged an extra
  // (potentially full-inference) submit attempt per file.
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
  ): Promise<ModelResponse> {
    // Resolve credentials *before* taking a gate slot so slow KV/crypto work never occupies a
    // model-call slot, then run the actual provider request under the gate. The provider's
    // timeout only starts inside the gated call, so time spent waiting for a slot is free.
    if (config.apiFormat === 'cloudflare-workers-ai') {
      return this.callGate.run(() =>
        reviewWithCloudflare(this.env, config.modelName, input, this.tracker, config.providerName, { timeoutMs }),
      );
    }

    if (config.apiFormat === 'gemini') {
      const apiKey = await this.decryptApiKey(config);
      return this.callGate.run(() =>
        reviewWithGoogle(
          { apiKey, baseUrl: config.baseUrl, providerName: config.providerName, timeoutMs },
          config.modelName,
          input,
          this.tracker,
        ),
      );
    }

    if (config.apiFormat === 'openai') {
      const apiKey = await this.decryptApiKey(config);
      return this.callGate.run(() =>
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
    return this.callGate.run(() =>
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

  async reviewFile(params: {
    file: any;
    prTitle: string | null;
    prDescription: string | null;
    config: RepoConfig;
    totalLineCount: number;
    compactPrompt?: boolean;
  }) {
    const configuredLineCap = params.config.review.max_diff_lines_per_file;
    const modelLineCap = params.compactPrompt
      ? Math.min(configuredLineCap, COMPACT_REVIEW_PROMPT_LINE_CAP)
      : configuredLineCap;

    let chunks = chunkFileDiff(params.file, modelLineCap);
    // Remember the pre-cap chunk count so wasPromptTruncated doesn't have to re-run chunkFileDiff.
    const totalChunkCount = chunks.length;

    // Cap chunks to prevent single files from burning all subrequests and getting stuck.
    const MAX_CHUNKS = 4;
    if (chunks.length > MAX_CHUNKS) {
      chunks = chunks.slice(0, MAX_CHUNKS);
    }

    if (chunks.length === 1) {
      return this.reviewFileChunk({ ...params, file: chunks[0] });
    }

    const results: Array<ModelResponse & { parsed: ReturnType<typeof parseFileReviewResponse>, reviewedLineCount: number, wasPromptTruncated: boolean, userPrompt: string }> = [];
    
    for (const chunk of chunks) {
      // Don't start a new chunk if we are dangerously close to the 50 subrequest limit.
      if (results.length > 0 && this.tracker?.isNearLimit()) {
        logger.warn(`Stopping chunk processing for ${params.file.path} early due to subrequest budget limits.`);
        break;
      }
      
      try {
        const res = await this.reviewFileChunk({ ...params, file: chunk });
        results.push(res as any);
      } catch (error) {
        if (results.length === 0) {
          throw error; // First chunk failed, let it defer/fail properly
        }
        logger.warn(`Chunk review failed for ${params.file.path}, returning partial results to avoid stalling the job.`, { error: error instanceof Error ? error.message : String(error) });
        break;
      }
    }

    const combinedFindings = results.flatMap(r => r.parsed.comments);
    // Report the file with the most serious chunk's verdict/summary/correctness, not just the last
    // chunk's: taking `results[results.length - 1]` would let a clean final chunk mask real findings
    // from an earlier chunk of the same file (reporting verdict 'approve' while carrying its comments).
    const primaryResult = results.find(r => r.parsed.verdict === 'comment') ?? results[results.length - 1];

    return {
      ...primaryResult,
      inputTokens: results.reduce((sum, r) => sum + r.inputTokens, 0),
      outputTokens: results.reduce((sum, r) => sum + r.outputTokens, 0),
      parsed: {
        ...primaryResult.parsed,
        comments: combinedFindings,
        // Summed across chunks, not inherited from the primary one. These counters drive the
        // "N claims were withheld" note and the approve/comment verdict, so taking a single chunk's
        // numbers would under-report a truncated file's withheld findings by up to 3/4.
        evidenceStats: results.reduce((acc, r) => ({
          total: acc.total + (r.parsed.evidenceStats?.total ?? 0),
          matched: acc.matched + (r.parsed.evidenceStats?.matched ?? 0),
          unmatched: acc.unmatched + (r.parsed.evidenceStats?.unmatched ?? 0),
          weak: acc.weak + (r.parsed.evidenceStats?.weak ?? 0),
          absent: acc.absent + (r.parsed.evidenceStats?.absent ?? 0),
        }), { total: 0, matched: 0, unmatched: 0, weak: 0, absent: 0 }),
        claimTypeCounts: mergeCounts(results.map((r) => r.parsed.claimTypeCounts)),
        deniedClaimCounts: mergeCounts(results.map((r) => r.parsed.deniedClaimCounts)),
        absenceCheckStats: results.reduce((acc, r) => ({
          absenceShaped: acc.absenceShaped + (r.parsed.absenceCheckStats?.absenceShaped ?? 0),
          identifierExtracted: acc.identifierExtracted + (r.parsed.absenceCheckStats?.identifierExtracted ?? 0),
          refuted: acc.refuted + (r.parsed.absenceCheckStats?.refuted ?? 0),
        }), { absenceShaped: 0, identifierExtracted: 0, refuted: 0 }),
      },
      reviewedLineCount: results.reduce((sum, r) => sum + r.reviewedLineCount, 0),
      wasPromptTruncated: chunks.length < totalChunkCount || results.length < chunks.length,
    };
  }

  /**
   * Try to submit a file's review to the Workers AI asynchronous batch queue. Returns the queue
   * request_id and the model it was submitted to, or null when async batching isn't usable for
   * the primary model (non-Cloudflare provider, or the model/account doesn't support queueing) --
   * in which case the caller falls back to the synchronous reviewFile path. This decouples slow
   * (e.g. reasoning) model inference from the per-invocation timeout and subrequest cap.
   */
  async submitReviewBatch(params: {
    file: any;
    prTitle: string | null;
    prDescription: string | null;
    config: RepoConfig;
    totalLineCount: number;
    compactPrompt?: boolean;
  }): Promise<{ requestId: string; model: string } | null> {
    const { primary } = this.selectModel({ totalLineCount: params.totalLineCount, config: params.config });

    let resolved: ResolvedModelConfig;
    try {
      resolved = await this.resolveModel(primary);
    } catch {
      return null;
    }
    // Only Cloudflare Workers AI exposes the async batch queue; other providers use the sync path.
    if (resolved.apiFormat !== 'cloudflare-workers-ai') return null;
    // Skip the probe for a model already shown not to support async queueing this invocation.
    if (this.asyncUnsupportedModels.has(resolved.modelName)) return null;

    const configuredLineCap = params.config.review.max_diff_lines_per_file;
    const modelLineCap = params.compactPrompt
      ? Math.min(configuredLineCap, COMPACT_REVIEW_PROMPT_LINE_CAP)
      : configuredLineCap;
    const file = truncateFileDiff(params.file, modelLineCap);
    const { systemPrompt, userPrompt } = buildFileReviewPrompts({
      ...params,
      file,
      config: params.config.review,
    });

    try {
      const requestId = await this.callGate.run(() =>
        submitCloudflareBatch(
          this.env,
          resolved.modelName,
          { systemPrompt, userPrompt, responseSchema: buildReviewResponseSchema(params.config.review.max_comments) },
          this.tracker,
        ),
      );
      return { requestId, model: resolved.modelName };
    } catch (error) {
      // Any failure here (async unsupported, transient submit error) is non-fatal: the caller
      // reviews the file synchronously instead. Remember the model so sibling files this
      // invocation don't each pay the failed probe.
      this.asyncUnsupportedModels.add(resolved.modelName);
      logger.warn(`Async batch submit unavailable for ${resolved.modelName}; using synchronous review`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Poll a previously submitted async batch review. Returns 'pending' while still queued/running,
   * 'done' with the parsed review once complete, or 'failed' if the poll or parse errored.
   */
  async pollReviewBatch(params: { model: string; requestId: string; file: any; config: RepoConfig }): Promise<
    | { status: 'pending' }
    | { status: 'done'; response: ModelResponse & { parsed: ReturnType<typeof parseFileReviewResponse>; reviewedLineCount: number; wasPromptTruncated: boolean; userPrompt: string } }
    | { status: 'failed'; error: unknown }
  > {
    let resolved: ResolvedModelConfig;
    try {
      resolved = await this.resolveModel(params.model);
    } catch (error) {
      return { status: 'failed', error };
    }

    try {
      const poll = await this.callGate.run(() =>
        pollCloudflareBatch(this.env, resolved.modelName, params.requestId, this.tracker, resolved.providerName),
      );
      if (poll.status === 'pending') return { status: 'pending' };

      const response = poll.response;
      if (this.tracker) {
        this.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
      }
      const parsed = parseFileReviewResponse(response.rawText, params.file, {
        deniedClaimTypes: params.config.review.deny_claim_types,
      });
      return {
        status: 'done',
        response: {
          ...response,
          parsed,
          userPrompt: '',
          reviewedLineCount: params.file.lineCount,
          wasPromptTruncated: params.file.isTruncated === true,
        },
      };
    } catch (error) {
      return { status: 'failed', error };
    }
  }

  private async reviewFileChunk(params: {
    file: any;
    prTitle: string | null;
    prDescription: string | null;
    config: RepoConfig;
    totalLineCount: number;
    compactPrompt?: boolean;
  }) {
    const { systemPrompt, userPrompt } = buildFileReviewPrompts({
      ...params,
      file: params.file,
      config: params.config.review,
    });
    const responseSchema = buildReviewResponseSchema(params.config.review.max_comments);

    const { primary, fallbacks } = this.selectModel({
      totalLineCount: params.totalLineCount,
      config: params.config,
    });
    const modelsToTry = [primary, ...fallbacks];

    // Size the per-call timeout to the diff the model actually sees: small
    // files fail over to the next model fast; large diffs get a proportionally longer budget.
    const timeoutMs = adaptiveModelTimeoutMs(params.file.lineCount);

    let lastError: unknown;
    let lastTransientError: unknown;
    let sawTransientFailure = false;
    let quotaFailures = 0;
    const chainStartedAt = Date.now();
    for (const [modelIndex, currentModel] of modelsToTry.entries()) {
      // Always allow the first (primary) model a shot even if the shared job budget is
      // already tight, so a file isn't punished for other files' earlier failures. But once
      // we're into the fallback chain, each additional attempt costs more subrequests
      // (config lookup + provider call, sometimes a provider-availability check too) that
      // could tip this whole invocation over Cloudflare's per-invocation subrequest cap
      // (Workers Free plan: 50). Defer the file for a later retry instead of gambling the
      // rest of the invocation's budget on a low-probability extra fallback.
      if (modelIndex > 0 && this.tracker?.isNearLimit()) {
        logger.warn(`Skipping remaining fallback models for ${params.file.path}; subrequest budget for this invocation is nearly exhausted`, {
          skippedModels: modelsToTry.slice(modelIndex),
        });

        // If we haven't seen any transient failures (e.g. they were all permanent timeouts),
        // don't force this to become a transient failure. Just break and let the last permanent error propagate.
        if (sawTransientFailure) {
          lastTransientError = lastTransientError ?? lastError ?? new Error('Subrequest budget for this invocation was nearly exhausted before trying all configured fallback models');
        }
        break;
      }

      // Stop walking the fallback chain once this file has consumed its wall-clock budget: a long
      // chain of slow/timing-out models could otherwise run several calls back-to-back and push the
      // whole workflow invocation past Cloudflare's ~120s limit (killing it as `exceededCpu` and
      // losing all progress). Defer instead -- the file resumes from the fast primary model in a
      // fresh invocation. Always let the primary (modelIndex 0) run first.
      if (modelIndex > 0 && Date.now() - chainStartedAt > MODEL_FALLBACK_CHAIN_BUDGET_MS) {
        logger.warn(`Deferring ${params.file.path}: fallback chain exceeded its per-invocation time budget`, {
          elapsedMs: Date.now() - chainStartedAt,
          skippedModels: modelsToTry.slice(modelIndex),
        });
        // Treat as a transient/deferrable outcome so the file is retried on a fresh budget rather
        // than marked permanently failed.
        sawTransientFailure = true;
        lastTransientError = lastTransientError ?? lastError ?? new Error(`Model fallback chain for ${params.file.path} exceeded its time budget; deferring for retry.`);
        break;
      }

      let resolved: ResolvedModelConfig;
      try {
        resolved = await this.resolveModel(currentModel);
      } catch (error) {
        lastError = error;
        logger.warn(`Model ${currentModel} could not be resolved`, {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (resolved.apiFormat === 'cloudflare-workers-ai' && await this.isProviderUnavailable(resolved.providerId)) {
        logger.warn(`Skipping ${resolved.providerName} model ${currentModel} because the provider is unavailable for job ${this.options.jobId ?? 'unknown'}`);
        continue;
      }

      // One shot per model: a failed call is never retried against the same model (a retryable
      // outage is handled by deferring the whole file to a fresh invocation), so on failure we just
      // fall through to the next model in the fallback chain.
      try {
        const response = await this.callResolvedModel(resolved, { systemPrompt, userPrompt, responseSchema }, timeoutMs);

        if (this.tracker) {
          this.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
        }

        const parsed = parseFileReviewResponse(response.rawText, params.file, {
          deniedClaimTypes: params.config.review.deny_claim_types,
        });
        return {
          ...response,
          parsed,
          userPrompt,
          reviewedLineCount: params.file.lineCount,
          wasPromptTruncated: params.file.isTruncated === true,
        };
      } catch (error) {
        lastError = error;
        if (isTransientModelFailure(error)) {
          sawTransientFailure = true;
          lastTransientError = error;
        }
        if (resolved.apiFormat === 'cloudflare-workers-ai' && isCloudflareAllocationError(error)) {
          await this.markProviderUnavailable(resolved.providerId, error instanceof Error ? error.message : String(error));
        }

        const rateLimited = isGoogleRateLimitError(error);
        if (rateLimited) quotaFailures += 1;

        // A quota 429 means "come back later", not "try a different model". Walking a long chain
        // in response is the single biggest way to blow the invocation's 50-subrequest cap: nine
        // models x three attempts is 27 subrequests for ONE file, against a per-file estimate of 5.
        // A couple of attempts is worth it -- each model has its own quota bucket, so the second
        // one often succeeds -- but past that, defer. The file resumes in a fresh invocation with a
        // fresh budget, by which time the bucket has refilled, which is the backoff that actually
        // works.
        const outOfQuotaBudget = quotaFailures >= MAX_QUOTA_FAILURES_PER_FILE;

        logger.warn(`Model ${currentModel} failed for ${params.file.path}`, {
          error: error instanceof Error ? error.message : String(error),
          rateLimited,
          quotaFailures,
          willTryFallback: !outOfQuotaBudget && modelIndex < modelsToTry.length - 1,
        });

        if (outOfQuotaBudget) {
          sawTransientFailure = true;
          lastTransientError = error;
          break;
        }
        // Fall through to the next model in the fallback chain.
      }
    }

    if (sawTransientFailure) {
      const retryCause = lastTransientError ?? lastError;
      const lastMessage = retryCause instanceof Error ? retryCause.message : String(retryCause ?? 'Unknown model error');
      throw new RetryableModelError(
        `All configured review models failed for ${params.file.path}; retrying later. Last error: ${lastMessage}`,
        retryCause,
      );
    }

    throw lastError;
  }

  async generateSummary(params: {
    prTitle: string | null;
    verdict: 'approve' | 'comment';
    fileSummaries: Array<{ path: string; summary: string; verdict: string }>;
    config: RepoConfig;
  }) {
    const { primary, fallbacks } = this.selectModel({ totalLineCount: 0, config: params.config });
    const modelsToTry = [primary, ...fallbacks];

    let lastError: unknown;
    let lastTransientError: unknown;
    let sawTransientFailure = false;
    for (const currentModel of modelsToTry) {
      let resolved: ResolvedModelConfig;
      try {
        resolved = await this.resolveModel(currentModel);
      } catch (error) {
        lastError = error;
        logger.warn(`Summary model ${currentModel} could not be resolved`, {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (resolved.apiFormat === 'cloudflare-workers-ai' && await this.isProviderUnavailable(resolved.providerId)) {
        logger.warn(`Skipping ${resolved.providerName} summary model ${currentModel} because the provider is unavailable for job ${this.options.jobId ?? 'unknown'}`);
        continue;
      }

      try {
        const response = await this.callResolvedModel(resolved, {
          systemPrompt: SUMMARY_SYSTEM_PROMPT,
          userPrompt: buildSummaryPrompt(params),
        }, adaptiveModelTimeoutMs(0));

        if (this.tracker) {
          this.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
        }

        return response;
      } catch (error) {
        lastError = error;
        if (isTransientModelFailure(error)) {
          sawTransientFailure = true;
          lastTransientError = error;
        }
        if (resolved.apiFormat === 'cloudflare-workers-ai' && isCloudflareAllocationError(error)) {
          await this.markProviderUnavailable(resolved.providerId, error instanceof Error ? error.message : String(error));
        }
        logger.warn(`Summary model ${currentModel} failed`, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (sawTransientFailure) {
      const retryCause = lastTransientError ?? lastError;
      const lastMessage = retryCause instanceof Error ? retryCause.message : String(retryCause ?? 'Unknown model error');
      throw new RetryableModelError(
        `All configured summary models failed; retrying later. Last error: ${lastMessage}`,
        retryCause,
      );
    }

    throw lastError;
  }

  /**
   * Runs one consolidated verification call: the model re-checks candidate findings against their
   * diff context and returns keep/drop verdicts. Best-effort — the caller treats any throw as
   * "verification unavailable" and keeps the pre-verification findings, so this must never be relied
   * on to block a review. Reuses the same model chain and concurrency gate as the review call.
   */
  async verifyFindings(params: { candidates: VerifyCandidate[]; config: RepoConfig }): Promise<ModelResponse> {
    const { primary, fallbacks } = this.selectModel({ totalLineCount: 0, config: params.config });
    const modelsToTry = [primary, ...fallbacks];
    const input: ModelInput = {
      systemPrompt: VERIFY_SYSTEM_PROMPT,
      userPrompt: buildVerifyPrompt(params.candidates),
      // The verify grammar, NOT the file-review one. Sending the review schema here (as this code
      // used to, unconditionally, at the provider layer) makes strict decoding impossible to
      // satisfy and silently turns the whole verification pass into a no-op.
      responseSchema: VERIFY_RESPONSE_SCHEMA as unknown as ModelInput['responseSchema'],
    };
    // Scale the timeout with the number of findings under review (capped inside adaptiveModelTimeoutMs).
    const timeoutMs = adaptiveModelTimeoutMs(params.candidates.length * 8);

    let lastError: unknown;
    for (const currentModel of modelsToTry) {
      let resolved: ResolvedModelConfig;
      try {
        resolved = await this.resolveModel(currentModel);
      } catch (error) {
        lastError = error;
        continue;
      }

      if (resolved.apiFormat === 'cloudflare-workers-ai' && await this.isProviderUnavailable(resolved.providerId)) {
        continue;
      }

      try {
        const response = await this.callResolvedModel(resolved, input, timeoutMs);
        if (this.tracker) {
          this.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
        }
        return response;
      } catch (error) {
        lastError = error;
        if (resolved.apiFormat === 'cloudflare-workers-ai' && isCloudflareAllocationError(error)) {
          await this.markProviderUnavailable(resolved.providerId, error instanceof Error ? error.message : String(error));
        }
        logger.warn(`Verification model ${currentModel} failed`, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    throw lastError ?? new Error('No model available for verification pass.');
  }
}
