import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import type { FileDiff } from '@server/core/diff';

export type VerifyCandidate = {
  index: number;
  path: string;
  line: number | null;
  title: string;
  body: string;
  snippet: string;
  evidence?: string | null;
};

const verifyResultSchema = z.object({
  results: z
    .array(
      z.object({
        index: z.number().int(),
        // `.optional()` and NOT `.default()`: a default would materialize the key on every parsed result, changing the shape callers compare against.
        reason: z.string().optional(),
        verdict: z.enum(['keep', 'drop']),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .default([]),
});

export type VerifyResult = z.infer<typeof verifyResultSchema>['results'][number];

// Field order matters for providers that decode against the schema: `reason` precedes `verdict` so the model commits to a justification BEFORE the decision token.
export const VERIFY_RESPONSE_SCHEMA = {
  name: 'codra_verify_findings',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'reason', 'verdict'],
          properties: {
            index: { type: 'integer', minimum: 0 },
            reason: { type: 'string', maxLength: 200 },
            verdict: { type: 'string', enum: ['keep', 'drop'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
  },
} as const;

export const VERIFY_SYSTEM_PROMPT = `You are a meticulous senior engineer checking whether each candidate code-review finding is actually supported by the code it points at.

For EACH finding you are given the claim and the diff context it was anchored to. Decide:
- "keep": the quoted/anchored code genuinely exhibits the problem the claim describes.
- "drop": the claim is not supported by the code shown - it describes something that isn't there, it is speculative, it is a subjective style preference, or confirming it would require code that is not visible.

Judge the CLAIM against the CODE. Do not defer to the claim's confidence or phrasing; a well-written claim about code that doesn't do what it says is still a drop.
Be strict: when in doubt, "drop". It is better to drop a borderline finding than to keep a wrong one.

Give a "reason" of at most 15 words BEFORE the verdict, then the verdict.

Output MUST be valid JSON, exactly one object, no prose before or after:
{
  "results": [
    { "index": <number>, "reason": "<max 15 words>", "verdict": "keep" | "drop", "confidence": <float 0.0-1.0> }
  ]
}
Include exactly one result object for every finding index provided, and use the same index numbers you were given.`;

export function buildVerifyPrompt(candidates: VerifyCandidate[]): string {
  const blocks = candidates.map((c) => {
    const location = c.line != null ? `${c.path}:${c.line}` : c.path;
    return [
      `### Finding index ${c.index}`,
      `Location: ${location}`,
      `Title: ${c.title}`,
      `Claim: ${c.body}`,
      ...(c.evidence ? [`Code the claim cites: ${c.evidence}`] : []),
      'Relevant diff:',
      c.snippet || '(no diff context available for this location)',
    ].join('\n');
  });

  return [
    'Validate each finding below against its diff context. Return a verdict for every index.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

// Renders a window of the diff around a finding's line so the verifier can judge it in context without re-sending the whole file.
// Returns '' when the line can't be located, rather than falling back to `anchor = 0`: that used to make the verifier silently judge unrelated code, masquerading an infrastructure miss as a real verdict.
export function renderDiffSnippet(file: FileDiff | undefined, line: number | undefined, radius = 12): string {
  if (!file) return '';
  const flat = file.hunks.flatMap((hunk) => hunk.lines);
  if (flat.length === 0) return '';

  if (line == null) return '';

  // NEW-file numbers first, in a separate pass: a combined findIndex on `newLineNumber === line || oldLineNumber === line` can match an earlier OLD-numbered context line in a deletion-heavy file, landing the window N-deletions away from the real finding. Old-number pass is kept only as a fallback for removed code.
  const byNewLine = flat.findIndex((l) => l.newLineNumber === line);
  const anchor = byNewLine !== -1 ? byNewLine : flat.findIndex((l) => l.oldLineNumber === line);
  if (anchor === -1) return '';

  const start = Math.max(0, anchor - radius);
  const end = Math.min(flat.length, anchor + radius + 1);

  return flat
    .slice(start, end)
    .map((l) => {
      const prefix = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
      const gutter = String(l.newLineNumber ?? l.oldLineNumber ?? '').padStart(4, ' ');
      return `${gutter} ${prefix}${l.content}`;
    })
    .join('\n');
}

export function parseVerifyResponse(raw: string): VerifyResult[] {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const candidate = start !== -1 && end !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed;

  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    json = JSON.parse(jsonrepair(candidate));
  }

  return verifyResultSchema.parse(json).results;
}
