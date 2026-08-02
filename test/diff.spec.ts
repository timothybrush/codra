import { 
  findPositionForLine, 
  filterReviewableFiles, 
  getValidNewLines, 
  parseUnifiedDiff,
  truncateFileDiff 
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
