import type { AppBindings } from '../env';
import { buildFileReviewPrompts, buildReviewResponseSchema, type RejectedExemplar } from '../prompts/file-review';
import { parseFileReviewResponse } from '../core/model-output';
import { chunkFileDiff } from '../core/diff';
import { adaptiveModelTimeoutMs, MODEL_FALLBACK_CHAIN_BUDGET_MS } from '../models/limits';
import {
  estimatePromptTokens,
  isCloudflareAllocationError,
  isGoogleRateLimitError,
  isTransientModelFailure,
  mergeCounts,
  RetryableModelError,
} from './model-support';
import { logger } from '../core/logger';
import type { RepoConfig } from '@shared/schema';
import type { ModelResponse } from '../models/types';
import type { ResolvedModelConfig } from '@server/db/model-configs';
import type { ModelChainContext } from './model-chain-runner';
import type { ModelRateLimitBook } from './model-rate-limits';

// Sibling of the services/model barrel; import from there, not here (four specs vi.mock it).
// Per-file review flow: chunking, the fallback chain, and the Cloudflare async-batch path.

// Per-invocation state on top of the model-chain surface. Implementation detail, not public API.
export const COMPACT_REVIEW_PROMPT_LINE_CAP = 400;
// Budget required before a chunk past BASE_CHUNKS runs, so a tail chunk only spends while another
// whole file still fits. Not chain-length derived: that shrinks the tail when budget is tightest.
const EXTRA_CHUNK_BUDGET_RESERVE = 8;
// Two: each model has its own bucket so the next often succeeds, but past two each attempt spends a
// subrequest for nothing.
const MAX_QUOTA_FAILURES_PER_FILE = 2;

export type ModelReviewContext = ModelChainContext & {
  env: AppBindings;
  rateLimits: ModelRateLimitBook;
  // Models proven this invocation not to support async batching: the first file probes, and the rest
  // skip straight to synchronous rather than pay for another failed submit.
  asyncUnsupportedModels: Set<string>;
};

export async function reviewFile(ctx: ModelReviewContext, params: {
  file: any;
  prTitle: string | null;
  prDescription: string | null;
  config: RepoConfig;
  totalLineCount: number;
  compactPrompt?: boolean;
  rejectedExemplars?: readonly RejectedExemplar[];
}) {
  const configuredLineCap = params.config.review.max_diff_lines_per_file;
  const modelLineCap = params.compactPrompt
    ? Math.min(configuredLineCap, COMPACT_REVIEW_PROMPT_LINE_CAP)
    : configuredLineCap;

  let chunks = chunkFileDiff(params.file, modelLineCap);
  // Remember the pre-cap chunk count so wasPromptTruncated doesn't have to re-run chunkFileDiff.
  const totalChunkCount = chunks.length;

  // Was a flat 4, hard-capping files at 3,200 lines and silently dropping the rest (~15% of one
  // 3,749-line file never reached a model). Past BASE_CHUNKS is opportunistic, only on spare budget.
  const BASE_CHUNKS = 4;
  const MAX_CHUNKS = 8;
  if (chunks.length > MAX_CHUNKS) {
    chunks = chunks.slice(0, MAX_CHUNKS);
  }

  if (chunks.length === 1) {
    return reviewFileChunk(ctx, { ...params, file: chunks[0] });
  }

  const results: Array<ModelResponse & { parsed: ReturnType<typeof parseFileReviewResponse>, reviewedLineCount: number, wasPromptTruncated: boolean, userPrompt: string }> = [];
  
  for (const [chunkIndex, chunk] of chunks.entries()) {
    // No new chunk when close to the 50-subrequest limit.
    if (results.length > 0 && ctx.tracker?.isNearLimit()) {
      logger.warn(`Stopping chunk processing for ${params.file.path} early due to subrequest budget limits.`);
      break;
    }

    // Opportunistic tail. isNearLimit() fires only at the safe margin, by which point in-flight files are
    // starved: that is how one large file took 16 others down. Needs spare budget, not merely remaining;
    // yielding here reports truncated, not failed.
    if (chunkIndex >= BASE_CHUNKS) {
      const remaining = ctx.tracker?.remainingSafeBudget() ?? Number.POSITIVE_INFINITY;
      if (remaining < EXTRA_CHUNK_BUDGET_RESERVE) {
        logger.info(`Skipping the opportunistic chunk tail for ${params.file.path}; budget is committed elsewhere.`, {
          chunkIndex,
          totalChunks: chunks.length,
          remainingSafeBudget: remaining,
        });
        break;
      }
    }


    try {
      const res = await reviewFileChunk(ctx, { ...params, file: chunk });
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
  // Most serious chunk's verdict, not the last: a clean final chunk would mask earlier findings.
  const primaryResult = results.find(r => r.parsed.verdict === 'comment') ?? results[results.length - 1];

  return {
    ...primaryResult,
    inputTokens: results.reduce((sum, r) => sum + r.inputTokens, 0),
    outputTokens: results.reduce((sum, r) => sum + r.outputTokens, 0),
    parsed: {
      ...primaryResult.parsed,
      comments: combinedFindings,
      // Summed across chunks, or a truncated file under-reports by nearly the chunk count; drives the
      // "N claims withheld" note.
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


// Internal to this module: reviewFile fans out to it per chunk.
async function reviewFileChunk(ctx: ModelReviewContext, params: {
  file: any;
  prTitle: string | null;
  prDescription: string | null;
  config: RepoConfig;
  totalLineCount: number;
  compactPrompt?: boolean;
  rejectedExemplars?: readonly RejectedExemplar[];
}) {
  const { systemPrompt, userPrompt } = buildFileReviewPrompts({
    ...params,
    file: params.file,
    config: params.config.review,
    rejectedExemplars: params.rejectedExemplars,
  });
  const responseSchema = buildReviewResponseSchema(params.config.review.max_comments);

  const { primary, fallbacks } = ctx.selectModel({
    totalLineCount: params.totalLineCount,
    config: params.config,
  });
  const modelsToTry = [primary, ...fallbacks];

  // Timeout scales with the diff the model sees: small files fail over fast, large diffs get longer.
  const timeoutMs = adaptiveModelTimeoutMs(params.file.lineCount);
  const estimatedPromptTokens = estimatePromptTokens(systemPrompt, userPrompt);

  let lastError: unknown;
  let lastTransientError: unknown;
  let sawTransientFailure = false;
  let quotaFailures = 0;
  const chainStartedAt = Date.now();
  // Gate-wait is excluded from the call timeout: charging it made a busy gate look like a slow model
  // and deferred files before any fallback ran.
  let gateWaitMs = 0;
  const recordGateWait = (waitedMs: number) => { gateWaitMs += waitedMs; };
  for (const [modelIndex, currentModel] of modelsToTry.entries()) {
    // The primary always gets a shot; past that each fallback risks the 50-subrequest cap, so defer.
    if (modelIndex > 0 && ctx.tracker?.isNearLimit()) {
      logger.warn(`Skipping remaining fallback models for ${params.file.path}; subrequest budget for this invocation is nearly exhausted`, {
        skippedModels: modelsToTry.slice(modelIndex),
      });

      // With no transient failures seen (all permanent), let the last permanent error propagate.
      if (sawTransientFailure) {
        lastTransientError = lastTransientError ?? lastError ?? new Error('Subrequest budget for this invocation was nearly exhausted before trying all configured fallback models');
      }
      break;
    }

    // Stop walking the chain once wall clock is spent: back-to-back slow calls pass Cloudflare's ~120s
    // limit and die as `exceededCpu`.
    if (modelIndex > 0 && Date.now() - chainStartedAt - gateWaitMs > MODEL_FALLBACK_CHAIN_BUDGET_MS) {
      logger.warn(`Deferring ${params.file.path}: fallback chain exceeded its per-invocation time budget`, {
        elapsedMs: Date.now() - chainStartedAt,
        gateWaitMs,
        skippedModels: modelsToTry.slice(modelIndex),
      });
      // Deferrable, so the file retries on a fresh budget instead of failing permanently.
      sawTransientFailure = true;
      lastTransientError = lastTransientError ?? lastError ?? new Error(`Model fallback chain for ${params.file.path} exceeded its time budget; deferring for retry.`);
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

    // Skip a call known to fail rather than pay a subrequest to be told: this is what stops the stronger
    // models' buckets being spent on 429s for files that could never fit.
    const skipReason = ctx.rateLimits.skipReason(resolved.modelName, estimatedPromptTokens);
    if (skipReason) {
      logger.info(`Skipping ${currentModel} for ${params.file.path}: ${skipReason}`);
      continue;
    }

    // One shot per model; a retryable outage defers the whole file, so failure falls to the next.
    try {
      const response = await ctx.callResolvedModel(
        resolved,
        { systemPrompt, userPrompt, responseSchema },
        timeoutMs,
        recordGateWait,
      );

      if (ctx.tracker) {
        ctx.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
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
        await ctx.markProviderUnavailable(resolved.providerId, error instanceof Error ? error.message : String(error));
      }

      const rateLimited = isGoogleRateLimitError(error);
      if (rateLimited) {
        quotaFailures += 1;
        // Learn bucket size and cool-off from the provider's message, so later files skip it instead of
        // rediscovering the limit at their own expense.
        ctx.rateLimits.note(resolved, error);
      }

      // A 429 means come back later, not try another model: nine models x three attempts is 27 subrequests
      // for ONE file against a 50-subrequest cap.
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

