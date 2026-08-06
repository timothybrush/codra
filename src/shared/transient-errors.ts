// Substrings that both the server's "should this persisted failed file-review be retried?" check
// (isRetryableFileReviewErrorMessage, review.ts) and its "is this live model error transient?"
// check (isTransientModelFailure, model-support.ts) treat as transient. Keeping the common core in one
// place stops the two lists from silently drifting apart. Each classifier still appends its own
// layer-specific extras (e.g. 'all configured review models failed', 'fetch failed').
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

export function matchesAnyTransientSubstring(
  lowerMessage: string,
  substrings: readonly string[] = SHARED_TRANSIENT_ERROR_SUBSTRINGS,
): boolean {
  return substrings.some((substring) => lowerMessage.includes(substring));
}
