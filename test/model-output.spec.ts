import { parseFileReviewResponse, dedupeFindings } from '@server/core/model-output';
import type { FileDiff } from '@server/core/diff';
import type { ParsedReviewComment } from '@shared/schema';

describe('Model Output Parsing Deep Dive', () => {
  const mockFile: FileDiff = {
    path: 'test.ts',
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: 10,
    hunks: [
      {
        header: '@@ -1,5 +1,5 @@',
        lines: [
          { kind: 'context', content: 'older', newLineNumber: 1, position: 1 },
          { kind: 'add', content: 'new line', newLineNumber: 2, position: 2 },
          { kind: 'context', content: 'older', newLineNumber: 3, position: 3 },
        ],
      },
    ],
  };

  it('extracts JSON from markdown code blocks with surrounding text', () => {
    const rawOutput = `
Here is my review:
\`\`\`json
{
  "findings": [{
    "title": "Good code",
    "body": "This looks fine.",
    "priority": 2,
    "code_location": { "absolute_file_path": "test.ts", "line": 2 }
  }],
  "overall_correctness": "patch is correct",
  "overall_explanation": "All good"
}
\`\`\`
Hope this helps!`;

    const result = parseFileReviewResponse(rawOutput, mockFile);
    expect(result.comments).toHaveLength(1);
    expect(result.verdict).toBe('comment'); // Since it has comments, verdict becomes 'comment'
  });

  it('salvages malformed JSON with unescaped newlines using jsonrepair', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "Multiline
Issue",
    "body": "This has
unescaped newlines",
    "priority": 1,
    "code_location": { "absolute_file_path": "test.ts", "line": 2 }
  }],
  "overall_correctness": "issues found",
  "overall_explanation": "explanation"
}`;

    const result = parseFileReviewResponse(rawOutput, mockFile);
    // our cleanText flattens newlines in titles to spaces
    expect(result.comments[0].title).toBe('Multiline Issue');
  });

  it('handles truncated JSON gracefully (salvage success)', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "Truncated",
    "body": "This cuts off",
    "priority": 1,
    "code_location": { "absolute_file_path": "test.ts", "line": 2 }
`; 
    const result = parseFileReviewResponse(rawOutput, mockFile);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].title).toBe('Truncated');
  });

  it('removes conversational tags and emojis from titles and bodies', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "🚀 [PERFORMANCE] Optimization needed",
    "body": "⚠️ HIGH: You should optimize this.",
    "priority": 0,
    "code_location": { "absolute_file_path": "test.ts", "line": 2 }
  }],
  "overall_correctness": "issues found",
  "overall_explanation": "explanation"
}`;

    const result = parseFileReviewResponse(rawOutput, mockFile);
    expect(result.comments[0].title).toBe('Optimization needed');
  });

  it('maps priorities correctly to P-levels', () => {
    const rawOutput = `
{
  "findings": [
    {
      "title": "P0 Issue",
      "body": "Critical",
      "priority": 0,
      "code_location": { "absolute_file_path": "test.ts", "line": 2 }
    },
    {
      "title": "P3 Issue",
      "body": "Minor",
      "priority": 3,
      "code_location": { "absolute_file_path": "test.ts", "line": 2 }
    }
  ],
  "overall_correctness": "issues found",
  "overall_explanation": "explanation"
}`;

    const result = parseFileReviewResponse(rawOutput, mockFile);
    expect(result.comments[0].severity).toBe('P0');
    expect(result.comments[1].severity).toBe('P3');
  });

  it('handles findings targeting lines outside the diff by finding the closest line', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "Off-target",
    "body": "Targeting line 10",
    "priority": 2,
    "code_location": { "absolute_file_path": "test.ts", "line": 8 }
  }],
  "overall_correctness": "issues found",
  "overall_explanation": "explanation"
}`;

    const result = parseFileReviewResponse(rawOutput, mockFile);
    // Closest valid line to 8 in our mockFile (available are 1, 2, 3) is 3
    expect(result.comments[0].line).toBe(3);
  });

  it('does not treat reviewed source snippets as review JSON', () => {
    const rawOutput = `
\`\`\`ts
export function nextOwner(owner: string) {
  return owner.toUpperCase();
}
\`\`\``;

    expect(() => parseFileReviewResponse(rawOutput, mockFile)).toThrow('Could not find JSON root');
  });

  it('drops placeholder schema findings instead of failing validation', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "<Plain title>",
    "body": "<Technical explanation>",
    "priority": "<0|1|2|3>",
    "code_location": {
      "absolute_file_path": "test.ts",
      "line": "<int>",
      "line_range": { "start": "<int>", "end": "<int>" }
    }
  }],
  "overall_correctness": "patch is correct",
  "overall_explanation": "No concrete findings",
  "overall_confidence_score": 0.5
}`;

    const result = parseFileReviewResponse(rawOutput, mockFile);
    expect(result.comments).toHaveLength(0);
    expect(result.verdict).toBe('approve');
  });

  it('carries per-finding confidence_score through to the parsed comment', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "Real bug",
    "body": "Concrete issue",
    "priority": 1,
    "confidence_score": 0.92,
    "code_location": { "absolute_file_path": "test.ts", "line": 2 }
  }],
  "overall_correctness": "issues found",
  "overall_explanation": "explanation"
}`;

    const result = parseFileReviewResponse(rawOutput, mockFile);
    expect(result.comments[0].confidenceScore).toBeCloseTo(0.92);
  });

  it('defaults a finding with no priority to P3 (low), not P2', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "Unranked finding",
    "body": "Model did not set a priority",
    "code_location": { "absolute_file_path": "test.ts", "line": 2 }
  }],
  "overall_correctness": "issues found",
  "overall_explanation": "explanation"
}`;

    const result = parseFileReviewResponse(rawOutput, mockFile);
    expect(result.comments[0].severity).toBe('P3');
  });
});

describe('dedupeFindings', () => {
  const make = (over: Partial<ParsedReviewComment>): ParsedReviewComment => ({
    path: 'a.ts',
    line: 1,
    position: 1,
    severity: 'P2',
    category: 'quality',
    title: 'Use of any',
    body: 'body',
    ...over,
  });

  it('collapses same-titled findings across files, keeping the strongest', () => {
    const input = [
      make({ path: 'a.ts', severity: 'P3', confidenceScore: 0.4 }),
      make({ path: 'b.ts', severity: 'P1', confidenceScore: 0.5 }),
      make({ path: 'c.ts', severity: 'P3', confidenceScore: 0.9 }),
    ];
    const result = dedupeFindings(input);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('P1');
    expect(result[0].path).toBe('b.ts');
  });

  it('prefers higher confidence when severities tie', () => {
    const input = [
      make({ title: 'Null deref', severity: 'P2', confidenceScore: 0.3 }),
      make({ title: 'Null deref', severity: 'P2', confidenceScore: 0.8 }),
    ];
    const result = dedupeFindings(input);
    expect(result).toHaveLength(1);
    expect(result[0].confidenceScore).toBeCloseTo(0.8);
  });

  it('keeps findings with genuinely different titles', () => {
    const input = [make({ title: 'Bug A' }), make({ title: 'Bug B' })];
    expect(dedupeFindings(input)).toHaveLength(2);
  });
});
