import {
  fileReviewModelOutputSchema,
  parsedReviewCommentSchema,
  summaryModelOutputSchema,
  toClaimType,
  CLAIM_TYPE_CATEGORY,
  type ParsedReviewComment,
  reviewSeverities,
} from '@shared/schema';
import { renderDiffSnippet } from '@server/prompts/verify';
import { z } from 'zod';
import { logger } from './logger';
import { findClosestValidLine, findPositionForLine, getValidNewLines, getValidPositions } from './diff';
import type { DiffLine, FileDiff } from './diff';
import { buildAnchorHash, buildFindingFingerprint, normalizeDiffText, normalizeFindingTitle } from './fingerprint';
import { jsonrepair } from 'jsonrepair';

/**
 * An `evidence` string shorter than this can't discriminate -- `}`, `);`, `return` and friends
 * match dozens of lines in any diff. Below the threshold we fall back to line-based anchoring and
 * never exclude the finding, because a non-match tells us nothing.
 */
const MIN_DISCRIMINATING_EVIDENCE_CHARS = 8;

const MAX_LOGGED_JSON_CHARS = 2_000;

function truncateJsonForLog(value: string) {
  if (value.length <= MAX_LOGGED_JSON_CHARS) return value;
  return `${value.slice(0, MAX_LOGGED_JSON_CHARS)}... [truncated ${value.length - MAX_LOGGED_JSON_CHARS} chars]`;
}

function hasReviewKeys(input: string) {
  return /"(findings|overall_explanation|overall_correctness|overall_confidence_score|summary)"\s*:/.test(input);
}

function extractJson(raw: string) {
  // 1. Try to find explicit JSON blocks first (most reliable)
  const jsonBlocks = Array.from(raw.matchAll(/```json\s*([\s\S]*?)```/gi));
  if (jsonBlocks.length > 0) {
    return jsonBlocks[jsonBlocks.length - 1][1].trim();
  }

  // 2. Fallback to generic code blocks - must contain a JSON-like structure
  const genericBlocks = Array.from(raw.matchAll(/```(?:[\w+-]+)?\s*([\s\S]*?)```/gi));
  if (genericBlocks.length > 0) {
    const candidates = genericBlocks.filter(b => b[1].includes('{') && b[1].includes('}') && hasReviewKeys(b[1]));
    if (candidates.length > 0) {
      const content = candidates[candidates.length - 1][1].trim();
      // Try to find the actual object inside the code block
      const start = content.indexOf('{');
      const end = content.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        return content.slice(start, end + 1);
      }
      return content;
    }
  }

  // 3. Robust "Outer Brace" extraction
  // Find the first '{' and then match braces to find the corresponding '}'
  // We prioritize blocks that look like our expected JSON
  const findingsIdx = raw.indexOf('"findings"');
  const summaryIdx = raw.indexOf('"summary"');
  const targetIdx = findingsIdx !== -1 ? findingsIdx : (summaryIdx !== -1 ? summaryIdx : -1);

  let firstBrace = -1;
  if (targetIdx !== -1) {
    // Try to find the brace that opens the object containing the keyword
    firstBrace = raw.lastIndexOf('{', targetIdx);
  }

  // If no keyword found, search for generic brace blocks and score them
  if (firstBrace === -1) {
    const allBraces = Array.from(raw.matchAll(/\{/g));
    let bestIdx = -1;
    let bestScore = -1;

    for (const match of allBraces) {
      const idx = match.index!;
      const excerpt = raw.slice(idx, idx + 200);
      let score = 0;

      // Keywords are strong indicators
      if (excerpt.includes('"findings"')) score += 100;
      if (excerpt.includes('"summary"')) score += 50;
      if (excerpt.includes('"overall_explanation"')) score += 50;

      // JSON structure indicators
      if (excerpt.includes('" : ') || excerpt.includes('":')) score += 10;
      if (excerpt.includes('"[')) score += 5;

      // Anti-indicators (looks like code, not our JSON)
      if (excerpt.includes(': number;') || excerpt.includes(': string;')) score -= 80;
      if (excerpt.includes('export ') || excerpt.includes('function ')) score -= 80;
      if (excerpt.includes('interface ') || excerpt.includes('type ')) score -= 80;
      if (excerpt.includes(' + ')) score -= 20; // Looks like a diff hunk

      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }

    if (bestIdx !== -1 && bestScore > 0) {
      firstBrace = bestIdx;
    }
  }

  // Final fallback to the very first brace if we're desperate and it looks like JSON
  if (firstBrace === -1) {
    const start = raw.indexOf('{');
    if (start !== -1) {
      const excerpt = raw.slice(start, start + 50);
      if (excerpt.includes('"') && excerpt.includes(':')) {
        firstBrace = start;
      }
    }
  }

  if (firstBrace !== -1) {
    let stack = 0;
    let inString = false;
    let escape = false;

    for (let i = firstBrace; i < raw.length; i++) {
      const char = raw[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === '\\') {
        escape = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') stack++;
        else if (char === '}') {
          stack--;
          if (stack === 0) {
            return raw.slice(firstBrace, i + 1);
          }
        }
      }
    }

    // Truncated JSON: the closing brace(s) are missing. Append them so jsonrepair
    // has a structurally complete (though incomplete-content) object to work with.
    const partial = raw.slice(firstBrace).trim();
    let closing = '';
    if (inString) closing += '"';
    closing += '}'.repeat(Math.max(1, stack));
    return `${partial}${closing}`;
  }

  return raw.trim();
}

function isPlaceholderString(value: unknown) {
  return typeof value === 'string' && /^<[^>]+>$/.test(value.trim());
}

function coerceReviewNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && !isPlaceholderString(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeFinding(finding: unknown) {
  if (!finding || typeof finding !== 'object') return null;
  const f = finding as Record<string, unknown>;
  // A model echoing the schema template back (`"<evidence>"`) has produced no finding at all.
  if (isPlaceholderString(f.title) || isPlaceholderString(f.body) || isPlaceholderString(f.evidence)) return null;

  const location = f.code_location && typeof f.code_location === 'object' ? (f.code_location as Record<string, unknown>) : {};
  const line = coerceReviewNumber(location.line);
  const start = coerceReviewNumber(location.line_range && typeof location.line_range === 'object' ? (location.line_range as Record<string, unknown>).start : undefined);
  const end = coerceReviewNumber(location.line_range && typeof location.line_range === 'object' ? (location.line_range as Record<string, unknown>).end : undefined);
  const priority = coerceReviewNumber(f.priority);

  const codeLocation: Record<string, unknown> = {
    absolute_file_path: location.absolute_file_path || f.path || '',
  };
  if (line !== undefined) {
    codeLocation.line = Math.trunc(line as number);
  }
  if (start !== undefined || end !== undefined) {
    codeLocation.line_range = {
      start: Math.trunc((start as number) ?? (end as number)!),
      end: Math.trunc((end as number) ?? (start as number)!),
    };
  }

  return {
    ...f,
    title: f.title || 'Code finding',
    // Clamp to 4, matching `fileReviewModelOutputSchema.priority` and the JSON grammar. This runs
    // BEFORE Zod sees the value, so a tighter clamp here than in the schema is unreachable -- and a
    // looser one throws for the entire file's review rather than the single bad finding.
    priority: priority === undefined ? undefined : Math.max(0, Math.min(4, Math.trunc(priority as number))),
    code_location: codeLocation,
    confidence_score: typeof f.confidence_score === 'number'
      ? Math.max(0, Math.min(1, f.confidence_score > 1 ? f.confidence_score / 10 : f.confidence_score))
      : undefined,
  };
}

/**
 * Pre-processes JSON string to handle common LLM defects before passing to jsonrepair.
 * Optimized for CPU performance (avoids backtracking regexes).
 */
function preprocessJson(json: string): string {
  let result = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (escape) {
      result += char;
      escape = false;
      continue;
    }

    if (char === '\\') {
      result += char;
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }

    if (inString) {
      if (char === '\n') {
        result += '\\n';
      } else if (char === '\r') {
        result += '\\r';
      } else {
        result += char;
      }
    } else {
      result += char;
    }
  }

  return result;
}

function withSuggestion(body: string, codeSuggestion?: string) {
  if (!codeSuggestion) return body;

  // Clean suggestion: remove existing fences if model added them, and trim
  const cleanSuggestion = codeSuggestion.replace(/```suggestion\n?|```/g, '').trim();

  // Clean body: remove any trailing redundant suggestion blocks if the model double-outputted
  const cleanBody = body.split('```suggestion')[0].trim();

  return `${cleanBody}\n\n\`\`\`suggestion\n${cleanSuggestion}\n\`\`\``;
}

type EvidenceIndex = {
  byContent: Map<string, DiffLine[]>;
  lines: { normalized: string; line: DiffLine }[];
};

/**
 * Indexes a file's diff by normalized line content so evidence quotes can be resolved in one pass
 * per file rather than re-scanning every line for every finding (findings x lines gets expensive
 * fast inside a CPU-bounded Worker).
 *
 * Deleted lines ARE indexed, but they resolve to the nearest postable line instead of themselves.
 * A finding about removed code is perfectly legitimate, yet `findPositionForLine` refuses `del`
 * lines, so anchoring to one guarantees the comment is dropped. Leaving them out of the index
 * entirely is no better: the quote would then match nothing and be excluded as a hallucination.
 */
function buildEvidenceIndex(file: FileDiff): EvidenceIndex {
  const byContent = new Map<string, DiffLine[]>();
  const lines: { normalized: string; line: DiffLine }[] = [];

  for (const hunk of file.hunks) {
    const postable = hunk.lines.filter((line) => line.kind !== 'del' && line.newLineNumber !== undefined);
    if (postable.length === 0) continue;

    hunk.lines.forEach((line, lineIndex) => {
      const normalized = normalizeDiffText(line.content);
      if (!normalized) return;

      let anchor = line;
      if (line.kind === 'del' || line.newLineNumber === undefined) {
        // Nearest postable line at or after the deletion, falling back to the one before it.
        anchor = hunk.lines.slice(lineIndex + 1).find((l) => l.kind !== 'del' && l.newLineNumber !== undefined)
          ?? [...hunk.lines.slice(0, lineIndex)].reverse().find((l) => l.kind !== 'del' && l.newLineNumber !== undefined)
          ?? postable[0];
      }

      lines.push({ normalized, line: anchor });
      const existing = byContent.get(normalized);
      if (existing) existing.push(anchor);
      else byContent.set(normalized, [anchor]);
    });
  }

  return { byContent, lines };
}

type EvidenceResolution =
  | { status: 'absent' }
  /** Present but too short to prove anything either way. */
  | { status: 'weak' }
  | { status: 'matched'; line: DiffLine }
  /** Present, discriminating, and matching nothing in the diff -- the hallucination signal. */
  | { status: 'unmatched' };

function resolveEvidence(
  evidence: unknown,
  index: EvidenceIndex,
  reportedLine: number | undefined,
): EvidenceResolution {
  if (typeof evidence !== 'string') return { status: 'absent' };

  // Multi-line quotes are common; the first substantive line is the one we anchor to.
  const firstLine = evidence.split('\n').map(normalizeDiffText).find((l) => l.length > 0);
  if (!firstLine) return { status: 'absent' };
  if (firstLine.length < MIN_DISCRIMINATING_EVIDENCE_CHARS) return { status: 'weak' };

  const nearest = (candidates: DiffLine[]) => {
    if (reportedLine === undefined) return candidates[0];
    return candidates.reduce((best, candidate) =>
      Math.abs((candidate.newLineNumber ?? 0) - reportedLine) < Math.abs((best.newLineNumber ?? 0) - reportedLine)
        ? candidate
        : best,
    );
  };

  const exact = index.byContent.get(firstLine);
  if (exact && exact.length > 0) return { status: 'matched', line: nearest(exact) };

  // The model may have quoted a fragment of the line, or included trailing context, so accept
  // containment in either direction -- but BOTH sides have to be discriminating.
  //
  // Requiring only the evidence to clear the length bar is not enough: a fabricated quote like
  // "useEffect(() => {" trivially contains a real but meaningless diff line such as ") => {", so
  // the finding anchors onto whatever brace happens to match and looks grounded. Observed in
  // production -- four hallucinated React-hook findings anchored to lines that were nothing but
  // punctuation. Holding the matched line to the same minimum closes that.
  const contained = index.lines
    .filter(({ normalized }) =>
      normalized.length >= MIN_DISCRIMINATING_EVIDENCE_CHARS
      && (normalized.includes(firstLine) || firstLine.includes(normalized)))
    .map(({ line }) => line);
  if (contained.length > 0) return { status: 'matched', line: nearest(contained) };

  return { status: 'unmatched' };
}

export function parseFileReviewResponse(
  raw: string,
  file: FileDiff,
  options?: {
    /**
     * True when the provider constrained decoding to our JSON schema, i.e. `evidence`,
     * `confidence_score` and `priority` were REQUIRED and the model could not have omitted them.
     * Only then is a missing or unmatched field the model's fault and safe to act on. On providers
     * that ignore schemas this stays false and grounding degrades to anchoring-only, so we never
     * empty out a review just because the provider can't enforce a grammar.
     */
    schemaEnforced?: boolean;
  },
): {
  comments: ParsedReviewComment[];
  verdict: 'approve' | 'comment';
  fileSummary: string;
  overallCorrectness?: string;
  confidenceScore?: number;
  evidenceStats: { total: number; matched: number; unmatched: number; weak: number; absent: number };
  claimTypeCounts: Record<string, number>;
} {
  let extracted = '';
  try {
    extracted = extractJson(raw);
    if (!hasReviewKeys(extracted)) {
      throw new Error('Model response did not contain review JSON keys.');
    }
  } catch (e) {
    // Log a prefix of the raw response so we can diagnose what the model returned
    // without bloating logs with 10k+ char dumps.
    logger.error('Failed to extract JSON from model response', {
      rawLength: raw.length,
      rawPrefix: raw.slice(0, 500),
      error: e instanceof Error ? e.message : String(e),
    });
    throw new Error('Could not find JSON root in model response.');
  }

  let preprocessed = '';
  try {
    preprocessed = preprocessJson(extracted);
  } catch (e) {
    logger.warn('JSON preprocessing partially failed, continuing...', { extracted, error: e });
    preprocessed = extracted;
  }

  let repaired = preprocessed;
  try {
    repaired = jsonrepair(preprocessed);
  } catch (e) {
    logger.warn('jsonrepair failed to fix model output, using preprocessed text', { preprocessed: truncateJsonForLog(preprocessed), error: e });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(repaired);
  } catch (e) {
    logger.error('Critical JSON parse error after extraction and repair', { repaired: truncateJsonForLog(repaired), error: e });
    throw new Error(`Invalid JSON format: ${e instanceof Error ? e.message : 'Unknown error'}`);
  }

  let parsed: z.infer<typeof fileReviewModelOutputSchema>;
  try {
    const findReviewObject = (arr: unknown[]): unknown | null => {
      // Priority 1: Has findings array and summary
      const best = arr.find(i => i && typeof i === 'object' && Array.isArray((i as Record<string, unknown>).findings) && typeof (i as Record<string, unknown>).summary === 'string');
      if (best) return best;

      // Priority 2: Has findings array
      const good = arr.find(i => i && typeof i === 'object' && Array.isArray((i as Record<string, unknown>).findings));
      if (good) return good;

      // Priority 3: Has review-like keys
      return arr.find(i =>
        i && typeof i === 'object' &&
        ('findings' in i || 'overall_explanation' in i || 'summary' in i || 'overall_correctness' in i)
      );
    };

    let data = Array.isArray(parsedJson) ? (findReviewObject(parsedJson) || parsedJson[0] || {}) : parsedJson;

    // Ensure essential keys exist to avoid schema validation errors
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      if (!obj.findings) obj.findings = [];
      if (!obj.overall_explanation) obj.overall_explanation = 'No explanation provided.';
      if (!obj.overall_correctness) obj.overall_correctness = 'Uncertain';

      // Handle confidence score hallucinations (0-1 range expected)
      if (typeof obj.overall_confidence_score === 'number') {
        if (obj.overall_confidence_score > 1) {
          // If they gave 1-10 scale, normalize it
          obj.overall_confidence_score = Math.min(obj.overall_confidence_score / 10, 1);
        } else if (obj.overall_confidence_score < 0) {
          obj.overall_confidence_score = 0;
        }
      } else {
        obj.overall_confidence_score = 0.5;
      }

      if (Array.isArray(obj.findings)) {
        obj.findings = obj.findings.map(normalizeFinding).filter(Boolean);
      }
      data = obj;
    }

    parsed = fileReviewModelOutputSchema.parse(data);
  } catch (e) {
    logger.error('Model response failed schema validation', { parsedJson, error: e });
    throw new Error(`Response schema mismatch: ${e instanceof Error ? e.message : 'Check logs'}`);
  }

  const validLines = getValidNewLines(file);
  const validPositions = getValidPositions(file);
  const evidenceIndex = buildEvidenceIndex(file);
  const schemaEnforced = options?.schemaEnforced === true;
  const evidenceStats = { total: 0, matched: 0, unmatched: 0, weak: 0, absent: 0 };
  const claimTypeCounts: Record<string, number> = {};

  const orphanedComments: string[] = [];
  const comments = (parsed.findings || [])
    .map((finding) => {
      // Codex style findings use start/end or line
      let line = finding.code_location.line || finding.code_location.line_range?.start;
      let position: number | undefined;
      let anchorLine: DiffLine | undefined;

      // Evidence first: a verbatim quote that actually appears in the diff is a far stronger
      // anchor than a line number the model may have invented, and it is the only signal we can
      // check deterministically.
      evidenceStats.total += 1;
      const evidence = resolveEvidence(finding.evidence, evidenceIndex, line);
      if (evidence.status === 'matched') evidenceStats.matched += 1;
      else if (evidence.status === 'unmatched') evidenceStats.unmatched += 1;
      else if (evidence.status === 'weak') evidenceStats.weak += 1;
      else if (evidence.status === 'absent') evidenceStats.absent += 1;

      // Where the grammar REQUIRED a verbatim quote, only a quote that actually resolves to a diff
      // line is good enough.
      //
      // This used to reject `unmatched` alone, which meant a finding that quoted NOTHING (`absent`)
      // or quoted three characters (`weak`) was treated more leniently than one that quoted wrong
      // -- it fell through to line-based anchoring and posted. Under an enforced schema `evidence`
      // is a required field, so absent/weak is a schema violation wearing a finding's clothes.
      //
      // Not deleted: these land in the off-diff list, which the dashboard renders, with a distinct
      // prefix per reason so the disposition data can attribute them.
      if (schemaEnforced && evidence.status !== 'matched') {
        orphanedComments.push(`- **[unverified:${evidence.status}] ${finding.title}:** ${finding.body}`);
        return null;
      }

      if (evidence.status === 'matched') {
        anchorLine = evidence.line;
        line = evidence.line.newLineNumber;
        position = findPositionForLine(file, line!);
      } else if (line !== undefined) {
        // No usable evidence: fall back to the model's line number, snapping only a short distance
        // to absorb genuine off-by-one errors.
        if (!validLines.has(line)) {
          const closest = findClosestValidLine(file, line);
          line = closest;
        }

        if (line !== undefined) {
          position = findPositionForLine(file, line);
        }
      }

      // Final validation
      if (position === undefined || !validPositions.has(position)) {
        orphanedComments.push(`- **${finding.title}:** ${finding.body}`);
        return null;
      }

      // Map priority to severity
      const priorityMap: Record<number, typeof reviewSeverities[number]> = {
        0: 'P0',
        1: 'P1',
        2: 'P2',
        3: 'P3',
        4: 'nit',
      };
      // A missing priority means the model didn't bother to rank it. Where the schema REQUIRED it,
      // omitting it is a defect and the finding is treated as a nit so the severity gate can act on
      // it; elsewhere fall back to P3 so a provider that can't enforce the field isn't punished.
      const severity = finding.priority !== undefined
        ? priorityMap[finding.priority] || 'P3'
        : schemaEnforced ? 'nit' : 'P3';

      const cleanText = (text: string) => {
        let current = text.trim();
        let prev = '';
        while (current !== prev) {
          prev = current;
          current = current
            .replace(/^(?:[^\w\s]+|(?:QUALITY|SECURITY|BUG|PERFORMANCE|CORRECTNESS|P[0-3]|NIT)\b)+/giu, '')
            .replace(/\n\s*/g, ' ') // Flatten newlines in titles/snippets
            .trim();
        }
        return current;
      };

      const title = cleanText(finding.title);
      let body = cleanText(finding.body);

      // If the body starts with the title or a similar variant, strip it
      const bodyPrefix = cleanText(body.split('\n')[0]);
      if (bodyPrefix.toLowerCase().startsWith(title.toLowerCase()) || title.toLowerCase().startsWith(bodyPrefix.toLowerCase())) {
        body = cleanText(body.slice(body.split('\n')[0].length));
      }

      // Anchor on the resolved line's actual content so the hash tracks the code, not the line
      // number: an edit above the finding shifts the number but must not re-raise the comment,
      // while an edit TO the line must.
      const anchorContent = anchorLine?.content
        ?? file.hunks.flatMap((h) => h.lines).find((l) => l.newLineNumber === line)?.content
        ?? '';

      // Where the schema required a confidence score, its absence is a model defect and must not
      // silently bypass the min_confidence gate downstream -- 0 fails it, as intended.
      const confidenceScore = typeof finding.confidence_score === 'number'
        ? finding.confidence_score
        : schemaEnforced ? 0 : undefined;

      // Unrecognized or missing values coerce to 'other' rather than throwing: a Zod rejection here
      // would discard every finding in the file over one bad label.
      const claimType = toClaimType(finding.claim_type);
      claimTypeCounts[claimType] = (claimTypeCounts[claimType] ?? 0) + 1;

      return parsedReviewCommentSchema.parse({
        path: file.path,
        line: line,
        position,
        severity,
        // Derived, never model-emitted. Asking the model for a field the harness can compute is how
        // you end up with a column that reads 'quality' on all 705 rows.
        category: CLAIM_TYPE_CATEGORY[claimType],
        claimType,
        // Captured now because it is unrecoverable later: migration 003 nulls diff_input and the KV
        // diff cache expires after 6h, so a finding with no stored context can never be re-judged.
        contextSnippet: renderDiffSnippet(file, line) || undefined,
        title,
        body: withSuggestion(body, finding.code_suggestion),
        codeSuggestion: finding.code_suggestion,
        confidenceScore,
        evidence: typeof finding.evidence === 'string' && finding.evidence.trim() ? finding.evidence.trim() : undefined,
        fingerprint: buildFindingFingerprint(file.path, title),
        anchorHash: anchorContent ? buildAnchorHash(anchorContent) : undefined,
      });
    })
    .filter((comment): comment is ParsedReviewComment => Boolean(comment));

  const verdict = parsed.overall_correctness.toLowerCase().includes('patch is correct') ? 'approve' : 'comment';
  let fileSummary = parsed.overall_explanation;

  if (orphanedComments.length > 0) {
    fileSummary += `\n\n### Additional Comments (Off-diff)\n${orphanedComments.join('\n')}`;
  }

  return {
    comments,
    verdict: comments.length > 0 ? 'comment' : verdict,
    fileSummary: fileSummary,
    overallCorrectness: parsed.overall_correctness,
    confidenceScore: parsed.overall_confidence_score,
    evidenceStats,
    claimTypeCounts,
  };
}

const SEVERITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };

/**
 * Collapses near-duplicate findings. The same issue (e.g. "Use of any") is frequently reported
 * across many files on a large PR; posting each one is pure noise. We key on the normalized title
 * so restatements of the same finding — whether in the same file or across files — collapse to a
 * single representative, keeping the highest-severity / highest-confidence instance.
 */
export function dedupeFindings(comments: ParsedReviewComment[]): ParsedReviewComment[] {
  const best = new Map<string, ParsedReviewComment>();
  for (const comment of comments) {
    const key = normalizeFindingTitle(comment.title);
    if (!key) {
      // Untitled/odd finding — keep as-is under a unique key so it isn't merged away.
      best.set(`__unique__${best.size}`, comment);
      continue;
    }
    const existing = best.get(key);
    if (!existing) {
      best.set(key, comment);
      continue;
    }
    const rank = SEVERITY_RANK[comment.severity] ?? 4;
    const existingRank = SEVERITY_RANK[existing.severity] ?? 4;
    const isBetter =
      rank < existingRank ||
      (rank === existingRank && (comment.confidenceScore ?? 0) > (existing.confidenceScore ?? 0));
    if (isBetter) best.set(key, comment);
  }
  return Array.from(best.values());
}

export function parseSummaryResponse(raw: string): string {
  const extracted = extractJson(raw);
  const preprocessed = preprocessJson(extracted);

  let repaired = preprocessed;
  try {
    repaired = jsonrepair(preprocessed);
  } catch (e) {
    // Fall back to original preprocessed text if repair fails
  }

  try {
    const parsedJson = JSON.parse(repaired);
    const validated = summaryModelOutputSchema.parse(parsedJson);
    return Array.isArray(validated) ? validated[0]?.summary : validated.summary;
  } catch (error) {
    // If it's not valid JSON or doesn't match the schema, return the raw text as a fallback
    // This handles cases where the model might still ignore the JSON constraint
    return raw.trim() || 'Review completed with no summary provided.';
  }
}
