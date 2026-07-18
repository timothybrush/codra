import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { ChevronRight } from 'lucide-react';
import { Badge, StatusBadge } from '@client/components/ui/badge';
import type { FileReviewRecord, ParsedReviewComment } from '@shared/schema';
import { CommentCard } from './comment-card';

const safeRehypePlugins = [rehypeRaw, rehypeSanitize];

interface FileFindingProps {
  file: FileReviewRecord;
}

export function FileFinding({ file }: FileFindingProps) {
  return (
    <details key={file.id} className="ui-panel ui-font-sans group min-w-0 overflow-hidden">
      <summary className="flex cursor-pointer select-none list-none items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-ui-fill/40 [&::-webkit-details-marker]:hidden sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <ChevronRight size={14} className="shrink-0 text-ui-subtle transition-transform group-open:rotate-90" />
          <span className="ui-font-mono truncate text-xs text-ui-default">{file.filePath}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge label={file.fileStatus} />
          {file.fileStatus === 'done' && <StatusBadge label={file.verdict ?? 'comment'} />}
          {file.parsedComments.length > 0 && (
            <Badge variant="neutral">{file.parsedComments.length}</Badge>
          )}
        </div>
      </summary>

      <div className="border-t border-ui-line/60 px-4 pb-5 pt-4 sm:px-5">
        {/* File-level error */}
        {file.fileStatus === 'failed' && file.errorMessage && (
          <div
            className="mb-4 rounded-md border p-3"
            style={{ background: 'var(--danger-bg)', borderColor: 'var(--danger-border)' }}
          >
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--danger)' }}>Review error</p>
            <p className="ui-font-mono break-all text-xs" style={{ color: 'var(--danger)' }}>{file.errorMessage}</p>
          </div>
        )}

        {/* File summary (when review succeeded) */}
        {file.fileStatus === 'done' && file.fileSummary && (
          <div className="ui-well mb-4 rounded-md px-4 py-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">Model summary</p>
            <div className="prose prose-sm max-w-none leading-relaxed text-foreground/90">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={safeRehypePlugins}>{file.fileSummary}</ReactMarkdown>
            </div>
          </div>
        )}

        {file.parsedComments.length > 0 && (
          <div>
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">
              Inline comments ({file.parsedComments.length})
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
