import { logger } from '../logger';
import { defaultRepoConfig, type ParsedReviewComment, type RepoConfig } from '@codra/schema';
import { shadowEvaluate } from '../finding-gates';
import { getDiffFiles } from './diff-cache';
import type { ReviewFormatter, ReviewGitHub, ReviewModel, ReviewRuntime } from '../ports';
import {
  type PersistedReviewJob,
  FRESH_INVOCATION_YIELD_SECONDS,
  enqueueJobPhase,
  heartbeatAndCheckSuperseded,
} from './phase-control';
import { sendReviewTelemetry } from './telemetry';
import { applyFindingGates } from './gate-pipeline';
// Reconciles reviews, gates findings, then composes and posts the review. Import from the core/review barrel, not here.

export async function runFinalizePhase(
  env: ReviewRuntime,
  job: PersistedReviewJob,
  leaseOwner: string,
  github: ReviewGitHub,
  formatter: ReviewFormatter,
  model: ReviewModel,
) {
  await env.jobs.updateJobStep(job.id, 'Generating Summary', { status: 'running' });

  const pr = await github.getPullRequest(job.owner, job.repo, job.prNumber);
  const config = (job.configSnapshot ?? defaultRepoConfig) as RepoConfig;
  // One lookup supplies both the file ceiling and the gating comment cap.
  const reviewSettings = await env.settings.getReviewSettings();
  // The diff (KV/GitHub) and the file reviews (Postgres) share no state; two in flight cannot breach the subrequest cap.
  const [{ files, skipped: filesOverCap }, initialReviews] = await Promise.all([
    getDiffFiles(env, job, github, config, reviewSettings.maxFiles),
    env.fileReviews.getFileReviewsForJobs([job.id]),
  ]);
  let reviews = initialReviews;

  {
    // Set difference, not counts: the re-fetched diff can differ, so equal counts can still hide unreviewed files.
    const reviewedPaths = new Set(reviews.map((r) => r.file_path));
    const missingFiles = files.filter((f) => !reviewedPaths.has(f.path));

    if (missingFiles.length > 0) {
      logger.warn(`Job ${job.id} reached finalize phase with ${missingFiles.length} missing file reviews. Forcing them to failed state.`);
      // One INSERT: per-file writes would exhaust the subrequest budget right before posting.
      await env.fileReviews.bulkMarkFilesFailed(
        job.id,
        missingFiles.map((file) => ({ filePath: file.path, diffLineCount: file.lineCount })),
        { modelUsed: config.model?.main ?? 'unconfigured', errorMessage: 'This file was not reviewed before the review run completed.' },
      );

      reviews = await env.fileReviews.getFileReviewsForJobs([job.id]);
    } else if (reviews.length < files.length) {
      // Every path covered but fewer rows than files: review isn't done, so bounce back. Must stay an `else if`, or the healthy path loops finalize forever.
      await env.jobs.updateJobStep(job.id, 'Reviewing Files', { status: 'running' });
      await enqueueJobPhase(env, job.id, 'review', FRESH_INVOCATION_YIELD_SECONDS);
      return;
    }
  }

  // The continuation-ceiling degrade reaches finalize unmarked, stranding the step "In progress".
  await env.jobs.updateJobStep(job.id, 'Reviewing Files', { status: 'done' });

  const reviewedComments = reviews.flatMap((review) => review.parsed_comments as ParsedReviewComment[]);
  const fileSummaries = reviews.map((review) => ({
    path: review.file_path,
    summary: review.file_status === 'failed'
      ? `Review failed: ${review.error_msg ?? 'Unknown file review error'}`
      : (review.file_summary ?? ''),
    verdict: review.file_status === 'failed' ? 'failed' : (review.verdict ?? 'comment'),
  }));

  const { concurrencyLevel, maxComments: globalMaxComments } = reviewSettings;
  const effectiveMaxComments = Math.min(config.review.max_comments, globalMaxComments);
  // One level of retryOfJobId only; deeper chains would need a dedicated column on jobs.
  const retryCount = job.retryOfJobId ? 1 : 0;

  if (fileSummaries.length > 0 && fileSummaries.every((file) => file.verdict === 'failed')) {
    await env.jobs.updateJobStep(job.id, 'Generating Summary', { status: 'failed', error: 'All files failed to review' });

    await sendReviewTelemetry(
      env,
      job,
      files,
      reviews,
      { findingsReported: 0, verdict: 'failed', severityDistribution: {} },
      { concurrencyLevel, retryCount },
    );

    throw new Error('All files failed to review');
  }

  const hasFailures = fileSummaries.some((file) => file.verdict === 'failed');
  const failedFileCount = fileSummaries.filter((file) => file.verdict === 'failed').length;
  const {
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
  } = await applyFindingGates({
    env, job, config, files, model, effectiveMaxComments, reviewedComments, reviews,
  });


  logger.info('Finding pipeline outcome', {
    jobId: job.id,
    parsed: reviewedComments.length,
    droppedByFilters,
    droppedBySuppression,
    droppedByVerification,
    droppedByCap,
    posted: finalComments.length,
    withheldByParser,
    byClaimType,
    // Partitioned by channel, or LLM-channel numbers silently include deterministic rule hits.
    byChannel: {
      llm: finalComments.filter((c) => c.source !== 'rule').length,
      rule: finalComments.filter((c) => c.source === 'rule').length,
    },
    // Retirement signal: high `generated` with `posted` at zero means the verifier always rejects it.
    byRule: reviewedComments.reduce<Record<string, number>>((acc, c) => {
      if (c.source === 'rule' && c.ruleId) acc[c.ruleId] = (acc[c.ruleId] ?? 0) + 1;
      return acc;
    }, {}),
    // Canaries: one empty review is fine, three in a row means the filters went too far.
    postedAny: finalComments.length > 0,
    postedPer100Files: files.length > 0
      ? Math.round((finalComments.length / files.length) * 1000) / 10
      : 0,
  });

  // Scored, not applied. Read over ~20 reviews; wouldDropPosted is the cost side.
  logger.info('Shadow filter evaluation', {
    jobId: job.id,
    ...shadowEvaluate(beforeVerifyList, finalComments),
  });

  // Verdict uses findings STILL OPEN: one suppressed from an earlier commit is still unaddressed.
  const rawVerdict = formatter.summarizeVerdict([...finalComments, ...suppressedComments], hasFailures);

  // All-withheld must not read as clean; only "nothing to find" justifies a green approval.
  const everythingWithheld = finalComments.length === 0
    && suppressedComments.length === 0
    && (withheldByParser > 0 || omittedCount > 0);
  const verdictSummary = everythingWithheld && rawVerdict.verdict === 'approve'
    ? { ...rawVerdict, verdict: 'comment' as const }
    : rawVerdict;
  await env.jobs.updateJobStep(job.id, 'Generating Summary', { status: 'done' });
  await heartbeatAndCheckSuperseded(env, job.id, leaseOwner);

  let formattedSummary = formatter.formatReviewOverview(pr.head.sha, env.botUsername);

  // Reviewing 100 of 106 files and calling it done looks identical to finding the other six clean.
  if (filesOverCap > 0) {
    formattedSummary += `\n\n> [!WARNING]\n> **${filesOverCap} file${filesOverCap === 1 ? ' was' : 's were'} not reviewed.** This pull request has ${files.length + filesOverCap} reviewable files and the limit is ${reviewSettings.maxFiles}. Raise it in Settings to cover the whole diff.`;
  }

  // Deliberately NOT surfaced in the GitHub comment. The withheld tally is diagnostic -- it says how
  // the pipeline behaved, not anything about the pull request -- and a reader of the review cannot act
  // on "5 not grounded in a quoted line". It stays in the structured log above, in `withheld_counts` on
  // each file_reviews row, and in the per-file off-diff list, which is where it is actually useful.
  // A finalize that died after createReview but before completeJob left a review on GitHub; reuse it.
  const finalizeRetriedPastPost = job.steps.some(
    (step) => step.name === 'Completing' && (step.status === 'running' || step.status === 'done'),
  );
  await env.jobs.updateJobStep(job.id, 'Completing', { status: 'running' });
  const existingReview: { id: number; postedIndices?: number[] } | null = finalizeRetriedPastPost
    ? await github.findBotReviewForCommit(job.owner, job.repo, job.prNumber, pr.head.sha, env.botUsername)
    : null;
  const review = existingReview ?? await github.createReview(job.owner, job.repo, job.prNumber, {
    commitSha: pr.head.sha,
    event: formatter.toReviewEvent(verdictSummary.verdict),
    body: formattedSummary,
    // `line` is what the model reports; sending only `position` discarded every inline comment.
    comments: finalComments.map(comment => ({
      path: comment.path,
      line: comment.line ?? undefined,
      side: 'RIGHT' as const,
      position: comment.position ?? undefined,
      body: formatter.formatInlineComment(comment),
    })),
  });

  // `postedIndices`, not `finalComments`: the 422 fallback posts nothing, and marking all posted would hide them forever.
  if (review.postedIndices && review.postedIndices.length > 0) {
    const postedFingerprints = review.postedIndices
      .map((index) => finalComments[index]?.fingerprint)
      .filter((fingerprint): fingerprint is string => Boolean(fingerprint));
    await env.fileReviews.markCommentsPosted(job.id, postedFingerprints);
  }

  // Measurement only: a failure here must never fail a review already on GitHub.
  try {
    // Union of both maps. Kept findings have no disposition and must not clobber 'posted'.
    const withReasons = new Map<string, { disposition: string | null; reason: string | null }>();
    for (const fingerprint of new Set([...dispositions.keys(), ...verifyReasons.keys()])) {
      withReasons.set(fingerprint, {
        disposition: dispositions.get(fingerprint) ?? null,
        reason: verifyReasons.get(fingerprint) ?? null,
      });
    }
    await env.fileReviews.markCommentDispositions(job.id, withReasons);
  } catch (error) {
    logger.warn('Could not record finding dispositions', {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const fileInputTokens = reviews.reduce((sum, review) => sum + (review.input_tokens ?? 0), 0);
  const fileOutputTokens = reviews.reduce((sum, review) => sum + (review.output_tokens ?? 0), 0);

  const severityDistribution: Record<string, number> = {};
  for (const comment of finalComments) {
    const sev = comment.severity || 'unknown';
    severityDistribution[sev] = (severityDistribution[sev] || 0) + 1;
  }

  const partialErrorMessage = hasFailures
    ? `Partial review: ${failedFileCount} of ${files.length} file${files.length === 1 ? '' : 's'} could not be reviewed.`
    : null;
  // Done immediately after createReview: the review is on GitHub, so a budget-exhausted cosmetic call must not strand the job.
  await env.jobs.completeJob(job.id, {
    verdict: verdictSummary.verdict,
    fileCount: files.length,
    commentCount: finalComments.length,
    totalInputTokens: fileInputTokens,
    totalOutputTokens: fileOutputTokens,
    summaryMarkdown: formattedSummary,
    reviewId: review.id,
    summaryModel: null,
    errorMessage: partialErrorMessage,
  });
  logger.info(`Review job completed: ${job.owner}/${job.repo} PR #${job.prNumber}`);

  // Cosmetics only from here (labels, check-run conclusion), best-effort: the review is posted, and completeTerminalCheckRuns reconciles on failure.
  try {
    // Check-run conclusion first: it drives the status badge, so it wins if the budget allows only one.
    if (job.checkRunId) {
      await github.updateCheckRun(job.owner, job.repo, job.checkRunId, {
        status: 'completed',
        conclusion: hasFailures ? 'failure' : (verdictSummary.verdict === 'approve' ? 'success' : 'neutral'),
        title: hasFailures ? 'Review partially failed' : (verdictSummary.verdict === 'approve' ? 'LGTM' : 'Comments posted'),
        summary: `${finalComments.length} inline comments across ${files.length} files.${hasFailures ? ` ${failedFileCount} file${failedFileCount === 1 ? '' : 's'} could not be reviewed.` : ''}`,
      });
      // Record completion so the maintenance sweep skips it.
      await env.jobs.markJobCheckRunCompleted(job.id);
    }

    if (config.review.labels !== false) {
      const labels = config.review.labels;
      const labelMap = {
        comment: { name: labels.p1, color: 'f79009' },
        approve: { name: labels.p2, color: '027a48' },
      } as const;
      const label = labelMap[verdictSummary.verdict];

      await github.removeIssueLabelsIfPresent(
        job.owner,
        job.repo,
        job.prNumber,
        [labels.p1, labels.p2, labels.p3].filter(possibleLabel => possibleLabel !== label.name),
      );

      await github.ensureLabel(job.owner, job.repo, label.name, label.color);
      await github.addIssueLabels(job.owner, job.repo, job.prNumber, [label.name]);
    }
  } catch (error) {
    logger.warn(`Post-review labels/check-run update failed for job ${job.id}; review is posted and job is completed, so leaving it best-effort`, error instanceof Error ? error : new Error(String(error)));
  }

  await sendReviewTelemetry(
    env,
    job,
    files,
    reviews,
    { findingsReported: finalComments.length, verdict: verdictSummary.verdict, severityDistribution },
    { concurrencyLevel, retryCount },
  );
}
