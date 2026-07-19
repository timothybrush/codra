import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { LoadError } from '@client/components/shared/load-error';
import {
  ChevronLeft, FileCode2, Clock, Cpu, Hash,
  AlertCircle, CheckCircle2, SkipForward, Hourglass,
  ChevronDown,
} from 'lucide-react';
import { useJobDetail } from '@client/hooks/use-job-detail';
import { JobDetailSkeleton } from '@client/components/features/job-detail/job-skeleton';
import { Badge } from '@client/components/ui/badge';
import { api } from '@client/lib/api';
import type { FileReviewRecord } from '@shared/schema';

import { formatDuration } from '@client/lib/utils';

/* diff_input isn't persisted in Postgres (reconstructed on demand from KV/GitHub — see
   GET /api/jobs/:id/diffs); fetched lazily here and session-cached per job, sharing the
   same cache key as the Files-changed tab so switching between the two doesn't refetch. */
function readDiffsCache(jobId: string): Record<string, string> | null {
  try {
    const raw = sessionStorage.getItem(`codra:job-diffs:${jobId}`);
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

function writeDiffsCache(jobId: string, diffs: Record<string, string>) {
  try {
    sessionStorage.setItem(`codra:job-diffs:${jobId}`, JSON.stringify(diffs));
  } catch {
    /* quota exceeded / unavailable — skip */
  }
}

function fmtK(n: number | null) {
  if (n === null) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

type FileStatus = FileReviewRecord['fileStatus'];

const STATUS_META: Record<FileStatus, {
  Icon: typeof CheckCircle2;
  iconCls: string;
  badge: 'success' | 'neutral' | 'danger';
  label: string;
}> = {
  done:    { Icon: CheckCircle2, iconCls: 'text-success',   badge: 'success', label: 'Done'    },
  skipped: { Icon: SkipForward,  iconCls: 'text-ui-subtle', badge: 'neutral', label: 'Skipped' },
  failed:  { Icon: AlertCircle,  iconCls: 'text-danger',    badge: 'danger',  label: 'Failed'  },
  pending: { Icon: Hourglass,    iconCls: 'text-ui-subtle', badge: 'neutral', label: 'Pending' },
};

function FileRow({ file, diffsLoading }: { file: FileReviewRecord; diffsLoading: boolean }) {
  const meta = STATUS_META[file.fileStatus] ?? STATUS_META.pending;
  const { Icon } = meta;
  const duration = formatDuration(file.durationMs);
  const inTok    = fmtK(file.inputTokens);
  const outTok   = fmtK(file.outputTokens);
  const modelShort = file.modelUsed?.split('/').pop() ?? null;

  return (
    <details className="group min-w-0">
      <summary className="flex cursor-pointer select-none list-none items-center gap-3 px-4 py-3 transition-colors hover:bg-ui-fill/40 [&::-webkit-details-marker]:hidden sm:px-5">

        {/* Status icon */}
        <Icon size={14} className={`shrink-0 ${meta.iconCls}`} />

        {/* File path */}
        <span className="ui-font-mono min-w-0 flex-1 truncate text-xs text-ui-default">
          {file.filePath}
        </span>

        {/* Meta chips — hidden on small screens */}
        <div className="hidden shrink-0 items-center gap-3 md:flex">
          {modelShort && (
            <span className="ui-font-mono flex items-center gap-1 text-[10px] text-ui-subtle">
              <Cpu size={10} />{modelShort}
            </span>
          )}
          {duration && (
            <span className="ui-font-mono flex items-center gap-1 text-[10px] tabular-nums text-ui-subtle">
              <Clock size={10} />{duration}
            </span>
          )}
          {(inTok || outTok) && (
            <span className="ui-font-mono flex items-center gap-1 text-[10px] tabular-nums text-ui-subtle">
              <Hash size={10} />{inTok ?? '—'}↑ {outTok ?? '—'}↓
            </span>
          )}
        </div>

        {/* Status pill */}
        <Badge variant={meta.badge} className="shrink-0">
          {meta.label}
        </Badge>

        {/* Chevron */}
        <ChevronDown
          size={14}
          className="shrink-0 text-ui-subtle transition-transform duration-200 group-open:rotate-180"
        />
      </summary>

      {/* Expanded content */}
      <div className="border-t border-ui-line/60">

        {/* Mobile meta strip */}
        <div className="ui-well ui-font-mono flex flex-wrap gap-x-5 gap-y-1 border-b border-ui-line/60 px-4 py-2.5 text-[10px] text-ui-subtle md:hidden">
          {modelShort && <span><Cpu size={9} className="mr-1 inline" />{modelShort}</span>}
          {duration   && <span><Clock size={9} className="mr-1 inline" />{duration}</span>}
          {inTok      && <span><Hash size={9} className="mr-1 inline" />{inTok}↑ {outTok ?? '—'}↓</span>}
        </div>

        {/* File-level error */}
        {file.fileStatus === 'failed' && file.errorMessage && (
          <div
            className="mx-4 mt-4 rounded-md border p-3.5 sm:mx-5"
            style={{ background: 'var(--danger-bg)', borderColor: 'var(--danger-border)' }}
          >
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--danger)' }}>
              Review error
            </p>
            <p className="ui-font-mono break-all text-xs leading-relaxed" style={{ color: 'var(--danger)' }}>
              {file.errorMessage}
            </p>
          </div>
        )}

        {/* Two-column content */}
        <div className="grid grid-cols-1 divide-y divide-ui-line/60 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
          <div className="flex min-w-0 flex-col gap-2.5 p-4 sm:p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">
              Prompt / diff
            </p>
            <pre className="code-block thin-scroll max-h-[480px] flex-1 overflow-auto text-[10px] leading-relaxed sm:text-[11px]">
              {file.diffInput ?? (diffsLoading ? '— Loading… —' : '— Prompt unavailable —')}
            </pre>
          </div>
          <div className="flex min-w-0 flex-col gap-2.5 p-4 sm:p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">
              Raw model output
            </p>
            <pre className="code-block thin-scroll max-h-[480px] flex-1 overflow-auto text-[10px] leading-relaxed sm:text-[11px]">
              {file.rawAiOutput ?? '— No output saved —'}
            </pre>
          </div>
        </div>
      </div>
    </details>
  );
}

export function JobLogsPage() {
  const { id = '' } = useParams();
  const { job, error } = useJobDetail(id);

  const [diffsByPath, setDiffsByPath] = useState<Record<string, string> | null>(() => readDiffsCache(id));
  const [diffsLoading, setDiffsLoading] = useState(diffsByPath === null);

  useEffect(() => {
    let cancelled = false;
    setDiffsLoading(true);
    api.getJobDiffs(id)
      .then((res) => {
        if (cancelled) return;
        setDiffsByPath(res.diffs);
        writeDiffsCache(id, res.diffs);
      })
      .catch(() => {
        if (!cancelled) setDiffsByPath((current) => current ?? {});
      })
      .finally(() => {
        if (!cancelled) setDiffsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const files = useMemo(
    () => (job ? job.files.map((f) => (diffsByPath?.[f.filePath] ? { ...f, diffInput: diffsByPath[f.filePath] } : f)) : []),
    [job, diffsByPath],
  );

  if (!job) return <JobDetailSkeleton error={error} />;

  const counts = {
    done:    files.filter(f => f.fileStatus === 'done').length,
    skipped: files.filter(f => f.fileStatus === 'skipped').length,
    failed:  files.filter(f => f.fileStatus === 'failed').length,
    total:   files.length,
  };

  return (
    <section className="ui-font-sans flex flex-col gap-5">

      {/* Back */}
      <Link
        to={`/jobs/${job.id}`}
        className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-ui-subtle transition-colors hover:text-ui-default"
      >
        <ChevronLeft size={14} />
        Back to Job Details
      </Link>

      {/* Page header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-foreground" style={{ letterSpacing: '-0.02em' }}>
            Review logs
          </h1>
          <p className="ui-font-mono mt-1.5 truncate text-xs text-ui-subtle">
            {job.owner}/{job.repo} · #{job.prNumber} · {job.commitSha.slice(0, 7)}
          </p>
        </div>

        {/* Summary counts */}
        {counts.total > 0 && (
          <div className="ui-panel flex shrink-0 items-center divide-x divide-ui-line/60 overflow-hidden">
            {[
              { label: 'Files',    val: counts.total,   cls: 'text-ui-strong' },
              { label: 'Reviewed', val: counts.done,    cls: 'text-success'   },
              { label: 'Skipped',  val: counts.skipped, cls: 'text-ui-subtle' },
              { label: 'Failed',   val: counts.failed,  cls: counts.failed > 0 ? 'text-danger' : 'text-ui-subtle' },
            ].map(({ label, val, cls }) => (
              <div key={label} className="flex flex-col items-center px-4 py-2.5">
                <span className={`ui-font-mono text-base leading-none tabular-nums ${cls}`}>{val}</span>
                <span className="mt-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">{label}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <LoadError title="Something went wrong" detail={error} />}

      {/* File list */}
      {files.length === 0 ? (
        <div className="ui-panel flex flex-col items-center justify-center gap-4 py-20 text-center">
          <FileCode2 size={36} className="text-ui-subtle/30" strokeWidth={1.5} />
          <div>
            <p className="text-sm font-medium text-ui-default">No files processed yet</p>
            {(job.status === 'running' || job.status === 'queued') && (
              <p className="mt-1 text-xs text-ui-subtle">
                Logs appear here once files are reviewed
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="ui-panel min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 border-b border-ui-line px-4 py-3 sm:px-5">
            <FileCode2 size={15} strokeWidth={2} className="shrink-0 text-ui-default" />
            <h2 className="text-[13px] font-medium text-ui-default">File reviews</h2>
            <span className="ui-font-mono ml-auto text-[11px] tabular-nums text-ui-subtle">
              {counts.total} {counts.total === 1 ? 'file' : 'files'}
            </span>
          </div>
          <div className="divide-y divide-ui-line/60">
            {files.map(file => (
              <FileRow key={file.id} file={file} diffsLoading={diffsLoading} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
