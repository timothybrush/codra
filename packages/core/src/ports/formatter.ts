import type { ParsedReviewComment } from '@codra/schema';

/**
 * Renders findings into the markdown the provider will show.
 *
 * Four of `FormatterService`'s methods, which are the four finalize calls. The implementation is
 * already pure apart from a base URL, and it stays outside the engine because the URL is deployment
 * configuration.
 *
 * A correct implementation must be PURE and DETERMINISTIC: same finding in, same string out, no I/O,
 * no clock, no randomness. Finalize is re-runnable, and a formatter whose output varied between
 * invocations would make a retried finalize post text that no longer matches what was recorded --
 * and, because posted findings are tracked by fingerprint rather than by body, would do so silently.
 * `summarizeVerdict` must treat `hasFailures` as decisive: a job with failed files cannot approve.
 */
export interface ReviewFormatter {
  toReviewEvent(verdict: 'approve' | 'comment'): 'APPROVE' | 'COMMENT';
  summarizeVerdict(comments: ParsedReviewComment[], hasFailures: boolean): { verdict: 'approve' | 'comment'; errors: number; warnings: number };
  formatInlineComment(comment: ParsedReviewComment): string;
  formatReviewOverview(commitSha: string, botUsername: string): string;
}
