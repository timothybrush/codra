import { ExternalLink, Check, Minus, X, ArrowRight, Info, ListChecks } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, StatusBadge } from '@client/components/ui/badge';
import type { JobDetail, JobStep } from '@shared/schema';
import { formatDuration } from '@client/lib/utils';

interface JobMetaCardsProps {
  job: JobDetail;
}

function elapsedSec(step: JobStep): string | null {
  if (step.finishedAt && step.startedAt) {
    const start = new Date(step.startedAt).getTime();
    const end = new Date(step.finishedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    // Reuse the shared formatter so long phases roll up into minutes/hours (e.g. "6m 24s")
    // instead of an unwieldy "383.7s".
    return formatDuration(end - start);
  }
  return null;
}

function StepRow({ step, index, total }: { step: JobStep; index: number; total: number }) {
  const isRunning = step.status === 'running';
  const isDone    = step.status === 'done';
  const isFailed  = step.status === 'failed';
  const isPending = step.status === 'pending';
  const isLast    = index === total - 1;

  const elapsed = elapsedSec(step);

  // Left accent bar color
  const accentColor = isDone
    ? 'bg-success'
    : isRunning
    ? 'bg-info'
    : isFailed
    ? 'bg-danger'
    : 'bg-ui-line';

  // Icon
  const iconEl = isDone ? (
    <Check size={11} strokeWidth={2.5} className="text-success" />
  ) : isFailed ? (
    <X size={11} strokeWidth={2.5} className="text-danger" />
  ) : isRunning ? (
    <ArrowRight size={11} strokeWidth={2.5} className="text-info" />
  ) : (
    <Minus size={11} strokeWidth={2} className="text-ui-subtle/40" />
  );

  return (
    <div className={`flex gap-3 ${!isLast ? 'pb-3' : ''} ${index > 0 ? 'pt-3' : ''} ${!isLast ? 'border-b border-ui-line/60' : ''}`}>
      {/* Left accent strip */}
      <div className="flex flex-col items-center gap-1 pt-0.5">
        <div className={`w-[3px] flex-1 rounded-full ${accentColor} opacity-40`} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-3">
          {/* Step name + icon */}
          <div className="flex items-center gap-2 min-w-0">
            <span className="shrink-0 flex h-4 w-4 items-center justify-center">{iconEl}</span>
            <span
              className={`truncate text-sm ${
                isPending ? 'text-ui-subtle/50' : 'text-ui-default'
              } ${isRunning ? 'font-semibold' : 'font-medium'}`}
            >
              {step.name}
            </span>
          </div>

          {/* Right side: status or time */}
          <div className="shrink-0">
            {isRunning && (
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-info">
                In progress
              </span>
            )}
            {elapsed && (
              <span className="ui-font-mono text-xs tabular-nums text-ui-subtle">
                {elapsed}
              </span>
            )}
            {!elapsed && !isRunning && (
              <span className="text-xs text-ui-subtle/40">—</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function JobMetaCards({ job }: JobMetaCardsProps) {
  const isPartialReview = job.status === 'done' && job.errorMessage?.startsWith('Partial review:');
  const steps = job.steps ?? [];
  const shortCommitSha = job.commitSha?.slice(0, 7) ?? 'unknown';

  return (
    <div className="ui-font-sans grid grid-cols-1 gap-4 md:grid-cols-2">

      {/* ── Job details ── */}
      <div className="ui-panel min-w-0 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-ui-line px-4 py-3 sm:px-5">
          <Info size={15} strokeWidth={2} className="shrink-0 text-ui-default" />
          <h2 className="text-[13px] font-medium text-ui-default">Job details</h2>
        </div>
        <div className="px-4 py-4 sm:px-5">

          {/* Metadata grid */}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5">
            {[
              { label: 'Status',  value: <StatusBadge label={job.status} job={job} /> },
              { label: 'Verdict', value: job.verdict
                  ? <StatusBadge label={job.verdict} />
                  : <span className="text-sm text-ui-subtle/60">—</span>
              },
              { label: 'Trigger', value: <Badge variant="neutral" className="capitalize">{job.trigger}</Badge> },
              { label: 'Tokens',  value:
                  <span className="ui-font-mono text-sm tabular-nums text-ui-default">
                    {(job.totalInputTokens + job.totalOutputTokens).toLocaleString()}
                  </span>
              },
            ].map(({ label, value }) => (
              <div key={label}>
                <dt className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">
                  {label}
                </dt>
                <dd>{value}</dd>
              </div>
            ))}

            <div>
              <dt className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">Commit</dt>
              <dd>
                {job.commitSha ? (
                  <a
                    href={`https://github.com/${job.owner}/${job.repo}/commit/${job.commitSha}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ui-font-mono inline-flex items-center gap-1.5 text-xs text-ui-default transition-colors hover:text-primary"
                  >
                    {shortCommitSha}
                    <ExternalLink size={10} className="text-ui-subtle" />
                  </a>
                ) : (
                  <span className="ui-font-mono text-xs text-ui-subtle">{shortCommitSha}</span>
                )}
              </dd>
            </div>

            {job.reviewId && (
              <div>
                <dt className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">Review</dt>
                <dd>
                  <a
                    href={`https://github.com/${job.owner}/${job.repo}/pull/${job.prNumber}#pullrequestreview-${job.reviewId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-ui-default transition-colors hover:text-primary"
                  >
                    GitHub <ExternalLink size={10} className="text-ui-subtle" />
                  </a>
                </dd>
              </div>
            )}

            {job.retryOfJobId && (
              <div>
                <dt className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">Retry of</dt>
                <dd>
                  <Link
                    to={`/jobs/${job.retryOfJobId}`}
                    className="ui-font-mono text-xs text-ui-subtle transition-colors hover:text-ui-default hover:underline"
                  >
                    {job.retryOfJobId.slice(0, 8)}…
                  </Link>
                </dd>
              </div>
            )}

            <div className="col-span-2 border-t border-ui-line/60 pt-3">
              <dt className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">Created</dt>
              <dd className="ui-font-mono text-xs tabular-nums text-ui-subtle">{new Date(job.createdAt).toLocaleString()}</dd>
            </div>
          </dl>

          {/* Error / partial message */}
          {job.errorMessage && (
            <div
              className="mt-5 rounded-md border p-4"
              style={{
                background: isPartialReview ? 'var(--warning-bg)' : 'var(--danger-bg)',
                borderColor: isPartialReview ? 'var(--warning-border)' : 'var(--danger-border)',
              }}
            >
              <p
                className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{ color: isPartialReview ? 'var(--warning)' : 'var(--danger)' }}
              >
                {isPartialReview ? 'Partial review' : 'Error'}
              </p>
              <p className="text-sm leading-relaxed" style={{ color: isPartialReview ? 'var(--warning)' : 'var(--danger)' }}>
                {job.errorMessage}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Progress steps ── */}
      <div className="ui-panel min-w-0 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-ui-line px-4 py-3 sm:px-5">
          <ListChecks size={15} strokeWidth={2} className="shrink-0 text-ui-default" />
          <h2 className="text-[13px] font-medium text-ui-default">Progress steps</h2>
        </div>
        <div className="px-4 py-4 sm:px-5">
          {steps.length === 0 ? (
            <p className="text-sm italic text-ui-subtle">No steps recorded yet.</p>
          ) : (
            <div>
              {steps.map((step, idx) => (
                <StepRow key={step.name || idx} step={step} index={idx} total={steps.length} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
