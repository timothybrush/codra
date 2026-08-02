export const supportedGitHubWebhookEvents = ['pull_request', 'issue_comment'] as const;

export type GitHubWebhookEventName = typeof supportedGitHubWebhookEvents[number];

export function isSupportedGitHubWebhookEvent(eventName: string): eventName is GitHubWebhookEventName {
  return (supportedGitHubWebhookEvents as readonly string[]).includes(eventName);
}

/**
 * Events that carry human feedback on findings we already posted.
 *
 * Deliberately a SEPARATE list from `supportedGitHubWebhookEvents`, which means "this event can
 * produce a review job" and is also consumed by the queue consumer. These are handled inline in the
 * webhook handler and never enqueue anything.
 *
 * NOTE: the GitHub App must be subscribed to "Pull request review comment" and "Pull request review
 * thread" in its settings. That lives outside this repository -- until it is done, no feedback
 * arrives and this code is simply never reached.
 */
export const feedbackGitHubWebhookEvents = ['pull_request_review_comment', 'pull_request_review_thread'] as const;

export type FeedbackGitHubWebhookEventName = typeof feedbackGitHubWebhookEvents[number];

export function isFeedbackGitHubWebhookEvent(eventName: string): eventName is FeedbackGitHubWebhookEventName {
  return (feedbackGitHubWebhookEvents as readonly string[]).includes(eventName);
}

/** The review-comment object shared by both feedback events. Only the fields we actually read. */
export type GitHubReviewCommentPayload = {
  id: number;
  body: string | null;
  path?: string | null;
  /** Null once the comment goes outdated, which is why we never key feedback on it. */
  line?: number | null;
  user?: { login?: string | null } | null;
};

export type PullRequestReviewCommentWebhookPayload = {
  action: 'created' | 'edited' | 'deleted';
  installation?: { id: number };
  repository: { owner: { login: string }; name: string };
  pull_request: { number: number };
  comment: GitHubReviewCommentPayload;
};

export type PullRequestReviewThreadWebhookPayload = {
  action: 'resolved' | 'unresolved';
  installation?: { id: number };
  repository: { owner: { login: string }; name: string };
  pull_request: { number: number };
  /** `thread` carries only `node_id` and `comments` -- there is no numeric thread id to key on. */
  thread: { node_id?: string; comments: GitHubReviewCommentPayload[] };
};

export type FeedbackWebhookPayload =
  | PullRequestReviewCommentWebhookPayload
  | PullRequestReviewThreadWebhookPayload;

export type PullRequestWebhookPayload = {
  action: 'opened' | 'synchronize' | 'ready_for_review' | 'reopened' | 'closed';
  installation?: { id: number };
  repository: {
    owner: { login: string };
    name: string;
  };
  pull_request: {
    number: number;
    title: string;
    user: { login: string };
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
    draft: boolean;
    body: string | null;
  };
};

export type IssueCommentWebhookPayload = {
  action: 'created';
  installation?: { id: number };
  repository: {
    owner: { login: string };
    name: string;
  };
  issue: {
    number: number;
    pull_request?: {
      url: string;
    };
  };
  comment: {
    body: string;
  };
};

export type GitHubWebhookPayload = PullRequestWebhookPayload | IssueCommentWebhookPayload;
