import type { AppBindings } from '@server/env';

// Sibling of db/jobs.ts -- import from that barrel, not from here.
//
// The KV "is anything running" flag, which the scheduled maintenance loop reads to decide whether it
// can skip the DB entirely and let the serverless Postgres suspend.
//
// A leaf on purpose: jobs-leases.ts and jobs-lifecycle.ts both write this flag, and jobs.ts imports
// both. Keeping it here instead of in the barrel is what stops that becoming an import cycle
// (import-x/no-cycle is an error).

export async function markSystemActive(env: Pick<AppBindings, 'APP_KV'>) {
  try {
    // claimJobLease() calls this on every review chunk, so a single large PR (dozens of chunks) used
    // to issue dozens of identical KV writes -- enough to blow through the Workers-Free daily KV
    // write quota. KV reads are far cheaper and have a much higher quota, so read first and only
    // write when the flag is actually missing (expired, or the first job after an idle period). The
    // 20-minute TTL means an active job refreshes it at most ~once per 20 minutes, not per chunk.
    const existing = await env.APP_KV.get('system:active_jobs');
    if (existing) return;
    await env.APP_KV.put('system:active_jobs', '1', { expirationTtl: 20 * 60 });
  } catch (error) {
  // Ignore KV errors to avoid failing the DB transaction
  }
}

export async function clearSystemActive(env: Pick<AppBindings, 'APP_KV'>) {
  try {
    await env.APP_KV.delete('system:active_jobs');
  } catch (error) {
  // Best-effort: the 20-minute TTL on the flag is the backstop if this delete fails.
  }
}
