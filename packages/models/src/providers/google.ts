import { logger } from '@codraoss/core/logger';
import { withTimeout } from '@codraoss/core/timeout';
import { ProviderRequestError, UnparseableModelResponseError, providerErrorMessage, jsonOnlyPrompts, isThinkingRejection, attachPartialResponse, type ModelInput, type ModelResponse } from '../types';
import { toGeminiResponseJsonSchema } from '../gemini-schema';
import { assertPublicBaseUrl } from '../url-guard';
import {
  MODEL_TIMEOUT_MAX_MS,
  MODEL_TIMEOUT_PER_1K_OUTPUT_MS,
  OUTPUT_TOKENS_FLOOR,
  geminiThinkingBudgetTokens,
  resolveOutputTokenCeiling,
} from '../limits';

const GEMINI_TIMEOUT_MS = MODEL_TIMEOUT_MAX_MS;
const GEMINI_MAX_RETRIES = 2;
const GEMINI_DEFAULT_OUTPUT_TOKENS = OUTPUT_TOKENS_FLOOR;
// 65k leaves room for thinking tokens plus dense multi-file output.
const GEMINI_MAX_OUTPUT_TOKENS = 65_536;
const GEMINI_MAX_RETRY_DELAY_MS = 5_000;
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// 429 handled separately; only retryable if a cool-off is stated.
function isRetryableGeminiStatus(status: number) {
  return status === 408 || status === 500 || status === 502 || status === 503 || status === 504 || status === 524;
}

function defaultRetryDelayMs(attempt: number) {
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

function requestedRetryDelayFromBody(message: string): number | null {
  const match = /retry in ([\d.]+)s/i.exec(message);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

// Broad on purpose: false positive costs 1 subrequest, false negative breaks the chain.
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
    // Bare 400 catch-all avoids permanent schema failures.
    lower.includes('invalid argument')
  );
}

function isRetryableTransportError(error: unknown) {
  if (!(error instanceof Error)) return false;
  // Skip retrying timeouts (caller already grants up to 2m); defer to fallback chain.
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
  let schemaRejected = false;
  let thinkingRejected = false;

  const answerBudget = resolveOutputTokenCeiling(
    input.outputBudgetTokens,
    GEMINI_MAX_OUTPUT_TOKENS,
    GEMINI_DEFAULT_OUTPUT_TOKENS,
  );
  const thinkingBudget = geminiThinkingBudgetTokens(answerBudget);
  let currentCeiling = Math.min(GEMINI_MAX_OUTPUT_TOKENS, answerBudget + thinkingBudget);
  let ceilingRaised = false;
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
              responseMimeType: 'application/json',
              ...(responseJsonSchema && !schemaRejected ? { responseJsonSchema } : {}),
              maxOutputTokens: currentCeiling,
              ...(thinkingRejected ? {} : { thinkingConfig: { thinkingBudget } }),
              // Gemini's temperature scale is 0-2, not 0-1.
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

      // Check thinking rejection first; isSchemaRejection below is broad.
      if (!thinkingRejected && isThinkingRejection(response.status, message)) {
        thinkingRejected = true;
        logger.warn('Gemini rejected thinkingConfig; retrying without an explicit thinking budget', {
          model,
          error: message,
        });
        lastError = new ProviderRequestError(config.providerName ?? 'Google', response.status, message);
        attempt--;
        continue;
      }

      if (responseJsonSchema && !schemaRejected && isSchemaRejection(response.status, message)) {
        schemaRejected = true;
        // Inferred from message; real cause surfaces below if 400 recurs.
        logger.warn('Gemini returned a 400 that looks like a response-grammar rejection; retrying without constrained decoding', {
          model,
          error: message,
        });
        lastError = new ProviderRequestError(config.providerName ?? 'Google', response.status, message);
        attempt--;
        continue;
      }

      const requestedDelayMs = response.status === 429
        ? retryAfterDelayMs(response.headers.get('retry-after')) ?? requestedRetryDelayFromBody(message)
        : null;
      // Unstated 429s back off ~60s, making them unretryable here; retry only short, stated cool-offs.
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
        // Billed against maxOutputTokens.
        thoughtsTokenCount?: number;
      };
    };

    const candidate = data.candidates?.[0];
    const rawText = candidate?.content?.parts?.map((part) => part.text ?? '').join('')?.trim();
    const finishReason = candidate?.finishReason;
    const truncated = finishReason === 'MAX_TOKENS';

    if (finishReason && finishReason !== 'STOP') {
      logger.warn(`Gemini response for ${model} ended with finishReason=${finishReason}; output is likely incomplete`, {
        // Avoid a `Tokens` key name; the logger redacts it.
        outputSpend: (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0),
        thoughtSpend: data.usageMetadata?.thoughtsTokenCount ?? 0,
        outputCeiling: currentCeiling,
        thinkingBudget: thinkingRejected ? undefined : thinkingBudget,
        schemaDropped: schemaRejected,
      });
    }

    if (truncated && input.truncationIntolerant && !ceilingRaised) {
      const elapsed = Date.now() - startTime;
      const raisedCeiling = Math.min(GEMINI_MAX_OUTPUT_TOKENS, 2 * answerBudget + thinkingBudget);
      const extraMs = ((raisedCeiling - currentCeiling) / 1_000) * MODEL_TIMEOUT_PER_1K_OUTPUT_MS;

      if (elapsed + extraMs < timeoutMs) {
        ceilingRaised = true;
        currentCeiling = raisedCeiling;
        logger.warn(`Gemini ran out of output room on ${model}; resending once with a larger ceiling`, {
          outputCeiling: raisedCeiling,
          thoughtSpend: data.usageMetadata?.thoughtsTokenCount ?? 0,
          hadPartialText: Boolean(rawText),
        });
        attempt--;
        continue;
      }
    }

    if (!rawText) {
      // Non-STOP finish fails permanently; empty STOP is transient.
      if (finishReason && finishReason !== 'STOP') {
        return fail(new UnparseableModelResponseError(model, `finishReason=${finishReason}`));
      }
      return fail(new Error('Gemini returned an empty response.'));
    }

    // Attach partial text so a later fallback model can salvage it.
    if (truncated && input.truncationIntolerant) {
      const error = new UnparseableModelResponseError(model, 'finishReason=MAX_TOKENS');
      attachPartialResponse(error, {
        rawText,
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        modelUsed: model,
        provider: config.providerName ?? 'Google',
      });
      return fail(error);
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
