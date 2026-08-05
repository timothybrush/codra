import type { ParsedReviewComment } from '@shared/schema';
import { normalizeFindingTitle } from '../fingerprint';

const SEVERITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };

// A separator guaranteed absent from any of ruleId/path/anchorHash, so joining them can never
// collide with a legitimate value the way a printable delimiter could.
const NUL = String.fromCharCode(0);

// Collapses near-duplicate findings by normalized title: the same issue reported across many
// files is noise. Keeps the highest-severity, highest-confidence instance.
export function dedupeFindings(comments: ParsedReviewComment[]): ParsedReviewComment[] {
  const best = new Map<string, ParsedReviewComment>();
  for (const comment of comments) {
    // A rule's title is a CONSTANT, so title-keying would collapse every empty catch in a PR into
    // one finding. Rule candidates key on their own identity: same rule+file+line is a duplicate.
    const key = comment.source === 'rule'
      ? `rule${NUL}${comment.ruleId ?? ''}${NUL}${comment.path}${NUL}${comment.anchorHash ?? ''}`
      : normalizeFindingTitle(comment.title);
    if (!key) {
      // Untitled/odd finding - keep as-is under a unique key so it isn't merged away.
      best.set(`__unique__${best.size}`, comment);
      continue;
    }
    const existing = best.get(key);
    if (!existing) {
      best.set(key, comment);
      continue;
    }
    const rank = SEVERITY_RANK[comment.severity] ?? 4;
    const existingRank = SEVERITY_RANK[existing.severity] ?? 4;
    const isBetter =
      rank < existingRank ||
      (rank === existingRank && (comment.confidenceScore ?? 0) > (existing.confidenceScore ?? 0));
    if (isBetter) best.set(key, comment);
  }
  return Array.from(best.values());
}
