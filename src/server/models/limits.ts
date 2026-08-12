// Two Workers Free-plan constraints shape all of it: (1) at most 6 connections per invocation may await headers at once, or the runtime silently queues and burns the call's own timeout undispatched; (2) 50 subrequests per invocation, so a queued-then-timed-out call is a wasted one.

// Base budget for a small diff. A suitable model answers in ~1-5s; slower means stuck or queued.
export const MODEL_TIMEOUT_BASE_MS = 20_000;
const MODEL_TIMEOUT_PER_LINE_MS = 100;
const MODEL_TIMEOUT_FREE_LINES = 100;
// Hard ceiling for one call, still well under the ~120s invocation wall clock: at the old 120s ceiling a hung call took the whole invocation down as `exceededCpu` instead of failing over.
export const MODEL_TIMEOUT_MAX_MS = 50_000;

// Budget for one file's entire fallback chain; past this, defer the file to RESUME AT THE NEXT MODEL in
// a fresh invocation (ModelChainProgressStore holds the position, so nothing is replayed). Deliberately
// only a little above MODEL_TIMEOUT_MAX_MS: a big bin therefore spends an invocation on ONE model and
// gets the full ceiling to itself, rather than splitting the budget and giving every model too little.
// The chain still gets walked, one model per continuation, bounded by MAX_RETRYABLE_FILE_REVIEW_FAILURES.
export const MODEL_FALLBACK_CHAIN_BUDGET_MS = 55_000;

// What an answer costs in wall clock, per 1,000 output tokens the caller has asked room for. Latency
// here tracks how much the model WRITES (and thinks), which the diff size only loosely predicts: a
// two-file bin is 60 diff lines and therefore got the 20s base, while its median answer took 18s on
// gemini-2.5-flash and 31% of those calls overran the ceiling their diff size had earned them. Sizing
// the timeout off the same `reviewOutputBudgetTokens` figure the prompt is built from removes that
// mismatch, and the MODEL_TIMEOUT_MAX_MS cap still bounds the worst case.
const MODEL_TIMEOUT_PER_1K_OUTPUT_MS = 1_200;

// Per-call timeout, scaled by the (already truncated) diff being reviewed AND by the size of the answer
// being requested. `outputBudgetTokens` is optional: a caller that omits it keeps the old arithmetic
// exactly, so the verify and summary paths are unaffected.
export function adaptiveModelTimeoutMs(
  diffLineCount: number | null | undefined,
  outputBudgetTokens?: number | null,
): number {
  const lines = typeof diffLineCount === 'number' && Number.isFinite(diffLineCount) ? Math.max(0, diffLineCount) : 0;
  const scaled = MODEL_TIMEOUT_BASE_MS + Math.max(0, lines - MODEL_TIMEOUT_FREE_LINES) * MODEL_TIMEOUT_PER_LINE_MS;

  const budget = typeof outputBudgetTokens === 'number' && Number.isFinite(outputBudgetTokens)
    ? Math.max(0, outputBudgetTokens)
    : 0;
  // Only the room ABOVE the floor earns extra time: every caller asks for at least the floor.
  const answerAllowance = Math.max(0, budget - OUTPUT_TOKENS_FLOOR) / 1_000 * MODEL_TIMEOUT_PER_1K_OUTPUT_MS;

  return Math.min(MODEL_TIMEOUT_MAX_MS, scaled + answerAllowance);
}

// One call must always fit the chain budget, or the HEAD of every chain would be deferred before it
// ever ran -- a job that never calls a model at all. Enforced here rather than at the call sites so
// raising MODEL_TIMEOUT_MAX_MS past the chain budget cannot quietly produce that.
export function clampTimeoutToChainBudget(timeoutMs: number): number {
  return Math.min(timeoutMs, MODEL_FALLBACK_CHAIN_BUDGET_MS);
}

// Kept below the runtime's 6-connection cap so KV/Hyperdrive/GitHub requests from concurrent file reviews still find a free slot.
export const MAX_CONCURRENT_MODEL_CALLS = 3;

// What one finding costs on the wire: a body capped at 160 words (~210 tokens), an `evidence` quote, a
// title, an optional `code_suggestion`, and the JSON scaffolding around them. Deliberately generous --
// under-budgeting truncates the response, and a truncated response is repaired into valid JSON with its
// tail findings silently gone (see the finishReason note in google.ts), which reads as "the file is clean".
const OUTPUT_TOKENS_PER_FINDING = 340;
// Per file entry in a batched response: the path, `overall_explanation`, `overall_correctness`.
const OUTPUT_TOKENS_PER_FILE_ENTRY = 160;
// Enough for the verify/summary paths and any caller that states no budget.
export const OUTPUT_TOKENS_FLOOR = 8_192;

// Room the ANSWER needs -- reasoning tokens are NOT included, and adapters that bill thinking against
// the same ceiling must add their thinking budget on top of this rather than carve it out of it.
//
// Sized from the ASK, not from the diff: a bin told it may return N findings per file across F files
// must be able to emit F*N of them, or the instruction and the ceiling contradict each other and the
// model resolves that by returning almost nothing. Callers pass this as `ModelInput.outputBudgetTokens`;
// each adapter clamps it to its own provider maximum.
export function reviewOutputBudgetTokens(input: { findingCap: number; fileCount: number }): number {
  const files = Math.max(1, input.fileCount);
  const findings = Math.max(1, input.findingCap) * files;
  return Math.max(
    OUTPUT_TOKENS_FLOOR,
    findings * OUTPUT_TOKENS_PER_FINDING + files * OUTPUT_TOKENS_PER_FILE_ENTRY,
  );
}

// Clamps a caller's requested ceiling into what one provider actually accepts. Centralised so a raised
// `providerMax` cannot silently apply to a caller that never asked for the room.
export function resolveOutputTokenCeiling(
  requested: number | undefined,
  providerMax: number,
  providerDefault: number,
): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return Math.min(providerDefault, providerMax);
  }
  return Math.min(providerMax, Math.max(providerDefault, Math.ceil(requested)));
}

// Gemini 2.5 bills `thoughtsTokenCount` against the SAME `maxOutputTokens` the JSON has to fit in, and
// with no explicit budget it thinks dynamically -- it can consume the whole ceiling and emit only a
// prefix of the answer. Bounding it is what makes the answer budget mean something; the caller then adds
// this ON TOP of the answer budget, so thinking can never eat into it.
// Floored at 1024 and ceilinged at 8192: 0 is refused outright by the Pro models, and every 2.5 model
// accepts a budget in this band.
export function geminiThinkingBudgetTokens(answerBudgetTokens: number): number {
  return Math.min(8_192, Math.max(1_024, Math.floor(answerBudgetTokens / 4)));
}

// What one attempt can actually cost, as opposed to the ~1 that review/budget.ts budgets it at: the
// Gemini adapter retries transport errors and may re-probe without its grammar, and a deferral writes
// chain progress to KV.
const SUBREQUESTS_PER_MODEL_ATTEMPT = 3;

// Headroom a unit must see before it commits a prompt to the wire. Times the concurrency cap because
// the check cannot reserve: every in-flight unit may pass it in the same tick and only then start
// spending, so the floor has to hold for all of them at once.
//
// Why a hard floor at all, when budgetAwareFileLimit already sized the chunk: that limit is computed
// ONCE from the budget at dispatch time and deliberately under-counts (see the note on
// estimatedSubrequestsPerFile), so a chain would transmit full prompts and learn the invocation was out
// of subrequests only from the runtime's refusal -- observed paying for three files' prompts before
// aborting. Declining to start costs nothing, and the unit defers to a fresh budget with its place in
// the chain remembered.
export const SUBREQUEST_HEADROOM_FOR_MODEL_CALL = SUBREQUESTS_PER_MODEL_ATTEMPT * MAX_CONCURRENT_MODEL_CALLS;

// Tiny FIFO semaphore; callers wait *before* their provider timeout starts, so queueing never eats into a call's own time budget.
export class ModelCallGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit = MAX_CONCURRENT_MODEL_CALLS) {}

  // `onAcquired` reports queue wait; charging it to a per-file budget would make a busy gate look like a slow model.
  async run<T>(fn: () => Promise<T>, onAcquired?: (waitedMs: number) => void): Promise<T> {
    const startedWaiting = Date.now();
    await this.acquire();
    onAcquired?.(Date.now() - startedWaiting);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get queueDepth() {
    return this.waiters.length;
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release() {
    // Hand the slot straight to the next waiter so a newly arriving caller can't sneak in ahead of it.
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}
