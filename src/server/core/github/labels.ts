import { GitHubError, type GitHubRequestContext, repoApiPath, withRetry } from './http';
import type { GitHubIssueLabel } from './types';

// Sibling of core/github.ts -- import from that barrel, not from here. Free functions over a
// GitHubRequestContext rather than methods, so the class stays the mockable seam.

export async function ensureLabel(
  ctx: GitHubRequestContext,
  owner: string,
  repo: string,
  name: string,
  color: string,
) {
  return withRetry(`ensureLabel ${owner}/${repo} ${name}`, async () => {
    const listResponse = await ctx.request(`${repoApiPath(owner, repo)}/labels/${encodeURIComponent(name)}`);
    if (listResponse.ok) {
      return;
    }
    if (listResponse.status !== 404) {
      const errText = await listResponse.text();
      throw new GitHubError(
        listResponse.status,
        errText,
        name,
        `GitHub label lookup failed with ${listResponse.status}: ${errText}`,
      );
    }

    const createResponse = await ctx.request(`${repoApiPath(owner, repo)}/labels`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name, color }),
    });

    // 422 means it already exists -- a concurrent job created it between the lookup and here.
    if (!createResponse.ok && createResponse.status !== 422) {
      const errText = await createResponse.text();
      throw new GitHubError(
        createResponse.status,
        errText,
        name,
        `GitHub label creation failed with ${createResponse.status}: ${errText}`,
      );
    }
  });
}

export async function addIssueLabels(
  ctx: GitHubRequestContext,
  owner: string,
  repo: string,
  issueNumber: number,
  labels: string[],
) {
  return withRetry(`addIssueLabels ${owner}/${repo}#${issueNumber}`, async () => {
    await ctx.requestAndCheck(`${repoApiPath(owner, repo)}/issues/${issueNumber}/labels`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ labels }),
    });
  });
}

export async function listIssueLabels(
  ctx: GitHubRequestContext,
  owner: string,
  repo: string,
  issueNumber: number,
) {
  return withRetry(`listIssueLabels ${owner}/${repo}#${issueNumber}`, async () => {
    const response = await ctx.requestAndCheck(`${repoApiPath(owner, repo)}/issues/${issueNumber}/labels?per_page=100`);
    const labels = await response.json();
    if (!Array.isArray(labels)) {
      throw new Error('Expected an array of labels from GitHub API.');
    }
    return labels
      .map((label: GitHubIssueLabel) => label.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
  });
}

export async function removeIssueLabel(
  ctx: GitHubRequestContext,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
) {
  return withRetry(`removeIssueLabel ${owner}/${repo}#${issueNumber} ${label}`, async () => {
    const response = await ctx.request(
      `${repoApiPath(owner, repo)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      {
        method: 'DELETE',
      },
    );

    if (!response.ok && response.status !== 404) {
      const errText = await response.text();
      throw new GitHubError(
        response.status,
        errText,
        label,
        `GitHub label removal failed with ${response.status}: ${errText}`,
      );
    }
  });
}
