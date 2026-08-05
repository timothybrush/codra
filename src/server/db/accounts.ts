import type { AppBindings } from '@server/env';
import { queryRows } from './client';

// Durable account record (see db/migrations/004_account_settings.sql).
export type AccountSettingsRecord = {
  // Stable, unique account id (uuid) - not the GitHub user id.
  id: string;
  githubUserId: number;
  githubUsername: string;
  accountName: string | null;
  accountEmail: string | null;
  // IANA zone for rendering timestamps; null = follow the viewer's browser.
  timezone: string | null;
};

export type AccountSettingsInput = {
  githubUserId: number;
  githubUsername: string;
  accountName: string | null;
  accountEmail: string | null;
};

type Row = {
  id: string;
  github_user_id: string | number;
  github_username: string;
  account_name: string | null;
  account_email: string | null;
  timezone: string | null;
};

const COLUMNS = 'id, github_user_id, github_username, account_name, account_email, timezone';

function mapRow(row: Row): AccountSettingsRecord {
  return {
    id: row.id,
    // BIGINT comes back as a string from postgres.js; GitHub ids are well within
    // Number's safe integer range.
    githubUserId: Number(row.github_user_id),
    githubUsername: row.github_username,
    accountName: row.account_name,
    accountEmail: row.account_email,
    timezone: row.timezone,
  };
}

// Insert or refresh the account record for a GitHub user, returning the row.
export async function upsertAccountSettings(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: AccountSettingsInput,
): Promise<AccountSettingsRecord> {
  const rows = await queryRows<Row>(
    env,
    `INSERT INTO account_settings (github_user_id, github_username, account_name, account_email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (github_user_id) DO UPDATE SET
       github_username = EXCLUDED.github_username,
       -- COALESCE, not EXCLUDED: this upsert runs on every sign-in, so assigning
       -- the GitHub profile name unconditionally would wipe a display name the
       -- user set on the account page. Keep theirs; only backfill when unset.
       account_name    = COALESCE(account_settings.account_name, EXCLUDED.account_name),
       account_email   = EXCLUDED.account_email,
       updated_at      = now()
     RETURNING ${COLUMNS}`,
    [input.githubUserId, input.githubUsername, input.accountName, input.accountEmail],
  );
  return mapRow(rows[0]);
}

export async function getAccountSettings(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  githubUserId: number,
): Promise<AccountSettingsRecord | null> {
  const rows = await queryRows<Row>(
    env,
    `SELECT ${COLUMNS} FROM account_settings WHERE github_user_id = $1`,
    [githubUserId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

// Update the user-editable fields. Only keys present in `patch` are written, so a
// name change can't clobber the timezone and vice versa. `timezone: null` is a
// meaningful value ("follow the browser"), hence the `!== undefined` checks.
// Returns null if no row exists for this user.
export async function updateAccountSettings(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  githubUserId: number,
  patch: { accountName?: string; timezone?: string | null },
): Promise<AccountSettingsRecord | null> {
  const assignments: string[] = [];
  const params: unknown[] = [githubUserId];

  if (patch.accountName !== undefined) {
    params.push(patch.accountName);
    assignments.push(`account_name = $${params.length}`);
  }
  if (patch.timezone !== undefined) {
    params.push(patch.timezone);
    assignments.push(`timezone = $${params.length}`);
  }
  if (assignments.length === 0) return getAccountSettings(env, githubUserId);

  const rows = await queryRows<Row>(
    env,
    `UPDATE account_settings
     SET ${assignments.join(', ')}, updated_at = now()
     WHERE github_user_id = $1
     RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0] ? mapRow(rows[0]) : null;
}
