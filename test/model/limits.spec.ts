import { describe, expect, it } from 'vitest';
import {
  ModelCallGate,
  adaptiveModelTimeoutMs,
  MODEL_TIMEOUT_BASE_MS,
  MODEL_TIMEOUT_MAX_MS,
} from '../../src/server/models/limits';

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
