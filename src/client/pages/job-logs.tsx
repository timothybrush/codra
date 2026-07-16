import { useParams, Link } from 'react-router-dom';
import { LoadError } from '@client/components/shared/load-error';
import {
  ChevronLeft, FileCode2, Clock, Cpu, Hash,
  AlertCircle, CheckCircle2, SkipForward, Hourglass,
  ChevronDown,
} from 'lucide-react';
import { useJobDetail } from '@client/hooks/use-job-detail';
import { JobDetailSkeleton } from '@client/components/features/job-detail/job-skeleton';
import { Alert } from '@client/components/ui/alert';
import type { FileReviewRecord } from '@shared/schema';

import { formatDuration } from '@client/lib/utils';

function fmtK(n: number | null) {
  if (n === null) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

type FileStatus = FileReviewRecord['fileStatus'];

const STATUS_META: Record<FileStatus, {
  Icon: typeof CheckCircle2;
  iconCls: string;
  pill: string;
  label: string;
}> = {
  done:    { Icon: CheckCircle2, iconCls: 'text-success',          pill: 'bg-success/10 text-success border-success/20',          label: 'Done'    },
  skipped: { Icon: SkipForward,  iconCls: 'text-muted-foreground', pill: 'bg-secondary text-muted-foreground border-border/50',   label: 'Skipped' },
  failed:  { Icon: AlertCircle,  iconCls: 'text-danger',           pill: 'bg-danger/10 text-danger border-danger/20',             label: 'Failed'  },
  pending: { Icon: Hourglass,    iconCls: 'text-muted-foreground', pill: 'bg-secondary text-muted-foreground border-border/50',   label: 'Pending' },
};

function FileCard({ file }: { file: FileReviewRecord }) {
  const meta = STATUS_META[file.fileStatus] ?? STATUS_META.pending;
  const { Icon } = meta;
  const duration = formatDuration(file.durationMs);
  const inTok    = fmtK(file.inputTokens);
  const outTok   = fmtK(file.outputTokens);
  const modelShort = file.modelUsed?.split('/').pop() ?? null;

  return (
    <details className="group surface overflow-hidden">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden hover:bg-muted/20 transition-colors select-none">

        {/* Status icon */}
        <Icon size={15} className={`shrink-0 ${meta.iconCls}`} />

        {/* File path */}
        <span className="font-mono text-sm text-foreground truncate flex-1 min-w-0">
          {file.filePath}
        </span>

        {/* Meta chips — hidden on small screens */}
        <div className="hidden md:flex items-center gap-3 shrink-0">
          {modelShort && (
            <span className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground/50">
              <Cpu size={10} />{modelShort}
            </span>
          )}
          {duration && (
            <span className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground/50">
              <Clock size={10} />{duration}
            </span>
          )}
          {(inTok || outTok) && (
            <span className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground/50">
              <Hash size={10} />{inTok ?? '—'}↑ {outTok ?? '—'}↓
            </span>
          )}
        </div>

        {/* Status pill */}
        <span className={`shrink-0 inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${meta.pill}`}>
          {meta.label}
        </span>

        {/* Chevron */}
        <ChevronDown
          size={14}
          className="shrink-0 text-muted-foreground/40 transition-transform duration-200 group-open:rotate-180"
        />
      </summary>

      {/* Expanded content */}
      <div className="border-t border-border/40">

        {/* Mobile meta strip */}
        <div className="md:hidden flex flex-wrap gap-x-5 gap-y-1 px-5 py-2.5 bg-muted/10 border-b border-border/30 text-[10px] font-mono text-muted-foreground/60">
          {modelShort && <span><Cpu size={9} className="inline mr-1" />{modelShort}</span>}
          {duration   && <span><Clock size={9} className="inline mr-1" />{duration}</span>}
          {inTok      && <span><Hash size={9} className="inline mr-1" />{inTok}↑ {outTok ?? '—'}↓</span>}
        </div>

        {/* File-level error */}
        {file.fileStatus === 'failed' && file.errorMessage && (
          <div
            className="mx-5 mt-4 rounded-lg border p-3.5"
            style={{ background: 'var(--danger-bg)', borderColor: 'var(--danger-border)' }}
          >
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--danger)' }}>
              Review error
            </p>
            <p className="font-mono text-xs break-all leading-relaxed" style={{ color: 'var(--danger)' }}>
              {file.errorMessage}
            </p>
          </div>
        )}

        {/* Two-column content */}
        <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-border/40">
          <div className="p-5 min-w-0 flex flex-col gap-2.5">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Prompt / diff
            </p>
            <pre className="code-block flex-1 max-h-[480px] text-[10px] sm:text-[11px] overflow-auto leading-relaxed">
              {file.diffInput ?? '— No prompt saved —'}
            </pre>
          </div>
          <div className="p-5 min-w-0 flex flex-col gap-2.5">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Raw model output
            </p>
            <pre className="code-block flex-1 max-h-[480px] text-[10px] sm:text-[11px] overflow-auto leading-relaxed">
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

  if (!job) return <JobDetailSkeleton error={error} />;

  const counts = {
    done:    job.files.filter(f => f.fileStatus === 'done').length,
    skipped: job.files.filter(f => f.fileStatus === 'skipped').length,
    failed:  job.files.filter(f => f.fileStatus === 'failed').length,
    total:   job.files.length,
  };

  return (
    <section className="flex flex-col gap-6">

      {/* Back */}
      <Link
        to={`/jobs/${job.id}`}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors w-fit"
      >
        <ChevronLeft size={14} />
        Back to Job Details
      </Link>

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary mb-1.5">Raw Logs</p>
          <h1 className="text-2xl font-bold tracking-tight text-foreground leading-none">Review logs</h1>
          <p className="mt-2 text-sm text-muted-foreground font-mono">
            {job.owner}/{job.repo} · PR #{job.prNumber} · <span className="opacity-60">{job.commitSha.slice(0, 7)}</span>
          </p>
        </div>

        {/* Summary counts */}
        {counts.total > 0 && (
          <div className="flex items-center divide-x divide-border rounded-lg border border-border bg-card shadow-sm overflow-hidden shrink-0">
            {[
              { label: 'Files',   val: counts.total,   cls: 'text-foreground'   },
              { label: 'Reviewed', val: counts.done,   cls: 'text-success'      },
              { label: 'Skipped', val: counts.skipped, cls: 'text-muted-foreground' },
              { label: 'Failed',  val: counts.failed,  cls: counts.failed > 0 ? 'text-danger' : 'text-muted-foreground' },
            ].map(({ label, val, cls }) => (
              <div key={label} className="flex flex-col items-center px-4 py-2.5">
                <span className={`text-base font-bold tabular-nums leading-none ${cls}`}>{val}</span>
                <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground mt-1">{label}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <LoadError title="Something went wrong" detail={error} />}

      {/* File list */}
      {job.files.length === 0 ? (
        <div className="surface flex flex-col items-center justify-center gap-4 py-20 text-center">
          <FileCode2 size={36} className="text-muted-foreground/15" strokeWidth={1.5} />
          <div>
            <p className="text-sm font-semibold text-muted-foreground">No files processed yet</p>
            {(job.status === 'running' || job.status === 'queued') && (
              <p className="mt-1 text-xs text-muted-foreground/50">
                Logs appear here once files are reviewed
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {job.files.map(file => (
            <FileCard key={file.id} file={file} />
          ))}
        </div>
      )}
    </section>
  );
}
