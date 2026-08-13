import { Hono } from 'hono';
import type { Context } from 'hono';
import { defaultRepoConfig, findingLabelSchema, jobsQuerySchema } from '@codra/schema';
import { getFindingLabelTarget } from '@server/db/file-reviews';
import { clearDashboardFeedback, upsertDashboardFeedback } from '@server/db/comment-feedback';
import type { AppBindings, AppEnv } from '@server/env';
import { bytesToHex, cancelJob, deleteJob, getJobDetail, getJobForProcessing, insertJob, listJobs, mapJob, supersedeOlderJobs } from '@server/db/jobs';
import { jsonError } from '@server/core/http';
import { scheduleBestEffortJobMaintenance } from '@server/core/job-recovery';
import { loadRepoConfig } from '@server/core/config';
import { logger } from '@server/core/logger';
import { disposeRpc } from '@server/core/rpc';
import { getOrFetchRawDiffForCompletedJob } from '@codra/core';
import { createReviewRuntime } from '@server/adapters';
import { parseUnifiedDiff } from '@server/core/diff';
import { buildFileReviewPrompts } from '@server/prompts/file-review';
import { GitHubService } from '@server/services/github';

// Best-effort terminate; .get() throws if the instance is gone and .terminate() if already terminal, both non-fatal.
async function terminateJobWorkflow(env: AppBindings, job: { id: string; workflowInstanceId?: string | null }) {
  const instanceId = job.workflowInstanceId ?? job.id;
  let instance: Awaited<ReturnType<typeof env.REVIEW_WORKFLOW.get>> | undefined;
  try {
    instance = await env.REVIEW_WORKFLOW.get(instanceId);
    await instance.terminate();
  } catch (error) {
    logger.info(`Could not terminate workflow for job ${job.id} (already finished or never started)`, {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // In `finally` on purpose: .terminate() throws on an already-terminal instance, and the handle
    // still needs releasing on that path. See core/rpc.ts.
    disposeRpc(instance);
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

  // diff_input is not persisted; rebuilt on demand from the job's own base/head commits (not the live PR), using the KV cache while warm.
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
        // Only needs the KV cache, but the composition root is cheap (a struct of closures) and
        // keeping one construction path means one place to change when a port is added.
        createReviewRuntime(c.env),
        { id: job.id, owner: job.owner, repo: job.repo, baseSha: job.baseSha, commitSha: job.commitSha },
        github,
      );
    } catch (error) {
      logger.warn(`Could not reconstruct diff for job ${job.id}`, error instanceof Error ? error : new Error(String(error)));
      return c.json({ diffs: {} });
    }

    // Must include the PR description: this reconstructs the prompt the model actually saw.
    let prDescription: string | null = null;
    try {
      prDescription = (await github.getPullRequest(job.owner, job.repo, job.prNumber)).body ?? null;
    } catch (error) {
      // Best-effort: a missing description degrades fidelity, never fails the view.
      logger.warn(`Could not load the PR body for job ${job.id}; prompts will omit the description`,
        error instanceof Error ? error : new Error(String(error)));
    }

    // The ENTIRE PR diff, not just files with a review row, so Files-changed matches GitHub mid-review.
    const diffs: Record<string, string> = {};
    for (const file of parseUnifiedDiff(rawDiff, config.review)) {
      if (file.isDeleted || file.isBinary || !file.path) continue;
      diffs[file.path] = buildFileReviewPrompts({
        file,
        prTitle: job.prTitle,
        prDescription,
        config: config.review,
      }).userPrompt;
    }

    const response = c.json({ diffs });
    response.headers.set('Cache-Control', 'private, max-age=60');
    return response;
  });

  // Shared by re-run and rerun-from-start; inherit=true links retryOfJobId and reuses `done` file reviews, false reviews everything.
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

    await supersedeOlderJobs(c.env, {
      installationId: source.installationId,
      owner: source.owner,
      repo: source.repo,
      prNumber: source.prNumber,
      newJobId: job.id,
    });

    await c.env.REVIEW_QUEUE.send({
      jobId: job.id,
      deliveryId: crypto.randomUUID(),
      phase: 'prepare',
      requestId: c.get('requestId'),
    });

    return job;
  }

  // Re-run: reuse the parent's completed reviews where the model strategy still matches.
  app.post('/:id/retry', async (c) => {
    const rawSource = await getJobForProcessing(c.env, c.req.param('id'));
    if (!rawSource) {
      return jsonError('Job not found.', 404);
    }
    const job = await startReplacementJob(c, rawSource, { inherit: true });
    return c.json({ job }, 202);
  });

  // Rerun from start: no inheritance. Stops the current run so two workflows cannot race.
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

  // Human verdict on one finding: WRONG suppresses repository-wide, RIGHT suppresses nothing and is purely measurement.
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
      // Carried so a rejection survives the model rewording its title.
      fingerprintV2: target.fingerprint_v2,
      jobId,
      labelledBy: c.get('sessionUser')?.githubUserId ?? null,
      outcome: parsed.data.label === 'wrong' ? 'marked_wrong' : 'marked_right',
    });

    return c.json({ label: parsed.data.label }, 200);
  });

  // Undo a label, scoped to dashboard rows so a real GitHub deletion stays recorded.
  app.delete('/:id/findings/:fingerprint/label', async (c) => {
    const jobId = c.req.param('id');
    const fingerprint = c.req.param('fingerprint');

    const target = await getFindingLabelTarget(c.env, jobId, fingerprint);
    if (!target) return jsonError('Finding not found on this job.', 404);

    await clearDashboardFeedback(c.env, target.repository_id, fingerprint);
    return c.body(null, 204);
  });

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
