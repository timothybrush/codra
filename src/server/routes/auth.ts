import { Hono } from 'hono';
import type { AppEnv } from '@server/env';
import { createOAuthState, consumeOAuthState, parseAllowedUsers } from '@server/core/oauth';
import { createSession, destroySession } from '@server/core/sessions';
import { exchangeGitHubOAuthCode, fetchGitHubOAuthProfile, toDashboardSessionUser } from '@server/core/github/oauth';
import { upsertAccountSettings } from '@server/db/accounts';
import { logger } from '@server/core/logger';

function redirectToLogin(reason: string) {
  const params = new URLSearchParams({ error: reason });
  return `/login?${params.toString()}`;
}

export function createAuthRouter() {
  const app = new Hono<AppEnv>();

  app.get('/github', async (c) => {
    const state = await createOAuthState(c.env);
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', c.env.AUTH_CALLBACK_URL);
    url.searchParams.set('scope', 'read:user');
    url.searchParams.set('state', state);

    return c.redirect(url.toString(), 302);
  });

  app.get('/github/callback', async (c) => {
    const error = c.req.query('error');
    if (error) {
      return c.redirect(redirectToLogin(error), 302);
    }

    const code = c.req.query('code')?.trim();
    const state = c.req.query('state')?.trim();
    if (!code || !state) {
      return c.redirect(redirectToLogin('invalid_callback'), 302);
    }

    const stateMatches = await consumeOAuthState(c.env, state);
    if (!stateMatches) {
      return c.redirect(redirectToLogin('invalid_state'), 302);
    }

    try {
      const token = await exchangeGitHubOAuthCode(c.env, code);
      const profile = await fetchGitHubOAuthProfile(token);
      const allowedUsers = parseAllowedUsers(c.env.DASHBOARD_ALLOWED_USERS);

      if (!allowedUsers.has(profile.login.toLowerCase())) {
        return c.redirect(redirectToLogin('not_allowed'), 302);
      }

      await destroySession(c);
      await createSession(c, toDashboardSessionUser(profile));

      // Best-effort: a DB hiccup must not block sign-in (the account page self-heals on next load).
      try {
        await upsertAccountSettings(c.env, {
          githubUserId: profile.id,
          githubUsername: profile.login,
          accountName: profile.name,
          accountEmail: profile.email,
        });
      } catch (err) {
        logger.warn('Failed to persist account settings on sign-in', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return c.redirect('/dashboard', 302);
    } catch {
      return c.redirect(redirectToLogin('oauth_failed'), 302);
    }
  });

  app.post('/logout', async (c) => {
    await destroySession(c);
    return c.json({ ok: true });
  });

  return app;
}
