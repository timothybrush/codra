// Subrequest budget arithmetic for the review loop. Pure functions over the Workers Free plan's 50-subrequests-per-invocation limit; no env, no I/O.
// KEEP `estimatedSubrequestsPerFile` AT 6 OR BELOW: fresh-budget headroom is 25 after SAFE_MARGIN, and floor(25 / 6) == 4 still honours the "max" concurrency level of 4; at 8, floor(25 / 8) == 3 silently caps that slider (regression pinned by chunk-concurrency.spec.ts).

// Per-file cost that isn't the model call: the persisted-review write and its lookups.
const FILE_FIXED_SUBREQUESTS = 2;

// Model attempts budgeted per file. Budgeting the full chain would collapse concurrency to one; SAFE_MARGIN absorbs attempts that cost more than one subrequest (google.ts grammar probe).
const MAX_MODEL_ATTEMPTS_ESTIMATE = 4;

// Files a chunk may review concurrently: the configured level, capped by remaining safe budget. Must NOT silently override the user's choice at a healthy budget; it only throttles once earlier failures have eaten into it.
export function budgetAwareFileLimit(
  remainingSafeBudget: number,
  configuredChunkFileLimit: number,
  modelChainLength = 1,
) {
  const budgetLimit = Math.floor(remainingSafeBudget / estimatedSubrequestsPerFile(modelChainLength));
  return Math.min(configuredChunkFileLimit, budgetLimit);
}

// Derived from the configured chain, not a flat 5: a flat estimate assumes the primary model answers, but a rate-limited primary walks the chain and each attempt costs a subrequest.
export function estimatedSubrequestsPerFile(modelChainLength: number) {
  const modelAttempts = Math.max(1, Math.min(modelChainLength, MAX_MODEL_ATTEMPTS_ESTIMATE));
  return FILE_FIXED_SUBREQUESTS + modelAttempts;
}
