import { verifyFindings } from '@server/core/review';
import { defaultRepoConfig, type ParsedReviewComment } from '@shared/schema';
import type { FileDiff } from '@server/core/diff';

const files: FileDiff[] = [
  {
    path: 'a.ts',
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: 2,
    hunks: [
      {
        header: '@@ -1,2 +1,2 @@',
        lines: [
          { kind: 'add', content: 'const x = 1;', newLineNumber: 1, position: 1 },
          { kind: 'add', content: 'const y = 2;', newLineNumber: 2, position: 2 },
        ],
      },
    ],
  },
];

const comment = (over: Partial<ParsedReviewComment>): ParsedReviewComment => ({
  path: 'a.ts',
  line: 1,
  position: 1,
  severity: 'P1',
  category: 'quality',
  title: 'Finding',
  body: 'body',
  ...over,
});

const fakeModel = (rawText: string) => ({
  verifyFindings: async () => ({ rawText, inputTokens: 0, outputTokens: 0, modelUsed: 'm', provider: 'p' }),
});

const throwingModel = () => ({
  verifyFindings: async () => {
    throw new Error('provider down');
  },
});

describe('verifyFindings orchestrator', () => {
  const base = { job: { id: 'job-1' }, config: defaultRepoConfig, files };

  it('drops findings the verifier marks as drop', async () => {
    const comments = [comment({ title: 'Real bug' }), comment({ title: 'False positive' })];
    const model = fakeModel('{"results":[{"index":0,"verdict":"keep"},{"index":1,"verdict":"drop"}]}');
    const result = await verifyFindings({ ...base, comments, model });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Real bug');
  });

  it('falls back to the input findings when verification throws', async () => {
    const comments = [comment({ title: 'A' }), comment({ title: 'B' })];
    const result = await verifyFindings({ ...base, comments, model: throwingModel() });
    expect(result).toHaveLength(2);
  });

  it('falls back when the verifier returns unparseable output', async () => {
    const comments = [comment({ title: 'A' })];
    const result = await verifyFindings({ ...base, comments, model: fakeModel('garbage') });
    expect(result).toHaveLength(1);
  });

  it('short-circuits without calling the model when there are no findings', async () => {
    let called = false;
    const model = {
      verifyFindings: async () => {
        called = true;
        return { rawText: '{}', inputTokens: 0, outputTokens: 0, modelUsed: 'm', provider: 'p' };
      },
    };
    const result = await verifyFindings({ ...base, comments: [], model });
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });
});
