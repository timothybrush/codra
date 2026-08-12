import type { GitHubClientFactory, ModelErrorClassifier, ReviewFormatter, ReviewGitHub, ReviewModel } from '@codra/core/ports';
import type { TokenTracker } from '@codra/core/token-tracker';
import type { AppBindings } from '@server/env';
import { GitHubClient } from '@server/core/github';
import { GitHubService } from '@server/services/github';
import { isRetryableModelError, ModelService, nextChainIndexOf } from '@server/services/model';
import { FormatterService } from '@server/services/formatter';

// The only place the four job-scoped collaborators are constructed. Every specifier above is the
// barrel form on purpose: nine specs vi.mock '@server/services/github' and '@server/services/model',
// and reaching for a sibling here would bypass those mocks while the tests kept passing.

export function makeGitHubFactory(env: AppBindings) {
  return (installationId: string, tracker: TokenTracker): ReviewGitHub => new GitHubService(env, installationId, tracker);
}

export function makeModelFactory(env: AppBindings) {
  return (jobId: string, tracker: TokenTracker): ReviewModel => new ModelService(env, tracker, { jobId });
}

export function makeFormatterFactory(env: AppBindings) {
  return (): ReviewFormatter => new FormatterService(env.APP_URL);
}

// Webhook resolution runs before a job row exists, so it cannot go through the job-scoped factory
// above: GitHubClient is the lower-level client the engine uses for label cleanup on a closed pull
// request and for finding the pull request behind an issue comment.
export function makeGitHubClientFactory(env: AppBindings): GitHubClientFactory {
  return { forInstallation: (installationId) => new GitHubClient(env, installationId) };
}

export function makeModelErrorClassifier(): ModelErrorClassifier {
  return { isRetryableModelError, nextChainIndexOf };
}
