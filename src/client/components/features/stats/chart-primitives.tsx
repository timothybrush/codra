import { Skeleton, GraphShell } from '@codraoss/ui';
import type { ReactNode } from 'react';
import { Activity, Boxes, Coins, FolderGit2, ShieldCheck } from 'lucide-react';
import { formatCompact, formatDayRange } from './chart-support';

export function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;

  const endDay: string | undefined = payload[0]?.payload?.endDay;
  const heading =
    typeof label === 'string' && label.includes('-') ? formatDayRange(label, endDay) : label;

  return (
    <div className="rounded-md bg-ui-base px-3 py-2.5 text-xs shadow-lg ring ring-ui-line">
      {label && <p className="mb-2 font-semibold text-ui-strong">{heading}</p>}
      <div className="space-y-1.5">
        {payload.map((item: any) => (
          <div key={item.dataKey ?? item.name} className="flex min-w-32 items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: item.color === 'url(#hatchGray)' ? 'currentColor' : item.color }}
            />
            <span className="flex-1 capitalize text-ui-subtle">{item.name}</span>
            <span className="font-semibold tabular-nums text-ui-default">
              {typeof item.value === 'number' ? formatCompact(item.value) : item.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GraphCardSkeleton({ title, icon, className = '' }: { title: string; icon?: ReactNode; className?: string }) {
  return (
    <GraphShell title={title} icon={icon} className={className}>
      <div className="h-64 px-4 pb-4 pt-4 sm:h-80 sm:px-5 sm:pb-5">
        <Skeleton height="100%" width="100%" borderRadius={6} />
      </div>
    </GraphShell>
  );
}

function GraphBarCardSkeleton({ title, icon, rows = 5, className = '' }: { title: string; icon?: ReactNode; rows?: number; className?: string }) {
  return (
    <GraphShell title={title} icon={icon} className={className}>
      <div className="space-y-4 px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton height={12} width={90} />
            <Skeleton height={14} width="100%" />
            <Skeleton height={12} width={34} />
          </div>
        ))}
      </div>
    </GraphShell>
  );
}

export function MetricsGridSkeleton() {
  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        <GraphCardSkeleton title="Review Flow" icon={<Activity size={14} strokeWidth={2} />} />
        <GraphCardSkeleton title="Token Volume" icon={<Coins size={14} strokeWidth={2} />} />
      </div>
      <div className="grid gap-4 sm:gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <GraphBarCardSkeleton title="Job Health" icon={<ShieldCheck size={14} strokeWidth={2} />} />
        <GraphBarCardSkeleton title="Top Repositories" icon={<FolderGit2 size={14} strokeWidth={2} />} rows={4} />
        <GraphBarCardSkeleton title="Model Calls" icon={<Boxes size={14} strokeWidth={2} />} rows={5} />
      </div>
    </div>
  );
}
