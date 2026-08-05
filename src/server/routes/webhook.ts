import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  isFeedbackGitHubWebhookEvent,
  isSupportedGitHubWebhookEvent,
  type FeedbackWebhookPayload,
  type GitHubReviewCommentPayload,
  type GitHubWebhookPayload,
} from '@shared/github';
import type { AppBindings, AppEnv } from '@server/env';
import { loadRepoConfig } from '@server/core/config';
import { extractReviewRequest } from '@server/core/review';
import { verifyGitHubWebhookSignature } from '@server/core/verify';
import { jsonError } from '@server/core/http';
import { logger } from '@server/core/logger';
import { parseFindingMarker } from '@server/services/formatter';
import { findExistingJobForHead, insertJob, supersedeOlderJobs } from '@server/db/jobs';
import { clearResolvedFeedback, recordCommentFeedback, type CommentFeedbackInput, type CommentOutcome } from '@server/db/comment-feedback';
import { recordWebhookDelivery } from '@server/db/webhook-deliveries';

// Records what a human did with findings we posted.
//
// Matching is done through the invisible `codra-fp` marker embedded in each comment body, which
// GitHub echoes back verbatim. Comments without a marker were not written by us (or predate the
// marker) and are ignored.
//
// Best-effort throughout: feedback is an enhancement, and a failure here must never turn into a
// webhook error that GitHub retries.
async function handleFeedbackEvent(
  env: AppBindings,
  input: {
    eventName: string;
    payload: FeedbackWebhookPayload;
    repositoryId: number | null;
  },
): Promise<number> {
  const { eventName, payload, repositoryId } = input;
  // The repository has to be one we know; the FK would reject anything else.
  if (repositoryId === null) return 0;

  const botLogin = (env.BOT_USERNAME ?? '').toLowerCase();
  // GitHub fires these events for human threads too. Without this filter we would record humans
  // deleting each other's comments and then suppress our own findings on that basis.
  const isOurs = (comment: GitHubReviewCommentPayload) =>
    Boolean(botLogin) && (comment.user?.login ?? '').toLowerCase().startsWith(botLogin);

  const prNumber = payload.pull_request?.number ?? null;
  const entries: CommentFeedbackInput[] = [];
  const reopened: number[] = [];

  const add = (comment: GitHubReviewCommentPayload, outcome: CommentOutcome) => {
    if (!isOurs(comment)) return;
    const marker = parseFindingMarker(comment.body);
    if (!marker) return;
    entries.push({
      repositoryId,
      prNumber,
      fingerprint: marker.fingerprint,
      anchorHash: marker.anchorHash,
      // Null on comments posted before the marker gained a third field; suppression then falls back to
      // the v1 fingerprint alone, exactly as it did before.
      fingerprintV2: marker.fingerprintV2,
      githubCommentId: comment.id,
      outcome,
    });
  };

  if (eventName === 'pull_request_review_comment') {
    const { action, comment } = payload as Extract<FeedbackWebhookPayload, { comment: unknown }>;
    // 'created' is how we learn the real GitHub comment id, for free -- no extra request in the
    // already tight finalize invocation. 'deleted' is the only negative signal we act on.
    if (action === 'created') add(comment, 'posted');
    else if (action === 'deleted') add(comment, 'deleted');
  } else if (eventName === 'pull_request_review_thread') {
    const { action, thread } = payload as Extract<FeedbackWebhookPayload, { thread: unknown }>;
    for (const comment of thread?.comments ?? []) {
      if (action === 'resolved') {
        add(comment, 'resolved');
      } else if (action === 'unresolved') {
        add(comment, 'unresolved');
        if (isOurs(comment)) reopened.push(comment.id);
      }
    }
  }

  if (entries.length === 0) return 0;

  try {
    // Reopening a thread must retract the earlier 'resolved' row, or the finding stays recorded as
    // accepted forever.
    if (reopened.length > 0) await clearResolvedFeedback(env, repositoryId, reopened);
    return await recordCommentFeedback(env, entries);
  } catch (error) {
    logger.warn('Could not record comment feedback', {
      eventName,
      repositoryId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

export async function handleGitHubWebhook(c: Context<AppEnv>) {
    const eventName = c.req.header('x-github-event');
    const deliveryId = c.req.header('x-github-delivery');
    const signature = c.req.header('x-hub-signature-256');
    const rawBody = await c.req.text();

    if (!eventName || !deliveryId) {
      return jsonError('Missing GitHub webhook headers.', 400);
    }

    const verified = await verifyGitHubWebhookSignature(c.env.GITHUB_APP_WEBHOOK_SECRET, signature ?? null, rawBody);
    if (!verified) {
      return jsonError('Invalid webhook signature.', 401);
    }

    let payload: GitHubWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as GitHubWebhookPayload;
    } catch {
      return jsonError('Invalid webhook JSON payload.', 400);
    }

    // Posting a review with N inline comments generates N feedback deliveries, each carrying the
    // whole pull_request object plus diff hunks. Storing those payloads would multiply
    // webhook_deliveries by an order of magnitude for data that is never replayed -- the row is
    // still written, so at-least-once delivery is still deduplicated.
    const isFeedbackEvent = isFeedbackGitHubWebhookEvent(eventName);

    const delivery = await recordWebhookDelivery(c.env, {
      deliveryId,
      eventName,
      owner: 'repository' in payload ? payload.repository.owner.login : null,
      repo: 'repository' in payload ? payload.repository.name : null,
      payload: isFeedbackEvent ? null : payload,
    });

    if (!delivery.inserted) {
      return c.json({ ok: true, duplicate: true }, 202);
    }

    const installationId = String(payload.installation?.id ?? '');
    if (!installationId || !('repository' in payload) || !payload.repository) {
      return c.json({ ok: true, ignored: true }, 202);
    }

    // Handled inline and answered immediately: recording feedback needs no repo config, no queue
    // message, and no Workflow. Placed before loadRepoConfig, which costs a KV read, possibly a DB
    // read, a KV write and a repo sync we have no use for here.
    if (isFeedbackEvent) {
      const recorded = await handleFeedbackEvent(c.env, {
        eventName,
        payload: payload as unknown as FeedbackWebhookPayload,
        repositoryId: delivery.repositoryId,
      });
      return c.json({ ok: true, feedback: true, recorded }, 202);
    }

    if (!isSupportedGitHubWebhookEvent(eventName)) {
      return c.json({ ok: true, ignored: true, eventName }, 202);
    }

    const repoConfig = await loadRepoConfig(c.env, {
      installationId,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    });

    if (repoConfig.enabled === false) {
      return c.json({ ok: true, ignored: true, reason: 'repository_disabled' }, 202);
    }

    const extracted = extractReviewRequest({
      eventName,
      payload,
      botUsername: c.env.BOT_USERNAME,
      config: repoConfig.parsedJson,
    });

    if (extracted?.commitSha && extracted.baseSha) {
      const existingJob = await findExistingJobForHead(c.env, {
        owner: extracted.owner,
        repo: extracted.repo,
        prNumber: extracted.prNumber,
        commitSha: extracted.commitSha,
        trigger: extracted.trigger,
      });

      if (existingJob) {
        return c.json({
          ok: true,
          duplicate: true,
          message: existingJob.status === 'queued' ? 'queued' : 'duplicate',
          job: existingJob,
        }, 202);
      }

      const job = await insertJob(c.env, {
        installationId: extracted.installationId,
        owner: extracted.owner,
        repo: extracted.repo,
        prNumber: extracted.prNumber,
        prTitle: extracted.prTitle,
        prAuthor: extracted.prAuthor,
        commitSha: extracted.commitSha,
        baseSha: extracted.baseSha,
        trigger: extracted.trigger,
        headRef: extracted.headRef,
        baseRef: extracted.baseRef,
        configSnapshot: repoConfig.parsedJson,
      });

      await supersedeOlderJobs(c.env, {
        installationId: extracted.installationId,
        owner: extracted.owner,
        repo: extracted.repo,
        prNumber: extracted.prNumber,
        newJobId: job.id,
      });

      await c.env.REVIEW_QUEUE.send({
        jobId: job.id,
        deliveryId,
        phase: 'prepare',
        requestId: c.get('requestId'),
      });

      return c.json({ ok: true, message: 'queued', job }, 202);
    }

    // Events that do not produce a concrete job, such as PR close cleanup or
    // mention events that need PR lookup, are still handled by the worker.
    await c.env.REVIEW_QUEUE.send({
      deliveryId,
      eventName,
      requestId: c.get('requestId'),
    });

    return c.json({ ok: true, message: 'queued' }, 202);
}

export function createWebhookRouter() {
  const app = new Hono<AppEnv>();

  app.post('/', handleGitHubWebhook);

  return app;
}
