import { logger } from '@codra/core/logger';
import { withTimeout } from '@codra/core/timeout';
import { ProviderRequestError, UnparseableModelResponseError, providerErrorMessage, jsonOnlyPrompts, type ModelInput, type ModelResponse } from '../types';
import { toGeminiResponseJsonSchema } from '../gemini-schema';
import { assertPublicBaseUrl } from '../url-guard';
import {
  MODEL_TIMEOUT_MAX_MS,
  OUTPUT_TOKENS_FLOOR,
  geminiThinkingBudgetTokens,
  resolveOutputTokenCeiling,
} from '../limits';

/** Fallback timeout if caller omits budget. */
const GEMINI_TIMEOUT_MS = MODEL_TIMEOUT_MAX_MS;
const GEMINI_MAX_RETRIES = 2;
// Output floor for low-budget tasks (verify, summary).
const GEMINI_DEFAULT_OUTPUT_TOKENS = OUTPUT_TOKENS_FLOOR;
// Max output claims. 65k allows room for thinking tokens and dense multi-file bins.
const GEMINI_MAX_OUTPUT_TOKENS = 65_536;
// Cap on retry sleeps; longer cool-offs defer files to free up gates.
const GEMINI_MAX_RETRY_DELAY_MS = 5_000;
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// 429 handled separately (only retryable if cool-off is stated).
function isRetryableGeminiStatus(status: number) {
  return status === 408 || status === 500 || status === 502 || status === 503 || status === 504 || status === 524;
}

function defaultRetryDelayMs(attempt: number) {
  // Exponential backoff for transient 5xx errors (clears quickly).
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

// Extract body cool-off ("Please retry in Xs.") to avoid indefinite 429 retries.
function requestedRetryDelayFromBody(message: string): number | null {
  const match = /retry in ([\d.]+)s/i.exec(message);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

// Broad matcher (false positives cost 1 subrequest; false negatives break chains).
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
    lower.includes('schema') ||
    // Bare 400 catch-all to prevent permanent schema failures. Worst case: one extra failed schema-less attempt.
    lower.includes('invalid argument')
  );
}

// Narrow matcher probed BEFORE isSchemaRejection to prevent misidentifying thinking-config refusals as schema drops.
function isThinkingRejection(status: number, message: string) {
  if (status !== 400) return false;
  const lower = message.toLowerCase();
  return lower.includes('thinking') || lower.includes('thought');
}

function isRetryableTransportError(error: unknown) {
  if (!(error instanceof Error)) return false;
  // Don't retry timeouts (caller grants up to 2m); defer to fallback chains.
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
  // Latches to disable features on subsequent attempts if rejected.
  let schemaRejected = false;
  let thinkingRejected = false;

  // Summing JSON and thinking token budgets prevents truncated prefixes.
  const answerBudget = resolveOutputTokenCeiling(
    input.outputBudgetTokens,
    GEMINI_MAX_OUTPUT_TOKENS,
    GEMINI_DEFAULT_OUTPUT_TOKENS,
  );
  const thinkingBudget = geminiThinkingBudgetTokens(answerBudget);
  const outputCeiling = Math.min(GEMINI_MAX_OUTPUT_TOKENS, answerBudget + thinkingBudget);
  // Mark error so caller latches schema-dropped state even on subsequent failure.
  const fail = (error: unknown): never => {
    if (schemaRejected && typeof error === 'object' && error !== null) {
      Object.defineProperty(error, 'schemaDropped', { value: true, configurable: true });
    }
    throw error;
  };

  const startTime = Date.now();
  let baseUrl = config.baseUrl || DEFAULT_GEMINI_BASE_URL;
  while (baseUrl.endsWith('/')) {
    baseUrl = baseUrl.slice(0, -1);
  }
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
              // Required for schemas and summary path.
              responseMimeType: 'application/json',
              // See gemini-schema.ts.
              ...(responseJsonSchema && !schemaRejected ? { responseJsonSchema } : {}),
              maxOutputTokens: outputCeiling,
              // Bounded thinking budget so it doesn't consume the output ceiling.
              ...(thinkingRejected ? {} : { thinkingConfig: { thinkingBudget } }),
              // 0.9 on Gemini's 0-2 scale.
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
      return fail(error);
    }

    if (!response.ok) {
      const errorText = await response.text();
      const message = providerErrorMessage(errorText);

      // Check thinking first; isSchemaRejection is broad.
      if (!thinkingRejected && isThinkingRejection(response.status, message)) {
        thinkingRejected = true;
        logger.warn('Gemini rejected thinkingConfig; retrying without an explicit thinking budget', {
          model,
          error: message,
        });
        lastError = new ProviderRequestError(config.providerName ?? 'Google', response.status, message);
        // Refund attempt (no sleep); latched.
        attempt--;
        continue;
      }

      if (responseJsonSchema && !schemaRejected && isSchemaRejection(response.status, message)) {
        schemaRejected = true;
        // Inferred schema rejection; real cause thrown below if 400 recurs.
        logger.warn('Gemini returned a 400 that looks like a response-grammar rejection; retrying without constrained decoding', {
          model,
          error: message,
        });
        lastError = new ProviderRequestError(config.providerName ?? 'Google', response.status, message);
        // Refund attempt (no sleep); latched.
        attempt--;
        continue;
      }

      const requestedDelayMs = response.status === 429
        ? retryAfterDelayMs(response.headers.get('retry-after')) ?? requestedRetryDelayFromBody(message)
        : null;
      // Unstated 429s back-off for ~60s, making them unretryable here. Retry only on short, stated cool-offs.
      const isRetryable = response.status === 429
        ? requestedDelayMs !== null && requestedDelayMs <= GEMINI_MAX_RETRY_DELAY_MS
        : isRetryableGeminiStatus(response.status);
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
        // Log bounded raw body for terminal 4xx to debug unactionable "invalid argument" errors.
        rawBody: response.status >= 400 && response.status < 500 && !(isRetryable && attempt < maxRetries)
          ? errorText.slice(0, 2_000)
          : undefined,
      };
      if (isRetryable && attempt < maxRetries) {
        logger.warn(`Gemini request failed with ${response.status}; retrying`, logData);
        lastError = new ProviderRequestError(config.providerName ?? 'Google', response.status, message);
        delayBeforeAttemptMs = retryDelayMs;
        continue;
      }

      logger.error(`Gemini request failed with ${response.status}`, logData);
      return fail(new ProviderRequestError(config.providerName ?? 'Google', response.status, message));
    }

    const durationMs = Date.now() - startTime;
    logger.info(`AI model ${model} responded in ${durationMs}ms`);

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        // Billed against `maxOutputTokens`.
        thoughtsTokenCount?: number;
      };
    };

    const candidate = data.candidates?.[0];
    const rawText = candidate?.content?.parts?.map((part) => part.text ?? '').join('')?.trim();
    if (!rawText) {
      const finishReason = candidate?.finishReason;
      // Deterministic non-STOP (budget burn, safety) fails permanently; empty STOP is transient.
      if (finishReason && finishReason !== 'STOP') {
        return fail(new UnparseableModelResponseError(model, `finishReason=${finishReason}`));
      }
      return fail(new Error('Gemini returned an empty response.'));
    }

    // Log non-STOP prefix truncations.
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
      logger.warn(`Gemini response for ${model} ended with finishReason=${candidate.finishReason}; output is likely incomplete`, {
        // Avoid `Tokens` key name to bypass logger redaction. Sum thinking + output spend.
        outputSpend: (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0),
        thoughtSpend: data.usageMetadata?.thoughtsTokenCount ?? 0,
        outputCeiling,
        thinkingBudget: thinkingRejected ? undefined : thinkingBudget,
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

  return fail(lastError);
}
