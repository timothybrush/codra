import { dedupeFindings } from '../model-output';
import { verifyFindings } from '../finding-gates';
import type { FindingDisposition, ParsedReviewComment, RepoConfig } from '@shared/schema';
import type { AppBindings } from '@server/env';
import type { FileDiff } from '../diff';
import type { PersistedReviewJob } from './phase-control';
import type { ModelService } from '../../services/model';
import { loadSuppressedFingerprints } from './telemetry';

// Sibling of the core/review barrel; import from there, not here.
//
// The finding funnel, in the one correct order: severity/confidence gates, then cross-run suppression
// (BEFORE dedupe and verification, both load-bearing and each got wrong once), dedupe, a
// severity/confidence sort so the cap keeps the strongest, then verification and the max_comments cap.
// Returns every count the caller needs, because `posted = false` alone conflated six outcomes.
export async function applyFindingGates(params: {
  env: AppBindings;
  job: PersistedReviewJob;
  config: RepoConfig;
  files: FileDiff[];
  model: Pick<ModelService, 'verifyFindings'>;
  effectiveMaxComments: number;
  reviewedComments: ParsedReviewComment[];
  reviews: Array<{ withheld_counts?: { evidence?: number; claimDenied?: number } | null }>;
}) {
  const { env, job, config, files, model, effectiveMaxComments, reviewedComments, reviews } = params;

  const severityRanks: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };
  const minRank = severityRanks[config.review.min_severity] ?? 4;
  const minConfidence = config.review.min_confidence ?? 0;

  // 1. Severity + confidence gates: the parser now substitutes 0 for an omitted score on every
  //    provider, repairing a gate that used to be a no-op. posted=false alone conflated six
  //    outcomes, so attribution is captured here instead.
  const dispositions = new Map<string, FindingDisposition>();
  // The verifier's own reasoning, kept and dropped alike -- the only surface that explains why
  // the Gatekeeper ruled as it did.
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

  // 2. Cross-run suppression, BEFORE dedupe (a suppressed finding must not be elected as a title
  //    group's representative) and before verification (no tokens spent judging what won't post).
  const suppressed = await loadSuppressedFingerprints(env, job.id);
  const suppressedComments: ParsedReviewComment[] = [];
  const hasSuppressionData = suppressed.rejected.size > 0 || suppressed.posted.size > 0
    || suppressed.rejectedV2.size > 0 || suppressed.postedV2.size > 0;
  if (hasSuppressionData) {
    finalComments = finalComments.filter((c) => {
      // EITHER identity matches: v1 alone missed reworded repeats (one PR, six of ten re-reports,
      // only one shared a v1 fingerprint, since v1 hashes the title and the model rewords it).
      const rejected = (c.fingerprint && suppressed.rejected.has(c.fingerprint))
        || (c.fingerprintV2 && suppressed.rejectedV2.has(c.fingerprintV2));

      // v1 also requires the anchored line unchanged; v2 needs no such check since the anchor is
      // already in the key, so an edit produces a different key and re-raises by construction.
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

  // 3. Collapse duplicates. NOTE dedupe elects one representative per title across ALL files and
  //    runs BEFORE verification, so a dropped representative takes a genuine sibling down with it.
  const beforeDedupe = finalComments;
  finalComments = dedupeFindings(finalComments);
  const survivedDedupe = new Set(finalComments);
  recordDisposition(beforeDedupe.filter((c) => !survivedDedupe.has(c)), 'dedupe');

  // 4. Order by severity (most severe first), then by confidence, so the max_comments cap keeps the
  //    strongest findings rather than whichever happened to be first in file order.
  finalComments.sort((a, b) => {
    const rankDiff = (severityRanks[a.severity] ?? 4) - (severityRanks[b.severity] ?? 4);
    if (rankDiff !== 0) return rankDiff;
    return (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0);
  });

  // 5. Verification: one model call re-checks survivors against the diff. Best-effort -- on
  //    failure we keep the filtered set. Returns a subsequence, so the severity sort survives.
  const beforeVerifyList = finalComments;
  const verify = await verifyFindings({ job, config, files, comments: finalComments, model, maxCandidates: effectiveMaxComments });
  finalComments = verify.comments;
  const droppedByVerification = verify.dropped.length;
  // Per-drop attribution rather than a set difference: this is what distinguishes "the model judged
  // this a drop" from "the verifier never answered" from "we could render no context for it".
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

  // Parser-withheld findings never became review_comments rows, so the count rides on
  // file_reviews instead -- otherwise "found nothing" and "withheld" are indistinguishable.
  const withheldByParser = reviews.reduce(
    (sum, review) => sum + (review.withheld_counts?.evidence ?? 0) + (review.withheld_counts?.claimDenied ?? 0),
    0,
  );

  // Per-claim-type counts split by survival: a type generated repeatedly and never posted is a
  // type to retire.
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
