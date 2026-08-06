import { describe, expect, it } from 'vitest';
import { parseFileReviewResponse } from '@server/core/model-output';
import { buildFindingFingerprint } from '@server/core/fingerprint';
import {
  CLAIM_TYPE_CATEGORY,
  CLAIM_TYPE_DECIDABILITY,
  DEFAULT_DENIED_CLAIM_TYPES,
  claimTypes,
  toClaimType,
} from '@shared/schema';
import { buildReviewResponseSchema, fileReviewSystemPromptBase } from '@server/prompts/file-review';
import type { FileDiff } from '@server/core/diff';

import { reviewJson } from '../mocks/fixtures';
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

const review = (finding: Record<string, unknown>) =>
  reviewJson(finding, { title: 'Unvalidated input', body: 'The value is never checked.' });

describe('claim types', () => {
  it('round-trips a valid claim type onto the parsed comment', () => {
    const raw = review({
      claim_type: 'sql_injection',
      evidence: 'const query = `SELECT * FROM users WHERE id = ${id}`;',
      code_location: { absolute_file_path: 'src/app.ts', line: 1 },
    });

    const result = parseFileReviewResponse(raw, file);
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
      const result = parseFileReviewResponse(raw, file);
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

    const result = parseFileReviewResponse(raw, file);
    expect(result.comments[0].category).toBe('security');
  });

  it('maps every claim type to a category', () => {
    for (const type of claimTypes) {
      expect(CLAIM_TYPE_CATEGORY[type]).toBeDefined();
    }
    expect(toClaimType('other')).toBe('other');
  });

  it('classifies every claim type for decidability', () => {
    for (const type of claimTypes) {
      expect(CLAIM_TYPE_DECIDABILITY[type]).toBeDefined();
    }
  });
});

describe('claim type denylist', () => {
  const denied = (over: Record<string, unknown> = {}) => review({
    claim_type: 'redos_regex',
    evidence: 'const query = `SELECT * FROM users WHERE id = ${id}`;',
    code_location: { absolute_file_path: 'src/app.ts', line: 1 },
    ...over,
  });

  // The denylist is about what the model CANNOT DECIDE from a diff, which is independent of whether
  // this particular quote happened to resolve. A denied claim with flawless evidence still drops.
  it('drops a denied claim type even when its evidence matches perfectly', () => {
    const result = parseFileReviewResponse(denied(), file, { deniedClaimTypes: ['redos_regex'] });

    expect(result.comments).toHaveLength(0);
    expect(result.fileSummary).toContain('[claim-denied:redos_regex]');
    expect(result.deniedClaimCounts.redos_regex).toBe(1);
  });

  // Load-bearing ordering. Counting after the drop would erase denied types from the tally, leaving
  // no way to distinguish a denylist that is working from one that never matches anything.
  it('counts a denied claim in claimTypeCounts before dropping it', () => {
    const result = parseFileReviewResponse(denied(), file, { deniedClaimTypes: ['redos_regex'] });
    expect(result.claimTypeCounts.redos_regex).toBe(1);
  });

  it('keeps the same claim when the type is not denied', () => {
    const result = parseFileReviewResponse(denied(), file, { deniedClaimTypes: [] });
    expect(result.comments).toHaveLength(1);
  });

  // Enforcement is invisible to the model precisely so it has no reason to relabel -- but a model can
  // reach for 'other' unprompted, which would launder a denied claim into the allowed bucket.
  it('repairs an other-labelled claim whose text is unmistakably a denied class', () => {
    const raw = review({
      claim_type: 'other',
      title: 'Effect re-runs on every render',
      body: 'The dependency array omits `id`, so this effect runs on every render.',
      evidence: 'server.listen(timeout);',
      code_location: { absolute_file_path: 'src/app.ts', line: 2 },
    });

    const result = parseFileReviewResponse(raw, file, { deniedClaimTypes: ['react_hook_missing_deps'] });
    expect(result.comments).toHaveLength(0);
    expect(result.deniedClaimCounts.react_hook_missing_deps).toBe(1);
  });

  // The counterpart risk: repair must not drag legitimate 'other' findings into a denied bucket.
  it('leaves a generic other finding alone', () => {
    const raw = review({
      claim_type: 'other',
      title: 'Loading guard is bypassed',
      body: 'When the render prop is used the loading state is never checked.',
      evidence: 'server.listen(timeout);',
      code_location: { absolute_file_path: 'src/app.ts', line: 2 },
    });

    const result = parseFileReviewResponse(raw, file, { deniedClaimTypes: [...DEFAULT_DENIED_CLAIM_TYPES] });
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].claimType).toBe('other');
  });

  // Anti-laundering guard. If the model is ever SHOWN a narrowed enum, it will relabel denied claims
  // as 'other' and walk them straight through the allowed bucket -- while also destroying the
  // per-type measurement. The grammar must keep advertising all of them.
  it('still advertises every claim type to the model', () => {
    const schema = buildReviewResponseSchema(10) as unknown as {
      schema: { properties: { findings: { items: { properties: { claim_type: { enum: string[] } } } } } };
    };

    expect(schema.schema.properties.findings.items.properties.claim_type.enum)
      .toEqual([...claimTypes]);
    for (const type of claimTypes) {
      expect(fileReviewSystemPromptBase).toContain(type);
    }
  });

  // Measured on PR #55: 3 generated, 0 valid. It was held out pending exactly that data.
  it('denies null_or_undefined_deref now that it has been measured', () => {
    expect(DEFAULT_DENIED_CLAIM_TYPES).toContain('null_or_undefined_deref');
    expect(DEFAULT_DENIED_CLAIM_TYPES).toContain('react_hook_missing_deps');
  });

  it('denies every claim type that is not decidable from the diff', () => {
    for (const type of claimTypes) {
      const denied = DEFAULT_DENIED_CLAIM_TYPES.includes(type);
      expect(denied).toBe(CLAIM_TYPE_DECIDABILITY[type] !== 'diff_local');
    }
  });
});

// The worst-performing family in the corpus: 21 generated, 4 posted, all four wrong, mean confidence
// 0.964 -- then two P0s asserting actions/checkout v7 "does not exist" while the CI job using it was
// green. Unfixable by grounding, because the fact lives in a registry, not in the diff.
describe('external version claims', () => {
  const yml: FileDiff = {
    path: '.github/workflows/ci.yml',
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: 2,
    hunks: [{
      header: '@@ -1,2 +1,2 @@',
      lines: [
        { kind: 'add', content: '        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0', newLineNumber: 1, position: 1 },
        { kind: 'add', content: '        run: npm ci', newLineNumber: 2, position: 2 },
      ],
    }],
  };

  const versionFinding = (over: Record<string, unknown> = {}) => JSON.stringify({
    findings: [{
      title: 'Invalid GitHub Action version',
      body: "The specified version 'v7.0.0' for 'actions/checkout' does not exist. The latest major version is v4.",
      priority: 0,
      confidence_score: 1,
      claim_type: 'other',
      evidence: '        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0',
      code_location: { absolute_file_path: '.github/workflows/ci.yml', line: 1 },
      ...over,
    }],
    overall_correctness: 'patch is incorrect',
    overall_explanation: 'explanation',
  });

  // The model labels these `other`, so the denylist only sees them once the wording is recognised.
  it('relabels an other-typed version-existence claim and denies it', () => {
    const result = parseFileReviewResponse(versionFinding(), yml, {
      deniedClaimTypes: [...DEFAULT_DENIED_CLAIM_TYPES],
    });

    expect(result.comments).toHaveLength(0);
    expect(result.deniedClaimCounts.external_version_claim).toBe(1);
  });

  // Belt and braces: a full commit SHA on the cited line refutes the claim whatever it is labelled,
  // because the version beside a SHA pin is a comment the runner never reads.
  it('refutes a version claim on a SHA-pinned line even when the type is not denied', () => {
    const result = parseFileReviewResponse(versionFinding(), yml, { deniedClaimTypes: [] });

    expect(result.comments).toHaveLength(0);
    expect(result.fileSummary).toContain('[refuted:pinned-sha]');
  });

  it('leaves an ordinary finding on the same file alone', () => {
    const raw = JSON.stringify({
      findings: [{
        title: 'Install step skips the lockfile',
        body: 'This runs a plain install rather than a clean, reproducible one.',
        priority: 2,
        confidence_score: 0.7,
        claim_type: 'other',
        evidence: '        run: npm ci',
        code_location: { absolute_file_path: '.github/workflows/ci.yml', line: 2 },
      }],
      overall_correctness: 'patch is incorrect',
      overall_explanation: 'explanation',
    });

    const result = parseFileReviewResponse(raw, yml, { deniedClaimTypes: [...DEFAULT_DENIED_CLAIM_TYPES] });
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].claimType).toBe('other');
  });

  it('captures the diff context needed to re-judge the finding later', () => {
    const raw = review({
      claim_type: 'other',
      evidence: 'server.listen(timeout);',
      code_location: { absolute_file_path: 'src/app.ts', line: 2 },
    });

    const result = parseFileReviewResponse(raw, file);
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
