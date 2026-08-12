// Groups small files into shared model calls, the inverse of chunkFileDiff, so a 4-line file does not pay the full ~2,800-token preamble.
import { renderFileDiff } from '../prompts/file-review';
import type { FileDiff } from '../diff';

// Above this a file is reviewed alone -- it already amortises its own preamble.
export const PACKABLE_MAX_DIFF_LINES = 150;
// Lowered from 400 after a 383-line bin came back with a file missing from the response entirely
// (the model ran out of room and silently dropped one) and took 77s doing it. Omission is the
// expensive failure here: the file is re-queued and reviewed again from scratch, so the calls the
// larger bin "saved" get spent back, and every file in that bin waits out the long call first.
export const BIN_TARGET_DIFF_LINES = 300;
// Blast radius and attention: per-file recall degrades before the token budget runs out.
//
// 6 -> 3 -> 2, each step on measurement rather than intuition, and the last step on the only design
// that survives contact with these models: PAIRED. The same unchanged prompt scored 36.1% and 44.9% in
// two sessions hours apart, so cross-time comparisons at this effect size are worthless -- every arm
// below ran in the same block as its own baseline, back to back, and is differenced within that block.
//
//   3 files/call -> 2   gemini-3.5-flash-lite  +11.1 pts recall (SE 2.7, t=4.15, 8 blocks)
//                       gemini-2.5-flash       +12.1 pts recall (SE 1.4, t=8.88, 4 blocks)
//
// Precision stayed at 100% on both models at bin 2, so the gain is defects that were previously never
// mentioned, not extra noise. Going further to ONE file per call did not extend the gain (+2.9 pts
// against bin 3, i.e. worse than bin 2) while tripling the call count, so 2 is the knee of the curve.
// Two things that look like they should help do NOT, once paired: raising max_comments (-2.1 pts here,
// and it costs precision on the stronger model) and adding custom repo rules (+1.4, t=0.56 -- an
// earlier unpaired sweep put this at +7.0, which was drift).
//
// The cost is paid in subrequests, not tokens per finding: each call re-sends the ~2,800-token preamble,
// and on the Workers Free 50-subrequests-per-invocation ceiling a smaller bin means more continuations
// per job, which phase-control already handles but which shows up as wall clock.
//
// The value is nonetheless set ABOVE the measured knee, at 4, trading the recall the table above
// quantifies for a quarter of the model calls that bin 2 would spend on the same diff. Bin 2 is the
// recall-optimal setting and the table stands; if the subrequest pressure that motivated 4 goes away,
// this should go back down rather than being re-derived from scratch.
export const BIN_MAX_FILES = 4;
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
