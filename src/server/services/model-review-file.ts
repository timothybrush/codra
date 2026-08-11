import {
  buildBatchReviewPrompts,
  buildBatchReviewResponseSchema,
  buildFileReviewPrompts,
  buildReviewResponseSchema,
  type RejectedExemplar,
} from '../prompts/file-review';
import { isNonAnswerReview, parseBatchReviewResponse, parseFileReviewResponse, type BatchReviewResult } from '../core/model-output';
import { UnparseableModelResponseError } from '../models/types';
import { chunkFileDiff, type FileDiff } from '../core/diff';
import { adaptiveModelTimeoutMs, reviewOutputBudgetTokens } from '../models/limits';
import { generatorFindingCap } from '../prompts/file-review';
import { mergeCounts } from './model-support';
import { type ModelReviewContext, runModelChain } from './model-review-chain';
import { logger } from '../core/logger';
import type { RepoConfig } from '@shared/schema';
import type { ModelResponse } from '../models/types';

// Import from the services/model barrel, not here (four specs vi.mock it).

export const COMPACT_REVIEW_PROMPT_LINE_CAP = 400;
// Budget required before a chunk past BASE_CHUNKS runs, so a tail chunk only spends while another whole file still fits.
const EXTRA_CHUNK_BUDGET_RESERVE = 8;
export type { ModelReviewContext };

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
  // Pre-cap count, so wasPromptTruncated doesn't re-run chunkFileDiff.
  const totalChunkCount = chunks.length;

  // Past BASE_CHUNKS is opportunistic, only on spare budget.
  const BASE_CHUNKS = 4;
  const MAX_CHUNKS = 8;
  if (chunks.length > MAX_CHUNKS) {
    chunks = chunks.slice(0, MAX_CHUNKS);
  }

  if (chunks.length === 1) {
    return reviewFileChunk(ctx, { ...params, file: chunks[0] });
  }

  const results: Array<ModelResponse & { parsed: ReturnType<typeof parseFileReviewResponse>, reviewedLineCount: number, wasPromptTruncated: boolean, userPrompt: string }> = [];
  const { path: filePath } = params.file;

  for (const [chunkIndex, chunk] of chunks.entries()) {
    // No new chunk when close to the 50-subrequest limit.
    if (results.length > 0 && ctx.tracker?.isNearLimit()) {
      logger.warn(`Stopping chunk processing for ${filePath} early due to subrequest budget limits.`);
      break;
    }

    // Needs spare budget, not merely remaining: isNearLimit() only fires once in-flight files are already starved.
    if (chunkIndex >= BASE_CHUNKS) {
      const remaining = ctx.tracker?.remainingSafeBudget() ?? Number.POSITIVE_INFINITY;
      if (remaining < EXTRA_CHUNK_BUDGET_RESERVE) {
        logger.info(`Skipping the opportunistic chunk tail for ${filePath}; budget is committed elsewhere.`, {
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
      logger.warn(`Chunk review failed for ${filePath}, returning partial results to avoid stalling the job.`, { error: error instanceof Error ? error.message : String(error) });
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
      // Summed across chunks, or a truncated file under-reports the "N claims withheld" note.
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

  const response = await runModelChain(ctx, {
    systemPrompt,
    userPrompt,
    responseSchema: buildReviewResponseSchema(params.config.review.max_comments),
    // Scales with the diff the model sees: small files fail over fast.
    timeoutMs: adaptiveModelTimeoutMs(params.file.lineCount),
    // Room for the number of findings the prompt just asked for. Sized from the ask, not the diff.
    outputBudgetTokens: reviewOutputBudgetTokens({
      findingCap: generatorFindingCap(params.config.review.max_comments),
      fileCount: 1,
    }),
    label: params.file.path,
    totalLineCount: params.totalLineCount,
    config: params.config,
    parse: (rawText, { isLastModel }) => {
      const parsed = parseFileReviewResponse(rawText, params.file, {
        deniedClaimTypes: params.config.review.deny_claim_types,
      });

      // A substantive diff waved through in one sentence is not a clean verdict, it is a model declining
      // to review. Thrown as UnparseableModelResponseError so the chain treats it exactly like any other
      // useless response and tries the next entry -- and never on the last one, where the alternative to
      // an unearned "clean" is failing the file, which is worse.
      if (!isLastModel && isNonAnswerReview({
        rawText,
        file: params.file,
        findingCount: parsed.comments.length,
      })) {
        logger.warn('Model returned a non-answer for a substantive diff; escalating to the next model', {
          path: params.file.path,
          diffLineCount: params.file.lineCount,
          responseChars: rawText.trim().length,
        });
        throw new UnparseableModelResponseError(
          params.config.model?.main ?? 'unconfigured',
          `no findings and only ${rawText.trim().length} characters of response for a ${params.file.lineCount}-line diff`,
        );
      }

      return parsed;
    },
  });

  return {
    ...response,
    reviewedLineCount: params.file.lineCount,
    wasPromptTruncated: params.file.isTruncated === true,
  };
}

export type BatchReviewOutcome = ModelResponse & {
  batch: BatchReviewResult;
  userPrompt: string;
};

// Caller fans the result out to per-file rows and must not record `batch.missing` as reviewed.
export async function reviewFiles(ctx: ModelReviewContext, params: {
  files: readonly FileDiff[];
  prTitle: string | null;
  prDescription: string | null;
  config: RepoConfig;
  totalLineCount: number;
  rejectedExemplars?: readonly RejectedExemplar[];
}): Promise<BatchReviewOutcome> {
  const { systemPrompt, userPrompt } = buildBatchReviewPrompts({
    files: params.files,
    prTitle: params.prTitle,
    prDescription: params.prDescription,
    config: params.config.review,
    rejectedExemplars: params.rejectedExemplars,
  });

  // The bin's total: a 400-line bin on a small-file timeout dies mid-call and takes all of it down.
  const binLineCount = params.files.reduce((sum, file) => sum + file.lineCount, 0);

  const response = await runModelChain(ctx, {
    systemPrompt,
    userPrompt,
    responseSchema: buildBatchReviewResponseSchema(params.config.review.max_comments, params.files.length),
    timeoutMs: adaptiveModelTimeoutMs(binLineCount),
    // The bin's whole response, not one file's: every entry shares one `maxOutputTokens`, and a bin that
    // overruns it comes back as a repaired prefix with its tail files looking clean.
    outputBudgetTokens: reviewOutputBudgetTokens({
      findingCap: generatorFindingCap(params.config.review.max_comments),
      fileCount: params.files.length,
    }),
    label: `${params.files.length} files (${params.files[0]?.path ?? 'unknown'} …)`,
    // Per file, so progress survives the bin narrowing or exploding into singles.
    progressLabels: params.files.map((file) => file.path),
    totalLineCount: params.totalLineCount,
    config: params.config,
    parse: (rawText) => parseBatchReviewResponse(rawText, params.files, {
      deniedClaimTypes: params.config.review.deny_claim_types,
      maxCommentsPerFile: params.config.review.max_comments,
    }),
  });

  return { ...response, batch: response.parsed };
}

