import { describe, expect, it } from 'vitest';
import { parseFileReviewResponse } from '@server/core/model-output';
import { buildFindingFingerprint } from '@server/core/fingerprint';
import { CLAIM_TYPE_CATEGORY, claimTypes, toClaimType } from '@shared/schema';
import type { FileDiff } from '@server/core/diff';

const file: FileDiff = {
  path: 'src/app.ts',
  previousPath: null,
  isNew: false,
  isDeleted: false,
  isBinary: false,
  lineCount: 2,
  hunks: [{
    header: '@@ -1,2 +1,2 @@',
    lines: [
      { kind: 'add', content: 'const query = `SELECT * FROM users WHERE id = ${id}`;', newLineNumber: 1, position: 1 },
      { kind: 'add', content: 'server.listen(timeout);', newLineNumber: 2, position: 2 },
    ],
  }],
};

function review(finding: Record<string, unknown>) {
  return JSON.stringify({
    findings: [{
      title: 'Unvalidated input',
      body: 'The value is never checked.',
      priority: 1,
      confidence_score: 0.9,
      ...finding,
    }],
    overall_correctness: 'patch is incorrect',
    overall_explanation: 'explanation',
    overall_confidence_score: 0.8,
  });
}

describe('claim types', () => {
  it('round-trips a valid claim type onto the parsed comment', () => {
    const raw = review({
      claim_type: 'sql_injection',
      evidence: 'const query = `SELECT * FROM users WHERE id = ${id}`;',
      code_location: { absolute_file_path: 'src/app.ts', line: 1 },
    });

    const result = parseFileReviewResponse(raw, file, { schemaEnforced: true });
    expect(result.comments[0].claimType).toBe('sql_injection');
    expect(result.claimTypeCounts).toEqual({ sql_injection: 1 });
  });

  // A Zod rejection here would discard every finding in the file over one bad label.
  it('coerces an unknown or missing claim type to other rather than throwing', () => {
    for (const value of ['not_a_real_type', '', undefined, 42]) {
      const raw = review({
        claim_type: value,
        evidence: 'server.listen(timeout);',
        code_location: { absolute_file_path: 'src/app.ts', line: 2 },
      });
      const result = parseFileReviewResponse(raw, file, { schemaEnforced: true });
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].claimType).toBe('other');
    }
  });

  // category was hardcoded to 'quality' on all 705 rows in production, making the per-category
  // dashboard aggregate a single meaningless bar.
  it('derives category from the claim type instead of hardcoding quality', () => {
    const raw = review({
      claim_type: 'sql_injection',
      evidence: 'const query = `SELECT * FROM users WHERE id = ${id}`;',
      code_location: { absolute_file_path: 'src/app.ts', line: 1 },
    });

    const result = parseFileReviewResponse(raw, file, { schemaEnforced: true });
    expect(result.comments[0].category).toBe('security');
  });

  it('maps every claim type to a category', () => {
    for (const type of claimTypes) {
      expect(CLAIM_TYPE_CATEGORY[type]).toBeDefined();
    }
    expect(toClaimType('other')).toBe('other');
  });

  it('captures the diff context needed to re-judge the finding later', () => {
    const raw = review({
      claim_type: 'other',
      evidence: 'server.listen(timeout);',
      code_location: { absolute_file_path: 'src/app.ts', line: 2 },
    });

    const result = parseFileReviewResponse(raw, file, { schemaEnforced: true });
    // Without this, offline evaluation is impossible: migration 003 nulls diff_input and the KV
    // diff cache expires after 6 hours.
    expect(result.comments[0].contextSnippet).toContain('server.listen(timeout);');
  });
});

describe('fingerprint stability', () => {
  // buildFindingFingerprint hashes path + normalized title. If a title-format change ever shifts
  // these values, cross-run suppression resets AND every human dismissal in comment_feedback stops
  // matching -- so the next review re-posts findings someone already deleted. Adding claim_type as
  // its own field (never in the title) must leave these untouched.
  it('is unchanged by the claim_type work', () => {
    expect(buildFindingFingerprint('src/app.ts', 'Unvalidated input')).toBe('7b6aa76f');
    expect(buildFindingFingerprint('src/client/pages/repos.tsx', 'Missing Dependency in useMemo')).toBe('8fbe1174');
  });

  it('ignores title formatting but not the path', () => {
    expect(buildFindingFingerprint('a.ts', 'Missing null check'))
      .toBe(buildFindingFingerprint('a.ts', 'missing  null-check'));
    expect(buildFindingFingerprint('a.ts', 'Missing null check'))
      .not.toBe(buildFindingFingerprint('b.ts', 'Missing null check'));
  });
});
