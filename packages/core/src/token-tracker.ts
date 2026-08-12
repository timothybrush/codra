import { logger } from './logger';

export interface TokenUsage {
  input: number;
  output: number;
}

export interface ModelUsage extends TokenUsage {
  model: string;
  calls: number;
}

export type WastedAttemptReason = 'rate-limited' | 'error';

// Prompts we paid to transmit but got nothing back for. Estimated, never billed: a failed call
// returns no usageMetadata, so this is `estimatePromptTokens` output and must not be compared to a
// provider's own promptTokenCount as an equal.
//
// `estimatedInput` is a token count but must NOT be named `...Tokens`: logger.ts redacts any key
// whose name contains "token", so the field would log as [REDACTED] and the metric would be useless.
export interface WastedUsage {
  attempts: number;
  estimatedInput: number;
  skips: number;
  byReason: Record<string, number>;
}

export class TokenTracker {
  private usage: Map<string, ModelUsage> = new Map();
  // Kept out of `usage` so estimates can never leak into billed accounting or telemetry.
  private wasted = { attempts: 0, estimatedInput: 0, skips: 0 };
  private wastedByReason: Map<string, number> = new Map();
  private subrequests = 0;
  private readonly MAX_SUBREQUESTS = 50;
  // Covers untracked Hyperdrive queries per chunk (lease heartbeats, review reads/writes, etc.) that the tracker never sees.
  private readonly SAFE_MARGIN = 25;

  incrementSubrequests(count = 1) {
    this.subrequests += count;
  }

  getSubrequestCount() {
    return this.subrequests;
  }

  hasRemainingSubrequests(needed = 1) {
    return this.subrequests + needed <= this.MAX_SUBREQUESTS;
  }

  isNearLimit() {
    return this.subrequests >= this.MAX_SUBREQUESTS - this.SAFE_MARGIN;
  }

  // Subrequests left before crossing into the reserved safety margin below Cloudflare's per-invocation cap; size variable concurrent work against this instead of a fixed constant.
  remainingSafeBudget() {
    return Math.max(0, this.MAX_SUBREQUESTS - this.SAFE_MARGIN - this.subrequests);
  }

  record(model: string, input: number, output: number) {
    const existing = this.usage.get(model) || { model, input: 0, output: 0, calls: 0 };
    
    this.usage.set(model, {
      model,
      input: existing.input + input,
      output: existing.output + output,
      calls: existing.calls + 1,
    });

    logger.debug(`Token usage recorded for ${model}`, { 
      input, 
      output, 
      totalInput: existing.input + input,
      totalOutput: existing.output + output
    });
  }

  // A full prompt went over the wire and produced no reviewable response.
  recordFailedAttempt(model: string, estimatedInputTokens: number, reason: WastedAttemptReason) {
    this.wasted.attempts += 1;
    this.wasted.estimatedInput += estimatedInputTokens;
    this.wastedByReason.set(reason, (this.wastedByReason.get(reason) ?? 0) + 1);

    logger.debug(`Wasted model attempt on ${model}`, { estimatedInput: estimatedInputTokens, reason });
  }

  // A prompt we did NOT send because a gate already knew it would fail -- the positive signal that
  // cooldown learning is working, and the counterpart to recordFailedAttempt.
  recordSkippedCall(model: string, reason: string) {
    this.wasted.skips += 1;

    logger.debug(`Skipped model call on ${model}`, { reason });
  }

  getWasted(): WastedUsage {
    return { ...this.wasted, byReason: Object.fromEntries(this.wastedByReason) };
  }

  getTotalUsage(): TokenUsage {
    let input = 0;
    let output = 0;
    for (const modelUsage of this.usage.values()) {
      input += modelUsage.input;
      output += modelUsage.output;
    }
    return { input, output };
  }

  getBreakdown(): ModelUsage[] {
    return Array.from(this.usage.values());
  }

  merge(other: TokenTracker) {
    for (const usage of other.getBreakdown()) {
      this.record(usage.model, usage.input, usage.output);
    }

    const otherWasted = other.getWasted();
    this.wasted.attempts += otherWasted.attempts;
    this.wasted.estimatedInput += otherWasted.estimatedInput;
    this.wasted.skips += otherWasted.skips;
    for (const [reason, count] of Object.entries(otherWasted.byReason)) {
      this.wastedByReason.set(reason, (this.wastedByReason.get(reason) ?? 0) + count);
    }
  }

  reset() {
    this.usage.clear();
    this.wasted = { attempts: 0, estimatedInput: 0, skips: 0 };
    this.wastedByReason.clear();
  }
}
