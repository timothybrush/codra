// The engine's ports: interfaces and data contracts only, never implementations. Every port carries a
// doc comment stating what a correct implementation must guarantee -- idempotency, ordering,
// retry-safety -- because those are the properties the engine relies on and cannot check.
//
// The dependency rule is one-way: this package may import @codra/schema and nothing else. Ports are
// implemented by hosts (src/server/adapters today, packages/{db,models,provider-github} later).

export type { Clock, IdGenerator, KvStore, Logger } from './platform';
export type { JobLeaseClaim, JobRow, JobStore, PersistedReviewJob } from './jobs';
export type { BulkFileReviewInput, FileReviewRow, FileReviewStore, SuppressedFinding } from './file-reviews';
export type { LearningStore, ModelConfigReader, RepoConfigLoader, ReviewSettingsReader, WebhookDeliveryReader } from './settings';
export type { GitHubClientFactory, GitHubReviewComment, PullRequestRecord, ReviewGitHub } from './github';
export type { FileReviewOutcome, ModelErrorClassifier, ModelResponse, ModelResponseSchema, ReviewModel } from './model';
export type { ReviewFormatter } from './formatter';
export type { ReviewTelemetryEvent, TelemetrySink } from './telemetry';
export type { ReviewRuntime } from './runtime';
