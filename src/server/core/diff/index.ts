import picomatch from 'picomatch';
import type { RepoConfig } from '@shared/schema';
import {
  type DiffLineKind,
  type DiffLine,
  type DiffHunk,
  type FileDiff,
  getValidNewLines,
  getValidPositions,
  findPositionForLine,
  truncateFileDiff,
  chunkFileDiff,
} from './position';

export {
  type DiffLineKind,
  type DiffLine,
  type DiffHunk,
  type FileDiff,
  getValidNewLines,
  getValidPositions,
  findPositionForLine,
  truncateFileDiff,
  chunkFileDiff,
};

const defaultSkipMatchers = ['**/*.lock', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/*.min.js'].map((pattern) =>
  picomatch(pattern, { dot: true }),
);

export function isReviewableFile(path: string, customMatchers: ReturnType<typeof picomatch>[]) {
  if (defaultSkipMatchers.some((matcher) => matcher(path))) return false;
  if (customMatchers.some((matcher) => matcher(path))) return false;
  return true;
}

// The b-side path from `diff --git a/<path> b/<path>`. Splitting on the LAST space breaks on `a/my file.ts b/my file.ts` (space in filename), which wedged jobs in a review -> finalize loop.
// A symmetric `a/X b/X` split handles spaces correctly since both sides match unless renamed; only a rename falls back to the first ` b/`.
export function parseDiffHeaderPath(line: string) {
  const rest = line.slice('diff --git '.length);

  if (rest.startsWith('a/')) {
    // len(X) for a symmetric "a/X b/X": total = 2 + n + 1 + 2 + n.
    const n = (rest.length - 5) / 2;
    if (Number.isInteger(n) && n > 0 && rest[2 + n] === ' ' && rest.startsWith('b/', 3 + n)) {
      const a = rest.slice(2, 2 + n);
      if (a === rest.slice(5 + n)) return a;
    }
  }

  const bStart = rest.indexOf(' b/', rest.startsWith('a/') ? 2 : 0);
  const bPath = bStart === -1 ? rest.slice(rest.lastIndexOf(' ') + 1) : rest.slice(bStart + 3);
  return bPath.startsWith('b/') ? bPath.slice(2) : bPath;
}

function parseHunkHeader(line: string): { oldLine: number; newLine: number } | null {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) {
    return null;
  }

  return {
    oldLine: Number.parseInt(match[1], 10),
    newLine: Number.parseInt(match[2], 10),
  };
}

function classifyDiffLine(prefix: ' ' | '+' | '-', content: string, oldLine: number, newLine: number, position: number): DiffLine {
  if (prefix === ' ') {
    return { kind: 'context', content, oldLineNumber: oldLine, newLineNumber: newLine, position };
  }

  if (prefix === '+') {
    return { kind: 'add', content, newLineNumber: newLine, position };
  }

  return { kind: 'del', content, oldLineNumber: oldLine, position };
}

function finishFile(files: FileDiff[], currentFile: FileDiff | null) {
  if (currentFile) {
    files.push(currentFile);
  }
}

export function parseUnifiedDiff(rawDiff: string, reviewConfig?: RepoConfig['review']): FileDiff[] {
  const files: FileDiff[] = [];
  const customMatchers = reviewConfig?.skip_files?.map((pattern) => picomatch(pattern, { dot: true })) ?? [];

  let currentFile: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let position = 0;
  let isIgnored = false;

  const pushCurrentFile = () => {
    finishFile(files, currentFile);
    currentFile = null;
    currentHunk = null;
    oldLine = 0;
    newLine = 0;
    position = 0;
    isIgnored = false;
  };

  let startIndex = 0;
  const length = rawDiff.length;

  while (startIndex < length) {
    let endIndex = rawDiff.indexOf('\n', startIndex);
    if (endIndex === -1) {
      endIndex = length;
    }

    let line = rawDiff.substring(startIndex, endIndex);
    if (line.charCodeAt(line.length - 1) === 13) {
      line = line.slice(0, -1);
    }

    startIndex = endIndex + 1;

    if (line.startsWith('diff --git ')) {
      pushCurrentFile();
      const path = parseDiffHeaderPath(line);

      currentFile = {
        path,
        previousPath: null,
        isNew: false,
        isDeleted: false,
        isBinary: false,
        lineCount: 0,
        hunks: [],
      };

      if (reviewConfig) {
        isIgnored = !isReviewableFile(path, customMatchers);
      }
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith('rename from ')) {
      currentFile.previousPath = line.slice(12);
      continue;
    }

    if (line.startsWith('rename to ')) {
      const nextPath = line.slice(10);
      currentFile.path = nextPath.startsWith('b/') ? nextPath.slice(2) : nextPath;
      if (reviewConfig) {
        isIgnored = !isReviewableFile(currentFile.path, customMatchers);
      }
      continue;
    }

    if (line.startsWith('new file mode ')) {
      currentFile.isNew = true;
      continue;
    }

    if (line.startsWith('deleted file mode ')) {
      currentFile.isDeleted = true;
      isIgnored = true;
      continue;
    }

    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      currentFile.isBinary = true;
      isIgnored = true;
      continue;
    }

    if (line.startsWith('+++ ')) {
      const nextPath = line.slice(4);
      currentFile.path = nextPath.startsWith('b/') ? nextPath.slice(2) : nextPath;
      if (reviewConfig) {
        isIgnored = !isReviewableFile(currentFile.path, customMatchers);
      }
      continue;
    }

    if (isIgnored) {
      continue;
    }

    if (line.startsWith('--- ')) {
      continue;
    }

    if (line.startsWith('@@ ')) {
      const header = parseHunkHeader(line);
      if (!header) {
        continue;
      }

      oldLine = header.oldLine;
      newLine = header.newLine;
      currentHunk = { header: line, lines: [] };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    const prefix = line[0];
    if (prefix !== ' ' && prefix !== '+' && prefix !== '-') {
      continue;
    }

    position += 1;
    const diffLine = classifyDiffLine(prefix, line.slice(1), oldLine, newLine, position);
    currentHunk.lines.push(diffLine);
    currentFile.lineCount += 1;

    if (diffLine.kind !== 'del') newLine += 1;
    if (diffLine.kind !== 'add') oldLine += 1;
  }

  pushCurrentFile();

  return files.filter((file) => file.path);
}

// One entry of GitHub's `/pulls/{n}/files` response, narrowed to what we use.
export type GitHubDiffFileEntry = {
  filename: string;
  previous_filename?: string | null;
  status?: string;
  // Absent for binary files and ones GitHub considers too large to patch.
  patch?: string | null;
};

// Rebuilds unified-diff text from GitHub's per-file JSON, because the diff media type returns 406 `too_large` past 20,000 lines with nothing to retry. Emitting text keeps `parseUnifiedDiff` the one format reader everywhere.
// Headers match real git output, including the mode lines that set `isNew`/`isDeleted` (`/dev/null` alone would not).
export function buildUnifiedDiffFromFiles(files: GitHubDiffFileEntry[]): string {
  const out: string[] = [];

  for (const file of files) {
    const newPath = file.filename;
    const oldPath = file.previous_filename || file.filename;
    const isAdded = file.status === 'added';
    const isRemoved = file.status === 'removed';

    out.push(`diff --git a/${oldPath} b/${newPath}`);
    if (isAdded) out.push('new file mode 100644');
    if (isRemoved) out.push('deleted file mode 100644');
    if (file.previous_filename && file.previous_filename !== newPath) {
      out.push(`rename from ${file.previous_filename}`);
      out.push(`rename to ${newPath}`);
    }

    // No patch means binary or declined. Say so in the form the parser knows, or the file silently disappears and reads as reviewed-and-clean.
    if (!file.patch) {
      out.push(`Binary files a/${oldPath} and b/${newPath} differ`);
      continue;
    }

    out.push(isAdded ? '--- /dev/null' : `--- a/${oldPath}`);
    out.push(isRemoved ? '+++ /dev/null' : `+++ b/${newPath}`);
    out.push(file.patch);
  }

  return out.length > 0 ? `${out.join('\n')}\n` : '';
}

// `maxFiles` is passed in, not read from repo config, because the subrequest ceiling and provider rate limit it protects are instance-wide, shared across repositories.
// Returns `skipped` so callers can say "100 of 106" instead of reporting a partial review as complete.
export function filterReviewableFiles(
  files: FileDiff[],
  config: RepoConfig['review'],
  maxFiles: number,
): { files: FileDiff[]; skipped: number } {
  const customMatchers = config.skip_files.map((pattern) => picomatch(pattern, { dot: true }));

  const reviewable = files
    .filter((file) => !file.isDeleted && !file.isBinary)
    .filter((file) => !defaultSkipMatchers.some((matcher) => matcher(file.path)))
    .filter((file) => !customMatchers.some((matcher) => matcher(file.path)))
    .sort((left, right) => Number(left.isNew) - Number(right.isNew) || left.path.localeCompare(right.path));

  return {
    files: reviewable.slice(0, maxFiles),
    skipped: Math.max(0, reviewable.length - maxFiles),
  };
}
