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
};

export const verifyResultSchema = z.object({
  results: z
    .array(
      z.object({
        index: z.number().int(),
        verdict: z.enum(['keep', 'drop']),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .default([]),
});

export type VerifyResult = z.infer<typeof verifyResultSchema>['results'][number];

export const VERIFY_SYSTEM_PROMPT = `You are a meticulous senior engineer validating candidate code-review findings against the actual diff.
Another reviewer produced these findings from the diff alone (without seeing the whole file/repo), so many are false positives — speculative, stylistic, or based on code that is simply not visible in the diff.

For EACH finding decide:
- "keep": the finding describes a real, correct defect that is clearly supported by the diff shown.
- "drop": the finding is a false positive, speculative, a subjective style preference, or depends on code not present in the diff (e.g. claims a symbol is undefined/unimported/missing when that cannot be confirmed from the diff).

Be strict: when in doubt, "drop". It is better to drop a borderline finding than to keep a wrong one.

Output MUST be valid JSON, exactly one object, no prose before or after:
{
  "results": [
    { "index": <number>, "verdict": "keep" | "drop", "confidence": <float 0.0-1.0> }
  ]
}
Include one result object for every finding index provided.`;

export function buildVerifyPrompt(candidates: VerifyCandidate[]): string {
  const blocks = candidates.map((c) => {
    const location = c.line != null ? `${c.path}:${c.line}` : c.path;
    return [
      `### Finding index ${c.index}`,
      `Location: ${location}`,
      `Title: ${c.title}`,
      `Claim: ${c.body}`,
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

/**
 * Renders a small window of the diff around a finding's line so the verifier can judge it in
 * context without re-sending the whole file. Falls back to the first hunk when the exact line
 * can't be located (line numbers from the model are occasionally approximate).
 */
export function renderDiffSnippet(file: FileDiff | undefined, line: number | undefined, radius = 6): string {
  if (!file) return '';
  const flat = file.hunks.flatMap((hunk) => hunk.lines);
  if (flat.length === 0) return '';

  let anchor = -1;
  if (line != null) {
    anchor = flat.findIndex((l) => l.newLineNumber === line || l.oldLineNumber === line);
  }
  if (anchor === -1) anchor = 0;

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
