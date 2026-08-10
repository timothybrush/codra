/**
 * Row vocabulary shared by the job detail page, mirroring the jobs table so the two read as one
 * product: status dot + word + duration, bordered verdict pills, muted icon chips.
 */
import { useState, type ReactNode } from 'react';
import { CheckCircle2, MessageSquare, type LucideIcon } from 'lucide-react';
import { cn } from '@client/lib/utils';
import { formatDateTime } from '@client/lib/timezone';
import { STATUS_DOT, jobDuration, statusLabel } from '@client/lib/job-format';

// Re-exported so the sibling job-detail components keep importing the row vocabulary from one place.
export { formatRelativeDate, formatRunDuration, jobDuration, statusLabel } from '@client/lib/job-format';

import type { JobDetail, JobSummary } from '@shared/schema';


/** Full stamp for `title` tooltips, in the account's display time zone (falling back to UTC). */
export function formatAbsoluteDate(value: string | Date | null | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  // Component options, not dateStyle/timeStyle: Intl throws if a style shorthand is combined
  // with a component option like `timeZoneName`.
  return formatDateTime(date, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/** Status dot alone, for rows that render their own label. */
export function StatusDot({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        'h-[7px] w-[7px] shrink-0 rounded-full',
        STATUS_DOT[status] ?? 'bg-ui-subtle',
        status === 'running' && 'animate-pulse',
        className,
      )}
      aria-hidden
    />
  );
}

/** Dot + status word + duration ("● Done  1m 36s") - counterpart to the table's status cell. */
export function StatusLine({
  status,
  duration,
  className,
}: {
  status: string;
  duration?: string | null;
  className?: string;
}) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <StatusDot status={status} />
      <span className="truncate text-[13px] leading-none text-ui-default">{statusLabel(status)}</span>
      {duration && (
        <span className="ui-font-mono shrink-0 text-[11px] leading-none tabular-nums text-ui-default dark:text-ui-subtle">
          {duration}
        </span>
      )}
    </span>
  );
}

/** Status line for a whole job - derives its own wall-clock duration. */
export function JobStatusLine({ job, className }: { job: JobDetail; className?: string }) {
  return <StatusLine status={job.status} duration={jobDuration(job)} className={className} />;
}

/** Verdict pill: the border stays neutral so only the leading icon carries colour. */
export function VerdictPill({ verdict }: { verdict: NonNullable<JobSummary['verdict']> }) {
  const approved = verdict === 'approve';
  const Icon = approved ? CheckCircle2 : MessageSquare;

  return (
    <span className="inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-full border border-ui-line px-2 text-[11px] font-medium leading-none text-ui-default">
      <Icon
        size={11}
        strokeWidth={2.25}
        className={cn('shrink-0', approved ? 'text-success' : 'text-warning')}
      />
      <span className="truncate capitalize">{verdict}</span>
    </span>
  );
}

/** A neutral bordered pill for anything that isn't a verdict (e.g. correctness). */
export function OutlinePill({
  icon: Icon,
  tone,
  children,
}: {
  icon?: LucideIcon;
  tone?: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-full border border-ui-line px-2 text-[11px] font-medium leading-none text-ui-default">
      {Icon && <Icon size={11} strokeWidth={2.25} className={cn('shrink-0', tone)} />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Icon-prefixed metadata text - the table's `MetaCell`, usable inline or in a row. */
export function MetaChip({
  icon: Icon,
  children,
  mono = false,
  title,
  className,
}: {
  icon: LucideIcon;
  children: ReactNode;
  mono?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)} title={title}>
      <Icon size={13} strokeWidth={2} className="shrink-0 text-ui-subtle" />
      <span
        className={cn(
          'truncate leading-none text-ui-default dark:text-ui-subtle',
          mono ? 'ui-font-mono text-[11px] tabular-nums' : 'text-xs',
        )}
      >
        {children}
      </span>
    </span>
  );
}

/**
 * Author avatar. Hits avatars.githubusercontent.com directly, since the github.com/<login>.png
 * redirect hop can fail, and falls back to an initial. No `loading="lazy"`: intersection
 * detection is unreliable inside the app's scroll containers.
 */
export function AuthorAvatar({ login, size = 20 }: { login: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size };

  if (!login || failed) {
    return (
      <span
        style={box}
        className="flex shrink-0 items-center justify-center rounded-full bg-ui-fill text-[9px] font-semibold uppercase text-ui-default ring-1 ring-ui-line"
        title={login ? `@${login}` : undefined}
      >
        {login?.charAt(0) ?? ''}
      </span>
    );
  }

  return (
    <img
      src={`https://avatars.githubusercontent.com/${login}?size=40`}
      alt=""
      style={box}
      title={`@${login}`}
      onError={() => setFailed(true)}
      className="shrink-0 rounded-full bg-ui-fill object-cover ring-1 ring-ui-line"
    />
  );
}

export function AuthorChip({ login }: { login: string | null }) {
  if (!login) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={`@${login}`}>
      <AuthorAvatar login={login} size={16} />
      <span className="truncate text-xs leading-none text-ui-default dark:text-ui-subtle">
        {login}
      </span>
    </span>
  );
}

/** One label → value row. Fixed height and hairline dividers echo the table's 48px rhythm. */
export const DETAIL_ROW =
  'flex h-11 items-center justify-between gap-4 border-t border-ui-line first:border-transparent';

export const DETAIL_LABEL = 'shrink-0 text-xs leading-none text-ui-default dark:text-ui-subtle';

export function EmptyValue() {
  return <span className="text-xs leading-none text-ui-subtle">-</span>;
}

/** File path in the table's mono style: the directory recedes, the basename carries the weight. */
export function MonoPath({ path, className }: { path: string; className?: string }) {
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash + 1);
  const base = slash === -1 ? path : path.slice(slash + 1);

  return (
    <span className={cn('ui-font-mono flex min-w-0 text-xs leading-none', className)} title={path}>
      {dir && <span className="truncate text-ui-subtle">{dir}</span>}
      <span className="shrink-0 text-ui-default">{base}</span>
    </span>
  );
}
