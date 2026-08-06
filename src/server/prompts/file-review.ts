import { claimTypes, type RepoConfig } from '@shared/schema';
import type { FileDiff } from '@server/core/diff';
import type { ModelResponseSchema } from '@server/models/types';
import { getLanguageForFile } from './languages';

// Generator cap, NOT the posted cap: per CHUNK, upstream of four remove-only filters, where
// `max_comments` is once per job. Equal values throttle the generator to the unfiltered survivors.
export function generatorFindingCap(maxComments: number): number {
  return Math.max(1, maxComments * 2);
}

// Response grammar for constrained decoding. Same contract as the system and user prompts; all three
// must agree.
export function buildReviewResponseSchema(maxComments: number): ModelResponseSchema {
  return {
    name: 'codra_file_review',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['findings', 'overall_explanation', 'overall_correctness', 'overall_confidence_score'],
      properties: {
        findings: {
          type: 'array',
          maxItems: generatorFindingCap(maxComments),
          items: {
            type: 'object',
            additionalProperties: false,
            // FIELD ORDER IS LOAD-BEARING under constrained decoding, which is why this is not
            // most-important-first. `evidence` is the one CHECKABLE field, so quoting a real line
            // before any prose is what separates grounding a claim from rationalising one. It used to
            // sit fifth, after the model had committed to a severity. `verify.ts` does the same with
            // `reason` before `verdict`.
            //
            // `confidence_score` is GONE, not reordered: self-reported confidence is inversely
            // correlated with correctness here. It stays optional in the schema, defaulting to 0, so
            // `min_confidence` still works for an operator who sets it deliberately.
            required: ['evidence', 'code_location', 'claim_type', 'title', 'body', 'priority'],
            // `properties` order must match `required` above: several providers drive generation order
            // from the property declaration order rather than from `required`, so a mismatch would defeat
            // the reordering on exactly the provider that enforces the grammar.
            properties: {
              evidence: { type: 'string' },
              code_location: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  absolute_file_path: { type: 'string' },
                  line: { type: 'integer', minimum: 1 },
                  line_range: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['start', 'end'],
                    properties: {
                      start: { type: 'integer', minimum: 1 },
                      end: { type: 'integer', minimum: 1 },
                    },
                  },
                },
                anyOf: [
                  { required: ['line'] },
                  { required: ['line_range'] },
                ],
              },
              claim_type: { type: 'string', enum: [...claimTypes] },
              title: { type: 'string', maxLength: 100 },
              body: { type: 'string' },
              priority: { type: 'integer', minimum: 0, maximum: 4 },
              code_suggestion: { type: 'string' },
            },
          },
        },
        overall_explanation: { type: 'string' },
        overall_correctness: { type: 'string', enum: ['patch is correct', 'patch is incorrect'] },
        overall_confidence_score: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
  };
}

// The generator prompt. Restraint duplicating a downstream gate is deliberately absent: behind four
// remove-only filters, asking the model to "prefer returning an empty findings array" produced 0.039
// findings per file and no true positives. The bar is investigation, not certainty. What remains
// encodes what no gate can check: context bounds, the evidence mandate, claim-type honesty.
export function buildFileReviewSystemPromptBase(): string {
  return `You are a world-class software engineer performing a precise, high-signal code review.
Your goal is to find REAL defects (bugs, security vulnerabilities, and performance problems) introduced by the diff. Every finding must be grounded in a line you can quote from the diff.

### CONTEXT EXTENDS (read carefully, this prevents false positives):
- You can see ONLY the diff below, not the whole file or the rest of the repository.
- Do NOT report that a symbol is undefined, unimported, unused, missing, or never-called merely because its declaration or usage is not visible in the diff. Imports, types, and definitions frequently live in unchanged parts of the file. Flag such an issue ONLY if the diff itself clearly introduces it.
- Do NOT assume how code elsewhere behaves. If confirming an issue requires code you cannot see, do not report it.

### WHAT TO REPORT:
- Report anything a senior engineer reviewing this diff would want to investigate: a bug, a security hole, a performance problem, a resource leak, an unhandled failure, a broken invariant.
- You do not need to be certain. A finding you can ground in a quoted line is worth raising; every finding is independently checked against the diff afterwards, and a wrong one is discarded at no cost to you. A defect you decline to mention is simply lost.
- Do NOT report subjective preferences (naming, formatting, "cleaner" alternatives, "consider using X") unless they cause a concrete bug, security hole, or measurable performance problem. These are discarded and crowd out real defects.

### EVIDENCE (mandatory, a finding without it cannot be posted):
- Every finding MUST include "evidence": the single line of code the finding is about, copied VERBATIM from the diff below.
- Copy the code exactly as it appears. Do NOT include the two line-number columns or the +/- marker, do NOT paraphrase, reformat, shorten, or invent code.
- If you cannot quote a specific line from the diff that exhibits the problem, you do not have a finding. Omit it.

### CLAIM TYPE (required, pick the one that fits, or "other"):
${claimTypes.join(', ')}
- This is a label for the KIND of defect. It does not license the claim: only report a type if the
  diff actually shows it. Picking a type the code cannot exhibit makes the finding easy to discard.
- If nothing fits, use "other". Do not stretch a label to fit.
- NEVER claim that a package, action, tag or version "does not exist", or that a config key is invalid. You cannot know what was released after your training data, and a step pinned to a commit SHA resolves by that SHA regardless of the version written beside it. Such claims are discarded.
- Label honestly. The type you choose does not affect whether a finding is accepted; an inaccurate label only makes a real defect harder to act on.

### OUTPUT RULES:
1. Output MUST be valid JSON, EXACTLY ONE object matching the schema below.
2. DO NOT output any conversational text, source code, or diff hunks before or after the JSON.
3. Prioritize by severity: 0 = P0 critical, 1 = P1 high, 2 = P2 medium, 3 = P3 low, 4 = nit (cosmetic/trivial). Set priority honestly; do not inflate. Use 4 for anything a reviewer would prefix with "nit:".
4. Return at most {{MAX_COMMENTS}} findings, most severe first. Keep each body under 160 words.
5. If the diff genuinely introduces no defect, return an empty findings array and a short explanation. Do not pad, and do not withhold.

### SCHEMA FORMAT:
{
  "findings": [
    {
      "evidence": "<the exact line of code from the diff this finding is about>",
      "code_location": {
        "line": number,
        "line_range": { "start": number, "end": number }
      },
      "claim_type": "<one of the claim types listed above>",
      "title": "<Plain title, NO tags/emoji>",
      "body": "<Explanation of the concrete defect and its impact>",
      "priority": 0 | 1 | 2 | 3 | 4,
      "code_suggestion": "Optional replacement code"
    }
  ],
  "overall_explanation": "Summary",
  "overall_correctness": "patch is correct" | "patch is incorrect",
  "overall_confidence_score": number (0 to 1)
}

Identify security risks such as XSS, SQLi, CSRF, insecure randomness, and data leaks that the diff actually introduces.`;
}

// Named export because several tests assert against the prompt text directly.
export const fileReviewSystemPromptBase = buildFileReviewSystemPromptBase();

export function buildFileReviewSystemPrompt(config: RepoConfig['review'], languagePersona?: string) {
  const persona = languagePersona ? ` as ${languagePersona}` : '';
  // Prose cap must be the generator cap: otherwise the grammar allows 2N while the text asks for N,
  // and the model obeys the text.
  const prompt = buildFileReviewSystemPromptBase()
    .replace('{{MAX_COMMENTS}}', generatorFindingCap(config.max_comments).toString());
  return `You are a world-class professional senior code reviewer${persona}. ${prompt}`;
}

// Human-rejected findings as NEGATIVE few-shot exemplars. Retrieval is the strongest measured lever
// at this model size: RAG at 20 shots took F1 36.35 -> 74.05, and gains grow as the model shrinks.
// Rejections only, since `marked_right` is rare and an absent label means nothing.
export type RejectedExemplar = { title: string; claimType?: string | null };

// Hard cap: every character competes with the diff for a 16k-input-tokens/minute bucket, and a prompt
// that no longer fits beats one with no exemplars.
const EXEMPLAR_BLOCK_CHARS = 700;

function renderExemplars(exemplars: readonly RejectedExemplar[] | undefined): string | null {
  if (!exemplars?.length) return null;

  const lines: string[] = [];
  let used = 0;
  for (const exemplar of exemplars) {
    const line = `- ${exemplar.title}${exemplar.claimType ? ` (${exemplar.claimType})` : ''}`;
    if (used + line.length > EXEMPLAR_BLOCK_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return null;

  const heading = 'Findings a reviewer on THIS repository has already rejected. Do not report things like these:';
  return [heading, ...lines].join('\n');
}

export function buildFileReviewPrompts(input: {
  file: FileDiff;
  prTitle: string | null;
  prDescription: string | null;
  config: RepoConfig['review'];
  rejectedExemplars?: readonly RejectedExemplar[];
}) {
  const languageInfo = getLanguageForFile(input.file.path);
  const rules = input.config.custom_rules.length > 0 ? input.config.custom_rules.map((rule) => `- ${rule}`).join('\n') : '- None';
  const systemPrompt = buildFileReviewSystemPrompt(input.config, languageInfo?.persona);
  const guidelineHeader = 'Specific Guidelines (check the diff against each of these)';
  const languageGuidelines = languageInfo
    ? `Language: ${languageInfo.language}\n${guidelineHeader}:\n${languageInfo.guidelines.map(g => `- ${g}`).join('\n')}`
    : 'Language: Generic\nSpecific Guidelines: Follow general best practices.';

  // The PR description is the highest-value context by a wide margin. ContextCRBench: diff-only F1
  // 36.08, +description 62.12 (+72%), +enclosing FUNCTION only 42.56 for far more tokens. Author intent
  // beats more code per token, and 500 chars truncates mid-sentence on any real body. The linked issue
  // is deliberately not fetched: the description alone is ~96% of the benefit.
  const prDescription = input.prDescription?.trim();
  const PR_DESCRIPTION_CHARS = 2_000;
  const prContext = prDescription
    ? `PR description (author intent - use to judge whether a change is deliberate):\n${prDescription.slice(0, PR_DESCRIPTION_CHARS)}${prDescription.length > PR_DESCRIPTION_CHARS ? '…' : ''}`
    : null;

  const exemplars = renderExemplars(input.rejectedExemplars);

  const userPrompt = [
    `PR title: ${input.prTitle ?? 'Untitled PR'}`,
    ...(prContext ? [prContext] : []),
    ...(exemplars ? [exemplars] : []),
    `File path: ${input.file.path}`,
    languageGuidelines,
    `Custom rules:\n${rules}`,
    'Review ONLY the diff shown below. You cannot see the rest of the file or repository - do not report something as undefined, unimported, unused, or missing just because it is not in the diff. If the diff note says it was truncated, do not infer issues from omitted lines.',
    // Lines print as "<old> <new> <+/-/ >content". `line` is posted to GitHub as the anchor, so it must
    // be the NEW-file number and must exist in the diff, or GitHub rejects the whole review.
    'Line numbers: every diff line below is prefixed with two columns - the OLD file line number, then the NEW file line number. Always report `line` (and `line_range`) using the NEW (second, right-hand) number, and only ever cite a line that appears in the diff. For a removed line, cite the nearest NEW line number shown next to it.',
    // Evidence is matched verbatim (whitespace-insensitive) before posting, so it must be code only:
    // gutter columns and the +/- marker are rendering, not source.
    'Evidence: every finding must carry an `evidence` string containing the exact code of the line it is about, copied character-for-character from the diff below. Strip the two leading line-number columns and the +/-/space marker - quote only the code itself. A finding whose evidence does not appear in the diff will be discarded.',
    'Prioritize correctness, security, and production-impacting bugs. Raise anything you can ground in a quoted line; avoid subjective style feedback.',
    '',
    `## Output JSON Schema (STRICTLY REQUIRED)`,
    `{
  "findings": [
    {
      "evidence": "<exact line of code copied verbatim from the diff below, without the line-number columns or +/- marker>",
      "code_location": {
        "absolute_file_path": "${input.file.path}",
        "line": <int>,
        "line_range": {"start": <int>, "end": <int>}
      },
      "claim_type": "<${claimTypes.join(' | ')}>",
      "title": "<Plain title>",
      "body": "<Technical explanation>",
      "priority": <0|1|2|3|4>,
      "code_suggestion": "string"
    }
  ],
  "overall_correctness": "patch is correct" | "patch is incorrect",
  "overall_explanation": "Summary",
  "overall_confidence_score": <float 0.0-1.0>
}`,
    '',
    'Unified diff:',
    renderFileDiff(input.file),
  ].join('\n');

  return { systemPrompt, userPrompt };
}

function renderFileDiff(file: FileDiff) {
  const lines = [`diff --git a/${file.previousPath ?? file.path} b/${file.path}`];
  for (const hunk of file.hunks) {
    lines.push(hunk.header);
    for (const line of hunk.lines) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      const left = line.oldLineNumber ?? '';
      const right = line.newLineNumber ?? '';
      lines.push(`${String(left).padStart(4, ' ')} ${String(right).padStart(4, ' ')} ${prefix}${line.content}`);
    }
  }

  if (file.isTruncated) {
    lines.push('');
    lines.push(`[NOTE: This diff has been truncated from ${file.originalLineCount} lines to ${file.lineCount} lines for brevity.]`);
  }

  return lines.join('\n');
}
