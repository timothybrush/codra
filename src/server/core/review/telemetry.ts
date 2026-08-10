import { logger } from '../logger';
import type { AppBindings } from '@server/env';
import { getSuppressedFindings } from '@server/db/file-reviews';
import { sendTelemetryEvent } from '../telemetry';
import { type PersistedReviewJob } from './phase-control';
import { bareModelId } from './retry-policy';
// Sibling of core/review.ts -- import from that barrel, not from here.

// Success/all-failed fields come in as `overrides`. Token/model data comes from `done` reviews only, so failed or inherited rows don't deflate totals.
export async function sendReviewTelemetry(
  env: AppBindings,
  job: PersistedReviewJob,
  files: Array<{ path: string; lineCount: number }>,
  reviews: Array<{ file_status: string; input_tokens: number | null; output_tokens: number | null; model_used: string }>,
  overrides: { findingsReported: number; verdict: string; severityDistribution: Record<string, number> },
  meta: { concurrencyLevel: string; retryCount: number },
) {
  try {
    const doneReviews = reviews.filter((r) => r.file_status === 'done');

    const cleanModels = Array.from(
      new Set(
        doneReviews.flatMap((r) => {
          const model = bareModelId(r.model_used);
          return model && !model.toLowerCase().includes('test') ? [model] : [];
        }),
      ),
    );

    const extractExtension = (filePath: string): string => {
      const name = filePath.split('/').pop() || filePath;
      const dotIndex = name.lastIndexOf('.');
      if (dotIndex <= 0) return '';
      return name.slice(dotIndex + 1).toLowerCase();
    };

    await sendTelemetryEvent(env, {
      linesReviewed: files.reduce((sum, file) => sum + file.lineCount, 0),
      inputTokens: doneReviews.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0),
      outputTokens: doneReviews.reduce((sum, r) => sum + (r.output_tokens ?? 0), 0),
      modelsUsed: cleanModels,
      fileExtensions: Array.from(new Set(files.flatMap((f) => {
        const extension = extractExtension(f.path);
        return extension ? [extension] : [];
      }))),
      triggerType: job.trigger,
      reviewDurationMs: Math.max(0, Date.now() - new Date(job.createdAt).getTime()),
      filesReviewed: files.length,
      concurrencyLevel: meta.concurrencyLevel,
      prTotalLinesChanged: files.reduce((sum, file) => sum + file.lineCount, 0),
      retryCount: meta.retryCount,
      ...overrides,
    });
  } catch (e) {
    logger.error('Failed to send telemetry', e instanceof Error ? e : new Error(String(e)));
  }
}

// `posted` requires both fingerprint and anchor hash to match, so an edit to the flagged line re-raises it; `rejected` suppresses on fingerprint alone.
export async function loadSuppressedFingerprints(env: AppBindings, jobId: string) {
  const posted = new Map<string, Set<string>>();
  const rejected = new Set<string>();
  // v2 already contains the anchor hash, so membership alone means "same file, same claim class, byte-identical line".
  const postedV2 = new Set<string>();
  const rejectedV2 = new Set<string>();

  try {
    for (const row of await getSuppressedFindings(env, jobId)) {
      if (!row.anchored) {
        if (row.fingerprint) rejected.add(row.fingerprint);
        if (row.fingerprint_v2) rejectedV2.add(row.fingerprint_v2);
        continue;
      }
      if (row.fingerprint_v2) postedV2.add(row.fingerprint_v2);
      if (!row.fingerprint || !row.anchor_hash) continue;
      const anchors = posted.get(row.fingerprint) ?? new Set<string>();
      anchors.add(row.anchor_hash);
      posted.set(row.fingerprint, anchors);
    }
  } catch (error) {
    logger.warn('Could not load suppressed findings; posting without cross-run dedupe', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { posted, rejected, postedV2, rejectedV2 };
}
