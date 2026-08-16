import { logger } from '@codraoss/core/logger';
import { ModelCallGate } from '../limits';
import type { ResolvedModelConfig } from '@codraoss/schema';
import { MAX_METERED_QUEUE_DEPTH, PROMPT_FIT_SAFETY_FACTOR, parseRateLimitFromError } from './model-support';

// Narrow port onto whatever survives an invocation (today: the job's chain-progress KV value), so
// this class stays unit-testable without an env and the barrel surface is unchanged.
export interface RateLimitPersistence {
  loadCooldowns(): Promise<Map<string, { cooldownUntil: number; limitTokens?: number }>>;
  noteRateLimit(modelId: string, entry: { cooldownUntil: number; limitTokens?: number }): void;
}

// Import from the services/model barrel, not here (four specs vi.mock it).
export class ModelRateLimitBook {
  // Workers allows 6 simultaneous connections per invocation; gating starts the client timeout once a slot is held, instead of while queued.
  private readonly callGate = new ModelCallGate();

  // Google's 429 body carries both bucket and cool-off, so parsing it keeps this adaptive with no baked-in numbers.
  private readonly modelRateLimits = new Map<string, { limitTokens?: number; cooldownUntil: number }>();

  // Keyed by model, not provider: keying by provider serialized every call in an all-Google chain, dropping concurrency and throughput.
  private readonly tokenMeteredModels = new Map<string, ModelCallGate>();

  // Memoized so the KV read is shared, not repeated per model per file.
  private hydrated: Promise<void> | null = null;

  constructor(private readonly persistence?: RateLimitPersistence) {}

  // Without this the book is invocation-scoped: every job continuation re-paid a full-prompt 429 to
  // re-learn a cool-off the previous invocation had already been told about.
  private hydrate(): Promise<void> {
    this.hydrated ??= (async () => {
      if (!this.persistence) return;
      for (const [modelName, entry] of await this.persistence.loadCooldowns()) {
        const existing = this.modelRateLimits.get(modelName);
        this.modelRateLimits.set(modelName, {
          limitTokens: existing?.limitTokens ?? entry.limitTokens,
          cooldownUntil: Math.max(existing?.cooldownUntil ?? 0, entry.cooldownUntil),
        });

        // A model with a known bucket is token-metered, so serialize it from the FIRST call rather
        // than after this invocation re-earns its own 429.
        if (!this.tokenMeteredModels.has(modelName)) {
          this.tokenMeteredModels.set(modelName, new ModelCallGate(1));
        }
      }
    })();
    return this.hydrated;
  }

  // Deliberately does NOT wait out the cool-off: the file falls through to the next model immediately, trading share of files for wall-clock.
  note(resolved: ResolvedModelConfig, error: unknown) {
    const { limitTokens, retryAfterMs } = parseRateLimitFromError(error);
    const existing = this.modelRateLimits.get(resolved.modelName);

    const entry = {
      // Sticky: a later 429 that omits the number must not erase it.
      limitTokens: limitTokens ?? existing?.limitTokens,
      // Default to a minute when the provider didn't say -- these buckets are per-minute.
      cooldownUntil: Date.now() + (retryAfterMs ?? 60_000),
    };
    this.modelRateLimits.set(resolved.modelName, entry);
    this.persistence?.noteRateLimit(resolved.modelName, entry);

    if (!this.tokenMeteredModels.has(resolved.modelName)) {
      this.tokenMeteredModels.set(resolved.modelName, new ModelCallGate(1));
      logger.info(`Serializing calls to ${resolved.modelName}; it enforces a token-per-minute bucket`, {
        provider: resolved.providerName,
        limitTokens: limitTokens ?? null,
      });
    }
  }

  // Avoids re-probing a model that already said "retry in Ns" once per file, which is what produced "Too many subrequests".
  async skipReason(modelName: string, estimatedPromptTokens: number): Promise<string | null> {
    // Cool-offs learned by an earlier invocation of this job count too.
    await this.hydrate();

    // Never queue deeply behind a serialized model; a shallow queue sends overflow to a free model instead.
    const gate = this.tokenMeteredModels.get(modelName);
    if (gate && gate.queueDepth >= MAX_METERED_QUEUE_DEPTH) {
      return `${gate.queueDepth} calls already queued on it`;
    }

    const known = this.modelRateLimits.get(modelName);
    if (!known) return null;

    if (known.cooldownUntil > Date.now()) {
      return `cooling off for another ${Math.ceil((known.cooldownUntil - Date.now()) / 1000)}s`;
    }

    // A prompt larger than the whole per-minute bucket can never succeed, however long we wait.
    if (known.limitTokens && estimatedPromptTokens > known.limitTokens * PROMPT_FIT_SAFETY_FACTOR) {
      return `prompt ~${estimatedPromptTokens} tokens exceeds its ${known.limitTokens}-token bucket`;
    }

    return null;
  }

  // 6-connection cap only, no per-model gate: async-batch submit/poll isn't the token-metered path.
  async runShared<T>(fn: () => Promise<T>): Promise<T> {
    return this.callGate.run(fn);
  }

  // Model gate then shared gate, in that order, to rule out deadlock.
  async runGated<T>(
    resolved: ResolvedModelConfig,
    onGateWait: ((waitedMs: number) => void) | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const modelGate = this.tokenMeteredModels.get(resolved.modelName);
    if (!modelGate) return this.callGate.run(fn, onGateWait);
    return modelGate.run(() => this.callGate.run(fn, onGateWait), onGateWait);
  }
}
