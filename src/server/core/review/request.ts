import type {
  GitHubWebhookEventName,
  GitHubWebhookPayload,
  IssueCommentWebhookPayload,
  PullRequestWebhookPayload,
} from '@shared/github';
import type { RepoConfig } from '@shared/schema';

// Turns a GitHub webhook into a normalized review request, or null when the event should not start
// a review. Pure: no env, no I/O, so it is the one part of the review pipeline testable in isolation.
function shouldTriggerFromPullRequest(action: PullRequestWebhookPayload['action'], config: RepoConfig['review']) {
  return (config.on as string[]).includes(action);
}

export type ReviewRequest = {
  installationId: string;
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string | null;
  prAuthor: string | null;
  commitSha: string;
  baseSha: string;
  headRef: string | null;
  baseRef: string | null;
  trigger: 'auto' | 'mention';
};

export function extractReviewRequest(input: {
  eventName: GitHubWebhookEventName;
  payload: GitHubWebhookPayload;
  botUsername: string;
  config: RepoConfig;
}): ReviewRequest | null {
  if (input.eventName === 'pull_request') {
    const payload = input.payload as PullRequestWebhookPayload;
    if (input.config.review.ignore_drafts && payload.pull_request.draft) {
      return null;
    }
    if (!shouldTriggerFromPullRequest(payload.action, input.config.review)) {
      return null;
    }

    return {
      installationId: String(payload.installation?.id ?? ''),
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      prNumber: payload.pull_request.number,
      prTitle: payload.pull_request.title,
      prAuthor: payload.pull_request.user.login,
      commitSha: payload.pull_request.head.sha,
      baseSha: payload.pull_request.base.sha,
      headRef: payload.pull_request.head.ref,
      baseRef: payload.pull_request.base.ref,
      trigger: 'auto' as const,
    };
  }

  if (input.eventName === 'issue_comment') {
    const payload = input.payload as IssueCommentWebhookPayload;
    const mentionTrigger = input.config.review.mention_trigger;

    if (!payload.issue?.pull_request || payload.action !== 'created' || !mentionTrigger) {
      return null;
    }

    if (!payload.comment?.body?.includes(mentionTrigger)) {
      return null;
    }

    return {
      installationId: String(payload.installation?.id ?? ''),
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      prNumber: payload.issue.number,
      prTitle: null,
      prAuthor: null,
      commitSha: '',
      baseSha: '',
      headRef: null,
      baseRef: null,
      trigger: 'mention' as const,
    };
  }

  return null;
}
