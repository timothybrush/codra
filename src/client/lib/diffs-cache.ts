/**
 * Session cache for a job's per-file diffs.
 *
 * `diff_input` isn't persisted in Postgres (it is reconstructed on demand from KV/GitHub, see
 * GET /api/jobs/:id/diffs), so both the Files-changed tab and the Logs page fetch it lazily. They
 * share one key so switching between them doesn't refetch.
 *
 * One module because there were two copies and they drifted: only one carried the size guard, so
 * the Logs page hit exactly the jank the other copy documents.
 */

const cacheKey = (jobId: string) => `codra:job-diffs:${jobId}`;

// Serializing multi-MB diffs janks the main thread and evicts everything else in sessionStorage.
// Giant PRs just refetch, since the server-side KV cache is warm.
const MAX_CACHED_CHARS = 2_000_000;

export function readDiffsCache(jobId: string): Record<string, string> | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(jobId));
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export function writeDiffsCache(jobId: string, diffs: Record<string, string>) {
  try {
    const payload = JSON.stringify(diffs);
    if (payload.length > MAX_CACHED_CHARS) return;
    sessionStorage.setItem(cacheKey(jobId), payload);
  } catch {
    /* quota exceeded / unavailable - skip */
  }
}
