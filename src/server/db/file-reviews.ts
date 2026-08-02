import type { ParsedReviewComment } from '@shared/schema';
import type { AppBindings } from '@server/env';
import { parseJsonColumn, queryRows, queryTransaction } from './client';

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
      const paths = input.parsedComments.map(c => c.path);
      const lines = input.parsedComments.map(c => c.line ?? null);
      const positions = input.parsedComments.map(c => c.position ?? null);
      const severities = input.parsedComments.map(c => c.severity);
      const categories = input.parsedComments.map(c => c.category);
      const titles = input.parsedComments.map(c => c.title);
      const bodies = input.parsedComments.map(c => c.body);
      const codeSuggestions = input.parsedComments.map(c => c.codeSuggestion ?? null);
      const confidenceScores = input.parsedComments.map(c => c.confidenceScore ?? null);

      await tx.query(
        `
          INSERT INTO review_comments (
            file_review_id, path, line, position, severity, category, title, body, code_suggestion, confidence_score
          )
          SELECT $1::uuid, * FROM UNNEST($2::text[], $3::int[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::real[])
        `,
        [review.id, paths, lines, positions, severities, categories, titles, bodies, codeSuggestions, confidenceScores]
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
          async_model
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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
      ],
    );

    await tx.query('DELETE FROM review_comments WHERE file_review_id = $1::uuid', [review.id]);

    if (input.parsedComments.length > 0) {
      await tx.query(
        `
          INSERT INTO review_comments (
            file_review_id, path, line, position, severity, category, title, body, code_suggestion, confidence_score
          )
          SELECT $1::uuid, * FROM UNNEST($2::text[], $3::int[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::real[])
        `,
        [
          review.id,
          input.parsedComments.map(c => c.path),
          input.parsedComments.map(c => c.line ?? null),
          input.parsedComments.map(c => c.position ?? null),
          input.parsedComments.map(c => c.severity),
          input.parsedComments.map(c => c.category),
          input.parsedComments.map(c => c.title),
          input.parsedComments.map(c => c.body),
          input.parsedComments.map(c => c.codeSuggestion ?? null),
          input.parsedComments.map(c => c.confidenceScore ?? null),
        ],
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
      await tx.query(
        `
          INSERT INTO review_comments (
            file_review_id, path, line, position, severity, category, title, body, code_suggestion, confidence_score
          )
          SELECT nw.new_id, rc.path, rc.line, rc.position, rc.severity, rc.category, rc.title, rc.body, rc.code_suggestion, rc.confidence_score
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

export async function getModelUsageStats(env: Pick<AppBindings, 'HYPERDRIVE'>) {
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
      GROUP BY model_used
      ORDER BY calls DESC, model_used ASC
    `,
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
  }>(
    env,
    `
      SELECT
        fr.*,
        COALESCE(
          (
            SELECT JSON_AGG(
              JSON_BUILD_OBJECT(
                'path', rc.path,
                'line', rc.line,
                'position', rc.position,
                'severity', rc.severity,
                'category', rc.category,
                'title', rc.title,
                'body', rc.body,
                'codeSuggestion', rc.code_suggestion,
                'confidenceScore', rc.confidence_score
              )
            ORDER BY rc.id ASC
            ) FROM review_comments rc WHERE rc.file_review_id = fr.id
          ),
          '[]'::json
        ) AS parsed_comments
      FROM file_reviews fr
      WHERE fr.job_id = ANY($1::uuid[])
      ORDER BY fr.created_at ASC
    `,
    [jobIds],
  );

  return rows.map((row) => ({
    ...row,
    parsed_comments: parseJsonColumn(row.parsed_comments, []),
  }));
}
