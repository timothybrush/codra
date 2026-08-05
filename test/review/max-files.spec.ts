import { describe, expect, it } from 'vitest';

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

});
