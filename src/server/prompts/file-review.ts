import { claimTypes, type RepoConfig } from '@shared/schema';
import type { FileDiff } from '@server/core/diff';
import type { ModelResponseSchema } from '@server/models/types';
import { getLanguageForFile } from './languages';

// Generator cap, NOT the posted cap: per CHUNK, upstream of four remove-only filters, where `max_comments` is once per job.
export function generatorFindingCap(maxComments: number): number {
  return Math.max(1, maxComments * 2);
}

// Shared by the single-file and batched grammars, so the field-order invariant is stated once.
function findingItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    // Field order is load-bearing under constrained decoding: `evidence` first forces a real quote before any prose.
    required: ['evidence', 'code_location', 'claim_type', 'title', 'body', 'priority'],
    // `properties` order must match `required`: generation follows declaration order, so gemini-schema.ts must never sort or rebuild this.
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
        // Branch order matters: gemini-schema.ts collapses this to the first branch.
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
  };
}

// Response grammar for constrained decoding; same contract as the system and user prompts, all three must agree.
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
          items: findingItemSchema(),
        },
        overall_explanation: { type: 'string' },
        overall_correctness: { type: 'string', enum: ['patch is correct', 'patch is incorrect'] },
        overall_confidence_score: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
  };
}

// Batched grammar: `absolute_file_path` is required here even though its per-finding twin is optional; no `minItems` on `files` (uneven provider support) so the count is checked at parse time.
export function buildBatchReviewResponseSchema(maxComments: number, fileCount: number): ModelResponseSchema {
  return {
    name: 'codra_batch_review',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['files', 'overall_confidence_score'],
      properties: {
        files: {
          type: 'array',
          maxItems: fileCount,
          items: {
            type: 'object',
            additionalProperties: false,
            // Path first, like `evidence` in a finding: commit to the file before describing it.
            required: ['absolute_file_path', 'findings', 'overall_explanation', 'overall_correctness'],
            properties: {
              absolute_file_path: { type: 'string' },
              // Deliberately unbounded, unlike the single-file grammar: `maxItems` on an array nested
              // inside another bounded array made Gemini reject the whole schema with "produces a
              // constraint that has too many states for serving", losing constrained decoding for the
              // bin. The cap is stated in prose ("per file") and enforced at parse time by the
              // over-cap truncation, so nothing but the FSM size changes.
              findings: { type: 'array', items: findingItemSchema() },
              overall_explanation: { type: 'string' },
              overall_correctness: { type: 'string', enum: ['patch is correct', 'patch is incorrect'] },
            },
          },
        },
        overall_confidence_score: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
  };
}

const SINGLE_FILE_SCHEMA_FORMAT = `{
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
}`;

// A finding belongs to whichever entry encloses it; the per-finding `absolute_file_path` is only a cross-check.
const MULTI_FILE_SCHEMA_FORMAT = `{
  "files": [
    {
      "absolute_file_path": "<exact path of one of the files listed below, copied character-for-character>",
      "findings": [
        {
          "evidence": "<the exact line of code from THIS file's diff this finding is about>",
          "code_location": {
            "absolute_file_path": "<the same path as above>",
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
      "overall_explanation": "Summary for THIS file",
      "overall_correctness": "patch is correct" | "patch is incorrect"
    }
  ],
  "overall_confidence_score": number (0 to 1)
}`;

// No restraint language: behind four remove-only filters, asking for empty findings arrays measured 0.039 findings/file and no true positives. Wording is snapshot-locked.
export function buildFileReviewSystemPromptBase(opts?: { multiFile?: boolean }): string {
  const multi = opts?.multiFile === true;

  const contextScope = multi
    ? `- You can see ONLY the diffs below, not the whole files or the rest of the repository.
- Each file below is INDEPENDENT. A finding about one file must be grounded in a line from THAT file's diff, and must be reported inside that file's entry. Never carry a claim from one file to another, and never assume two files interact unless both diffs show it.`
    : '- You can see ONLY the diff below, not the whole file or the rest of the repository.';

  const evidenceSource = multi
    ? `the single line of code the finding is about, copied VERBATIM from that file's diff below.`
    : 'the single line of code the finding is about, copied VERBATIM from the diff below.';

  const capRule = multi
    ? '4. Return at most {{MAX_COMMENTS}} findings PER FILE, most severe first. Keep each body under 160 words.'
    : '4. Return at most {{MAX_COMMENTS}} findings, most severe first. Keep each body under 160 words.';

  const emptyRule = multi
    ? `5. Return exactly one entry per file listed below, in the same order, even for files with no defect - give those an empty findings array and a short explanation. Do not pad, do not withhold, and do not omit a file.`
    : '5. If the diff genuinely introduces no defect, return an empty findings array and a short explanation. Do not pad, and do not withhold.';

  return `You are a world-class software engineer performing a precise, high-signal code review.
Your goal is to find REAL defects (bugs, security vulnerabilities, and performance problems) introduced by the diff. Every finding must be grounded in a line you can quote from the diff.

### CONTEXT EXTENDS (read carefully, this prevents false positives):
${contextScope}
- Do NOT report that a symbol is undefined, unimported, unused, missing, or never-called merely because its declaration or usage is not visible in the diff. Imports, types, and definitions frequently live in unchanged parts of the file. Flag such an issue ONLY if the diff itself clearly introduces it.
- Do NOT assume how code elsewhere behaves. If confirming an issue requires code you cannot see, do not report it.

### WHAT TO REPORT:
- Report anything a senior engineer reviewing this diff would want to investigate: a bug, a security hole, a performance problem, a resource leak, an unhandled failure, a broken invariant.
- You do not need to be certain. A finding you can ground in a quoted line is worth raising; every finding is independently checked against the diff afterwards, and a wrong one is discarded at no cost to you. A defect you decline to mention is simply lost.
- Do NOT report subjective preferences (naming, formatting, "cleaner" alternatives, "consider using X") unless they cause a concrete bug, security hole, or measurable performance problem. These are discarded and crowd out real defects.

### EVIDENCE (mandatory, a finding without it cannot be posted):
- Every finding MUST include "evidence": ${evidenceSource}
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
${capRule}
${emptyRule}

### SCHEMA FORMAT:
${multi ? MULTI_FILE_SCHEMA_FORMAT : SINGLE_FILE_SCHEMA_FORMAT}

Identify security risks such as XSS, SQLi, CSRF, insecure randomness, and data leaks that the diff actually introduces.`;
}

// Named export because several tests assert against the prompt text directly.
export const fileReviewSystemPromptBase = buildFileReviewSystemPromptBase();

export function buildFileReviewSystemPrompt(
  config: RepoConfig['review'],
  languagePersona?: string,
  opts?: { multiFile?: boolean },
) {
  const persona = languagePersona ? ` as ${languagePersona}` : '';
  // Prose cap must be the generator cap: otherwise the grammar allows 2N while the text asks for N, and the model obeys the text.
  const prompt = buildFileReviewSystemPromptBase(opts)
    .replace('{{MAX_COMMENTS}}', generatorFindingCap(config.max_comments).toString());
  return `You are a world-class professional senior code reviewer${persona}. ${prompt}`;
}

// Human-rejected findings as NEGATIVE few-shot exemplars. Rejections only, since `marked_right` is rare and an absent label means nothing.
export type RejectedExemplar = { title: string; claimType?: string | null };

// Hard cap: every character competes with the diff for a 16k-input-tokens/minute bucket.
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

const PR_DESCRIPTION_CHARS = 2_000;

// Highest-value context by a wide margin (ContextCRBench: diff-only F1 36.08, +description 62.12).
function renderPrContext(prDescription: string | null): string | null {
  const trimmed = prDescription?.trim();
  if (!trimmed) return null;
  return `PR description (author intent - use to judge whether a change is deliberate):\n${trimmed.slice(0, PR_DESCRIPTION_CHARS)}${trimmed.length > PR_DESCRIPTION_CHARS ? '…' : ''}`;
}

function renderCustomRules(config: RepoConfig['review']): string {
  const rules = config.custom_rules.length > 0 ? config.custom_rules.map((rule) => `- ${rule}`).join('\n') : '- None';
  return `Custom rules:\n${rules}`;
}

function renderLanguageGuidelines(path: string): string {
  const languageInfo = getLanguageForFile(path);
  const guidelineHeader = 'Specific Guidelines (check the diff against each of these)';
  return languageInfo
    ? `Language: ${languageInfo.language}\n${guidelineHeader}:\n${languageInfo.guidelines.map(g => `- ${g}`).join('\n')}`
    : 'Language: Generic\nSpecific Guidelines: Follow general best practices.';
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
  const languageGuidelines = renderLanguageGuidelines(input.file.path);

  const prContext = renderPrContext(input.prDescription);

  const exemplars = renderExemplars(input.rejectedExemplars);

  const userPrompt = [
    `PR title: ${input.prTitle ?? 'Untitled PR'}`,
    ...(prContext ? [prContext] : []),
    ...(exemplars ? [exemplars] : []),
    `File path: ${input.file.path}`,
    languageGuidelines,
    `Custom rules:\n${rules}`,
    'Review ONLY the diff shown below. You cannot see the rest of the file or repository - do not report something as undefined, unimported, unused, or missing just because it is not in the diff. If the diff note says it was truncated, do not infer issues from omitted lines.',
    // `line` is posted to GitHub as the anchor, so it must be a NEW-file number present in the diff.
    'Line numbers: every diff line below is prefixed with two columns - the OLD file line number, then the NEW file line number. Always report `line` (and `line_range`) using the NEW (second, right-hand) number, and only ever cite a line that appears in the diff. For a removed line, cite the nearest NEW line number shown next to it.',
    // Evidence is matched verbatim before posting, so it must be code only -- no gutter or marker.
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

// Distinct enough not to be confused for diff content.
function packFileHeader(file: FileDiff, index: number, total: number): string {
  return `===== FILE ${index + 1} of ${total}: ${file.path} =====`;
}

// Several small files share one call so the ~2,800-token preamble amortises. Not a generalisation of buildFileReviewPrompts, which is snapshot-locked.
export function buildBatchReviewPrompts(input: {
  files: readonly FileDiff[];
  prTitle: string | null;
  prDescription: string | null;
  config: RepoConfig['review'];
  rejectedExemplars?: readonly RejectedExemplar[];
}) {
  const files = input.files;

  // Object identity is enough: getLanguageForFile returns the same entry for every matching file.
  const languages = new Set(files.map((file) => getLanguageForFile(file.path)));
  const uniformLanguage = languages.size === 1 ? [...languages][0] : undefined;

  // A persona claims something about the whole response, so only uniform bins get one.
  const systemPrompt = buildFileReviewSystemPrompt(input.config, uniformLanguage?.persona, { multiFile: true });

  const prContext = renderPrContext(input.prDescription);
  const exemplars = renderExemplars(input.rejectedExemplars);
  const pathList = files.map((file) => `- ${file.path}`).join('\n');

  const fileBlocks = files.flatMap((file, index) => [
    '',
    packFileHeader(file, index, files.length),
    // Uniform bins state the language once, above; only a mixed bin repeats it per file.
    ...(uniformLanguage ? [] : [renderLanguageGuidelines(file.path)]),
    'Unified diff:',
    renderFileDiff(file),
  ]);

  const userPrompt = [
    `PR title: ${input.prTitle ?? 'Untitled PR'}`,
    ...(prContext ? [prContext] : []),
    ...(exemplars ? [exemplars] : []),
    `You are reviewing ${files.length} files in ONE response. Return exactly ${files.length} entries in "files", one per path, in this order:\n${pathList}`,
    ...(uniformLanguage ? [renderLanguageGuidelines(files[0].path)] : []),
    renderCustomRules(input.config),
    'Review ONLY the diffs shown below. You cannot see the rest of any file or the repository - do not report something as undefined, unimported, unused, or missing just because it is not in a diff. If a diff note says it was truncated, do not infer issues from omitted lines.',
    // The key batch-only rule: a misfiled finding can fuzzy-match a common line in the wrong file.
    'File scoping: each finding belongs to exactly ONE file. Put it inside that file\'s entry, set that file\'s path in `absolute_file_path`, and quote evidence from that file\'s diff only. Never report a finding about one file inside another file\'s entry, and never quote a line from a different file.',
    // `line` is posted to GitHub as the anchor, so it must be a NEW-file number present in the diff.
    'Line numbers: every diff line below is prefixed with two columns - the OLD file line number, then the NEW file line number. Always report `line` (and `line_range`) using the NEW (second, right-hand) number, and only ever cite a line that appears in that file\'s diff. For a removed line, cite the nearest NEW line number shown next to it.',
    // Evidence is matched verbatim before posting, so it must be code only -- no gutter or marker.
    'Evidence: every finding must carry an `evidence` string containing the exact code of the line it is about, copied character-for-character from its own file\'s diff below. Strip the two leading line-number columns and the +/-/space marker - quote only the code itself. A finding whose evidence does not appear in that file\'s diff will be discarded.',
    'Prioritize correctness, security, and production-impacting bugs. Raise anything you can ground in a quoted line; avoid subjective style feedback.',
    '',
    `## Output JSON Schema (STRICTLY REQUIRED)`,
    // Same constant the system prompt renders.
    MULTI_FILE_SCHEMA_FORMAT,
    ...fileBlocks,
  ].join('\n');

  return { systemPrompt, userPrompt };
}

// Exported so the packer measures bins with the exact renderer the prompt uses.
export function renderFileDiff(file: FileDiff) {
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
