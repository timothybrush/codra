import type { AppBindings } from '@server/env';
import { queryRows } from './client';
import type { ClaimType } from '@shared/schema';

/**
 * The learning loop: three reads over findings a human has already judged.
 *
 * All three share one discipline — **report only over the LABELLED subset, always with n**. The
 * absence of a label is not a signal. Treating unlabelled findings as correct is how "P3 has never
 * been posted" looked decisive when it was really measuring sort order.
 */

export type RejectedExemplar = {
  title: string;
  body: string;
  claim_type: ClaimType | null;
  context_snippet: string | null;
  path: string;
};

/**
 * Findings a human rejected in this repository, for injection as negative few-shot exemplars.
 *
 * Retrieval is the best measured lever for small models: RAG at 20 shots took F1 36.35 → 74.05 on
 * this task, beating a fine-tuned Gemini, and the gains are consistently LARGER on smaller models —
 * which is this whole chain.
 *
 * Claim-type-keyed rather than embedding-based on purpose. There is no vector store here, and the
 * claim type is already the axis precision varies along, so it is the cheapest useful retrieval key.
 * Served by the `(repository_id, fingerprint)` index from migration 005.
 */
export async function getRejectedExemplars(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: { repositoryId: number; claimTypes?: readonly ClaimType[]; limit?: number },
): Promise<RejectedExemplar[]> {
  const limit = Math.min(input.limit ?? 5, 20);

  return queryRows<RejectedExemplar>(
    env,
    `
      SELECT DISTINCT ON (rc.fingerprint)
             rc.title, rc.body, rc.claim_type, rc.context_snippet, rc.path
      FROM comment_feedback cf
      JOIN review_comments rc
        ON rc.fingerprint = cf.fingerprint
        -- OR-matched, same as suppression: v1 dies the moment the model rewords a title.
        OR (rc.fingerprint_v2 IS NOT NULL AND rc.fingerprint_v2 = cf.fingerprint_v2)
      WHERE cf.repository_id = $1
        AND cf.outcome IN ('deleted', 'marked_wrong')
        AND rc.title IS NOT NULL
        AND ($2::text[] IS NULL OR rc.claim_type = ANY($2::text[]))
      ORDER BY rc.fingerprint, rc.id DESC
      LIMIT $3
    `,
    [input.repositoryId, input.claimTypes?.length ? [...input.claimTypes] : null, limit],
  );
}

export type ClaimTypePrecision = {
  claim_type: ClaimType | null;
  source: string;
  labelled: number;
  correct: number;
};

/**
 * Precision per claim type, over the labelled subset only.
 *
 * Known limits, all real, and any dashboard built on this must state them:
 *  - `claim_type` is NULL on every pre-004 row.
 *  - Denied claim types never become review_comments rows at all, so `generated` UNDERCOUNTS them
 *    here; the per-type denied breakdown lives only in the parser's log.
 *  - Rows are deleted and recreated on every re-review, so there is no history beyond the latest row
 *    per (job, file).
 */
export async function getClaimTypePrecision(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  repositoryId: number,
): Promise<ClaimTypePrecision[]> {
  return queryRows<ClaimTypePrecision>(
    env,
    `
      SELECT rc.claim_type,
             rc.source,
             COUNT(*)::int                                              AS labelled,
             COUNT(*) FILTER (WHERE cf.outcome = 'marked_right')::int   AS correct
      FROM comment_feedback cf
      JOIN review_comments rc ON rc.fingerprint = cf.fingerprint
      JOIN file_reviews    fr ON fr.id = rc.file_review_id
      JOIN jobs            j  ON j.id = fr.job_id
      WHERE j.repository_id = $1
        -- Only decided findings. An unlabelled one is neither confirmed nor refuted.
        AND cf.outcome IN ('marked_right', 'marked_wrong', 'deleted')
      GROUP BY rc.claim_type, rc.source
      ORDER BY labelled DESC
    `,
    [repositoryId],
  );
}

export type OutdatedRateCandidate = {
  job_id: string;
  next_job_id: string;
  base_sha: string;
  head_sha: string;
  anchor_hashes: string[];
};

/**
 * Job pairs for the Outdated Rate metric: the share of flagged lines a developer subsequently
 * modified. It needs zero human annotation and is measured against what actually happened, which is
 * why BitsAI-CR uses it as the retirement signal — high precision but low Outdated Rate means a rule
 * is technically right and practically ignored.
 *
 * Returns each job with the NEXT job on the same PR at a DIFFERENT commit (retries reuse the head
 * sha, so same-sha pairs would compare a diff against itself), plus the anchor hashes it posted.
 * The caller diffs the two commits and checks whether any changed line hashes to one of them.
 *
 * `commit_sha` is BYTEA, so it is hex-encoded here rather than bound as text by the caller.
 */
export async function getOutdatedRateCandidates(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  repositoryId: number,
  limit = 50,
): Promise<OutdatedRateCandidate[]> {
  return queryRows<OutdatedRateCandidate>(
    env,
    `
      WITH posted AS (
        SELECT j.id            AS job_id,
               j.pr_number,
               j.created_at,
               encode(j.commit_sha, 'hex') AS head_sha,
               ARRAY_AGG(DISTINCT rc.anchor_hash) FILTER (WHERE rc.anchor_hash IS NOT NULL) AS anchor_hashes
        FROM jobs j
        JOIN file_reviews    fr ON fr.job_id = j.id
        JOIN review_comments rc ON rc.file_review_id = fr.id
        WHERE j.repository_id = $1 AND rc.posted
        GROUP BY j.id, j.pr_number, j.created_at, j.commit_sha
      )
      SELECT p.job_id,
             n.id::text                    AS next_job_id,
             p.head_sha                    AS base_sha,
             encode(n.commit_sha, 'hex')   AS head_sha,
             p.anchor_hashes
      FROM posted p
      JOIN LATERAL (
        SELECT j2.id, j2.commit_sha
        FROM jobs j2
        WHERE j2.repository_id = $1
          AND j2.pr_number = p.pr_number
          AND j2.created_at > p.created_at
          -- A retry reuses the head sha; comparing it to itself would report every finding as
          -- untouched and make the metric read as a flat zero.
          AND encode(j2.commit_sha, 'hex') <> p.head_sha
        ORDER BY j2.created_at ASC
        LIMIT 1
      ) n ON true
      WHERE p.anchor_hashes IS NOT NULL
      ORDER BY p.created_at DESC
      LIMIT $2
    `,
    [repositoryId, limit],
  );
}

/**
 * The repository a job belongs to. Exemplars are repository-scoped — what one team rejects is not
 * evidence about another — and the job row is the only place that link is available mid-review.
 */
export async function getRepositoryIdForJob(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
): Promise<number | null> {
  const [row] = await queryRows<{ repository_id: number }>(
    env,
    `SELECT repository_id FROM jobs WHERE id = $1::uuid`,
    [jobId],
  );
  return row?.repository_id ?? null;
}
