import { logger } from '../core/logger';
import { ModelCallGate } from '../models/limits';
import type { ResolvedModelConfig } from '@server/db/model-configs';
import { MAX_METERED_QUEUE_DEPTH, PROMPT_FIT_SAFETY_FACTOR, parseRateLimitFromError } from './model-support';

// Sibling of the services/model barrel; import from there, not here (four specs vi.mock it).
// What ModelService learned this invocation about rate limits, plus the gates enforcing them. A
// collaborator, not free functions: the two maps and the gate are one state with one lifetime.
// (resolveModel / callModel / selectModel) deliberately stay methods on ModelService.
export class ModelRateLimitBook {
  // Workers allows only 6 simultaneous connections per invocation; an un-gated call queues past
  // that and burns its whole client timeout before dispatch (a provider "timing out" at exactly
  // the configured timeout). Gating starts the timeout only once a slot is held.
  private readonly callGate = new ModelCallGate();

  // What each model has told us about its own rate limit, this invocation. Google's 429 body
  // carries both bucket and cool-off, so parsing it keeps this adaptive with no baked-in numbers.
  private readonly modelRateLimits = new Map<string, { limitTokens?: number; cooldownUntil: number }>();

  // Models observed to enforce a token-per-minute bucket, each with its own serial gate: four
  // parallel files at ~4k tokens is 16k in one instant, tripping a 16k/min limit even though each
  // call alone would fit.
  //
  // KEYED BY MODEL, NOT PROVIDER. Google states the bucket per model; keying by provider
  // serialized every Google call in an all-Google chain: concurrency fell 1.21 -> 0.85, 32s -> 54s/file.
  private readonly tokenMeteredModels = new Map<string, ModelCallGate>();

  // Records what a 429 taught us, keyed by model. Deliberately does NOT wait out the cool-off:
  // the file falls through to the next model immediately, trading share of files for wall-clock.
  note(resolved: ResolvedModelConfig, error: unknown) {
    const { limitTokens, retryAfterMs } = parseRateLimitFromError(error);
    const existing = this.modelRateLimits.get(resolved.modelName);

    this.modelRateLimits.set(resolved.modelName, {
      // A learned bucket size is sticky: it describes the model, not this one failure, so a later
      // 429 that omits the number must not erase it.
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

  // Saves a call that was going to fail. Before this, every file re-probed a model that had
  // already said "retry in 50s", spending one of ~25 subrequests per probe -- which is what
  // produced "Too many subrequests", not any single large file.
  skipReason(modelName: string, estimatedPromptTokens: number): string | null {
    // Never queue deeply behind a serialized model: doing so once made 39 files queue behind
    // ~36s calls and lose the wait against their fallback budget, losing 16 of 119 files. A shallow
    // queue sends the overflow to a free model instead.
    const gate = this.tokenMeteredModels.get(modelName);
    if (gate && gate.queueDepth >= MAX_METERED_QUEUE_DEPTH) {
      return `${gate.queueDepth} calls already queued on it`;
    }

    const known = this.modelRateLimits.get(modelName);
    if (!known) return null;

    if (known.cooldownUntil > Date.now()) {
      return `cooling off for another ${Math.ceil((known.cooldownUntil - Date.now()) / 1000)}s`;
    }

    // A prompt larger than the whole per-minute bucket can never succeed, no matter how long we
    // wait, so it must not be allowed to consume the bucket's error path either.
    if (known.limitTokens && estimatedPromptTokens > known.limitTokens * PROMPT_FIT_SAFETY_FACTOR) {
      return `prompt ~${estimatedPromptTokens} tokens exceeds its ${known.limitTokens}-token bucket`;
    }

    return null;
  }

  // The runtime's 6-connection cap ONLY, with no per-model serial gate. Used by the Cloudflare
  // async-batch submit/poll calls, which are not the token-metered per-model path -- putting them
  // behind a metered model's serial gate would make a batch submit queue behind synchronous reviews.
  async runShared<T>(fn: () => Promise<T>): Promise<T> {
    return this.callGate.run(fn);
  }

  // Shared gate always (the runtime's 6-connection cap), plus a serial gate for a metered model.
  // Model gate THEN shared gate: consistent ordering rules out deadlock, and taking the model gate
  // first stops one metered model's queue from occupying slots other models could use.
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
