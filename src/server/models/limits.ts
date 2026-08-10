// Two Workers Free-plan constraints shape all of it: (1) at most 6 connections per invocation may await headers at once, or the runtime silently queues and burns the call's own timeout undispatched; (2) 50 subrequests per invocation, so a queued-then-timed-out call is a wasted one.

// Base budget for a small diff. A suitable model answers in ~1-5s; slower means stuck or queued.
export const MODEL_TIMEOUT_BASE_MS = 20_000;
const MODEL_TIMEOUT_PER_LINE_MS = 100;
const MODEL_TIMEOUT_FREE_LINES = 100;
// Hard ceiling for one call, well under the ~120s invocation wall clock: at the old 120s ceiling a hung call took the whole invocation down as `exceededCpu` instead of failing over.
export const MODEL_TIMEOUT_MAX_MS = 40_000;

// Budget for one file's entire fallback chain; past this, defer the file to resume from the primary model in a fresh invocation.
export const MODEL_FALLBACK_CHAIN_BUDGET_MS = 55_000;

// Per-call timeout, scaled by the size of the (already truncated) diff being reviewed.
export function adaptiveModelTimeoutMs(diffLineCount: number | null | undefined): number {
  const lines = typeof diffLineCount === 'number' && Number.isFinite(diffLineCount) ? Math.max(0, diffLineCount) : 0;
  const scaled = MODEL_TIMEOUT_BASE_MS + Math.max(0, lines - MODEL_TIMEOUT_FREE_LINES) * MODEL_TIMEOUT_PER_LINE_MS;
  return Math.min(MODEL_TIMEOUT_MAX_MS, scaled);
}

// Kept below the runtime's 6-connection cap so KV/Hyperdrive/GitHub requests from concurrent file reviews still find a free slot.
export const MAX_CONCURRENT_MODEL_CALLS = 3;

// Tiny FIFO semaphore; callers wait *before* their provider timeout starts, so queueing never eats into a call's own time budget.
export class ModelCallGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit = MAX_CONCURRENT_MODEL_CALLS) {}

  // `onAcquired` reports queue wait; charging it to a per-file budget would make a busy gate look like a slow model.
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
    // Hand the slot straight to the next waiter so a newly arriving caller can't sneak in ahead of it.
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}
