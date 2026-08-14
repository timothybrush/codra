// Free-plan constraints: 6 concurrent connections max, 50 subrequests per invocation.

// Base timeout for small diffs (~1-5s response expected).
export const MODEL_TIMEOUT_BASE_MS = 20_000;
const MODEL_TIMEOUT_PER_LINE_MS = 100;
const MODEL_TIMEOUT_FREE_LINES = 100;
// Hard ceiling (max 50s) avoids 120s `exceededCpu` runtime limits, allowing failovers.
export const MODEL_TIMEOUT_MAX_MS = 50_000;

// File's total fallback chain budget. Exceeding defers the file to a fresh invocation.
// Sized slightly above MODEL_TIMEOUT_MAX_MS to give big diffs the full ceiling on a single model.
export const MODEL_FALLBACK_CHAIN_BUDGET_MS = 55_000;

// Scaled timeout buffer based on requested output tokens (1200ms per 1k tokens) to accommodate model generation time.
const MODEL_TIMEOUT_PER_1K_OUTPUT_MS = 1_200;

// Per-call timeout, scaled by diff size and expected output budget.
export function adaptiveModelTimeoutMs(
  diffLineCount: number | null | undefined,
  outputBudgetTokens?: number | null,
): number {
  const lines = typeof diffLineCount === 'number' && Number.isFinite(diffLineCount) ? Math.max(0, diffLineCount) : 0;
  const scaled = MODEL_TIMEOUT_BASE_MS + Math.max(0, lines - MODEL_TIMEOUT_FREE_LINES) * MODEL_TIMEOUT_PER_LINE_MS;

  const budget = typeof outputBudgetTokens === 'number' && Number.isFinite(outputBudgetTokens)
    ? Math.max(0, outputBudgetTokens)
    : 0;
  // Only the room ABOVE the floor earns extra time: every caller asks for at least the floor.
  const answerAllowance = Math.max(0, budget - OUTPUT_TOKENS_FLOOR) / 1_000 * MODEL_TIMEOUT_PER_1K_OUTPUT_MS;

  return Math.min(MODEL_TIMEOUT_MAX_MS, scaled + answerAllowance);
}

// Clamps timeout so single calls never exceed the chain budget and loop endlessly without running.
export function clampTimeoutToChainBudget(timeoutMs: number): number {
  return Math.min(timeoutMs, MODEL_FALLBACK_CHAIN_BUDGET_MS);
}

// Max 3 calls limits connection pool (out of 6 max) to leave slots for KV/GitHub.
export const MAX_CONCURRENT_MODEL_CALLS = 3;

// Token cost of a single finding (JSON structure). Generous to avoid silent truncations.
const OUTPUT_TOKENS_PER_FINDING = 340;
// Tokens per file entry in batch response.
const OUTPUT_TOKENS_PER_FILE_ENTRY = 160;
// Enough for the verify/summary paths and any caller that states no budget.
export const OUTPUT_TOKENS_FLOOR = 8_192;

// Output budget sizing (excludes reasoning tokens). Driven by requested capacity (findings * files).
export function reviewOutputBudgetTokens(input: { findingCap: number; fileCount: number }): number {
  const files = Math.max(1, input.fileCount);
  const findings = Math.max(1, input.findingCap) * files;
  return Math.max(
    OUTPUT_TOKENS_FLOOR,
    findings * OUTPUT_TOKENS_PER_FINDING + files * OUTPUT_TOKENS_PER_FILE_ENTRY,
  );
}

// Clamps output budget to provider maximums.
export function resolveOutputTokenCeiling(
  requested: number | undefined,
  providerMax: number,
  providerDefault: number,
): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return Math.min(providerDefault, providerMax);
  }
  return Math.min(providerMax, Math.max(providerDefault, Math.ceil(requested)));
}

// Gemini 2.5 reasoning budget (1024-8192 bounds). Must be explicitly limited since it counts against maxOutputTokens.
export function geminiThinkingBudgetTokens(answerBudgetTokens: number): number {
  return Math.min(8_192, Math.max(1_024, Math.floor(answerBudgetTokens / 4)));
}

// Actual subrequests cost per attempt (allows for adapter retries/fallback).
const SUBREQUESTS_PER_MODEL_ATTEMPT = 3;

// Subrequest headroom before calling models. Multiplied by concurrency cap to ensure pool can execute.
export const SUBREQUEST_HEADROOM_FOR_MODEL_CALL = SUBREQUESTS_PER_MODEL_ATTEMPT * MAX_CONCURRENT_MODEL_CALLS;

// FIFO semaphore: waits here don't eat into the caller's timeout budget.
export class ModelCallGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit = MAX_CONCURRENT_MODEL_CALLS) {}

  // onAcquired tracks wait time, preventing busy queues from skewing model latency metrics.
  async run<T>(fn: () => Promise<T>, onAcquired?: (waitedMs: number) => void): Promise<T> {
    const startedWaiting = Date.now();
    await this.acquire();
    onAcquired?.(Date.now() - startedWaiting);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get queueDepth() {
    return this.waiters.length;
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release() {
    // Fair release to next waiter.
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}
