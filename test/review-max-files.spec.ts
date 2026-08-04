import { describe, expect, it } from 'vitest';
import { createTestEnv, dbDescribe } from './helpers';
import { runWithDb, queryRows } from '@server/db/client';
import { getReviewSettings, updateReviewSettings } from '@server/db/app-settings';
import { defaultRepoConfig, reviewMaxFilesRange, reviewSettingsSchema } from '@shared/schema';


describe('review max files settings', () => {
  it('defaults to 200', () => {
    expect(reviewSettingsSchema.parse({}).maxFiles).toBe(200);
    expect(reviewMaxFilesRange.default).toBe(200);
  });

  it('accepts the full configured range', () => {
    expect(reviewSettingsSchema.parse({ maxFiles: reviewMaxFilesRange.min }).maxFiles).toBe(1);
    expect(reviewSettingsSchema.parse({ maxFiles: reviewMaxFilesRange.max }).maxFiles).toBe(500);
  });

  it('rejects values outside the range', () => {
    expect(() => reviewSettingsSchema.parse({ maxFiles: 0 })).toThrow();
    expect(() => reviewSettingsSchema.parse({ maxFiles: 501 })).toThrow();
    expect(() => reviewSettingsSchema.parse({ maxFiles: 12.5 })).toThrow();
  });

  // It moved to global_settings; leaving it on the repo schema would let a stale per-repo value
  // look authoritative while having no effect.
  it('is no longer part of the per-repo config', () => {
    expect('max_files' in defaultRepoConfig.review).toBe(false);
  });

  it('ignores a stale max_files key left in a stored repo config', () => {
    const parsed = defaultRepoConfig;
    expect(parsed.review).not.toHaveProperty('max_files');
  });
});

dbDescribe('review max files persistence', () => {
  const env = createTestEnv();

  it('round-trips through global_settings', async () => {
    await runWithDb(env, async () => {
      const original = await getReviewSettings(env);
      try {
        await updateReviewSettings(env, { ...original, maxFiles: 275 });
        expect((await getReviewSettings(env)).maxFiles).toBe(275);
      } finally {
        await updateReviewSettings(env, original);
      }
    });
  });

  // A free numeric field is clamped rather than discarded: a stored value outside the range
  // should be pulled into it, not silently replaced by the default.
  it('clamps an out-of-range stored value instead of falling back to the default', async () => {
    await runWithDb(env, async () => {
      const original = await getReviewSettings(env);
      try {
        await queryRows(
          env,
          `INSERT INTO global_settings (key, value) VALUES ('review_max_files', '9999')
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        );
        expect((await getReviewSettings(env)).maxFiles).toBe(reviewMaxFilesRange.max);

        await queryRows(
          env,
          `UPDATE global_settings SET value = 'not-a-number' WHERE key = 'review_max_files'`,
        );
        expect((await getReviewSettings(env)).maxFiles).toBe(reviewMaxFilesRange.default);
      } finally {
        await updateReviewSettings(env, original);
      }
    });
  });
});
