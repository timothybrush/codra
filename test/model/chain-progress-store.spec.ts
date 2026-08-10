import { describe, expect, it } from 'vitest';
import { ModelChainProgressStore } from '@server/services/model';

// A KV double that settles its own puts after a tick and records how many were ever in flight at
// once. Overlapping puts are the hazard: KV has no ordering guarantee, so if the put carrying LESS
// state lands second, the other file's progress is gone and it replays a model already ruled out.
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
        // Two ticks, so an overlapping put would genuinely overlap rather than serialize by luck.
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
    const store = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-race');

    await Promise.all([store.advance('src/a.ts', 2), store.advance('src/b.ts', 3)]);

    // The property that makes ordering irrelevant: puts never overlap, so the last one written is
    // also the most complete one.
    expect(kv.maxInFlight).toBe(1);
    expect(kv.stored?.files).toEqual({ 'src/a.ts': 2, 'src/b.ts': 3 });
    expect(await store.startIndexFor('src/a.ts')).toBe(2);
    expect(await store.startIndexFor('src/b.ts')).toBe(3);
  });

  it('coalesces a burst of deferrals instead of writing once per file', async () => {
    const kv = makeKV();
    const store = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-burst');

    await Promise.all([1, 2, 3, 4, 5, 6].map((n) => store.advance(`src/f${n}.ts`, n)));

    expect(kv.maxInFlight).toBe(1);
    // Six advances, far fewer writes: subrequests are the scarce resource this memo protects.
    expect(kv.writes.length).toBeLessThan(6);
    expect(Object.keys(kv.stored?.files ?? {})).toHaveLength(6);
  });

  it('merges with progress another invocation stored, rather than overwriting it', async () => {
    const kv = makeKV();
    // Written by a concurrent invocation this store never loaded.
    await kv.kv.put('k', JSON.stringify({ 'src/other.ts': 4 }));

    const store = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-merge');
    await store.advance('src/mine.ts', 1);

    expect(kv.stored?.files).toEqual({ 'src/other.ts': 4, 'src/mine.ts': 1 });
  });

  it('never walks an index backwards', async () => {
    const kv = makeKV();
    const store = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-monotonic');

    await store.advance('src/a.ts', 3);
    // A later deferral that got less far must not un-skip models already ruled out.
    await store.advance('src/a.ts', 1);

    expect(kv.stored?.files).toEqual({ 'src/a.ts': 3 });
    expect(await store.startIndexFor('src/a.ts')).toBe(3);
  });

  // A chunk dispatches its units concurrently, so a whole wave times out on the same model before
  // any of them can react. Only a persisted tally lets the NEXT wave stop paying for it.
  it('drops a model after a full wave of timeouts, and remembers across invocations', async () => {
    const kv = makeKV();
    const store = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-slow');

    expect(await store.isTimingOut('vertex-ai:gemini-2.5-pro')).toBe(false);
    await store.noteTimeout('vertex-ai:gemini-2.5-pro');
    await store.noteTimeout('vertex-ai:gemini-2.5-pro');
    // Two is one wave short: judged on a round, not on a single slow call.
    expect(await store.isTimingOut('vertex-ai:gemini-2.5-pro')).toBe(false);
    await store.noteTimeout('vertex-ai:gemini-2.5-pro');
    expect(await store.isTimingOut('vertex-ai:gemini-2.5-pro')).toBe(true);

    // A fresh store stands in for the next invocation, reading the tally back out of KV.
    const next = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-slow');
    expect(await next.isTimingOut('vertex-ai:gemini-2.5-pro')).toBe(true);
    // Scoped to the model that actually timed out.
    expect(await next.isTimingOut('vertex-ai:gemini-2.5-flash')).toBe(false);
  });

  it('keeps chain progress and timeouts in one value without either clobbering the other', async () => {
    const kv = makeKV();
    const store = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-both');

    await Promise.all([store.advance('src/a.ts', 2), store.noteTimeout('vertex-ai:gemini-2.5-pro')]);

    const next = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-both');
    expect(await next.startIndexFor('src/a.ts')).toBe(2);
    await next.noteTimeout('vertex-ai:gemini-2.5-pro');
    await next.noteTimeout('vertex-ai:gemini-2.5-pro');
    expect(await next.isTimingOut('vertex-ai:gemini-2.5-pro')).toBe(true);
  });

  // Jobs already in flight when this deploys have the old bare label->index map stored.
  it('reads the pre-timeouts stored shape without losing resume progress', async () => {
    const kv = makeKV();
    await kv.kv.put('k', JSON.stringify({ 'src/legacy.ts': 3 }));

    const store = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-legacy');

    expect(await store.startIndexFor('src/legacy.ts')).toBe(3);
    expect(await store.isTimingOut('anything')).toBe(false);
  });

  // Without persistence ModelRateLimitBook is invocation-scoped, so every job continuation re-paid a
  // full-prompt 429 to re-learn a cool-off the previous invocation had already been told about.
  describe('rate-limit cool-offs', () => {
    it('carries a learned cool-off and bucket size to the next invocation', async () => {
      const kv = makeKV();
      const store = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-cooldown');
      const until = Date.now() + 30_000;

      store.noteRateLimit('google:gemini-2.5-flash', { cooldownUntil: until, limitTokens: 16000 });
      await store.flushPending();

      const next = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-cooldown');
      const loaded = await next.loadCooldowns();
      expect(loaded.get('google:gemini-2.5-flash')).toEqual({ cooldownUntil: until, limitTokens: 16000 });
      // Scoped to the model that actually 429'd: each Gemini model has its own per-minute bucket.
      expect(loaded.has('google:gemini-2.5-flash-lite')).toBe(false);
    });

    it('does not write on note alone, so a 429 adds no subrequests on a path that had none', async () => {
      const kv = makeKV();
      const store = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-lazy');

      store.noteRateLimit('google:gemini-2.5-flash', { cooldownUntil: Date.now() + 30_000 });
      expect(kv.writes).toHaveLength(0);

      // The deferral that follows is what makes it durable.
      await store.flushPending();
      expect(kv.writes.length).toBeGreaterThan(0);
    });

    it('takes the later deadline when two invocations both learned one', async () => {
      const kv = makeKV();
      const earlier = Date.now() + 10_000;
      const later = Date.now() + 90_000;
      await kv.kv.put('k', JSON.stringify({ cooldowns: { 'google:m': { until: later, limitTokens: 16000 } } }));

      const store = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-merge-cooldown');
      // Omits limitTokens on purpose: a later 429 that doesn't restate the bucket must not erase it.
      store.noteRateLimit('google:m', { cooldownUntil: earlier });
      await store.flushPending();

      expect(kv.stored?.cooldowns?.['google:m']).toEqual({ until: later, limitTokens: 16000 });
    });

    it('clamps an implausible cool-off rather than disabling a model for the whole job', async () => {
      const kv = makeKV();
      // A mis-parsed "retry in 3600s" would otherwise pin this model out for the job's 24h lifetime.
      await kv.kv.put('k', JSON.stringify({ cooldowns: { 'google:m': { until: Date.now() + 3_600_000 } } }));

      const store = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-clamp');

      const entry = (await store.loadCooldowns()).get('google:m');
      expect(entry!.cooldownUntil).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
    });

    // The bucket size outlives the cool-off: it still answers "can this prompt ever fit?".
    it('keeps an expired entry so its bucket size survives', async () => {
      const kv = makeKV();
      await kv.kv.put('k', JSON.stringify({ cooldowns: { 'google:m': { until: Date.now() - 60_000, limitTokens: 16000 } } }));

      const store = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-expired');

      expect((await store.loadCooldowns()).get('google:m')?.limitTokens).toBe(16000);
    });

    it('reads a blob written before cooldowns existed without losing resume progress', async () => {
      const kv = makeKV();
      await kv.kv.put('k', JSON.stringify({ files: { 'src/a.ts': 2 }, timeouts: { 'google:m': 1 } }));

      const store = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-old-shape');

      expect(await store.startIndexFor('src/a.ts')).toBe(2);
      expect((await store.loadCooldowns()).size).toBe(0);
    });

    it('keeps a cool-off noted before the KV read resolved', async () => {
      const kv = makeKV();
      await kv.kv.put('k', JSON.stringify({ files: { 'src/a.ts': 2 } }));

      const store = new ModelChainProgressStore({ APP_KV: kv.kv } as never, 'job-early-note');
      // noteRateLimit is sync and can land first; load() must merge into it, not replace it.
      store.noteRateLimit('google:m', { cooldownUntil: Date.now() + 30_000, limitTokens: 16000 });

      expect((await store.loadCooldowns()).get('google:m')?.limitTokens).toBe(16000);
      expect(await store.startIndexFor('src/a.ts')).toBe(2);
    });
  });

  it('does nothing at all without a jobId', async () => {
    const kv = makeKV();
    const store = new ModelChainProgressStore({ APP_KV: kv.kv } as never, undefined);

    await store.advance('src/a.ts', 2);

    expect(kv.writes).toHaveLength(0);
    expect(await store.startIndexFor('src/a.ts')).toBe(0);
  });
});
