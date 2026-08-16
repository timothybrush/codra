import type { DashboardSessionUser, SessionStore } from '@codraoss/core';
export interface AppBindings {
    SESSION_STORE: SessionStore;
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
    CF_API_TOKEN: string;
    CF_ACCOUNT_ID: string;
    APP_KV?: any;
    REVIEW_QUEUE?: any;
    REVIEW_WORKFLOW?: any;
    ASSETS?: any;
    HYPERDRIVE?: any;
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
