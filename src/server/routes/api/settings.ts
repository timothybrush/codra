import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '@server/env';
import { getReviewSettings, updateReviewSettings } from '@codra/db/app-settings';
import { jsonError } from '@server/core/http';
import { reviewConcurrencyLevels, reviewMaxCommentsOptions, reviewMaxFilesRange, reviewSettingsSchema } from '@codra/schema';

const reviewSettingsPatchSchema = z.strictObject({
  concurrencyLevel: z.enum(reviewConcurrencyLevels).optional(),
  maxComments: z.number().int().refine(
    (value) => (reviewMaxCommentsOptions as readonly number[]).includes(value),
    'Invalid max comments value.',
  ).optional(),
  maxFiles: z.number().int().min(reviewMaxFilesRange.min).max(reviewMaxFilesRange.max).optional(),
}).refine(
  (settings) => Object.values(settings).some((value) => value !== undefined),
  'At least one setting must be provided.',
);

export function createSettingsRouter() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const settings = await getReviewSettings(c.env);
    return c.json({ settings });
  });

  app.patch('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = reviewSettingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError('Invalid review settings.', 400);
    }

    const current = await getReviewSettings(c.env);
    const next = reviewSettingsSchema.parse({ ...current, ...parsed.data });
    await updateReviewSettings(c.env, next);
    return c.json({ ok: true, settings: next });
  });

  return app;
}
