import { logger } from '../core/logger';
import { ModelCallGate } from '../models/limits';
import type { ResolvedModelConfig } from '@server/db/model-configs';
import { MAX_METERED_QUEUE_DEPTH, PROMPT_FIT_SAFETY_FACTOR, parseRateLimitFromError } from './model-support';

// Import from the services/model barrel, not here (four specs vi.mock it).
export class ModelRateLimitBook {
  // Workers allows 6 simultaneous connections per invocation; gating starts the client timeout once a slot is held, instead of while queued.
  private readonly callGate = new ModelCallGate();

  // Google's 429 body carries both bucket and cool-off, so parsing it keeps this adaptive with no baked-in numbers.
  private readonly modelRateLimits = new Map<string, { limitTokens?: number; cooldownUntil: number }>();

  // Keyed by model, not provider: keying by provider serialized every call in an all-Google chain, dropping concurrency and throughput.
  private readonly tokenMeteredModels = new Map<string, ModelCallGate>();

  // Deliberately does NOT wait out the cool-off: the file falls through to the next model immediately, trading share of files for wall-clock.
  note(resolved: ResolvedModelConfig, error: unknown) {
    const { limitTokens, retryAfterMs } = parseRateLimitFromError(error);
    const existing = this.modelRateLimits.get(resolved.modelName);

    this.modelRateLimits.set(resolved.modelName, {
      // Sticky: a later 429 that omits the number must not erase it.
      limitTokens: limitTokens ?? existing?.limitTokens,
      // Default to a minute when the provider didn't say -- these buckets are per-minute.
      cooldownUntil: Date.now() + (retryAfterMs ?? 60_000),
    });

    if (!this.tokenMeteredModels.has(resolved.modelName)) {
      this.tokenMeteredModels.set(resolved.modelName, new ModelCallGate(1));
      logger.info(`Serializing calls to ${resolved.modelName}; it enforces a token-per-minute bucket`, {
        provider: resolved.providerName,
        limitTokens: limitTokens ?? null,
      });
    }
  }

  // Avoids re-probing a model that already said "retry in Ns" once per file, which is what produced "Too many subrequests".
  skipReason(modelName: string, estimatedPromptTokens: number): string | null {
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
