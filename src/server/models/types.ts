// Both live in @codra/core/ports now: prompts/file-review.ts builds a ModelResponseSchema, and it is
// the only reason a pure prompt module ever imported from models/. Re-exported here so the ~20
// existing `@server/models/types` importers are unaffected, and so there is exactly one definition.
import type { ModelResponseSchema } from '@codra/core/ports';
export type { ModelResponse, ModelResponseSchema } from '@codra/core/ports';

// `responseSchema` is per-call on purpose: file review, verification, and summary each need a different output shape.
export type ModelInput = {
  systemPrompt: string;
  userPrompt: string;
  responseSchema?: ModelResponseSchema;
  // Output tokens this call needs to answer in full, from `reviewOutputBudgetTokens`. Advisory: each
  // adapter clamps it to its own provider maximum and never goes BELOW its own default, so a caller
  // that omits it is unaffected. Omitting it on a large batched review is what truncates the response.
  outputBudgetTokens?: number;
};

export class ProviderRequestError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    message: string,
  ) {
    super(`${provider} request failed with ${status}: ${message}`);
    this.name = 'ProviderRequestError';
  }
}

// Thrown instead of synthesizing a fake "inconclusive" pass, so the fallback chain tries the next model. Treated as PERMANENT (not transient): the outcome is deterministic, so retrying just burns quota.
export class UnparseableModelResponseError extends Error {
  constructor(public readonly model: string, public readonly reason: string) {
    super(`Model ${model} produced no reviewable output (${reason}); the file review failed.`);
    this.name = 'UnparseableModelResponseError';
  }
}

// `details[].description` and `details[].fieldViolations[].description`, flattened and deduped.
function errorDetailText(error: unknown): string {
  const details = (error as Record<string, unknown> | null)?.details;
  if (!Array.isArray(details)) return '';

  const parts = new Set<string>();
  for (const entry of details) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    for (const candidate of [e, ...(Array.isArray(e.fieldViolations) ? e.fieldViolations : [])]) {
      const description = (candidate as Record<string, unknown> | null)?.description;
      if (typeof description === 'string' && description.trim()) parts.add(description.trim());
    }
  }
  return [...parts].join(' ');
}

export function providerErrorMessage(errorText: string) {
  try {
    const parsed = JSON.parse(errorText) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      let message: unknown;

      if (typeof obj.error === 'object' && obj.error !== null) {
        message = (obj.error as Record<string, unknown>).message ?? obj.error;
      } else {
        message = obj.message ?? obj.error;
      }

      if (typeof message === 'string' && message.trim()) {
        // Gemini puts the actionable reason in `error.details`, leaving `message` as the useless
        // "Request contains an invalid argument." -- which made isSchemaRejection miss a grammar
        // rejection and lose the whole model instead of retrying without the schema.
        const detail = errorDetailText(obj.error);
        return detail ? `${message.trim()} ${detail}` : message.trim();
      }
    }
  } catch {
  // Fall back to the provider body below.
  }

  return errorText.trim() || 'The provider returned an error.';
}

// Temperature deliberately not zero: a little randomness reviews better than greedy decoding. Each adapter sits at the same relative point on its own scale (Google/Vertex/OpenAI 0-2 at 0.9; Anthropic 0-1 and Cloudflare 0-5 at 0.6); watch `droppedByVerdict` if these move.
export function jsonOnlyPrompts(input: ModelInput) {
  return {
    system: `${input.systemPrompt}\n\nReturn only the JSON object. Do not include chain-of-thought, analysis, markdown, code fences, or explanatory prose.`,
    user: `${input.userPrompt}\n\nRespond with the required JSON object only.`,
  };
}
