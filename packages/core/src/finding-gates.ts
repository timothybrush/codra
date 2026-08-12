import type { FindingDisposition, ParsedReviewComment, RepoConfig } from '@codra/schema';
import type { FileDiff } from './diff';
import type { ReviewModel } from './ports';
import { renderDiffSnippet, parseVerifyResponse, type VerifyCandidate } from './prompts/verify';
import { logger } from './logger';

type VerifiableJob = { id: string };

// Scores candidate filters WITHOUT applying them. Score anywhere else and you measure sort order: "P3 never posted" (0 of 173) was really `max_comments` slicing a severity sort from the end.
const LOW_YIELD_TITLE = /missing|redundant|repetitive|inconsisten|documentation|\btype\b|\bany\b|potential/i;

export function shadowEvaluate(candidates: ParsedReviewComment[], posted: ParsedReviewComment[]) {
  const postedSet = new Set(posted);
  const count = (predicate: (c: ParsedReviewComment) => boolean) => ({
    wouldDrop: candidates.filter(predicate).length,
    wouldDropPosted: posted.filter(predicate).length,
  });

  return {
    candidates: candidates.length,
    posted: postedSet.size,
    dropP3AndNit: count((c) => c.severity === 'P3' || c.severity === 'nit'),
    dropLowYieldTitle: count((c) => LOW_YIELD_TITLE.test(c.title)),
    dropUnmatchedEvidence: count((c) => !c.evidence),
    // Counted, never applied: an already-applied rule scores 0 and tells you nothing.
  };
}

// Scaled to what can be posted, since verification runs BEFORE the max_comments cap.
function verifyCandidateLimit(effectiveMaxComments: number) {
  // 3x, not 2x: the generator emits 2x per chunk, so a 2x window leaves later files unjudged.
  return Math.min(40, Math.max(10, effectiveMaxComments * 3));
}

// Below this share of answered indices everything is kept: 3 verdicts for 20 findings is not judgement, and failing the other 17 closed is mass deletion. 0.6 is a guess pending data.
const VERIFY_MIN_ANSWER_RATIO = 0.6;

export type VerifyDrop = {
  comment: ParsedReviewComment;
  disposition: Extract<FindingDisposition, 'verify' | 'verify_unanswered'>;
  reason?: string;
};

export type VerifyOutcome = {
  // A strict SUBSEQUENCE of the input: this pass may only ever subtract.
  comments: ParsedReviewComment[];
  dropped: VerifyDrop[];
  // Verifier reasoning per judged candidate, kept ones included.
  reasons: Map<ParsedReviewComment, string>;
};

// Two load-bearing properties: it SUBTRACTS ONLY (`comments.filter`), so the caller's severity sort survives `max_comments`; and verdicts come from a SPARSE MAP keyed on the model's own `index`, never position, so a renumbered list cannot delete the wrong finding.
export async function verifyFindings(params: {
  job: VerifiableJob;
  config: RepoConfig;
  files: FileDiff[];
  comments: ParsedReviewComment[];
  model: Pick<ReviewModel, 'verifyFindings'>;
  maxCandidates?: number;
}): Promise<VerifyOutcome> {
  const { comments, files, model, config, job } = params;

  // A finding nobody judged is not a finding anybody disproved, so keeping it costs a reader a moment while deleting it silently loses a real defect.
  const keepAll = (): VerifyOutcome => ({ comments, dropped: [], reasons: new Map() });

  if (comments.length === 0) return keepAll();

  const limit = verifyCandidateLimit(params.maxCandidates ?? config.review.max_comments);
  const toVerify = comments.slice(0, limit);

  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const prepared = toVerify.map((comment) => ({
    comment,
    snippet: renderDiffSnippet(fileByPath.get(comment.path), comment.line ?? undefined),
  }));

  // A candidate with no renderable diff context is passed through UNJUDGED rather than dropped: failing it closed would let one path-normalization mismatch delete every finding in a file.
  const verifiable = prepared.filter((entry) => entry.snippet !== '' || entry.comment.evidence);
  if (verifiable.length === 0) return keepAll();

  const candidates: VerifyCandidate[] = verifiable.map((entry, index) => ({
    index,
    path: entry.comment.path,
    line: entry.comment.line ?? null,
    title: entry.comment.title,
    body: entry.comment.body,
    snippet: entry.snippet,
    evidence: entry.comment.evidence ?? null,
  }));

  try {
    const response = await model.verifyFindings({ candidates, config });
    const results = parseVerifyResponse(response.rawText);

    // Tolerant of junk: an out-of-range index is ignored, and two conflicting verdicts for one index cancel to "unanswered" rather than letting arrival order decide.
    const byIndex = new Map<number, { verdict: 'keep' | 'drop'; reason?: string }>();
    const conflicting = new Set<number>();
    for (const result of results) {
      if (!Number.isInteger(result.index) || result.index < 0 || result.index >= candidates.length) continue;
      // `decidable: false` is a drop whatever the verdict says: the verifier has just stated that the
      // window it was given cannot settle the claim, and a claim nobody can check must not be posted as
      // if it were checked. Only an explicit `false` counts -- an omitted field means "did not say".
      const verdict = result.decidable === false ? 'drop' as const : result.verdict;
      const prior = byIndex.get(result.index);
      if (prior && prior.verdict !== verdict) {
        conflicting.add(result.index);
        continue;
      }
      if (!prior) byIndex.set(result.index, { verdict, reason: result.reason });
    }
    for (const index of conflicting) byIndex.delete(index);

    const answered = byIndex.size;
    if (answered === 0 || answered / candidates.length < VERIFY_MIN_ANSWER_RATIO) {
      logger.warn('Verification did not answer enough indices; keeping all findings', {
        jobId: job.id, candidates: candidates.length, answered,
      });
      return keepAll();
    }

    const dropped: VerifyDrop[] = [];
    const reasons = new Map<ParsedReviewComment, string>();

    verifiable.forEach((entry, index) => {
      const result = byIndex.get(index);
      if (result?.reason) reasons.set(entry.comment, result.reason);

      if (result?.verdict === 'drop') {
        dropped.push({ comment: entry.comment, disposition: 'verify', reason: result.reason });
        return;
      }
      if (!result) {
        // Fail closed: unaddressed one is unendorsed. Labelled apart from a real 'verify' drop because this one is OUR defect.
        dropped.push({
          comment: entry.comment,
          disposition: 'verify_unanswered',
          reason: 'the verifier returned no verdict for this finding',
        });
      }
    });

    const droppedSet = new Set(dropped.map((drop) => drop.comment));
    logger.info('Verification pass complete', {
      jobId: job.id,
      candidates: candidates.length,
      answered,
      dropped: dropped.length,
      topReasons: dropped.slice(0, 5).map((drop) => drop.reason),
    });

    return { comments: comments.filter((comment) => !droppedSet.has(comment)), dropped, reasons };
  } catch (error) {
    logger.warn('Verification pass failed; posting pre-verification findings', {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return keepAll();
  }
}
