import type { AppBindings } from '@server/env';
import { queryRows } from './client';

/**
 * What a human did with a finding we posted.
 *
 * Only 'deleted' is treated as a negative signal. 'resolved' is deliberately NOT: resolving a
 * thread overwhelmingly means "I fixed this", so suppressing on it would train the system to stop
 * reporting exactly the findings that worked.
 */
export type CommentOutcome = 'posted' | 'deleted' | 'resolved' | 'unresolved';

export type CommentFeedbackInput = {
  repositoryId: number;
  prNumber: number | null;
  fingerprint: string;
  anchorHash: string | null;
  githubCommentId: number;
  outcome: CommentOutcome;
};

/**
 * Records feedback events in one statement.
 *
 * Keyed by fingerprint rather than by review_comments.id because those rows are deleted and
 * re-inserted on every re-review of a file, so their ids cannot anchor anything long-lived.
 *
 * Webhook delivery is at-least-once and resolve/unresolve toggles freely, so the unique index does
 * the deduplication and repeat deliveries are no-ops.
 */
export async function recordCommentFeedback(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  entries: CommentFeedbackInput[],
): Promise<number> {
  if (entries.length === 0) return 0;

  const rows = await queryRows<{ id: string }>(
    env,
    `
      INSERT INTO comment_feedback (repository_id, pr_number, fingerprint, anchor_hash, github_comment_id, outcome)
      SELECT * FROM UNNEST($1::int[], $2::int[], $3::text[], $4::text[], $5::bigint[], $6::text[])
      ON CONFLICT (repository_id, github_comment_id, outcome) DO NOTHING
      RETURNING id
    `,
    [
      entries.map((e) => e.repositoryId),
      entries.map((e) => e.prNumber ?? null),
      entries.map((e) => e.fingerprint),
      entries.map((e) => e.anchorHash ?? null),
      entries.map((e) => e.githubCommentId),
      entries.map((e) => e.outcome),
    ],
  );

  return rows.length;
}

/**
 * Clears a stale 'resolved' row when a thread is reopened, so a resolve -> unresolve round trip
 * doesn't leave the finding permanently recorded as accepted.
 */
export async function clearResolvedFeedback(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  repositoryId: number,
  githubCommentIds: number[],
): Promise<void> {
  if (githubCommentIds.length === 0) return;
  await queryRows(
    env,
    `
      DELETE FROM comment_feedback
      WHERE repository_id = $1::int
        AND outcome = 'resolved'
        AND github_comment_id = ANY($2::bigint[])
    `,
    [repositoryId, githubCommentIds],
  );
}
