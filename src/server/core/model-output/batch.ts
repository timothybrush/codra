// Splits one batched response into per-file reviews, then grounds each through the same groundParsedFindings the single-file path uses.
import type { ClaimType } from '@shared/schema';
import type { FileDiff } from '../diff';
import { generatorFindingCap } from '@server/prompts/file-review';
import { logger } from '../logger';
import { buildBinAmbiguityIndex } from './evidence';
import { type GroundedFileReview, groundParsedFindings, samePath } from './index';
import { parseRawBatchPayload } from './json-batch';

export type BatchParseStats = {
  // Entry named a path not in the bin; its findings are discarded.
  unroutableEntries: number;
  // Finding named a file other than its enclosing entry. The entry wins.
  pathMismatchFindings: number;
  ambiguousAcrossBin: number;
  // Model ignored the nested schema and returned the single-file shape.
  flatFallback: number;
  // Comments discarded by the per-file cap.
  overCap: number;
  entriesReturned: number;
};

export type BatchReviewResult = {
  // Keyed by FileDiff.path, only for files the model returned.
  reviews: Map<string, GroundedFileReview>;
  // Packed files with no entry. Never reviewed-and-clean.
  missing: string[];
  stats: BatchParseStats;
};

type Ambiguity = { index: ReturnType<typeof buildBinAmbiguityIndex>; stats: { ambiguousAcrossBin: number } };
type RawEntry = { findings: unknown[]; overall_correctness: string; overall_explanation: string };

const basename = (path: string) => path.split('/').pop() ?? path;
const SEVERITY_ORDER = ['P0', 'P1', 'P2', 'P3', 'nit'];

// Resolves a reported path to a packed file, most-confident first. Exact/rename match over the full list before `claimed` applies, so a duplicate cannot fall into the fuzzy steps.
function resolveEntryPath(reported: string, candidates: readonly FileDiff[], claimed: Set<string>): FileDiff | null {
  const unclaimed = (matches: readonly FileDiff[]) => matches.find((f) => !claimed.has(f.path)) ?? null;

  const exact = candidates.filter((f) => samePath(f.path, reported));
  const renamed = candidates.filter((f) => f.previousPath && samePath(f.previousPath, reported));
  if (exact.length > 0 || renamed.length > 0) return unclaimed(exact) ?? unclaimed(renamed);

  // Bare paths are common, but only resolve when unambiguous over the full list.
  const stripped = reported.trim().replace(/^\.\//, '').replace(/^[ab]\//, '').replace(/^\//, '');
  const suffixed = candidates.filter((f) => f.path.endsWith(`/${stripped}`));
  if (suffixed.length === 1) return unclaimed(suffixed);

  const named = candidates.filter((f) => basename(f.path) === basename(stripped));
  return named.length === 1 ? unclaimed(named) : null;
}

function groundEntry(
  file: FileDiff,
  entry: RawEntry,
  deniedClaimTypes: readonly ClaimType[] | undefined,
  ambiguity: Ambiguity,
  confidenceScore: number | undefined,
  stats: BatchParseStats,
): GroundedFileReview {
  for (const finding of entry.findings as Array<{ code_location?: { absolute_file_path?: string } }>) {
    const claimed = finding.code_location?.absolute_file_path?.trim();
    if (claimed && !samePath(claimed, file.path)) stats.pathMismatchFindings += 1;
  }

  return groundParsedFindings(
    { ...entry, findings: entry.findings as never, overall_confidence_score: confidenceScore },
    file,
    { deniedClaimTypes, ambiguity: { index: ambiguity.index, filePath: file.path, stats: ambiguity.stats } },
  );
}

// Per file, like the grammar: a bin-wide ceiling would let one noisy file starve the rest.
function trimOverCap(reviews: Map<string, GroundedFileReview>, cap: number, stats: BatchParseStats) {
  for (const [path, review] of reviews) {
    if (review.comments.length <= cap) continue;

    const ranked = [...review.comments].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
    const dropped = ranked.slice(cap);
    stats.overCap += dropped.length;

    // groundParsedFindings may have appended this header already; extend rather than repeat it.
    const header = '### Additional Comments (Off-diff)';
    const bullets = dropped.map((c) => `- **[over-cap] ${c.title}:** ${c.body}`).join('\n');
    reviews.set(path, {
      ...review,
      comments: ranked.slice(0, cap),
      fileSummary: review.fileSummary.includes(header)
        ? `${review.fileSummary}\n${bullets}`
        : `${review.fileSummary}\n\n${header}\n${bullets}`,
    });
  }
}

// Throws when nothing recognisable comes back, so the chain falls to the next model rather than marking the whole bin clean.
export function parseBatchReviewResponse(
  raw: string,
  files: readonly FileDiff[],
  options?: { deniedClaimTypes?: readonly ClaimType[]; maxCommentsPerFile?: number },
): BatchReviewResult {
  const stats: BatchParseStats = {
    unroutableEntries: 0, pathMismatchFindings: 0, ambiguousAcrossBin: 0,
    flatFallback: 0, overCap: 0, entriesReturned: 0,
  };
  const payload = parseRawBatchPayload(raw);
  const reviews = new Map<string, GroundedFileReview>();
  const ambiguity: Ambiguity = { index: buildBinAmbiguityIndex(files), stats: { ambiguousAcrossBin: 0 } };
  const claimed = new Set<string>();

  const ground = (file: FileDiff, entry: RawEntry, confidence: number | undefined) =>
    reviews.set(file.path, groundEntry(file, entry, options?.deniedClaimTypes, ambiguity, confidence, stats));

  if (payload.shape === 'flat') {
    // Single-file shape: route each finding by its own path, or a weak fallback model turns the whole bin into "unreviewed".
    stats.flatFallback = 1;
    stats.entriesReturned = 1;

    const byFile = new Map<string, typeof payload.data.findings>();
    for (const finding of payload.data.findings) {
      const reported = finding.code_location.absolute_file_path?.trim();
      // `claimed` stays empty here: findings share files, so claiming would starve the rest.
      const target = !reported && files.length === 1 ? files[0] : resolveEntryPath(reported ?? '', files, claimed);
      if (!target) {
        stats.unroutableEntries += 1;
        continue;
      }
      byFile.set(target.path, [...(byFile.get(target.path) ?? []), finding]);
    }

    for (const [path, findings] of byFile) {
      ground(files.find((f) => f.path === path)!, {
        findings,
        overall_correctness: payload.data.overall_correctness,
        // Batch-level summary is all there is here.
        overall_explanation: payload.data.overall_explanation,
      }, payload.data.overall_confidence_score);
    }
  } else {
    stats.entriesReturned = payload.data.files.length;
    for (const entry of payload.data.files) {
      const file = resolveEntryPath(entry.absolute_file_path, files, claimed);
      if (!file) {
        stats.unroutableEntries += 1;
        logger.warn('Batched review returned an entry for an unknown path', { reported: entry.absolute_file_path });
        continue;
      }
      claimed.add(file.path);
      ground(file, entry, entry.overall_confidence_score ?? payload.data.overall_confidence_score);
    }
  }

  stats.ambiguousAcrossBin = ambiguity.stats.ambiguousAcrossBin;
  // Defence: the grammar caps per file, but only binds on providers that enforce it.
  if (options?.maxCommentsPerFile) trimOverCap(reviews, generatorFindingCap(options.maxCommentsPerFile), stats);

  return { reviews, missing: files.filter((f) => !reviews.has(f.path)).map((f) => f.path), stats };
}
