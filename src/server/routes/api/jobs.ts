import { Hono } from 'hono';
import type { Context } from 'hono';
import { defaultRepoConfig, findingLabelSchema, jobsQuerySchema } from '@shared/schema';
import { getFindingLabelTarget } from '@server/db/file-reviews';
import { clearDashboardFeedback, upsertDashboardFeedback } from '@server/db/comment-feedback';
import type { AppEnv } from '@server/env';
import { bytesToHex, cancelJob, deleteJob, getJobDetail, getJobForProcessing, insertJob, listJobs, mapJob, supersedeOlderJobs } from '@server/db/jobs';
import { jsonError } from '@server/core/http';
import { scheduleBestEffortJobMaintenance } from '@server/core/job-recovery';
import { loadRepoConfig } from '@server/core/config';
import { logger } from '@server/core/logger';
import type { AppBindings } from '@server/env';
import { getOrFetchRawDiffForCompletedJob } from '@server/core/review';
import { parseUnifiedDiff } from '@server/core/diff';
import { buildFileReviewPrompts } from '@server/prompts/file-review';
import { GitHubService } from '@server/services/github';

/**
 * Best-effort termination of a job's Cloudflare Workflow instance. The instance id is the one we
 * stored (workflowInstanceId) or, as a fallback, the job id we passed to REVIEW_WORKFLOW.create().
 * .get() throws if the instance doesn't exist and .terminate() throws if it's already terminal --
 * both are non-fatal here (there's simply nothing left to stop).
 */
async function terminateJobWorkflow(env: AppBindings, job: { id: string; workflowInstanceId?: string | null }) {
  const instanceId = job.workflowInstanceId ?? job.id;
  try {
    const instance = await env.REVIEW_WORKFLOW.get(instanceId);
    await instance.terminate();
  } catch (error) {
    logger.info(`Could not terminate workflow for job ${job.id} (already finished or never started)`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function jobEtag(input: { id: string; status: string; updatedAt: string; fileCount: number; commentCount: number }) {
  return `"job-${input.id}-${input.status}-${input.fileCount}-${input.commentCount}-${new Date(input.updatedAt).getTime()}"`;
}

function getExecutionContext(c: Context<AppEnv>) {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

export function createJobsRouter() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    scheduleBestEffortJobMaintenance(c.env, getExecutionContext(c));

    const rawQuery = c.req.query();
    const query = jobsQuerySchema.parse(rawQuery);

    const result = await listJobs(c.env, query as any);
    return c.json(result);
  });

  app.get('/:id', async (c) => {
    scheduleBestEffortJobMaintenance(c.env, getExecutionContext(c));

    const job = await getJobDetail(c.env, c.req.param('id'));
    if (!job) {
      return jsonError('Job not found.', 404);
    }

    const etag = jobEtag(job);
    const lastModified = new Date(job.updatedAt).toUTCString();
    if (c.req.header('if-none-match') === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Last-Modified': lastModified,
        },
      });
    }

    const response = c.json({ job });
    response.headers.set('ETag', etag);
    response.headers.set('Last-Modified', lastModified);
    response.headers.set('Cache-Control', 'private, no-cache');
    return response;
  });

  // diff_input (the rendered prompt embedding that file's diff) isn't persisted to Postgres --
  // reconstructed here on demand, only when the client actually opens Files-changed/Raw Logs.
  // Reuses the same KV cache the job wrote during processing while it's still warm (fast path),
  // and falls back to re-deriving the exact same diff from GitHub (via the job's own base/head
  // commits, not the live PR) once that 6h TTL has lapsed.
  app.get('/:id/diffs', async (c) => {
    const job = await getJobDetail(c.env, c.req.param('id'));
    if (!job) {
      return jsonError('Job not found.', 404);
    }

    const config = job.configSnapshot ?? defaultRepoConfig;
    const github = new GitHubService(c.env, job.installationId);

    let rawDiff: string;
    try {
      rawDiff = await getOrFetchRawDiffForCompletedJob(
        c.env,
        { id: job.id, owner: job.owner, repo: job.repo, baseSha: job.baseSha, commitSha: job.commitSha },
        github,
      );
    } catch (error) {
      logger.warn(`Could not reconstruct diff for job ${job.id}`, error instanceof Error ? error : new Error(String(error)));
      return c.json({ diffs: {} });
    }

    // The ENTIRE PR diff (every reviewable file), not just files that already have a
    // review row -- so the Files-changed view matches GitHub's diff even while a job
    // is still mid-review and most files haven't been processed yet.
    const diffs: Record<string, string> = {};
    for (const file of parseUnifiedDiff(rawDiff, config.review)) {
      if (file.isDeleted || file.isBinary || !file.path) continue;
      diffs[file.path] = buildFileReviewPrompts({
        file,
        prTitle: job.prTitle,
        prDescription: null,
        config: config.review,
      }).userPrompt;
    }

    const response = c.json({ diffs });
    response.headers.set('Cache-Control', 'private, max-age=60');
    return response;
  });

  // Shared logic for "re-run" (retry) and "rerun from start". Creates a fresh job for the same PR,
  // supersedes any older queued/running jobs, and enqueues the prepare phase. When inherit=true the
  // new job links to its parent (retryOfJobId) and reuses already-`done` file reviews; when false
  // it starts from scratch (no inheritance) so every file is reviewed again.
  async function startReplacementJob(c: Context<AppEnv>, rawSource: NonNullable<Awaited<ReturnType<typeof getJobForProcessing>>>, options: { inherit: boolean }) {
    const source = mapJob(rawSource);
    let configSnapshot;
    try {
      const currentConfig = await loadRepoConfig(c.env, {
        installationId: source.installationId,
        owner: source.owner,
        repo: source.repo,
      });
      configSnapshot = currentConfig?.parsedJson ?? defaultRepoConfig;
    } catch (e) {
      configSnapshot = defaultRepoConfig;
    }

    const job = await insertJob(c.env, {
      installationId: source.installationId,
      owner: source.owner,
      repo: source.repo,
      prNumber: source.prNumber,
      prTitle: source.prTitle,
      prAuthor: source.prAuthor,
      commitSha: source.commitSha,
      baseSha: bytesToHex(rawSource.base_sha), // base_sha is only in raw row/detail
      trigger: 'retry',
      headRef: rawSource.head_ref,
      baseRef: rawSource.base_ref,
      configSnapshot,
      ...(options.inherit ? { retryOfJobId: source.id } : {}),
    });

    // Supersede any older pending/running jobs for this PR
    await supersedeOlderJobs(c.env, {
      installationId: source.installationId,
      owner: source.owner,
      repo: source.repo,
      prNumber: source.prNumber,
      newJobId: job.id,
    });

    // Send to queue using the NEW schema (background worker will handle it)
    await c.env.REVIEW_QUEUE.send({
      jobId: job.id,
      deliveryId: crypto.randomUUID(),
      phase: 'prepare',
      requestId: c.get('requestId'),
    });

    return job;
  }

  // Re-run: reuse the parent's already-completed file reviews where the model strategy still matches.
  app.post('/:id/retry', async (c) => {
    const rawSource = await getJobForProcessing(c.env, c.req.param('id'));
    if (!rawSource) {
      return jsonError('Job not found.', 404);
    }
    const job = await startReplacementJob(c, rawSource, { inherit: true });
    return c.json({ job }, 202);
  });

  // Rerun from start: review every file again from scratch (no inheritance). Stops the current run
  // first so two workflows don't race on the same PR.
  app.post('/:id/rerun', async (c) => {
    const rawSource = await getJobForProcessing(c.env, c.req.param('id'));
    if (!rawSource) {
      return jsonError('Job not found.', 404);
    }
    const source = mapJob(rawSource);
    if (source.status === 'queued' || source.status === 'running') {
      await terminateJobWorkflow(c.env, source);
    }
    const job = await startReplacementJob(c, rawSource, { inherit: false });
    return c.json({ job }, 202);
  });

  // Stop an ongoing job: terminate its workflow and mark it 'cancelled'.
  app.post('/:id/stop', async (c) => {
    const id = c.req.param('id');
    const raw = await getJobForProcessing(c.env, id);
    if (!raw) {
      return jsonError('Job not found.', 404);
    }
    const job = mapJob(raw);
    if (job.status !== 'queued' && job.status !== 'running') {
      return jsonError('Only a queued or running job can be stopped.', 409);
    }
    await terminateJobWorkflow(c.env, job);
    await cancelJob(c.env, id);
    const updated = await getJobForProcessing(c.env, id);
    return c.json({ job: updated ? mapJob(updated) : job }, 200);
  });

  /**
   * Record a human verdict on one finding.
   *
   * The only way to get ground truth into this system. Until now the sole capture path was a human
   * deleting an inline GitHub comment, which nobody does -- so `comment_feedback` sat empty and every
   * accuracy question had to be answered by hand-auditing a review.
   *
   * Marking a finding WRONG suppresses it repository-wide; marking it RIGHT does not suppress
   * anything and exists purely for measurement. See the note on CommentOutcome.
   */
  app.put('/:id/findings/:fingerprint/label', async (c) => {
    const jobId = c.req.param('id');
    const fingerprint = c.req.param('fingerprint');

    const parsed = findingLabelSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return jsonError('Body must be {"label":"right"|"wrong"}.', 400);

    const target = await getFindingLabelTarget(c.env, jobId, fingerprint);
    if (!target) return jsonError('Finding not found on this job.', 404);

    await upsertDashboardFeedback(c.env, {
      repositoryId: target.repository_id,
      prNumber: target.pr_number,
      fingerprint,
      anchorHash: target.anchor_hash,
      jobId,
      labelledBy: c.get('sessionUser')?.githubUserId ?? null,
      outcome: parsed.data.label === 'wrong' ? 'marked_wrong' : 'marked_right',
    });

    return c.json({ label: parsed.data.label }, 200);
  });

  // Undo a label. Scoped to dashboard-sourced rows so a genuine GitHub deletion stays recorded.
  app.delete('/:id/findings/:fingerprint/label', async (c) => {
    const jobId = c.req.param('id');
    const fingerprint = c.req.param('fingerprint');

    const target = await getFindingLabelTarget(c.env, jobId, fingerprint);
    if (!target) return jsonError('Finding not found on this job.', 404);

    await clearDashboardFeedback(c.env, target.repository_id, fingerprint);
    return c.body(null, 204);
  });

  // Delete a job (cascades to its file reviews and comments). Stops the workflow first if running.
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const raw = await getJobForProcessing(c.env, id);
    if (!raw) {
      return jsonError('Job not found.', 404);
    }
    const job = mapJob(raw);
    if (job.status === 'queued' || job.status === 'running') {
      await terminateJobWorkflow(c.env, job);
    }
    await deleteJob(c.env, id);
    return c.body(null, 204);
  });

  return app;
}
