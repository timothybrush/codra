import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRight } from 'lucide-react';
import type { FileReviewRecord, ParsedReviewComment } from '@shared/schema';
import { CommentCard } from './comment-card';
import { preventToggleOnTextSelection } from '@client/lib/selection';
import { MonoPath, StatusDot, VerdictPill, statusLabel } from './job-chips';

import { safeRehypePlugins } from '@client/lib/markdown-plugins';
interface FileFindingProps {
  file: FileReviewRecord;
}

export function FileFinding({ file }: FileFindingProps) {
  const count = file.parsedComments.length;

  return (
    <details key={file.id} className="ui-panel ui-font-sans group min-w-0 overflow-hidden">
      {/* Fixed 48px summary row, matching the jobs table's row height: mono path
          on the left, then the status dot + verdict pill + finding count. */}
      {/* `select-none` used to sit here, which made the file path -- the one thing in this row worth
          copying -- impossible to select at all. Selection is allowed instead, and the click guard
          keeps a drag-select from collapsing the panel on mouse-up. */}
      <summary
        onClick={preventToggleOnTextSelection}
        className="flex h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 transition-colors hover:bg-ui-fill/40 [&::-webkit-details-marker]:hidden sm:px-5"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronRight
            size={14}
            className="shrink-0 text-ui-subtle transition-transform group-open:rotate-90"
          />
          <MonoPath path={file.filePath} />
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-2">
            <StatusDot status={file.fileStatus} />
            <span className="text-[13px] leading-none text-ui-default">
              {statusLabel(file.fileStatus)}
            </span>
          </span>

          {file.fileStatus === 'done' && <VerdictPill verdict={file.verdict ?? 'comment'} />}

          {count > 0 && (
            <span
              className="ui-font-mono text-[11px] leading-none tabular-nums text-ui-default dark:text-ui-subtle"
              title={`${count} ${count === 1 ? 'finding' : 'findings'}`}
            >
              {count}
            </span>
          )}
        </div>
      </summary>

      <div className="border-t border-ui-line px-4 pb-5 pt-4 sm:px-5">
        {/* File-level error */}
        {file.fileStatus === 'failed' && file.errorMessage && (
          <div className="mb-4 rounded-md border border-danger-border bg-danger-bg px-3 py-2.5">
            <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium leading-none text-danger">
              <StatusDot status="failed" />
              Review error
            </p>
            <p className="ui-font-mono break-all text-xs leading-relaxed text-danger">
              {file.errorMessage}
            </p>
          </div>
        )}

        {/* File summary (when review succeeded) */}
        {file.fileStatus === 'done' && file.fileSummary && (
          <div className="ui-well mb-4 rounded-md px-4 py-3">
            <p className="mb-1 text-xs leading-none text-ui-default dark:text-ui-subtle">
              Model summary
            </p>
            <div className="prose prose-sm max-w-none leading-relaxed text-foreground/90">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={safeRehypePlugins}>
                {file.fileSummary}
              </ReactMarkdown>
            </div>
          </div>
        )}

        {count > 0 && (
          <div>
            <p className="mb-3 text-xs leading-none text-ui-default dark:text-ui-subtle">
              Inline comments ({count})
            </p>
            <div className="flex flex-col gap-3">
              {file.parsedComments.map((comment: ParsedReviewComment, index: number) => (
                <CommentCard key={`${file.id}-${index}`} comment={comment} filePath={file.filePath} />
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
