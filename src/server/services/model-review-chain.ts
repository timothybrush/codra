import { logger } from '../core/logger';
import { isSubrequestBudgetMessage, isTimeoutMessage } from '@codra/schema/transient-errors';
import type { RepoConfig } from '@codra/schema';
import type { AppBindings } from '../env';
import type { ModelResponseSchema } from '../models/types';
import { clampTimeoutToChainBudget, MODEL_FALLBACK_CHAIN_BUDGET_MS, SUBREQUEST_HEADROOM_FOR_MODEL_CALL } from '../models/limits';
import {
  estimatePromptTokens,
  isCloudflareAllocationError,
  isGoogleRateLimitError,
  isTransientModelFailure,
  RetryableModelError,
} from './model-support';
import type { ResolvedModelConfig } from '@codra/db/model-configs';
import type { ModelChainContext } from './model-chain-runner';
import type { ModelRateLimitBook } from './model-rate-limits';
import type { ModelChainProgressStore } from './model-chain-progress';

// Fallback chain for single/batched reviews. Import from services/model barrel.

// Past two quota failures per file burns subrequests for nothing.
const MAX_QUOTA_FAILURES_PER_FILE = 2;

// Internal per-invocation chain state.
export type ModelReviewContext = ModelChainContext & {
  env: AppBindings;
  rateLimits: ModelRateLimitBook;
  // Models lacking async batching; routes subsequent files directly to synchronous.
  asyncUnsupportedModels: Set<string>;
  // Per-job memo of chain progress for each label.
  chainProgress: ModelChainProgressStore;
};

// Walks chain returning first success. `parse` errors count as model failures.
export async function runModelChain<T>(ctx: ModelReviewContext, params: {
  systemPrompt: string;
  userPrompt: string;
  // Accepts both single-file and batched response schemas.
  responseSchema: ModelResponseSchema;
  timeoutMs: number;
  label: string;
  totalLineCount: number;
  config: RepoConfig;
  // Needed output tokens; adapters clamp it, omission defaults to provider ceiling.
  outputBudgetTokens?: number;
  // `isLastModel` allows parsers to reject weak answers and try better models, accepting them only as a last resort.
  parse: (rawText: string, ctx: { isLastModel: boolean }) => T;
  // Keys for resume memo. Bins pass member paths so progress survives mid-batch success/de-escalation.
  progressLabels?: readonly string[];
}) {
  const { systemPrompt, userPrompt, responseSchema, label, outputBudgetTokens } = params;
  const progressLabels = params.progressLabels?.length ? params.progressLabels : [label];

  const { primary, fallbacks } = ctx.selectModel({
    totalLineCount: params.totalLineCount,
    config: params.config,
  });
  const wholeChain = [primary, ...fallbacks];

  // Resumes from invocation memo. Clamped to prevent empty chains on mid-job config changes.
  // Takes the MINIMUM across members so no file skips a model untried due to bin-mates.
  const recorded = await Promise.all(progressLabels.map((key) => ctx.chainProgress.startIndexFor(key)));
  const startIndex = Math.min(Math.min(...recorded), Math.max(wholeChain.length - 1, 0));
  const modelsToTry = wholeChain.slice(startIndex);
  if (startIndex > 0) {
    logger.info(`Resuming the model chain for ${label} at ${modelsToTry[0]}`, {
      startIndex,
      skipped: wholeChain.slice(0, startIndex),
    });
  }

  // Guards chain head; see clampTimeoutToChainBudget.
  const timeoutMs = clampTimeoutToChainBudget(params.timeoutMs);

  const estimatedPromptTokens = estimatePromptTokens(systemPrompt, userPrompt);

  let lastError: unknown;
  let lastTransientError: unknown;
  let sawTransientFailure = false;
  let quotaFailures = 0;
  // Prevents undefined lastError from failing files permanently.
  let attemptedAnyModel = false;
  // Distinguishes rate-limit skips from timeouts for job logs.
  let skippedForTimeouts = false;
  // Advances memo past failed models only; skips/429s never rule out the current model.
  let attemptedFailedThrough = 0;
  const chainStartedAt = Date.now();
  // Excluded from call timeout so busy gates don't manifest as slow models.
  let gateWaitMs = 0;
  const recordGateWait = (waitedMs: number) => { gateWaitMs += waitedMs; };
  for (const [modelIndex, currentModel] of modelsToTry.entries()) {
    // Primary guaranteed; fallbacks near 50-subrequest cap defer.
    if (modelIndex > 0 && ctx.tracker?.isNearLimit()) {
      logger.warn(`Skipping remaining fallback models for ${label}; subrequest budget for this invocation is nearly exhausted`, {
        skippedModels: modelsToTry.slice(modelIndex),
      });

      // If no transient failures, let permanent error propagate. Avoid 'subrequest' keyword to ensure write.
      if (sawTransientFailure) {
        lastTransientError = lastTransientError ?? lastError ?? new Error('Per-invocation request budget was nearly exhausted before trying all configured fallback models');
      }
      break;
    }

    // Prospective ~120s limit check to avoid doomed calls and CPU faults. Defers gracefully to fresh invocations.
    if (modelIndex > 0 && Date.now() - chainStartedAt - gateWaitMs + timeoutMs > MODEL_FALLBACK_CHAIN_BUDGET_MS) {
      logger.warn(`Deferring ${label}: no room in the per-invocation time budget for another model`, {
        elapsedMs: Date.now() - chainStartedAt,
        gateWaitMs,
        timeoutMs,
        skippedModels: modelsToTry.slice(modelIndex),
      });
      // Defer to retry on a fresh budget.
      sawTransientFailure = true;
      lastTransientError = lastTransientError ?? lastError ?? new Error(`Model fallback chain for ${label} exceeded its time budget; deferring for retry.`);
      break;
    }

    let resolved: ResolvedModelConfig;
    try {
      resolved = await ctx.resolveModel(currentModel);
    } catch (error) {
      lastError = error;
      logger.warn(`Model ${currentModel} could not be resolved`, {
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (resolved.apiFormat === 'cloudflare-workers-ai' && await ctx.isProviderUnavailable(resolved.providerId)) {
      logger.warn(`Skipping ${resolved.providerName} model ${currentModel} because the provider is unavailable for job ${ctx.jobId ?? 'unknown'}`);
      continue;
    }

    // Skip models timing out consistently. Last candidates use a higher threshold to avoid "no model attempted" errors, but still cut off eventually.
    const isLastCandidate = modelIndex === modelsToTry.length - 1;
    const timingOut = isLastCandidate
      ? await ctx.chainProgress.isTimingOutTerminally(currentModel)
      : await ctx.chainProgress.isTimingOut(currentModel);
    if (timingOut) {
      skippedForTimeouts = true;
      logger.info(`Skipping ${currentModel} for ${label}: it has repeatedly timed out on this job`, {
        isLastCandidate,
      });
      continue;
    }

    // Hard subrequest floor for ALL models (including primary) prevents prompt transmissions into depleted invocations.
    if (ctx.tracker && !ctx.tracker.hasRemainingSubrequests(SUBREQUEST_HEADROOM_FOR_MODEL_CALL)) {
      logger.warn(`Deferring ${label}: not enough subrequest budget left to commit a prompt`, {
        subrequests: ctx.tracker.getSubrequestCount(),
        needed: SUBREQUEST_HEADROOM_FOR_MODEL_CALL,
        skippedModels: modelsToTry.slice(modelIndex),
      });
      sawTransientFailure = true;
      // Avoid 'subrequest' keyword so error isn't mistaken for runtime refusal.
      lastTransientError = lastTransientError ?? lastError
        ?? new Error(`Per-invocation request budget was too low to attempt a model for ${label}; deferring for retry.`);
      break;
    }

    // Pre-flight check against known limits.
    const skipReason = await ctx.rateLimits.skipReason(resolved.modelName, estimatedPromptTokens);
    if (skipReason) {
      logger.info(`Skipping ${currentModel} for ${label}: ${skipReason}`);
      ctx.tracker?.recordSkippedCall(resolved.modelName, skipReason);
      continue;
    }

    // No intra-model retries here; outages defer the file or fall to next model.
    try {
      attemptedAnyModel = true;
      const response = await ctx.callResolvedModel(
        resolved,
        { systemPrompt, userPrompt, responseSchema, outputBudgetTokens },
        timeoutMs,
        recordGateWait,
      );

      if (ctx.tracker) {
        ctx.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
      }

      // Parse in try-block. `isLastModel` uses absolute chain length, protecting resumed jobs from premature acceptance.
      const parsed = params.parse(response.rawText, {
        isLastModel: startIndex + modelIndex >= wholeChain.length - 1,
      });
      // Clear strikes. No-op on healthy paths to avoid KV writes.
      await ctx.chainProgress.noteSuccess(currentModel);
      // Terminal success; clear memo for clean future retries.
      await Promise.all(progressLabels.map((key) => ctx.chainProgress.clear(key)));
      // Flush 429 cool-offs from earlier models in this chain to prevent re-paying them on next invocation.
      await ctx.chainProgress.flushPending();
      return { ...response, userPrompt, parsed };
    } catch (error) {
      lastError = error;
      // Record failed wire transmission.
      ctx.tracker?.recordFailedAttempt(
        resolved.modelName,
        estimatedPromptTokens,
        isGoogleRateLimitError(error) ? 'rate-limited' : 'error',
      );
      if (isTransientModelFailure(error)) {
        sawTransientFailure = true;
        lastTransientError = error;
      }
      if (resolved.apiFormat === 'cloudflare-workers-ai' && isCloudflareAllocationError(error)) {
        await ctx.markProviderUnavailable(resolved.providerId, error instanceof Error ? error.message : String(error));
      }

      // Runtime refusal (out of subrequests). Aborts immediately to prevent cascading instant failures. Not recorded as chain progress so healthy models aren't skipped on retry.
      if (isSubrequestBudgetMessage(error)) {
        logger.warn(`Aborting the model chain for ${label}; this invocation is out of subrequests`, {
          skippedModels: modelsToTry.slice(modelIndex + 1),
        });
        sawTransientFailure = true;
        lastTransientError = error;
        break;
      }

      // Persist timeouts so subsequent waves avoid doomed models.
      if (isTimeoutMessage(String(error instanceof Error ? error.message : error).toLowerCase())) {
        await ctx.chainProgress.noteTimeout(currentModel);
      }

      const rateLimited = isGoogleRateLimitError(error);
      if (!rateLimited) attemptedFailedThrough = startIndex + modelIndex + 1;
      if (rateLimited) {
        quotaFailures += 1;
        // Extract rate limit data to protect subsequent calls.
        ctx.rateLimits.note(resolved, error);
      }

      // 429 defers rather than trying fallbacks to preserve subrequests.
      const outOfQuotaBudget = quotaFailures >= MAX_QUOTA_FAILURES_PER_FILE;

      logger.warn(`Model ${currentModel} failed for ${label}`, {
        error: error instanceof Error ? error.message : String(error),
        rateLimited,
        quotaFailures,
        // `estimatedWastedInput` over `Tokens` since logger redacts 'token'.
        estimatedWastedInput: estimatedPromptTokens,
        willTryFallback: !outOfQuotaBudget && modelIndex < modelsToTry.length - 1,
      });

      if (outOfQuotaBudget) {
        sawTransientFailure = true;
        lastTransientError = error;
        break;
      }
    }
  }

  if (sawTransientFailure) {
    const retryCause = lastTransientError ?? lastError;
    const lastMessage = retryCause instanceof Error ? retryCause.message : String(retryCause ?? 'Unknown model error');
    const error = new RetryableModelError(
      `All configured review models failed for ${label}; retrying later. Last error: ${lastMessage}`,
      retryCause,
    );

    // Advance progress past failed models for the retry. Skipped at chain's end so file retries start clean.
    if (attemptedFailedThrough > 0 && attemptedFailedThrough < wholeChain.length) {
      // Coalesced writes to minimize KV get+puts from subrequest budget.
      await Promise.all(progressLabels.map((key) => ctx.chainProgress.advance(key, attemptedFailedThrough)));
      Object.defineProperty(error, 'nextChainIndex', { value: attemptedFailedThrough, configurable: true });
    } else {
      // Flush cool-offs learned before the quota deferral.
      await ctx.chainProgress.flushPending();
    }
    throw error;
  }

  // No model was called. Two very different reasons land here.
  if (!attemptedAnyModel) {
    // Throw permanent operator errors (transient wrappers obscure root cause).
    if (lastError !== undefined) {
      if (isTransientModelFailure(lastError)) {
        throw new RetryableModelError(`Every model for ${label} failed to resolve; retrying later.`, lastError);
      }
      throw lastError;
    }

    // All models skipped via cool-downs, timeouts, or unavailability.
    throw new RetryableModelError(
      `No configured review model was attempted for ${label} (all skipped: ${
        skippedForTimeouts ? 'repeated timeouts on this job' : 'rate-limit cooldown or provider unavailable'
      }); retrying later.`,
    );
  }

  throw lastError;
}
