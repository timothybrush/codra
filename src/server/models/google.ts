import { logger } from '@server/core/logger';
import { withTimeout } from '@server/core/timeout';
import { ProviderRequestError, UnparseableModelResponseError, providerErrorMessage, jsonOnlyPrompts, type ModelInput, type ModelResponse } from './types';
import { toGeminiResponseJsonSchema } from './gemini-schema';
import { assertPublicBaseUrl } from './url-guard';

/** Fallback when the caller supplies no diff-size-aware budget. */
const GEMINI_TIMEOUT_MS = 45_000;
const GEMINI_MAX_RETRIES = 2;
// Headroom so reasoning models can think and still emit the JSON answer without truncating.
const GEMINI_MAX_OUTPUT_TOKENS = 8192;
// Cap on any in-call retry sleep; a longer cool-off is better served by deferring the file than by pinning a gate slot here.
const GEMINI_MAX_RETRY_DELAY_MS = 5_000;
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function isRetryableGeminiStatus(status: number) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 524;
}

function defaultRetryDelayMs(attempt: number) {
  // ~0.8s then ~1.6s: a transient Gemini 5xx usually clears within a second or two.
  return Math.pow(2, attempt) * 800 + Math.random() * 400;
}

function retryAfterDelayMs(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

// Google states the cool-off in the body ("Please retry in 56.158s.") too; without reading it a quota 429 looks indefinitely retryable.
function requestedRetryDelayFromBody(message: string): number | null {
  const match = /retry in ([\d.]+)s/i.exec(message);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

// Broad on purpose: a false negative is a chain-wide outage, a false positive one subrequest.
function isSchemaRejection(status: number, message: string) {
  if (status !== 400) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('responsejsonschema') ||
    lower.includes('response_json_schema') ||
    lower.includes('responseschema') ||
    lower.includes('response_schema') ||
    lower.includes('invalid json payload') ||
    lower.includes('unknown name') ||
    lower.includes('schema')
  );
}

function isRetryableTransportError(error: unknown) {
  if (!(error instanceof Error)) return false;
  // Never retry timeouts: the caller already grants up to 2 minutes, so let the fallback chain take over instead.
  if (error.name === 'TimeoutError' || error.message.toLowerCase().includes('timed out')) return false;
  if (error.message.includes('fetch failed')) return true;
  return error instanceof TypeError;
}

export async function reviewWithGoogle(
  config: { apiKey: string; baseUrl?: string | null; providerName?: string; timeoutMs?: number },
  model: string,
  input: ModelInput,
  tracker?: { incrementSubrequests(count?: number): void },
): Promise<ModelResponse> {
  const timeoutMs = config.timeoutMs ?? GEMINI_TIMEOUT_MS;
  logger.info(`Calling Google model: ${model}`);

  assertPublicBaseUrl(config.baseUrl, config.providerName ?? 'Google');
  const prompts = jsonOnlyPrompts(input);
  const responseJsonSchema = input.responseSchema
    ? toGeminiResponseJsonSchema(input.responseSchema.schema)
    : null;
  // Latched: once the endpoint rejects the grammar, every later attempt goes without it.
  let schemaRejected = false;

  const startTime = Date.now();
  const baseUrl = (config.baseUrl || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const maxRetries = GEMINI_MAX_RETRIES;
  let lastError: unknown;
  let delayBeforeAttemptMs = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (delayBeforeAttemptMs > 0) {
      logger.info(`Retrying Gemini request (attempt ${attempt}/${maxRetries}) in ${Math.round(delayBeforeAttemptMs)}ms`);
      await new Promise(resolve => setTimeout(resolve, delayBeforeAttemptMs));
      delayBeforeAttemptMs = 0;
    }

    let response: Response;
    try {
      if (tracker) tracker.incrementSubrequests(1);
      response = await withTimeout('Gemini API', timeoutMs, (signal) =>
        fetch(url, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            systemInstruction: {
              role: 'system',
              parts: [{ text: prompts.system }],
            },
            contents: [
              { role: 'user', parts: [{ text: prompts.user }] },
            ],
            generationConfig: {
              // Required alongside a grammar, and the schema-less summary path needs it too.
              responseMimeType: 'application/json',
              // See gemini-schema.ts for why not `responseSchema`.
              ...(responseJsonSchema && !schemaRejected ? { responseJsonSchema } : {}),
              maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
              // See the note in models/types.ts on sampling. 0.9 on Gemini's 0-2 scale.
              temperature: 0.9,
            },
          }),
        }),
      );
    } catch (error) {
      lastError = error;
      if (isRetryableTransportError(error) && attempt < maxRetries) {
        delayBeforeAttemptMs = defaultRetryDelayMs(attempt);
        continue;
      }
      throw error;
    }

    if (!response.ok) {
      const errorText = await response.text();
      const message = providerErrorMessage(errorText);

      if (responseJsonSchema && !schemaRejected && isSchemaRejection(response.status, message)) {
        schemaRejected = true;
        // Inferred, not established: another cause 400s again and throws the real message below.
        logger.warn('Gemini returned a 400 that looks like a response-grammar rejection; retrying without constrained decoding', {
          model,
          error: message,
        });
        lastError = new ProviderRequestError(config.providerName ?? 'Google', response.status, message);
        // Attempt refunded, no sleep: the probe isn't a transient rung and the latch bounds it to one.
        attempt--;
        continue;
      }

      const requestedDelayMs = response.status === 429
        ? retryAfterDelayMs(response.headers.get('retry-after')) ?? requestedRetryDelayFromBody(message)
        : null;
      // A cool-off longer than our cap can't be retried usefully; defer the file instead.
      const canHonorCoolOff = requestedDelayMs === null || requestedDelayMs <= GEMINI_MAX_RETRY_DELAY_MS;
      const isRetryable = isRetryableGeminiStatus(response.status) && canHonorCoolOff;
      const retryDelayMs = Math.min(
        GEMINI_MAX_RETRY_DELAY_MS,
        requestedDelayMs ?? defaultRetryDelayMs(attempt),
      );

      const logData = {
        error: message,
        attempt,
        willRetry: isRetryable && attempt < maxRetries,
        requestedDelayMs: requestedDelayMs ?? undefined,
        retryDelayMs: isRetryable && attempt < maxRetries ? retryDelayMs : undefined,
      };
      if (isRetryable && attempt < maxRetries) {
        logger.warn(`Gemini request failed with ${response.status}; retrying`, logData);
        lastError = new ProviderRequestError(config.providerName ?? 'Google', response.status, message);
        delayBeforeAttemptMs = retryDelayMs;
        continue;
      }

      logger.error(`Gemini request failed with ${response.status}`, logData);
      throw new ProviderRequestError(config.providerName ?? 'Google', response.status, message);
    }

    const durationMs = Date.now() - startTime;
    logger.info(`AI model ${model} responded in ${durationMs}ms`);

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        // Billed against `maxOutputTokens` but reported separately.
        thoughtsTokenCount?: number;
      };
    };

    const candidate = data.candidates?.[0];
    const rawText = candidate?.content?.parts?.map((part) => part.text ?? '').join('')?.trim();
    if (!rawText) {
      const finishReason = candidate?.finishReason;
      // A thinking model burning budget before emitting text, or a safety block, is deterministic and should fail permanently; an empty STOP is transient.
      if (finishReason && finishReason !== 'STOP') {
        throw new UnparseableModelResponseError(model, `finishReason=${finishReason}`);
      }
      throw new Error('Gemini returned an empty response.');
    }

    // A non-empty non-STOP response is only a prefix: json.ts repairs the braces and the tail findings vanish silently.
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
      logger.warn(`Gemini response for ${model} ended with finishReason=${candidate.finishReason}; output is likely incomplete`, {
        // Thinking tokens bill against the same ceiling, so compare the sum.
        outputTokens: (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0),
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        schemaDropped: schemaRejected,
      });
    }

    return {
      rawText,
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      modelUsed: model,
      provider: config.providerName ?? 'Google',
      ...(schemaRejected ? { degraded: 'schema-dropped' as const } : {}),
    };
  }

  throw lastError;
}
