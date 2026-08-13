import { useState } from 'react';
import type { ComponentType } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronRight,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Loader2,
  RotateCcw,
  Terminal,
  Trash2,
} from 'lucide-react';
import { Button } from '@client/components/ui/button';
import type { ButtonProps } from '@client/components/ui/button';
import { ConfirmDialog } from '@client/components/ui/confirm-dialog';
import { UpdatesEmailPrompt } from '@client/components/features/dashboard/updates-email-prompt';
import { AuthorChip, JobStatusLine, MetaChip, VerdictPill } from './job-chips';
import { formatAbsoluteDate, formatRelativeDate } from './job-chip-utils';
import type { JobDetail } from '@codra/schema';

// Lucide's CircleStop strokes the inner square too, which reads as a blob at 14px; filling it
// instead keeps the stop symbol legible.
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

interface JobActionButtonProps {
  icon: ComponentType<{ size?: number }>;
  label: string;
  /** In-flight: swaps the icon for a spinner. Also disables unless `disabled` says otherwise. */
  busy: boolean;
  disabled?: boolean;
  variant?: ButtonProps['variant'];
  className?: string;
  onClick: () => void;
}

// Every header action is the same icon-only button whose only state is "in flight", so the busy flag
// lives here rather than branching the header itself.
function JobActionButton({
  icon: Icon,
  label,
  busy,
  disabled,
  variant = 'secondary',
  className = 'rounded-[7px]',
  onClick,
}: JobActionButtonProps) {
  return (
    <Button
      variant={variant}
      size="sm"
      shape="square"
      className={className}
      disabled={disabled ?? busy}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} />}
    </Button>
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
      {/* The header is the detail page's version of a table row: same vocabulary as the jobs table. */}
      <header className="ui-font-sans flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="min-w-0 w-full">
          {/* Deliberately thin: the repo and PR live in the chip row below, so this only carries the way back and the job id. */}
          <div className="flex min-w-0 items-center gap-1 text-[11px] text-ui-default dark:text-ui-subtle">
            <Link to="/jobs" className="transition-colors hover:text-ui-strong">
              Jobs
            </Link>
            <ChevronRight size={12} className="shrink-0 text-ui-subtle opacity-60" />
            <span className="ui-font-mono cursor-default truncate text-ui-subtle" title={job.id}>
              {job.id.slice(0, 8)}
            </span>
          </div>

          <h1 className="mt-1.5 min-w-0 text-xl font-bold text-foreground" style={{ letterSpacing: '-0.02em' }}>
            <a
              href={`https://github.com/${job.owner}/${job.repo}/pull/${job.prNumber}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex max-w-full items-center gap-2 transition-colors hover:text-primary"
            >
              <span className="min-w-0 break-words">{job.prTitle ?? 'Untitled pull request'}</span>
              <ExternalLink size={15} className="mt-0.5 shrink-0 text-ui-subtle" />
            </a>
          </h1>

          <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <JobStatusLine job={job} />

            {job.verdict && <VerdictPill verdict={job.verdict} />}

            <MetaChip icon={FolderGit2} title={`${job.owner}/${job.repo}`}>
              {job.owner}/{job.repo}
            </MetaChip>

            <MetaChip icon={GitPullRequest} mono>
              #{job.prNumber}
            </MetaChip>

            {job.commitSha && (
              <MetaChip icon={GitCommitHorizontal} mono title={job.commitSha}>
                {job.commitSha.slice(0, 7)}
              </MetaChip>
            )}

            {/* Branch pair is the widest and least essential chip, so it is capped and drops off first. */}
            {job.baseRef && job.headRef && (
              <MetaChip
                icon={GitBranch}
                mono
                title={`${job.headRef} → ${job.baseRef}`}
                className="hidden max-w-[15rem] 2xl:flex"
              >
                {job.baseRef} ← {job.headRef}
              </MetaChip>
            )}

            <AuthorChip login={job.prAuthor} />

            <span
              className="shrink-0 text-xs leading-none text-ui-default dark:text-ui-subtle"
              title={formatAbsoluteDate(job.createdAt)}
            >
              {formatRelativeDate(job.createdAt)}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <Button variant="secondary" size="sm" asChild className="gap-1.5 rounded-[7px]">
            <Link to={`/jobs/${job.id}/logs`}>
              <Terminal size={13} />
              Raw Logs
            </Link>
          </Button>

          <JobActionButton
            icon={StopIcon}
            label="Stop review"
            busy={isStopping}
            disabled={!canStop || isStopping}
            onClick={() => setStopOpen(true)}
          />

          {/* Always restarts the review from the beginning (every file), regardless of the job's current status. */}
          <JobActionButton
            icon={RotateCcw}
            label={job.status === 'failed' ? 'Retry job' : 'Re-run job'}
            busy={isRerunning}
            onClick={onRerun}
          />

          <JobActionButton
            icon={Trash2}
            label="Delete job"
            busy={isDeleting}
            variant="destructive-outline"
            className="rounded-[7px] shadow-none"
            onClick={() => setDeleteOpen(true)}
          />
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
