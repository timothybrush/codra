import { logger } from '@codraoss/core/logger';
import { withTimeout } from '@codraoss/core/timeout';
import { ProviderRequestError, UnparseableModelResponseError, providerErrorMessage, jsonOnlyPrompts, type ModelResponse } from '../types';
import { assertPublicBaseUrl } from '../url-guard';
import { MODEL_TIMEOUT_MAX_MS, OUTPUT_TOKENS_FLOOR, resolveOutputTokenCeiling } from '../limits';

// Vertex's REST API rejects plain API keys and requires an OAuth2 token via RFC 7523 JWT-bearer grant, so `apiKey` here holds the full service-account JSON key, not a short API key string.
const VERTEX_TIMEOUT_MS = MODEL_TIMEOUT_MAX_MS;
const VERTEX_DEFAULT_OUTPUT_TOKENS = OUTPUT_TOKENS_FLOOR;
// Same Gemini models as the Google adapter, so the same ceiling. No `thinkingConfig` here though: this
// adapter makes ONE attempt and has no latch, so a model that refused the field would fail the file.
const VERTEX_MAX_OUTPUT_TOKENS = 65_536;
// Retries for a 429 only, and only while the caller's own timeout still has room. See the loop below
// for why resending an unchanged request is the correct response to this particular refusal.
const VERTEX_QUOTA_RETRIES = 2;
const VERTEX_QUOTA_BACKOFF_MS = 4_000;
// Room a resend needs to be worth starting at all; a Vertex 429 itself comes back in ~7s.
const VERTEX_MIN_ATTEMPT_MS = 8_000;
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const ACCESS_TOKEN_LIFETIME_S = 3600;
// Refresh before real expiry so an in-flight review never starts a call with a token that expires mid-request.
const TOKEN_REFRESH_MARGIN_MS = 60_000;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

// Per-isolate cache, not per-request: saves a token mint (and a subrequest) on every file review after the first to hit a warm isolate.
const tokenCache = new Map<string, CachedToken>();

function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Vertex AI credentials must be the full service-account JSON key (paste the downloaded .json file contents), not an API key.');
  }

  const obj = parsed as Partial<ServiceAccountKey> | null;
  if (!obj || typeof obj.client_email !== 'string' || typeof obj.private_key !== 'string') {
    throw new Error('Vertex AI service-account JSON is missing client_email or private_key.');
  }
  return { client_email: obj.client_email, private_key: obj.private_key };
}

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function importPrivateKey(pem: string) {
  const der = Buffer.from(
    pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, ''),
    'base64',
  );
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

async function mintAccessToken(serviceAccount: ServiceAccountKey): Promise<CachedToken> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const header = base64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claimSet = base64Url(encoder.encode(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: OAUTH_SCOPE,
    aud: OAUTH_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + ACCESS_TOKEN_LIFETIME_S,
  })));
  const signingInput = `${header}.${claimSet}`;

  const key = await importPrivateKey(serviceAccount.private_key);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signingInput));
  const assertion = `${signingInput}.${base64Url(new Uint8Array(signature))}`;

  const response = await withTimeout('Google OAuth token', 10_000, (signal) =>
    fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    }),
  );

  if (!response.ok) {
    const message = providerErrorMessage(await response.text());
    throw new ProviderRequestError('Google Vertex AI', response.status, `Could not mint an access token for the service account -- check that the JSON key is valid and the Vertex AI API is enabled (${message})`);
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('Google OAuth token endpoint returned no access_token.');

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? ACCESS_TOKEN_LIFETIME_S) * 1000,
  };
}

async function getAccessToken(
  serviceAccount: ServiceAccountKey,
  tracker?: { incrementSubrequests(count?: number): void },
) {
  const cached = tokenCache.get(serviceAccount.client_email);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return cached.accessToken;
  }

  if (tracker) tracker.incrementSubrequests(1);
  const token = await mintAccessToken(serviceAccount);
  tokenCache.set(serviceAccount.client_email, token);
  return token.accessToken;
}

export async function reviewWithVertex(
  config: { apiKey: string; baseUrl?: string | null; providerName?: string; timeoutMs?: number },
  model: string,
  input: { systemPrompt: string; userPrompt: string; outputBudgetTokens?: number },
  tracker?: { incrementSubrequests(count?: number): void },
): Promise<ModelResponse> {
  const providerName = config.providerName ?? 'Google Vertex AI';
  const timeoutMs = config.timeoutMs ?? VERTEX_TIMEOUT_MS;
  const outputCeiling = resolveOutputTokenCeiling(
    input.outputBudgetTokens,
    VERTEX_MAX_OUTPUT_TOKENS,
    VERTEX_DEFAULT_OUTPUT_TOKENS,
  );
  logger.info(`Calling Vertex AI model: ${model}`);

  assertPublicBaseUrl(config.baseUrl, providerName);
  if (!config.baseUrl) {
    throw new ProviderRequestError(
      providerName,
      400,
      'Vertex AI requires a base URL with your project and region, e.g. https://us-central1-aiplatform.googleapis.com/v1/projects/YOUR_PROJECT_ID/locations/us-central1',
    );
  }

  const serviceAccount = parseServiceAccountKey(config.apiKey);
  const accessToken = await getAccessToken(serviceAccount, tracker);
  const prompts = jsonOnlyPrompts(input);

  const startTime = Date.now();
  let baseUrl = config.baseUrl;
  while (baseUrl.endsWith('/')) {
    baseUrl = baseUrl.slice(0, -1);
  }
  const url = `${baseUrl}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;

  const body = JSON.stringify({
    systemInstruction: {
      role: 'system',
      parts: [{ text: prompts.system }],
    },
    contents: [
      { role: 'user', parts: [{ text: prompts.user }] },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      // No `responseJsonSchema`: this adapter cannot drop a schema mid-flight, so a rejection would fail the file outright.
      maxOutputTokens: outputCeiling,
      // Same models as the Google adapter, so the same value keeps the two paths comparable.
      temperature: 0.9,
    },
  });

  const attempt = () =>
    withTimeout('Vertex AI', timeoutMs, (signal) =>
      fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body,
      }),
    );

  if (tracker) tracker.incrementSubrequests(1);
  let response = await attempt();

  // A Vertex 429 here is queueing, not a bucket the caller can pace around. Measured over ~900 calls on
  // one project: roughly three in four refused, and the refusal was uncorrelated with the requested
  // output ceiling, with the endpoint, and with whether the previous call succeeded -- resending the
  // IDENTICAL request works. The adapter used to make one attempt and turn every one of those into a
  // failed file, which is the one case where the single-attempt rule above does not apply: there is no
  // schema to re-probe and nothing about the request to change.
  //
  // Bounded by the caller's own timeout, not by a retry count alone: `timeoutMs` is already clamped to
  // the fallback-chain budget, so a slow rung must not spend the whole invocation sitting in backoff.
  for (let retry = 0; retry < VERTEX_QUOTA_RETRIES && response.status === 429; retry++) {
    const waitMs = VERTEX_QUOTA_BACKOFF_MS * (retry + 1);
    if (Date.now() - startTime + waitMs + VERTEX_MIN_ATTEMPT_MS > timeoutMs) break;

    logger.warn(`Vertex AI refused with 429; resending unchanged in ${waitMs}ms`, { model, retry: retry + 1 });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (tracker) tracker.incrementSubrequests(1);
    response = await attempt();
  }

  if (!response.ok) {
    const message = providerErrorMessage(await response.text());
    throw new ProviderRequestError(providerName, response.status, message);
  }

  const durationMs = Date.now() - startTime;
  logger.info(`AI model ${model} responded in ${durationMs}ms`);

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    };
  };

  const candidate = data.candidates?.[0];
  const rawText = candidate?.content?.parts?.map((part) => part.text ?? '').join('')?.trim();
  if (!rawText) {
    const finishReason = candidate?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      throw new UnparseableModelResponseError(model, `finishReason=${finishReason}`);
    }
    throw new Error('Vertex AI returned an empty response.');
  }

  return {
    rawText,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    modelUsed: model,
    provider: providerName,
  };
}
