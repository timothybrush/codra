// Common core shared by isRetryableFileReviewErrorMessage (review.ts) and isTransientModelFailure (model-support.ts) so their lists can't silently drift apart; each still appends its own layer-specific extras.
export const SHARED_TRANSIENT_ERROR_SUBSTRINGS = [
  'unavailable',
  'high demand',
  'returned no review content',
  'empty response',
  '[redacted]',
] as const;

// Timeouts are deliberately NOT transient here -- both classifiers fail fast on them.
export function isTimeoutMessage(lowerMessage: string): boolean {
  return lowerMessage.includes('timed out') || lowerMessage.includes('timeout');
}

// The runtime refused the call because the invocation is out of subrequests. Nothing about the
// model: every remaining model in a chain will fail identically, so the only useful response is to
// stop and let a fresh invocation retry. Lives here, not in core/review/retry-policy.ts, because the
// model chain in services/ needs the same answer and cannot import across that boundary.
// Any message that merely MENTIONS "subrequest" counts -- retry-policy.ts has always matched that
// loosely, and the callers that must not trip it already avoid the word deliberately.
export function isSubrequestBudgetMessage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.toLowerCase().includes('subrequest');
}

export function matchesAnyTransientSubstring(
  lowerMessage: string,
  substrings: readonly string[] = SHARED_TRANSIENT_ERROR_SUBSTRINGS,
): boolean {
  return substrings.some((substring) => lowerMessage.includes(substring));
}
