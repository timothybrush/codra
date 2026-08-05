// Shared service doubles for the DB-backed review suites (review-flow and async-batch).
//
// `vi.mock` factories are hoisted above imports, so these are pulled in with a dynamic `await
// import(...)` inside the factory rather than a top-level import. That is the only shape that works.
//
// Each suite overrides the two or three methods it is actually testing and inherits the rest, so a
// new field on a review response is added once here instead of in every suite that never reads it.

// A PR that always resolves, with one changed file. Enough for any suite not testing GitHub itself.
export function makeGitHubServiceMock(overrides: Record<string, unknown> = {}) {
  return class MockGitHubService {
    async getPullRequest() {
      return {
        title: 'Test PR',
        body: 'Test Body',
        head: { sha: 'headsha', ref: 'feature' },
        base: { sha: 'basesha', ref: 'main' },
        user: { login: 'author' },
      };
    }
    async getPullRequestDiff() {
      return [
        'diff --git a/src/app.ts b/src/app.ts',
        'index 0000000..1111111 100644',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -0,0 +1 @@',
        '+console.log(1);',
        '',
      ].join('\n');
    }
    async createCheckRun() { return { id: 123 }; }
    async updateCheckRun() { return {}; }
    async createReview() { return { id: 456 }; }
    async findBotReviewForCommit() { return null; }
    async ensureLabel() { return {}; }
    async addIssueLabels() { return {}; }
    async removeIssueLabelsIfPresent() { return {}; }
    async removeIssueLabel() { return {}; }

    constructor() {
      Object.assign(this, overrides);
    }
  };
}

// One P2 finding on src/app.ts, with the counters finalize reads kept in step with the parser.
function reviewFileResponse(overrides: Record<string, unknown> = {}) {
  return {
    parsed: {
      comments: [{
        path: 'src/app.ts', line: 1, position: 1,
        severity: 'P2', category: 'quality', title: 'Typo', body: 'Fixed typo',
      }],
      verdict: 'comment',
      fileSummary: 'Looks ok',
      overallCorrectness: 'issues found',
      confidenceScore: 0.9,
      // finalize sums these to decide whether an empty review means "nothing found" or
      // "everything withheld", so they must stay in step with parseFileReviewResponse.
      evidenceStats: { total: 1, matched: 1, unmatched: 0, weak: 0, absent: 0 },
      claimTypeCounts: { other: 1 },
      deniedClaimCounts: {},
      absenceCheckStats: { absenceShaped: 0, identifierExtracted: 0, refuted: 0 },
    },
    modelUsed: 'test-model',
    provider: 'test-provider',
    inputTokens: 10,
    outputTokens: 5,
    rawText: '{}',
    userPrompt: '',
    ...overrides,
  };
}

// Synchronous review path by default: `submitReviewBatch` returns null so the review phase takes
// `reviewFile` rather than the async batch submit/poll flow.
//
// `verifyFindings` keeps every candidate. Without it the verifier throws, and although it fails
// open, the warning masked genuine failures in these suites.
export function makeModelServiceMock(overrides: Record<string, unknown> = {}) {
  return class MockModelService {
    async submitReviewBatch() { return null; }
    async pollReviewBatch() { return { status: 'pending' as const }; }
    async reviewFile() { return reviewFileResponse(); }
    async generateSummary() {
      return { modelUsed: 'sum-model', provider: 'google', rawText: '{"summary": "test"}', inputTokens: 3, outputTokens: 2 };
    }
    async verifyFindings({ candidates }: { candidates: Array<{ index: number }> }) {
      return {
        modelUsed: 'verify-model',
        provider: 'test-provider',
        rawText: JSON.stringify({
          results: candidates.map((c) => ({ index: c.index, reason: 'confirmed', verdict: 'keep' })),
        }),
        inputTokens: 1,
        outputTokens: 1,
      };
    }

    constructor() {
      Object.assign(this, overrides);
    }
  };
}

export const isRetryableModelErrorMock = (error: unknown) =>
  Boolean(error && typeof error === 'object' && (error as { retryable?: boolean }).retryable === true);
