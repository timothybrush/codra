import { Hono } from 'hono';
import { z } from 'zod';
import { jsonError } from '@server/core/http';
import { getUpdatesEmailPreference, syncUpdatesEmail } from '@server/core/updates-email';
import { getAccountSettings, updateAccountSettings, upsertAccountSettings } from '@server/db/accounts';
import type { AppEnv } from '@server/env';

const emailSchema = z.object({
  email: z.string().trim().email().max(254),
}).strict();

/**
 * Both fields are optional so the client can PATCH either independently, but at
 * least one must be present. `timezone: null` means "follow the browser"; a string
 * must be a zone the runtime's Intl actually knows, so we never persist a value
 * that would later throw at format time.
 */
const accountUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().min(1).max(64).refine(isSupportedTimeZone, {
    message: 'Unknown time zone.',
  }).nullable().optional(),
}).strict().refine(
  (body) => body.name !== undefined || body.timezone !== undefined,
  { message: 'Nothing to update.' },
);

function isSupportedTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function createAuthApiRouter() {
  const app = new Hono<AppEnv>();

  app.get('/session', async (c) => {
    const sessionUser = c.get('sessionUser');
    if (!sessionUser) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return c.json({ user: sessionUser });
  });

  app.get('/account', async (c) => {
    const sessionUser = c.get('sessionUser');
    if (!sessionUser) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Return the durable record, self-healing for sessions created before the
    // account_settings table existed (or before this feature shipped).
    let account = await getAccountSettings(c.env, sessionUser.githubUserId);
    if (!account) {
      account = await upsertAccountSettings(c.env, {
        githubUserId: sessionUser.githubUserId,
        githubUsername: sessionUser.login,
        accountName: sessionUser.name,
        accountEmail: sessionUser.email,
      });
    }

    return c.json({ account });
  });

  app.patch('/account', async (c) => {
    const sessionUser = c.get('sessionUser');
    if (!sessionUser) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await c.req.json().catch(() => null);
    const parsed = accountUpdateSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message;
      return jsonError(
        issue && issue !== 'Invalid input' ? issue : 'Enter a name (1–120 characters).',
        400,
      );
    }

    // Ensure a row exists first (self-heal for pre-existing sessions), then update.
    const existing = await getAccountSettings(c.env, sessionUser.githubUserId);
    if (!existing) {
      await upsertAccountSettings(c.env, {
        githubUserId: sessionUser.githubUserId,
        githubUsername: sessionUser.login,
        accountName: sessionUser.name,
        accountEmail: sessionUser.email,
      });
    }

    const account = await updateAccountSettings(c.env, sessionUser.githubUserId, {
      accountName: parsed.data.name,
      timezone: parsed.data.timezone,
    });
    return c.json({ account });
  });

  app.get('/updates-email', async (c) => {
    const sessionUser = c.get('sessionUser');
    if (!sessionUser) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const preference = await getUpdatesEmailPreference(c.env, sessionUser.githubUserId);
    return c.json({
      status: preference?.status ?? 'pending',
      email: preference?.email ?? null,
      updatedAt: preference?.updatedAt ?? null,
    });
  });

  app.post('/updates-email', async (c) => {
    const sessionUser = c.get('sessionUser');
    if (!sessionUser) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await c.req.json().catch(() => null);
    const parsed = emailSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError('Enter a valid email address.', 400);
    }

    const existingPreference = await getUpdatesEmailPreference(c.env, sessionUser.githubUserId);
    if (existingPreference) {
      return c.json({
        status: existingPreference.status,
        email: existingPreference.email,
        updatedAt: existingPreference.updatedAt,
      });
    }

    const synced = await syncUpdatesEmail(c.env, sessionUser.githubUserId, parsed.data.email);
    if (!synced) {
      return jsonError('Could not save updates email right now.', 502);
    }

    const preference = await getUpdatesEmailPreference(c.env, sessionUser.githubUserId);

    return c.json({
      status: preference?.status ?? 'pending',
      email: preference?.email ?? null,
      updatedAt: preference?.updatedAt ?? null,
    });
  });

  return app;
}
