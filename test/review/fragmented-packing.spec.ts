import { describe, expect, it } from 'vitest';
import { planReviewUnits, unitFiles } from '@server/core/review';
import { wantsFileContext } from '@server/prompts/file-review';
import { filterReviewableFiles } from '@server/core/diff';
import { defaultRepoConfig } from '@codraoss/schema';
import type { FileDiff } from '@server/core/diff';

// Bins deliberately get no whole-file context: they exist to save subrequests, and four extra GitHub
// fetches per bin inverts that. The alternative is to pull the one kind of file that suffers most from
// diff-only review -- mid-size, changes scattered across many small hunks -- out of its bin, where the
// existing single-file path already fetches context for it.

function file(path: string, opts: { hunks: number; linesPerHunk: number; isNew?: boolean }): FileDiff {
  let line = 0;
  return {
    path,
    previousPath: null,
    isNew: opts.isNew ?? false,
    isDeleted: false,
    isBinary: false,
    lineCount: opts.hunks * opts.linesPerHunk,
    hunks: Array.from({ length: opts.hunks }, (_, h) => ({
      header: `@@ -${h * 20},${opts.linesPerHunk} +${h * 20},${opts.linesPerHunk} @@`,
      lines: Array.from({ length: opts.linesPerHunk }, () => {
        line += 1;
        return { kind: 'add' as const, content: `const value${line} = ${line};`, newLineNumber: line, position: line };
      }),
    })),
  };
}

/** Scattered across many hunks, but small enough that packing would otherwise take it. */
const fragmented = () => file('src/scattered.ts', { hunks: 6, linesPerHunk: 12 });
/** Same size, changes in one place. */
const concentrated = () => file('src/focused.ts', { hunks: 2, linesPerHunk: 36 });

describe('fragmented files and bin packing', () => {
  it('packs a fragmented file normally when whole-file context is off', () => {
    const units = planReviewUnits([fragmented(), concentrated()], { enabled: true });

    expect(units).toHaveLength(1);
    expect(units[0].kind).toBe('bin');
    expect(unitFiles(units[0]).map((f) => f.path)).toEqual(['src/scattered.ts', 'src/focused.ts']);
  });

  it('pulls it out of the bin when context is on, and leaves the others alone', () => {
    const units = planReviewUnits([fragmented(), concentrated(), concentrated()], {
      enabled: true,
      fullFileContext: true,
    });

    const singles = units.filter((u) => u.kind === 'single');
    expect(singles).toHaveLength(1);
    expect(unitFiles(singles[0])[0].path).toBe('src/scattered.ts');
    // The concentrated files still share one call.
    expect(units.filter((u) => u.kind === 'bin')).toHaveLength(1);
  });

  // Promoting a file and then handing it nothing costs an extra model call and buys nothing, so the
  // two conditions have to agree.
  it('grants context to exactly the files it promotes', () => {
    expect(wantsFileContext(fragmented(), true)).toBe(true);
    expect(wantsFileContext(concentrated(), true)).toBe(false);
    expect(wantsFileContext(fragmented(), false)).toBe(false);
  });

  it('leaves trivial scattered edits in their bins', () => {
    // Six hunks, but only twelve lines in total -- a version bump repeated, not a change that hides
    // anything.
    const trivial = file('src/version.ts', { hunks: 6, linesPerHunk: 2 });

    expect(wantsFileContext(trivial, true)).toBe(false);
    expect(planReviewUnits([trivial, concentrated()], { enabled: true, fullFileContext: true })[0].kind).toBe('bin');
  });

  it('does not promote a new file, whose content is already the diff', () => {
    const added = file('src/added.ts', { hunks: 6, linesPerHunk: 12, isNew: true });

    expect(wantsFileContext(added, true)).toBe(false);
    const units = planReviewUnits([added, concentrated()], { enabled: true, fullFileContext: true });
    expect(units.filter((u) => u.kind === 'single')).toHaveLength(0);
  });
});

// Declared in the config schema since it was added, and enforced nowhere: a pull request under the
// file count could carry an unbounded amount of diff. It is the only knob that bounds total job input.
describe('max_total_diff_chars', () => {
  const wide = (path: string) => file(path, { hunks: 1, linesPerHunk: 40 });
  const review = (max: number) => ({ ...defaultRepoConfig.review, max_total_diff_chars: max });

  it('stops taking files once the budget is spent', () => {
    const files = [wide('a.ts'), wide('b.ts'), wide('c.ts')];
    const oneFile = files[0].hunks[0].lines.reduce((sum, l) => sum + l.content.length + 1, 0);

    const result = filterReviewableFiles(files, review(oneFile * 2), 50);

    expect(result.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(result.skipped).toBe(1);
  });

  it('keeps everything when the budget is generous', () => {
    const files = [wide('a.ts'), wide('b.ts'), wide('c.ts')];

    const result = filterReviewableFiles(files, review(1_000_000), 50);

    expect(result.files).toHaveLength(3);
    expect(result.skipped).toBe(0);
  });

  // A single oversized file is truncated by `max_diff_lines_per_file`, not dropped -- otherwise the
  // job reviews nothing at all and reports success.
  it('always keeps the first file, however large', () => {
    const result = filterReviewableFiles([wide('a.ts')], review(1), 50);

    expect(result.files.map((f) => f.path)).toEqual(['a.ts']);
    expect(result.skipped).toBe(0);
  });
});
