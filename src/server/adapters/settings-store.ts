import type { LearningStore, ModelConfigReader, RepoConfigLoader, ReviewSettingsReader, WebhookDeliveryReader } from '@codra/core/ports';
import type { AppBindings } from '@server/env';
import { getReviewSettings } from '@server/db/app-settings';
import { getResolvedModelConfig } from '@server/db/model-configs';
import { getWebhookDelivery } from '@server/db/webhook-deliveries';
import { getRejectedExemplars, getRepositoryIdForJob } from '@server/db/learning';
import { loadRepoConfig } from '@server/core/config';

export function makeReviewSettingsReader(env: AppBindings): ReviewSettingsReader {
  return { getReviewSettings: () => getReviewSettings(env) };
}

export function makeModelConfigReader(env: AppBindings): ModelConfigReader {
  // Returns the full ResolvedModelConfig, which the narrower port type discards -- deliberately, so
  // encryptedApiKey has no path into the engine.
  return { getResolvedModelConfig: (modelId) => getResolvedModelConfig(env, modelId) };
}

export function makeWebhookDeliveryReader(env: AppBindings): WebhookDeliveryReader {
  return { getWebhookDelivery: (deliveryId) => getWebhookDelivery(env, deliveryId) };
}

export function makeLearningStore(env: AppBindings): LearningStore {
  return {
    getRepositoryIdForJob: (jobId) => getRepositoryIdForJob(env, jobId),
    getRejectedExemplars: (input) => getRejectedExemplars(env, input),
  };
}

export function makeRepoConfigLoader(env: AppBindings): RepoConfigLoader {
  return { loadRepoConfig: (input) => loadRepoConfig(env, input) };
}
