import type { AppBindings } from '@server/env';

// Import from db/jobs.ts, not here. Holds the KV "is anything running" flag the maintenance loop reads to decide whether it can skip the DB and let Postgres suspend.
// Kept as a leaf, not in the barrel, because jobs-leases.ts and jobs-lifecycle.ts both write this flag and jobs.ts imports both, which would otherwise create an import cycle.

export async function markSystemActive(env: Pick<AppBindings, 'APP_KV'>) {
  try {
    // claimJobLease() calls this on every review chunk; read first and only write when missing, since a large PR's dozens of chunks otherwise blow the Workers-Free daily KV write quota.
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
