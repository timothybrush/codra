import { logger } from '../core/logger';
import { isSubrequestBudgetMessage, isTimeoutMessage } from '@shared/transient-errors';
import type { RepoConfig } from '@shared/schema';
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
import type { ResolvedModelConfig } from '@server/db/model-configs';
import type { ModelChainContext } from './model-chain-runner';
import type { ModelRateLimitBook } from './model-rate-limits';
import type { ModelChainProgressStore } from './model-chain-progress';

// The model fallback chain, shared by the single-file and batched review paths.
// Import from the services/model barrel, not here.

// Each model has its own bucket, but past two an attempt spends a subrequest for nothing.
const MAX_QUOTA_FAILURES_PER_FILE = 2;

// Per-invocation state on top of the model-chain surface. Not public API.
export type ModelReviewContext = ModelChainContext & {
  env: AppBindings;
  rateLimits: ModelRateLimitBook;
  // Models proven not to support async batching, so later files go straight to synchronous.
  asyncUnsupportedModels: Set<string>;
  // Per-job memo of how far down the chain each label already got. See model-chain-progress.ts.
  chainProgress: ModelChainProgressStore;
};

// Walks the chain for one prompt pair, returning the first success. `parse` runs inside the
// per-model try: an unparseable response is that model's failure.
export async function runModelChain<T>(ctx: ModelReviewContext, params: {
  systemPrompt: string;
  userPrompt: string;
  // Not the single-file builder's return type: callers pass the batched grammar here too.
  responseSchema: ModelResponseSchema;
  timeoutMs: number;
  label: string;
  totalLineCount: number;
  config: RepoConfig;
  // Output-token headroom this prompt needs to answer in full; see reviewOutputBudgetTokens. Adapters
  // clamp it, so omitting it leaves a caller on its provider's default.
  outputBudgetTokens?: number;
  // `isLastModel` lets a parser reject a technically-valid non-answer while a stronger entry is still
  // untried, and accept it once nothing better remains -- so escalation can never fail a file outright.
  parse: (rawText: string, ctx: { isLastModel: boolean }) => T;
  // Stable keys for the resume memo. A bin passes its member paths: its own `label` embeds the file
  // count, so it changes the moment a member completes or the bin de-escalates to singles, and the
  // progress would be lost exactly when it matters most.
  progressLabels?: readonly string[];
}) {
  const { systemPrompt, userPrompt, responseSchema, label, outputBudgetTokens } = params;
  const progressLabels = params.progressLabels?.length ? params.progressLabels : [label];

  const { primary, fallbacks } = ctx.selectModel({
    totalLineCount: params.totalLineCount,
    config: params.config,
  });
  const wholeChain = [primary, ...fallbacks];

  // Resume where a previous invocation left off. Clamped rather than allowed to empty the list: a
  // config edit mid-job can shorten the chain, and an empty list would fail the file with
  // "no model was attempted" instead of just re-running the last one.
  // The MINIMUM across members: a file that has not yet been tried against model k must not have k
  // skipped just because a bin-mate already ruled it out.
  const recorded = await Promise.all(progressLabels.map((key) => ctx.chainProgress.startIndexFor(key)));
  const startIndex = Math.min(Math.min(...recorded), Math.max(wholeChain.length - 1, 0));
  const modelsToTry = wholeChain.slice(startIndex);
  if (startIndex > 0) {
    logger.info(`Resuming the model chain for ${label} at ${modelsToTry[0]}`, {
      startIndex,
      skipped: wholeChain.slice(0, startIndex),
    });
  }

  // Guards the head of the chain only; see clampTimeoutToChainBudget.
  const timeoutMs = clampTimeoutToChainBudget(params.timeoutMs);

  const estimatedPromptTokens = estimatePromptTokens(systemPrompt, userPrompt);

  let lastError: unknown;
  let lastTransientError: unknown;
  let sawTransientFailure = false;
  let quotaFailures = 0;
  // The `continue` paths can otherwise leave `lastError` undefined, failing the file permanently.
  let attemptedAnyModel = false;
  // Separates "every model is on a rate-limit cooldown" from "every model is timing out" in the
  // no-model-attempted message; the two need opposite responses from whoever reads the job log.
  let skippedForTimeouts = false;
  // Absolute index just past the last model that ran and failed on its own merits. Only these
  // advance the memo: a model skipped by a budget breaker never ran, and a 429 means "same model,
  // later" (ModelRateLimitBook already holds that cool-off), so neither has been ruled out.
  let attemptedFailedThrough = 0;
  const chainStartedAt = Date.now();
  // Excluded from the call timeout: charging gate-wait made a busy gate look like a slow model.
  let gateWaitMs = 0;
  const recordGateWait = (waitedMs: number) => { gateWaitMs += waitedMs; };
  for (const [modelIndex, currentModel] of modelsToTry.entries()) {
    // The primary always gets a shot; past that each fallback risks the 50-subrequest cap, so defer.
    if (modelIndex > 0 && ctx.tracker?.isNearLimit()) {
      logger.warn(`Skipping remaining fallback models for ${label}; subrequest budget for this invocation is nearly exhausted`, {
        skippedModels: modelsToTry.slice(modelIndex),
      });

      // All-permanent failures: let the last one propagate.
      if (sawTransientFailure) {
        // Must not say "subrequest": isSubrequestBudgetError substring-matches, and skips the write.
        lastTransientError = lastTransientError ?? lastError ?? new Error('Per-invocation request budget was nearly exhausted before trying all configured fallback models');
      }
      break;
    }

    // Back-to-back slow calls pass Cloudflare's ~120s limit and die as `exceededCpu`.
    // Prospective, not reactive: asking whether the budget is ALREADY blown let a call start with less
    // time left than it needs, burn what remained, and defer anyway -- paying for a doomed attempt and
    // reporting it as that model's failure. Asking whether THIS call still fits spends nothing instead,
    // and the resume memo means the model it declines to start is the one the next invocation begins at.
    if (modelIndex > 0 && Date.now() - chainStartedAt - gateWaitMs + timeoutMs > MODEL_FALLBACK_CHAIN_BUDGET_MS) {
      logger.warn(`Deferring ${label}: no room in the per-invocation time budget for another model`, {
        elapsedMs: Date.now() - chainStartedAt,
        gateWaitMs,
        timeoutMs,
        skippedModels: modelsToTry.slice(modelIndex),
      });
      // Deferrable, so the file retries on a fresh budget instead of failing permanently.
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

    // Proven too slow for this job's budget. The last candidate is held to a higher bar rather than
    // exempted: skipping every model reports "no model was attempted", which is worse than one more
    // slow try -- but it is far better than paying a full per-call budget per unit, forever, for a
    // model that has never once answered on this job.
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

    // Hard floor, and unlike the isNearLimit() breaker above it applies to the PRIMARY too: that
    // breaker exists to leave room for other in-flight files and so exempts index 0, which left the
    // head of every chain free to transmit a full prompt into an invocation that had nothing left.
    // The runtime then refuses it and the whole unit is lost having paid for the prompt.
    if (ctx.tracker && !ctx.tracker.hasRemainingSubrequests(SUBREQUEST_HEADROOM_FOR_MODEL_CALL)) {
      logger.warn(`Deferring ${label}: not enough subrequest budget left to commit a prompt`, {
        subrequests: ctx.tracker.getSubrequestCount(),
        needed: SUBREQUEST_HEADROOM_FOR_MODEL_CALL,
        skippedModels: modelsToTry.slice(modelIndex),
      });
      sawTransientFailure = true;
      // Must not say "subrequest": isSubrequestBudgetError substring-matches it and would treat this
      // as the runtime's own refusal, which skips persisting chain progress.
      lastTransientError = lastTransientError ?? lastError
        ?? new Error(`Per-invocation request budget was too low to attempt a model for ${label}; deferring for retry.`);
      break;
    }

    // Skip a call known to fail rather than pay a subrequest to be told.
    const skipReason = await ctx.rateLimits.skipReason(resolved.modelName, estimatedPromptTokens);
    if (skipReason) {
      logger.info(`Skipping ${currentModel} for ${label}: ${skipReason}`);
      ctx.tracker?.recordSkippedCall(resolved.modelName, skipReason);
      continue;
    }

    // One shot per model; a retryable outage defers the whole file, so failure falls to the next.
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

      // Inside the try on purpose -- see the header. `isLastModel` is computed against the WHOLE chain,
      // not `modelsToTry`: a resumed job starts mid-chain, and measuring from the slice would call the
      // resume point "last" and skip the escalation the memo was holding a place for.
      const parsed = params.parse(response.rawText, {
        isLastModel: startIndex + modelIndex >= wholeChain.length - 1,
      });
      // Keyed on the chain entry, matching noteTimeout. No-ops unless this model has strikes, so the
      // healthy path stays free of the KV write.
      await ctx.chainProgress.noteSuccess(currentModel);
      // Terminal for these labels; drop the memo so a job retry starts from the primary again.
      await Promise.all(progressLabels.map((key) => ctx.chainProgress.clear(key)));
      // The common shape is "primary 429s, fallback answers": the file succeeds, so nothing below
      // runs, yet a cool-off was just paid for in full and the next invocation would re-pay it.
      // No-ops unless a 429 actually landed, so the healthy path stays free.
      await ctx.chainProgress.flushPending();
      return { ...response, userPrompt, parsed };
    } catch (error) {
      lastError = error;
      // The prompt was transmitted in full and bought nothing; the only site that sees every failed
      // attempt across both the single-file and batched paths.
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

      // The runtime refused the call: the invocation is out of subrequests, so every remaining
      // model fails identically and instantly. Observed in production walking all 8 remaining
      // entries for 2 files -- 16 doomed attempts -- then failing the chunk outright instead of
      // deferring. Deliberately NOT recorded as chain progress: these models never ran, and marking
      // them tried would make the resume memo skip healthy models for the rest of the job.
      if (isSubrequestBudgetMessage(error)) {
        logger.warn(`Aborting the model chain for ${label}; this invocation is out of subrequests`, {
          skippedModels: modelsToTry.slice(modelIndex + 1),
        });
        sawTransientFailure = true;
        lastTransientError = error;
        break;
      }

      // Counted per job: a wave of concurrent units all time out before any of them can react, so
      // only a persisted tally lets the next wave stop paying for it.
      if (isTimeoutMessage(String(error instanceof Error ? error.message : error).toLowerCase())) {
        await ctx.chainProgress.noteTimeout(currentModel);
      }

      const rateLimited = isGoogleRateLimitError(error);
      if (!rateLimited) attemptedFailedThrough = startIndex + modelIndex + 1;
      if (rateLimited) {
        quotaFailures += 1;
        // Learn bucket size and cool-off from the message, so later files skip it.
        ctx.rateLimits.note(resolved, error);
      }

      // A 429 means come back later, not try another model, which would blow the subrequest cap.
      const outOfQuotaBudget = quotaFailures >= MAX_QUOTA_FAILURES_PER_FILE;

      logger.warn(`Model ${currentModel} failed for ${label}`, {
        error: error instanceof Error ? error.message : String(error),
        rateLimited,
        quotaFailures,
        // Not `...Tokens`: logger.ts redacts any key containing "token".
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

    // Persist progress before throwing, so the retry resumes past the models that just failed.
    // Only when there is somewhere left to go: at the end of the chain the memo would pin every
    // future attempt to the last entry, and the file should get a clean walk instead.
    if (attemptedFailedThrough > 0 && attemptedFailedThrough < wholeChain.length) {
      // Together, not one at a time: the store is single-flight, so a bin's N labels coalesce into
      // one merged put (plus the drain loop's redundant second put) instead of paying a KV get+put
      // per member out of the 50-subrequest budget.
      await Promise.all(progressLabels.map((key) => ctx.chainProgress.advance(key, attemptedFailedThrough)));
      Object.defineProperty(error, 'nextChainIndex', { value: attemptedFailedThrough, configurable: true });
    } else {
      // A quota deferral advances no chain progress (a 429 means "same model, later"), so nothing
      // above would have flushed the cool-off this file just paid a full prompt to learn.
      await ctx.chainProgress.flushPending();
    }
    throw error;
  }

  // No model was called. Two very different reasons land here.
  if (!attemptedAnyModel) {
    // Permanent operator errors: a transient deferral would hide the message that says what to fix.
    if (lastError !== undefined) {
      if (isTransientModelFailure(lastError)) {
        throw new RetryableModelError(`Every model for ${label} failed to resolve; retrying later.`, lastError);
      }
      throw lastError;
    }

    // Genuinely skipped: a cooldown from another file's 429, repeated timeouts, or an unavailable provider.
    throw new RetryableModelError(
      `No configured review model was attempted for ${label} (all skipped: ${
        skippedForTimeouts ? 'repeated timeouts on this job' : 'rate-limit cooldown or provider unavailable'
      }); retrying later.`,
    );
  }

  throw lastError;
}
