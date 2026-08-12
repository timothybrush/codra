// Batched-response payload extraction. Separate from the single-file parser, whose force-filled `findings: []` would approve an unexamined file here.
import { batchReviewModelOutputSchema, fileReviewModelOutputSchema } from '@codra/schema';
import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';
import { logger } from '../logger';
import {
  extractJson,
  hasReviewKeys,
  normalizeFinding,
  parseRawPayload,
  preprocessJson,
  stripNulls,
  truncateJsonForLog,
} from './json';

// Models routinely report the path under a key other than the one the schema asked for.
function readEntryPath(entry: Record<string, unknown>): string | null {
  for (const key of ['absolute_file_path', 'path', 'file', 'file_path', 'filename'] as const) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value > 1) return Math.min(value / 10, 1);
  if (value < 0) return 0;
  return value;
}

// Returns null for an untrustworthy entry, so it surfaces as `missing` -- re-queued, not clean.
function normalizeBatchFileEntry(entry: unknown, fallbackPath?: string): unknown | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  const path = readEntryPath(e) ?? fallbackPath;
  if (!path) return null;

  // Absence of the key, not an empty array: a truncated response repairs into a missing `findings`.
  if (!Array.isArray(e.findings)) return null;

  return {
    absolute_file_path: path,
    findings: e.findings.flatMap((finding) => {
      const normalized = normalizeFinding(finding);
      return normalized ? [normalized] : [];
    }),
    overall_correctness: typeof e.overall_correctness === 'string' && e.overall_correctness ? e.overall_correctness : undefined,
    overall_explanation: typeof e.overall_explanation === 'string' && e.overall_explanation ? e.overall_explanation : undefined,
    overall_confidence_score: normalizeConfidence(e.overall_confidence_score),
  };
}

// Three shapes seen in practice: a grammar-honouring array, a path-keyed object, and a bare array.
function collectBatchEntries(parsedJson: unknown): unknown[] | null {
  const root = parsedJson && typeof parsedJson === 'object' ? (parsedJson as Record<string, unknown>) : null;
  const files = root?.files ?? (Array.isArray(parsedJson) ? parsedJson : undefined);

  if (Array.isArray(files)) {
    return files.flatMap((entry) => {
      const normalized = normalizeBatchFileEntry(entry);
      return normalized ? [normalized] : [];
    });
  }
  if (files && typeof files === 'object') {
    return Object.entries(files as Record<string, unknown>).flatMap(([path, entry]) => {
      const normalized = normalizeBatchFileEntry(entry, path);
      return normalized ? [normalized] : [];
    });
  }
  return null;
}

export type RawBatchPayload =
  | { shape: 'nested'; data: z.infer<typeof batchReviewModelOutputSchema> }
  // Model ignored the nested schema -- common on weaker fallback models.
  | { shape: 'flat'; data: z.infer<typeof fileReviewModelOutputSchema> };

// NOT routed through parseRawPayload -- see the header.
export function parseRawBatchPayload(raw: string): RawBatchPayload {
  let extracted: string;
  try {
    extracted = extractJson(raw, 'files');
    if (!hasReviewKeys(extracted)) {
      throw new Error('Model response did not contain review JSON keys.');
    }
  } catch (e) {
    logger.error('Failed to extract JSON from batched model response', {
      rawLength: raw.length,
      rawPrefix: raw.slice(0, 500),
      error: e instanceof Error ? e.message : String(e),
    });
    throw new Error('Could not find JSON root in batched model response.', { cause: e });
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
    logger.warn('jsonrepair failed to fix batched model output, using preprocessed text', { preprocessed: truncateJsonForLog(preprocessed), error: e });
  }

  let parsedJson: unknown;
  try {
    // See stripNulls: one `"code_suggestion": null` used to discard the whole bin's response.
    parsedJson = stripNulls(JSON.parse(repaired));
  } catch (e) {
    logger.error('Critical JSON parse error after extraction and repair', { repaired: truncateJsonForLog(repaired), error: e });
    throw new Error(`Invalid JSON format: ${e instanceof Error ? e.message : 'Unknown error'}`, { cause: e });
  }

  const entries = collectBatchEntries(parsedJson);
  const root = parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)
    ? (parsedJson as Record<string, unknown>)
    : {};

  if (!entries?.length) {
    // No usable `files`, but a findings array is present: the flat shape, not a lost response.
    if (Array.isArray(root.findings)) return { shape: 'flat', data: parseRawPayload(raw) };
    logger.error('Batched model response contained no recognisable file entries', {
      parsedJson: truncateJsonForLog(JSON.stringify(parsedJson ?? null)),
    });
    throw new Error('Batched response contained no recognisable file entries.');
  }

  try {
    return {
      shape: 'nested',
      data: batchReviewModelOutputSchema.parse({
        files: entries,
        overall_confidence_score: normalizeConfidence(root.overall_confidence_score) ?? 0.5,
      }),
    };
  } catch (e) {
    logger.error('Batched model response failed schema validation', { parsedJson, error: e });
    throw new Error(`Batched response schema mismatch: ${e instanceof Error ? e.message : 'Check logs'}`, { cause: e });
  }
}
