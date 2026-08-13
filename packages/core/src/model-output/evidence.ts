import { foldEvidenceText } from '../fingerprint';
import type { DiffLine, FileDiff } from '../diff';

export const MIN_DISCRIMINATING_EVIDENCE_CHARS = 8;

export type EvidenceIndex = {
  byContent: Map<string, DiffLine[]>;
  lines: { normalized: string; line: DiffLine }[];
};

export function buildEvidenceIndex(file: FileDiff): EvidenceIndex {
  const byContent = new Map<string, DiffLine[]>();
  const lines: { normalized: string; line: DiffLine }[] = [];

  for (const hunk of file.hunks) {
    const postable = hunk.lines.filter((line) => line.kind !== 'del' && line.newLineNumber !== undefined);
    if (postable.length === 0) continue;

    hunk.lines.forEach((line, lineIndex) => {
      const normalized = foldEvidenceText(line.content);
      if (!normalized) return;

      let anchor = line;
      if (line.kind === 'del' || line.newLineNumber === undefined) {
        anchor = hunk.lines.slice(lineIndex + 1).find((l) => l.kind !== 'del' && l.newLineNumber !== undefined)
          ?? hunk.lines.slice(0, lineIndex).reverse().find((l) => l.kind !== 'del' && l.newLineNumber !== undefined)
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

export function foldFirstEvidenceLine(evidence: unknown): string | null {
  if (typeof evidence !== 'string') return null;
  return evidence.split('\n').map(foldEvidenceText).find((l) => l.length > 0) ?? null;
}

export type BinAmbiguityIndex = Map<string, number>;

export function buildBinAmbiguityIndex(files: readonly FileDiff[]): BinAmbiguityIndex {
  const filesPerLine = new Map<string, Set<string>>();

  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        const normalized = foldEvidenceText(line.content);
        if (normalized.length < MIN_DISCRIMINATING_EVIDENCE_CHARS) continue;
        const paths = filesPerLine.get(normalized);
        if (paths) paths.add(file.path);
        else filesPerLine.set(normalized, new Set([file.path]));
      }
    }
  }

  const index: BinAmbiguityIndex = new Map();
  for (const [normalized, paths] of filesPerLine) {
    if (paths.size > 1) index.set(normalized, paths.size);
  }
  return index;
}

export type EvidenceResolution =
  | { status: 'absent' }
  | { status: 'weak' }
  | { status: 'matched'; line: DiffLine }
  | { status: 'unmatched' };

export function resolveEvidence(
  evidence: unknown,
  index: EvidenceIndex,
  reportedLine: number | undefined,
): EvidenceResolution {
  if (typeof evidence !== 'string') return { status: 'absent' };

  const firstLine = foldFirstEvidenceLine(evidence);
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

  const contained = index.lines.flatMap(({ normalized, line }) =>
    normalized.length >= MIN_DISCRIMINATING_EVIDENCE_CHARS
    && (normalized.includes(firstLine) || firstLine.includes(normalized))
      ? [line]
      : []);
  if (contained.length > 0) return { status: 'matched', line: nearest(contained) };

  return { status: 'unmatched' };
}
