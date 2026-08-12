// @codra/core -- the review engine.
//
// Depends on @codra/schema and its own ports, and on nothing else: no HTTP framework, no database
// driver, no platform bindings, no git-provider SDK. Everything environment-specific arrives through
// the ReviewRuntime a host assembles (see ./ports).
//
// The entrypoint is `runReview(runtime, message)`, which runs one phase of one review job. See its
// doc comment for the driver contract.
export {
  runReview,
  type ReviewJobRunResult,
  // Phase plumbing the driver needs: the inter-phase sleep floor and the transition signal.
  FRESH_INVOCATION_YIELD_SECONDS,
  NextPhaseError,
  failJobAndCheckRun,
  // Trigger detection, for a host that receives webhooks before it has a job.
  extractReviewRequest,
  type ReviewRequest,
  // Diff access, shared with hosts that surface a finished job's diff.
  getDiffFiles,
  getOrFetchRawDiffForCompletedJob,
  // Budget and packing, exposed because they are the engine's documented capacity model.
  budgetAwareFileLimit,
  estimatedSubrequestsPerFile,
  BIN_DIFF_CHAR_BUDGET,
  BIN_MAX_FILES,
  BIN_TARGET_DIFF_LINES,
  PACKABLE_MAX_DIFF_LINES,
  narrowUnit,
  planReviewUnits,
  unitFiles,
  proportionalSplit,
  type LedgerEntry,
  type ReviewUnit,
  // The verification gate, used directly by finding-quality suites.
  verifyFindings,
  type VerifyDrop,
  type VerifyOutcome,
} from './review';

export type * from './ports';
