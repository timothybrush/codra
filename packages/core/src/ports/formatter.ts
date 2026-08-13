import type { ParsedReviewComment } from '@codra/schema';

export interface ReviewFormatter {
  toReviewEvent(verdict: 'approve' | 'comment'): 'APPROVE' | 'COMMENT';
  summarizeVerdict(comments: ParsedReviewComment[], hasFailures: boolean): { verdict: 'approve' | 'comment'; errors: number; warnings: number };
  formatInlineComment(comment: ParsedReviewComment): string;
  formatReviewOverview(commitSha: string, botUsername: string): string;
}
