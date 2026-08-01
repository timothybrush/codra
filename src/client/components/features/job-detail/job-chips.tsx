/**
 * The row vocabulary shared by the job detail page, mirroring the deployment-style
 * jobs table (`@client/components/shared/jobs-table`): status is a coloured dot +
 * word + duration, verdicts are restrained bordered pills, and every other piece
 * of metadata is a compact muted icon chip. Keeping these in one place is what
 * makes the detail page and the list read as one product.
 */
import { useState, type ReactNode } from 'react';
import { CheckCircle2, MessageSquare, type LucideIcon } from 'lucide-react';
import { cn } from '@client/lib/utils';
import { formatDateTime } from '@client/lib/timezone';

import type { JobDetail, JobSummary } from '@shared/schema';

/* ── Formatters (terser than Intl, matching the jobs table) ───────────────── */

/** Dot tone per status — same semantic tokens the jobs table uses. */
const STATUS_DOT: Record<string, string> = {
  done: 'bg-success',
  running: 'bg-info',
  queued: 'bg-warning',
  failed: 'bg-danger',
  superseded: 'bg-ui-subtle',
  cancelled: 'bg-ui-subtle',
  stopped: 'bg-ui-subtle',
  // File- and step-level statuses reuse the same vocabulary. `pending` means
  // "not reached yet", so it stays neutral rather than borrowing queued's amber.
  pending: 'bg-ui-subtle',
  skipped: 'bg-ui-subtle',
};

export function statusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');
}

/** Whole seconds/minutes/hours — no decimals, so the chip stays narrow. */
export function formatRunDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Wall-clock run time: start → finish, or start → now while still running. */
export function jobDuration(job: Pick<JobSummary, 'startedAt' | 'finishedAt'>) {
  if (!job.startedAt) return null;
  const start = new Date(job.startedAt).getTime();
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return formatRunDuration(end - start);
}

/** Compact "16m ago" / "15h ago" / "3d ago" stamp. */
export function formatRelativeDate(value: string | Date | null | undefined) {
  if (!value) return '—';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * Full stamp for `title` tooltips, so the terse relative text stays precise.
 * Rendered in the account's display time zone (falls back to the browser's).
 */
export function formatAbsoluteDate(value: string | Date | null | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  // Component options, NOT dateStyle/timeStyle: Intl throws `Invalid option` if
  // either style shorthand is combined with a component like `timeZoneName`.
  return formatDateTime(date, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/* ── Pieces ───────────────────────────────────────────────────────────────── */

/** The 7px status dot on its own (for rows that carry their own label). */
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

/**
 * Coloured dot + status word + run duration (e.g. "● Done  1m 36s") — the
 * detail page's counterpart to the table's status cell.
 */
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

/** Status line for a whole job — derives its own wall-clock duration. */
export function JobStatusLine({ job, className }: { job: JobDetail; className?: string }) {
  return <StatusLine status={job.status} duration={jobDuration(job)} className={className} />;
}

/**
 * Bordered verdict pill with a tinted leading icon: the border stays neutral so
 * only the icon carries colour.
 */
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

/** Icon-prefixed metadata text — the table's `MetaCell`, usable inline or in a row. */
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
 * Author avatar. Hits avatars.githubusercontent.com directly (github.com/<login>.png
 * only 302-redirects, and that hop can fail) and falls back to an initial, so the
 * header never shows a broken-image glyph. No `loading="lazy"` — intersection
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

/** Avatar + login as one chip, for the header's identity line. */
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

/* ── Row rhythm ───────────────────────────────────────────────────────────── */

/**
 * One label → value row inside a panel. Fixed height and hairline dividers give
 * the detail cards the same uniform rhythm as the table's 48px rows (a touch
 * tighter, since these are dense key/value pairs).
 */
export const DETAIL_ROW =
  'flex h-11 items-center justify-between gap-4 border-t border-ui-line first:border-transparent';

/** Muted row label — quiet, sentence case, never competing with its value. */
export const DETAIL_LABEL = 'shrink-0 text-xs leading-none text-ui-default dark:text-ui-subtle';

/** The em-dash placeholder used wherever a nullable field is absent. */
export function EmptyValue() {
  return <span className="text-xs leading-none text-ui-subtle">—</span>;
}

/**
 * A file path rendered like the table's mono cells: the directory prefix recedes
 * and the basename carries the weight, so long paths stay scannable.
 */
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
