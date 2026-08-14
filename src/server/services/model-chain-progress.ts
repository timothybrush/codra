import { logger } from '../core/logger';
import type { AppBindings } from '../env';
import type { TokenTracker } from '../core/token-tracker';
import { isPlausibleTokenBucket } from './model-support';

// Stores where each label got to in its model chain so deferred reviews resume properly.
// Stored as a single KV value per job to minimize subrequest budget overhead.

// Outlives job continuations; key is job-scoped and dies with the job.
const CHAIN_PROGRESS_TTL_SECONDS = 24 * 60 * 60;

// Allowed timeouts per model before dropping it from the job (3 = one full wave).
const MODEL_TIMEOUT_STRIKES = 3;

// Strikes before dropping the LAST chain candidate. Finite (6) to avoid infinite retries on dead models.
const LAST_CANDIDATE_TIMEOUT_STRIKES = 6;

// Max persisted cool-off (5 mins) protects against mis-parsed long delays.
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

// Absolute epoch-ms deadline prevents stale reads from over-suppressing models.
function parseCooldowns(source: Record<string, StoredCooldown> | undefined): Map<string, ModelCooldown> {
  const kept = new Map<string, ModelCooldown>();
  if (!source || typeof source !== 'object') return kept;

  const ceiling = Date.now() + MAX_PERSISTED_COOLDOWN_MS;
  for (const [model, value] of Object.entries(source)) {
    if (!value || typeof value !== 'object') continue;
    const until = typeof value.until === 'number' && Number.isFinite(value.until) ? value.until : 0;
    // Drops implausible limit sizes to prevent indefinite model suppression.
    const limitTokens =
      typeof value.limitTokens === 'number' && isPlausibleTokenBucket(value.limitTokens)
        ? value.limitTokens
        : undefined;
    if (until <= 0 && limitTokens === undefined) continue;
    kept.set(model, { cooldownUntil: Math.min(until, ceiling), limitTokens });
  }
  return kept;
}

function mergeCooldown(a: ModelCooldown | undefined, b: ModelCooldown): ModelCooldown {
  return {
    // Idempotent max() merge for advancing deadlines.
    cooldownUntil: Math.max(a?.cooldownUntil ?? 0, b.cooldownUntil),
    // Sticky limit retention on subsequent 429s.
    limitTokens: a?.limitTokens ?? b.limitTokens,
  };
}

export class ModelChainProgressStore {
  private loaded: Promise<Map<string, number>> | null = null;

  // Per-model timeouts stored alongside chain progress to save subrequests.
  private timeouts = new Map<string, number>();

  // Cleared strikes in this invocation, preventing max() merges from resurrecting them.
  private clearedTimeouts = new Set<string>();

  // Persisted rate-limits to avoid re-paying 429 prompts across invocations.
  private cooldowns = new Map<string, ModelCooldown>();

  // Single-flight writer prevents overlapping KV puts from dropping concurrent updates.
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

  // Job-less reviews return 0 (nothing to resume).
  private load(): Promise<Map<string, number>> {
    if (this.loaded) return this.loaded;

    const key = this.key;
    this.loaded = (async () => {
      if (!key) return new Map<string, number>();
      try {
        this.tracker?.incrementSubrequests(1);
        const raw = await this.env.APP_KV.get(key, 'json');
        if (!raw || typeof raw !== 'object') return new Map<string, number>();

        // Legacy support: reads bare label->index maps as files for smooth deploys.
        const stored = raw as StoredShape;
        const isNewShape =
          stored.files !== undefined || stored.timeouts !== undefined || stored.cooldowns !== undefined;
        this.timeouts = positiveInts(isNewShape ? stored.timeouts : undefined);
        // Merge sync noteRateLimit calls.
        for (const [model, value] of parseCooldowns(isNewShape ? stored.cooldowns : undefined)) {
          this.cooldowns.set(model, mergeCooldown(this.cooldowns.get(model), value));
        }
        return positiveInts(isNewShape ? stored.files : (raw as Record<string, unknown>));
      } catch (error) {
        // Missing memo costs retries, not correctness.
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
    // Monotonic advance only.
    if ((progress.get(label) ?? 0) >= nextIndex) return;
    progress.set(label, nextIndex);
    this.dirty = true;

    return this.flush();
  }

  // Ensure progress durability before deferring.
  private flush(): Promise<void> {
    // Join in-flight writes.
    if (this.inFlightWrite) return this.inFlightWrite;

    this.inFlightWrite = (async () => {
      try {
        // Process mid-put advances.
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
      // Merge against remote KV state using max() to prevent concurrent invocations from dropping labels.
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
          // Success outranks stored tally.
          if (this.clearedTimeouts.has(model)) continue;
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

  // Clears terminal labels for clean retries.
  async clear(label: string): Promise<void> {
    const progress = await this.load();
    progress.delete(label);
  }

  // Persist timeouts so subsequent waves can skip failing models.
  async noteTimeout(modelId: string): Promise<void> {
    if (!this.key) return;
    await this.load();
    this.timeouts.set(modelId, (this.timeouts.get(modelId) ?? 0) + 1);
    this.dirty = true;
    return this.flush();
  }

  // Reset tallies on success to avoid false permanent bans.
  async noteSuccess(modelId: string): Promise<void> {
    if (!this.key) return;
    await this.load();
    // No-op for healthy models to save subrequests.
    if (!this.timeouts.has(modelId)) return;
    this.timeouts.delete(modelId);
    this.clearedTimeouts.add(modelId);
    this.dirty = true;
    return this.flush();
  }

  async isTimingOut(modelId: string): Promise<boolean> {
    await this.load();
    return (this.timeouts.get(modelId) ?? 0) >= MODEL_TIMEOUT_STRIKES;
  }

  // For chain tails with no fallback.
  async isTimingOutTerminally(modelId: string): Promise<boolean> {
    await this.load();
    return (this.timeouts.get(modelId) ?? 0) >= LAST_CANDIDATE_TIMEOUT_STRIKES;
  }

  // Share load() promise to save KV reads.
  async loadCooldowns(): Promise<Map<string, ModelCooldown>> {
    await this.load();
    return new Map(this.cooldowns);
  }

  // Sync/non-flushing. Deferrals call flushPending() to coalesce writes.
  noteRateLimit(modelId: string, entry: ModelCooldown): void {
    if (!this.key) return;
    this.cooldowns.set(modelId, mergeCooldown(this.cooldowns.get(modelId), entry));
    this.dirty = true;
  }

  // Flush mutations without advancing progress (e.g. quota deferrals).
  flushPending(): Promise<void> {
    if (!this.key || !this.dirty) return Promise.resolve();
    return this.flush();
  }
}
