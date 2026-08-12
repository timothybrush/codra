// Platform primitives the engine refuses to reach for as globals, so a caller can make a review
// deterministic (fixed clock, fixed ids) or run it with no key-value store at all.

/**
 * A best-effort string cache, satisfied structurally by Cloudflare's KVNamespace.
 *
 * A correct implementation must:
 *  - treat every entry as expendable. `get` returning null is always legal, for any key, at any
 *    time, including immediately after a successful `put` -- the engine re-derives the value.
 *  - never throw from `get`. A read failure must surface as null, not an exception, because the
 *    only caller (diff-cache) treats a miss as normal and a throw as a job failure.
 *  - honour `expirationTtl` in seconds if it can, and ignore it if it cannot. `put` MAY throw; the
 *    engine catches and continues, so a full or read-only store degrades to re-fetching.
 * Reads need not be strongly consistent, and writes need not be visible to a concurrent reader.
 */
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/**
 * Wall-clock time in epoch milliseconds, satisfied by `{ now: () => Date.now() }`.
 *
 * A correct implementation must be non-decreasing within one phase: the file runner and the phase
 * loop both compute elapsed time by subtracting two `now()` readings, and a clock that went
 * backwards would produce a negative duration and, worse, hide a breach of the 12-minute
 * REVIEW_CHUNK_WALL_CLOCK_MS budget that exists to keep the phase inside its invocation limit.
 * It need not be monotonic ACROSS phases -- each phase re-reads it from scratch.
 */
export interface Clock {
  now(): number;
}

/**
 * Opaque unique identifiers, satisfied structurally by `globalThis.crypto`.
 *
 * A correct implementation must never return the same value twice for the lifetime of the
 * deployment. The engine's one caller mints a job lease owner with it, and two workers agreeing on
 * a lease owner string would let both believe they hold the same job's lease -- the one failure this
 * whole locking scheme exists to prevent. Values need not be UUID-shaped, sortable, or unguessable.
 */
export interface IdGenerator {
  randomUUID(): string;
}

// Re-exported so `@codra/core/ports` is the single place a host looks for the contracts it must
// implement, even though the interface itself has to live next to the scrubbing it constrains.
export type { Logger } from '../logger';
