// Subrequest budget arithmetic for the review loop. Pure functions over the Workers Free plan's
// 50-subrequests-per-invocation limit; no env, no I/O.
//
// KEEP `estimatedSubrequestsPerFile` AT 6 OR BELOW. Fresh-budget headroom is 25 after SAFE_MARGIN,
// and floor(25 / 6) == 4 still honours the "max" concurrency level, which is 4. At 8,
// floor(25 / 8) == 3 silently caps that slider at 3, the regression pinned by
// chunk-concurrency.spec.ts.

// Per-file cost that isn't the model call: the persisted-review write and its lookups.
const FILE_FIXED_SUBREQUESTS = 2;

// Model attempts budgeted per file. Chains of nine are common, but a file needing a fifth attempt is
// failing for a reason a fifth won't fix, and budgeting the full chain collapses concurrency to one.
const MAX_MODEL_ATTEMPTS_ESTIMATE = 4;

// Files a chunk may review concurrently: the configured level, capped by remaining safe budget.
//
// It must NOT silently override the user's choice at a healthy budget, which would make the
// concurrency setting a no-op. It only throttles once earlier failures have eaten into the budget;
// files a throttled chunk cannot reach roll into the next one.
export function budgetAwareFileLimit(
  remainingSafeBudget: number,
  configuredChunkFileLimit: number,
  modelChainLength = 1,
) {
  const budgetLimit = Math.floor(remainingSafeBudget / estimatedSubrequestsPerFile(modelChainLength));
  return Math.min(configuredChunkFileLimit, budgetLimit);
}

// Derived from the configured chain, not a flat 5. A flat estimate assumes the primary model
// answers; with a rate-limited primary the file walks the chain, each attempt costs a subrequest,
// and three files started on that assumption can spend the whole invocation budget.
export function estimatedSubrequestsPerFile(modelChainLength: number) {
  const modelAttempts = Math.max(1, Math.min(modelChainLength, MAX_MODEL_ATTEMPTS_ESTIMATE));
  return FILE_FIXED_SUBREQUESTS + modelAttempts;
}
