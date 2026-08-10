import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { AppBindings } from '@server/env';
import { runReviewJob, FRESH_INVOCATION_YIELD_SECONDS } from '@server/core/review';
import { type ReviewJobMessage } from '@shared/schema';
import { setJobWorkflowInstance } from '@server/db/jobs';
import { logger } from '@server/core/logger';
import { runBestEffortJobMaintenance } from '@server/core/job-recovery';
import { runWithDb } from '@server/db/client';

export class ReviewWorkflow extends WorkflowEntrypoint<AppBindings, ReviewJobMessage> {
  async run(event: WorkflowEvent<ReviewJobMessage>, step: WorkflowStep) {
    // One DB client for the whole invocation, instead of a Hyperdrive connection per query; a replay after step.sleep just runs this again for the new invocation.
    return runWithDb(this.env, () => this.execute(event, step));
  }

  private async execute(event: WorkflowEvent<ReviewJobMessage>, step: WorkflowStep) {
    const params = event.payload;
    const env = this.env;

    const jobId = params.jobId ?? params.deliveryId;

    await step.do('bind-workflow-id', async () => {
      try {
        if (jobId) {
          await setJobWorkflowInstance(env, jobId, event.instanceId);
        }
      } catch (err) {
        logger.warn('Failed to bind workflow ID to job', err instanceof Error ? err : new Error(String(err)));
      }
    });

    try {
      await step.do('pre-maintenance', async () => {
        await runBestEffortJobMaintenance(env);
      });
    } catch (e) {
    // Ignore maintenance errors
    }

    let phase = params.phase ?? 'prepare';
    let delaySeconds = 0;
    let attempt = 0;

    while (phase) {
      attempt++;

      if (delaySeconds > 0) {
        await step.sleep(`sleep-${phase}-${attempt}`, `${delaySeconds} seconds`);
      }

      const currentPhase = phase;
      
      let result;
      try {
        result = await step.do(`run-${currentPhase}-${attempt}`, {
          retries: { limit: 5, delay: '60 seconds', backoff: 'exponential' },
          timeout: '15 minutes'
        }, async () => {
          return await runReviewJob(env, { ...params, phase: currentPhase, workflowInstanceId: event.instanceId });
        });
      } catch (error) {
        await step.do(`telemetry-failure-${currentPhase}-${attempt}`, async () => {
          const { sendTelemetryEvent } = await import('@server/core/telemetry');
          await sendTelemetryEvent(env, {
            linesReviewed: 0,
            findingsReported: 0,
            inputTokens: 0,
            outputTokens: 0,
            modelsUsed: [],
            fileExtensions: [],
            triggerType: params.eventName === 'pull_request' ? 'auto' : 'mention',
            reviewDurationMs: 0,
            filesReviewed: 0,
            verdict: 'failed',
            severityDistribution: {},
            // concurrencyLevel is not available in the workflow context (no DB access at this level)
            concurrencyLevel: 'unknown',
            prTotalLinesChanged: 0,
            // attempt is 1-indexed; subtract 1 so the first run is retryCount=0
            retryCount: Math.max(0, attempt - 1),
          });
        });
        throw error;
      }

      if (result.action === 'next_phase') {
        // Hand the next phase to a BRAND-NEW instance when this one can no longer get a clean subrequest budget: a long-lived instance stops hibernating between steps, so its budget never resets.
        if (result.freshInstance) {
          const nextJobId = result.jobId ?? jobId;
          if (nextJobId) {
            const nextPhase = result.phase;
            await step.do(`enqueue-fresh-${nextPhase}-${attempt}`, async () => {
              await env.REVIEW_QUEUE.send({
                jobId: nextJobId,
                deliveryId: crypto.randomUUID(),
                phase: nextPhase,
                forceFreshInstance: true,
              });
            });
            break;
          }
        }
        phase = result.phase;
        // Floor at FRESH_INVOCATION_YIELD_SECONDS, not 1: a short sleep does NOT hibernate, so the next phase would run on a spent budget while its TokenTracker starts at zero.
        delaySeconds = Math.max(result.delaySeconds ?? 0, FRESH_INVOCATION_YIELD_SECONDS);
      } else if (result.action === 'retry') {
        delaySeconds = result.delaySeconds ?? 60;
      } else {
        // 'ack' or completion
        break;
      }
    }

    // Yield first, so maintenance gets its own subrequest budget rather than the remains of the one the final phase step may have just exhausted.
    await step.sleep('pre-post-maintenance-yield', `${FRESH_INVOCATION_YIELD_SECONDS} seconds`);

    try {
      await step.do('post-maintenance', async () => {
        await runBestEffortJobMaintenance(env);
      });
    } catch (e) {
    // Ignore maintenance errors
    }
  }
}
