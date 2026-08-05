import { logger } from '@server/core/logger';
import { GitHubError, type GitHubRequestContext, repoApiPath, withRetry } from './http';
import type { GitHubReviewComment } from './types';

// Sibling of core/github.ts -- import from that barrel, not from here. Free functions over a
// GitHubRequestContext rather than methods, so the class stays the mockable seam.

export async function postReview(
  ctx: GitHubRequestContext,
  owner: string,
  repo: string,
  pullNumber: number,
  input: {
    commitSha: string;
    event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
    body: string;
    comments: GitHubReviewComment[];
  },
) {
  return withRetry(`createReview ${owner}/${repo}#${pullNumber}`, async () => {
    // Address by `line` + `side`, falling back to a legacy diff `position` if a caller supplied
    // one. Comments used to be kept ONLY when they had `position`, which nothing computed, so every
    // inline comment was silently dropped and reviews posted with just the summary.
    const mapped = input.comments.map((comment) => {
      if (typeof comment.line === 'number' && comment.line > 0) {
        return {
          path: comment.path,
          line: comment.line,
          side: comment.side ?? 'RIGHT',
          body: comment.body,
        };
      }
      if (typeof comment.position === 'number' && comment.position > 0) {
        return { path: comment.path, position: comment.position, body: comment.body };
      }
      return null;
    });

    // Which of the caller's comments survived mapping. Only the caller knows what a comment means,
    // and marking one "posted" when it was dropped here would suppress it on every future commit
    // without anyone having seen it.
    let postedIndices = mapped.flatMap((c, index) => (c === null ? [] : [index]));

    const comments = mapped.filter((c): c is NonNullable<typeof c> => c !== null);
    const unaddressable = mapped.length - comments.length;
    if (unaddressable > 0) {
      logger.warn('Dropping review comments with no usable line/position', {
        owner,
        repo,
        pullNumber,
        unaddressable,
        total: mapped.length,
      });
    }

    const body = {
      commit_id: input.commitSha,
      event: input.event,
      body: input.body,
      comments,
    };

    const reviewPath = `${repoApiPath(owner, repo)}/pulls/${pullNumber}/reviews`;
    let response = await ctx.request(reviewPath, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (response.status === 422 && body.comments.length > 0) {
      // Log GitHub's reason: a 422 here almost always means a comment pointed at a
      // line that isn't part of the diff. Without the response text this failure
      // is invisible and the review silently loses every inline comment.
      const reason = await response.clone().text().catch(() => '<unreadable>');
      logger.warn(`GitHub review creation failed with 422, retrying without inline comments`, {
        owner,
        repo,
        pullNumber,
        droppedComments: body.comments.length,
        reason: reason.slice(0, 500),
      });
      response = await ctx.request(reviewPath, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          commit_id: input.commitSha,
          event: input.event,
          body: input.body,
          comments: [],
        }),
      });
      // The summary still posts, but not a single inline comment did.
      postedIndices = [];
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new GitHubError(
        response.status,
        errText,
        reviewPath,
        `GitHub review creation failed with ${response.status}: ${errText}`,
      );
    }

    const review = (await response.json()) as { id: number };
    return { id: review.id, postedIndices };
  });
}

// A review this app already posted on the given commit. Used by finalize ONLY when re-running past
// the posting stage, to avoid double-posting when an earlier invocation died between createReview()
// and completeJob(). One GET, first page of 100.
export async function findBotReviewForCommit(
  ctx: GitHubRequestContext,
  owner: string,
  repo: string,
  pullNumber: number,
  commitSha: string,
  botLogin: string,
): Promise<{ id: number } | null> {
  return withRetry(`findBotReviewForCommit ${owner}/${repo}#${pullNumber}`, async () => {
    const response = await ctx.requestAndCheck(
      `${repoApiPath(owner, repo)}/pulls/${pullNumber}/reviews?per_page=100`,
    );
    const reviews = (await response.json()) as Array<{
      id: number;
      commit_id?: string | null;
      user?: { login?: string | null } | null;
    }>;
    const login = botLogin.toLowerCase();
    const match = reviews.find(
      (review) =>
        review.commit_id === commitSha &&
        (review.user?.login ?? '').toLowerCase().startsWith(login),
    );
    return match ? { id: match.id } : null;
  });
}
