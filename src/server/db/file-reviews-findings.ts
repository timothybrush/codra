import type { AppBindings } from '@server/env';
import { queryRows } from './client';

export type SuppressedFinding = {
  fingerprint: string | null;
  // Null for repo-wide rejections, which suppress regardless of what the code now says.
  anchor_hash: string | null;
  // Title-independent identity; already includes the anchor, so it needs no separate anchor check.
  fingerprint_v2: string | null;
  // True when this came from an earlier posted comment rather than from human rejection.
  anchored: boolean;
};

// Findings that must not be posted again for this pull request: already posted on an EARLIER commit
// with the anchored line unchanged, or rejected by a human anywhere in this repository.
//
// `j.commit_sha <> me.commit_sha` is load-bearing. Retries and mention-triggered re-reviews reuse the
// SAME head commit, so without it a manual re-review matches everything the previous run posted and
// returns an empty, summary-only review.
export async function getSuppressedFindings(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
): Promise<SuppressedFinding[]> {
  return queryRows<SuppressedFinding>(
    env,
    `
      WITH me AS (
        SELECT repository_id, pr_number, commit_sha FROM jobs WHERE id = $1::uuid
      ),
      already_posted AS (
        SELECT DISTINCT rc.fingerprint, rc.anchor_hash, rc.fingerprint_v2
        FROM me
        JOIN jobs            j  ON j.repository_id = me.repository_id AND j.pr_number = me.pr_number
        JOIN file_reviews    fr ON fr.job_id = j.id
        JOIN review_comments rc ON rc.file_review_id = fr.id
        WHERE j.id <> $1::uuid
          AND j.commit_sha <> me.commit_sha
          AND rc.posted
          -- Either identity is enough. v1 alone missed reworded repeats: on PR #55 six of ten findings
          -- were re-reports and only one shared a v1 fingerprint.
          AND (rc.fingerprint IS NOT NULL OR rc.fingerprint_v2 IS NOT NULL)
      ),
      rejected AS (
        -- Only the NEGATIVE outcomes. 'resolved' and 'marked_right' are stored but never read here:
        -- suppressing on them would silence the findings that turned out to be correct. And note
        -- there is no branch for "no row" -- an unlabelled finding is not a negative signal.
        SELECT DISTINCT cf.fingerprint, NULL::text AS anchor_hash, cf.fingerprint_v2
        FROM me
        JOIN comment_feedback cf ON cf.repository_id = me.repository_id
        WHERE cf.outcome IN ('deleted', 'marked_wrong')
          AND (cf.fingerprint IS NOT NULL OR cf.fingerprint_v2 IS NOT NULL)
      )
      SELECT fingerprint, anchor_hash, fingerprint_v2, TRUE  AS anchored FROM already_posted
      UNION ALL
      SELECT fingerprint, anchor_hash, fingerprint_v2, FALSE AS anchored FROM rejected
    `,
    [jobId],
  );
}

// Resolves a finding fingerprint WITHIN a job, for the dashboard labelling route. This is the
// authorization boundary, not a convenience: a label writes a REPOSITORY-WIDE suppression, so
// without job scoping anyone could silence a finding by guessing eight hex characters.
export async function getFindingLabelTarget(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  fingerprint: string,
): Promise<{ repository_id: number; pr_number: number | null; anchor_hash: string | null; fingerprint_v2: string | null } | null> {
  const rows = await queryRows<{ repository_id: number; pr_number: number | null; anchor_hash: string | null; fingerprint_v2: string | null }>(
    env,
    `
      SELECT j.repository_id, j.pr_number, rc.anchor_hash, rc.fingerprint_v2
      FROM jobs j
      JOIN file_reviews    fr ON fr.job_id = j.id
      JOIN review_comments rc ON rc.file_review_id = fr.id
      WHERE j.id = $1::uuid AND rc.fingerprint = $2::text
      LIMIT 1
    `,
    [jobId, fingerprint],
  );
  return rows[0] ?? null;
}

// Records which findings actually reached GitHub, so later commits can suppress them. Only
// fingerprints GitHub genuinely accepted: marking a silently dropped one posted hides it forever.
export async function markCommentsPosted(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  fingerprints: string[],
): Promise<void> {
  if (fingerprints.length === 0) return;
  await queryRows(
    env,
    `
      UPDATE review_comments rc
      SET posted = TRUE, disposition = 'posted'
      FROM file_reviews fr
      WHERE fr.id = rc.file_review_id
        AND fr.job_id = $1::uuid
        AND rc.fingerprint = ANY($2::text[])
    `,
    [jobId, fingerprints],
  );
}

// Records WHY each finding did not reach the pull request.
//
// `posted = false` alone conflates the severity gate, the confidence gate, suppression, dedupe, the
// verifier and the max_comments cap. That ambiguity is what made the corpus unusable: "P3 has never
// been posted" was mostly P3 sorting last and the cap slicing from the end. Attribution has to be
// recorded where the decision is made. One statement regardless of how many stages fired.
export async function markCommentDispositions(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  byFingerprint: Map<string, { disposition: string | null; reason: string | null }>,
): Promise<void> {
  if (byFingerprint.size === 0) return;
  const fingerprints = [...byFingerprint.keys()];
  const dispositions = fingerprints.map((fp) => byFingerprint.get(fp)!.disposition);
  const reasons = fingerprints.map((fp) => byFingerprint.get(fp)!.reason);

  // A posted finding's disposition is never rewritten. A KEPT finding is entered with a null
  // disposition purely to carry its verifier reason, so an unconditional assignment would null out
  // `posted`. Worse, the map is keyed on FINGERPRINT = hash(path + normalized title), so two findings
  // on one file with the same title share one: this UPDATE matched BOTH and wrote 'suppression' over
  // 'posted' for two P0s that really were posted. `posted` is GitHub's fact; a disposition is our
  // inference. The fact wins.
  await queryRows(
    env,
    `
      UPDATE review_comments rc
      SET disposition   = CASE WHEN rc.posted THEN rc.disposition
                               ELSE COALESCE(d.disposition, rc.disposition) END,
          verify_reason = COALESCE(d.reason, rc.verify_reason)
      FROM file_reviews fr,
           UNNEST($2::text[], $3::text[], $4::text[]) AS d(fingerprint, disposition, reason)
      WHERE fr.id = rc.file_review_id
        AND fr.job_id = $1::uuid
        AND rc.fingerprint = d.fingerprint
    `,
    [jobId, fingerprints, dispositions, reasons],
  );
}
