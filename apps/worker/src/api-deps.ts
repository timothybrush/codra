import type { ApiRouterDeps } from '@codraoss/api';
import type { AppBindings } from './env';

import * as dbAccounts from '@codraoss/db/accounts';
import * as dbJobs from '@codraoss/db/jobs';
import * as dbFileReviews from '@codraoss/db/file-reviews';
import * as dbCommentFeedback from '@codraoss/db/comment-feedback';
import * as dbModelConfigs from '@codraoss/db/model-configs';
import * as dbRepoConfigs from '@codraoss/db/repo-configs';
import * as dbAppSettings from '@codraoss/db/app-settings';
import * as dbStats from '@codraoss/db/stats';
import * as dbWebhookDeliveries from '@codraoss/db/webhook-deliveries';

import { GitHubClient, normalizeGitHubWebhook } from '@codraoss/provider-github';
import { GitHubIdentityProvider } from '@codraoss/provider-github/oauth';
import { getGlobalConfig, updateGlobalConfig, loadRepoConfig, invalidateRepoConfigCache } from './core/config';

import { getUpdatesEmailPreference, syncUpdatesEmail } from './core/updates-email';

import { getOrFetchRawDiffForCompletedJob, extractReviewRequest } from './core/review';

import { createOAuthState, consumeOAuthState } from './core/oauth';

import { verifyGitHubWebhookSignature } from '@codraoss/core/verify';

import { CloudflareSessionStore } from './sessions';
import { makeKvStore } from './adapters/platform';
import { logger } from './core/logger';

// model sync dependencies
import { listLlmProviderSecrets, upsertDiscoveredModelConfigs, createLlmProvider, updateLlmProvider, getResolvedModelConfig, getLlmProvider } from '@codraoss/db/model-configs';
import { encryptLlmApiKey, decryptLlmApiKey, listProviderModels, reviewWithCloudflare, reviewWithGoogle, reviewWithVertex, reviewWithOpenAI, reviewWithAnthropic, ProviderRequestError } from '@codraoss/models';
import { buildReviewResponseSchema } from '@codraoss/core/prompts/file-review';

function getSecretStore(env: AppBindings) {
  return { getSecret: async (key: string) => (env as any)[key] as string || null };
}

function optionalEnv(value: () => string) {
  try {
    const resolved = value().trim();
    return resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

// `IDENTITY_PROVIDER` is a test-only seam; production has no such binding.
const githubIdentity = new GitHubIdentityProvider();
function identityProvider(env: AppBindings) {
  return env.IDENTITY_PROVIDER ?? githubIdentity;
}

export function createApiRouterDeps(env: AppBindings, _ctx: ExecutionContext): ApiRouterDeps {
  return {
    repositories: {
      accounts: dbAccounts,
      jobs: dbJobs,
      fileReviews: dbFileReviews,
      commentFeedback: dbCommentFeedback,
      modelConfigs: dbModelConfigs,
      repoConfigs: dbRepoConfigs,
      appSettings: dbAppSettings,
      stats: dbStats,
      webhookDeliveries: dbWebhookDeliveries,
    },
    gitProvider: {
      getAppInstallationUrl: async () => await GitHubClient.getAppInstallationUrl(env as any),
      listInstallations: async () => await GitHubClient.listInstallations(env as any),
      createService: (installationId?: number | string | null) => new GitHubClient(env as any, String(installationId)),
    },
    config: {
      getGlobalConfig: async () => await getGlobalConfig(env),
      updateGlobalConfig: async (config: any) => await updateGlobalConfig(env, config),
      loadRepoConfig: async (input: any) => await loadRepoConfig(env, input),
      invalidateRepoConfigCache: async (owner: string, repo: string) => await invalidateRepoConfigCache(env, owner, repo),
    },
    modelRunner: {
      syncProviderModelCatalog: async () => {
        const providers = await listLlmProviderSecrets(env as any);
        const syncErrors: Array<{ providerId: string; providerName: string; error: string }> = [];

        await Promise.all(providers.map(async (provider) => {
          if (!provider.enabled) return;
          if (provider.apiFormat !== 'cloudflare-workers-ai' && !provider.encryptedApiKey) return;

          try {
            const apiKey = provider.encryptedApiKey
              ? await decryptLlmApiKey(getSecretStore(env), provider.encryptedApiKey)
              : undefined;
            const modelNames = await listProviderModels({
              apiFormat: provider.apiFormat,
              baseUrl: provider.baseUrl,
              apiKey,
              cloudflareAccountId: optionalEnv(() => env.CF_ACCOUNT_ID),
              cloudflareApiToken: optionalEnv(() => env.CF_API_TOKEN),
            });
            await upsertDiscoveredModelConfigs(env as any, {
              providerId: provider.id,
              providerName: provider.name,
              apiFormat: provider.apiFormat,
              modelNames,
            });
          } catch (error) {
            syncErrors.push({
              providerId: provider.id,
              providerName: provider.name,
              error: error instanceof Error ? error.message : 'Could not refresh provider models.',
            });
          }
        }));

        return syncErrors;
      },
      testConnection: async (modelId: string) => {
        const config = await getResolvedModelConfig(env as any, modelId);
        if (!config) throw { isNotFoundError: true };
        if (!config.providerEnabled) throw { isDisabledError: true, message: 'Provider is disabled.' };

        try {
          const input = {
            systemPrompt: 'You are validating connectivity. Return only the JSON object.',
            userPrompt: 'Return an empty review: no findings, overall_correctness "patch is correct".',
            responseSchema: buildReviewResponseSchema(1),
          };
          let response;
          if (config.apiFormat === 'cloudflare-workers-ai') {
            response = await reviewWithCloudflare(env.AI, config.modelName, input, undefined, config.providerName);
          } else {
            if (!config.encryptedApiKey) {
              throw { isMissingKeyError: true, message: `Provider ${config.providerName} does not have a saved API key.` };
            }
            const apiKey = await decryptLlmApiKey(getSecretStore(env), config.encryptedApiKey);
            
            switch (config.apiFormat) {
              case 'gemini':
                response = await reviewWithGoogle({ apiKey, baseUrl: config.baseUrl, providerName: config.providerName, timeoutMs: 15000 }, config.modelName, input);
                break;
              case 'vertex':
                response = await reviewWithVertex({ apiKey, baseUrl: config.baseUrl, providerName: config.providerName }, config.modelName, input);
                break;
              case 'openai':
                response = await reviewWithOpenAI({ apiKey, baseUrl: config.baseUrl || 'https://api.openai.com/v1', providerName: config.providerName }, config.modelName, input);
                break;
              case 'anthropic':
                response = await reviewWithAnthropic({ apiKey, baseUrl: config.baseUrl, providerName: config.providerName }, config.modelName, input);
                break;
              default:
                throw new Error(`Unsupported API format: ${config.apiFormat}`);
            }
          }
          return {
            ok: true,
            modelUsed: response.modelUsed,
            provider: response.provider,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            ...(response.degraded === 'schema-dropped'
              ? { degraded: response.degraded, warning: 'Connected, but this endpoint rejected the response grammar. Reviews will run without constrained decoding.' }
              : {}),
          };
        } catch (error) {
          if (error instanceof ProviderRequestError) {
             throw { status: error.status >= 500 ? 502 : error.status, message: error.message };
          }
          throw error;
        }
      },
      createProviderWithSecret: async (input: any) => {
        let encryptedApiKey: string | null;
        try {
          encryptedApiKey = input.apiFormat === 'cloudflare-workers-ai'
            ? null
            : (input.apiKey ? await encryptLlmApiKey(getSecretStore(env), input.apiKey.trim()) : null);
        } catch (error) {
          if (error instanceof Error && error.message.includes('LLM_CONFIG_ENCRYPTION_KEY')) {
            throw { isEncryptionConfigError: true, message: error.message };
          }
          throw error;
        }

        if (input.enabled && input.apiFormat !== 'cloudflare-workers-ai' && !encryptedApiKey) {
          throw { isKeyRequiredError: true };
        }

        try {
          return await createLlmProvider(env as any, {
            name: input.name,
            apiFormat: input.apiFormat,
            baseUrl: input.apiFormat === 'cloudflare-workers-ai' ? null : (input.baseUrl ? input.baseUrl.replace(/\/+$/, '') : null), // basic normalization
            encryptedApiKey,
            enabled: input.enabled,
          });
        } catch (error: any) {
          if (error?.code === '23505') throw { isUniqueNameError: true };
          throw error;
        }
      },
      updateProviderWithSecret: async (id: string, input: any) => {
        const existing = await getLlmProvider(env as any, id);
        if (!existing) return null;

        let encryptedApiKey: string | null | undefined;
        try {
          encryptedApiKey = input.apiFormat === 'cloudflare-workers-ai'
            ? null
            : (input.clearApiKey ? null : (input.apiKey ? await encryptLlmApiKey(getSecretStore(env), input.apiKey.trim()) : undefined));
        } catch (error) {
          if (error instanceof Error && error.message.includes('LLM_CONFIG_ENCRYPTION_KEY')) {
            throw { isEncryptionConfigError: true, message: error.message };
          }
          throw error;
        }

        const effectiveEncryptedApiKey = encryptedApiKey !== undefined ? encryptedApiKey : existing.encryptedApiKey;
        if (input.enabled && input.apiFormat !== 'cloudflare-workers-ai' && !effectiveEncryptedApiKey) {
          throw { isKeyRequiredError: true };
        }

        try {
          return await updateLlmProvider(env as any, id, {
            name: input.name,
            apiFormat: input.apiFormat,
            baseUrl: input.apiFormat === 'cloudflare-workers-ai' ? null : (input.baseUrl ? input.baseUrl.replace(/\/+$/, '') : null),
            ...(encryptedApiKey !== undefined ? { encryptedApiKey } : {}),
            enabled: input.enabled,
          });
        } catch (error: any) {
          if (error?.code === '23505') throw { isUniqueNameError: true };
          throw error;
        }
      },
    },
    sessionStore: new CloudflareSessionStore(env.APP_KV),
    platform: {
      scheduleBestEffortJobMaintenance: (executionContext: any) => {
        try {
            executionContext?.waitUntil(
              import('./core/job-recovery').then(m => m.runBestEffortJobMaintenance(env))
            );
        } catch (e) { /* ignore */ }
      },
      createReviewRuntime: () => ({ kv: makeKvStore(env) } as any),
      getUpdatesEmailPreference: async (githubUserId: number) => await getUpdatesEmailPreference(env, githubUserId),
      syncUpdatesEmail: async (githubUserId: number, email: string | null | undefined) => await syncUpdatesEmail(env, githubUserId, email),
      terminateJobWorkflow: async (job: { id: string; workflowInstanceId?: string | null }) => {
        if (job.workflowInstanceId) {
          try {
            const instance = await env.REVIEW_WORKFLOW.get(job.workflowInstanceId);
            await instance.terminate();
          } catch (e) { /* ignore */ }
        }
      },
      enqueueReviewJob: async (input: any) => {
        await env.REVIEW_QUEUE.send(input);
      },
      getOrFetchRawDiffForCompletedJob: async (runtime: any, job: any, github: any) => {
        return await getOrFetchRawDiffForCompletedJob(runtime, job, github);
      },
      logger,
    },
    authProvider: {
      createOAuthState: async () => await createOAuthState(env),
      consumeOAuthState: async (state: string) => await consumeOAuthState(env, state),
      beginAuthorization: async (callbackUrl: string, state: string) =>
        await identityProvider(env).beginAuthorization(callbackUrl, state, env),
      completeAuthorization: async (code: string, state: string, expectedState: string) =>
        await identityProvider(env).completeAuthorization(code, state, expectedState, env),
    },
    webhook: {
      verifySignature: async (signature: string | null, body: string) => await verifyGitHubWebhookSignature(env.GITHUB_APP_WEBHOOK_SECRET, signature, body),
      normalizePayload: (eventName: string, payload: any) => normalizeGitHubWebhook(eventName, payload),
      extractReviewRequest: (input: any) => extractReviewRequest(input),
    },
  };
}
