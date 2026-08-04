/**
 * Subrequest budget arithmetic for the review loop. Pure functions over the Workers Free plan's
 * 50-subrequests-per-invocation limit; no env, no I/O.
 */

// Subrequest cost of one file review, sizing how many files a chunk runs concurrently against the
// remaining budget (see budgetAwareFileLimit). Derived from the configured chain rather than a flat
// 5, because a rate-limited primary sends the file down a nine-model chain and blows the cap.
//
// KEEP THE SHORT-CHAIN RESULT AT 5 OR BELOW. Fresh-budget headroom is 25 after SAFE_MARGIN, and
// floor(25 / 5) == 5 honours even the "max" concurrency level. At 8, floor(25 / 8) == 3 silently
// caps that slider at 3 — the regression pinned by chunk-concurrency.spec.ts.
/** Per-file cost that isn't the model call: the persisted-review write and its lookups. */
const FILE_FIXED_SUBREQUESTS = 2;
/**
 * Ceiling on how many model attempts we budget for per file. Chains longer than this are common
 * (nine is not unusual) but a file that needs more than four attempts is failing for a reason that
 * a fifth won't fix, and budgeting for the full chain would collapse concurrency to one.
 */
const MAX_MODEL_ATTEMPTS_ESTIMATE = 4;

/**
 * How many files a single review chunk may process concurrently: the configured concurrency
 * level, capped only by what the invocation's remaining subrequest budget can safely cover.
 *
 * The cap is deliberately sized so it does NOT silently override the user's chosen concurrency
 * at a healthy budget -- that would make the concurrency setting a no-op above the cap. It
 * only throttles once earlier failures in this invocation have actually eaten into the budget;
 * if there is not enough safe budget for one more file, the chunk yields and resumes in a fresh
 * invocation instead of gambling past the margin. Any files a throttled chunk can't reach roll
 * into the next chunk. The
 * chunk-file-limit-honors-configured-level invariant is pinned by a regression test.
 */
export function budgetAwareFileLimit(
  remainingSafeBudget: number,
  configuredChunkFileLimit: number,
  modelChainLength = 1,
) {
  const budgetLimit = Math.floor(remainingSafeBudget / estimatedSubrequestsPerFile(modelChainLength));
  return Math.min(configuredChunkFileLimit, budgetLimit);
}

/**
 * What one file can actually cost, given how many models it may walk through.
 *
 * The flat estimate of 5 assumed the primary model answers. With a long fallback chain and a
 * rate-limited primary it doesn't: the file walks the chain, each attempt is a subrequest, and
 * three files started on the strength of a 5-per-file estimate can spend far more than the
 * invocation's whole budget. Quota failures are now capped, so the realistic worst case is a
 * couple of quota attempts or a handful of genuine errors -- but with a nine-model chain that is
 * still well above 5, and concurrency has to shrink to match rather than discover it by failing.
 */
export function estimatedSubrequestsPerFile(modelChainLength: number) {
  const modelAttempts = Math.max(1, Math.min(modelChainLength, MAX_MODEL_ATTEMPTS_ESTIMATE));
  return FILE_FIXED_SUBREQUESTS + modelAttempts;
}
