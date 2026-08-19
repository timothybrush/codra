import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ApiEnv } from './ports';
import { requireSession } from './middleware/auth';
import { requireCsrfHeader } from './middleware/csrf';
import { observability } from './middleware/observability';
import { createAuthRouter } from './routes/auth';
import { createWebhookRouter } from './routes/webhook';
import { createAuthApiRouter } from './routes/api/auth';
import { createJobsRouter } from './routes/api/jobs';
import { createReposRouter } from './routes/api/repos';
import { createStatsRouter } from './routes/api/stats';
import { createModelsRouter } from './routes/api/models';
import { createSettingsRouter } from './routes/api/settings';

async function serveIndex(c: Context<ApiEnv>) {
  // If the host platform passes an ASSETS binding via `c.env`, use it (e.g., Cloudflare Workers).
  const assets = (c.env as any).ASSETS;
  if (assets && typeof assets.fetch === 'function') {
    // Method call, and `/` not `/index.html`: detaching throws, and `/index.html` 307s into a loop.
    return assets.fetch(new Request(new URL('/', c.req.url), c.req.raw));
  }

  return c.text('Not Found: Please mount UI static assets handler here.', 404);
}

export function createApiRouter() {
  const app = new Hono<ApiEnv>();

  app.use('*', observability);
  app.use('/auth/logout', requireSession);
  app.use('/auth/logout', requireCsrfHeader);

  app.route('/auth', createAuthRouter());
  app.route('/webhook', createWebhookRouter());

  app.use('/api/*', requireSession);
  app.use('/api/*', requireCsrfHeader);

  app.route('/api/auth', createAuthApiRouter());
  app.route('/api/jobs', createJobsRouter());
  app.route('/api/repos', createReposRouter());
  app.route('/api/stats', createStatsRouter());
  app.route('/api/models', createModelsRouter());
  app.route('/api/settings', createSettingsRouter());

  app.get('/login', serveIndex);
  app.get('/', serveIndex); // Unauthenticated landing page
  app.get('/dashboard', requireSession, serveIndex);
  app.get('/jobs', requireSession, serveIndex);
  app.get('/jobs/*', requireSession, serveIndex);
  app.get('/repos', requireSession, serveIndex);
  app.get('/stats', requireSession, serveIndex);
  app.get('/health', requireSession, serveIndex);
  app.get('/settings', requireSession, serveIndex);
  app.get('/account', requireSession, serveIndex);

  return app;
}
