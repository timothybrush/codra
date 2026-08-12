import { dedupeFindings } from '../model-output';
import { verifyFindings } from '../finding-gates';
import type { FindingDisposition, ParsedReviewComment, RepoConfig } from '@codra/schema';
import type { FileDiff } from '../diff';
import type { PersistedReviewJob } from './phase-control';
import type { ReviewModel, ReviewRuntime } from '../ports';
import { loadSuppressedFingerprints } from './telemetry';

// The finding funnel. Order is load-bearing: severity/confidence gates, cross-run suppression (before dedupe/verification), dedupe, a severity sort, then verification and the max_comments cap.
// Returns per-stage counts, since `posted = false` alone conflated six outcomes. Import from the core/review barrel, not here.
export async function applyFindingGates(params: {
  env: Pick<ReviewRuntime, 'fileReviews'>;
  job: PersistedReviewJob;
  config: RepoConfig;
  files: FileDiff[];
  model: Pick<ReviewModel, 'verifyFindings'>;
  effectiveMaxComments: number;
  reviewedComments: ParsedReviewComment[];
  reviews: Array<{ withheld_counts?: { evidence?: number; claimDenied?: number } | null }>;
}) {
  const { env, job, config, files, model, effectiveMaxComments, reviewedComments, reviews } = params;

  const severityRanks: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };
  const minRank = severityRanks[config.review.min_severity] ?? 4;
  const minConfidence = config.review.min_confidence ?? 0;

  // 1. Severity + confidence gates. The parser substitutes 0 for an omitted score on every provider, which is what stops this being a no-op.
  const dispositions = new Map<string, FindingDisposition>();
  // The verifier's reasoning, kept and dropped alike: the only surface explaining its rulings.
  const verifyReasons = new Map<string, string>();
  const recordDisposition = (comments: ParsedReviewComment[], stage: FindingDisposition) => {
    for (const comment of comments) {
      if (comment.fingerprint && !dispositions.has(comment.fingerprint)) {
        dispositions.set(comment.fingerprint, stage);
      }
    }
  };

  let finalComments = reviewedComments.filter((c) => {
    if ((severityRanks[c.severity] ?? 4) > minRank) {
      recordDisposition([c], 'severity');
      return false;
    }
    if (typeof c.confidenceScore === 'number' && c.confidenceScore < minConfidence) {
      recordDisposition([c], 'confidence');
      return false;
    }
    return true;
  });

  // 2. Cross-run suppression, BEFORE dedupe (a suppressed finding must not be elected as a title group's representative) and before verification (no tokens spent judging what won't post).
  const suppressed = await loadSuppressedFingerprints(env, job.id);
  const suppressedComments: ParsedReviewComment[] = [];
  const hasSuppressionData = suppressed.rejected.size > 0 || suppressed.posted.size > 0
    || suppressed.rejectedV2.size > 0 || suppressed.postedV2.size > 0;
  if (hasSuppressionData) {
    finalComments = finalComments.filter((c) => {
      // EITHER identity matches: v1 hashes the title, so it missed reworded repeats (six of ten re-reports on one PR).
      const rejected = (c.fingerprint && suppressed.rejected.has(c.fingerprint))
        || (c.fingerprintV2 && suppressed.rejectedV2.has(c.fingerprintV2));

      // v1 also requires the anchored line unchanged; v2 has the anchor in its key already.
      const anchors = c.fingerprint ? suppressed.posted.get(c.fingerprint) : undefined;
      const alreadyPosted = (anchors && c.anchorHash && anchors.has(c.anchorHash))
        || (c.fingerprintV2 && suppressed.postedV2.has(c.fingerprintV2));

      if (rejected || alreadyPosted) {
        suppressedComments.push(c);
        return false;
      }
      return true;
    });
  }
  const droppedBySuppression = suppressedComments.length;
  recordDisposition(suppressedComments, 'suppression');

  // 3. Collapse duplicates. One representative per title across ALL files, elected BEFORE verification, so a dropped representative takes a genuine sibling down with it.
  const beforeDedupe = finalComments;
  finalComments = dedupeFindings(finalComments);
  const survivedDedupe = new Set(finalComments);
  recordDisposition(beforeDedupe.filter((c) => !survivedDedupe.has(c)), 'dedupe');

  // 4. Severity then confidence, so the max_comments cap keeps the strongest, not the first.
  finalComments.sort((a, b) => {
    const rankDiff = (severityRanks[a.severity] ?? 4) - (severityRanks[b.severity] ?? 4);
    if (rankDiff !== 0) return rankDiff;
    return (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0);
  });

  // 5. Verification: one model call re-checks survivors against the diff. Best-effort, and it returns a subsequence, so the severity sort survives.
  const beforeVerifyList = finalComments;
  const verify = await verifyFindings({ job, config, files, comments: finalComments, model, maxCandidates: effectiveMaxComments });
  finalComments = verify.comments;
  const droppedByVerification = verify.dropped.length;
  // Per-drop attribution, not a set difference: distinguishes "judged a drop" from "never answered" from "no context could be rendered".
  for (const drop of verify.dropped) recordDisposition([drop.comment], drop.disposition);
  for (const [comment, reason] of verify.reasons) {
    if (comment.fingerprint) verifyReasons.set(comment.fingerprint, reason);
  }

  const beforeCapList = finalComments;
  const beforeCap = finalComments.length;
  if (finalComments.length > effectiveMaxComments) {
    finalComments = finalComments.slice(0, effectiveMaxComments);
  }
  const droppedByCap = beforeCap - finalComments.length;
  recordDisposition(beforeCapList.slice(effectiveMaxComments), 'cap');
  const omittedCount = reviewedComments.length - finalComments.length;
  // Everything removed before verification, minus suppression: severity/confidence gates + dedupe.
  const droppedByFilters = omittedCount - droppedBySuppression - droppedByVerification - droppedByCap;

  // Parser-withheld findings never became review_comments rows, so the count rides on file_reviews; otherwise "found nothing" and "withheld" are indistinguishable.
  const withheldByParser = reviews.reduce(
    (sum, review) => sum + (review.withheld_counts?.evidence ?? 0) + (review.withheld_counts?.claimDenied ?? 0),
    0,
  );

  // Split by survival: a type generated repeatedly and never posted is a type to retire.
  const byClaimType: Record<string, { generated: number; posted: number }> = {};
  for (const comment of reviewedComments) {
    const key = comment.claimType ?? 'unlabelled';
    byClaimType[key] ??= { generated: 0, posted: 0 };
    byClaimType[key].generated += 1;
  }
  for (const comment of finalComments) {
    const key = comment.claimType ?? 'unlabelled';
    byClaimType[key] ??= { generated: 0, posted: 0 };
    byClaimType[key].posted += 1;
  }
  return {
    finalComments,
    dispositions,
    verifyReasons,
    suppressedComments,
    droppedBySuppression,
    beforeVerifyList,
    droppedByVerification,
    droppedByCap,
    omittedCount,
    droppedByFilters,
    withheldByParser,
    byClaimType,
  };
}
