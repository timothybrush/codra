import { describe, expect, it } from 'vitest';
import { groupBatches } from '@client/pages/job-logs';
import type { FileReviewRecord } from '@shared/schema';

// Which files shared a model call is NOT stored -- pack.ts derives bins and never persists them.
// The logs view reconstructs them from the shared response body, so these pin that reconstruction.
function row(filePath: string, over: Partial<FileReviewRecord> = {}): FileReviewRecord {
  return {
    id: `id-${filePath}`,
    jobId: 'job',
    filePath,
    fileStatus: 'done',
    modelUsed: 'gemini-2.5-flash',
    diffLineCount: 10,
    diffInput: null,
    rawAiOutput: null,
    parsedComments: [],
    inputTokens: 100,
    outputTokens: 10,
    durationMs: 1000,
    verdict: 'comment',
    fileSummary: 'ok',
    errorMessage: null,
    createdAt: new Date().toISOString(),
    ...over,
  } as FileReviewRecord;
}

describe('groupBatches', () => {
  it('groups the files that shared one model call, and numbers the batches in file order', () => {
    const binA = '{"files":[{"absolute_file_path":"a.ts"},{"absolute_file_path":"b.ts"}]}';
    const binB = '{"files":[{"absolute_file_path":"c.ts"},{"absolute_file_path":"d.ts"}]}';
    const groups = groupBatches([
      row('a.ts', { batchSize: 2, rawAiOutput: binA }),
      row('c.ts', { batchSize: 2, rawAiOutput: binB }),
      row('b.ts', { batchSize: 2, rawAiOutput: binA }),
      row('d.ts', { batchSize: 2, rawAiOutput: binB }),
    ]);

    expect(groups.get('a.ts')!.paths.sort()).toEqual(['a.ts', 'b.ts']);
    expect(groups.get('b.ts')!.index).toBe(groups.get('a.ts')!.index);
    expect(groups.get('c.ts')!.index).not.toBe(groups.get('a.ts')!.index);
    // Numbered by first appearance, so the labels read top-to-bottom down the list.
    expect(groups.get('a.ts')!.index).toBe(1);
    expect(groups.get('c.ts')!.index).toBe(2);
  });

  it('leaves solo, pre-batching and response-less rows ungrouped', () => {
    const groups = groupBatches([
      // Reviewed alone.
      row('solo.ts', { batchSize: 1, rawAiOutput: '{"findings":[]}' }),
      // Row written before batching existed.
      row('old.ts', { batchSize: null, rawAiOutput: '{"findings":[]}' }),
      // Deferred/failed bin member: no response to group on, so it must not invent a batch.
      row('failed.ts', { batchSize: 4, rawAiOutput: null, fileStatus: 'failed' }),
    ]);

    expect(groups.size).toBe(0);
  });
});
