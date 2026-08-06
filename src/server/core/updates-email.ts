import type { AppBindings } from '@server/env';

const EMAILS_API_URL = 'https://codra.run/api/emails';

type UpdatesEmailRecord = {
  status: 'subscribed';
  email: string;
  updatedAt: string;
};

function updatesEmailKey(githubUserId: number) {
  return `updates-email:${githubUserId}`;
}

export async function getUpdatesEmailPreference(
  env: Pick<AppBindings, 'APP_KV'>,
  githubUserId: number,
) {
  return await env.APP_KV.get(updatesEmailKey(githubUserId), 'json') as UpdatesEmailRecord | null;
}

async function hasUpdatesEmailPreference(
  env: Pick<AppBindings, 'APP_KV'>,
  githubUserId: number,
) {
  return Boolean(await getUpdatesEmailPreference(env, githubUserId));
}

export async function syncUpdatesEmail(
  env: Pick<AppBindings, 'APP_KV'>,
  githubUserId: number,
  email: string | null | undefined,
) {
  if (!email) return false;

  if (await hasUpdatesEmailPreference(env, githubUserId)) return false;

  const response = await fetch(EMAILS_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });

  if (!response.ok) return false;

  const record: UpdatesEmailRecord = {
    status: 'subscribed',
    email,
    updatedAt: new Date().toISOString(),
  };
  await env.APP_KV.put(updatesEmailKey(githubUserId), JSON.stringify(record));

  return true;
}
