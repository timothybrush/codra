import type { AppBindings } from '@server/env';
import type { JobStore } from '@codra/core/ports';
import { makeJobStore as makeDbJobStore } from '@codra/db/repositories';
import type { DbEnv } from '@codra/db/env';

export function makeJobStore(env: AppBindings): JobStore {
  const dbEnv: DbEnv = {
    HYPERDRIVE: env.HYPERDRIVE,
    APP_KV: env.APP_KV,
    workerMode: true,
  };
  return makeDbJobStore(dbEnv);
}
