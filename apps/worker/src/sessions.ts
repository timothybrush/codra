import type { DashboardSessionUser, SessionStore } from '@codra/core';

export class CloudflareSessionStore implements SessionStore {
  constructor(private readonly kv: KVNamespace) {}

  private sessionKey(token: string) {
    return `session:${token}`;
  }

  async createSession(session: DashboardSessionUser): Promise<string> {
    const token = crypto.randomUUID();
    await this.kv.put(this.sessionKey(token), JSON.stringify(session), {
      expirationTtl: 60 * 60 * 24 * 7,
    });
    return token;
  }

  async readSession(token: string): Promise<DashboardSessionUser | null> {
    return this.kv.get(this.sessionKey(token), 'json');
  }

  async destroySession(token: string): Promise<void> {
    await this.kv.delete(this.sessionKey(token));
  }
}
