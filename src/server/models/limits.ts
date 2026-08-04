/**
 * Shared throttling/timeout policy for outbound model calls.
 *
 * Two Workers Free-plan constraints shape all of it:
 *  1. At most SIX connections per invocation may await response headers at once. Beyond that the
 *     runtime silently QUEUES — it does not error. A queued model call burns its own client-side
 *     timeout without ever being dispatched, which reads in the logs as a provider timing out at
 *     exactly the configured value on every attempt.
 *  2. 50 subrequests per invocation, so every queued-then-timed-out call is a wasted one.
 */

/** Base budget for a small diff. A suitable model answers in ~1-5s; slower means stuck or queued. */
export const MODEL_TIMEOUT_BASE_MS = 20_000;
export const MODEL_TIMEOUT_PER_LINE_MS = 100;
export const MODEL_TIMEOUT_FREE_LINES = 100;
/**
 * Hard ceiling for one call, and it must stay well under the ~120s invocation wall clock. At the
 * old 120s ceiling a hung call took the whole workflow invocation down as `exceededCpu` — losing
 * all progress and looping — instead of timing out and failing over. 40s leaves room for a couple
 * of sequential fallback attempts inside one invocation.
 */
export const MODEL_TIMEOUT_MAX_MS = 40_000;

/**
 * Budget for one file's entire fallback chain. Even with a short per-call ceiling, a file failing
 * over through many models can run enough calls back-to-back to pass the invocation limit. Past
 * this, defer the file: it resumes from the fast primary model in a fresh invocation.
 */
export const MODEL_FALLBACK_CHAIN_BUDGET_MS = 55_000;

/** Per-call timeout, scaled by the size of the (already truncated) diff being reviewed. */
export function adaptiveModelTimeoutMs(diffLineCount: number | null | undefined): number {
  const lines = typeof diffLineCount === 'number' && Number.isFinite(diffLineCount) ? Math.max(0, diffLineCount) : 0;
  const scaled = MODEL_TIMEOUT_BASE_MS + Math.max(0, lines - MODEL_TIMEOUT_FREE_LINES) * MODEL_TIMEOUT_PER_LINE_MS;
  return Math.min(MODEL_TIMEOUT_MAX_MS, scaled);
}

/**
 * Kept below the runtime's 6-connection cap so the KV/Hyperdrive/GitHub requests that concurrent
 * file reviews issue still find a free slot, and model calls are never queued behind each other.
 */
export const MAX_CONCURRENT_MODEL_CALLS = 3;

/**
 * Tiny FIFO semaphore. Callers wait *before* their provider timeout starts, so queueing for a slot
 * never eats into a call's own time budget.
 */
export class ModelCallGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit = MAX_CONCURRENT_MODEL_CALLS) {}

  /**
   * `onAcquired` reports how long this caller queued. Callers that budget wall clock need it —
   * charging queue time to a per-file budget makes a busy gate look like a slow model.
   */
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

  /** How many callers are queued behind the active ones. */
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
    // Hand the slot straight to the next waiter (active count unchanged) so a newly arriving caller
    // cannot sneak in between the release and the waiter resuming.
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}
