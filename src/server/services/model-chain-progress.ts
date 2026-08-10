import { logger } from '../core/logger';
import type { AppBindings } from '../env';
import type { TokenTracker } from '../core/token-tracker';

// Where each label (file path, or a bin's label) got to in its model chain, so a deferred review
// resumes at the next model instead of replaying the models that already failed for it.
//
// Why this exists: one invocation affords ~55s of model calls (MODEL_FALLBACK_CHAIN_BUDGET_MS), and
// a single slow model can spend all of it. Without a memo the retry starts at the primary again, so
// a chain whose first two entries time out never reaches entries 3..n no matter how many times the
// job retries -- the fallback list past the head is unreachable by construction.
//
// Stored as ONE KV value per job rather than a key per file: a key per file would cost a subrequest
// per file per invocation out of a budget of 50, which is the very resource this is protecting.

// Long enough to outlive a job's continuations; the key is job-scoped so it dies with the job.
const CHAIN_PROGRESS_TTL_SECONDS = 24 * 60 * 60;

// Timeouts against one model before it is dropped for the rest of the job. Three, because a review
// chunk dispatches three units concurrently: that is one full wave, so the model is judged on a
// whole round rather than on a single slow call, and is dropped from the next invocation onward.
const MODEL_TIMEOUT_STRIKES = 3;

// Ceiling on a persisted cool-off. A mis-parsed "retry in 3600s" would otherwise disable a model for
// the rest of the job; per-minute buckets never legitimately need more than this.
const MAX_PERSISTED_COOLDOWN_MS = 5 * 60 * 1000;

export interface ModelCooldown {
  cooldownUntil: number;
  limitTokens?: number;
}

type StoredCooldown = { until?: unknown; limitTokens?: unknown };
type StoredShape = {
  files?: Record<string, unknown>;
  timeouts?: Record<string, unknown>;
  cooldowns?: Record<string, StoredCooldown>;
};

function positiveInts(source: Record<string, unknown> | undefined): Map<string, number> {
  const kept = new Map<string, number>();
  if (!source || typeof source !== 'object') return kept;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) kept.set(key, value);
  }
  return kept;
}

// `until` is an absolute epoch-ms deadline, never a duration: a stale KV read then yields an
// already-expired entry, which degrades to today's behaviour (one wasted probe) and can never
// over-suppress. Expired entries are kept, not dropped -- `limitTokens` outlives the cool-off and
// still answers "can this prompt ever fit in that bucket?".
function parseCooldowns(source: Record<string, StoredCooldown> | undefined): Map<string, ModelCooldown> {
  const kept = new Map<string, ModelCooldown>();
  if (!source || typeof source !== 'object') return kept;

  const ceiling = Date.now() + MAX_PERSISTED_COOLDOWN_MS;
  for (const [model, value] of Object.entries(source)) {
    if (!value || typeof value !== 'object') continue;
    const until = typeof value.until === 'number' && Number.isFinite(value.until) ? value.until : 0;
    const limitTokens =
      typeof value.limitTokens === 'number' && Number.isFinite(value.limitTokens) && value.limitTokens > 0
        ? value.limitTokens
        : undefined;
    if (until <= 0 && limitTokens === undefined) continue;
    kept.set(model, { cooldownUntil: Math.min(until, ceiling), limitTokens });
  }
  return kept;
}

function mergeCooldown(a: ModelCooldown | undefined, b: ModelCooldown): ModelCooldown {
  return {
    // Indexes and deadlines both only move forward, which makes max() the idempotent merge here too.
    cooldownUntil: Math.max(a?.cooldownUntil ?? 0, b.cooldownUntil),
    // Sticky: a later 429 that omits the bucket size must not erase a known one.
    limitTokens: a?.limitTokens ?? b.limitTokens,
  };
}

export class ModelChainProgressStore {
  private loaded: Promise<Map<string, number>> | null = null;

  // Timeouts per model for this job, in the SAME KV value as the chain progress. A second key would
  // cost a second subrequest read per invocation, out of the 50 this whole mechanism exists to save.
  private timeouts = new Map<string, number>();

  // Per-model rate-limit state, in the same KV value again. Without persistence ModelRateLimitBook
  // is invocation-scoped, so every continuation re-paid a full-prompt 429 to re-learn the cool-off
  // this job already knew -- which is what the comment in model-review-chain.ts assumed was covered.
  private cooldowns = new Map<string, ModelCooldown>();

  // Single-flight writer. Two bins deferring at once used to issue two overlapping puts, and KV has
  // no ordering guarantee: if the put carrying LESS state happened to land second, the other bin's
  // entry was gone and those files replayed a model already ruled out. Only one put is ever in
  // flight now, and anything that arrives during it is folded into one follow-up put.
  private inFlightWrite: Promise<void> | null = null;
  private dirty = false;

  constructor(
    private readonly env: Pick<AppBindings, 'APP_KV'>,
    private readonly jobId: string | undefined,
    private readonly tracker?: TokenTracker,
  ) {}

  private get key() {
    return this.jobId ? `jobs:${this.jobId}:chain-progress` : null;
  }

  // Resolves to 0 without a jobId: a review outside a job (preflight, verify) has nothing to resume.
  private load(): Promise<Map<string, number>> {
    if (this.loaded) return this.loaded;

    const key = this.key;
    this.loaded = (async () => {
      if (!key) return new Map<string, number>();
      try {
        this.tracker?.incrementSubrequests(1);
        const raw = await this.env.APP_KV.get(key, 'json');
        if (!raw || typeof raw !== 'object') return new Map<string, number>();

        // Values written before `timeouts` existed are a bare label->index map. Reading them as the
        // files map keeps in-flight jobs resuming correctly across the deploy.
        const stored = raw as StoredShape;
        const isNewShape =
          stored.files !== undefined || stored.timeouts !== undefined || stored.cooldowns !== undefined;
        this.timeouts = positiveInts(isNewShape ? stored.timeouts : undefined);
        // Merged, not assigned: noteRateLimit is sync and may land before this read resolves.
        for (const [model, value] of parseCooldowns(isNewShape ? stored.cooldowns : undefined)) {
          this.cooldowns.set(model, mergeCooldown(this.cooldowns.get(model), value));
        }
        return positiveInts(isNewShape ? stored.files : (raw as Record<string, unknown>));
      } catch (error) {
        // A missing memo costs a repeated model attempt, never correctness -- never fail the review for it.
        logger.warn('Failed to read model chain progress; resuming from the primary model', {
          jobId: this.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
        return new Map<string, number>();
      }
    })();
    return this.loaded;
  }

  async startIndexFor(label: string): Promise<number> {
    return (await this.load()).get(label) ?? 0;
  }

  async advance(label: string, nextIndex: number): Promise<void> {
    if (!this.key || nextIndex <= 0) return;

    const progress = await this.load();
    // Monotonic: a later invocation must never walk back up a chain it already descended.
    if ((progress.get(label) ?? 0) >= nextIndex) return;
    progress.set(label, nextIndex);
    this.dirty = true;

    return this.flush();
  }

  // Callers await this, so a deferral never returns before its progress is durable.
  private flush(): Promise<void> {
    // A write is already running; it re-checks `dirty` before finishing, so joining it is enough.
    if (this.inFlightWrite) return this.inFlightWrite;

    this.inFlightWrite = (async () => {
      try {
        // Loop rather than write once: advances that arrive mid-put set `dirty` again, and the
        // single-threaded runtime guarantees they land before this re-reads it.
        while (this.dirty) {
          this.dirty = false;
          await this.writeOnce();
        }
      } finally {
        this.inFlightWrite = null;
      }
    })();

    return this.inFlightWrite;
  }

  private async writeOnce(): Promise<void> {
    const key = this.key;
    if (!key) return;

    const progress = await this.load();
    try {
      // Merge against what is actually stored, taking the higher index per label. Two concurrent
      // INVOCATIONS (rare, but possible around a continuation handoff) have separate in-memory
      // maps, so a blind put would drop the other one's labels entirely. Indexes only ever move
      // forward, which makes max() the correct and idempotent merge.
      this.tracker?.incrementSubrequests(1);
      const raw = await this.env.APP_KV.get(key, 'json');
      if (raw && typeof raw === 'object') {
        const stored = raw as StoredShape;
        const isNewShape =
          stored.files !== undefined || stored.timeouts !== undefined || stored.cooldowns !== undefined;
        for (const [label, value] of positiveInts(isNewShape ? stored.files : (raw as Record<string, unknown>))) {
          if (value > (progress.get(label) ?? 0)) progress.set(label, value);
        }
        for (const [model, value] of positiveInts(isNewShape ? stored.timeouts : undefined)) {
          if (value > (this.timeouts.get(model) ?? 0)) this.timeouts.set(model, value);
        }
        for (const [model, value] of parseCooldowns(isNewShape ? stored.cooldowns : undefined)) {
          this.cooldowns.set(model, mergeCooldown(this.cooldowns.get(model), value));
        }
      }

      this.tracker?.incrementSubrequests(1);
      await this.env.APP_KV.put(
        key,
        JSON.stringify({
          files: Object.fromEntries(progress),
          timeouts: Object.fromEntries(this.timeouts),
          cooldowns: Object.fromEntries(
            Array.from(this.cooldowns, ([model, entry]) => [
              model,
              { until: entry.cooldownUntil, limitTokens: entry.limitTokens },
            ]),
          ),
        }),
        { expirationTtl: CHAIN_PROGRESS_TTL_SECONDS },
      );
    } catch (error) {
      logger.warn('Failed to persist model chain progress; the next attempt will retry from the same model', {
        jobId: this.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Clears a label once it reaches a terminal state, so a retry of the job starts from the primary.
  async clear(label: string): Promise<void> {
    const progress = await this.load();
    progress.delete(label);
  }

  // A model that keeps timing out is spending the invocation's wall clock and returning nothing,
  // and because a chunk dispatches its units concurrently, every unit in a wave pays that cost
  // before any of them can learn from it. Persisting the count is what lets the NEXT wave skip it.
  async noteTimeout(modelId: string): Promise<void> {
    if (!this.key) return;
    await this.load();
    this.timeouts.set(modelId, (this.timeouts.get(modelId) ?? 0) + 1);
    this.dirty = true;
    return this.flush();
  }

  async isTimingOut(modelId: string): Promise<boolean> {
    await this.load();
    return (this.timeouts.get(modelId) ?? 0) >= MODEL_TIMEOUT_STRIKES;
  }

  // Shares load()'s single promise, so hydrating the rate-limit book costs no extra KV read.
  async loadCooldowns(): Promise<Map<string, ModelCooldown>> {
    await this.load();
    return new Map(this.cooldowns);
  }

  // Deliberately sync and non-flushing. A 429 does not advance chain progress (see the caller), so
  // flushing here would add a get+put pair on a path that has none today; the deferral that follows
  // calls flushPending() instead, and the single-flight writer coalesces a whole wave into one put.
  noteRateLimit(modelId: string, entry: ModelCooldown): void {
    if (!this.key) return;
    this.cooldowns.set(modelId, mergeCooldown(this.cooldowns.get(modelId), entry));
    this.dirty = true;
  }

  // For paths that mutated state without advancing progress -- notably a quota deferral.
  flushPending(): Promise<void> {
    if (!this.key || !this.dirty) return Promise.resolve();
    return this.flush();
  }
}
