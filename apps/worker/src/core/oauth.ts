import { randomHex } from '@codraoss/schema/hex';
import type { AppBindings } from '../env';

const OAUTH_STATE_TTL_SECONDS = 60 * 10;

function oauthStateKey(state: string) {
  return `oauth-state:${state}`;
}

export function parseAllowedUsers(input: string) {
  return new Set(
    input
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function createOAuthState(env: Pick<AppBindings, 'APP_KV'>) {
  const state = randomHex();
  await env.APP_KV.put(
    oauthStateKey(state),
    JSON.stringify({ createdAt: new Date().toISOString() }),
    { expirationTtl: OAUTH_STATE_TTL_SECONDS },
  );
  return state;
}

export async function consumeOAuthState(env: Pick<AppBindings, 'APP_KV'>, state: string) {
  const key = oauthStateKey(state);
  const value = await env.APP_KV.get(key);
  if (!value) {
    return false;
  }

  await env.APP_KV.delete(key);
  return true;
}
