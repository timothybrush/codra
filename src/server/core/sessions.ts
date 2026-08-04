import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { AppEnv, DashboardSessionUser } from '@server/env';

const SESSION_COOKIE_NAME = 'codra_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

type SessionRecord = DashboardSessionUser;

function randomHex(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sessionKey(token: string) {
  return `session:${token}`;
}

export async function createSession(c: Context<AppEnv>, session: SessionRecord) {
  const token = randomHex();

  await c.env.APP_KV.put(sessionKey(token), JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: true,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });

  c.set('sessionToken', token);
  c.set('sessionUser', session);

  return token;
}

export async function destroySession(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE_NAME);
  if (token) {
    await c.env.APP_KV.delete(sessionKey(token));
  }

  c.set('sessionToken', null);
  c.set('sessionUser', null);

  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: '/',
  });
}

export async function readSession(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE_NAME) ?? null;
  c.set('sessionToken', token);

  if (!token) {
    c.set('sessionUser', null);
    return null;
  }

  const session = await c.env.APP_KV.get(sessionKey(token), 'json') as SessionRecord | null;
  c.set('sessionUser', session);
  return session;
}
