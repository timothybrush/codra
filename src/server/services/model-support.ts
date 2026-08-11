import { normalizeModelId } from '@shared/schema';
import { isTimeoutMessage, matchesAnyTransientSubstring } from '@shared/transient-errors';
import { UnparseableModelResponseError } from '../models/types';

// Pure helpers for the model service: alias resolution, prompt-size estimation, rate-limit parsing, error classification.

// Legacy id rewrites, applied before resolution. Empty today; kept as the hook for the next one.
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

// Rough estimate at four chars/token, only good enough to answer "is this hopeless against a 16k bucket?" -- underestimating costs a wasted call, overestimating just routes onward.
export function estimatePromptTokens(systemPrompt: string, userPrompt: string): number {
  return Math.ceil((systemPrompt.length + userPrompt.length) / 4);
}

// Only commit a prompt to a token-metered model if the estimate leaves this much headroom.
export const PROMPT_FIT_SAFETY_FACTOR = 0.8;

// A learned bucket below this is not a token quota, whatever the body said. Belt to the metric-name
// braces in parseRateLimitFromError: bodies already misparsed are persisted in KV for a job's 24h
// life and are sticky by design, so the read path has to reject them too or those jobs stay broken.
// No review prompt is ever this small, so a genuine bucket under it would skip every prompt anyway.
export const MIN_PLAUSIBLE_TOKEN_BUCKET = 1_000;

export function isPlausibleTokenBucket(limitTokens: number | undefined): boolean {
  return typeof limitTokens === 'number' && limitTokens >= MIN_PLAUSIBLE_TOKEN_BUCKET;
}

// Set by runModelChain on the deferral it throws when the chain still has untried models, so the
// caller can tell "we made progress, resume lower down" from "the same models failed again".
// A property rather than a constructor field, matching how retry-policy.ts attaches
// `retryAfterSeconds`. Deliberately lives here and not on the services/model barrel: four specs
// vi.mock that barrel with a hand-written object, and a symbol missing from it reads as `undefined`
// at the call site -- which is a TypeError inside the very catch block that handles failures.
export function nextChainIndexOf(error: unknown): number | null {
  const value = (error as { nextChainIndex?: unknown } | null)?.nextChainIndex;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

// Set by the Gemini adapter on any error it throws after dropping the response grammar, so the
// caller latches the (provider, model, grammar) triple even when that schema-less attempt also
// failed. Lives here rather than on the barrel for the same reason as `nextChainIndexOf` above.
export function isSchemaDroppedError(error: unknown): boolean {
  return (error as { schemaDropped?: unknown } | null)?.schemaDropped === true;
}

// Calls that may queue on a serialized model before further files route elsewhere; deeper queues have cost files their per-file chain budget while waiting.
export const MAX_METERED_QUEUE_DEPTH = 2;

// Every `metric: <name>, limit: <n>` pair Google states in a 429 body. A body may carry several, one
// per violated quota.
const QUOTA_VIOLATION_PATTERN = /metric:\s*(\S+?),\s*limit:\s*(\d[\d_,]*)/gi;

// Which of those metrics measures TOKENS. The rest count requests, and reading a request count as a
// bucket size is what took a model out for a whole job: Google's free tier reports
// `generate_content_free_tier_requests, limit: 15` -- 15 requests per minute -- and storing 15 as
// `limitTokens` made skipReason refuse every prompt over 12 tokens from then on, permanently, for a
// model that was merely busy. An unrecognised metric therefore teaches nothing about prompt size.
const TOKEN_QUOTA_METRIC = /(?:input_token|output_token|token_count|_tokens)/i;

// Google states both numbers in the 429 body ("...limit: 16000, model: <id> Please retry in 26.9s."); anything absent is simply omitted.
export function parseRateLimitFromError(error: unknown): { limitTokens?: number; retryAfterMs?: number } {
  const message = error instanceof Error ? error.message : String(error ?? '');

  // Deliberately NOT a bare /limit:\s*(\d+)/: the first stated limit in a multi-quota body is as
  // likely to be the request count as the token bucket.
  let limitTokens: number | undefined;
  for (const [, metric, limit] of message.matchAll(QUOTA_VIOLATION_PATTERN)) {
    if (!TOKEN_QUOTA_METRIC.test(metric)) continue;
    const parsed = Number(limit.replace(/[_,]/g, ''));
    if (!Number.isFinite(parsed) || !isPlausibleTokenBucket(parsed)) continue;
    // Smallest stated token bucket wins: it is the one that will reject the prompt first.
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
  // No reviewable output (reasoning-only / truncated / empty) is deterministic -- never retry it.
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
    // An upstream 5xx is a transient outage, not a client error, so it defers rather than permanently failing files.
    /\b50[0-9]\b/.test(lower) ||
    lower.includes('internal error')
  );
}
