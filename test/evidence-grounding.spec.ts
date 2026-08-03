import { describe, expect, it } from 'vitest';
import { parseFileReviewResponse } from '@server/core/model-output';
import { buildAnchorHash, buildFindingFingerprint, fnv1a32Hex, normalizeDiffText } from '@server/core/fingerprint';
import type { FileDiff } from '@server/core/diff';

const file: FileDiff = {
  path: 'src/app.ts',
  previousPath: null,
  isNew: false,
  isDeleted: false,
  isBinary: false,
  lineCount: 5,
  hunks: [
    {
      header: '@@ -1,4 +1,5 @@',
      lines: [
        { kind: 'context', content: 'const config = load();', newLineNumber: 1, position: 1 },
        { kind: 'del', content: 'const timeout = 30;', oldLineNumber: 2, position: 2 },
        { kind: 'add', content: 'const timeout = config.timeout;', newLineNumber: 2, position: 3 },
        { kind: 'add', content: 'server.listen(timeout);', newLineNumber: 3, position: 4 },
        { kind: 'context', content: '}', newLineNumber: 4, position: 5 },
      ],
    },
  ],
};

// NOTE: avoid titles beginning with a severity/category keyword ('Bug', 'Security', ...) -- the
// parser strips those as leading tags, which would empty the title and cascade into an empty body.
function review(finding: Record<string, unknown>) {
  return JSON.stringify({
    findings: [{ title: 'Unvalidated timeout', body: 'The timeout value is never checked.', priority: 1, confidence_score: 0.9, ...finding }],
    overall_correctness: 'patch is incorrect',
    overall_explanation: 'explanation',
    overall_confidence_score: 0.8,
  });
}

describe('evidence grounding', () => {
  it('anchors on the quoted line, overriding a wrong reported line number', () => {
    const raw = review({
      evidence: 'server.listen(timeout);',
      code_location: { absolute_file_path: 'src/app.ts', line: 1 },
    });

    const result = parseFileReviewResponse(raw, file, { schemaEnforced: true });
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].line).toBe(3);
  });

  // renderFileDiff shows each line as "   1   2 +code", and models routinely copy that whole
  // prefix when told to quote verbatim. If the normalizer didn't strip it, nothing would match.
  it('matches evidence that still carries the rendered gutter and +/- marker', () => {
    const raw = review({
      evidence: '   2    2 +const timeout = config.timeout;',
      code_location: { absolute_file_path: 'src/app.ts', line: 2 },
    });

    const result = parseFileReviewResponse(raw, file, { schemaEnforced: true });
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].line).toBe(2);
  });

  it('excludes a finding whose evidence appears nowhere in the diff', () => {
    const raw = review({
      evidence: 'const retries = getRetryPolicy(config);',
      code_location: { absolute_file_path: 'src/app.ts', line: 2 },
    });

    const result = parseFileReviewResponse(raw, file, { schemaEnforced: true });
    expect(result.comments).toHaveLength(0);
    // The reason is part of the marker so the disposition data can attribute it.
    expect(result.fileSummary).toContain('[unverified:unmatched]');
  });

  // Same unmatched evidence, but on a provider that cannot enforce the field. Excluding here would
  // let a provider limitation empty out the whole review.
  it('keeps an unmatched finding when the provider could not enforce the schema', () => {
    const raw = review({
      evidence: 'const retries = getRetryPolicy(config);',
      code_location: { absolute_file_path: 'src/app.ts', line: 2 },
    });

    const result = parseFileReviewResponse(raw, file, { schemaEnforced: false });
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].line).toBe(2);
  });

  // Previously `weak` and `absent` fell through to line-based anchoring and posted, so a finding
  // that quoted NOTHING was treated more leniently than one that quoted wrong. Under an enforced
  // schema `evidence` is a required field, so an unusable quote is a schema violation.
  it('excludes evidence too short to discriminate when the schema required a quote', () => {
    const raw = review({
      evidence: '}',
      code_location: { absolute_file_path: 'src/app.ts', line: 2 },
    });

    const result = parseFileReviewResponse(raw, file, { schemaEnforced: true });
    expect(result.comments).toHaveLength(0);
    expect(result.fileSummary).toContain('[unverified:weak]');
    expect(result.evidenceStats.weak).toBe(1);
  });

  it('excludes a finding with no evidence at all when the schema required a quote', () => {
    const raw = review({ code_location: { absolute_file_path: 'src/app.ts', line: 2 } });

    const result = parseFileReviewResponse(raw, file, { schemaEnforced: true });
    expect(result.comments).toHaveLength(0);
    expect(result.fileSummary).toContain('[unverified:absent]');
    expect(result.evidenceStats.absent).toBe(1);
  });

  // ...but a provider that cannot enforce a grammar must not have its whole review emptied out.
  it('keeps weak and absent evidence when the provider could not enforce the schema', () => {
    const weak = parseFileReviewResponse(
      review({ evidence: '}', code_location: { absolute_file_path: 'src/app.ts', line: 2 } }),
      file, { schemaEnforced: false },
    );
    const absent = parseFileReviewResponse(
      review({ code_location: { absolute_file_path: 'src/app.ts', line: 2 } }),
      file, { schemaEnforced: false },
    );

    expect(weak.comments).toHaveLength(1);
    expect(absent.comments).toHaveLength(1);
  });

  // A quote of removed code must not anchor to the `del` line: findPositionForLine rejects those,
  // so the finding would be orphaned even though it is perfectly legitimate.
  it('does not anchor to a deleted line', () => {
    const raw = review({
      evidence: 'const timeout = 30;',
      code_location: { absolute_file_path: 'src/app.ts', line: 2 },
    });

    const result = parseFileReviewResponse(raw, file, { schemaEnforced: true });
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].line).toBe(2);
  });

  // Regression: a fabricated quote must not anchor itself by "containing" a scrap of punctuation
  // from the diff. Production posted four hallucinated React-hook findings this way -- evidence
  // like "useEffect(() => {" matched a real line that was just ") => {".
  it('does not anchor a fabricated quote to a short punctuation-only diff line', () => {
    const braceFile: FileDiff = {
      ...file,
      hunks: [{
        header: '@@ -1,2 +1,2 @@',
        lines: [
          { kind: 'add', content: '  ) => {', newLineNumber: 1, position: 1 },
          { kind: 'add', content: '  const timeout = config.timeout;', newLineNumber: 2, position: 2 },
        ],
      }],
    };

    const raw = review({
      evidence: 'useEffect(() => {',
      code_location: { absolute_file_path: 'src/app.ts', line: 1 },
    });

    const result = parseFileReviewResponse(raw, braceFile, { schemaEnforced: true });
    expect(result.comments).toHaveLength(0);
    expect(result.evidenceStats.unmatched).toBe(1);
  });

  it('still accepts a genuine fragment of a substantial line', () => {
    const raw = review({
      evidence: 'server.listen(timeout)',
      code_location: { absolute_file_path: 'src/app.ts', line: 3 },
    });

    const result = parseFileReviewResponse(raw, file, { schemaEnforced: true });
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].line).toBe(3);
  });

  it('reports evidence match statistics for observability', () => {
    const raw = review({
      evidence: 'server.listen(timeout);',
      code_location: { absolute_file_path: 'src/app.ts', line: 3 },
    });

    const result = parseFileReviewResponse(raw, file, { schemaEnforced: true });
    expect(result.evidenceStats).toMatchObject({ total: 1, matched: 1, unmatched: 0 });
  });

  it('treats a missing confidence score as failing when the schema required one', () => {
    const raw = JSON.stringify({
      findings: [{
        title: 'Unvalidated timeout',
        body: 'The timeout value is never checked.',
        priority: 1,
        evidence: 'server.listen(timeout);',
        code_location: { absolute_file_path: 'src/app.ts', line: 3 },
      }],
      overall_correctness: 'patch is incorrect',
      overall_explanation: 'explanation',
    });

    const enforced = parseFileReviewResponse(raw, file, { schemaEnforced: true });
    expect(enforced.comments[0].confidenceScore).toBe(0);

    // Where the provider ignores schemas, absence is not the model's fault and must not be scored 0.
    const unenforced = parseFileReviewResponse(raw, file, { schemaEnforced: false });
    expect(unenforced.comments[0].confidenceScore).toBeUndefined();
  });

  it('maps priority 4 to nit so the severity gate has something to act on', () => {
    const raw = review({
      priority: 4,
      evidence: 'server.listen(timeout);',
      code_location: { absolute_file_path: 'src/app.ts', line: 3 },
    });

    const result = parseFileReviewResponse(raw, file, { schemaEnforced: true });
    expect(result.comments[0].severity).toBe('nit');
  });
});

describe('fingerprints', () => {
  it('is deterministic', () => {
    expect(fnv1a32Hex('hello')).toBe(fnv1a32Hex('hello'));
    expect(fnv1a32Hex('hello')).not.toBe(fnv1a32Hex('hellp'));
  });

  it('strips the rendered diff gutter and collapses whitespace', () => {
    expect(normalizeDiffText('   2    2 +const a = 1;')).toBe('const a = 1;');
    expect(normalizeDiffText('  const   a  =  1;  ')).toBe('const a = 1;');
  });

  // Identity must survive reindentation, so an unrelated formatting change doesn't re-raise every
  // finding in the file...
  it('anchor hash ignores whitespace-only changes', () => {
    expect(buildAnchorHash('  const a = 1;')).toBe(buildAnchorHash('const   a = 1;'));
  });

  // ...but must change when the code itself does, so a genuine edit re-raises the finding.
  it('anchor hash changes when the code changes', () => {
    expect(buildAnchorHash('const a = 1;')).not.toBe(buildAnchorHash('const a = 2;'));
  });

  it('fingerprint is scoped per path and stable across title formatting', () => {
    expect(buildFindingFingerprint('a.ts', 'Missing null check'))
      .toBe(buildFindingFingerprint('a.ts', 'missing  null-check'));
    expect(buildFindingFingerprint('a.ts', 'Missing null check'))
      .not.toBe(buildFindingFingerprint('b.ts', 'Missing null check'));
  });
});
