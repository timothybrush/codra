import { Hono } from 'hono';
import type { AppEnv } from '@server/env';
import { getStats } from '@server/db/stats';

export function createStatsRouter() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const daysParam = c.req.query('days');
    const days = daysParam ? parseInt(daysParam, 10) : 30;
    // Grouped in the caller's display zone so the trend matches timestamps shown elsewhere; getStats falls back to UTC if invalid.
    const timeZone = c.req.query('tz') ?? 'UTC';
    const stats = await getStats(c.env, days, timeZone);
    return c.json({ stats });
  });

  return app;
}
