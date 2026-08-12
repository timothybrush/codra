import type { ClaimType, RepoConfig, ReviewSettings } from '@codra/schema';

/**
 * Instance-wide review settings (concurrency level, file caps).
 *
 * A correct implementation must always return a complete, valid `ReviewSettings` -- defaults when
 * nothing is stored, never a partial object and never a throw. The engine reads this on the admission
 * path, so a failure here rejects a job that should have run. It MAY cache: callers already assume
 * one lookup serves a whole phase, and a setting changed mid-review taking effect on the next phase
 * is the intended behaviour.
 */
export interface ReviewSettingsReader {
  getReviewSettings(): Promise<ReviewSettings>;
}

/**
 * Per-repository configuration (the committed `.codra.json`, merged over defaults).
 *
 * A correct implementation must guarantee:
 *  - the return is always a fully-populated `RepoConfig`, defaults included. Callers index into
 *    `parsedJson.review` without checking, and a partial config silently disables gates.
 *  - `enabled: false` means "this repo has opted out"; absence of any record means enabled.
 *  - it is safe to call repeatedly for the same repo within a phase. Caching is expected; the cache
 *    need not be invalidated mid-review.
 */
export interface RepoConfigLoader {
  loadRepoConfig(input: { installationId: string; owner: string; repo: string }): Promise<{ parsedJson: RepoConfig; enabled: boolean }>;
}

/**
 * The model catalogue, narrowed to the one field the engine needs.
 *
 * Deliberately NOT the full `ResolvedModelConfig`: that carries `encryptedApiKey`, and a credential
 * has no business crossing into the engine. The real implementation is still structurally assignable,
 * so this is a narrowing rather than an API change.
 *
 * A correct implementation returns null for an unknown or disabled model id rather than throwing --
 * the sole caller is labelling a failure for telemetry and must not fail because of it.
 */
export interface ModelConfigReader {
  getResolvedModelConfig(modelId: string): Promise<{ providerName: string } | null>;
}

/**
 * Webhook deliveries, replayed to recover a job whose queue message arrived without one.
 *
 * `payload` stays `unknown` on purpose: the caller narrows it to a `GitHubWebhookPayload` itself, and
 * a port that pre-narrowed it would be asserting a git-provider shape the engine is meant not to
 * assume. A correct implementation must return the payload already decoded from whatever column
 * encoding it uses -- never a JSON string -- and null for an unknown delivery id.
 */
export interface WebhookDeliveryReader {
  getWebhookDelivery(deliveryId: string): Promise<{ delivery_id: string; event_name: string; payload: unknown } | null>;
}

/**
 * Findings a human previously rejected, injected as negative few-shot exemplars.
 *
 * A correct implementation must guarantee:
 *  - results are drawn only from findings a human actually labelled. Absence of a label is not a
 *    rejection, and treating it as one would teach the model from silence.
 *  - `limit` is an upper bound and may be clamped down; returning fewer (including none) is always
 *    legal. Every caller treats exemplars as optional enrichment and must still work with zero.
 *  - it never throws for a repository with no history -- a new repo returns an empty array.
 *  - the field names stay snake_case: they are read straight through into the prompt builder.
 */
export interface LearningStore {
  getRepositoryIdForJob(jobId: string): Promise<number | null>;
  getRejectedExemplars(input: { repositoryId: number; claimTypes?: readonly ClaimType[]; limit?: number }): Promise<
    Array<{ title: string; body: string; claim_type: ClaimType | null; context_snippet: string | null; path: string }>
  >;
}
