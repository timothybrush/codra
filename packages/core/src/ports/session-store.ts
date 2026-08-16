export interface DashboardSessionUser {
  provider: string;
  providerUserId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
  signedInAt: string;
  metadata: Record<string, unknown>;
}

export interface SessionStore {
  createSession(session: DashboardSessionUser): Promise<string>;
  readSession(token: string): Promise<DashboardSessionUser | null>;
  destroySession(token: string): Promise<void>;
  renewSession(token: string): Promise<void>;
}
