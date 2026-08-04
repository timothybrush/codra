import type { FindingDisposition, ParsedReviewComment, RepoConfig } from '@shared/schema';
import type { FileDiff } from './diff';
import type { ModelService } from '../services/model';
import type { GeneratorProfile } from '../prompts/file-review';
import { renderDiffSnippet, parseVerifyResponse, type VerifyCandidate } from '../prompts/verify';
import { logger } from './logger';

/**
 * The Gatekeeper: a second model pass that can only REMOVE findings, plus the shadow scoring of
 * candidate filters that are not yet applied.
 *
 * Split out of review.ts because it was already structurally independent — it takes
 * `Pick<ModelService, 'verifyFindings'>` and `Pick<PersistedReviewJob, 'id'>` rather than the real
 * objects, so it shares no state with the phase machinery. The ModelService import must stay
 * type-only or it closes an import cycle back through core/model-output.
 */

type VerifiableJob = { id: string };

/**
 * Scores candidate filters WITHOUT applying them, as a paired within-run comparison. A/B testing is
 * unavailable — one operator, one PR at a time — but scoring both the live chain and the candidate
 * rules on the same findings yields paired data on every review and is valid at n=1.
 *
 * The discipline matters: "P3 has never been posted" (0 of 173) looked decisive until it emerged
 * that P3 sorts last and `max_comments` slices from the end, so the statistic was measuring sort
 * order rather than findings. These counters score against findings that survived the live chain.
 */
const LOW_YIELD_TITLE = /missing|redundant|repetitive|inconsisten|documentation|\btype\b|\bany\b|potential/i;

export function shadowEvaluate(candidates: ParsedReviewComment[], posted: ParsedReviewComment[]) {
  const postedSet = new Set(posted);
  const count = (predicate: (c: ParsedReviewComment) => boolean) => ({
    wouldDrop: candidates.filter(predicate).length,
    // The number that matters: how many findings the rule would have taken off the pull request.
    wouldDropPosted: posted.filter(predicate).length,
  });

  return {
    candidates: candidates.length,
    posted: postedSet.size,
    dropP3AndNit: count((c) => c.severity === 'P3' || c.severity === 'nit'),
    dropLowYieldTitle: count((c) => LOW_YIELD_TITLE.test(c.title)),
    dropUnmatchedEvidence: count((c) => !c.evidence),
    // `null_or_undefined_deref` used to be scored here pending measurement. The measurement arrived
    // (3 generated, 0 valid) and it is now enforced in DEFAULT_DENIED_CLAIM_TYPES, so it left this
    // harness: a rule that is already applied always scores 0 here and tells you nothing.
    //
    // Nothing is currently shadow-scored. Add the next candidate rule here rather than enabling it.
  };
}

/**
 * How many findings the verification pass will look at.
 *
 * Scaled to what can actually be posted rather than fixed at 40: verification runs BEFORE the
 * max_comments cap, so a fixed ceiling spends context (and wall clock, on a call already pinned at
 * the model timeout maximum) judging findings that would be sliced off regardless.
 */
function verifyCandidateLimit(effectiveMaxComments: number, profile: GeneratorProfile = 'strict') {
  // Widened under 'balanced'. The generator emits up to 2x max_comments per chunk there, so a window
  // sized at 2x would be filled by the first file or two and every later candidate would reach
  // `unverifiedTail` without ever being judged -- the verify window quietly becoming the new cap, and
  // the relaxation showing up as noise rather than recall.
  //
  // Not raised further than this: a larger batch is exactly what VERIFY_MIN_ANSWER_RATIO guards
  // against, and `droppedUnanswered` in the finalize log is the signal that it has gone too far. If
  // that number is routinely non-zero, bring this back down before touching the ratio.
  const perComment = profile === 'balanced' ? 3 : 2;
  return Math.min(40, Math.max(10, effectiveMaxComments * perComment));
}

/**
 * Below this share of answered indices the response is treated as a non-answer and everything is
 * kept. A model that returned 3 verdicts for 20 findings did not do the task, and letting the 17
 * silent ones fail closed would be a mass deletion dressed up as judgement.
 *
 * A guess, pending data. `droppedUnanswered` is logged separately so it can be tuned; if it is
 * routinely non-zero the batch is too large and `verifyCandidateLimit` should come down instead.
 */
const VERIFY_MIN_ANSWER_RATIO = 0.6;

/**
 * Above this share of un-snippetable candidates, verification is skipped entirely.
 *
 * Unverifiable candidates now fail closed, which makes a path-normalization mismatch between the
 * diff and the stored comments capable of deleting every finding in a file. That is an
 * infrastructure failure and must never read as a wall of model verdicts.
 */
const UNVERIFIABLE_CIRCUIT_BREAKER_RATIO = 0.5;

export type VerifyDrop = {
  comment: ParsedReviewComment;
  disposition: Extract<FindingDisposition, 'verify' | 'verify_unanswered' | 'unverifiable_passthrough' | 'rule_unverified'>;
  reason?: string;
};

export type VerifyOutcome = {
  /** A strict SUBSEQUENCE of the input: this pass may only ever subtract. */
  comments: ParsedReviewComment[];
  dropped: VerifyDrop[];
  /** Verifier reasoning per judged candidate, for the kept ones too. The tuning surface. */
  reasons: Map<ParsedReviewComment, string>;
  stats: {
    candidates: number;
    answered: number;
    droppedByVerdict: number;
    droppedUnanswered: number;
    droppedUnverifiable: number;
    /** Candidates past the limit, never judged at all. A pre-existing hole, now at least visible. */
    unverifiedTail: number;
    failedOpen: false | 'error' | 'no_verdicts' | 'under_response' | 'unverifiable_ratio';
    /**
     * Rule candidates dropped because verification failed open. Routinely non-zero means the
     * free-tier chain is not doing the triage job, and no rule should be promoted out of shadow.
     */
    droppedRuleFailClosed: number;
  };
};

/**
 * The Gatekeeper: one consolidated model call re-checks the top candidate findings against their
 * diff context and subtracts the ones that don't hold up.
 *
 * Two structural properties, both load-bearing:
 *
 * 1. It can only SUBTRACT. The return is `comments.filter(...)`, so the severity sort established by
 *    the caller survives by construction rather than by remembering to re-sort. This used to return
 *    `[...kept, ...unverifiable, ...passthrough]`, which reordered the array before `max_comments`
 *    sliced it -- so the cap was cutting from a list that was no longer in severity order.
 * 2. Verdicts are read from a SPARSE MAP keyed on the model's own `index` field, never by position.
 *    A renumbered or truncated list can therefore no longer delete the wrong finding; the worst it
 *    can do is leave an index unanswered, which is a separate, separately-labelled outcome.
 */
export async function verifyFindings(params: {
  job: VerifiableJob;
  config: RepoConfig;
  files: FileDiff[];
  comments: ParsedReviewComment[];
  model: Pick<ModelService, 'verifyFindings'>;
  maxCandidates?: number;
}): Promise<VerifyOutcome> {
  const { comments, files, model, config, job } = params;
  /**
   * Every fail-open path, and the one place the two channels are treated differently.
   *
   * `verifyFindings` fails OPEN five ways — an error, no verdicts, an under-response, too many
   * unverifiable candidates — because silently deleting an LLM finding nobody judged is worse than
   * posting one. Rule candidates invert that: they are cheap, deterministic and unproven, so an
   * unverified one is DROPPED. Without this, promoting a rule out of shadow would ship an
   * unfiltered candidate stream behind a filter that, on those paths, is not running at all.
   */
  const keepAll = (failedOpen: VerifyOutcome['stats']['failedOpen'], extra?: Partial<VerifyOutcome['stats']>): VerifyOutcome => {
    const kept = comments.filter((comment) => comment.source !== 'rule');
    const droppedRules = comments.filter((comment) => comment.source === 'rule');
    return {
      comments: kept,
      dropped: droppedRules.map((comment) => ({
        comment,
        disposition: 'rule_unverified' as const,
        reason: `Rule candidate not confirmed (verification ${failedOpen || 'unavailable'}).`,
      })),
      reasons: new Map(
        droppedRules.map((comment) => [
          comment,
          `Rule candidate not confirmed (verification ${failedOpen || 'unavailable'}).`,
        ]),
      ),
      stats: {
        candidates: 0, answered: 0, droppedByVerdict: 0, droppedUnanswered: 0,
        droppedUnverifiable: 0, unverifiedTail: 0, failedOpen,
        droppedRuleFailClosed: droppedRules.length,
        ...extra,
      },
    };
  };

  if (comments.length === 0) return keepAll(false);

  const limit = verifyCandidateLimit(
    params.maxCandidates ?? config.review.max_comments,
    config.review.generator_profile,
  );
  const toVerify = comments.slice(0, limit);
  const unverifiedTail = comments.length - toVerify.length;

  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const prepared = toVerify.map((comment) => ({
    comment,
    snippet: renderDiffSnippet(fileByPath.get(comment.path), comment.line ?? undefined),
  }));

  const verifiable = prepared.filter((entry) => entry.snippet !== '' || entry.comment.evidence);
  const unverifiable = prepared.filter((entry) => entry.snippet === '' && !entry.comment.evidence);

  // Circuit breaker before anything else: a wholesale failure to render snippets is infrastructure,
  // not judgement, and the fail-closed rule below would turn it into a silent mass deletion.
  const unverifiableRatio = prepared.length > 0 ? unverifiable.length / prepared.length : 0;
  if (verifiable.length === 0 || unverifiableRatio > UNVERIFIABLE_CIRCUIT_BREAKER_RATIO) {
    logger.warn('Too many candidates have no diff context; skipping verification', {
      jobId: job.id,
      unverifiable: unverifiable.length,
      prepared: prepared.length,
      paths: [...new Set(unverifiable.map((entry) => entry.comment.path))].slice(0, 10),
    });
    return keepAll('unverifiable_ratio', { unverifiedTail });
  }

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

    // Sparse, index-keyed, and tolerant of junk: an out-of-range index is ignored rather than
    // aborting the whole pass, and two conflicting verdicts for one index cancel out to "unanswered"
    // instead of letting arrival order decide.
    const byIndex = new Map<number, { verdict: 'keep' | 'drop'; reason?: string }>();
    const conflicting = new Set<number>();
    for (const result of results) {
      if (!Number.isInteger(result.index) || result.index < 0 || result.index >= candidates.length) continue;
      const prior = byIndex.get(result.index);
      if (prior && prior.verdict !== result.verdict) {
        conflicting.add(result.index);
        continue;
      }
      if (!prior) byIndex.set(result.index, { verdict: result.verdict, reason: result.reason });
    }
    for (const index of conflicting) byIndex.delete(index);

    const answered = byIndex.size;
    if (answered === 0) {
      logger.warn('Verification returned no usable verdicts; keeping all findings', {
        jobId: job.id, candidates: candidates.length, results: results.length,
      });
      return keepAll('no_verdicts', { candidates: candidates.length, unverifiedTail });
    }
    if (answered / candidates.length < VERIFY_MIN_ANSWER_RATIO) {
      logger.warn('Verification under-responded; keeping all findings', {
        jobId: job.id, candidates: candidates.length, answered,
      });
      return keepAll('under_response', { candidates: candidates.length, answered, unverifiedTail });
    }

    const dropped: VerifyDrop[] = [];
    const reasons = new Map<ParsedReviewComment, string>();
    let droppedByVerdict = 0;
    let droppedUnanswered = 0;

    verifiable.forEach((entry, index) => {
      const result = byIndex.get(index);
      if (result?.reason) reasons.set(entry.comment, result.reason);

      if (result?.verdict === 'drop') {
        droppedByVerdict += 1;
        dropped.push({ comment: entry.comment, disposition: 'verify', reason: result.reason });
        return;
      }
      if (!result) {
        // Fail closed. The prompt demands exactly one result per index, so an index the model never
        // addressed has not been endorsed. Labelled distinctly from a real 'verify' drop on purpose:
        // this one is OUR defect, and conflating the two would make the tuning data worthless in
        // exactly the way `posted = false` was.
        droppedUnanswered += 1;
        dropped.push({
          comment: entry.comment,
          disposition: 'verify_unanswered',
          reason: 'the verifier returned no verdict for this finding',
        });
      }
    });

    for (const entry of unverifiable) {
      dropped.push({
        comment: entry.comment,
        disposition: 'unverifiable_passthrough',
        reason: 'no diff context could be rendered for this location',
      });
    }

    const droppedSet = new Set(dropped.map((drop) => drop.comment));
    logger.info('Verification pass complete', {
      jobId: job.id,
      candidates: candidates.length,
      answered,
      droppedByVerdict,
      droppedUnanswered,
      droppedUnverifiable: unverifiable.length,
      unverifiedTail,
      // Severity of every unverifiable drop: a P0 appearing here means the fail-closed rule is
      // eating high-severity findings for an infrastructure reason and should be reverted.
      unverifiableSeverities: unverifiable.map((entry) => entry.comment.severity),
      topReasons: dropped.slice(0, 5).map((drop) => drop.reason),
    });

    return {
      // Subtraction only, hence the sort is preserved.
      comments: comments.filter((comment) => !droppedSet.has(comment)),
      dropped,
      reasons,
      stats: {
        candidates: candidates.length,
        answered,
        droppedByVerdict,
        droppedUnanswered,
        droppedUnverifiable: unverifiable.length,
        unverifiedTail,
        failedOpen: false,
        // The verifier ran, so every rule candidate was judged on its merits like any other.
        droppedRuleFailClosed: 0,
      },
    };
  } catch (error) {
    logger.warn('Verification pass failed; posting pre-verification findings', {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return keepAll('error', { candidates: candidates.length, unverifiedTail });
  }
}
