import { describe, expect, it } from 'vitest';
import { ModelChainProgressStore } from '@codraoss/models';

// KV double tracks overlapping puts (KV lacks ordering; late puts with less state can revert progress).
function makeKV() {
  let value: string | null = null;
  let inFlight = 0;
  let maxInFlight = 0;
  const writes: string[] = [];

  return {
    kv: {
      async get(_key: string, type?: string) {
        if (value === null) return null;
        return type === 'json' ? JSON.parse(value) : value;
      },
      async put(_key: string, body: string) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        writes.push(body);
        // Two ticks ensure overlapping puts genuinely overlap.
        await Promise.resolve();
        await Promise.resolve();
        value = body;
        inFlight -= 1;
      },
    },
    get maxInFlight() {
      return maxInFlight;
    },
    get stored() {
      return value === null ? null : JSON.parse(value) as {
        files?: Record<string, number>;
        timeouts?: Record<string, number>;
        cooldowns?: Record<string, { until?: number; limitTokens?: number }>;
      };
    },
    writes,
  };
}

describe('ModelChainProgressStore', () => {
  it('keeps both entries when two files defer concurrently', async () => {
    const kv = makeKV();
    const store = new ModelChainProgressStore(kv.kv, 'job-race');

    await Promise.all([store.advance('src/a.ts', 2), store.advance('src/b.ts', 3)]);

    // Order irrelevance: non-overlapping puts ensure the last one is the most complete.
    expect(kv.maxInFlight).toBe(1);
    expect(kv.stored?.files).toEqual({ 'src/a.ts': 2, 'src/b.ts': 3 });
    expect(await store.startIndexFor('src/a.ts')).toBe(2);
    expect(await store.startIndexFor('src/b.ts')).toBe(3);
  });

  it('coalesces a burst of deferrals instead of writing once per file', async () => {
    const kv = makeKV();
    const store = new ModelChainProgressStore(kv.kv, 'job-burst');

    await Promise.all([1, 2, 3, 4, 5, 6].map((n) => store.advance(`src/f${n}.ts`, n)));

    expect(kv.maxInFlight).toBe(1);
    // Six advances but fewer writes; conserves subrequests.
    expect(kv.writes.length).toBeLessThan(6);
    expect(Object.keys(kv.stored?.files ?? {})).toHaveLength(6);
  });

  it('merges with progress another invocation stored, rather than overwriting it', async () => {
    const kv = makeKV();
    // Written by a concurrent, unloaded invocation.
    await kv.kv.put('k', JSON.stringify({ 'src/other.ts': 4 }));

    const store = new ModelChainProgressStore(kv.kv, 'job-merge');
    await store.advance('src/mine.ts', 1);

    expect(kv.stored?.files).toEqual({ 'src/other.ts': 4, 'src/mine.ts': 1 });
  });

  it('never walks an index backwards', async () => {
    const kv = makeKV();
    const store = new ModelChainProgressStore(kv.kv, 'job-monotonic');

    await store.advance('src/a.ts', 3);
    // Later, shorter deferral must not resurrect ruled-out models.
    await store.advance('src/a.ts', 1);

    expect(kv.stored?.files).toEqual({ 'src/a.ts': 3 });
    expect(await store.startIndexFor('src/a.ts')).toBe(3);
  });

  // Persisted tally lets the next concurrent wave avoid models the first wave timed out on.
  it('drops a model after a full wave of timeouts, and remembers across invocations', async () => {
    const kv = makeKV();
    const store = new ModelChainProgressStore(kv.kv, 'job-slow');

    expect(await store.isTimingOut('vertex-ai:gemini-2.5-pro')).toBe(false);
    await store.noteTimeout('vertex-ai:gemini-2.5-pro');
    await store.noteTimeout('vertex-ai:gemini-2.5-pro');
    // Judged on a round, not a single slow call.
    expect(await store.isTimingOut('vertex-ai:gemini-2.5-pro')).toBe(false);
    await store.noteTimeout('vertex-ai:gemini-2.5-pro');
    expect(await store.isTimingOut('vertex-ai:gemini-2.5-pro')).toBe(true);

    // Fresh store mimics next invocation.
    const next = new ModelChainProgressStore(kv.kv, 'job-slow');
    expect(await next.isTimingOut('vertex-ai:gemini-2.5-pro')).toBe(true);
    // Scoped to the failing model.
    expect(await next.isTimingOut('vertex-ai:gemini-2.5-flash')).toBe(false);
  });

  // Tail candidates use a higher strike threshold rather than exemption, to prevent infinite looping.
  it('holds the last candidate to a higher strike count before dropping it too', async () => {
    const kv = makeKV();
    const store = new ModelChainProgressStore(kv.kv, 'job-tail');

    for (let i = 0; i < 3; i += 1) await store.noteTimeout('cf:glm-4.7-flash');
    // Drops mid-chain, but preserves the tail.
    expect(await store.isTimingOut('cf:glm-4.7-flash')).toBe(true);
    expect(await store.isTimingOutTerminally('cf:glm-4.7-flash')).toBe(false);

    for (let i = 0; i < 3; i += 1) await store.noteTimeout('cf:glm-4.7-flash');
    expect(await store.isTimingOutTerminally('cf:glm-4.7-flash')).toBe(true);

    // Durable across invocations.
    const next = new ModelChainProgressStore(kv.kv, 'job-tail');
    expect(await next.isTimingOutTerminally('cf:glm-4.7-flash')).toBe(true);
  });

  describe('noteSuccess', () => {
    // Resets prevent cumulative tallies from condemning a model for the job's entire 24h life.
    it('restarts the tally, so a slow patch cannot condemn a working model', async () => {
      const kv = makeKV();
      const store = new ModelChainProgressStore(kv.kv, 'job-recovered');

      for (let i = 0; i < 3; i += 1) await store.noteTimeout('vertex-ai:gemini-2.5-pro');
      expect(await store.isTimingOut('vertex-ai:gemini-2.5-pro')).toBe(true);

      await store.noteSuccess('vertex-ai:gemini-2.5-pro');
      expect(await store.isTimingOut('vertex-ai:gemini-2.5-pro')).toBe(false);
    });

    // writeOnce's max() merge must not resurrect pre-success counts from KV.
    it('survives the merge against what another invocation stored', async () => {
      const kv = makeKV();
      await kv.kv.put('k', JSON.stringify({ timeouts: { 'vertex-ai:gemini-2.5-pro': 5 } }));

      const store = new ModelChainProgressStore(kv.kv, 'job-merge-success');
      await store.noteSuccess('vertex-ai:gemini-2.5-pro');

      expect(kv.stored?.timeouts?.['vertex-ai:gemini-2.5-pro']).toBeUndefined();
      const next = new ModelChainProgressStore(kv.kv, 'job-merge-success');
      expect(await next.isTimingOut('vertex-ai:gemini-2.5-pro')).toBe(false);
    });

    it('writes nothing for a model with a clean record', async () => {
      const kv = makeKV();
      const store = new ModelChainProgressStore(kv.kv, 'job-clean');

      await store.noteSuccess('vertex-ai:gemini-2.5-pro');

      // Healthy paths don't incur KV writes to save subrequests.
      expect(kv.writes).toHaveLength(0);
    });
  });

  it('keeps chain progress and timeouts in one value without either clobbering the other', async () => {
    const kv = makeKV();
    const store = new ModelChainProgressStore(kv.kv, 'job-both');

    await Promise.all([store.advance('src/a.ts', 2), store.noteTimeout('vertex-ai:gemini-2.5-pro')]);

    const next = new ModelChainProgressStore(kv.kv, 'job-both');
    expect(await next.startIndexFor('src/a.ts')).toBe(2);
    await next.noteTimeout('vertex-ai:gemini-2.5-pro');
    await next.noteTimeout('vertex-ai:gemini-2.5-pro');
    expect(await next.isTimingOut('vertex-ai:gemini-2.5-pro')).toBe(true);
  });

  // Supports legacy in-flight bare label->index maps.
  it('reads the pre-timeouts stored shape without losing resume progress', async () => {
    const kv = makeKV();
    await kv.kv.put('k', JSON.stringify({ 'src/legacy.ts': 3 }));

    const store = new ModelChainProgressStore(kv.kv, 'job-legacy');

    expect(await store.startIndexFor('src/legacy.ts')).toBe(3);
    expect(await store.isTimingOut('anything')).toBe(false);
  });

  // Persisted rate-limits prevent continuation jobs from re-paying for known cool-offs.
  describe('rate-limit cool-offs', () => {
    it('carries a learned cool-off and bucket size to the next invocation', async () => {
      const kv = makeKV();
      const store = new ModelChainProgressStore(kv.kv, 'job-cooldown');
      const until = Date.now() + 30_000;

      store.noteRateLimit('google:gemini-2.5-flash', { cooldownUntil: until, limitTokens: 16000 });
      await store.flushPending();

      const next = new ModelChainProgressStore(kv.kv, 'job-cooldown');
      const loaded = await next.loadCooldowns();
      expect(loaded.get('google:gemini-2.5-flash')).toEqual({ cooldownUntil: until, limitTokens: 16000 });
      // Cool-offs scope per-model bucket.
      expect(loaded.has('google:gemini-2.5-flash-lite')).toBe(false);
    });

    it('does not write on note alone, so a 429 adds no subrequests on a path that had none', async () => {
      const kv = makeKV();
      const store = new ModelChainProgressStore(kv.kv, 'job-lazy');

      store.noteRateLimit('google:gemini-2.5-flash', { cooldownUntil: Date.now() + 30_000 });
      expect(kv.writes).toHaveLength(0);

      // Made durable by the subsequent deferral.
      await store.flushPending();
      expect(kv.writes.length).toBeGreaterThan(0);
    });

    it('takes the later deadline when two invocations both learned one', async () => {
      const kv = makeKV();
      const earlier = Date.now() + 10_000;
      const later = Date.now() + 90_000;
      await kv.kv.put('k', JSON.stringify({ cooldowns: { 'google:m': { until: later, limitTokens: 16000 } } }));

      const store = new ModelChainProgressStore(kv.kv, 'job-merge-cooldown');
      // Later 429s omitting limitTokens must not erase known buckets.
      store.noteRateLimit('google:m', { cooldownUntil: earlier });
      await store.flushPending();

      expect(kv.stored?.cooldowns?.['google:m']).toEqual({ until: later, limitTokens: 16000 });
    });

    // Protects against sticky, misparsed request counts crippling the model for 24h.
    it('discards a stored bucket too small to be a token quota', async () => {
      const kv = makeKV();
      const until = Date.now() + 30_000;
      await kv.kv.put('k', JSON.stringify({ cooldowns: { 'google:m': { until, limitTokens: 15 } } }));

      const store = new ModelChainProgressStore(kv.kv, 'job-poisoned-bucket');

      const entry = (await store.loadCooldowns()).get('google:m');
      // Retains valid cool-off while discarding nonsense bucket size.
      expect(entry?.cooldownUntil).toBe(until);
      expect(entry?.limitTokens).toBeUndefined();
    });

    it('clamps an implausible cool-off rather than disabling a model for the whole job', async () => {
      const kv = makeKV();
      // Prevents misparsed delays from disabling models indefinitely.
      await kv.kv.put('k', JSON.stringify({ cooldowns: { 'google:m': { until: Date.now() + 3_600_000 } } }));

      const store = new ModelChainProgressStore(kv.kv, 'job-clamp');

      const entry = (await store.loadCooldowns()).get('google:m');
      expect(entry!.cooldownUntil).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
    });

    // Bucket sizes outlive cool-offs to answer "can this prompt fit?".
    it('keeps an expired entry so its bucket size survives', async () => {
      const kv = makeKV();
      await kv.kv.put('k', JSON.stringify({ cooldowns: { 'google:m': { until: Date.now() - 60_000, limitTokens: 16000 } } }));

      const store = new ModelChainProgressStore(kv.kv, 'job-expired');

      expect((await store.loadCooldowns()).get('google:m')?.limitTokens).toBe(16000);
    });

    it('reads a blob written before cooldowns existed without losing resume progress', async () => {
      const kv = makeKV();
      await kv.kv.put('k', JSON.stringify({ files: { 'src/a.ts': 2 }, timeouts: { 'google:m': 1 } }));

      const store = new ModelChainProgressStore(kv.kv, 'job-old-shape');

      expect(await store.startIndexFor('src/a.ts')).toBe(2);
      expect((await store.loadCooldowns()).size).toBe(0);
    });

    it('keeps a cool-off noted before the KV read resolved', async () => {
      const kv = makeKV();
      await kv.kv.put('k', JSON.stringify({ files: { 'src/a.ts': 2 } }));

      const store = new ModelChainProgressStore(kv.kv, 'job-early-note');
      // Sync noteRateLimit can land before load(); must merge, not replace.
      store.noteRateLimit('google:m', { cooldownUntil: Date.now() + 30_000, limitTokens: 16000 });

      expect((await store.loadCooldowns()).get('google:m')?.limitTokens).toBe(16000);
      expect(await store.startIndexFor('src/a.ts')).toBe(2);
    });
  });

  it('does nothing at all without a jobId', async () => {
    const kv = makeKV();
    const store = new ModelChainProgressStore(kv.kv, undefined);

    await store.advance('src/a.ts', 2);

    expect(kv.writes).toHaveLength(0);
    expect(await store.startIndexFor('src/a.ts')).toBe(0);
  });
});
