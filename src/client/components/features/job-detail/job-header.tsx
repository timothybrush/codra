import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronRight,
  ExternalLink,
  Loader2,
  RotateCcw,
  Terminal,
  Trash2,
} from 'lucide-react';
import { Button } from '@client/components/ui/button';
import { ConfirmDialog } from '@client/components/ui/confirm-dialog';
import { UpdatesEmailPrompt } from '@client/components/features/dashboard/updates-email-prompt';
import type { JobDetail } from '@shared/schema';

/* Stop icon: outlined circle with a solid square inside. Lucide's CircleStop strokes the inner
   square too, which at 14px reads as a blob — filling it keeps the stop symbol legible. */
function StopIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

interface JobHeaderProps {
  job: JobDetail;
  isRerunning: boolean;
  isStopping: boolean;
  isDeleting: boolean;
  onRerun: () => void;
  onStop: () => void;
  onDelete: () => void;
}

export function JobHeader({
  job,
  isRerunning,
  isStopping,
  isDeleting,
  onRerun,
  onStop,
  onDelete,
}: JobHeaderProps) {
  const [stopOpen, setStopOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const canStop = job.status === 'running' || job.status === 'queued';

  return (
    <>
      <header className="ui-font-sans flex flex-col sm:flex-row items-start justify-between gap-4">
      <div className="min-w-0 w-full">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">
          <Link to="/jobs" className="hover:text-ui-default transition-colors">Jobs</Link>
          <ChevronRight size={12} className="opacity-40" />
          <span className="ui-font-mono lowercase tracking-normal text-ui-default">
            {job.owner}/{job.repo}#{job.prNumber}
          </span>
          <ChevronRight size={12} className="opacity-40" />
          <span
            className="ui-font-mono font-medium lowercase tracking-normal text-ui-subtle cursor-default"
            title={job.id}
          >
            {job.id.slice(0, 8)}…
          </span>
        </div>
        <h1 className="mt-2 text-xl font-bold text-foreground" style={{ letterSpacing: '-0.02em' }}>
          <a
            href={`https://github.com/${job.owner}/${job.repo}/pull/${job.prNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 hover:text-primary transition-colors"
          >
            {job.prTitle ?? 'Untitled pull request'}
            <ExternalLink size={15} className="text-ui-subtle" />
          </a>
        </h1>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-ui-subtle">
          <span className="ui-font-mono">#{job.prNumber}</span>
          {job.baseRef && job.headRef && (
            <>
              <span className="opacity-50">·</span>
              <span className="ui-font-mono max-w-[160px] truncate rounded-md bg-ui-fill/50 px-1.5 py-0.5 text-[11px] text-ui-default">
                {job.baseRef}
              </span>
              <span className="opacity-60">←</span>
              <span className="ui-font-mono max-w-[220px] truncate rounded-md bg-ui-fill/50 px-1.5 py-0.5 text-[11px] text-ui-default">
                {job.headRef}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
        <Button variant="outline" asChild className="gap-2">
          <Link to={`/jobs/${job.id}/logs`}>
            <Terminal size={14} />
            Raw Logs
          </Link>
        </Button>

        <Button
          variant="outline"
          size="icon"
          disabled={!canStop || isStopping}
          onClick={() => setStopOpen(true)}
          title="Stop review"
          aria-label="Stop review"
        >
          {isStopping ? <Loader2 size={14} className="animate-spin" /> : <StopIcon size={14} />}
        </Button>

        {/* A single re-run control. It always restarts the review from the beginning (a fresh
            review of every file) and works whether the job is finished, failed, or still running. */}
        <Button
          variant="outline"
          size="icon"
          disabled={isRerunning}
          onClick={onRerun}
          title={job.status === 'failed' ? 'Retry job' : 'Re-run job'}
          aria-label={job.status === 'failed' ? 'Retry job' : 'Re-run job'}
        >
          {isRerunning ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
        </Button>

        <Button
          variant="destructive-outline"
          size="icon"
          disabled={isDeleting}
          onClick={() => setDeleteOpen(true)}
          title="Delete job"
          aria-label="Delete job"
        >
          {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        </Button>
      </div>
      </header>

      <ConfirmDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title="Stop this review?"
        description="This cancels the ongoing review for this pull request. Any files not yet reviewed will be left unreviewed."
        confirmLabel="Stop review"
        confirmVariant="destructive"
        onConfirm={onStop}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this job?"
        description="This permanently removes the job and its review history. This action cannot be undone."
        confirmLabel="Delete job"
        confirmVariant="destructive"
        onConfirm={onDelete}
      />

      <UpdatesEmailPrompt />
    </>
  );
}
