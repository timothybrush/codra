import { describe, expect, it } from 'vitest';
import { parseFileReviewResponse } from '@server/core/model-output';
import { DEFAULT_DENIED_CLAIM_TYPES } from '@shared/schema';
import type { FileDiff } from '@server/core/diff';

/**
 * End-to-end regression over the parse-time chain: JSON extraction, evidence grounding, the
 * claim-type denylist, label repair and fingerprinting, all in one pass over ONE realistic response.
 *
 * This replaces a 3.4 MB corpus of 100 recorded model responses. That corpus asserted aggregates
 * ("at least 20 findings surface", "at least 30 are withheld by evidence") across real data, which
 * made a regression visible but never said WHICH behaviour broke — and every individual behaviour it
 * covered is already tested precisely in model-output.spec.ts, evidence-grounding.spec.ts and
 * claim-types.spec.ts.
 *
 * What it uniquely provided was one whole response exercising every gate at once, so the gates are
 * tested in composition rather than in isolation. That is what this file keeps, at a size a human
 * can read. The response below is shaped like real output: markdown-fenced, mixed valid and invalid
 * findings, one field-perfect fabrication.
 *
 * NOTE what this deliberately does NOT claim to measure: model accuracy. Synthetic findings flatter
 * a reviewer by roughly an order of magnitude (F1 0.847 on injected mutations versus 0.066 on real
 * PRs), so nothing here is evidence about precision. Precision is measured on real reviews, via
 * `comment_feedback` and `scripts/outdated-rate.ts`.
 */

const file: FileDiff = {
  path: 'src/server/db/stats.ts',
  previousPath: null,
  isNew: false,
  isDeleted: false,
  isBinary: false,
  lineCount: 8,
  hunks: [{
    header: '@@ -10,4 +10,8 @@',
    lines: [
      { kind: 'context', content: 'export async function getStats(env: Env, tz: string) {', newLineNumber: 10, oldLineNumber: 10, position: 1 },
      { kind: 'add', content: '  const rows = await sql`SELECT * FROM jobs WHERE tz = ${tz}`;', newLineNumber: 11, position: 2 },
      { kind: 'add', content: '  try { await refresh(); } catch (e) {}', newLineNumber: 12, position: 3 },
      { kind: 'add', content: '  uses: actions/checkout@v7', newLineNumber: 13, position: 4 },
      { kind: 'add', content: '  return rows;', newLineNumber: 14, position: 5 },
      { kind: 'context', content: '}', newLineNumber: 15, oldLineNumber: 11, position: 6 },
    ],
  }],
};

/**
 * Six findings, chosen so each exits the chain by a different door. Markdown-fenced because that is
 * how the models in this chain actually answer.
 */
const response = `Here is my review.

\`\`\`json
{
  "findings": [
    {
      "evidence": "try { await refresh(); } catch (e) {}",
      "code_location": { "absolute_file_path": "src/server/db/stats.ts", "line": 12 },
      "claim_type": "swallowed_error",
      "title": "Empty catch swallows the refresh failure",
      "body": "The catch block discards the error with no log and no rethrow.",
      "priority": 2
    },
    {
      "evidence": "const rows = await sql\`SELECT * FROM jobs WHERE tz = \${tz}\`;",
      "code_location": { "absolute_file_path": "src/server/db/stats.ts", "line": 11 },
      "claim_type": "react_hook_missing_deps",
      "title": "Missing hook dependency",
      "body": "A claim type that cannot be decided from a diff hunk.",
      "priority": 2
    },
    {
      "evidence": "uses: actions/checkout@v7",
      "code_location": { "absolute_file_path": "src/server/db/stats.ts", "line": 13 },
      "claim_type": "other",
      "title": "Invalid GitHub Action version",
      "body": "actions/checkout@v7 does not exist; the latest release is v4.",
      "priority": 0
    },
    {
      "evidence": "const cached = await redis.get(cacheKey);",
      "code_location": { "absolute_file_path": "src/server/db/stats.ts", "line": 11 },
      "claim_type": "resource_leak",
      "title": "Unclosed Redis connection",
      "body": "Field-perfect, and about a line that does not exist in this diff.",
      "priority": 1
    },
    {
      "evidence": "}",
      "code_location": { "absolute_file_path": "src/server/db/stats.ts", "line": 15 },
      "claim_type": "other",
      "title": "Brace placement",
      "body": "Evidence too short to discriminate between dozens of lines.",
      "priority": 3
    },
    {
      "code_location": { "absolute_file_path": "src/server/db/stats.ts", "line": 11 },
      "claim_type": "sql_injection",
      "title": "Unparameterised timezone interpolation",
      "body": "No evidence field at all, despite the prompt demanding one in four places.",
      "priority": 0
    }
  ],
  "overall_explanation": "Several issues found.",
  "overall_correctness": "patch is incorrect",
  "overall_confidence_score": 0.9
}
\`\`\``;

describe('the parse-time chain, composed', () => {
  const parsed = parseFileReviewResponse(response, file, {
    deniedClaimTypes: DEFAULT_DENIED_CLAIM_TYPES,
  });

  it('extracts the JSON from a markdown-fenced response with surrounding prose', () => {
    expect(parsed.verdict).toBe('comment');
    expect(parsed.overallCorrectness).toBe('patch is incorrect');
  });

  /**
   * The whole point of composing them: six findings in, exactly one survives. Asserting the surviving
   * SET rather than a count means a gate that stops firing shows up as a specific new title here.
   */
  it('surfaces only the finding that is both grounded and decidable', () => {
    expect(parsed.comments.map((c) => c.title)).toEqual([
      'Empty catch swallows the refresh failure',
    ]);
  });

  it('withholds the three findings whose evidence does not resolve', () => {
    // unmatched: quoted a line that is not in the diff.
    // weak:      quoted `}`, which matches dozens of lines and proves nothing.
    // absent:    omitted the one field that can be checked.
    //
    // `matched` is 3, not 1: evidence resolution runs BEFORE the claim-type denylist, so the two
    // findings that are later denied still resolved their quotes correctly. The two gates are
    // independent, and this is what proves it.
    expect(parsed.evidenceStats).toMatchObject({ total: 6, matched: 3, unmatched: 1, weak: 1, absent: 1 });
  });

  it('denies the claim types that cannot be decided from a diff hunk', () => {
    // react_hook_missing_deps needs the enclosing component; the version claim needs the outside
    // world. Both are counted before being dropped, so the denial is measurable rather than silent.
    expect(parsed.deniedClaimCounts.react_hook_missing_deps).toBe(1);
    expect(parsed.deniedClaimCounts.external_version_claim).toBe(1);
  });

  /**
   * The version claim arrives labelled `other` — models never self-label it — so the denylist can
   * only see it if the parser relabels it first. This is the family that posted two P0s asserting a
   * SHA-pinned action "does not exist" while the CI job using it was green.
   */
  it('relabels a version-existence claim before denying it', () => {
    expect(parsed.claimTypeCounts.external_version_claim).toBe(1);
    expect(parsed.comments.some((c) => c.title.includes('Invalid GitHub Action'))).toBe(false);
  });

  /**
   * Withheld findings are appended to `fileSummary` under an "Off-diff" heading rather than being
   * dropped, each tagged with WHY. That tag is what lets the dashboard attribute a withholding to a
   * specific gate, instead of showing a review that appears to have found nothing.
   */
  it('lists every withheld finding, tagged with the gate that withheld it', () => {
    expect(parsed.fileSummary).toContain('Off-diff');
    expect(parsed.fileSummary).toMatch(/\[unverified:unmatched\]/);
    expect(parsed.fileSummary).toMatch(/\[unverified:weak\]/);
    expect(parsed.fileSummary).toMatch(/\[unverified:absent\]/);
    expect(parsed.fileSummary).toMatch(/\[claim-denied:react_hook_missing_deps\]/);
    expect(parsed.fileSummary).toMatch(/\[claim-denied:external_version_claim\]/);
  });

  it('gives the surviving finding both identities and an anchor', () => {
    const [comment] = parsed.comments;
    expect(comment.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(comment.fingerprintV2).toMatch(/^[0-9a-f]{8}$/);
    expect(comment.anchorHash).toMatch(/^[0-9a-f]{8}$/);
    // Anchored by the quote, not by the model's reported line number.
    expect(comment.line).toBe(12);
  });

  it('derives the category from the claim type instead of defaulting everything to quality', () => {
    expect(parsed.comments[0].claimType).toBe('swallowed_error');
    expect(parsed.comments[0].category).toBe('bugs');
  });

  it('is deterministic', () => {
    const again = parseFileReviewResponse(response, file, { deniedClaimTypes: DEFAULT_DENIED_CLAIM_TYPES });
    expect(again.comments).toEqual(parsed.comments);
  });
});

describe('a clean response', () => {
  // The parser must not invent findings from an empty array — the failure mode a corpus of 25
  // zero-finding samples existed to catch.
  it('produces no findings and approves', () => {
    const parsed = parseFileReviewResponse(
      '{"findings":[],"overall_explanation":"No issues.","overall_correctness":"patch is correct","overall_confidence_score":0.9}',
      file,
      { deniedClaimTypes: DEFAULT_DENIED_CLAIM_TYPES },
    );

    expect(parsed.comments).toEqual([]);
    // No "Off-diff" section, because nothing was withheld either.
    expect(parsed.fileSummary).not.toContain('Off-diff');
    expect(parsed.verdict).toBe('approve');
    expect(parsed.evidenceStats.total).toBe(0);
  });
});
