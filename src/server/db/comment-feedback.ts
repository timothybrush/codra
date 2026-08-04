import type { AppBindings } from '@server/env';
import { queryRows } from './client';

/**
 * What a human did with a finding we posted.
 *
 * 'deleted' and 'marked_wrong' are the negative signals. 'resolved' and 'marked_right' are
 * deliberately NOT: resolving a thread, or marking a finding correct, overwhelmingly means "this was
 * right" -- suppressing on either would train the system to stop reporting exactly the findings that
 * worked. They are stored for MEASUREMENT only and read by nothing in the review path.
 *
 * Note the asymmetry that has to hold everywhere downstream: the ABSENCE of a row is not a signal in
 * either direction. An unlabelled finding is neither confirmed nor refuted, so precision may only
 * ever be computed over labelled findings -- `marked_right / (marked_right + marked_wrong)`, reported
 * with n. Averaging over everything is how "P3 is never posted" became a conclusion instead of a
 * sorting artifact.
 */
export type CommentOutcome = 'posted' | 'deleted' | 'resolved' | 'unresolved' | 'marked_wrong' | 'marked_right';

export type CommentFeedbackInput = {
  repositoryId: number;
  prNumber: number | null;
  fingerprint: string;
  anchorHash: string | null;
  /** Title-independent identity, carried so a reworded repeat of a rejected claim also matches. */
  fingerprintV2?: string | null;
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
      INSERT INTO comment_feedback (repository_id, pr_number, fingerprint, anchor_hash, github_comment_id, outcome, fingerprint_v2)
      SELECT * FROM UNNEST($1::int[], $2::int[], $3::text[], $4::text[], $5::bigint[], $6::text[], $7::text[])
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
      entries.map((e) => e.fingerprintV2 ?? null),
    ],
  );

  return rows.length;
}

/**
 * Writes (or flips) a human's verdict made in the dashboard.
 *
 * Separate from `recordCommentFeedback` because a dashboard label has no GitHub comment behind it, so
 * it cannot use the webhook path's `(repository_id, github_comment_id, outcome)` unique index. It
 * targets a partial index on `(repository_id, fingerprint) WHERE source = 'dashboard'` instead, which
 * is what makes a right -> wrong flip an UPDATE rather than two contradictory rows.
 */
export async function upsertDashboardFeedback(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    repositoryId: number;
    prNumber: number | null;
    fingerprint: string;
    anchorHash: string | null;
    fingerprintV2?: string | null;
    jobId: string;
    labelledBy: number | null;
    outcome: 'marked_wrong' | 'marked_right';
  },
): Promise<void> {
  await queryRows(
    env,
    `
      INSERT INTO comment_feedback
        (repository_id, pr_number, fingerprint, anchor_hash, github_comment_id, outcome, source, job_id, labelled_by, fingerprint_v2)
      VALUES ($1::int, $2::int, $3::text, $4::text, NULL, $5::text, 'dashboard', $6::uuid, $7::bigint, $8::text)
      ON CONFLICT (repository_id, fingerprint) WHERE source = 'dashboard'
      DO UPDATE SET
        outcome     = EXCLUDED.outcome,
        pr_number   = EXCLUDED.pr_number,
        anchor_hash = COALESCE(EXCLUDED.anchor_hash, comment_feedback.anchor_hash),
        fingerprint_v2 = COALESCE(EXCLUDED.fingerprint_v2, comment_feedback.fingerprint_v2),
        job_id      = EXCLUDED.job_id,
        labelled_by = EXCLUDED.labelled_by,
        updated_at  = now()
    `,
    [
      input.repositoryId, input.prNumber, input.fingerprint, input.anchorHash,
      input.outcome, input.jobId, input.labelledBy, input.fingerprintV2 ?? null,
    ],
  );
}

/**
 * Removes a dashboard label, so a mislabel is undoable.
 *
 * Scoped to `source = 'dashboard'` on purpose: a webhook-sourced 'deleted' row is ground truth from
 * GitHub -- somebody actually deleted the comment -- and must not be erasable from the dashboard.
 */
export async function clearDashboardFeedback(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  repositoryId: number,
  fingerprint: string,
): Promise<void> {
  await queryRows(
    env,
    `DELETE FROM comment_feedback
     WHERE repository_id = $1::int AND fingerprint = $2::text AND source = 'dashboard'`,
    [repositoryId, fingerprint],
  );
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
