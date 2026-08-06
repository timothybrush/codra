import { fileReviewModelOutputSchema } from '@shared/schema';
import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';
import { logger } from '../logger';

const MAX_LOGGED_JSON_CHARS = 2_000;

export function truncateJsonForLog(value: string) {
  if (value.length <= MAX_LOGGED_JSON_CHARS) return value;
  return `${value.slice(0, MAX_LOGGED_JSON_CHARS)}... [truncated ${value.length - MAX_LOGGED_JSON_CHARS} chars]`;
}

export function hasReviewKeys(input: string) {
  return /"(findings|overall_explanation|overall_correctness|overall_confidence_score|summary)"\s*:/.test(input);
}

export function extractJson(raw: string) {
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

  // 3. Robust brace extraction: find the first '{' and match braces for the corresponding '}',
  // preferring blocks that look like our expected JSON.
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

// Pre-processes JSON string to handle common LLM defects before passing to jsonrepair.
// Optimized for CPU performance (avoids backtracking regexes).
export function preprocessJson(json: string): string {
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
    // Clamp to 4, matching the schema and the JSON grammar, BEFORE Zod sees the value -- a looser
    // clamp here throws for the whole file's review rather than the one bad finding.
    priority: priority === undefined ? undefined : Math.max(0, Math.min(4, Math.trunc(priority as number))),
    code_location: codeLocation,
    confidence_score: typeof f.confidence_score === 'number'
      ? Math.max(0, Math.min(1, f.confidence_score > 1 ? f.confidence_score / 10 : f.confidence_score))
      : undefined,
  };
}

// Extracts, repairs and schema-validates the raw model response into a typed payload. Throws on
// failure; every catch here logs enough of the raw/intermediate text to diagnose what the model
// actually returned, without bloating logs with 10k+ char dumps.
export function parseRawPayload(raw: string): z.infer<typeof fileReviewModelOutputSchema> {
  let extracted: string;
  try {
    extracted = extractJson(raw);
    if (!hasReviewKeys(extracted)) {
      throw new Error('Model response did not contain review JSON keys.');
    }
  } catch (e) {
    logger.error('Failed to extract JSON from model response', {
      rawLength: raw.length,
      rawPrefix: raw.slice(0, 500),
      error: e instanceof Error ? e.message : String(e),
    });
    throw new Error('Could not find JSON root in model response.', { cause: e });
  }

  let preprocessed: string;
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
    throw new Error(`Invalid JSON format: ${e instanceof Error ? e.message : 'Unknown error'}`, { cause: e });
  }

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

    return fileReviewModelOutputSchema.parse(data);
  } catch (e) {
    logger.error('Model response failed schema validation', { parsedJson, error: e });
    throw new Error(`Response schema mismatch: ${e instanceof Error ? e.message : 'Check logs'}`, { cause: e });
  }
}
