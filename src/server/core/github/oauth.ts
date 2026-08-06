import type { AppBindings, DashboardSessionUser } from '@server/env';

export type GitHubOAuthProfile = {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  email: string | null;
};

function githubHeaders(token?: string) {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'codra-app',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function exchangeGitHubOAuthCode(
  env: Pick<AppBindings, 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET' | 'AUTH_CALLBACK_URL'>,
  code: string,
) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: env.AUTH_CALLBACK_URL,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed with ${response.status}`);
  }

  const payload = await response.json() as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? 'GitHub token exchange did not return an access token.');
  }

  return payload.access_token;
}

export async function fetchGitHubOAuthProfile(token: string) {
  const response = await fetch('https://api.github.com/user', {
    headers: githubHeaders(token),
  });

  if (!response.ok) {
    throw new Error(`GitHub user lookup failed with ${response.status}`);
  }

  return (await response.json()) as GitHubOAuthProfile;
}

export function toDashboardSessionUser(profile: GitHubOAuthProfile): DashboardSessionUser {
  return {
    githubUserId: profile.id,
    login: profile.login,
    name: profile.name,
    avatarUrl: profile.avatar_url,
    email: profile.email,
    signedInAt: new Date().toISOString(),
  };
}
