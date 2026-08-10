// Groups small files into shared model calls, the inverse of chunkFileDiff, so a 4-line file does not pay the full ~2,800-token preamble.
import { renderFileDiff } from '@server/prompts/file-review';
import type { FileDiff } from '../diff';

// Above this a file is reviewed alone -- it already amortises its own preamble.
export const PACKABLE_MAX_DIFF_LINES = 150;
// Lowered from 400 after a 383-line bin came back with a file missing from the response entirely
// (the model ran out of room and silently dropped one) and took 77s doing it. Omission is the
// expensive failure here: the file is re-queued and reviewed again from scratch, so the calls the
// larger bin "saved" get spent back, and every file in that bin waits out the long call first.
export const BIN_TARGET_DIFF_LINES = 300;
// Blast radius and attention: per-file recall degrades before the token budget runs out.
export const BIN_MAX_FILES = 6;
export const BIN_DIFF_CHAR_BUDGET = 24_000;

export type ReviewUnit =
  | { kind: 'single'; file: FileDiff }
  | { kind: 'bin'; files: FileDiff[]; diffLineCount: number; diffChars: number };

export type LedgerEntry = { handled: boolean; transientErrorCount: number };

export function unitFiles(unit: ReviewUnit): FileDiff[] {
  return unit.kind === 'single' ? [unit.file] : unit.files;
}

// The exact renderer the prompt uses; any other estimate drifts.
const measure = (file: FileDiff) => renderFileDiff(file).length;

// A one-file bin is a single file with scaffolding it does not need.
const asBin = (files: FileDiff[]): ReviewUnit => (files.length === 1
  ? { kind: 'single', file: files[0] }
  : {
    kind: 'bin',
    files,
    diffLineCount: files.reduce((sum, f) => sum + f.lineCount, 0),
    diffChars: files.reduce((sum, f) => sum + measure(f), 0),
  });

// Takes the FULL file list, never the remainder: bin membership isn't persisted, so resumption re-derives this plan and narrows it with narrowUnit.
export function planReviewUnits(files: readonly FileDiff[], opts: { enabled: boolean }): ReviewUnit[] {
  if (!opts.enabled) return files.map((file) => ({ kind: 'single', file }));

  const units: ReviewUnit[] = [];
  let open: FileDiff[] = [];
  let lines = 0;
  let chars = 0;

  const close = () => {
    if (open.length > 0) units.push(asBin(open));
    open = [];
    lines = 0;
    chars = 0;
  };

  for (const file of files) {
    const fileChars = measure(file);
    // Both ceilings: 150 short lines and 150 minified ones are not the same prompt.
    if (file.lineCount > PACKABLE_MAX_DIFF_LINES || fileChars > BIN_DIFF_CHAR_BUDGET) {
      // Emitted in place, so the plan preserves input order.
      close();
      units.push({ kind: 'single', file });
      continue;
    }

    if (open.length > 0 && (
      lines + file.lineCount > BIN_TARGET_DIFF_LINES
      || chars + fileChars > BIN_DIFF_CHAR_BUDGET
      || open.length >= BIN_MAX_FILES
    )) close();

    open.push(file);
    lines += file.lineCount;
    chars += fileChars;
  }

  close();
  return units;
}

// Applies the ledger, returning the units still needing review. A list, because a previously failed bin de-escalates into singles rather than re-forming on every retry.
export function narrowUnit(unit: ReviewUnit, ledger: Map<string, LedgerEntry>): ReviewUnit[] {
  const outstanding = unitFiles(unit).filter((file) => !ledger.get(file.path)?.handled);
  if (outstanding.length === 0) return [];

  const failedBefore = outstanding.some((file) => (ledger.get(file.path)?.transientErrorCount ?? 0) > 0);
  if (failedBefore) return outstanding.map((file): ReviewUnit => ({ kind: 'single', file }));

  return [asBin(outstanding)];
}
