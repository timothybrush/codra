import { normalizeModelId } from '@codra/schema';
import { isTimeoutMessage, matchesAnyTransientSubstring } from '@codra/schema/transient-errors';
import { UnparseableModelResponseError } from '../models/types';

// Model service pure helpers: aliases, prompt sizes, rate limits, errors.

// Legacy ID rewrites (applied before resolution). Hook for future aliases.
const MODEL_ALIASES: Record<string, string> = {};

export function mergeCounts(sources: Array<Record<string, number> | undefined>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const source of sources) {
    for (const [key, count] of Object.entries(source ?? {})) {
      merged[key] = (merged[key] ?? 0) + count;
    }
  }
  return merged;
}

// Rough 4-chars/token estimate to preempt doomed calls. Overestimating safely routes onward.
export function estimatePromptTokens(systemPrompt: string, userPrompt: string): number {
  return Math.ceil((systemPrompt.length + userPrompt.length) / 4);
}

// Headroom required before committing prompts to metered models.
export const PROMPT_FIT_SAFETY_FACTOR = 0.8;

// Minimum plausible token bucket. Rejects misparsed small numbers (like request quotas) to prevent jobs from permanently blocking valid prompts.
export const MIN_PLAUSIBLE_TOKEN_BUCKET = 1_000;

export function isPlausibleTokenBucket(limitTokens: number | undefined): boolean {
  return typeof limitTokens === 'number' && limitTokens >= MIN_PLAUSIBLE_TOKEN_BUCKET;
}

// Extracted nextChainIndex from deferrals. Lets callers distinguish "progress made" from "same failures". Lives here to avoid vi.mock TypeError in specs.
export function nextChainIndexOf(error: unknown): number | null {
  const value = (error as { nextChainIndex?: unknown } | null)?.nextChainIndex;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

// Detects if Gemini adapter dropped grammar before throwing. Lets callers latch the schema-dropped state.
export function isSchemaDroppedError(error: unknown): boolean {
  return (error as { schemaDropped?: unknown } | null)?.schemaDropped === true;
}

// Max serialized queue depth before routing elsewhere, avoiding budget exhaustion while waiting.
export const MAX_METERED_QUEUE_DEPTH = 2;

// Extracts metric/limit pairs from 429 bodies (may contain multiple).
const QUOTA_VIOLATION_PATTERN = /metric:\s*(\S+?),\s*limit:\s*(\d[\d_,]*)/gi;

// Token metrics only. Prevents parsing request quotas (e.g. limit: 15) as token buckets, which would permanently disable the model.
const TOKEN_QUOTA_METRIC = /(?:input_token|output_token|token_count|_tokens)/i;

// Extracts limit/retry from 429 bodies ("limit: 16000... retry in 26.9s").
export function parseRateLimitFromError(error: unknown): { limitTokens?: number; retryAfterMs?: number } {
  const message = error instanceof Error ? error.message : String(error ?? '');

  // Avoid bare limits; first stated limit might be request count.
  let limitTokens: number | undefined;
  for (const [, metric, limit] of message.matchAll(QUOTA_VIOLATION_PATTERN)) {
    if (!TOKEN_QUOTA_METRIC.test(metric)) continue;
    const parsed = Number(limit.replace(/[_,]/g, ''));
    if (!Number.isFinite(parsed) || !isPlausibleTokenBucket(parsed)) continue;
    // Smallest valid token bucket wins.
    if (limitTokens === undefined || parsed < limitTokens) limitTokens = parsed;
  }

  const retryMatch = /retry in ([\d.]+)\s*s/i.exec(message);
  const retryAfterMs = retryMatch ? Number(retryMatch[1]) * 1000 : undefined;

  return {
    limitTokens,
    retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs! > 0 ? retryAfterMs : undefined,
  };
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

export function normalizeModel(model: string) {
  return normalizeModelId(MODEL_ALIASES[model] ?? model);
}

export function uniqueModels(models: string[]) {
  return Array.from(new Set(models.map(normalizeModel)));
}

export function isCloudflareAllocationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('4006') || message.toLowerCase().includes('daily free allocation');
}

export function isGoogleRateLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return false;
  }
  
  return lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota exceeded');
}

export function isTransientModelFailure(error: unknown) {
  if (isRetryableModelError(error)) return true;
  // Deterministic unparseable output (reasoning-only/truncated) is non-retryable.
  if (error instanceof UnparseableModelResponseError) return false;
  if (isCloudflareAllocationError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (isTimeoutMessage(lower)) {
    return false;
  }

  return (
    isGoogleRateLimitError(error) ||
    matchesAnyTransientSubstring(lower) ||
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('temporar') ||
    // Upstream 5xx is transient; defer rather than failing.
    /\b50[0-9]\b/.test(lower) ||
    lower.includes('internal error')
  );
}
