import {
  chunkFileDiff,
  filterReviewableFiles,
  findPositionForLine,
  getValidNewLines,
  parseDiffHeaderPath,
  parseUnifiedDiff,
  truncateFileDiff,
} from '@server/core/diff';
import { defaultRepoConfig } from '@shared/schema';

describe('Diff Engine Deep Dive', () => {
  const sampleDiff = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,4 @@
 const answer = 41;
+const next = answer + 1;
 export function value() {
   return answer;
 }`;

  describe('parseUnifiedDiff', () => {
    it('tracks new lines and GitHub positions for standard diffs', () => {
      const [file] = parseUnifiedDiff(sampleDiff);
      expect(file.path).toBe('src/example.ts');
      expect(file.lineCount).toBe(5);
      expect(getValidNewLines(file)).toEqual(new Set([1, 2, 3, 4, 5]));
      expect(findPositionForLine(file, 2)).toBe(2);
    });

    it('correctly handles file renames', () => {
      const renameDiff = `diff --git a/old-name.ts b/new-name.ts
similarity index 100%
rename from old-name.ts
rename to new-name.ts
`;
      const [file] = parseUnifiedDiff(renameDiff);
      expect(file.path).toBe('new-name.ts');
      expect(file.previousPath).toBe('old-name.ts');
    });

    it('identifies new file creations', () => {
      const newFileDiff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,1 @@
+console.log("hello");
`;
      const [file] = parseUnifiedDiff(newFileDiff);
      expect(file.isNew).toBe(true);
      expect(file.path).toBe('new.ts');
    });

    it('identifies deleted files', () => {
      const deleteDiff = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index 1234567..0000000
--- a/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-console.log("bye");
`;
      const [file] = parseUnifiedDiff(deleteDiff);
      expect(file.isDeleted).toBe(true);
    });

    it('gracefully skips binary files', () => {
      const binaryDiff = `diff --git a/image.png b/image.png
index 1234567..890abcd 100644
Binary files a/image.png and b/image.png differ
`;
      const [file] = parseUnifiedDiff(binaryDiff);
      expect(file.isBinary).toBe(true);
      expect(file.path).toBe('image.png');
    });

    it('handles malformed hunk headers without crashing', () => {
      const malformedDiff = `diff --git a/broken.ts b/broken.ts
--- a/broken.ts
+++ b/broken.ts
@@ invalid hunk header @@
+broken
`;
      const files = parseUnifiedDiff(malformedDiff);
      expect(files).toHaveLength(1);
      expect(files[0].hunks).toHaveLength(0);
    });
  });

  describe('truncateFileDiff', () => {
    it('truncates large files to the specified line limit', () => {
      const largeFile = {
        path: 'large.ts',
        previousPath: null,
        isNew: false,
        isDeleted: false,
        isBinary: false,
        lineCount: 100,
        hunks: [
          { header: '@@ -1,50 +1,50 @@', lines: Array(50).fill({ kind: 'add', content: 'line', position: 1 }) },
          { header: '@@ -51,100 +51,100 @@', lines: Array(50).fill({ kind: 'add', content: 'line', position: 51 }) },
        ],
      } as any;

      const truncated = truncateFileDiff(largeFile, 60);
      expect(truncated.isTruncated).toBe(true);
      expect(truncated.hunks).toHaveLength(2);
      expect(truncated.hunks[1].lines).toHaveLength(10);
      expect(truncated.lineCount).toBe(60);
    });

    it('slices a single oversized hunk to the line limit', () => {
      const largeFile = {
        path: 'large.ts',
        previousPath: null,
        isNew: false,
        isDeleted: false,
        isBinary: false,
        lineCount: 500,
        hunks: [
          { header: '@@ -1,500 +1,500 @@', lines: Array(500).fill({ kind: 'add', content: 'line', position: 1 }) },
        ],
      } as any;

      const truncated = truncateFileDiff(largeFile, 300);
      expect(truncated.isTruncated).toBe(true);
      expect(truncated.hunks).toHaveLength(1);
      expect(truncated.hunks[0].lines).toHaveLength(300);
      expect(truncated.lineCount).toBe(300);
    });
  });

  // chunkFileDiff decides how much of a large file any model ever sees; a silent partition bug means
  // whole regions go unreviewed with nothing to report it. Invariant: every original line appears in
  // exactly one chunk, in order. Truncation is allowed; losing a line in the middle is not.
  describe('chunkFileDiff', () => {
    // Distinct content per line so a dropped or duplicated line is detectable - Array(n).fill(sameObject)
    // would hide exactly the bug this is looking for.
    const fileOf = (hunkSizes: number[]) => {
      let n = 0;
      return {
        path: 'large.ts',
        previousPath: null,
        isNew: false,
        isDeleted: false,
        isBinary: false,
        lineCount: hunkSizes.reduce((a, b) => a + b, 0),
        hunks: hunkSizes.map((size, h) => ({
          header: `@@ hunk${h} @@`,
          lines: Array.from({ length: size }, () => {
            n += 1;
            return { kind: 'add', content: `line ${n}`, newLineNumber: n, position: n };
          }),
        })),
      } as any;
    };

    const linesOf = (files: any[]) => files.flatMap((f) => f.hunks.flatMap((h: any) => h.lines));

    it('returns the file untouched when it fits, without marking it truncated', () => {
      const file = fileOf([40]);
      const chunks = chunkFileDiff(file, 100);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(file);
      expect(chunks[0].isTruncated).toBeUndefined();
    });

    it('partitions every line exactly once, in order, across chunk boundaries', () => {
      const file = fileOf([50, 50, 50]);
      const chunks = chunkFileDiff(file, 40);

      const partitioned = linesOf(chunks);
      expect(partitioned).toHaveLength(150);
      expect(partitioned.map((l) => l.content)).toEqual(linesOf([file]).map((l) => l.content));
    });

    it('splits a single hunk larger than the cap, keeping the hunk header on both halves', () => {
      // Without the header the model cannot resolve line numbers for the second half's findings.
      const chunks = chunkFileDiff(fileOf([100]), 40);
      expect(chunks).toHaveLength(3);
      for (const chunk of chunks) {
        expect(chunk.hunks.every((h: any) => h.header === '@@ hunk0 @@')).toBe(true);
      }
      expect(chunks.map((c) => c.lineCount)).toEqual([40, 40, 20]);
    });

    it('never exceeds the cap, and reports lineCount that matches the lines actually carried', () => {
      const chunks = chunkFileDiff(fileOf([13, 71, 5, 44]), 30);
      for (const chunk of chunks) {
        const actual = chunk.hunks.reduce((sum: number, h: any) => sum + h.lines.length, 0);
        expect(chunk.lineCount).toBe(actual);
        expect(actual).toBeLessThanOrEqual(30);
        expect(actual).toBeGreaterThan(0);
      }
    });

    it('carries the original line count on every chunk so truncation is reportable', () => {
      const chunks = chunkFileDiff(fileOf([90]), 25);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.originalLineCount).toBe(90);
        expect(chunk.isTruncated).toBe(true);
      }
    });

    // The MAX_CHUNKS cap in reviewFile is what makes this the load-bearing number: at 800 lines/chunk,
    // 4 chunks meant any file over 3,200 diff lines was silently cut off. src/server/core/review.ts
    // changed 3,749 lines in PR #55, so ~15% of the largest file in the PR reached no model at all.
    it('produces more than four chunks for a file the size of the largest in PR #55', () => {
      expect(chunkFileDiff(fileOf([3_749]), 800).length).toBeGreaterThan(4);
    });
  });

  describe('filterReviewableFiles', () => {
    it('applies complex exclusion patterns', () => {
      const files = [
        { path: 'src/main.ts', isDeleted: false, isBinary: false, isNew: false, hunks: [] },
        { path: 'dist/bundle.js', isDeleted: false, isBinary: false, isNew: false, hunks: [] },
        { path: 'src/test.spec.ts', isDeleted: false, isBinary: false, isNew: false, hunks: [] },
      ] as any;

      const config = {
        ...defaultRepoConfig.review,
        skip_files: ['dist/**', '**/*.spec.ts'],
      };

      const filtered = filterReviewableFiles(files, config, 150);
      expect(filtered.files).toHaveLength(1);
      expect(filtered.files[0].path).toBe('src/main.ts');
      expect(filtered.skipped).toBe(0);
    });

    it('respects the file limit and reports how many it left out', () => {
      const manyFiles = Array(20).fill(0).map((_, i) => ({
        path: `file${i}.ts`, isDeleted: false, isBinary: false, isNew: false, hunks: []
      })) as any;

      const filtered = filterReviewableFiles(manyFiles, defaultRepoConfig.review, 5);
      expect(filtered.files).toHaveLength(5);
      // Callers need this to say "5 of 20" instead of silently reviewing part of a PR.
      expect(filtered.skipped).toBe(15);
    });

    it('does not count files excluded by skip patterns as skipped-for-limit', () => {
      const files = [
        { path: 'src/main.ts', isDeleted: false, isBinary: false, isNew: false, hunks: [] },
        { path: 'dist/bundle.js', isDeleted: false, isBinary: false, isNew: false, hunks: [] },
      ] as any;

      const filtered = filterReviewableFiles(files, defaultRepoConfig.review, 150);
      expect(filtered.files).toHaveLength(1);
      expect(filtered.skipped).toBe(0);
    });
  });
});

describe('diff --git header paths', () => {
  const header = (line: string) => parseDiffHeaderPath(line);

  it('reads an ordinary path', () => {
    expect(header('diff --git a/src/app.ts b/src/app.ts')).toBe('src/app.ts');
  });

  // Git does not quote spaces in this header. Splitting on the last space produced `file.ts`, a path
  // not in the PR, so GitHub rejected the whole review with a 422 and every inline comment was lost.
  it('reads a path containing spaces', () => {
    expect(header('diff --git a/src/my file.ts b/src/my file.ts')).toBe('src/my file.ts');
    expect(header('diff --git a/docs/release notes.md b/docs/release notes.md')).toBe('docs/release notes.md');
  });

  // Two such files sharing a last token collapsed to one path, desynchronising the file count from
  // the review count and wedging the job in a review -> finalize loop.
  it('keeps two space-named files distinct', () => {
    expect(header('diff --git a/docs/release notes.md b/docs/release notes.md'))
      .not.toBe(header('diff --git a/spec/api notes.md b/spec/api notes.md'));
  });

  it('takes the b-side on a rename', () => {
    expect(header('diff --git a/old name.ts b/new name.ts')).toBe('new name.ts');
  });

  // The symmetric split resolves even a filename that itself contains " b/".
  it('reads a path containing a literal b/ segment', () => {
    expect(header('diff --git a/a b/b b/a b/b')).toBe('a b/b');
  });

  it('parses a full diff with a spaced path end to end', () => {
    const [file] = parseUnifiedDiff([
      'diff --git a/src/my file.ts b/src/my file.ts',
      '--- a/src/my file.ts',
      '+++ b/src/my file.ts',
      '@@ -0,0 +1 @@',
      '+console.log(1);',
    ].join('\n'));
    expect(file.path).toBe('src/my file.ts');
    expect(file.hunks[0].lines[0].content).toBe('console.log(1);');
  });
});
