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

// Google states both numbers in the 429 body ("...limit: 16000, model: <id> Please retry in 26.9s."); anything absent is simply omitted.
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
