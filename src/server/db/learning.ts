import type { AppBindings } from '@server/env';
import { queryRows } from './client';
import type { ClaimType } from '@shared/schema';

// The learning loop: reads over findings a human has already judged.
//
// They share one discipline - **report only over the LABELLED subset, always with n**. The
// absence of a label is not a signal. Treating unlabelled findings as correct is how "P3 has never
// been posted" looked decisive when it was really measuring sort order.

export type RejectedExemplar = {
  title: string;
  body: string;
  claim_type: ClaimType | null;
  context_snippet: string | null;
  path: string;
};

// Findings a human rejected in this repository, for injection as negative few-shot exemplars.
//
// Retrieval is the best measured lever for small models: RAG at 20 shots took F1 36.35 → 74.05 on
// this task, beating a fine-tuned Gemini, and the gains are consistently LARGER on smaller models -
// which is this whole chain.
//
// Claim-type-keyed rather than embedding-based on purpose. There is no vector store here, and the
// claim type is already the axis precision varies along, so it is the cheapest useful retrieval key.
// Served by the `(repository_id, fingerprint)` index from migration 005 (now folded into 003_grounding.sql).
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

// The repository a job belongs to. Exemplars are repository-scoped - what one team rejects is not
// evidence about another - and the job row is the only place that link is available mid-review.
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
