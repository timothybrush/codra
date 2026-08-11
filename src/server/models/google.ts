import { logger } from '@server/core/logger';
import { withTimeout } from '@server/core/timeout';
import { ProviderRequestError, UnparseableModelResponseError, providerErrorMessage, jsonOnlyPrompts, type ModelInput, type ModelResponse } from './types';
import { toGeminiResponseJsonSchema } from './gemini-schema';
import { assertPublicBaseUrl } from './url-guard';
import {
  MODEL_TIMEOUT_MAX_MS,
  OUTPUT_TOKENS_FLOOR,
  geminiThinkingBudgetTokens,
  resolveOutputTokenCeiling,
} from './limits';

/** Fallback when the caller supplies no diff-size-aware budget. */
const GEMINI_TIMEOUT_MS = MODEL_TIMEOUT_MAX_MS;
const GEMINI_MAX_RETRIES = 2;
// Floor, used when the caller states no budget (verify and summary, which answer in well under this).
const GEMINI_DEFAULT_OUTPUT_TOKENS = OUTPUT_TOKENS_FLOOR;
// What a review call may claim when it asks for room. The old single 8192 for every call was the
// binding constraint on findings: thinking tokens bill against it, so a six-file bin asked for ~120
// findings inside a window that held ~35 and answered with near-empty arrays.
const GEMINI_MAX_OUTPUT_TOKENS = 65_536;
// Cap on any in-call retry sleep; a longer cool-off is better served by deferring the file than by pinning a gate slot here.
const GEMINI_MAX_RETRY_DELAY_MS = 5_000;
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// 429 is handled separately: it is retryable only when the provider names a cool-off we can wait out.
function isRetryableGeminiStatus(status: number) {
  return status === 408 || status === 500 || status === 502 || status === 503 || status === 504 || status === 524;
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
    lower.includes('schema') ||
    // The bare, detail-less 400. Google sometimes rejects a request with nothing but "Request
    // contains an invalid argument." and no `error.details`, so none of the specific markers above
    // can fire and the file used to fail permanently on its FIRST 400 -- no schema probe, no
    // fallback, because a 400 is not transient. Only consulted when a grammar was actually sent, so
    // the worst case is one extra schema-less attempt that 400s again and rethrows the real message.
    lower.includes('invalid argument')
  );
}

// Narrow, and probed BEFORE isSchemaRejection: that one matches "unknown name" and "invalid argument",
// so an endpoint or model that does not know `thinkingConfig` would otherwise be read as a grammar
// rejection, dropping the schema while still sending the field that was actually refused.
function isThinkingRejection(status: number, message: string) {
  if (status !== 400) return false;
  const lower = message.toLowerCase();
  return lower.includes('thinking') || lower.includes('thought');
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
  // Same latch for `thinkingConfig`: the 2.0-era models and some proxies do not accept the field.
  let thinkingRejected = false;

  // Room for the JSON alone, then thinking ON TOP of it. Summing rather than sharing is the fix: with
  // one flat ceiling for both, a thinking model spent it deliberating and returned a truncated prefix.
  const answerBudget = resolveOutputTokenCeiling(
    input.outputBudgetTokens,
    GEMINI_MAX_OUTPUT_TOKENS,
    GEMINI_DEFAULT_OUTPUT_TOKENS,
  );
  const thinkingBudget = geminiThinkingBudgetTokens(answerBudget);
  const outputCeiling = Math.min(GEMINI_MAX_OUTPUT_TOKENS, answerBudget + thinkingBudget);
  // The caller latches per (provider, model, grammar) off this flag. Marking the error too means a
  // schema-dropped attempt that then fails still teaches the caller, instead of re-probing next call.
  const fail = (error: unknown): never => {
    if (schemaRejected && typeof error === 'object' && error !== null) {
      Object.defineProperty(error, 'schemaDropped', { value: true, configurable: true });
    }
    throw error;
  };

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
              maxOutputTokens: outputCeiling,
              // Bounded on purpose: thinking bills against maxOutputTokens, so leaving it dynamic lets
              // it eat the ceiling and return a prefix of the JSON.
              ...(thinkingRejected ? {} : { thinkingConfig: { thinkingBudget } }),
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
      return fail(error);
    }

    if (!response.ok) {
      const errorText = await response.text();
      const message = providerErrorMessage(errorText);

      // Before the schema probe: isSchemaRejection is deliberately broad and would swallow this.
      if (!thinkingRejected && isThinkingRejection(response.status, message)) {
        thinkingRejected = true;
        logger.warn('Gemini rejected thinkingConfig; retrying without an explicit thinking budget', {
          model,
          error: message,
        });
        lastError = new ProviderRequestError(config.providerName ?? 'Google', response.status, message);
        // Attempt refunded, no sleep: the latch bounds this to one extra probe, as with the grammar.
        attempt--;
        continue;
      }

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
      // An unstated 429 cool-off is ~60s by construction on a per-minute bucket, so backing off ~1s
      // buys a second 429 and a second full prompt re-send. Only a stated, short cool-off is retryable.
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
        // A bare "Request contains an invalid argument." with no `error.details` is unactionable, and
        // without the body there is no way to learn what Google objected to. Bounded, and only on a
        // 4xx we are about to give up on -- one body per genuinely failed call, never on a retry rung.
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
        return fail(new UnparseableModelResponseError(model, `finishReason=${finishReason}`));
      }
      return fail(new Error('Gemini returned an empty response.'));
    }

    // A non-empty non-STOP response is only a prefix: json.ts repairs the braces and the tail findings vanish silently.
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
      logger.warn(`Gemini response for ${model} ended with finishReason=${candidate.finishReason}; output is likely incomplete`, {
        // NONE of these may be named `...Tokens`: logger.ts redacts any key containing "token", so the
        // previous `outputTokens`/`maxOutputTokens` pair logged as [REDACTED] and this warning could
        // never show how close to the ceiling a truncated response actually got.
        // Thinking bills against the same ceiling, so compare the sum.
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
