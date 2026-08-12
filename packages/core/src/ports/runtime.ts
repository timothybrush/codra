import type { TokenTracker } from '../token-tracker';
import type { Clock, IdGenerator, KvStore } from './platform';
import type { FileReviewStore } from './file-reviews';
import type { GitHubClientFactory, ReviewGitHub } from './github';
import type { JobStore } from './jobs';
import type { ModelErrorClassifier, ReviewModel } from './model';
import type { ReviewFormatter } from './formatter';
import type { LearningStore, ModelConfigReader, RepoConfigLoader, ReviewSettingsReader, WebhookDeliveryReader } from './settings';
import type { TelemetrySink } from './telemetry';

/**
 * Everything the review engine needs from the outside world. This single object is what replaced
 * `env: AppBindings`, and assembling one is the whole job of a host: see
 * src/server/adapters/index.ts for the Cloudflare/Postgres/GitHub implementation, and
 * packages/core/test/in-memory.ts for a complete in-memory one.
 *
 * A correct runtime must be CHEAP TO CONSTRUCT and hold no per-job state: one is built per Worker
 * invocation, before the job is known, and a phase that dies is re-run against a fresh one.
 * Everything job-scoped is created through the factories below, after the lease is claimed.
 */
export interface ReviewRuntime {
  kv: KvStore;
  clock: Clock;
  ids: IdGenerator;

  /**
   * The bot's own login, used to find its previous review on a retried finalize and to attribute the
   * review overview. Must match the account the `github` port posts as, or finalize will fail to
   * recognise its own earlier comment and post a duplicate.
   */
  botUsername: string;

  jobs: JobStore;
  fileReviews: FileReviewStore;
  settings: ReviewSettingsReader;
  webhooks: WebhookDeliveryReader;
  learning: LearningStore;
  modelConfigs: ModelConfigReader;
  repoConfig: RepoConfigLoader;
  telemetry: TelemetrySink;

  /**
   * Job-scoped collaborators. Factories rather than instances because all four are built per phase,
   * after the job row is claimed, and because the github and model ports must share ONE
   * TokenTracker -- the subrequest budget that decides how many files a phase attempts counts both
   * provider calls and model calls, so two trackers would let a phase overrun its invocation limit.
   */
  createTokenTracker(): TokenTracker;
  createGitHub(installationId: string, tracker: TokenTracker): ReviewGitHub;
  createModel(jobId: string, tracker: TokenTracker): ReviewModel;
  createFormatter(): ReviewFormatter;

  /** For webhook resolution, which runs before any job row exists. */
  githubClients: GitHubClientFactory;
  modelErrors: ModelErrorClassifier;
}
