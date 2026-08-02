import type { RepoConfig } from '@shared/schema';
import type { FileDiff } from '@server/core/diff';
import type { ModelResponseSchema } from '@server/models/types';
import { getLanguageForFile } from './languages';

/**
 * Grammar for the file-review response, for providers that support constrained decoding.
 *
 * This lives next to the prose schema blocks below on purpose: the same contract is stated three
 * times (system prompt, user prompt, this grammar) and they must agree. `maxItems` is derived from
 * the repo's `max_comments` rather than hardcoded -- a fixed cap here silently overrides a repo
 * configured for more findings, with no error anywhere.
 */
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
          maxItems: Math.max(1, maxComments),
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'body', 'priority', 'confidence_score', 'evidence', 'code_location'],
            properties: {
              title: { type: 'string', maxLength: 100 },
              body: { type: 'string' },
              confidence_score: { type: 'number', minimum: 0, maximum: 1 },
              priority: { type: 'integer', minimum: 0, maximum: 4 },
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

export const fileReviewSystemPromptBase = `You are a world-class software engineer performing a precise, high-signal code review.
Your goal is to find REAL defects — bugs, security vulnerabilities, and performance problems — introduced by the diff. Accuracy matters far more than the number of findings.

### CONTEXT LIMITS (read carefully — this prevents false positives):
- You can see ONLY the diff below, not the whole file or the rest of the repository.
- Do NOT report that a symbol is undefined, unimported, unused, missing, or never-called merely because its declaration or usage is not visible in the diff. Imports, types, and definitions frequently live in unchanged parts of the file. Flag such an issue ONLY if the diff itself clearly introduces it.
- Do NOT assume how code elsewhere behaves. If confirming an issue requires code you cannot see, do not report it.

### PRECISION MANDATE:
- Report a finding only if a senior engineer, looking at this exact diff, would confidently agree it is a genuine defect.
- Prefer returning an empty findings array over speculative, stylistic, or "might be" findings.
- Do NOT report subjective preferences (naming, formatting, "cleaner" alternatives, "consider using X") unless they cause a concrete bug, security hole, or measurable performance problem.
- Every finding MUST include a calibrated "confidence_score" (0.0–1.0). Use < 0.6 for anything you are not sure is a real problem, and reserve > 0.85 for defects you are certain about.

### EVIDENCE (mandatory — a finding without it cannot be posted):
- Every finding MUST include "evidence": the single line of code the finding is about, copied VERBATIM from the diff below.
- Copy the code exactly as it appears. Do NOT include the two line-number columns or the +/- marker, do NOT paraphrase, reformat, shorten, or invent code.
- If you cannot quote a specific line from the diff that exhibits the problem, you do not have a finding. Omit it.

### OUTPUT RULES:
1. Output MUST be valid JSON — EXACTLY ONE object matching the schema below.
2. DO NOT output any conversational text, source code, or diff hunks before or after the JSON.
3. Prioritize by severity: 0 = P0 critical, 1 = P1 high, 2 = P2 medium, 3 = P3 low, 4 = nit (cosmetic/trivial). Set priority honestly; do not inflate. Use 4 for anything a reviewer would prefix with "nit:".
4. Return at most {{MAX_COMMENTS}} findings, most severe first. Keep each body under 160 words.
5. If there are no material issues, return an empty findings array and a short explanation.

### SCHEMA FORMAT:
{
  "findings": [
    {
      "title": "<Plain title, NO tags/emoji>",
      "body": "<Explanation of the concrete defect and its impact>",
      "priority": 0 | 1 | 2 | 3 | 4,
      "confidence_score": number (0 to 1),
      "evidence": "<the exact line of code from the diff this finding is about>",
      "code_location": {
        "line": number,
        "line_range": { "start": number, "end": number }
      },
      "code_suggestion": "Optional replacement code"
    }
  ],
  "overall_explanation": "Summary",
  "overall_correctness": "patch is correct" | "patch is incorrect",
  "overall_confidence_score": number (0 to 1)
}

Identify security risks such as XSS, SQLi, CSRF, insecure randomness, and data leaks that the diff actually introduces.`;

export function buildFileReviewSystemPrompt(config: RepoConfig['review'], languagePersona?: string) {
  const persona = languagePersona ? ` as ${languagePersona}` : '';
  const prompt = fileReviewSystemPromptBase.replace('{{MAX_COMMENTS}}', config.max_comments.toString());
  return `You are a world-class professional senior code reviewer${persona}. ${prompt}`;
}

export function buildFileReviewPrompts(input: {
  file: FileDiff;
  prTitle: string | null;
  prDescription: string | null;
  config: RepoConfig['review'];
}) {
  const languageInfo = getLanguageForFile(input.file.path);
  const rules = input.config.custom_rules.length > 0 ? input.config.custom_rules.map((rule) => `- ${rule}`).join('\n') : '- None';
  const systemPrompt = buildFileReviewSystemPrompt(input.config, languageInfo?.persona);
  const languageGuidelines = languageInfo
    ? `Language: ${languageInfo.language}\nSpecific Guidelines (flag only when they cause a real defect):\n${languageInfo.guidelines.map(g => `- ${g}`).join('\n')}`
    : 'Language: Generic\nSpecific Guidelines: Follow general best practices.';

  const prDescription = input.prDescription?.trim();
  const prContext = prDescription
    ? `PR description (author intent — use to judge whether a change is deliberate):\n${prDescription.slice(0, 500)}${prDescription.length > 500 ? '…' : ''}`
    : null;

  const userPrompt = [
    `PR title: ${input.prTitle ?? 'Untitled PR'}`,
    ...(prContext ? [prContext] : []),
    `File path: ${input.file.path}`,
    languageGuidelines,
    `Custom rules:\n${rules}`,
    'Review ONLY the diff shown below. You cannot see the rest of the file or repository — do not report something as undefined, unimported, unused, or missing just because it is not in the diff. If the diff note says it was truncated, do not infer issues from omitted lines.',
    // Each diff line is printed as "<old> <new> <+/-/ >content". `line` is posted
    // straight to GitHub as a comment anchor, so it must be the NEW-file number and
    // must exist in the diff, otherwise GitHub rejects the whole review.
    'Line numbers: every diff line below is prefixed with two columns — the OLD file line number, then the NEW file line number. Always report `line` (and `line_range`) using the NEW (second, right-hand) number, and only ever cite a line that appears in the diff. For a removed line, cite the nearest NEW line number shown next to it.',
    // The evidence string is matched against the diff verbatim (whitespace-insensitive) before the
    // finding is allowed to post, so it must be the code only -- the gutter columns and the +/-
    // marker are rendering, not source.
    'Evidence: every finding must carry an `evidence` string containing the exact code of the line it is about, copied character-for-character from the diff below. Strip the two leading line-number columns and the +/-/space marker — quote only the code itself. A finding whose evidence does not appear in the diff will be discarded.',
    'Prioritize correctness, security, and production-impacting bugs. Prefer no finding over a speculative one, and avoid subjective style feedback.',
    '',
    `## Output JSON Schema (STRICTLY REQUIRED)`,
    `{
  "findings": [
    {
      "title": "<Plain title>",
      "body": "<Technical explanation>",
      "priority": <0|1|2|3|4>,
      "confidence_score": <float 0.0-1.0>,
      "evidence": "<exact line of code copied verbatim from the diff below, without the line-number columns or +/- marker>",
      "code_location": {
        "absolute_file_path": "${input.file.path}",
        "line": <int>,
        "line_range": {"start": <int>, "end": <int>}
      },
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
