import { describe, expect, it } from 'vitest';
import { proportionalSplit } from '@server/core/review';

// The parts must sum to exactly what the call cost: usage stats are computed from these columns.
describe('proportionalSplit', () => {
  // Exactness covers both hazards: flooring loses tokens, and an all-zero-weight
  // bin divides by zero.
  it('sums to exactly the total and splits by weight, not evenly', () => {
    for (const total of [0, 1, 7, 100, 4_097, 999_983]) {
      for (const weights of [[1], [1, 1], [3, 1], [1, 2, 3, 4], [7, 7, 7, 7, 7, 7], [0, 0, 0]]) {
        const parts = proportionalSplit(total, weights);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        expect(parts).toHaveLength(weights.length);
        expect(parts.every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
      }
    }

    expect(proportionalSplit(100, [90, 10])).toEqual([90, 10]);
    // 10 over [5,1,1] floors to 7,1,1 = 9; the leftover token goes to the heaviest weight.
    expect(proportionalSplit(10, [5, 1, 1])[0]).toBe(8);
  });
});
