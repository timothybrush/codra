import type { AppBindings } from '@server/env';
import type { FileReviewStore } from '@codra/core/ports';
import { makeFileReviewStore as makeDbFileReviewStore } from '@codra/db/repositories';
import type { DbEnv } from '@codra/db/env';

export function makeFileReviewStore(env: AppBindings): FileReviewStore {
  const dbEnv: DbEnv = {
    HYPERDRIVE: env.HYPERDRIVE,
    APP_KV: env.APP_KV,
    workerMode: true,
  };
  return makeDbFileReviewStore(dbEnv);
}
