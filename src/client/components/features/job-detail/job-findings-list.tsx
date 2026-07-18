import { useState } from 'react';
import { FileText } from 'lucide-react';
import type { JobDetail } from '@shared/schema';
import { reviewSeverities } from '@shared/schema';
import { Badge } from '@client/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@client/components/motion/tabs';
import { FileFinding } from './file-finding';
import { CommentCard } from './comment-card';
import { severityConfig } from './constants';

interface JobFindingsListProps {
  job: JobDetail;
}

export function JobFindingsList({ job }: JobFindingsListProps) {
  const [viewBy, setViewBy] = useState<'files' | 'severity'>('files');

  // Only surface files that actually have something to report — findings or a
  // failed review. Clean files are omitted.
  const filesWithIssues = job.files.filter(
    (f) => f.parsedComments.length > 0 || f.fileStatus === 'failed',
  );

  return (
    <div className="ui-font-sans">
      {/* Section header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText size={15} strokeWidth={2} className="shrink-0 text-ui-default" />
          <h2 className="text-[13px] font-medium text-ui-default">Findings</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">View by</span>
          <Tabs value={viewBy} onValueChange={(v) => setViewBy(v as 'files' | 'severity')} variant="segment">
            <TabsList className="bg-secondary">
              <TabsTrigger value="files" className="text-xs">
                Files
              </TabsTrigger>
              <TabsTrigger value="severity" className="text-xs">
                Severity
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {viewBy === 'files' ? (
        <div className="flex flex-col gap-3">
          {filesWithIssues.length === 0 ? (
            <div className="ui-panel flex flex-col items-center justify-center py-16 text-center">
              <FileText size={32} className="mb-3 text-ui-subtle/30" />
              <p className="text-sm font-medium text-ui-default">No findings</p>
              <p className="mt-1 text-xs text-ui-subtle">Codra didn't flag any issues in the reviewed files.</p>
            </div>
          ) : (
            filesWithIssues.map((file) => (
              <FileFinding key={file.id} file={file} />
            ))
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {job.files.some((f) => f.fileStatus === 'failed') && (
            <div className="ui-panel min-w-0 overflow-hidden">
              {/* Group header */}
              <div className="flex items-center gap-2 border-b border-ui-line px-4 py-3 sm:px-5">
                <FileText size={14} strokeWidth={2} className="shrink-0 text-danger" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ui-default">
                  Failed files
                </span>
                <Badge variant="danger">
                  {job.files.filter((f) => f.fileStatus === 'failed').length}
                </Badge>
              </div>
              {/* Failed files list */}
              <div className="flex flex-col gap-3 p-4 sm:p-5">
                {job.files.filter((f) => f.fileStatus === 'failed').map((file) => (
                  <FileFinding key={file.id} file={file} />
                ))}
              </div>
            </div>
          )}

          {reviewSeverities.map((groupName) => {
            const comments = job.files.flatMap((f) =>
              f.parsedComments
                .filter((c) => c.severity === groupName)
                .map((c) => ({ ...c, filePath: f.filePath })),
            );
            if (comments.length === 0) return null;

            const sev = severityConfig[groupName];
            const GroupIcon = sev?.icon ?? FileText;

            return (
              <div key={groupName} className="ui-panel min-w-0 overflow-hidden">
                {/* Group header */}
                <div className="flex items-center gap-2 border-b border-ui-line px-4 py-3 sm:px-5">
                  {sev?.svg ? (
                    <img src={sev.svg} alt={groupName} className="h-[15px] w-[15px]" />
                  ) : (
                    <GroupIcon size={14} strokeWidth={2} className={sev?.iconColor ?? 'text-ui-subtle'} />
                  )}
                  <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ui-default">
                    {groupName}
                  </span>
                  <Badge variant="neutral">{comments.length}</Badge>
                </div>
                {/* Comment list */}
                <div className="flex flex-col gap-3 p-4 sm:p-5">
                  {comments.map((comment, index) => (
                    <CommentCard
                      key={`${groupName}-${index}`}
                      comment={comment}
                      filePath={comment.filePath}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
