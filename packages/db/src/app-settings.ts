import type { DbEnv } from './env';
import { queryRows } from './client';
import { reviewConcurrencyLevels, reviewMaxCommentsOptions, reviewMaxFilesRange, reviewSettingsSchema, type ReviewSettings } from '@codra/schema';

const CONCURRENCY_KEY = 'review_concurrency_level';
const MAX_COMMENTS_KEY = 'review_max_comments';
const MAX_FILES_KEY = 'review_max_files';

const DEFAULT_REVIEW_SETTINGS: ReviewSettings = reviewSettingsSchema.parse({});
const CONCURRENCY_LEVELS = new Set<string>(reviewConcurrencyLevels);
const MAX_COMMENTS_OPTIONS = new Set<number>(reviewMaxCommentsOptions);

export async function getReviewSettings(env: DbEnv): Promise<ReviewSettings> {
  try {
    const rows = await queryRows<{ key: string; value: string }>(
      env,
      'SELECT key, value FROM global_settings WHERE key = ANY($1)',
      [[CONCURRENCY_KEY, MAX_COMMENTS_KEY, MAX_FILES_KEY]],
    );
    const map = new Map(rows.map((row) => [row.key, row.value]));
    const storedConcurrency = map.get(CONCURRENCY_KEY);
    const storedMaxComments = map.get(MAX_COMMENTS_KEY);
    const storedMaxFiles = map.get(MAX_FILES_KEY);
    const parsedMaxComments = storedMaxComments === undefined ? NaN : Number(storedMaxComments);
    const parsedMaxFiles = storedMaxFiles === undefined ? NaN : Number(storedMaxFiles);

    return reviewSettingsSchema.parse({
      concurrencyLevel: storedConcurrency && CONCURRENCY_LEVELS.has(storedConcurrency)
        ? storedConcurrency
        : DEFAULT_REVIEW_SETTINGS.concurrencyLevel,
      maxComments: MAX_COMMENTS_OPTIONS.has(parsedMaxComments)
        ? parsedMaxComments
        : DEFAULT_REVIEW_SETTINGS.maxComments,
      // Unlike the other two this is a free numeric field, so clamp rather than fall back to the default.
      maxFiles: Number.isFinite(parsedMaxFiles)
        ? Math.min(reviewMaxFilesRange.max, Math.max(reviewMaxFilesRange.min, Math.trunc(parsedMaxFiles)))
        : DEFAULT_REVIEW_SETTINGS.maxFiles,
    });
  } catch (error) {
    console.warn('Failed to load review settings, using defaults', {
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_REVIEW_SETTINGS;
  }
}

export async function updateReviewSettings(env: DbEnv, settings: ReviewSettings): Promise<void> {
  await queryRows(
    env,
    `INSERT INTO global_settings (key, value) VALUES ($1, $2), ($3, $4), ($5, $6)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      CONCURRENCY_KEY, settings.concurrencyLevel,
      MAX_COMMENTS_KEY, String(settings.maxComments),
      MAX_FILES_KEY, String(settings.maxFiles),
    ],
  );
}
