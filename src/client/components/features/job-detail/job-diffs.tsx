import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileDiff as FileDiffIcon,
  FileText,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  Info,
} from 'lucide-react';
import { Badge, StatusBadge } from '@client/components/ui/badge';
import { api } from '@client/lib/api';
import { buildTree, type TreeNode } from '@client/lib/file-tree';
import { parsePromptDiff, diffStats, type DiffRow } from '@client/lib/prompt-diff';
import { highlightLine, langForPath } from '@client/lib/highlight';
import { cn } from '@client/lib/utils';
import type { FileReviewRecord, JobDetail, ParsedReviewComment } from '@shared/schema';
import { CommentCard } from './comment-card';

/* diff_input isn't persisted in Postgres (reconstructed on demand from KV/GitHub — see
   GET /api/jobs/:id/diffs), so it's fetched lazily the moment this tab actually mounts and
   session-cached per job so switching tabs back and forth doesn't refetch. */
function readDiffsCache(jobId: string): Record<string, string> | null {
  try {
    const raw = sessionStorage.getItem(`codra:job-diffs:${jobId}`);
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

function writeDiffsCache(jobId: string, diffs: Record<string, string>) {
  try {
    const payload = JSON.stringify(diffs);
    // Serializing multi-MB diffs janks the main thread and evicts everything else
    // in sessionStorage; giant PRs just refetch (the server-side KV cache is warm).
    if (payload.length > 2_000_000) return;
    sessionStorage.setItem(`codra:job-diffs:${jobId}`, payload);
  } catch {
    /* quota exceeded / unavailable — skip */
  }
}

/** A file present in the PR diff that has no review row (yet) — e.g. the job is
    still running, or the file was skipped. Shown like GitHub shows every changed
    file, with a "pending" status instead of review results. */
function syntheticFileReview(jobId: string, filePath: string, diffInput: string): FileReviewRecord {
  return {
    id: `diff-only:${filePath}`,
    jobId,
    filePath,
    fileStatus: 'pending',
    modelUsed: '',
    diffLineCount: null,
    diffInput,
    rawAiOutput: null,
    parsedComments: [],
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
    verdict: null,
    fileSummary: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
  };
}

/* Diffs longer than this render only the first PREVIEW_ROWS lines with a
   "Show full diff" control (GitHub-style truncation), so a huge PR never dumps
   tens of thousands of rows into the DOM at once. Files carrying review
   comments are never truncated (anchors must stay visible). */
const LARGE_DIFF_ROWS = 300;
const PREVIEW_ROWS = 150;

/* Above this many files, only files with review comments start expanded —
   the tree is the navigation surface, so a huge PR opens as a short page. */
const AUTO_EXPAND_FILE_LIMIT = 8;

/* Row height used to estimate a panel's rendered size before it first paints. */
const DIFF_ROW_PX = 20;

/* Offscreen file panels skip layout/paint entirely; the placeholder height keeps
   the scrollbar honest ('auto' remembers the real height once rendered, the
   estimate covers it before that). An accurate per-file estimate — derived from
   the diff's own line count, capped at the preview size — keeps the page height
   stable while scrolling instead of "growing" as panels come into view. */
function panelCvStyle(open: boolean, lineEstimate: number): CSSProperties {
  const body = open ? Math.min(lineEstimate, PREVIEW_ROWS) * DIFF_ROW_PX + 140 : 0;
  return {
    contentVisibility: 'auto',
    containIntrinsicSize: `auto ${46 + body}px`,
  };
}

function fileAnchorId(id: string) {
  return `diff-file-${id}`;
}

/* ── Diff rows ────────────────────────────────────────────────── */

const ROW_TONES: Record<DiffRow['kind'], { row: string; gutter: string; marker: string }> = {
  add:  { row: 'diff-add', gutter: 'diff-add-fg', marker: 'diff-add-fg' },
  del:  { row: 'diff-del', gutter: 'diff-del-fg', marker: 'diff-del-fg' },
  ctx:  { row: '',         gutter: 'text-ui-subtle/60', marker: 'text-transparent' },
  hunk: { row: 'ui-well',  gutter: '',           marker: '' },
};

function DiffLine({ row, lang }: { row: DiffRow; lang: ReturnType<typeof langForPath> }) {
  const tone = ROW_TONES[row.kind];

  if (row.kind === 'hunk') {
    return (
      <div className="ui-well flex">
        <span className="w-[52px] shrink-0" />
        <span className="ui-font-mono whitespace-pre px-3 py-1 text-[11px] leading-5 text-ui-subtle">
          {row.text}
        </span>
      </div>
    );
  }

  // Single line-number column: new-file number for additions/context, old-file
  // number for deletions.
  const num = row.newNo ?? row.oldNo;

  return (
    <div className={cn('flex', tone.row)}>
      <span className={cn('ui-font-mono w-[52px] shrink-0 select-none px-2 text-right text-[11px] leading-5 tabular-nums', tone.gutter)}>
        {num ?? ''}
      </span>
      <span className={cn('ui-font-mono w-4 shrink-0 select-none text-center text-[11px] leading-5', tone.marker)}>
        {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
      </span>
      <span className="ui-font-mono whitespace-pre pr-4 text-[11px] leading-5 text-ui-default">
        {highlightLine(row.text, lang)}
      </span>
    </div>
  );
}

/* ── Per-file diff card ───────────────────────────────────────── */

interface FileDiffProps {
  file: FileReviewRecord;
  open: boolean;
  viewed: boolean;
  /** The job's diffs are still being fetched (see JobDiffs) — don't yet claim "no diff saved". */
  diffsLoading?: boolean;
  onOpenChange: (open: boolean) => void;
  onToggleViewed: (viewed: boolean) => void;
}

const NO_ROWS: DiffRow[] = [];

function FileDiff({ file, open, viewed, diffsLoading = false, onOpenChange, onToggleViewed }: FileDiffProps) {
  const lang = useMemo(() => langForPath(file.filePath), [file.filePath]);
  // Header stats come from a cheap line scan; the full row parse only happens once
  // the panel is actually open — collapsed files cost almost nothing.
  const { adds, dels } = useMemo(() => diffStats(file.diffInput), [file.diffInput]);
  const rows = useMemo(
    () => (open && file.diffInput ? parsePromptDiff(file.diffInput) : NO_ROWS),
    [open, file.diffInput],
  );

  // GitHub-style truncation: long diffs render a preview with a "Show full diff"
  // control. Files with review comments always render fully (anchors must show).
  const truncatable = rows.length > LARGE_DIFF_ROWS && file.parsedComments.length === 0;
  const [showFull, setShowFull] = useState(false);
  const visibleRows = useMemo(
    () => (truncatable && !showFull ? rows.slice(0, PREVIEW_ROWS) : rows),
    [rows, truncatable, showFull],
  );
  const hiddenLines = rows.length - visibleRows.length;

  // Anchor comments to their new-file line and split the diff into segments:
  // runs of rows, interrupted by comment blocks. Unmatched comments fall to the end.
  const { segments, unanchored } = useMemo(() => {
    const byLine = new Map<number, ParsedReviewComment[]>();
    const rest: ParsedReviewComment[] = [];
    const anchorable = new Set(visibleRows.filter((r) => r.newNo !== null).map((r) => r.newNo));
    for (const comment of file.parsedComments) {
      if (comment.line != null && anchorable.has(comment.line)) {
        const list = byLine.get(comment.line) ?? [];
        list.push(comment);
        byLine.set(comment.line, list);
      } else {
        rest.push(comment);
      }
    }

    const segs: Array<
      | { type: 'rows'; rows: DiffRow[] }
      | { type: 'comments'; comments: ParsedReviewComment[] }
    > = [];
    let run: DiffRow[] = [];
    for (const row of visibleRows) {
      run.push(row);
      const comments = row.newNo !== null ? byLine.get(row.newNo) : undefined;
      if (comments) {
        segs.push({ type: 'rows', rows: run });
        segs.push({ type: 'comments', comments });
        run = [];
      }
    }
    if (run.length > 0) segs.push({ type: 'rows', rows: run });

    return { segments: segs, unanchored: rest };
  }, [visibleRows, file.parsedComments]);

  const toggleViewed = (next: boolean) => {
    onToggleViewed(next);
    // Mirror the PR-review pattern: marking viewed folds the file away.
    onOpenChange(!next);
  };

  return (
    <div className="ui-panel min-w-0 overflow-hidden scroll-mt-4">
      {/* File header */}
      <div className={cn('flex items-center gap-3 px-3 py-2.5 sm:px-4', open && 'border-b border-ui-line')}>
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} diff for ${file.filePath}`}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ui-subtle transition-colors hover:bg-ui-fill hover:text-ui-default"
        >
          <ChevronDown size={14} className={cn('transition-transform duration-200', !open && '-rotate-90')} />
        </button>

        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          className="ui-font-mono min-w-0 flex-1 truncate text-left text-xs font-medium text-ui-default"
          title={file.filePath}
        >
          {file.filePath}
        </button>

        <span className="ui-font-mono hidden shrink-0 text-[11px] tabular-nums sm:inline">
          <span className="diff-add-fg">+{adds}</span>{' '}
          <span className="diff-del-fg">−{dels}</span>
        </span>

        {file.parsedComments.length > 0 && (
          <Badge variant="neutral" className="shrink-0">{file.parsedComments.length}</Badge>
        )}
        <span className="hidden shrink-0 md:inline-flex">
          <StatusBadge label={file.fileStatus} />
        </span>

        <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md border border-ui-line px-2 py-1 text-[11px] font-medium text-ui-subtle transition-colors hover:bg-ui-fill/60 hover:text-ui-default">
          <input
            type="checkbox"
            checked={viewed}
            onChange={(e) => toggleViewed(e.target.checked)}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className={cn(
              'flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border transition-colors',
              viewed
                ? 'border-transparent bg-[var(--btn-primary-bg)] text-[oklch(20%_0.04_115)]'
                : 'border-ui-line bg-transparent',
            )}
          >
            {viewed && <Check size={10} strokeWidth={3} />}
          </span>
          <span className="hidden sm:inline">Viewed</span>
        </label>
      </div>

      {/* Diff body */}
      {open && (
        <div className="min-w-0">
          {rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-ui-subtle">
              {diffsLoading ? 'Loading diff…' : 'Diff unavailable for this file.'}
            </p>
          ) : (
            // Comments split the diff into independently-scrollable row segments so
            // comment cards stay at panel width instead of stretching to the widest
            // code line inside one shared horizontal scroller.
            segments.map((segment, i) =>
              segment.type === 'rows' ? (
                <div key={i} className="thin-scroll overflow-x-auto">
                  <div className="min-w-fit py-1">
                    {segment.rows.map((row, j) => (
                      <DiffLine key={j} row={row} lang={lang} />
                    ))}
                  </div>
                </div>
              ) : (
                <div key={i} className="space-y-3 border-y border-ui-line/60 px-3 py-3 sm:px-4">
                  <div className="max-w-3xl space-y-3">
                    {segment.comments.map((comment, j) => (
                      <CommentCard key={j} comment={comment} filePath={file.filePath} />
                    ))}
                  </div>
                </div>
              ),
            )
          )}

          {/* GitHub-style truncation footer for long diffs */}
          {hiddenLines > 0 && (
            <div className="ui-well flex items-center justify-center gap-3 border-t border-ui-line px-4 py-2.5">
              <p className="text-xs text-ui-subtle">
                {hiddenLines.toLocaleString()} more {hiddenLines === 1 ? 'line' : 'lines'} not shown.
              </p>
              <button
                type="button"
                onClick={() => setShowFull(true)}
                className="text-xs font-medium text-primary transition-opacity hover:opacity-80"
              >
                Show full diff
              </button>
            </div>
          )}
          {truncatable && showFull && (
            <div className="ui-well flex items-center justify-center border-t border-ui-line px-4 py-2">
              <button
                type="button"
                onClick={() => setShowFull(false)}
                className="text-xs font-medium text-ui-subtle transition-colors hover:text-ui-default"
              >
                Collapse to preview
              </button>
            </div>
          )}

          {/* Error + comments that didn't match a diff line */}
          {file.fileStatus === 'failed' && file.errorMessage && (
            <div
              className="mx-3 mb-3 rounded-md border p-3 sm:mx-4"
              style={{ background: 'var(--danger-bg)', borderColor: 'var(--danger-border)' }}
            >
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--danger)' }}>Review error</p>
              <p className="ui-font-mono break-all text-xs" style={{ color: 'var(--danger)' }}>{file.errorMessage}</p>
            </div>
          )}
          {unanchored.length > 0 && (
            <div className="space-y-3 border-t border-ui-line/60 px-3 py-3 sm:px-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">
                File-level comments
              </p>
              <div className="max-w-3xl space-y-3">
                {unanchored.map((comment, j) => (
                  <CommentCard key={j} comment={comment} filePath={file.filePath} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── File tree ────────────────────────────────────────────────── */

interface TreeProps {
  nodes: TreeNode[];
  collapsedDirs: Set<string>;
  viewedFiles: Set<string>;
  selectedFileId: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (file: FileReviewRecord) => void;
}

function FileTree({ nodes, collapsedDirs, viewedFiles, selectedFileId, onToggleDir, onSelectFile }: TreeProps) {
  // Indentation, guide lines, and connector ticks come from the `.diff-tree`
  // CSS (nested ul padding + borders); rows carry no depth styling themselves.
  return (
    <ul>
      {nodes.map((node) => {
        if (node.type === 'dir') {
          const collapsed = collapsedDirs.has(node.path);
          return (
            <li key={`d:${node.path}`} className="min-w-0">
              <button
                type="button"
                onClick={() => onToggleDir(node.path)}
                aria-expanded={!collapsed}
                className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-ui-default transition-colors hover:bg-ui-fill/60"
              >
                {collapsed ? (
                  <Folder size={14} className="shrink-0 text-ui-subtle" />
                ) : (
                  <FolderOpen size={14} className="shrink-0 text-ui-default" />
                )}
                <span className="min-w-0 truncate">{node.name}</span>
              </button>
              <div className="diff-tree-children" data-collapsed={collapsed}>
                <div>
                  <FileTree
                    nodes={node.children}
                    collapsedDirs={collapsedDirs}
                    viewedFiles={viewedFiles}
                    selectedFileId={selectedFileId}
                    onToggleDir={onToggleDir}
                    onSelectFile={onSelectFile}
                  />
                </div>
              </div>
            </li>
          );
        }

        const { adds, dels } = diffStats(node.file.diffInput);
        const viewed = viewedFiles.has(node.file.id);
        const selected = selectedFileId === node.file.id;
        return (
          <li key={`f:${node.file.id}`} className="min-w-0">
            <button
              type="button"
              onClick={() => onSelectFile(node.file)}
              aria-current={selected ? 'true' : undefined}
              className={cn(
                'group flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors',
                selected ? 'bg-ui-fill font-medium text-ui-strong' : 'hover:bg-ui-fill/60',
              )}
              title={`${node.file.filePath} · +${adds} −${dels}`}
            >
              {viewed ? (
                <Check size={13} className="shrink-0 text-success" strokeWidth={3} />
              ) : (
                <FileText size={14} className={cn('shrink-0', selected ? 'text-ui-default' : 'text-ui-subtle')} />
              )}
              <span
                className={cn(
                  'ui-font-mono min-w-0 flex-1 truncate text-[11px]',
                  viewed ? 'text-ui-subtle line-through' : selected ? 'text-ui-strong' : 'text-ui-default',
                )}
              >
                {node.name}
              </span>
              {node.file.parsedComments.length > 0 && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" title={`${node.file.parsedComments.length} review comments`} />
              )}
              {/* Counts appear only on hover/selection — `hidden` (not opacity-0) so
                  they don't reserve width and squeeze the filename when invisible. */}
              <span
                className={cn(
                  'ui-font-mono shrink-0 text-[10px] tabular-nums',
                  selected ? 'inline' : 'hidden group-hover:inline',
                )}
              >
                <span className="diff-add-fg">+{adds}</span>{' '}
                <span className="diff-del-fg">−{dels}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ── Files-changed view ───────────────────────────────────────── */

interface JobDiffsProps {
  job: JobDetail;
}

export function JobDiffs({ job }: JobDiffsProps) {
  const [diffsByPath, setDiffsByPath] = useState<Record<string, string> | null>(() => readDiffsCache(job.id));
  const [diffsLoading, setDiffsLoading] = useState(diffsByPath === null);

  useEffect(() => {
    let cancelled = false;
    setDiffsLoading(true);
    api.getJobDiffs(job.id)
      .then((res) => {
        if (cancelled) return;
        setDiffsByPath(res.diffs);
        writeDiffsCache(job.id, res.diffs);
      })
      .catch(() => {
        if (!cancelled) setDiffsByPath((current) => current ?? {});
      })
      .finally(() => {
        if (!cancelled) setDiffsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [job.id]);

  // The full GitHub-style file list: every file in the PR diff, merged with review
  // rows where they exist. Files without a review row yet (job still running,
  // skipped, etc.) show as pending, sorted by path like GitHub.
  const files = useMemo(() => {
    const merged = job.files.map((f) =>
      diffsByPath?.[f.filePath] ? { ...f, diffInput: diffsByPath[f.filePath] } : f,
    );
    if (diffsByPath) {
      const known = new Set(job.files.map((f) => f.filePath));
      for (const [path, diff] of Object.entries(diffsByPath)) {
        if (!known.has(path)) merged.push(syntheticFileReview(job.id, path, diff));
      }
    }
    return merged.sort((a, b) => a.filePath.localeCompare(b.filePath));
  }, [job.id, job.files, diffsByPath]);

  // Per-file cheap stats, computed once per diff change and reused everywhere
  // (header counts, tree, totals, panel size estimates).
  const statsByPath = useMemo(() => {
    const map = new Map<string, ReturnType<typeof diffStats>>();
    for (const file of files) map.set(file.filePath, diffStats(file.diffInput));
    return map;
  }, [files]);

  const [viewedFiles, setViewedFiles] = useState<Set<string>>(() => new Set());
  // Open state is an override on top of a default rule, so files that stream in
  // later (running jobs, late-arriving diffs) still get sensible defaults: big
  // PRs start collapsed except files carrying review comments.
  const [openOverrides, setOpenOverrides] = useState<Map<string, boolean>>(() => new Map());
  const isLargePr = files.length > AUTO_EXPAND_FILE_LIMIT;
  const isOpen = (file: FileReviewRecord) =>
    openOverrides.get(file.id) ?? (!isLargePr || file.parsedComments.length > 0);

  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  // Single-file mode: render one diff at a time — the fast path for huge PRs.
  const [singleFileMode, setSingleFileMode] = useState(false);
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const tree = useMemo(() => buildTree(files), [files]);

  const totals = useMemo(() => {
    let adds = 0;
    let dels = 0;
    for (const s of statsByPath.values()) {
      adds += s.adds;
      dels += s.dels;
    }
    return { adds, dels };
  }, [statsByPath]);

  const setOpen = (id: string, open: boolean) =>
    setOpenOverrides((current) => new Map(current).set(id, open));

  const setViewed = (id: string, viewed: boolean) =>
    setViewedFiles((current) => {
      const next = new Set(current);
      if (viewed) next.add(id);
      else next.delete(id);
      return next;
    });

  const jumpToFile = (file: FileReviewRecord) => {
    setSelectedFileId(file.id);
    setOpen(file.id, true);
    if (singleFileMode) return; // the single panel swaps in place, nothing to scroll to
    // Let the panel expand before scrolling to it.
    requestAnimationFrame(() => {
      fileRefs.current.get(file.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  // Single-file mode current selection (defaults to the first file).
  const currentIndex = Math.max(0, files.findIndex((f) => f.id === selectedFileId));
  const currentFile = files[currentIndex];
  const stepFile = (delta: number) => {
    const next = files[currentIndex + delta];
    if (next) jumpToFile(next);
  };

  const allOpen = files.every((f) => isOpen(f));
  const toggleAll = () =>
    setOpenOverrides(new Map(files.map((f) => [f.id, !allOpen])));

  const toggleDir = (path: string) =>
    setCollapsedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (files.length === 0) {
    return (
      <div className="ui-panel flex flex-col items-center justify-center py-16 text-center">
        <FileDiffIcon size={32} className="mb-3 text-ui-subtle/30" />
        <p className="text-sm font-medium text-ui-default">No file diffs yet</p>
        <p className="mt-1 text-xs text-ui-subtle">Diffs appear here as files are reviewed.</p>
      </div>
    );
  }

  return (
    /* This row fills the height the page hands it, so the tree is full height by
       construction. A fixed viewport calc can't work here: the row starts below the
       header and tabs, so `100svh - <constant>` overshot the bottom and forced the
       whole page to scroll even for three files. */
    <div className="flex min-h-0 min-w-0 flex-1 gap-4">
      {/* File tree — full height, scrolling independently so it stays reachable
          in huge PRs. */}
      <aside className="ui-panel hidden h-full w-72 shrink-0 flex-col overflow-hidden lg:flex xl:w-80">
        <div className="flex items-center gap-2 border-b border-ui-line px-4 py-3">
          <FileDiffIcon size={15} strokeWidth={2} className="shrink-0 text-ui-default" />
          <h2 className="text-[13px] font-medium text-ui-default">Files</h2>
          <span className="ui-font-mono ml-auto text-[11px] tabular-nums text-ui-subtle">
            {files.length}
          </span>
        </div>
        {/* Viewed progress — matches the review progress bar styling. */}
        <div
          className="h-[3px] w-full shrink-0 bg-ui-fill"
          role="progressbar"
          aria-valuenow={viewedFiles.size}
          aria-valuemin={0}
          aria-valuemax={files.length}
          aria-label="Files marked viewed"
        >
          <div
            className="h-full bg-[var(--btn-primary-bg)] transition-[width] duration-500 ease-out"
            style={{ width: `${(viewedFiles.size / files.length) * 100}%` }}
          />
        </div>
        <div className="diff-tree diff-tree-scroll min-h-0 flex-1 overflow-y-auto py-2 pl-2 pr-1">
          <FileTree
            nodes={tree}
            collapsedDirs={collapsedDirs}
            viewedFiles={viewedFiles}
            selectedFileId={singleFileMode ? currentFile?.id ?? null : selectedFileId}
            onToggleDir={toggleDir}
            onSelectFile={jumpToFile}
          />
        </div>
        <div className="ui-well border-t border-ui-line px-4 py-2">
          <p className="ui-font-mono text-[10px] tabular-nums text-ui-subtle">
            {files.length} {files.length === 1 ? 'file' : 'files'} ·{' '}
            <span className="diff-add-fg">+{totals.adds}</span>{' '}
            <span className="diff-del-fg">−{totals.dels}</span>
          </p>
        </div>
      </aside>

      {/* Diff column — scrolls itself rather than growing the page, which is what
          keeps the tree beside it full height. */}
      <div className="auto-hide-scroll flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
        {/* Large-PR banner */}
        {isLargePr && (
          <div className="ui-panel flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
            <Info size={14} className="shrink-0 text-ui-subtle" />
            <p className="min-w-0 flex-1 text-xs text-ui-subtle">
              This view has been optimized for large pull requests, files start collapsed and
              offscreen diffs render lazily.
            </p>
            <button
              type="button"
              onClick={() => setSingleFileMode((v) => !v)}
              className="shrink-0 text-xs font-medium text-primary transition-opacity hover:opacity-80"
            >
              {singleFileMode ? 'Show all files' : 'Switch to single file mode'}
            </button>
          </div>
        )}

        {/* Summary strip */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
          <span className="flex items-center gap-1.5 text-xs text-ui-subtle">
            <GitCommitHorizontal size={13} />
            {singleFileMode
              ? `File ${currentIndex + 1} of ${files.length}`
              : `${files.length} ${files.length === 1 ? 'file' : 'files'}`}
          </span>
          <span className="ui-font-mono text-xs tabular-nums">
            <span className="diff-add-fg">+{totals.adds}</span>{' '}
            <span className="diff-del-fg">−{totals.dels}</span>
          </span>
          <span className="ml-auto text-xs tabular-nums text-ui-subtle">
            {viewedFiles.size} / {files.length} viewed
          </span>
          {singleFileMode ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => stepFile(-1)}
                disabled={currentIndex === 0}
                aria-label="Previous file"
                className="flex h-6 w-6 items-center justify-center rounded-md border border-ui-line text-ui-subtle transition-colors hover:bg-ui-fill/60 hover:text-ui-default disabled:pointer-events-none disabled:opacity-40"
              >
                <ChevronLeft size={13} />
              </button>
              <button
                type="button"
                onClick={() => stepFile(1)}
                disabled={currentIndex >= files.length - 1}
                aria-label="Next file"
                className="flex h-6 w-6 items-center justify-center rounded-md border border-ui-line text-ui-subtle transition-colors hover:bg-ui-fill/60 hover:text-ui-default disabled:pointer-events-none disabled:opacity-40"
              >
                <ChevronRight size={13} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={toggleAll}
              className="flex items-center gap-1.5 rounded-md border border-ui-line px-2 py-1 text-[11px] font-medium text-ui-subtle transition-colors hover:bg-ui-fill/60 hover:text-ui-default"
            >
              {allOpen ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />}
              {allOpen ? 'Collapse all' : 'Expand all'}
            </button>
          )}
        </div>

        {singleFileMode && currentFile ? (
          // One diff at a time — only the current file exists in the DOM.
          <FileDiff
            key={currentFile.id}
            file={currentFile}
            open
            viewed={viewedFiles.has(currentFile.id)}
            diffsLoading={diffsLoading}
            onOpenChange={() => {}}
            onToggleViewed={(viewed) => {
              setViewed(currentFile.id, viewed);
              // Marking viewed advances to the next file, GitHub-style.
              if (viewed) stepFile(1);
            }}
          />
        ) : (
          files.map((file) => (
            <div
              key={file.id}
              id={fileAnchorId(file.id)}
              style={panelCvStyle(isOpen(file), statsByPath.get(file.filePath)?.total ?? 0)}
              ref={(el) => {
                if (el) fileRefs.current.set(file.id, el);
                else fileRefs.current.delete(file.id);
              }}
            >
              <FileDiff
                file={file}
                open={isOpen(file)}
                viewed={viewedFiles.has(file.id)}
                diffsLoading={diffsLoading}
                onOpenChange={(open) => setOpen(file.id, open)}
                onToggleViewed={(viewed) => setViewed(file.id, viewed)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
