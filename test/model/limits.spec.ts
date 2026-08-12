import { describe, expect, it } from 'vitest';
import {
  ModelCallGate,
  adaptiveModelTimeoutMs,
  clampTimeoutToChainBudget,
  geminiThinkingBudgetTokens,
  MODEL_FALLBACK_CHAIN_BUDGET_MS,
  MODEL_TIMEOUT_BASE_MS,
  MODEL_TIMEOUT_MAX_MS,
  OUTPUT_TOKENS_FLOOR,
  resolveOutputTokenCeiling,
  reviewOutputBudgetTokens,
} from '../../src/server/models/limits';
import { generatorFindingCap } from '../../src/server/prompts/file-review';

// The whole point of these: a bin that overruns `maxOutputTokens` comes back as a repaired JSON prefix
// with its tail files silently empty, which is indistinguishable from "those files are clean".
describe('reviewOutputBudgetTokens', () => {
  it('never asks for less than the floor', () => {
    expect(reviewOutputBudgetTokens({ findingCap: 1, fileCount: 1 })).toBe(OUTPUT_TOKENS_FLOOR);
  });

  it('grows with the number of findings the prompt asked for', () => {
    const one = reviewOutputBudgetTokens({ findingCap: generatorFindingCap(10), fileCount: 1 });
    const bin = reviewOutputBudgetTokens({ findingCap: generatorFindingCap(10), fileCount: 6 });
    // Six files at the same per-file cap need more room than one.
    expect(bin).toBeGreaterThan(one);
    expect(bin).toBeGreaterThan(OUTPUT_TOKENS_FLOOR);
  });

  it('covers the bin ask that the old flat ceiling could not', () => {
    // The regression: 6 files x 20 findings each, requested inside a flat 8192.
    expect(reviewOutputBudgetTokens({ findingCap: 20, fileCount: 6 })).toBeGreaterThan(8_192);
  });
});

describe('resolveOutputTokenCeiling', () => {
  it('falls back to the provider default when no budget is stated', () => {
    expect(resolveOutputTokenCeiling(undefined, 65_536, 8_192)).toBe(8_192);
    // A caller that omits it must be unaffected by a raised provider max.
    expect(resolveOutputTokenCeiling(0, 65_536, 8_192)).toBe(8_192);
    expect(resolveOutputTokenCeiling(Number.NaN, 65_536, 8_192)).toBe(8_192);
  });

  it('never drops below the provider default, and never exceeds its max', () => {
    expect(resolveOutputTokenCeiling(1_000, 65_536, 8_192)).toBe(8_192);
    expect(resolveOutputTokenCeiling(20_000, 65_536, 8_192)).toBe(20_000);
    expect(resolveOutputTokenCeiling(999_999, 65_536, 8_192)).toBe(65_536);
    // A provider whose max is below the shared default still gets a request it accepts.
    expect(resolveOutputTokenCeiling(20_000, 4_096, 8_192)).toBe(4_096);
  });
});

describe('geminiThinkingBudgetTokens', () => {
  // Thinking bills against the SAME maxOutputTokens the JSON must fit in, so raising the ceiling has to
  // buy answer rather than more thinking.
  it('stays a minority of the ceiling', () => {
    expect(geminiThinkingBudgetTokens(32_768)).toBeLessThan(32_768 / 3);
    expect(geminiThinkingBudgetTokens(8_192)).toBeLessThan(8_192 / 3);
  });

  it('stays inside the band every Gemini 2.5 model accepts', () => {
    // Never 0 (the Pro models refuse it outright) and never above 8192 (Flash's own ceiling is lower).
    expect(geminiThinkingBudgetTokens(1_024)).toBeGreaterThanOrEqual(1_024);
    expect(geminiThinkingBudgetTokens(65_536)).toBeLessThanOrEqual(8_192);
  });
});

describe('generatorFindingCap', () => {
  // Bin size deliberately does NOT divide this; see the note on generatorFindingCap. Measured output was
  // ~3% of the ceiling, so the cap has never been the limit and lowering it only removes headroom.
  it('is 2x max_comments regardless of how many files share the call', () => {
    expect(generatorFindingCap(10)).toBe(20);
    expect(generatorFindingCap(1)).toBe(2);
  });
});

describe('adaptiveModelTimeoutMs', () => {
  it('uses the base budget for small diffs', () => {
    expect(adaptiveModelTimeoutMs(0)).toBe(MODEL_TIMEOUT_BASE_MS);
    expect(adaptiveModelTimeoutMs(100)).toBe(MODEL_TIMEOUT_BASE_MS);
    expect(adaptiveModelTimeoutMs(undefined)).toBe(MODEL_TIMEOUT_BASE_MS);
    expect(adaptiveModelTimeoutMs(null)).toBe(MODEL_TIMEOUT_BASE_MS);
  });

  it('scales with diff size beyond the free-line allowance', () => {
    // Use line counts that stay below the MAX cap so the linear scaling is observable.
    expect(adaptiveModelTimeoutMs(200)).toBe(MODEL_TIMEOUT_BASE_MS + 100 * 100);
    expect(adaptiveModelTimeoutMs(250)).toBeGreaterThan(adaptiveModelTimeoutMs(150));
  });

  it('caps at the maximum regardless of diff size', () => {
    expect(adaptiveModelTimeoutMs(100_000)).toBe(MODEL_TIMEOUT_MAX_MS);
  });
});

describe('clampTimeoutToChainBudget', () => {
  it('leaves every budget the adaptive ceiling can produce untouched', () => {
    // A big bin is meant to spend a whole invocation on one model and get the full ceiling.
    expect(clampTimeoutToChainBudget(MODEL_TIMEOUT_MAX_MS)).toBe(MODEL_TIMEOUT_MAX_MS);
    expect(clampTimeoutToChainBudget(MODEL_TIMEOUT_BASE_MS)).toBe(MODEL_TIMEOUT_BASE_MS);
  });

  // The invariant it exists to hold: the head of a chain is exempt from the budget check, so a per-call
  // budget above the chain budget would let a call start that can never finish inside it.
  it('holds the ceiling under the chain budget', () => {
    expect(MODEL_TIMEOUT_MAX_MS).toBeLessThanOrEqual(MODEL_FALLBACK_CHAIN_BUDGET_MS);
    expect(clampTimeoutToChainBudget(MODEL_FALLBACK_CHAIN_BUDGET_MS + 10_000)).toBe(MODEL_FALLBACK_CHAIN_BUDGET_MS);
  });
});

describe('ModelCallGate', () => {
  it('never runs more than the limit concurrently and eventually runs everything', async () => {
    const gate = new ModelCallGate(2);
    let active = 0;
    let peak = 0;
    const done: number[] = [];

    const task = (id: number) =>
      gate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        // Yield a couple of microtasks so tasks genuinely overlap.
        await Promise.resolve();
        await Promise.resolve();
        active--;
        done.push(id);
      });

    await Promise.all([task(1), task(2), task(3), task(4), task(5)]);

    expect(peak).toBeLessThanOrEqual(2);
    expect(done).toHaveLength(5);
  });

  it('releases the slot when a gated call rejects', async () => {
    const gate = new ModelCallGate(1);

    await expect(gate.run(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    // The slot must be free again for the next caller.
    const result = await gate.run(async () => 'ok');
    expect(result).toBe('ok');
  });
});
