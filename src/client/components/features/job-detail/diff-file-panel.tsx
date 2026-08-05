import { useMemo, useState, type CSSProperties } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Badge, StatusBadge } from '@client/components/ui/badge';
import { parsePromptDiff, diffStats, type DiffRow } from '@client/lib/prompt-diff';
import { highlightLine, langForPath } from '@client/lib/highlight';
import { cn } from '@client/lib/utils';
import type { FileReviewRecord, ParsedReviewComment } from '@shared/schema';
import { CommentCard } from './comment-card';
// One expandable file panel in the diff view, and the single diff row it repeats. Holds the
// row-height and preview-size constants because they only mean anything here.

export const LARGE_DIFF_ROWS = 300;

/* Longer diffs render only the first PREVIEW_ROWS lines behind a "Show full diff" control, so a huge
   PR never dumps tens of thousands of rows into the DOM. Files carrying review comments are never
   truncated, since their anchors must stay visible. */
export const PREVIEW_ROWS = 150;

/* Row height used to estimate a panel's rendered size before it first paints. */
export const DIFF_ROW_PX = 20;

/* Offscreen panels skip layout and paint; the placeholder height keeps the scrollbar honest. A
   per-file estimate from the diff's own line count keeps page height stable while scrolling instead
   of "growing" as panels come into view. */
export function panelCvStyle(open: boolean, lineEstimate: number): CSSProperties {
  const body = open ? Math.min(lineEstimate, PREVIEW_ROWS) * DIFF_ROW_PX + 140 : 0;
  return {
    contentVisibility: 'auto',
    containIntrinsicSize: `auto ${46 + body}px`,
  };
}

export function fileAnchorId(id: string) {
  return `diff-file-${id}`;
}

export const ROW_TONES: Record<DiffRow['kind'], { row: string; gutter: string; marker: string }> = {
  add:  { row: 'diff-add', gutter: 'diff-add-fg', marker: 'diff-add-fg' },
  del:  { row: 'diff-del', gutter: 'diff-del-fg', marker: 'diff-del-fg' },
  ctx:  { row: '',         gutter: 'text-ui-subtle/60', marker: 'text-transparent' },
  hunk: { row: 'ui-well',  gutter: '',           marker: '' },
};

export function DiffLine({ row, lang }: { row: DiffRow; lang: ReturnType<typeof langForPath> }) {
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

export interface FileDiffProps {
  file: FileReviewRecord;
  open: boolean;
  viewed: boolean;
  /** The job's diffs are still being fetched (see JobDiffs) - don't yet claim "no diff saved". */
  diffsLoading?: boolean;
  onOpenChange: (open: boolean) => void;
  onToggleViewed: (viewed: boolean) => void;
}

export const NO_ROWS: DiffRow[] = [];

export function FileDiff({ file, open, viewed, diffsLoading = false, onOpenChange, onToggleViewed }: FileDiffProps) {
  const lang = useMemo(() => langForPath(file.filePath), [file.filePath]);
  // Header stats come from a cheap line scan; the full row parse only happens once
  // the panel is actually open - collapsed files cost almost nothing.
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
          <span className="diff-del-fg">-{dels}</span>
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
