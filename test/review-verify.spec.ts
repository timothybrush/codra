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

  it('drops findings the verifier marks as drop, and records its reason', async () => {
    const comments = [comment({ title: 'Real bug' }), comment({ title: 'False positive' })];
    const model = fakeModel('{"results":[{"index":0,"verdict":"keep"},{"index":1,"reason":"line does not do that","verdict":"drop"}]}');
    const result = await verifyFindings({ ...base, comments, model });
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].title).toBe('Real bug');
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].disposition).toBe('verify');
    expect(result.dropped[0].reason).toBe('line does not do that');
    // Reasons are captured for KEPT findings too -- that is the half that explains what survived.
    expect(result.reasons.size).toBeGreaterThanOrEqual(0);
  });

  it('falls back to the input findings when verification throws', async () => {
    const comments = [comment({ title: 'A' }), comment({ title: 'B' })];
    const result = await verifyFindings({ ...base, comments, model: throwingModel() });
    expect(result.comments).toHaveLength(2);
    expect(result.stats.failedOpen).toBe('error');
  });

  it('falls back when the verifier returns unparseable output', async () => {
    const comments = [comment({ title: 'A' })];
    const result = await verifyFindings({ ...base, comments, model: fakeModel('garbage') });
    expect(result.comments).toHaveLength(1);
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
    expect(result.comments).toEqual([]);
    expect(called).toBe(false);
  });

  // THE mis-attribution test. Verdicts are read from a sparse map keyed on the model's own `index`
  // field, so a scrambled result order must still land on the finding the model actually judged. If
  // this is ever read positionally again, the wrong findings get deleted and nothing looks wrong.
  it('applies verdicts by index, not by arrival order', async () => {
    const comments = [comment({ title: 'A' }), comment({ title: 'B' }), comment({ title: 'C' })];
    const model = fakeModel('{"results":[{"index":2,"verdict":"drop"},{"index":0,"verdict":"keep"},{"index":1,"verdict":"keep"}]}');
    const result = await verifyFindings({ ...base, comments, model });
    expect(result.comments.map((c) => c.title)).toEqual(['A', 'B']);
  });

  // Above the answer-ratio floor, an index the model never addressed fails CLOSED -- but with its own
  // disposition, because an unanswered finding is our defect, not the model's judgement.
  it('drops an unanswered index as verify_unanswered when most indices were answered', async () => {
    const comments = ['A', 'B', 'C', 'D', 'E'].map((title) => comment({ title }));
    const model = fakeModel(
      '{"results":[{"index":0,"verdict":"keep"},{"index":1,"verdict":"keep"},{"index":2,"verdict":"keep"},{"index":4,"verdict":"keep"}]}',
    );
    const result = await verifyFindings({ ...base, comments, model });
    expect(result.comments.map((c) => c.title)).toEqual(['A', 'B', 'C', 'E']);
    expect(result.dropped[0].disposition).toBe('verify_unanswered');
    expect(result.stats.droppedUnanswered).toBe(1);
  });

  // Below the floor the model did not do the task. Failing closed there would be a mass deletion
  // dressed up as judgement -- and truncated output truncates the TAIL, i.e. the low-severity end.
  it('keeps everything when the verifier answers too few indices', async () => {
    const comments = ['A', 'B', 'C', 'D', 'E'].map((title) => comment({ title }));
    const model = fakeModel('{"results":[{"index":0,"verdict":"drop"},{"index":1,"verdict":"drop"}]}');
    const result = await verifyFindings({ ...base, comments, model });
    expect(result.comments).toHaveLength(5);
    expect(result.stats.failedOpen).toBe('under_response');
    expect(result.dropped).toHaveLength(0);
  });

  it('ignores an out-of-range index rather than aborting the pass', async () => {
    const comments = [comment({ title: 'A' }), comment({ title: 'B' }), comment({ title: 'C' })];
    const model = fakeModel(
      '{"results":[{"index":99,"verdict":"drop"},{"index":0,"verdict":"keep"},{"index":1,"verdict":"drop"},{"index":2,"verdict":"keep"}]}',
    );
    const result = await verifyFindings({ ...base, comments, model });
    expect(result.comments.map((c) => c.title)).toEqual(['A', 'C']);
  });

  // Two conflicting verdicts for one index must not let arrival order decide.
  it('treats a conflicting duplicate index as unanswered', async () => {
    const comments = ['A', 'B', 'C', 'D'].map((title) => comment({ title }));
    const model = fakeModel(
      '{"results":[{"index":0,"verdict":"keep"},{"index":0,"verdict":"drop"},{"index":1,"verdict":"keep"},{"index":2,"verdict":"keep"},{"index":3,"verdict":"keep"}]}',
    );
    const result = await verifyFindings({ ...base, comments, model });
    const dropped = result.dropped.find((d) => d.comment.title === 'A');
    expect(dropped?.disposition).toBe('verify_unanswered');
  });

  // A candidate with no snippet AND no evidence cannot be judged at all. It used to skip the model
  // and post anyway -- the least-grounded findings taking the most lenient path.
  it('fails closed on a candidate with no diff context', async () => {
    const comments = [
      comment({ title: 'A' }),
      comment({ title: 'B' }),
      comment({ title: 'C' }),
      comment({ title: 'Orphan', path: 'missing.ts', line: 99 }),
    ];
    const model = fakeModel(
      '{"results":[{"index":0,"verdict":"keep"},{"index":1,"verdict":"keep"},{"index":2,"verdict":"keep"}]}',
    );
    const result = await verifyFindings({ ...base, comments, model });
    const orphan = result.dropped.find((d) => d.comment.title === 'Orphan');
    expect(orphan?.disposition).toBe('unverifiable_passthrough');
    expect(result.comments).toHaveLength(3);
  });

  // ...but a WHOLESALE failure to render snippets is infrastructure, not judgement. A path
  // normalization mismatch must not read as a wall of model verdicts.
  it('trips the circuit breaker rather than deleting a whole file of findings', async () => {
    const comments = [
      comment({ title: 'A' }),
      comment({ title: 'Orphan 1', path: 'missing.ts', line: 99 }),
      comment({ title: 'Orphan 2', path: 'missing.ts', line: 98 }),
      comment({ title: 'Orphan 3', path: 'missing.ts', line: 97 }),
    ];
    let called = false;
    const model = {
      verifyFindings: async () => {
        called = true;
        return { rawText: '{"results":[]}', inputTokens: 0, outputTokens: 0, modelUsed: 'm', provider: 'p' };
      },
    };
    const result = await verifyFindings({ ...base, comments, model });
    expect(result.comments).toHaveLength(4);
    expect(result.stats.failedOpen).toBe('unverifiable_ratio');
    expect(called).toBe(false);
  });

  // The invariant that makes the severity sort survive into the max_comments cap. This pass used to
  // return [...kept, ...unverifiable, ...passthrough], which reordered the array before it was
  // sliced -- so the cap was cutting from a list that was no longer sorted by severity.
  it('returns a strict subsequence of its input', async () => {
    const comments = ['A', 'B', 'C', 'D', 'E'].map((title) => comment({ title }));
    const model = fakeModel(
      '{"results":[{"index":0,"verdict":"drop"},{"index":1,"verdict":"keep"},{"index":2,"verdict":"keep"},{"index":3,"verdict":"drop"},{"index":4,"verdict":"keep"}]}',
    );
    const result = await verifyFindings({ ...base, comments, model });

    const indices = result.comments.map((c) => comments.indexOf(c));
    expect(indices).not.toContain(-1);
    expect([...indices]).toEqual([...indices].sort((a, b) => a - b));
  });

  it('forwards the evidence quote so the verifier judges a specific line', async () => {
    let seen: any;
    const model = {
      verifyFindings: async (params: any) => {
        seen = params.candidates;
        return {
          rawText: '{"results":[{"index":0,"verdict":"keep"}]}',
          inputTokens: 0, outputTokens: 0, modelUsed: 'm', provider: 'p',
        };
      },
    };
    await verifyFindings({ ...base, comments: [comment({ evidence: 'const x = 1;' })], model });
    expect(seen[0].evidence).toBe('const x = 1;');
  });
});
