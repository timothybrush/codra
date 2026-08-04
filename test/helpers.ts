import { describe } from 'vitest';
import type { AppBindings } from '@server/env';
import { encryptLlmApiKey } from '@server/core/llm-crypto';
import { queryRows } from '@server/db/client';

export class MemoryKV {
  private readonly store = new Map<string, string>();

  async put(key: string, value: string) {
    this.store.set(key, value);
  }

  async get(key: string, type?: 'text' | 'json' | Partial<KVNamespaceGetOptions<undefined>>) {
    const value = this.store.get(key) ?? null;
    if (value === null) return null;
    if (type === 'json') {
      return JSON.parse(value);
    }
    return value;
  }

  async getWithMetadata(key: string, type?: 'text' | 'json' | Partial<KVNamespaceGetOptions<undefined>>) {
    return {
      value: await this.get(key, type as 'text' | 'json'),
      metadata: null,
      cacheStatus: null,
    } as any;
  }

  async list() {
    return {
      keys: Array.from(this.store.keys()).map((name) => ({ name })),
      list_complete: true,
      cursor: '',
    } as any;
  }

  async delete(key: string) {
    this.store.delete(key);
  }
}

export class MockAssets {
  async fetch(input: RequestInfo | URL) {
    const request = input instanceof Request ? input : new Request(input);
    return new Response(`<html><body>${new URL(request.url).pathname}</body></html>`, {
      headers: { 'content-type': 'text/html' },
    });
  }
}

export class MockQueue {
  public readonly sent: any[] = [];

  async send(message: any, options?: { delaySeconds?: number }) {
    this.sent.push({ ...message, options });
  }
}

export class MockWorkflow {
  public readonly created: any[] = [];
  public readonly terminated: string[] = [];

  async create(opts: any) {
    this.created.push(opts);
  }

  async get(id: string) {
    return {
      terminate: async () => {
        this.terminated.push(id);
      },
    };
  }
}

function usableEnvValue(value: string | undefined) {
  return value && value !== 'undefined' && value !== 'null' ? value : null;
}

function requiredEnv(key: keyof NodeJS.ProcessEnv) {
  const value = usableEnvValue(process.env[key]);
  if (!value) {
    throw new Error(`Missing required test environment variable: ${key}`);
  }
  return value;
}

function unusedEnv(key: string): string {
  throw new Error(`${key} is not required by the current test suite. Add it to the test env only when a test exercises that path.`);
}

export function getTestDatabaseUrl() {
  return requiredEnv('TEST_DATABASE_URL');
}

export function hasConfiguredTestDatabaseUrl() {
  return Boolean(usableEnvValue(process.env.TEST_DATABASE_URL));
}

export function createTestEnv(overrides: Partial<AppBindings> = {}): AppBindings {
  return {
    AI: {
      async run() {
        return { response: '{"findings":[],"file_verdict":"approve","file_summary":"ok"}', usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
    },
    APP_KV: new MemoryKV() as unknown as KVNamespace,
    REVIEW_QUEUE: new MockQueue() as any,
    REVIEW_WORKFLOW: new MockWorkflow() as any,
    ASSETS: new MockAssets() as any,
    HYPERDRIVE: {
      connectionString: getTestDatabaseUrl(),
    },
    get APP_PRIVATE_KEY() { return unusedEnv('APP_PRIVATE_KEY'); },
    get GITHUB_APP_ID() { return unusedEnv('GITHUB_APP_ID'); },
    GITHUB_APP_SLUG: requiredEnv('GITHUB_APP_SLUG'),
    GITHUB_APP_WEBHOOK_SECRET: requiredEnv('GITHUB_APP_WEBHOOK_SECRET'),
    GITHUB_CLIENT_ID: requiredEnv('GITHUB_CLIENT_ID'),
    GITHUB_CLIENT_SECRET: requiredEnv('GITHUB_CLIENT_SECRET'),
    AUTH_CALLBACK_URL: requiredEnv('AUTH_CALLBACK_URL'),
    APP_URL: requiredEnv('APP_URL'),
    DASHBOARD_ALLOWED_USERS: requiredEnv('DASHBOARD_ALLOWED_USERS'),
    LLM_CONFIG_ENCRYPTION_KEY: 'test-llm-config-encryption-key',
    BOT_USERNAME: requiredEnv('BOT_USERNAME'),
    get ENVIRONMENT() { return unusedEnv('ENVIRONMENT'); },
    get CF_API_TOKEN() { return unusedEnv('CF_API_TOKEN'); },
    get CF_ACCOUNT_ID() { return unusedEnv('CF_ACCOUNT_ID'); },
    ...overrides,
  };
}

// The Gemini test fixtures reviewers reach for (`gemma-4-31b-it`, `gemma-4-26b-a4b-it`) are NOT real
// catalog entries, so migrations/ensureModelCatalog never seed them -- only Cloudflare models are
// seeded. Tests must therefore create these Google model_configs themselves; relying on them being
// left over in a dev DB makes the suite pass locally but fail on a fresh CI database ("Model ... is
// not configured"). Seeding them alongside enabling the Google provider keeps the setup in one place.
// gemini-3.1-flash-lite is here so a test can assert fall-through to a model that actually ANSWERS,
// not just that the metered models were skipped -- an unresolvable fallback ends the chain and looks
// identical to every model failing.
const GOOGLE_TEST_MODEL_IDS = ['gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'gemini-3.1-flash-lite'];

export async function saveTestProviderApiKey(env: AppBindings, providerName = 'Google', apiKey = 'test-key') {
  const encrypted = await encryptLlmApiKey(env, apiKey);
  await queryRows(
    env,
    `
    UPDATE llm_providers
    SET encrypted_api_key = $1, enabled = TRUE, updated_at = now()
    WHERE name = $2
    `,
    [encrypted, providerName],
  );

  if (providerName === 'Google') {
    for (const modelId of GOOGLE_TEST_MODEL_IDS) {
      await queryRows(
        env,
        `
        INSERT INTO model_configs (model_id, provider, provider_id, model_name, updated_at)
        SELECT $1, 'gemini', p.id, $1, now()
        FROM llm_providers p
        WHERE p.name = 'Google'
        ON CONFLICT (model_id) DO UPDATE SET
          provider = EXCLUDED.provider,
          provider_id = EXCLUDED.provider_id,
          model_name = EXCLUDED.model_name,
          updated_at = now()
        `,
        [modelId],
      );
    }
  }
}

/**
 * Generates a mock Unified Diff string for testing.
 */
export function generateMockDiff(files: { path: string; content: string }[]): string {
  return files
    .map((f) => {
      const lines = f.content.split('\n');
      return `diff --git a/${f.path} b/${f.path}
index 1234567..890abcd 100644
--- a/${f.path}
+++ b/${f.path}
@@ -1,${lines.length} +1,${lines.length} @@
${lines.map((l) => `+${l}`).join('\n')}`;
    })
    .join('\n');
}

/**
 * Creates a mock GitHub Webhook payload for a PR opened event.
 */
export function createMockPRWebhook(overrides: any = {}) {
  return {
    action: 'opened',
    installation: { id: 12345 },
    repository: {
      name: 'test-repo',
      owner: { login: 'test-owner' },
    },
    pull_request: {
      number: 1,
      title: 'Initial PR',
      body: 'Testing PR body',
      user: { login: 'dev-author' },
      head: { sha: 'headsha', ref: 'feature' },
      base: { sha: 'basesha', ref: 'main' },
      draft: false,
    },
    ...overrides,
  };
}

/**
 * A deterministic 40-hex-character commit sha from a short seed.
 *
 * The `.slice(0, 40)` is load-bearing: four specs carried `seed.repeat(40)` instead, which produces
 * an EIGHTY-character string for any two-character seed (`sha('a1')`). Nothing validates the length,
 * so those rows stored a 40-byte value in a column meant to hold 20 and no test ever failed.
 */
export const sha = (seed: string) => seed.repeat(40).slice(0, 40);

/**
 * `describe` that skips when TEST_DATABASE_URL is unset, so the suite still runs without Postgres.
 * Was defined identically in five spec files.
 */
export const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;
