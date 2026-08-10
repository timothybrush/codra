import { logger } from './logger';

export interface TokenUsage {
  input: number;
  output: number;
}

export interface ModelUsage extends TokenUsage {
  model: string;
  calls: number;
}

export class TokenTracker {
  private usage: Map<string, ModelUsage> = new Map();
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
  }

  reset() {
    this.usage.clear();
  }
}
