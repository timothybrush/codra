export interface DashboardSessionUser {
  githubUserId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
  signedInAt: string;
}

export interface SessionStore {
  createSession(session: DashboardSessionUser): Promise<string>;
  readSession(token: string): Promise<DashboardSessionUser | null>;
  destroySession(token: string): Promise<void>;
}
