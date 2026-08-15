import { createApp } from '../../../src/server/app';
import { ReviewWorkflow } from './workflows/review';
import type { AppBindings } from './env';
import { reviewJobMessageSchema } from '@codra/schema';
import { logger } from '@server/core/logger';
import { disposeRpc } from '@server/core/rpc';
import { runWithDb } from '@codra/db/client';
import { failJob, hasPendingMaintenanceWork, clearSystemActive } from '@codra/db/jobs';
import { runBestEffortJobMaintenance } from '@server/core/job-recovery';

import { CloudflareSessionStore } from './sessions';
const app = createApp();

export { ReviewWorkflow };

export default {
  fetch(request: Request, env: AppBindings, ctx: ExecutionContext) {
    const apiEnv = {
      ...env,
      SESSION_STORE: new CloudflareSessionStore(env.APP_KV),
    };
    return runWithDb(env, () => app.fetch(request, apiEnv as any, ctx));
  },

  async scheduled(_controller: ScheduledController, env: AppBindings, _ctx: ExecutionContext) {
    // The cron fires every 2 minutes but only does maintenance (recovering stuck jobs, finishing
    // check runs). Touching Postgres every tick would keep the serverless DB awake 24/7, so gate on
    // a KV flag set whenever a job is created/claimed and cleared once nothing is left to maintain
    // -- when it's absent we return without ever opening a DB connection.
    try {
      const active = await env.APP_KV.get('system:active_jobs');
      if (!active) {
        return;
      }
    } catch (error) {
      logger.warn('Failed to read active jobs flag from KV, proceeding with maintenance', error instanceof Error ? error : new Error(String(error)));
    }

    return runWithDb(env, async () => {
      await runBestEffortJobMaintenance(env);
      // Drop the flag as soon as nothing is left to maintain, so the next tick skips Postgres
      // instead of waiting out the 20-minute TTL; a new job re-sets it on insert/claim.
      try {
        if (!(await hasPendingMaintenanceWork(env))) {
          await clearSystemActive(env);
        }
      } catch (error) {
        logger.warn('Failed to evaluate pending maintenance work; leaving active-jobs flag to expire via TTL', error instanceof Error ? error : new Error(String(error)));
      }
    });
  },

  async queue(batch: MessageBatch<unknown>, env: AppBindings, _ctx: ExecutionContext) {
    return runWithDb(env, async () => {
      try {
        await runBestEffortJobMaintenance(env);
      } catch (error) {
        logger.error('Pre-batch maintenance task failed', error instanceof Error ? error : new Error(String(error)));
      }

      // Sequential by design: each iteration creates a Workflow instance (a subrequest), and a
      // batch can carry enough messages that fanning out would breach the Workers simultaneous-
      // subrequest cap on the Free plan.
      for (const message of batch.messages) {
        const parseResult = reviewJobMessageSchema.safeParse(message.body);

        if (!parseResult.success) {
          logger.error('Invalid queue message schema; dropping message', {
            body: message.body,
            error: parseResult.error.flatten(),
          });
          // A malformed message can't be processed and retrying won't help, so ack it -- but if it
          // still carries a recognizable jobId, fail that job so it doesn't sit 'queued' forever
          // (lease recovery only revives 'running' rows).
          const strandedId = (message.body as { jobId?: unknown })?.jobId;
          if (typeof strandedId === 'string' && /^[0-9a-f-]{36}$/i.test(strandedId)) {
            try {
              await failJob(env, strandedId, 'Review dropped: the queue message failed schema validation.');
            } catch (failError) {
              logger.error('Failed to fail job stranded by an invalid queue message', failError instanceof Error ? failError : new Error(String(failError)));
            }
          }
          message.ack();
          continue;
        }

        const { jobId, deliveryId, forceFreshInstance } = parseResult.data;

        try {
          // Recovery re-enqueues a stuck job under its original jobId; keying the instance on jobId
          // would collide with the dead instance (instance.already_exists), so recovery sets
          // forceFreshInstance to key the new instance on the (fresh) deliveryId -- a UUID,
          // matching workflow_instance_id's column type.
          const id = forceFreshInstance ? deliveryId : (jobId ?? deliveryId);
          if (!id) {
            logger.error('Message missing identifiers; dropping', { body: message.body });
            message.ack();
            continue;
          }
          // The returned handle is an RPC stub and this path never uses it; see core/rpc.ts.
          disposeRpc(await env.REVIEW_WORKFLOW.create({
             id,
             params: parseResult.data,
          }));
          message.ack();
        } catch (error) {
          if (error instanceof Error && error.message.includes('instance.already_exists')) {
            logger.info('Workflow instance already exists; dropping duplicate queue message.', {
              jobId,
              deliveryId,
            });
            message.ack();
            continue;
          }

          logger.error('Failed to create workflow', error instanceof Error ? error : new Error(String(error)));
          if (message.attempts >= 3) {
            const id = jobId ?? deliveryId;
            if (id) {
              try {
                await failJob(env, id, 'Failed to start Cloudflare Workflow after multiple attempts. The Cloudflare infrastructure might be experiencing an outage.');
              } catch (failError) {
                logger.error('Critical: Failed to mark job as failed in DB', failError instanceof Error ? failError : new Error(String(failError)));
              }
            }
            message.ack();
          } else {
            message.retry();
          }
        }
      }

      try {
        await runBestEffortJobMaintenance(env);
      } catch (error) {
        logger.error('Post-batch maintenance task failed', error instanceof Error ? error : new Error(String(error)));
      }
    });
  },
} satisfies ExportedHandler<AppBindings>;
