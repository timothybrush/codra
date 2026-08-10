import type { AppBindings } from '@server/env';
import { withTimeout } from '@server/core/timeout';
import { GitHubError, GITHUB_TIMEOUT_MS, installationCacheKey, withRetry } from './http';
import type { GitHubAppRecord, GitHubInstallation, InstallationTokenCacheRecord } from './types';

// Sibling of core/github.ts -- import from that barrel, not from here.

const GITHUB_APP_INSTALL_URL_CACHE_KEY = 'github:app_installation_url';

type AppAuthEnv = Pick<AppBindings, 'APP_PRIVATE_KEY' | 'GITHUB_APP_ID' | 'BOT_USERNAME'>;

function pemToArrayBuffer(pem: string) {
  const base64 = pem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
    // Handles literal \n escape sequences from wrangler secrets stored as single-line strings.
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function base64UrlEncode(input: string) {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function createGitHubJwt(appId: string, privateKeyPem: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  );

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  const signatureString = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  return `${header}.${payload}.${signatureString}`;
}

// Headers for the three app-level (JWT-authenticated) endpoints, as opposed to installation-token requests.
async function appJwtHeaders(env: AppAuthEnv) {
  const jwt = await createGitHubJwt(env.GITHUB_APP_ID, env.APP_PRIVATE_KEY);
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${jwt}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': env.BOT_USERNAME ?? 'codra-bot',
  };
}

export function normalizeGitHubAppSlug(slug: string | undefined) {
  const normalized = slug?.trim().replace(/\[bot\]$/i, '');
  return normalized || null;
}

function installUrlFromSlug(slug: string) {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

export async function readCachedInstallationToken(
  env: Pick<AppBindings, 'APP_KV'>,
  installationId: string,
  tracker?: { incrementSubrequests(count?: number): void },
) {
  if (tracker) tracker.incrementSubrequests(1);
  const cached = await env.APP_KV.get(installationCacheKey(installationId), 'json');
  return cached as InstallationTokenCacheRecord | null;
}

export async function writeCachedInstallationToken(
  env: Pick<AppBindings, 'APP_KV'>,
  installationId: string,
  record: InstallationTokenCacheRecord,
  tracker?: { incrementSubrequests(count?: number): void },
) {
  const expiresAt = new Date(record.expiresAt).getTime();
  const ttl = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000) - 300);
  if (tracker) tracker.incrementSubrequests(1);
  await env.APP_KV.put(installationCacheKey(installationId), JSON.stringify(record), { expirationTtl: ttl });
}

// Deliberately NOT wrapped in withRetry here: the caller (GitHubClient.getInstallationToken) wraps mint + KV-write + memo in one withRetry, so retrying here too would nest the ladders into 9 attempts.
export async function fetchInstallationToken(
  env: AppAuthEnv,
  installationId: string,
): Promise<InstallationTokenCacheRecord> {
  // Signed OUTSIDE withTimeout: the 30s budget is for the network call, not key import + signing.
  const headers = await appJwtHeaders(env);
  const response = await withTimeout('GitHub installation token', GITHUB_TIMEOUT_MS, (signal) =>
    fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      signal,
      headers,
    }),
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new GitHubError(
      response.status,
      errText,
      '/app/installations/.../access_tokens',
      `GitHub installation token request failed with ${response.status}: ${errText}`,
    );
  }

  const data = (await response.json()) as { token: string; expires_at: string };
  return { token: data.token, expiresAt: data.expires_at };
}

export async function fetchInstallations(env: AppAuthEnv): Promise<GitHubInstallation[]> {
  return withRetry('listInstallations', async () => {
    const headers = await appJwtHeaders(env);
    const response = await withTimeout('GitHub list installations', GITHUB_TIMEOUT_MS, (signal) =>
      fetch('https://api.github.com/app/installations', { signal, headers }),
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new GitHubError(
        response.status,
        errText,
        '/app/installations',
        `GitHub list installations failed with ${response.status}: ${errText}`,
      );
    }

    return (await response.json()) as GitHubInstallation[];
  });
}

export async function fetchAppInstallationUrl(
  env: Pick<AppBindings, 'APP_KV' | 'APP_PRIVATE_KEY' | 'GITHUB_APP_ID' | 'BOT_USERNAME' | 'GITHUB_APP_SLUG'>,
): Promise<string> {
  const configuredSlug = normalizeGitHubAppSlug(env.GITHUB_APP_SLUG);
  if (configuredSlug) {
    return installUrlFromSlug(configuredSlug);
  }

  const cached = await env.APP_KV.get(GITHUB_APP_INSTALL_URL_CACHE_KEY);
  if (cached) {
    return cached;
  }

  return withRetry('getAppInstallationUrl', async () => {
    const headers = await appJwtHeaders(env);
    const response = await withTimeout('GitHub app lookup', GITHUB_TIMEOUT_MS, (signal) =>
      fetch('https://api.github.com/app', { signal, headers }),
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new GitHubError(
        response.status,
        errText,
        '/app',
        `GitHub app lookup failed with ${response.status}: ${errText}`,
      );
    }

    const app = (await response.json()) as GitHubAppRecord;
    const fallbackSlug = normalizeGitHubAppSlug(app.slug);
    const installUrl = app.html_url
      ? `${app.html_url.replace(/\/$/, '')}/installations/new`
      : fallbackSlug
        ? installUrlFromSlug(fallbackSlug)
        : null;

    if (!installUrl) {
      throw new Error('GitHub app lookup did not return a usable app URL.');
    }

    await env.APP_KV.put(GITHUB_APP_INSTALL_URL_CACHE_KEY, installUrl, { expirationTtl: 60 * 60 * 24 });
    return installUrl;
  });
}
