import { normalizeModelId } from '@shared/schema';
import { isTimeoutMessage, matchesAnyTransientSubstring } from '@shared/transient-errors';
import { UnparseableModelResponseError } from '../models/types';

// Pure helpers for the model service: alias resolution, prompt-size estimation, rate-limit parsing
// and error classification. No state, no `this`, no I/O - everything ModelService needs that does
// not touch its per-invocation caches.

// Legacy id rewrites, applied before resolution. Empty today; kept as the hook for the next one.
const MODEL_ALIASES: Record<string, string> = {};

// Sums per-key counters across a file's chunks.
export function mergeCounts(sources: Array<Record<string, number> | undefined>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const source of sources) {
    for (const [key, count] of Object.entries(source ?? {})) {
      merged[key] = (merged[key] ?? 0) + count;
    }
  }
  return merged;
}

// Rough prompt size in tokens, for deciding whether a call can fit a token-per-minute bucket.
//
// Four characters per token is the usual English/code approximation. It only has to be good enough
// to answer "is this prompt hopeless against a 16k bucket?", and it is deliberately used with a
// safety factor (see PROMPT_FIT_SAFETY_FACTOR) because underestimating costs a wasted call and a
// 429, whereas overestimating merely routes a borderline file to the next model.
export function estimatePromptTokens(systemPrompt: string, userPrompt: string): number {
  return Math.ceil((systemPrompt.length + userPrompt.length) / 4);
}

// Only commit a prompt to a token-metered model if the estimate leaves this much headroom. The
// estimate is approximate in both directions and the bucket is shared with concurrent calls.
export const PROMPT_FIT_SAFETY_FACTOR = 0.8;

// Calls that may queue on a serialized model before further files route elsewhere. Two keeps it fed
// without anyone waiting more than about one call. Deeper queues lost 16 of 119 files once: the wait
// ate the per-file chain budget, so they were deferred without ever trying a second model.
export const MAX_METERED_QUEUE_DEPTH = 2;

// Reads a provider's own account of its rate limit out of the error it just returned.
//
// Google states both numbers in the 429 body:
//   "Quota exceeded for metric: ...input_token_count, limit: 16000, model: <model-id>
//    Please retry in 26.917952921s."
// Anything not present is simply absent from the result -- a provider that reports neither still
// gets a cool-off applied by the caller, just without a learned bucket size.
export function parseRateLimitFromError(error: unknown): { limitTokens?: number; retryAfterMs?: number } {
  const message = error instanceof Error ? error.message : String(error ?? '');

  const limitMatch = /limit:\s*(\d[\d_,]*)/i.exec(message);
  const retryMatch = /retry in ([\d.]+)\s*s/i.exec(message);

  const limitTokens = limitMatch ? Number(limitMatch[1].replace(/[_,]/g, '')) : undefined;
  const retryAfterMs = retryMatch ? Number(retryMatch[1]) * 1000 : undefined;

  return {
    limitTokens: Number.isFinite(limitTokens) && limitTokens! > 0 ? limitTokens : undefined,
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
