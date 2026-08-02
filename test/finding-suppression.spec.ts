import { describe, expect, it } from 'vitest';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';
import { runWithDb, queryRows } from '@server/db/client';
import { insertJob } from '@server/db/jobs';
import { getSuppressedFindings, markCommentsPosted, upsertFileReview } from '@server/db/file-reviews';
import type { ParsedReviewComment } from '@shared/schema';

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const sha = (seed: string) => seed.repeat(40).slice(0, 40);

const finding = (over: Partial<ParsedReviewComment> = {}): ParsedReviewComment => ({
  path: 'a.ts',
  line: 1,
  position: 1,
  severity: 'P1',
  category: 'quality',
  title: 'Unvalidated input',
  body: 'The value is never checked.',
  fingerprint: 'fp0001',
  anchorHash: 'anchor01',
  ...over,
});

dbDescribe('cross-run finding suppression', () => {
  const env = createTestEnv();

  async function seedJob(repo: string, commitSha: string) {
    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 1,
      prTitle: 'PR',
      prAuthor: 'author',
      commitSha,
      baseSha: sha('b'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
    });
    return job.id;
  }

  async function seedPostedFinding(jobId: string, comment: ParsedReviewComment) {
    await upsertFileReview(env, jobId, {
      filePath: comment.path,
      fileStatus: 'done',
      modelUsed: 'test-model',
      diffLineCount: 1,
      diffInput: null,
      rawAiOutput: null,
      parsedComments: [comment],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: 'comment',
      fileSummary: 'summary',
      errorMessage: null,
    });
    await markCommentsPosted(env, jobId, [comment.fingerprint!]);
  }

  it('suppresses a finding already posted on an earlier commit of the same PR', async () => {
    const repo = `suppress-${Date.now()}-earlier`;
    await runWithDb(env, async () => {
      const firstJob = await seedJob(repo, sha('1'));
      await seedPostedFinding(firstJob, finding());

      const secondJob = await seedJob(repo, sha('2'));
      const suppressed = await getSuppressedFindings(env, secondJob);

      expect(suppressed).toContainEqual(
        expect.objectContaining({ fingerprint: 'fp0001', anchor_hash: 'anchor01', anchored: true }),
      );
    });
  });

  // Identity alone is not enough. If the developer edited the flagged line the anchor hash changes,
  // and the caller must be able to tell that apart so the finding is raised again.
  it('reports the anchor hash so an edited line can still be re-raised', async () => {
    const repo = `suppress-${Date.now()}-edited`;
    await runWithDb(env, async () => {
      const firstJob = await seedJob(repo, sha('3'));
      await seedPostedFinding(firstJob, finding({ anchorHash: 'anchor-old' }));

      const secondJob = await seedJob(repo, sha('4'));
      const suppressed = await getSuppressedFindings(env, secondJob);
      const match = suppressed.find((s) => s.fingerprint === 'fp0001');

      expect(match?.anchor_hash).toBe('anchor-old');
      expect(match?.anchor_hash).not.toBe('anchor-new');
    });
  });

  // The retry API and mention-triggered re-reviews both reuse the SAME head commit. Without the
  // commit_sha guard a manual re-review would match everything the previous run posted and produce
  // an empty, summary-only review.
  it('does not suppress a re-review of the same commit', async () => {
    const repo = `suppress-${Date.now()}-samesha`;
    const commit = sha('5');
    await runWithDb(env, async () => {
      const firstJob = await seedJob(repo, commit);
      await seedPostedFinding(firstJob, finding());

      const retryJob = await seedJob(repo, commit);
      const suppressed = await getSuppressedFindings(env, retryJob);

      expect(suppressed.filter((s) => s.anchored)).toHaveLength(0);
    });
  });

  it('does not suppress findings that were generated but never posted', async () => {
    const repo = `suppress-${Date.now()}-unposted`;
    await runWithDb(env, async () => {
      const firstJob = await seedJob(repo, sha('6'));
      // Same as seedPostedFinding, minus the markCommentsPosted call: the 422 fallback and the
      // unaddressable-comment filter both produce findings GitHub never showed.
      await upsertFileReview(env, firstJob, {
        filePath: 'a.ts', fileStatus: 'done', modelUsed: 'test-model', diffLineCount: 1,
        diffInput: null, rawAiOutput: null, parsedComments: [finding()],
        inputTokens: 1, outputTokens: 1, durationMs: 1, verdict: 'comment',
        fileSummary: 'summary', errorMessage: null,
      });

      const secondJob = await seedJob(repo, sha('7'));
      const suppressed = await getSuppressedFindings(env, secondJob);

      expect(suppressed.filter((s) => s.anchored)).toHaveLength(0);
    });
  });

  it('suppresses repo-wide, anchor-independently, when a human deleted the comment', async () => {
    const repo = `suppress-${Date.now()}-rejected`;
    await runWithDb(env, async () => {
      const job = await seedJob(repo, sha('8'));
      const [{ repository_id: repositoryId }] = await queryRows<{ repository_id: number }>(
        env, 'SELECT repository_id FROM jobs WHERE id = $1::uuid', [job],
      );
      await queryRows(
        env,
        `INSERT INTO comment_feedback (repository_id, pr_number, fingerprint, anchor_hash, github_comment_id, outcome)
         VALUES ($1::int, 1, 'fp-rejected', NULL, 12345, 'deleted')`,
        [repositoryId],
      );

      const suppressed = await getSuppressedFindings(env, job);
      const rejected = suppressed.find((s) => s.fingerprint === 'fp-rejected');

      expect(rejected).toBeDefined();
      expect(rejected?.anchored).toBe(false);
      expect(rejected?.anchor_hash).toBeNull();
    });
  });

  // Resolving a thread usually means "I fixed it" -- the finding was good. Treating it as negative
  // would train the system to stop reporting exactly what works.
  it('does not suppress on resolved feedback', async () => {
    const repo = `suppress-${Date.now()}-resolved`;
    await runWithDb(env, async () => {
      const job = await seedJob(repo, sha('9'));
      const [{ repository_id: repositoryId }] = await queryRows<{ repository_id: number }>(
        env, 'SELECT repository_id FROM jobs WHERE id = $1::uuid', [job],
      );
      await queryRows(
        env,
        `INSERT INTO comment_feedback (repository_id, pr_number, fingerprint, anchor_hash, github_comment_id, outcome)
         VALUES ($1::int, 1, 'fp-resolved', NULL, 54321, 'resolved')`,
        [repositoryId],
      );

      const suppressed = await getSuppressedFindings(env, job);
      expect(suppressed.find((s) => s.fingerprint === 'fp-resolved')).toBeUndefined();
    });
  });

  it('round-trips fingerprint, anchor hash and evidence through persistence', async () => {
    const repo = `suppress-${Date.now()}-roundtrip`;
    await runWithDb(env, async () => {
      const job = await seedJob(repo, sha('a'));
      await seedPostedFinding(job, finding({ evidence: 'const x = 1;' }));

      const [row] = await queryRows<{ evidence: string; fingerprint: string; anchor_hash: string; posted: boolean }>(
        env,
        `SELECT rc.evidence, rc.fingerprint, rc.anchor_hash, rc.posted
         FROM review_comments rc JOIN file_reviews fr ON fr.id = rc.file_review_id
         WHERE fr.job_id = $1::uuid`,
        [job],
      );

      expect(row).toMatchObject({
        evidence: 'const x = 1;',
        fingerprint: 'fp0001',
        anchor_hash: 'anchor01',
        posted: true,
      });
    });
  });
});
