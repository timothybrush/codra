import type { DashboardSessionUser, SessionStore, IdentityProvider } from '@codraoss/core';
export type { DashboardSessionUser };

export interface AppBindings {
  SESSION_STORE: SessionStore;
  IDENTITY_PROVIDER: IdentityProvider;
  APP_PRIVATE_KEY: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_WEBHOOK_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  AUTH_CALLBACK_URL: string;
  APP_URL: string;
  DASHBOARD_ALLOWED_USERS: string;
  LLM_CONFIG_ENCRYPTION_KEY: string;
  BOT_USERNAME: string;
  ENVIRONMENT: string;
  
  // These are still used by DB for now, until DB is fully ported
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;

  // Temporary aliases while we port everything else
  APP_KV: any;
  REVIEW_QUEUE: any;
  REVIEW_WORKFLOW: any;
  ASSETS: any;
  HYPERDRIVE: any;
  AI: any;
}

export interface AppVariables {
  sessionToken: string | null;
  sessionUser: DashboardSessionUser | null;
  requestId: string;
}

export type AppEnv = {
  Bindings: AppBindings;
  Variables: AppVariables;
};
