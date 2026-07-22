import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  FileText,
  Zap,
} from 'lucide-react';
import { StatusBadge } from '@client/components/ui/badge';
import { Skeleton } from '@client/components/shared/skeleton';
import { cn, fmtNumber } from '@client/lib/utils';

import type { JobSummary } from '@shared/schema';

type Column =
  | 'repo'
  | 'pr'
  | 'status'
  | 'verdict'
  | 'files'
  | 'tokens'
  | 'created'
  | 'action';

interface JobsTableProps {
  jobs: JobSummary[];
  loading: boolean;
  /** Columns to show. Defaults to all. */
  columns?: Column[];
  /**
   * Fill the parent's height and scroll the table body internally (sticky
   * header), instead of growing to fit all rows. Used on the Jobs page so the
   * page / content card never needs its own scrollbar.
   */
  fill?: boolean;
}

const DEFAULT_COLUMNS: Column[] = [
  'pr',
  'repo',
  'status',
  'verdict',
  'created',
  'action',
];

const thCls =
  'border-b border-ui-line px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle select-none';

const COLUMN_CLASSES: Record<Column, string> = {
  repo: 'w-[190px] max-w-[190px]',
  pr: 'max-w-[480px]',
  status: 'w-[150px]',
  verdict: 'w-[120px]',
  files: 'hidden md:table-cell w-[76px]',
  tokens: 'hidden lg:table-cell w-[96px]',
  created: 'hidden sm:table-cell w-[150px]',
  action: 'w-[64px]',
};

const COLUMN_HEADERS: Record<Column, string> = {
  repo: 'Repository',
  pr: 'Title',
  status: 'Status',
  verdict: 'Verdict',
  files: 'Files',
  tokens: 'Tokens',
  created: 'Last Updated',
  action: '',
};

const SKELETON_WIDTHS: Record<Column, number | string> = {
  repo: 112,
  pr: '78%',
  status: 82,
  verdict: 78,
  files: 28,
  tokens: 58,
  created: 88,
  action: 28,
};

function formatDate(value: JobSummary['createdAt']) {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelativeDate(value: JobSummary['createdAt']) {
  const date = new Date(value).getTime();
  const diffSeconds = Math.round((date - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  const divisions: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  for (const [unit, seconds] of divisions) {
    if (absSeconds >= seconds) {
      return formatter.format(Math.round(diffSeconds / seconds), unit);
    }
  }

  return 'just now';
}

function NumericMetric({
  icon: Icon,
  value,
  label,
  strong = false,
}: {
  icon: typeof FileText;
  value: string | number;
  label: string;
  strong?: boolean;
}) {
  return (
    <span
      className={cn(
        'ui-font-mono inline-flex min-w-0 items-center justify-end gap-1.5 text-xs tabular-nums',
        strong ? 'text-ui-default' : 'text-ui-subtle',
      )}
      title={label}
    >
      <Icon size={12} className="text-ui-subtle" />
      {value}
    </span>
  );
}

function JobMobileCard({ job, columns }: { job: JobSummary; columns: Column[] }) {
  const show = (column: Column) => columns.includes(column);
  const tokenTotal = job.totalInputTokens + job.totalOutputTokens;

  return (
    <Link
      to={`/jobs/${job.id}`}
      className="group block border-b border-ui-line px-4 py-4 transition-colors last:border-b-0 hover:bg-ui-fill/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-brand/40 focus-visible:ring-offset-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {show('repo') && (
            <p className="truncate text-xs font-semibold text-ui-default dark:text-ui-subtle">
              {job.owner}/{job.repo}
            </p>
          )}
          {show('pr') && (
            <div className="mt-1 flex min-w-0 items-start gap-2">
              <span className="mt-0.5 shrink-0 ui-font-mono rounded bg-ui-fill/50 px-1.5 py-0.5 text-[11px] font-semibold text-ui-default dark:text-ui-subtle">
                #{job.prNumber}
              </span>
              <p className="line-clamp-2 text-sm font-semibold leading-5 text-ui-strong">
                {job.prTitle ?? 'Untitled PR'}
              </p>
            </div>
          )}
        </div>
        {show('action') && (
          <ArrowUpRight
            size={15}
            className="mt-0.5 shrink-0 text-ui-subtle transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-ui-brand"
          />
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {show('status') && <StatusBadge label={job.status} job={job} />}
        {show('verdict') &&
          (job.verdict ? (
            <StatusBadge label={job.verdict} />
          ) : (
            <span className="text-xs text-ui-subtle">No verdict</span>
          ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-ui-default dark:text-ui-subtle">
        {show('files') && (
          <div className="flex items-center gap-1.5">
            <FileText size={13} />
            <span>{job.fileCount.toLocaleString()} files</span>
          </div>
        )}
        {show('tokens') && (
          <div className="flex items-center gap-1.5">
            <Zap size={13} />
            <span>{fmtNumber(tokenTotal)} tokens</span>
          </div>
        )}
        {show('created') && (
          <span>{formatRelativeDate(job.createdAt)}</span>
        )}
      </div>
    </Link>
  );
}

export function JobsTable({ jobs, loading, columns, fill = false }: JobsTableProps) {
  const cols: Column[] = columns ?? DEFAULT_COLUMNS;
  const tableMinWidth = cols.length > 7 ? 'min-w-[980px]' : 'min-w-[720px]';

  return (
    <div className={cn('min-w-0 max-w-full', fill ? 'flex min-h-0 flex-1 flex-col' : 'overflow-hidden')}>
      <div className={cn('sm:hidden', fill && 'auto-hide-scroll min-h-0 flex-1 overflow-y-auto')}>
        {loading && jobs.length === 0
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="border-b border-ui-line px-4 py-4 last:border-b-0">
                <Skeleton width="42%" height={12} />
                <div className="mt-2 flex items-center gap-2">
                  <Skeleton width={42} height={22} />
                  <Skeleton width="72%" height={18} />
                </div>
                <div className="mt-3 flex gap-2">
                  <Skeleton width={82} height={24} />
                  <Skeleton width={72} height={24} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Skeleton width="70%" height={14} />
                  <Skeleton width="62%" height={14} />
                </div>
              </div>
            ))
          : jobs.map((job) => <JobMobileCard key={job.id} job={job} columns={cols} />)}
      </div>

      <div
        className={cn(
          'hidden max-w-full sm:block',
          fill ? 'auto-hide-scroll min-h-0 flex-1 overflow-auto' : 'overflow-x-auto',
        )}
      >
        <table className={cn('w-full border-separate border-spacing-0 text-sm', tableMinWidth)}>
          <thead>
            <tr className="ui-well">
              {cols.map((col) => (
                <th
                  key={col}
                  className={cn(
                    thCls,
                    COLUMN_CLASSES[col],
                    // Sticky header when the body scrolls internally; the well
                    // background keeps rows from showing through underneath.
                    fill && 'ui-well sticky top-0 z-10',
                    (col === 'files' || col === 'tokens') && 'text-right',
                    col === 'action' && 'text-center',
                  )}
                >
                  {COLUMN_HEADERS[col]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && jobs.length === 0
              ? Array.from({ length: 7 }).map((_, i) => (
                  <tr key={i}>
                    {cols.map((col) => (
                      <td
                        key={col}
                        className={cn('border-t border-ui-line px-4 py-3.5', COLUMN_CLASSES[col])}
                      >
                        <Skeleton width={SKELETON_WIDTHS[col]} />
                      </td>
                    ))}
                  </tr>
                ))
              : jobs.map((job) => {
                  const tokenTotal = job.totalInputTokens + job.totalOutputTokens;

                  // Flat single-line rows (Cloudflare-dashboard table style):
                  // mono data columns, pills for status, no avatars or icons.
                  return (
                    <tr
                      key={job.id}
                      className="group relative transition-colors hover:bg-ui-fill/40"
                    >
                      {cols.includes('repo') && (
                        <td className={cn('border-t border-ui-line px-4 py-3 align-middle', COLUMN_CLASSES.repo)}>
                          <Link
                            to={`/jobs/${job.id}`}
                            className="ui-font-mono block truncate text-xs text-ui-default hover:text-ui-brand"
                            title={`${job.owner}/${job.repo}`}
                          >
                            {job.owner}/{job.repo}
                          </Link>
                        </td>
                      )}

                      {cols.includes('pr') && (
                        <td className={cn('border-t border-ui-line px-4 py-3 align-middle overflow-hidden', COLUMN_CLASSES.pr)}>
                          <div className="flex min-w-0 items-baseline gap-2">
                            <span className="ui-font-mono shrink-0 text-[11px] text-ui-default dark:text-ui-subtle">
                              #{job.prNumber}
                            </span>
                            <Link
                              to={`/jobs/${job.id}`}
                              className="block truncate text-sm text-ui-default group-hover:text-ui-strong"
                              title={job.prAuthor ? `opened by ${job.prAuthor}` : undefined}
                            >
                              {job.prTitle ?? 'Untitled PR'}
                            </Link>
                          </div>
                        </td>
                      )}

                      {cols.includes('status') && (
                        <td className={cn('border-t border-ui-line px-4 py-3 align-middle', COLUMN_CLASSES.status)}>
                          <StatusBadge label={job.status} job={job} />
                        </td>
                      )}

                      {cols.includes('verdict') && (
                        <td className={cn('border-t border-ui-line px-4 py-3 align-middle', COLUMN_CLASSES.verdict)}>
                          {job.verdict ? (
                            <StatusBadge label={job.verdict} />
                          ) : (
                            <span className="text-ui-subtle">-</span>
                          )}
                        </td>
                      )}

                      {cols.includes('files') && (
                        <td className={cn('border-t border-ui-line px-4 py-3 text-right align-middle', COLUMN_CLASSES.files)}>
                          <NumericMetric
                            icon={FileText}
                            value={job.fileCount.toLocaleString()}
                            label="Files reviewed"
                          />
                        </td>
                      )}

                      {cols.includes('tokens') && (
                        <td className={cn('border-t border-ui-line px-4 py-3 text-right align-middle', COLUMN_CLASSES.tokens)}>
                          <NumericMetric
                            icon={Zap}
                            value={fmtNumber(tokenTotal)}
                            label={`${tokenTotal.toLocaleString()} total tokens`}
                          />
                        </td>
                      )}

                      {cols.includes('created') && (
                        <td className={cn('whitespace-nowrap border-t border-ui-line px-4 py-3 align-middle', COLUMN_CLASSES.created)}>
                          <span
                            className="ui-font-mono text-xs tabular-nums text-ui-default dark:text-ui-subtle"
                            title={formatRelativeDate(job.createdAt)}
                          >
                            {formatDate(job.createdAt)}
                          </span>
                        </td>
                      )}

                      {cols.includes('action') && (
                        <td className={cn('border-t border-ui-line px-4 py-3 text-center align-middle', COLUMN_CLASSES.action)}>
                          <Link
                            to={`/jobs/${job.id}`}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ui-subtle transition-colors hover:bg-ui-fill hover:text-ui-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-brand/40"
                            aria-label={`Open job for ${job.owner}/${job.repo} pull request ${job.prNumber}`}
                          >
                            <ArrowUpRight size={14} />
                          </Link>
                        </td>
                      )}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
