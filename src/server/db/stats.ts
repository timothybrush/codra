import type { AppBindings } from '@server/env';
import { queryRows } from './client';
import { statsSchema, jobStatuses, reviewTriggers, reviewSeverities, reviewCategories } from '@shared/schema';
import { getModelUsageStats } from './file-reviews';

/** Guard the zone before it reaches SQL, so an unknown name can't error the query. */
function isSupportedTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const jobStatusSet = new Set<string>(jobStatuses);
const reviewTriggerSet = new Set<string>(reviewTriggers);
const reviewSeveritySet = new Set<string>(reviewSeverities);
const reviewCategorySet = new Set<string>(reviewCategories);

/**
 * Day buckets are grouped in `timeZone` so the trend lines up with the timestamps
 * shown elsewhere in the dashboard. `created_at` is `timestamptz` (absolute), and
 * `AT TIME ZONE <zone>` converts it to wall-clock time in that zone before
 * truncating, so a job at 03:00 IST lands on the IST day rather than the UTC one.
 * Defaults to UTC, matching the client's default display zone.
 */
export async function getStats(env: Pick<AppBindings, 'HYPERDRIVE'>, days = 30, timeZone = 'UTC') {
  const parsedDays = Number(days);
  const safeDays = Number.isFinite(parsedDays) ? Math.trunc(parsedDays) : 30;
  const clampedDays = Math.min(Math.max(safeDays, 1), 365);
  const zone = isSupportedTimeZone(timeZone) ? timeZone : 'UTC';
  const [[totals], dailyRows, verdictRows, topRepos, modelRows, statusRows, triggerRows, severityRows, categoryRows, [performanceRow]] = await Promise.all([
    queryRows<{
      jobs: number;
      input_tokens: number;
      output_tokens: number;
      comments: number;
    }>(
      env,
      `
        SELECT
          COUNT(*)::int AS jobs,
          COALESCE(SUM(total_input_tokens), 0)::int AS input_tokens,
          COALESCE(SUM(total_output_tokens), 0)::int AS output_tokens,
          COALESCE(SUM(comment_count), 0)::int AS comments
        FROM jobs
        WHERE created_at >= now() - ($1::int * interval '1 day')
      `,
      [clampedDays],
    ),
    queryRows<{ day: string; jobs: number; input_tokens: number; output_tokens: number; comments: number }>(
      env,
      `
        SELECT
          TO_CHAR(DATE_TRUNC('day', created_at AT TIME ZONE $2), 'YYYY-MM-DD') AS day,
          COUNT(*)::int AS jobs,
          COALESCE(SUM(total_input_tokens), 0)::int AS input_tokens,
          COALESCE(SUM(total_output_tokens), 0)::int AS output_tokens,
          COALESCE(SUM(comment_count), 0)::int AS comments
        FROM jobs
        WHERE created_at >= now() - ($1::int * interval '1 day')
        GROUP BY DATE_TRUNC('day', created_at AT TIME ZONE $2)
        ORDER BY day ASC
      `,
      [clampedDays, zone],
    ),
    queryRows<{ verdict: 'approve' | 'comment' | null; count: number }>(
      env,
      `
        SELECT verdict, COUNT(*)::int AS count
        FROM jobs
        GROUP BY verdict
        ORDER BY count DESC
      `,
    ),
    queryRows<{ owner: string; repo: string; jobs: number }>(
      env,
      `
        SELECT r.owner, r.repo, COUNT(*)::int AS jobs
        FROM jobs j
        JOIN repositories r ON j.repository_id = r.id
        WHERE j.created_at >= now() - ($1::int * interval '1 day')
        GROUP BY r.owner, r.repo
        ORDER BY jobs DESC, r.owner ASC, r.repo ASC
        LIMIT 10
      `,
      [clampedDays],
    ),
    getModelUsageStats(env, clampedDays),
    queryRows<{ status: string; count: number }>(
      env,
      `
        SELECT status, COUNT(*)::int AS count
        FROM jobs
        WHERE created_at >= now() - ($1::int * interval '1 day')
        GROUP BY status
        ORDER BY count DESC
      `,
      [clampedDays],
    ),
    queryRows<{ trigger: string; count: number }>(
      env,
      `
        SELECT trigger, COUNT(*)::int AS count
        FROM jobs
        WHERE created_at >= now() - ($1::int * interval '1 day')
        GROUP BY trigger
        ORDER BY count DESC
      `,
      [clampedDays],
    ),
    queryRows<{ severity: string; count: number }>(
      env,
      `
        SELECT rc.severity, COUNT(*)::int AS count
        FROM review_comments rc
        JOIN file_reviews fr ON fr.id = rc.file_review_id
        WHERE fr.created_at >= now() - ($1::int * interval '1 day')
        GROUP BY rc.severity
        ORDER BY count DESC
      `,
      [clampedDays],
    ),
    queryRows<{ category: string; count: number }>(
      env,
      `
        SELECT rc.category, COUNT(*)::int AS count
        FROM review_comments rc
        JOIN file_reviews fr ON fr.id = rc.file_review_id
        WHERE fr.created_at >= now() - ($1::int * interval '1 day')
        GROUP BY rc.category
        ORDER BY count DESC
      `,
      [clampedDays],
    ),
    queryRows<{ avg_duration_ms: number | null; p95_duration_ms: number | null; avg_confidence: number | null }>(
      env,
      `
        SELECT
          AVG(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) AS avg_duration_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) AS p95_duration_ms,
          AVG(overall_confidence_score) AS avg_confidence
        FROM jobs
        WHERE finished_at IS NOT NULL AND started_at IS NOT NULL AND created_at >= now() - ($1::int * interval '1 day')
      `,
      [clampedDays],
    ),
  ]);

  return statsSchema.parse({
    totals: {
      jobs: totals?.jobs ?? 0,
      inputTokens: totals?.input_tokens ?? 0,
      outputTokens: totals?.output_tokens ?? 0,
      comments: totals?.comments ?? 0,
    },
    trend: dailyRows.map((row) => ({ 
      day: row.day, 
      jobs: row.jobs,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      comments: row.comments
    })),
    verdicts: verdictRows.map((row) => ({ verdict: row.verdict, count: row.count })),
    models: modelRows.map((row) => ({
      modelUsed: row.model_used,
      provider: row.model_provider ?? undefined,
      calls: row.calls,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
    })),
    topRepos: topRepos.map((row) => ({ owner: row.owner, repo: row.repo, jobs: row.jobs })),
    // Drop any rows whose enum-typed column holds an unexpected value (e.g. legacy
    // rows back-migrated from JSON, where severity/category have no DB CHECK
    // constraint). Keeping them would fail statsSchema.parse and 500 the endpoint.
    statuses: statusRows.filter((row) => jobStatusSet.has(row.status)).map((row) => ({ status: row.status as (typeof jobStatuses)[number], count: row.count })),
    triggers: triggerRows.filter((row) => reviewTriggerSet.has(row.trigger)).map((row) => ({ trigger: row.trigger as (typeof reviewTriggers)[number], count: row.count })),
    severities: severityRows.filter((row) => reviewSeveritySet.has(row.severity)).map((row) => ({ severity: row.severity as (typeof reviewSeverities)[number], count: row.count })),
    categories: categoryRows.filter((row) => reviewCategorySet.has(row.category)).map((row) => ({ category: row.category as (typeof reviewCategories)[number], count: row.count })),
    performance: {
      avgDurationMs: performanceRow?.avg_duration_ms != null ? Math.round(performanceRow.avg_duration_ms) : null,
      p95DurationMs: performanceRow?.p95_duration_ms != null ? Math.round(performanceRow.p95_duration_ms) : null,
      avgConfidence: performanceRow?.avg_confidence ?? null,
    },
  });
}
