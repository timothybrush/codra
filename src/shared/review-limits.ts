// Zod-free by design: the client imports these runtime values directly from this module, not from
// @shared/schema, which drags in the whole zod dependency chain (including the side-effecting
// `repoConfigSchema.parse({})` at module load) the moment any single export is touched.

export const reviewSeverities = ['P0', 'P1', 'P2', 'P3', 'nit'] as const;

export const reviewConcurrencyLevels = ['low', 'medium', 'high', 'max'] as const;
export type ReviewConcurrencyLevel = typeof reviewConcurrencyLevels[number];

// Instance-wide, not per-repo: bounds the Workers subrequest budget and provider rate limit, both
// shared across every repository.
export const REVIEW_CONCURRENCY_LIMITS: Record<ReviewConcurrencyLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  max: 4,
};

export const reviewMaxCommentsOptions = [5, 10, 15, 20] as const;

export const reviewMaxFilesRange = { min: 1, max: 500, default: 200 } as const;
