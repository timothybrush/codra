import { buildSummaryPrompt, SUMMARY_SYSTEM_PROMPT } from '../prompts/summary';
import { buildVerifyPrompt, VERIFY_RESPONSE_SCHEMA, VERIFY_SYSTEM_PROMPT, type VerifyCandidate } from '../prompts/verify';
import { adaptiveModelTimeoutMs, MODEL_FALLBACK_CHAIN_BUDGET_MS } from '../models/limits';
import { isCloudflareAllocationError, isTransientModelFailure, RetryableModelError } from './model-support';
import { logger } from '../core/logger';
import type { RepoConfig } from '@shared/schema';
import type { TokenTracker } from '../core/token-tracker';
import type { ModelInput, ModelResponse } from '../models/types';
import type { ResolvedModelConfig } from '@server/db/model-configs';

// Sibling of services/model.ts -- import from that barrel, not from here. Four specs vi.mock that
// specifier.
//
// The two single-call model flows: PR summary and finding verification. Both walk the configured
// model chain, so they share one shape and one context.

// What these flows need from ModelService. An implementation detail, NOT new public API: the class
// builds one of these and keeps selectModel / resolveModel / callResolvedModel private, because
// three specs reach those via `(service as any)` and moving them off the class would leave
// `undefined` there -- which reads as a passing skip rather than a failure.
export type ModelChainContext = {
  selectModel(params: { totalLineCount: number; config: RepoConfig }): { primary: string; fallbacks: string[] };
  resolveModel(model: string): Promise<ResolvedModelConfig>;
  isProviderUnavailable(providerId: string): Promise<boolean>;
  markProviderUnavailable(providerId: string, reason: string): Promise<void>;
  callResolvedModel(
    resolved: ResolvedModelConfig,
    input: ModelInput,
    timeoutMs?: number,
    onGateWait?: (waitedMs: number) => void,
  ): Promise<ModelResponse>;
  tracker?: TokenTracker;
  jobId?: string;
};

export async function generateSummary(ctx: ModelChainContext, params: {
  prTitle: string | null;
  verdict: 'approve' | 'comment';
  fileSummaries: Array<{ path: string; summary: string; verdict: string }>;
  config: RepoConfig;
}) {
  const { primary, fallbacks } = ctx.selectModel({ totalLineCount: 0, config: params.config });
  const modelsToTry = [primary, ...fallbacks];

  let lastError: unknown;
  let lastTransientError: unknown;
  let sawTransientFailure = false;
  for (const currentModel of modelsToTry) {
    let resolved: ResolvedModelConfig;
    try {
      resolved = await ctx.resolveModel(currentModel);
    } catch (error) {
      lastError = error;
      logger.warn(`Summary model ${currentModel} could not be resolved`, {
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (resolved.apiFormat === 'cloudflare-workers-ai' && await ctx.isProviderUnavailable(resolved.providerId)) {
      logger.warn(`Skipping ${resolved.providerName} summary model ${currentModel} because the provider is unavailable for job ${ctx.jobId ?? 'unknown'}`);
      continue;
    }

    try {
      const response = await ctx.callResolvedModel(resolved, {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        userPrompt: buildSummaryPrompt(params),
      }, adaptiveModelTimeoutMs(0));

      if (ctx.tracker) {
        ctx.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
      }

      return response;
    } catch (error) {
      lastError = error;
      if (isTransientModelFailure(error)) {
        sawTransientFailure = true;
        lastTransientError = error;
      }
      if (resolved.apiFormat === 'cloudflare-workers-ai' && isCloudflareAllocationError(error)) {
        await ctx.markProviderUnavailable(resolved.providerId, error instanceof Error ? error.message : String(error));
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

// One model call re-checks candidates against their diff context. Best-effort: any throw is
// "verification unavailable", keeping the pre-verification findings.
export async function verifyFindings(ctx: ModelChainContext, params: { candidates: VerifyCandidate[]; config: RepoConfig }): Promise<ModelResponse> {
  const { primary, fallbacks } = ctx.selectModel({ totalLineCount: 0, config: params.config });
  const modelsToTry = [primary, ...fallbacks];
  const input: ModelInput = {
    systemPrompt: VERIFY_SYSTEM_PROMPT,
    userPrompt: buildVerifyPrompt(params.candidates),
    // The verify grammar, NOT the file-review one -- sending the review schema here (as this
    // used to, unconditionally) makes strict decoding unsatisfiable and the pass a silent no-op.
    responseSchema: VERIFY_RESPONSE_SCHEMA as unknown as ModelInput['responseSchema'],
  };
  // Scale the timeout with the number of findings under review (capped inside adaptiveModelTimeoutMs).
  const timeoutMs = adaptiveModelTimeoutMs(params.candidates.length * 8);

  let lastError: unknown;
  const chainStartedAt = Date.now();
  let gateWaitMs = 0;
  const recordGateWait = (waitedMs: number) => { gateWaitMs += waitedMs; };

  for (const [modelIndex, currentModel] of modelsToTry.entries()) {
    // The same two breakers reviewFileChunk has, and they matter MORE here: finalize cannot
    // hibernate, so it has one invocation's budget for the verify call, createReview, disposition
    // writes and labels. A nine-model chain through an outage costs ~36 of 50 subrequests, or
    // ~180s against a ~120s ceiling, swallowed by fail-open -- the review never posts and the job
    // fails terminally with every file already reviewed. Giving up early is the right trade.
    if (modelIndex > 0 && ctx.tracker?.isNearLimit()) {
      logger.warn('Stopping the verification chain; subrequest budget for this invocation is nearly exhausted', {
        skippedModels: modelsToTry.slice(modelIndex),
      });
      break;
    }
    if (modelIndex > 0 && Date.now() - chainStartedAt - gateWaitMs > MODEL_FALLBACK_CHAIN_BUDGET_MS) {
      logger.warn('Stopping the verification chain; it exceeded its per-invocation time budget', {
        elapsedMs: Date.now() - chainStartedAt,
        gateWaitMs,
        skippedModels: modelsToTry.slice(modelIndex),
      });
      break;
    }

    let resolved: ResolvedModelConfig;
    try {
      resolved = await ctx.resolveModel(currentModel);
    } catch (error) {
      lastError = error;
      continue;
    }

    if (resolved.apiFormat === 'cloudflare-workers-ai' && await ctx.isProviderUnavailable(resolved.providerId)) {
      continue;
    }

    try {
      const response = await ctx.callResolvedModel(resolved, input, timeoutMs, recordGateWait);
      if (ctx.tracker) {
        ctx.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (resolved.apiFormat === 'cloudflare-workers-ai' && isCloudflareAllocationError(error)) {
        await ctx.markProviderUnavailable(resolved.providerId, error instanceof Error ? error.message : String(error));
      }
      logger.warn(`Verification model ${currentModel} failed`, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  throw lastError ?? new Error('No model available for verification pass.');
}
