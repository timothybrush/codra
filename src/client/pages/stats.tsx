import { useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  Boxes,
  Coins,
  FolderGit2,
  ShieldCheck,
} from 'lucide-react';
import { LayerCard } from '@client/components/ui/layer-card';
import { PageHeaderActions } from '@client/components/shared/page-header-actions';
import { PageHeader } from '@client/components/layout/page-header';
import { Skeleton } from '@client/components/shared/skeleton';
import { LoadError } from '@client/components/shared/load-error';
import { useIsDarkMode } from '@client/hooks/use-is-dark-mode';
import { usePolling } from '@client/hooks/use-polling';
import { api } from '@client/lib/api';
import { cn, fmtNumber } from '@client/lib/utils';
import { formatDayLabel } from '@client/lib/timezone';
import type { StatsPayload } from '@shared/schema';

const CHART = {
  primary: '#65a30d',
  primaryDark: '#e0fe56',
  blue: '#3b82f6',
  blueDark: '#3b82f6',
  amber: '#d97706',
  amberDark: '#f59e0b',
  danger: '#dc2626',
  dangerDark: '#f87171',
  info: '#0ea5e9',
  infoDark: '#38bdf8',
  quiet: '#94a3b8',
  quietDark: '#64748b',
};

// Per-row accents for the segmented tick meters (reference: white / orange /
// cyan / blue / purple rhythm).
const TICK_COLORS_DARK = ['#e4e4e7', '#fb923c', '#22d3ee', '#3b82f6', '#a78bfa'];
const TICK_COLORS_LIGHT = ['#3f3f46', '#ea580c', '#0891b2', '#2563eb', '#7c3aed'];

const MONO_STACK = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

/**
 * The server buckets days in the account's display zone and returns plain
 * `YYYY-MM-DD` strings, so the label must be rendered verbatim — parsing it in the
 * viewer's local zone used to shift it a day for negative UTC offsets.
 */
function formatDay(value: string) {
  return formatDayLabel(value);
}

function formatCompact(value: number) {
  return value >= 1000 ? fmtNumber(value) : value.toLocaleString();
}

function modelName(model: string) {
  return model.split('/').pop()?.replace(/-/g, ' ') ?? model;
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-md bg-ui-base px-3 py-2.5 text-xs shadow-lg ring ring-ui-line">
      {label && (
        <p className="mb-2 font-semibold text-ui-strong">
          {typeof label === 'string' && label.includes('-') ? formatDay(label) : label}
        </p>
      )}
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

/* ── Card chrome ─────────────────────────────────────────────────────────── */

/** Faint dot-grid texture behind chart content (reference dashboard look). */
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

function GraphShell({
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
function LegendChip({
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
function ChartDefs({ isDark }: { isDark: boolean }) {
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

/** Segmented tick meter (reference "cost allocation" bars). */
function TickMeter({
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
    <div className="flex items-center gap-3">
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

/* ── Metrics grid ────────────────────────────────────────────────────────── */

function MetricsGrid({
  stats,
  isDark,
}: {
  stats: StatsPayload;
  isDark: boolean;
}) {
  const lime = isDark ? CHART.primaryDark : CHART.primary;
  const amber = isDark ? CHART.amberDark : CHART.amber;
  const dangerColor = isDark ? CHART.dangerDark : CHART.danger;
  const infoColor = isDark ? CHART.infoDark : CHART.info;
  const quietColor = isDark ? CHART.quietDark : CHART.quiet;
  const dashColor = isDark ? 'rgba(228,228,231,0.75)' : 'rgba(63,63,70,0.65)';
  const tickColors = isDark ? TICK_COLORS_DARK : TICK_COLORS_LIGHT;
  const repoMax = Math.max(...stats.topRepos.map((repo) => repo.jobs), 1);
  const modelMax = Math.max(...stats.models.map((model) => model.calls), 1);

  // Theme-aware chart chrome. CSS variables don't reliably resolve inside
  // Recharts SVG text, so use explicit colors keyed off the active theme.
  const axisColor = isDark ? 'rgba(228,228,231,0.55)' : 'rgba(63,63,70,0.7)';
  const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
  const cursorColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
  const axisProps = {
    fontSize: 10,
    tickLine: false,
    tickMargin: 8,
    axisLine: false,
    tick: { fontFamily: MONO_STACK, fill: axisColor },
  } as const;
  // Let Recharts thin the labels by available space (respecting minTickGap)
  // rather than a fixed stride keyed off the range — the trend array can have
  // far fewer points than `days`, which would hide every label but the first.
  const xAxisProps = {
    dataKey: 'day',
    tickFormatter: formatDay,
    interval: 'preserveStartEnd' as const,
    minTickGap: 24,
  };

  const STATUS_COLOR: Record<string, string> = {
    done: lime,
    running: infoColor,
    queued: quietColor,
    failed: dangerColor,
    superseded: quietColor,
    cancelled: quietColor,
  };
  const statusTotal = Math.max(stats.statuses.reduce((sum, s) => sum + s.count, 0), 1);

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        <GraphShell
          title="Review Flow"
          icon={<Activity size={14} strokeWidth={2} />}
          legend={
            <>
              <LegendChip color={amber} label="Reviews" />
              <LegendChip color={dashColor} dashed label="Comments" />
            </>
          }
        >
          <div className="h-64 px-2 pb-4 pt-3 sm:h-80 sm:px-3 sm:pb-5">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <AreaChart data={stats.trend} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
                <ChartDefs isDark={isDark} />
                <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
                <XAxis {...axisProps} {...xAxisProps} />
                <YAxis {...axisProps} width={34} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: amber, strokeDasharray: '4 4' }} />
                <Area
                  type="stepAfter"
                  dataKey="jobs"
                  name="reviews"
                  stroke={amber}
                  strokeWidth={2}
                  fill="url(#amberFill)"
                  dot={false}
                  activeDot={{ r: 4, fill: amber, stroke: 'var(--card)', strokeWidth: 2 }}
                />
                <Area
                  type="stepAfter"
                  dataKey="comments"
                  name="comments"
                  stroke={dashColor}
                  strokeWidth={1.5}
                  strokeDasharray="5 4"
                  fill="transparent"
                  dot={false}
                  activeDot={{ r: 4, fill: dashColor, stroke: 'var(--card)', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </GraphShell>

        <GraphShell
          title="Token Volume"
          icon={<Coins size={14} strokeWidth={2} />}
          legend={
            <>
              <LegendChip color="#3b82f6" label="Output tokens" />
              <LegendChip hatched label="Input tokens" />
            </>
          }
        >
          <div className="h-64 px-2 pb-4 pt-3 sm:h-80 sm:px-3 sm:pb-5">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <BarChart data={stats.trend} margin={{ left: 4, right: 8, top: 8, bottom: 4 }} barCategoryGap="28%">
                <ChartDefs isDark={isDark} />
                <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
                <XAxis {...axisProps} {...xAxisProps} />
                <YAxis {...axisProps} width={46} tickFormatter={formatCompact} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: cursorColor }} />
                <Bar dataKey="outputTokens" name="output" stackId="tokens" fill="url(#blueBar)" radius={[2, 2, 2, 2]} />
                <Bar dataKey="inputTokens" name="input" stackId="tokens" fill="url(#hatchGray)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </GraphShell>
      </div>

      <div className="grid gap-4 sm:gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <GraphShell title="Job Health" icon={<ShieldCheck size={14} strokeWidth={2} />}>
          <div className="flex flex-1 items-center gap-5 px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
            {/* Donut with centred total */}
            <div className="relative h-36 w-36 shrink-0">
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                <PieChart>
                  <Pie
                    data={stats.statuses}
                    dataKey="count"
                    nameKey="status"
                    innerRadius="72%"
                    outerRadius="96%"
                    paddingAngle={3}
                    cornerRadius={4}
                    strokeWidth={0}
                    isAnimationActive
                  >
                    {stats.statuses.map((s) => (
                      <Cell key={s.status} fill={STATUS_COLOR[s.status] ?? quietColor} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="ui-font-mono text-xl font-medium leading-none text-ui-strong">
                  {formatCompact(statusTotal)}
                </span>
                <span className="mt-1 text-[10px] uppercase tracking-[0.14em] text-ui-subtle">Jobs</span>
              </div>
            </div>

            {/* Legend with counts + share */}
            <div className="min-w-0 flex-1 space-y-2.5">
              {stats.statuses.map((s) => (
                <div key={s.status} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                      style={{ backgroundColor: STATUS_COLOR[s.status] ?? quietColor }}
                    />
                    <span className="truncate text-[13px] font-medium capitalize text-ui-default">{s.status}</span>
                  </span>
                  <span className="ui-font-mono shrink-0 text-xs tabular-nums text-ui-subtle">
                    {s.count}
                    <span className="text-ui-subtle/70"> ({Math.round((s.count / statusTotal) * 100)}%)</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </GraphShell>

        <GraphShell title="Top Repositories" icon={<FolderGit2 size={14} strokeWidth={2} />}>
          <div className="space-y-3.5 px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
            {stats.topRepos.slice(0, 8).map((repo, i) => (
              <TickMeter
                key={`${repo.owner}/${repo.repo}`}
                label={repo.repo}
                value={repo.jobs}
                max={repoMax}
                color={tickColors[i % tickColors.length]}
                valueLabel={repo.jobs.toLocaleString()}
              />
            ))}
          </div>
        </GraphShell>

        <GraphShell title="Model Calls" icon={<Boxes size={14} strokeWidth={2} />}>
          <div className="space-y-3.5 px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
            {stats.models.slice(0, 8).map((model, i) => (
              <TickMeter
                key={model.modelUsed}
                label={modelName(model.modelUsed)}
                value={model.calls}
                max={modelMax}
                color={tickColors[i % tickColors.length]}
                valueLabel={model.calls.toLocaleString()}
              />
            ))}
          </div>
        </GraphShell>
      </div>
    </div>
  );
}

/* Skeletons reuse GraphShell so the card chrome — border, title, and icon —
   stays put; only the chart body (the part that actually loads) is skeletoned. */
function GraphCardSkeleton({ title, icon, className = '' }: { title: string; icon?: ReactNode; className?: string }) {
  return (
    <GraphShell title={title} icon={icon} className={className}>
      <div className="h-64 px-4 pb-4 pt-4 sm:h-80 sm:px-5 sm:pb-5">
        <Skeleton height="100%" width="100%" borderRadius={6} />
      </div>
    </GraphShell>
  );
}

function GraphBarCardSkeleton({ title, icon, className = '' }: { title: string; icon?: ReactNode; className?: string }) {
  return (
    <GraphShell title={title} icon={icon} className={className}>
      <div className="space-y-4 px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
        {Array.from({ length: 8 }).map((_, i) => (
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

function MetricsGridSkeleton() {
  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        <GraphCardSkeleton title="Review Flow" icon={<Activity size={14} strokeWidth={2} />} />
        <GraphCardSkeleton title="Token Volume" icon={<Coins size={14} strokeWidth={2} />} />
      </div>
      <div className="grid gap-4 sm:gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <GraphBarCardSkeleton title="Job Health" icon={<ShieldCheck size={14} strokeWidth={2} />} />
        <GraphBarCardSkeleton title="Top Repositories" icon={<FolderGit2 size={14} strokeWidth={2} />} />
        <GraphBarCardSkeleton title="Model Calls" icon={<Boxes size={14} strokeWidth={2} />} />
      </div>
    </div>
  );
}

export function StatsPage() {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(14);
  const isDark = useIsDarkMode();

  // Switching the range reloads every metric, so clear the current data to show
  // skeletons while the new range loads (same as the initial page load).
  const changeDays = (next: number) => {
    setStats(null);
    setDays(next);
  };

  const load = async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const res = await api.getStats(days);
      setStats(res.stats);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load stats.');
    } finally {
      setRefreshing(false);
    }
  };

  usePolling(load, 30_000, [days]);

  return (
    <section className="page-enter flex flex-col gap-6">
      <PageHeader
        title="Review metrics"
        description="Daily review and comment activity for the selected range."
        actions={
          <PageHeaderActions
            days={days}
            onDaysChange={changeDays}
            onRefresh={() => load(true)}
            refreshing={refreshing}
          />
        }
      />

      {error && (
        <LoadError
          title="Couldn't load stats"
          detail={error}
          onRetry={() => load(true)}
          retrying={refreshing}
        />
      )}

      {stats ? (
        <MetricsGrid stats={stats} isDark={isDark} />
      ) : (
        <MetricsGridSkeleton />
      )}
    </section>
  );
}
