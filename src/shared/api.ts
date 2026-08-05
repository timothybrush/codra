import type { JobDetail, JobSummary, RepoConfigRecord, StatsPayload } from './schema';

export type AuthSessionUser = {
  githubUserId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
  signedInAt: string;
};

export type JobsResponse = {
  jobs: JobSummary[];
  total: number;
};

export type AuthSessionResponse = {
  user: AuthSessionUser;
};

// Durable account record persisted in Postgres (account_settings).
export type AccountSettings = {
  // Stable, unique account id (uuid) - distinct from the GitHub user id.
  id: string;
  githubUserId: number;
  githubUsername: string;
  accountName: string | null;
  accountEmail: string | null;
  // IANA zone (e.g. 'Asia/Kolkata') used to render timestamps in the dashboard.
  // Timestamps are always stored absolute (TIMESTAMPTZ/UTC); this is presentation
  // only. `null` means "follow the viewer's browser timezone".
  timezone: string | null;
};

export type AccountResponse = {
  account: AccountSettings;
};

export type UpdatesEmailStatus = 'pending' | 'subscribed';

export type UpdatesEmailResponse = {
  status: UpdatesEmailStatus;
  email: string | null;
  updatedAt: string | null;
};

export type JobDetailResponse = {
  job: JobDetail;
};

/** Per-file reconstructed diff/prompt text, fetched on demand (see GET /api/jobs/:id/diffs) --
    diff_input isn't persisted in Postgres, so this comes from KV or a fresh GitHub fetch. Files
    with no entry are unavailable (e.g. the underlying commits are gone). */
export type JobDiffsResponse = {
  diffs: Record<string, string>;
};

export type RetryJobResponse = {
  job: JobSummary;
};

export type RepoConfigsResponse = {
  repos: RepoConfigRecord[];
};

export type RepoConfigResponse = {
  repo: RepoConfigRecord;
};

export type StatsResponse = {
  stats: StatsPayload;
};

export type SyncReposResponse = {
  ok: boolean;
  synced: string[];
};


export type ModelConfigsResponse = {
  providers: import('./schema').LlmProvider[];
  configs: import('./schema').ModelConfig[];
  syncErrors?: Array<{ providerId: string; providerName: string; error: string }>;
};
