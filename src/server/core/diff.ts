import picomatch from 'picomatch';
import type { RepoConfig } from '@shared/schema';

export type DiffLineKind = 'context' | 'add' | 'del';

export type DiffLine = {
  kind: DiffLineKind;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  position: number;
};

export type DiffHunk = {
  header: string;
  lines: DiffLine[];
};

export type FileDiff = {
  path: string;
  previousPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  lineCount: number;
  hunks: DiffHunk[];
  isTruncated?: boolean;
  originalLineCount?: number;
};

const defaultSkipMatchers = ['**/*.lock', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/*.min.js'].map((pattern) =>
  picomatch(pattern, { dot: true }),
);

export function isReviewableFile(path: string, customMatchers: ReturnType<typeof picomatch>[]) {
  if (defaultSkipMatchers.some((matcher) => matcher(path))) return false;
  if (customMatchers.some((matcher) => matcher(path))) return false;
  return true;
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
    if (currentFile) {
      files.push(currentFile);
    }
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
      const lastSpace = line.lastIndexOf(' ');
      const bPath = line.substring(lastSpace + 1);
      const path = bPath.startsWith('b/') ? bPath.slice(2) : bPath;

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
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!match) {
        continue;
      }

      oldLine = Number.parseInt(match[1], 10);
      newLine = Number.parseInt(match[2], 10);
      currentHunk = {
        header: line,
        lines: [],
      };
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

    if (prefix === ' ') {
      currentHunk.lines.push({
        kind: 'context',
        content: line.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: newLine,
        position,
      });
      oldLine += 1;
      newLine += 1;
      currentFile.lineCount += 1;
      continue;
    }

    if (prefix === '+') {
      currentHunk.lines.push({
        kind: 'add',
        content: line.slice(1),
        newLineNumber: newLine,
        position,
      });
      newLine += 1;
      currentFile.lineCount += 1;
      continue;
    }

    currentHunk.lines.push({
      kind: 'del',
      content: line.slice(1),
      oldLineNumber: oldLine,
      position,
    });
    oldLine += 1;
    currentFile.lineCount += 1;
  }

  pushCurrentFile();

  return files.filter((file) => file.path);
}

export function getValidNewLines(file: FileDiff) {
  return new Set(
    file.hunks.flatMap((hunk) =>
      hunk.lines
        .filter((line) => line.kind !== 'del' && line.newLineNumber !== undefined)
        .map((line) => line.newLineNumber as number),
    ),
  );
}

export function getValidPositions(file: FileDiff) {
  return new Set(
    file.hunks.flatMap((hunk) =>
      hunk.lines
        .filter((line) => line.kind !== 'del')
        .map((line) => line.position),
    ),
  );
}

export function findPositionForLine(file: FileDiff, lineNumber: number) {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLineNumber === lineNumber && line.kind !== 'del') {
        return line.position;
      }
    }
  }

  return undefined;
}

/*
 * `MAX_LINE_SNAP_DISTANCE` and `findClosestValidLine` used to live here, relocating a reported line
 * up to 3 lines to reach a real diff line.
 *
 * Both are gone because their only caller is gone. Findings are now anchored solely on a verbatim
 * evidence quote resolved against the diff, and a finding whose quote does not resolve is withheld
 * rather than relocated -- so there is no longer a reported line number left to snap. Reintroducing
 * a snap would mean reintroducing the line-number-first anchoring it replaced.
 */

/**
 * Narrows a parsed diff to the files worth reviewing.
 *
 * `maxFiles` is passed in rather than read from the repo config: it is an instance-wide budget
 * (see reviewSettingsSchema.maxFiles), because what it protects -- the per-invocation subrequest
 * ceiling and the model provider's rate limit -- is shared across every repository.
 *
 * Returns `skipped`, the count discarded purely for exceeding the cap, so callers can say "100
 * of 106" instead of silently reviewing part of a pull request and reporting it as complete.
 */
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

export function truncateFileDiff(file: FileDiff, maxLines: number): FileDiff {
  if (file.lineCount <= maxLines) {
    return file;
  }

  let currentLines = 0;
  const keptHunks: DiffHunk[] = [];

  for (const hunk of file.hunks) {
    const remainingLines = maxLines - currentLines;
    if (remainingLines <= 0) {
      break;
    }

    if (hunk.lines.length <= remainingLines) {
      keptHunks.push(hunk);
      currentLines += hunk.lines.length;
      continue;
    }

    keptHunks.push({
      ...hunk,
      lines: hunk.lines.slice(0, remainingLines),
    });
    currentLines += remainingLines;
    break;
  }

  return {
    ...file,
    hunks: keptHunks,
    lineCount: currentLines,
    isTruncated: true,
    originalLineCount: file.lineCount,
  };
}

export function chunkFileDiff(file: FileDiff, maxLinesPerChunk: number): FileDiff[] {
  if (file.lineCount <= maxLinesPerChunk) {
    return [file];
  }

  const chunks: FileDiff[] = [];
  let currentHunks: DiffHunk[] = [];
  let currentLines = 0;

  for (const hunk of file.hunks) {
    let linesRemainingInHunk = hunk.lines;

    while (linesRemainingInHunk.length > 0) {
      const roomInChunk = maxLinesPerChunk - currentLines;

      if (roomInChunk <= 0) {
        chunks.push({
          ...file,
          hunks: currentHunks,
          lineCount: currentLines,
          isTruncated: true,
          originalLineCount: file.lineCount,
        });
        currentHunks = [];
        currentLines = 0;
        continue;
      }

      if (linesRemainingInHunk.length <= roomInChunk) {
        currentHunks.push({
          ...hunk,
          lines: linesRemainingInHunk,
        });
        currentLines += linesRemainingInHunk.length;
        linesRemainingInHunk = [];
      } else {
        currentHunks.push({
          ...hunk,
          lines: linesRemainingInHunk.slice(0, roomInChunk),
        });
        currentLines += roomInChunk;
        linesRemainingInHunk = linesRemainingInHunk.slice(roomInChunk);
      }
    }
  }

  if (currentHunks.length > 0) {
    chunks.push({
      ...file,
      hunks: currentHunks,
      lineCount: currentLines,
      isTruncated: true,
      originalLineCount: file.lineCount,
    });
  }

  return chunks;
}
