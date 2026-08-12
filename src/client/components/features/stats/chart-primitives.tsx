import { Children, type ReactNode } from 'react';
import { Activity, Boxes, Coins, FolderGit2, ShieldCheck } from 'lucide-react';
import { LayerCard } from '@client/components/ui/layer-card';
import { Skeleton } from '@client/components/shared/skeleton';
import { cn } from '@client/lib/utils';
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

function CardDots() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 opacity-[0.35]"
      style={{
        backgroundImage: 'radial-gradient(circle, var(--ui-line) 1px, transparent 1px)',
        backgroundSize: '18px 18px',
      }}
    />
  );
}

export function GraphShell({
  title,
  icon,
  legend,
  children,
  className = '',
}: {
  title: string;
  icon?: ReactNode;
  legend?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <LayerCard className={cn('relative flex flex-col overflow-hidden', className)}>
      <CardDots />
      <div className="relative flex items-center gap-2 px-4 pt-4 sm:px-5 sm:pt-5">
        {icon && <span className="shrink-0 text-ui-subtle">{icon}</span>}
        <h3 className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-ui-default">
          {title}
        </h3>
      </div>
      {legend && (
        <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 pt-3 sm:px-5">
          {legend}
        </div>
      )}
      <div className="relative flex flex-1 flex-col">{children}</div>
    </LayerCard>
  );
}

/** Legend chip: solid square, hatched square, or dashed-line swatch + label. */
export function LegendChip({
  color,
  hatched,
  dashed,
  label,
}: {
  color?: string;
  hatched?: boolean;
  dashed?: boolean;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-ui-subtle">
      {dashed ? (
        <span
          className="h-0 w-3.5 shrink-0 border-t-2 border-dashed"
          style={{ borderColor: color }}
        />
      ) : (
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
          style={
            hatched
              ? {
                  backgroundImage:
                    'repeating-linear-gradient(45deg, var(--ui-subtle) 0 1.5px, transparent 1.5px 3.5px)',
                  backgroundColor: 'color-mix(in oklch, var(--ui-fill) 60%, transparent)',
                }
              : { backgroundColor: color }
          }
        />
      )}
      {label}
    </span>
  );
}

/** SVG defs shared by the bar/area charts: diagonal hatch + soft fills. */
export function ChartDefs({ isDark }: { isDark: boolean }) {
  const hatch = isDark ? 'rgba(228,228,231,0.5)' : 'rgba(63,63,70,0.4)';
  const hatchBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';
  return (
    <defs>
      <pattern id="hatchGray" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
        <rect width="5" height="5" fill={hatchBg} />
        <line x1="0" y1="0" x2="0" y2="5" stroke={hatch} strokeWidth="1.4" />
      </pattern>
      <linearGradient id="blueBar" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#60a5fa" />
        <stop offset="100%" stopColor="#2563eb" />
      </linearGradient>
      <linearGradient id="amberFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={isDark ? '#f59e0b' : '#d97706'} stopOpacity={0.16} />
        <stop offset="100%" stopColor={isDark ? '#f59e0b' : '#d97706'} stopOpacity={0.02} />
      </linearGradient>
    </defs>
  );
}

/**
 * Caps a meter list at `visible` rows and scrolls the rest, so a long tail (dozens of models)
 * can't stretch the card and throw off the others sharing its grid row. The cap is a pixel
 * max-height derived from the fixed row/gap metrics below, which is why `TickMeter` pins its
 * own height.
 */
const METER_ROW_PX = 20;
const METER_GAP_PX = 14;

export function MeterList({ visible, children }: { visible: number; children: ReactNode }) {
  // Only the overflowing case gets the cap and the scrollbar gutter, so short lists keep even padding.
  const scrolls = Children.count(children) > visible;

  return (
    <div className="px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
      <div
        className={cn('space-y-3.5', scrolls && 'overflow-y-auto pr-3')}
        style={scrolls ? { maxHeight: visible * METER_ROW_PX + (visible - 1) * METER_GAP_PX } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

/** Segmented tick meter (reference "cost allocation" bars). */
export function TickMeter({
  label,
  value,
  max,
  color,
  valueLabel,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
  valueLabel: string;
}) {
  const SEGMENTS = 26;
  const filled = value > 0 ? Math.max(1, Math.round((value / Math.max(max, 1)) * SEGMENTS)) : 0;

  return (
    <div className="flex h-5 items-center gap-3">
      <span className="w-28 shrink-0 truncate text-[13px] font-medium text-ui-default" title={label}>
        {label}
      </span>
      <div className="flex h-4 flex-1 items-stretch gap-[2.5px]" aria-hidden>
        {Array.from({ length: SEGMENTS }).map((_, i) => (
          <span
            key={i}
            className="min-w-[2px] flex-1 rounded-[1px]"
            style={{ backgroundColor: i < filled ? color : 'var(--ui-fill)' }}
          />
        ))}
      </div>
      <span className="ui-font-mono w-14 shrink-0 text-right text-xs tabular-nums text-ui-default">
        {valueLabel}
      </span>
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
