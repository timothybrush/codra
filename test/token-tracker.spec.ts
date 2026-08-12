import { describe, it, expect } from 'vitest';
import { TokenTracker } from '@server/core/token-tracker';

// Regression coverage for the subrequest-exhaustion incident (job bb9cf692...): the review
// workflow could burn through Cloudflare's per-invocation subrequest cap (Workers Free plan:
// 50 subrequests/invocation) without ever checking how much budget was left. TokenTracker
// already tracked a running count but exposed no way to ask "how much is safely left", so
// nothing consulted it before starting more concurrent work. These tests pin down the new
// remainingSafeBudget() accessor that review.ts and model.ts now use to throttle themselves.

describe('TokenTracker.remainingSafeBudget', () => {
  it('starts with the full margin below the hard cap available', () => {
    const tracker = new TokenTracker();
    // MAX_SUBREQUESTS (50) - SAFE_MARGIN (25) = 25, with nothing spent yet.
    expect(tracker.remainingSafeBudget()).toBe(25);
  });

  it('shrinks by exactly what has been spent so far', () => {
    const tracker = new TokenTracker();
    tracker.incrementSubrequests(10);
    expect(tracker.remainingSafeBudget()).toBe(15);

    tracker.incrementSubrequests(5);
    expect(tracker.remainingSafeBudget()).toBe(10);
  });

  it('never goes negative once spending exceeds the safe margin', () => {
    const tracker = new TokenTracker();
    tracker.incrementSubrequests(45);
    expect(tracker.remainingSafeBudget()).toBe(0);

    tracker.incrementSubrequests(100);
    expect(tracker.remainingSafeBudget()).toBe(0);
  });

  it('agrees with isNearLimit at the same threshold', () => {
    const tracker = new TokenTracker();
    // Near-limit / zero-safe-budget threshold is MAX_SUBREQUESTS (50) - SAFE_MARGIN (25) = 25.
    tracker.incrementSubrequests(24);
    expect(tracker.isNearLimit()).toBe(false);
    expect(tracker.remainingSafeBudget()).toBeGreaterThan(0);

    tracker.incrementSubrequests(1);
    expect(tracker.isNearLimit()).toBe(true);
    expect(tracker.remainingSafeBudget()).toBe(0);
  });
});

// A failed model call still put a full prompt on the wire, but record() only ever ran after a
// success -- so every 429'd and retried send was invisible to token accounting and telemetry, and
// the reported input total understated what the review actually cost.
describe('TokenTracker wasted-attempt accounting', () => {
  it('counts failed attempts by reason without touching billed usage', () => {
    const tracker = new TokenTracker();
    tracker.record('google:m', 1000, 200);
    tracker.recordFailedAttempt('google:m', 3000, 'rate-limited');
    tracker.recordFailedAttempt('google:m', 3000, 'error');
    tracker.recordFailedAttempt('google:m', 3000, 'rate-limited');

    // Estimates must never leak into the billed figures.
    expect(tracker.getTotalUsage()).toEqual({ input: 1000, output: 200 });
    expect(tracker.getBreakdown()).toHaveLength(1);

    expect(tracker.getWasted()).toEqual({
      attempts: 3,
      estimatedInput: 9000,
      skips: 0,
      byReason: { 'rate-limited': 2, error: 1 },
    });
  });

  it('counts skipped calls separately -- the signal that the cool-off gates are working', () => {
    const tracker = new TokenTracker();
    tracker.recordSkippedCall('google:m', 'cooling off for another 42s');
    tracker.recordSkippedCall('google:m', 'cooling off for another 41s');

    const wasted = tracker.getWasted();
    expect(wasted.skips).toBe(2);
    // A skip sent no prompt, so it costs no estimated tokens.
    expect(wasted.attempts).toBe(0);
    expect(wasted.estimatedInput).toBe(0);
  });

  it('carries wasted counters through merge, so a per-chunk tracker rolls up', () => {
    const parent = new TokenTracker();
    parent.recordFailedAttempt('google:m', 1000, 'error');
    parent.recordSkippedCall('google:m', 'cooling off');

    const child = new TokenTracker();
    child.record('google:m', 500, 100);
    child.recordFailedAttempt('google:m', 2000, 'rate-limited');
    child.recordFailedAttempt('google:m', 2000, 'error');
    child.recordSkippedCall('google:m', 'cooling off');

    parent.merge(child);

    expect(parent.getTotalUsage()).toEqual({ input: 500, output: 100 });
    expect(parent.getWasted()).toEqual({
      attempts: 3,
      estimatedInput: 5000,
      skips: 2,
      byReason: { error: 2, 'rate-limited': 1 },
    });
  });

  it('clears wasted counters on reset alongside usage', () => {
    const tracker = new TokenTracker();
    tracker.record('google:m', 100, 10);
    tracker.recordFailedAttempt('google:m', 1000, 'error');
    tracker.recordSkippedCall('google:m', 'cooling off');

    tracker.reset();

    expect(tracker.getTotalUsage()).toEqual({ input: 0, output: 0 });
    expect(tracker.getWasted()).toEqual({ attempts: 0, estimatedInput: 0, skips: 0, byReason: {} });
  });
});
