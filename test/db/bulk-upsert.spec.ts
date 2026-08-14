import { expect, it } from 'vitest';
import {
  type BulkFileReviewInput,
  bulkInheritFileReviews,
  bulkRecordRetryableFileReviewFailures,
  bulkUpsertFileReviews,
  getFileReviewsForJobs,
} from '@codra/db/file-reviews';
import { getJobDetail, insertJob } from '@codra/db/jobs';
import type { ParsedReviewComment } from '@codra/schema';
import { createTestEnv, dbDescribe, sha, uniqueName } from '../helpers';

const env = createTestEnv();

async function newJob(label: string) {
  return insertJob(env, {
    installationId: '123',
    owner: 'test-owner',
    repo: uniqueName(label),
    prNumber: 1,
    prTitle: 'Bulk upsert',
    prAuthor: 'author',
    commitSha: sha('a'),
    baseSha: sha('b'),
    trigger: 'auto',
    headRef: 'feature',
    baseRef: 'main',
  });
}

function comment(path: string, title: string): ParsedReviewComment {
  return {
    path,
    line: 3,
    position: 3,
    severity: 'P2',
    category: 'quality',
    title,
    body: 'A concrete problem.',
    confidenceScore: 0.5,
    evidence: 'const x = 1;',
    fingerprint: `${path}:${title}`,
    posted: false,
    claimType: 'other',
    source: 'llm',
  } as ParsedReviewComment;
}

function review(path: string, overrides: Partial<BulkFileReviewInput> = {}): BulkFileReviewInput {
  return {
    filePath: path,
    fileStatus: 'done',
    modelUsed: 'gemini-3.5-flash',
    modelProvider: 'google',
    diffLineCount: 10,
    rawAiOutput: '{"files":[]}',
    parsedComments: [comment(path, `Finding in ${path}`)],
    inputTokens: 100,
    outputTokens: 20,
    durationMs: 1234,
    verdict: 'comment',
    fileSummary: `Summary for ${path}`,
    overallCorrectness: 'patch is incorrect',
    confidenceScore: 0.6,
    errorMessage: null,
    withheldCounts: { evidence: 5, claimDenied: 2 },
    batchSize: 3,
    ...overrides,
  };
}

dbDescribe('bulkUpsertFileReviews', () => {
  it('writes every file with its own verdict, summary and comments', async () => {
    const job = await newJob('bulk-write');
    const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

    await bulkUpsertFileReviews(env, job.id, paths.map((p) => review(p)));

    const rows = await getFileReviewsForJobs(env, [job.id]);
    expect(rows).toHaveLength(3);
    for (const path of paths) {
      const row = rows.find((r) => r.file_path === path)!;
      expect(row.file_status).toBe('done');
      expect(row.file_summary).toBe(`Summary for ${path}`);
      expect(row.batch_size).toBe(3);
      expect(row.parsed_comments).toHaveLength(1);
      // The hazard: RETURNING order is not input order, so comments joined positionally would land
      // on the wrong file's review.
      expect(row.parsed_comments[0].title).toBe(`Finding in ${path}`);
      expect(row.parsed_comments[0].path).toBe(path);
      // Without the ::jsonb cast this stores a JSON scalar and `->>'evidence'` reads NULL.
      expect(typeof row.withheld_counts).toBe('object');
      expect(row.withheld_counts).toEqual({ evidence: 5, claimDenied: 2 });
    }
  });

  // The dashboard's only signal that a row's tokens are a share of a shared call rather than its own
  // cost. Dropping it from either the SQL projection or the zod record silently reverts the feature.
  it('surfaces batch_size through getJobDetail', async () => {
    const job = await newJob('bulk-detail');

    await bulkUpsertFileReviews(env, job.id, [
      review('src/batched.ts', { batchSize: 4 }),
      review('src/alone.ts', { batchSize: 1 }),
    ]);

    const detail = await getJobDetail(env, job.id);
    expect(detail!.files.find((f) => f.filePath === 'src/batched.ts')!.batchSize).toBe(4);
    expect(detail!.files.find((f) => f.filePath === 'src/alone.ts')!.batchSize).toBe(1);
    // The logs view reads this to separate "found nothing" from "withheld everything".
    expect(detail!.files.find((f) => f.filePath === 'src/batched.ts')!.withheldCounts)
      .toEqual({ evidence: 5, claimDenied: 2 });
  });

  // A deferred bin inserts without a resolved provider, so model_provider is NULL. When the record
  // schema only allowed `undefined`, that one row threw for the whole query and every job-detail
  // request 500'd for the rest of the job's life -- observed in production on a six-file bin.
  it('reads back a row whose provider was never resolved', async () => {
    const job = await newJob('null-provider');

    await bulkRecordRetryableFileReviewFailures(env, job.id, [
      { filePath: 'src/deferred.ts', modelUsed: 'gemini-2.5-pro', diffLineCount: 9, errorMessage: 'retrying later' },
    ]);
    // A healthy row alongside it: the failure mode is one bad row poisoning the whole parse.
    await bulkUpsertFileReviews(env, job.id, [review('src/ok.ts')]);

    const detail = await getJobDetail(env, job.id);
    expect(detail!.files).toHaveLength(2);
    expect(detail!.files.find((f) => f.filePath === 'src/deferred.ts')!.modelProvider).toBeNull();
  });
});

dbDescribe('bulkRecordRetryableFileReviewFailures', () => {
  it('increments per file and returns each new count', async () => {
    const job = await newJob('bulk-retry');
    const inputs = ['src/a.ts', 'src/b.ts'].map((filePath) => ({
      filePath,
      modelUsed: 'gemini-3.5-flash',
      diffLineCount: 10,
      errorMessage: 'Model omitted this file from a batched review; retrying later',
    }));

    const first = await bulkRecordRetryableFileReviewFailures(env, job.id, inputs);
    expect(first.map((r) => r.transientErrorCount).sort()).toEqual([1, 1]);

    const second = await bulkRecordRetryableFileReviewFailures(env, job.id, inputs);
    expect(second.map((r) => r.transientErrorCount).sort()).toEqual([2, 2]);
    expect(second.map((r) => r.filePath).sort()).toEqual(['src/a.ts', 'src/b.ts']);

    // Stale comments would let finalize post findings from a review since marked failed.
    await bulkUpsertFileReviews(env, job.id, [review('src/a.ts')]);
    await bulkRecordRetryableFileReviewFailures(env, job.id, [inputs[0]]);
    const [row] = (await getFileReviewsForJobs(env, [job.id])).filter((r) => r.file_path === 'src/a.ts');
    expect(row.parsed_comments).toHaveLength(0);
  });



  // Usage stats group by model_used, which this overwrites, and withheld_counts is summed unfiltered.
  it('clears the previous attempt success columns', async () => {
    const job = await newJob('bulk-retry-clears-columns');

    await bulkUpsertFileReviews(env, job.id, [review('src/a.ts', {
      inputTokens: 900,
      outputTokens: 300,
      verdict: 'comment',
      fileSummary: 'Found things',
      overallCorrectness: 'patch is incorrect',
      confidenceScore: 0.8,
      rawAiOutput: '{"files":[{"lots":"of text"}]}',
      withheldCounts: { evidence: 5, claimDenied: 2 },
    })]);

    await bulkRecordRetryableFileReviewFailures(env, job.id, [
      { filePath: 'src/a.ts', modelUsed: 'other-model', diffLineCount: 10, errorMessage: 'provider outage; retrying later' },
    ]);

    const [row] = await getFileReviewsForJobs(env, [job.id]);
    expect(row.file_status).toBe('failed');
    expect(row.input_tokens).toBeNull();
    expect(row.output_tokens).toBeNull();
    expect(row.verdict).toBeNull();
    expect(row.file_summary).toBeNull();
    expect(row.overall_correctness).toBeNull();
    expect(row.confidence_score).toBeNull();
    expect(row.raw_ai_output).toBeNull();
    expect(row.withheld_counts).toEqual({});
  });
});

dbDescribe('bulkInheritFileReviews', () => {
  // The column list is hand-written, so a missing `withheld_counts` reads as "found nothing".
  it('carries withheld_counts and batch_size onto the inheriting job', async () => {
    const parent = await newJob('inherit-parent');
    const child = await newJob('inherit-child');

    await bulkUpsertFileReviews(env, parent.id, [review('src/a.ts', {
      batchSize: 4,
      withheldCounts: { evidence: 3, claimDenied: 1 },
    })]);

    const inherited = await bulkInheritFileReviews(env, {
      jobId: child.id,
      parentJobId: parent.id,
      filePaths: ['src/a.ts'],
    });
    expect(inherited).toEqual(['src/a.ts']);

    const [row] = await getFileReviewsForJobs(env, [child.id]);
    expect(row.batch_size).toBe(4);
    expect(row.withheld_counts).toEqual({ evidence: 3, claimDenied: 1 });
    expect(row.file_status).toBe('done');
    // Identity carries, but `posted` means "this job showed it", which the child has not.
    expect(row.parsed_comments).toHaveLength(1);
    expect(row.parsed_comments[0].posted).toBe(false);
    expect(row.parsed_comments[0].source).toBe('llm');
  });
});
