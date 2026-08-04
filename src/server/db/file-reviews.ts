import type { ParsedReviewComment } from '@shared/schema';
import type { AppBindings } from '@server/env';
import { parseJsonColumn, queryRows, queryTransaction } from './client';
import {
  REVIEW_COMMENT_INSERT_CASTS,
  REVIEW_COMMENT_INSERT_COLUMNS,
  reviewCommentInsertValues,
  reviewCommentsAggregate,
} from './review-comment-sql';

export async function insertFileReview(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    jobId: string;
    filePath: string;
    fileStatus: 'pending' | 'done' | 'skipped' | 'failed';
    modelUsed: string;
    modelProvider?: string | null;
    diffLineCount: number;
    diffInput: string | null;
    rawAiOutput: string | null;
    parsedComments: ParsedReviewComment[];
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number | null;
    verdict: 'approve' | 'comment' | null;
    fileSummary: string | null;
    overallCorrectness?: string | null;
    confidenceScore?: number | null;
    errorMessage: string | null;
  },
) {
  await queryTransaction(env, async (tx) => {
    const [review] = await tx.query<{ id: string }>(
      `
        INSERT INTO file_reviews (
          job_id,
          file_path,
          file_status,
          model_used,
          diff_line_count,
          diff_input,
          raw_ai_output,
          input_tokens,
          output_tokens,
          duration_ms,
          verdict,
          file_summary,
          overall_correctness,
          confidence_score,
          error_msg,
          model_provider
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING id
      `,
      [
        input.jobId,
        input.filePath,
        input.fileStatus,
        input.modelUsed,
        input.diffLineCount,
        input.diffInput,
        input.rawAiOutput,
        input.inputTokens,
        input.outputTokens,
        input.durationMs,
        input.verdict,
        input.fileSummary,
        input.overallCorrectness ?? null,
        input.confidenceScore ?? null,
        input.errorMessage,
        input.modelProvider ?? null,
      ],
    );

    if (input.parsedComments.length > 0) {
      await tx.query(
        `
          INSERT INTO review_comments (file_review_id, ${REVIEW_COMMENT_INSERT_COLUMNS.join(', ')})
          SELECT $1::uuid, * FROM UNNEST(${REVIEW_COMMENT_INSERT_CASTS})
        `,
        [review.id, ...reviewCommentInsertValues(input.parsedComments)],
      );
    }
  });
}

export async function upsertFileReview(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  input: {
    filePath: string;
    fileStatus: 'pending' | 'done' | 'skipped' | 'failed';
    modelUsed: string;
    modelProvider?: string | null;
    diffLineCount: number;
    diffInput: string | null;
    rawAiOutput: string | null;
    parsedComments: ParsedReviewComment[];
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number | null;
    verdict: 'approve' | 'comment' | null;
    fileSummary: string | null;
    overallCorrectness?: string | null;
    confidenceScore?: number | null;
    errorMessage: string | null;
    /**
     * Findings dropped in the PARSER, which therefore have no review_comments row to carry a
     * disposition. Without this, a review where every finding was withheld is indistinguishable from
     * a clean one, and both get approved.
     */
    withheldCounts?: { evidence: number; claimDenied: number } | null;
    // Async batch bookkeeping: set when a review is submitted to the Workers AI queue (status
    // 'pending'), cleared (null) once the batch completes and a terminal review is persisted.
    asyncRequestId?: string | null;
    asyncModel?: string | null;
  },
) {
  await queryTransaction(env, async (tx) => {
    const [review] = await tx.query<{ id: string }>(
      `
        INSERT INTO file_reviews (
          job_id,
          file_path,
          file_status,
          model_used,
          diff_line_count,
          diff_input,
          raw_ai_output,
          input_tokens,
          output_tokens,
          duration_ms,
          verdict,
          file_summary,
          overall_correctness,
          confidence_score,
          error_msg,
          model_provider,
          async_request_id,
          async_model,
          withheld_counts
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::text::jsonb)
        ON CONFLICT (job_id, file_path) DO UPDATE SET
          file_status = EXCLUDED.file_status,
          model_used = EXCLUDED.model_used,
          diff_line_count = EXCLUDED.diff_line_count,
          diff_input = EXCLUDED.diff_input,
          raw_ai_output = EXCLUDED.raw_ai_output,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          duration_ms = EXCLUDED.duration_ms,
          verdict = EXCLUDED.verdict,
          file_summary = EXCLUDED.file_summary,
          overall_correctness = EXCLUDED.overall_correctness,
          confidence_score = EXCLUDED.confidence_score,
          error_msg = EXCLUDED.error_msg,
          model_provider = EXCLUDED.model_provider,
          async_request_id = EXCLUDED.async_request_id,
          async_model = EXCLUDED.async_model,
          withheld_counts = EXCLUDED.withheld_counts,
          transient_error_count = 0
        RETURNING id
      `,
      [
        jobId,
        input.filePath,
        input.fileStatus,
        input.modelUsed,
        input.diffLineCount,
        input.diffInput,
        input.rawAiOutput,
        input.inputTokens,
        input.outputTokens,
        input.durationMs,
        input.verdict,
        input.fileSummary,
        input.overallCorrectness ?? null,
        input.confidenceScore ?? null,
        input.errorMessage,
        input.modelProvider ?? null,
        input.asyncRequestId ?? null,
        input.asyncModel ?? null,
        // JSON text into a `::text::jsonb` placeholder -- the one jsonb-writing idiom, documented at
        // normalizeParam in db/client.ts. Binding the raw object also happens to work here, but only
        // for objects, and having two idioms in the codebase is precisely how the string-scalar bug
        // spread to five columns. This column is where it was caught: `withheld_counts->>'evidence'`
        // returned NULL and the SQL aggregate read zero for a review that had withheld five findings,
        // while the TypeScript path kept working because parseJsonColumn tolerates both shapes.
        input.withheldCounts ? JSON.stringify(input.withheldCounts) : null,
      ],
    );

    await tx.query('DELETE FROM review_comments WHERE file_review_id = $1::uuid', [review.id]);

    if (input.parsedComments.length > 0) {
      await tx.query(
        `
          INSERT INTO review_comments (file_review_id, ${REVIEW_COMMENT_INSERT_COLUMNS.join(', ')})
          SELECT $1::uuid, * FROM UNNEST(${REVIEW_COMMENT_INSERT_CASTS})
        `,
        [review.id, ...reviewCommentInsertValues(input.parsedComments)],
      );
    }
  });
}

export async function recordRetryableFileReviewFailure(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  input: {
    filePath: string;
    modelUsed: string;
    modelProvider?: string | null;
    diffLineCount: number;
    diffInput: string | null;
    durationMs: number | null;
    errorMessage: string;
  },
) {
  return await queryTransaction(env, async (tx) => {
    const [review] = await tx.query<{ id: string; transient_error_count: number }>(
      `
        INSERT INTO file_reviews (
          job_id,
          file_path,
          file_status,
          model_used,
          model_provider,
          diff_line_count,
          diff_input,
          raw_ai_output,
          input_tokens,
          output_tokens,
          duration_ms,
          verdict,
          file_summary,
          overall_correctness,
          confidence_score,
          error_msg,
          transient_error_count
        )
        VALUES ($1::uuid, $2, 'failed', $3, $4, $5, $6, NULL, NULL, NULL, $7, NULL, NULL, NULL, NULL, $8, 1)
        ON CONFLICT (job_id, file_path) DO UPDATE SET
          file_status = 'failed',
          model_used = EXCLUDED.model_used,
          model_provider = EXCLUDED.model_provider,
          diff_line_count = EXCLUDED.diff_line_count,
          diff_input = EXCLUDED.diff_input,
          raw_ai_output = NULL,
          input_tokens = NULL,
          output_tokens = NULL,
          duration_ms = EXCLUDED.duration_ms,
          verdict = NULL,
          file_summary = NULL,
          overall_correctness = NULL,
          confidence_score = NULL,
          error_msg = EXCLUDED.error_msg,
          transient_error_count = file_reviews.transient_error_count + 1
        RETURNING id, transient_error_count
      `,
      [
        jobId,
        input.filePath,
        input.modelUsed,
        input.modelProvider ?? null,
        input.diffLineCount,
        input.diffInput,
        input.durationMs,
        input.errorMessage,
      ],
    );

    await tx.query('DELETE FROM review_comments WHERE file_review_id = $1::uuid', [review.id]);
    return review.transient_error_count;
  });
}

/**
 * Copy every still-needed, inheritable parent review (and its comments) into `jobId` in a single
 * cheap DB pass. A retry that can reuse the parent's completed reviews would otherwise re-persist
 * them one file at a time through the budget-limited review loop (~5 files/chunk, hibernating a
 * fresh invocation between chunks), turning a fully-inheritable retry into a many-minute crawl.
 * This collapses all of them into one transaction (a couple of subrequests total, regardless of
 * file count) so the review phase finishes in a single invocation. `filePaths` must already be
 * filtered to files that are inheritable under the current model strategy and have no row yet in
 * the target job. Returns the file paths that were actually inserted.
 */
export async function bulkInheritFileReviews(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: { jobId: string; parentJobId: string; filePaths: string[] },
): Promise<string[]> {
  if (input.filePaths.length === 0) return [];

  return await queryTransaction(env, async (tx) => {
    const inserted = await tx.query<{ id: string; file_path: string }>(
      `
        INSERT INTO file_reviews (
          job_id, file_path, file_status, model_used, diff_line_count, diff_input,
          raw_ai_output, input_tokens, output_tokens, duration_ms, verdict,
          file_summary, overall_correctness, confidence_score, error_msg, model_provider
        )
        SELECT $1::uuid, file_path, file_status, model_used, diff_line_count, diff_input,
          raw_ai_output, input_tokens, output_tokens, duration_ms, verdict,
          file_summary, overall_correctness, confidence_score, error_msg, model_provider
        FROM file_reviews
        WHERE job_id = $2::uuid AND file_status = 'done' AND file_path = ANY($3::text[])
        ON CONFLICT (job_id, file_path) DO NOTHING
        RETURNING id, file_path
      `,
      [input.jobId, input.parentJobId, input.filePaths],
    );

    if (inserted.length > 0) {
      // Re-attach each inherited review's comments, mapping the parent's rows to the new ids by path.
      // Identity (fingerprint/anchor_hash/evidence) carries over, but `posted` is explicitly reset:
      // it means "THIS job showed this comment on GitHub", which an inheriting job has not done.
      await tx.query(
        `
          INSERT INTO review_comments (
            file_review_id, path, line, position, severity, category, title, body, code_suggestion, confidence_score,
            evidence, fingerprint, anchor_hash, posted, claim_type, context_snippet, disposition, fingerprint_v2,
            source, rule_id
          )
          SELECT nw.new_id, rc.path, rc.line, rc.position, rc.severity, rc.category, rc.title, rc.body, rc.code_suggestion, rc.confidence_score,
                 rc.evidence, rc.fingerprint, rc.anchor_hash, FALSE, rc.claim_type, rc.context_snippet, NULL, rc.fingerprint_v2,
                 -- Carried, not defaulted: omitting these would turn every retried job's rule
                 -- findings into LLM findings, and fail-closed would stop applying to them.
                 rc.source, rc.rule_id
          FROM UNNEST($1::uuid[], $2::text[]) AS nw(new_id, file_path)
          JOIN file_reviews pf ON pf.job_id = $3::uuid AND pf.file_path = nw.file_path
          JOIN review_comments rc ON rc.file_review_id = pf.id
        `,
        [inserted.map((r) => r.id), inserted.map((r) => r.file_path), input.parentJobId],
      );
    }

    return inserted.map((r) => r.file_path);
  });
}

/**
 * Mark many files 'failed' in a single INSERT. Finalize backfills reviews for files that never got
 * one (e.g. files that appeared mid-review, or unrecoverable ones); doing that one-by-one through
 * upsertFileReview runs a transaction per file (several Hyperdrive round-trips each), which for a
 * large/growing PR can blow the per-invocation subrequest budget right before the review is posted.
 * This collapses the whole backfill into one statement (one subrequest). Skips files that already
 * have a row (ON CONFLICT DO NOTHING) so it never clobbers a real review.
 */
export async function bulkMarkFilesFailed(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  files: Array<{ filePath: string; diffLineCount: number }>,
  opts: { modelUsed: string; errorMessage: string },
): Promise<void> {
  if (files.length === 0) return;
  await queryRows(
    env,
    `
      INSERT INTO file_reviews (job_id, file_path, file_status, model_used, diff_line_count, diff_input, error_msg, duration_ms)
      SELECT $1::uuid, u.file_path, 'failed', $2, u.diff_line_count, NULL, $3, 0
      FROM UNNEST($4::text[], $5::int[]) AS u(file_path, diff_line_count)
      ON CONFLICT (job_id, file_path) DO NOTHING
    `,
    [jobId, opts.modelUsed, opts.errorMessage, files.map((f) => f.filePath), files.map((f) => f.diffLineCount)],
  );
}

export async function getModelUsageStats(env: Pick<AppBindings, 'HYPERDRIVE'>, days: number) {
  return queryRows<{
    model_used: string;
    model_provider: string | null;
    calls: number;
    input_tokens: number | null;
    output_tokens: number | null;
  }>(
    env,
    `
      SELECT
        model_used,
        MIN(model_provider) AS model_provider,
        COUNT(*)::int AS calls,
        COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS output_tokens
      FROM file_reviews
      WHERE created_at >= now() - ($1::int * interval '1 day')
      GROUP BY model_used
      ORDER BY calls DESC, model_used ASC
    `,
    [days],
  );
}

export async function getFileReviewsForJobs(env: Pick<AppBindings, 'HYPERDRIVE'>, jobIds: string[]) {
  if (jobIds.length === 0) return [];

  const rows = await queryRows<{
    id: string;
    job_id: string;
    file_path: string;
    file_status: 'pending' | 'done' | 'skipped' | 'failed';
    model_used: string;
    diff_line_count: number;
    diff_input: string | null;
    raw_ai_output: string | null;
    parsed_comments: ParsedReviewComment[] | string;
    input_tokens: number | null;
    output_tokens: number | null;
    duration_ms: number | null;
    verdict: 'approve' | 'comment' | null;
    file_summary: string | null;
    overall_correctness: string | null;
    confidence_score: number | null;
    error_msg: string | null;
    model_provider: string | null;
    transient_error_count: number;
    async_request_id: string | null;
    async_model: string | null;
    withheld_counts: { evidence?: number; claimDenied?: number } | string | null;
  }>(
    env,
    `
      SELECT
        fr.*,
        ${reviewCommentsAggregate()} AS parsed_comments
      FROM file_reviews fr
      WHERE fr.job_id = ANY($1::uuid[])
      ORDER BY fr.created_at ASC
    `,
    [jobIds],
  );

  return rows.map((row) => ({
    ...row,
    parsed_comments: parseJsonColumn(row.parsed_comments, []),
    withheld_counts: parseJsonColumn(row.withheld_counts, {} as { evidence?: number; claimDenied?: number }),
  }));
}

export type SuppressedFinding = {
  fingerprint: string | null;
  /** Null for repo-wide rejections, which suppress regardless of what the code now says. */
  anchor_hash: string | null;
  /** Title-independent identity; already includes the anchor, so it needs no separate anchor check. */
  fingerprint_v2: string | null;
  /** True when this came from an earlier posted comment rather than from human rejection. */
  anchored: boolean;
};

/**
 * Findings that must not be posted again for this job's pull request.
 *
 * Two sources, one round trip:
 *   - already posted on an EARLIER COMMIT of this PR, and the anchored line is unchanged. Without
 *     this every push re-posts the same unfixed comment.
 *   - rejected by a human anywhere in this repository (they deleted the comment).
 *
 * `j.commit_sha <> me.commit_sha` is load-bearing: the retry API and mention-triggered re-reviews
 * both reuse the SAME head commit, so without it a manual re-review would match every fingerprint
 * the previous run posted and produce an empty, summary-only review.
 *
 * The join is driven from `jobs`, so jobs_repo_idx -> file_reviews_job_idx ->
 * review_comments_file_idx already cover it.
 */
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

/**
 * Resolves a finding fingerprint WITHIN a specific job, for the dashboard labelling route.
 *
 * This lookup is the authorization boundary, not a convenience. A dashboard label writes a
 * REPOSITORY-WIDE suppression, so without scoping it to a job the caller owns, anyone could silence
 * an arbitrary finding by guessing eight hex characters. Returns null when the fingerprint is not
 * part of this job, which the route turns into a 404.
 */
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

/**
 * Record which findings actually reached GitHub, so later commits on the same PR can suppress them.
 *
 * Only the fingerprints GitHub genuinely accepted may be passed here. Marking a finding posted when
 * it was silently dropped (the 422 fallback re-posts a review with zero inline comments, and
 * comments with no usable line anchor are filtered client-side) would hide it forever.
 */
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

/**
 * Record WHY each finding did not reach the pull request.
 *
 * `posted = false` on its own conflates six different outcomes -- the severity gate, the confidence
 * gate, cross-run suppression, dedupe, the verifier, and the max_comments cap. That ambiguity is
 * what made the corpus unusable for evaluation: "P3 has never been posted" turned out to be mostly
 * an artifact of P3 sorting last and the cap slicing from the end, not evidence that P3 findings are
 * wrong. Attribution has to be recorded at the moment the decision is made.
 *
 * One statement regardless of how many stages fired, so finalize's subrequest cost is unchanged.
 */
export async function markCommentDispositions(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  byFingerprint: Map<string, { disposition: string | null; reason: string | null }>,
): Promise<void> {
  if (byFingerprint.size === 0) return;
  const fingerprints = [...byFingerprint.keys()];
  const dispositions = fingerprints.map((fp) => byFingerprint.get(fp)!.disposition);
  const reasons = fingerprints.map((fp) => byFingerprint.get(fp)!.reason);

  // A posted finding's disposition is never rewritten.
  //
  // Two reasons, and the second was observed corrupting production data. First, a KEPT finding is
  // entered here with a null disposition purely to carry its verifier reason, so an unconditional
  // assignment would null out `posted`. Second -- and this is the subtle one -- the disposition map is
  // keyed on FINGERPRINT, and fingerprints are `hash(path + normalized title)`, so two findings on the
  // same file with the same title share one. When one of them is suppressed and the other is posted,
  // this UPDATE matches BOTH rows and wrote 'suppression' over 'posted'. Observed on two P0s that were
  // genuinely posted to GitHub yet recorded as suppressed, which corrupts the disposition data this
  // exists to produce.
  //
  // `posted` is the fact GitHub gave us; a disposition is our inference about why something did not
  // post. The fact wins.
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
