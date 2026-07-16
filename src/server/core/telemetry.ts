import type { AppBindings } from '@server/env';
import { logger } from './logger';

const TELEMETRY_SECRET = 'codra-telemetry-v1-secret-8f9a2b5c';
const INSTANCE_ID_KEY = 'codra:instance_id';

/**
 * Returns a stable, anonymous instance ID.
 * Generates and stores one in KV if it doesn't exist yet.
 */
import { queryRows } from '@server/db/client';
// Static import: version string is inlined at build time by Vite — no runtime cost.
import pkg from '../../../package.json';

const CODRA_VERSION: string = pkg.version;

export async function getInstanceId(env: AppBindings): Promise<string> {
  try {
    const rows = await queryRows<{ value: string }>(env, 'SELECT value FROM global_settings WHERE key = $1', [INSTANCE_ID_KEY]);
    let instanceId = rows[0]?.value;

    if (!instanceId) {
      instanceId = crypto.randomUUID();
      await queryRows(
        env, 
        'INSERT INTO global_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', 
        [INSTANCE_ID_KEY, instanceId]
      );
      // Fetch again in case another instance inserted it concurrently
      const rowsAfter = await queryRows<{ value: string }>(env, 'SELECT value FROM global_settings WHERE key = $1', [INSTANCE_ID_KEY]);
      instanceId = rowsAfter[0]?.value ?? instanceId;
    }
    return instanceId;
  } catch (error) {
    logger.warn('Failed to retrieve or generate instance ID for telemetry', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Fallback to a random UUID so telemetry can still send, though it will
    // count as a new "install" if the DB is failing.
    return crypto.randomUUID();
  }
}

/**
 * Sends an anonymous telemetry event to Codra Core backend.
 * Swallows all errors so the caller is never interrupted.
 */
export async function sendTelemetryEvent(
  env: AppBindings,
  data: { 
    linesReviewed: number; 
    findingsReported: number; 
    inputTokens: number; 
    outputTokens: number;
    modelsUsed: string[];
    fileExtensions: string[];
    triggerType: string;
    reviewDurationMs: number;
    filesReviewed: number;
    verdict?: string;
    severityDistribution: Record<string, number>;
    concurrencyLevel: string;
    prTotalLinesChanged: number;
    retryCount: number;
  },
): Promise<void> {
  try {
    // Opt-out for self-hosters/forks: set TELEMETRY_DISABLED=true (or 1) to send nothing.
    const disabled = String((env as any).TELEMETRY_DISABLED ?? '').toLowerCase();
    if (disabled === 'true' || disabled === '1') {
      return;
    }

    // Suppress telemetry from test environments or stub model runs. Test runs use a mock AI
    // binding that produces a "test-model" model name with hardcoded stub token counts; sending
    // those to production would pollute the analytics DB with meaningless rows.
    const environment = String((env as any).ENVIRONMENT ?? '').toLowerCase();
    if (environment === 'test' || environment === 'local') {
      logger.debug('Skipping telemetry in non-production environment', { environment });
      return;
    }

    // Secondary guard: if every model used is a stub/test model, skip. This catches cases where
    // ENVIRONMENT is unset but the worker is still running under the vitest mock AI binding.
    const hasOnlyStubModels =
      data.modelsUsed.length > 0 &&
      data.modelsUsed.every((m) => m.toLowerCase().includes('test'));
    if (hasOnlyStubModels) {
      logger.debug('Skipping telemetry: only stub/test models detected', {
        modelsUsed: data.modelsUsed,
      });
      return;
    }

    const instanceId = await getInstanceId(env);
    // Use an environment variable if available, otherwise default to the hosted backend
    const telemetryUrl = (env as any).TELEMETRY_API_URL ?? 'https://codra.run/api/telemetry';
    // Allow the ingestion secret to be overridden via env so it isn't pinned to the value committed
    // in this (public) source tree.
    const telemetrySecret = (env as any).TELEMETRY_SECRET ?? TELEMETRY_SECRET;

    // Fire and forget using standard fetch with a timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    await fetch(telemetryUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${telemetrySecret}`,
      },
      body: JSON.stringify({
        instanceId,
        prsReviewed: 1,
        linesReviewed: data.linesReviewed,
        findingsReported: data.findingsReported,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        modelsUsed: data.modelsUsed,
        fileExtensions: data.fileExtensions,
        triggerType: data.triggerType,
        reviewDurationMs: data.reviewDurationMs,
        filesReviewed: data.filesReviewed,
        verdict: data.verdict,
        severityDistribution: data.severityDistribution,
        codraVersion: CODRA_VERSION,
        concurrencyLevel: data.concurrencyLevel,
        prTotalLinesChanged: data.prTotalLinesChanged,
        retryCount: data.retryCount,
      }),
      signal: controller.signal,
    }).catch((error) => {
      // Intentionally swallowed: Network errors are expected occasionally
      logger.debug('Failed to send anonymous telemetry event (network)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      clearTimeout(timeoutId);
    });
  } catch (error) {
    // Intentionally swallowed: We never want telemetry to fail a PR review
    logger.debug('Failed to send anonymous telemetry event (setup)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
