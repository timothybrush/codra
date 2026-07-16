import { useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
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
import { Text } from '@client/components/ui/text';
import { Meter } from '@client/components/ui/meter';
import { Badge } from '@client/components/ui/badge';
import { PageHeaderActions } from '@client/components/shared/page-header-actions';
import { PageHeader } from '@client/components/layout/page-header';
import { Skeleton } from '@client/components/shared/skeleton';
import { LoadError } from '@client/components/shared/load-error';
import { useIsDarkMode } from '@client/hooks/use-is-dark-mode';
import { usePolling } from '@client/hooks/use-polling';
import { api } from '@client/lib/api';
import { cn, fmtNumber } from '@client/lib/utils';
import type { StatsPayload } from '@shared/schema';

const CHART = {
  primary: '#65a30d',
  primaryDark: '#e0fe56',
  comments: '#0ea5e9',
  commentsDark: '#38bdf8',
  warning: '#d97706',
  warningDark: '#fbbf24',
  danger: '#dc2626',
  dangerDark: '#f87171',
  quiet: '#94a3b8',
  quietDark: '#64748b',
};

// Badge variant per job status, echoing the reference's colored action pills.
type BadgeTone = 'success' | 'info' | 'neutral' | 'danger' | 'warning';
const STATUS_TONE: Record<string, BadgeTone> = {
  done: 'success',
  running: 'info',
  queued: 'neutral',
  failed: 'danger',
  superseded: 'neutral',
  cancelled: 'warning',
};

function formatDay(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
              style={{ backgroundColor: item.color }}
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

function GraphShell({
  title,
  icon,
  children,
  className = '',
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <LayerCard className={cn('flex flex-col', className)}>
      <div className="flex items-center gap-2 px-4 pt-4 sm:px-5 sm:pt-5">
        {icon && <span className="text-ui-subtle">{icon}</span>}
        <Text as="h3" variant="body" bold>
          {title}
        </Text>
      </div>
      <div className="flex flex-1 flex-col">{children}</div>
    </LayerCard>
  );
}

function MetricsGrid({
  stats,
  isDark,
}: {
  stats: StatsPayload;
  isDark: boolean;
}) {
  const color = isDark ? CHART.primaryDark : CHART.primary;
  const commentsColor = isDark ? CHART.commentsDark : CHART.comments;
  const inputColor = isDark ? CHART.commentsDark : CHART.comments;
  const outputColor = isDark ? CHART.warningDark : CHART.warning;
  const dangerColor = isDark ? CHART.dangerDark : CHART.danger;
  const quietColor = isDark ? CHART.quietDark : CHART.quiet;
  const repoMax = Math.max(...stats.topRepos.map((repo) => repo.jobs), 1);
  const modelMax = Math.max(...stats.models.map((model) => model.calls), 1);

  // Theme-aware chart chrome. CSS variables don't reliably resolve inside
  // Recharts SVG text, so use explicit colors keyed off the active theme.
  const axisColor = isDark ? 'rgba(228,228,231,0.62)' : 'rgba(63,63,70,0.78)';
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const cursorColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
  const axisProps = {
    fontSize: 11,
    tickLine: false,
    tickMargin: 8,
    axisLine: false,
    tick: { fontFamily: 'var(--font-sans)', fill: axisColor },
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
    done: color,
    running: commentsColor,
    queued: quietColor,
    failed: dangerColor,
    superseded: quietColor,
    cancelled: quietColor,
  };
  const statusTotal = Math.max(stats.statuses.reduce((sum, s) => sum + s.count, 0), 1);

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
          <GraphShell title="Review flow" icon={<Activity size={14} strokeWidth={2} />}>
            <div className="h-64 px-2 pb-4 pt-4 sm:h-80 sm:px-3 sm:pb-5">
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                <AreaChart data={stats.trend} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
                  <defs>
                    <linearGradient id="reviewFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                      <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="commentFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={commentsColor} stopOpacity={0.2} />
                      <stop offset="100%" stopColor={commentsColor} stopOpacity={0.01} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
                  <XAxis {...axisProps} {...xAxisProps} />
                  <YAxis {...axisProps} width={34} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ stroke: color, strokeDasharray: '4 4' }} />
                  <Area
                    type="monotone"
                    dataKey="jobs"
                    name="reviews"
                    stroke={color}
                    strokeWidth={2.5}
                    fill="url(#reviewFill)"
                    dot={false}
                    activeDot={{ r: 4, fill: color, stroke: 'var(--card)', strokeWidth: 2 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="comments"
                    name="comments"
                    stroke={commentsColor}
                    strokeWidth={2}
                    fill="url(#commentFill)"
                    dot={false}
                    activeDot={{ r: 4, fill: commentsColor, stroke: 'var(--card)', strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </GraphShell>

          <GraphShell title="Input vs output tokens" icon={<Coins size={14} strokeWidth={2} />}>
            <div className="h-64 px-2 pb-4 pt-4 sm:h-80 sm:px-3 sm:pb-5">
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                <BarChart data={stats.trend} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
                  <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
                  <XAxis {...axisProps} {...xAxisProps} />
                  <YAxis {...axisProps} width={46} tickFormatter={formatCompact} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: cursorColor }} />
                  <Bar dataKey="inputTokens" name="input" fill={inputColor} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="outputTokens" name="output" fill={outputColor} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </GraphShell>
        </div>

      <div className="grid gap-4 sm:gap-5 sm:grid-cols-2 xl:grid-cols-3">
          <GraphShell title="Job health" icon={<ShieldCheck size={14} strokeWidth={2} />}>
            <div className="flex flex-col space-y-5 px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
              <div className="flex h-3.5 overflow-hidden rounded-full bg-ui-fill">
                {stats.statuses.map((s) => (
                  <div
                    key={s.status}
                    style={{ width: `${(s.count / statusTotal) * 100}%`, backgroundColor: STATUS_COLOR[s.status] ?? CHART.quiet }}
                  />
                ))}
              </div>
              <div className="space-y-3">
                {stats.statuses.map((s) => (
                  <div key={s.status} className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: STATUS_COLOR[s.status] ?? CHART.quiet }} />
                      <Text variant="secondary" size="sm" className="capitalize">
                        {s.status}
                      </Text>
                    </div>
                    <Badge variant={STATUS_TONE[s.status] ?? 'neutral'}>
                      {s.count}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          </GraphShell>

          <GraphShell title="Top repositories" icon={<FolderGit2 size={14} strokeWidth={2} />}>
            <div className="space-y-4 px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
              {stats.topRepos.slice(0, 8).map((repo) => (
                <Meter
                  key={`${repo.owner}/${repo.repo}`}
                  label={`${repo.owner}/${repo.repo}`}
                  value={repo.jobs}
                  max={repoMax}
                  customValue={repo.jobs.toLocaleString()}
                />
              ))}
            </div>
          </GraphShell>

          <GraphShell title="Model calls" icon={<Boxes size={14} strokeWidth={2} />}>
            <div className="space-y-4 px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
              {stats.models.slice(0, 8).map((model) => (
                <Meter
                  key={model.modelUsed}
                  label={modelName(model.modelUsed)}
                  value={model.calls}
                  max={modelMax}
                  customValue={model.calls.toLocaleString()}
                  indicatorClassName="meter-indicator-info"
                />
              ))}
            </div>
          </GraphShell>
        </div>
      </div>
  );
}

function GraphCardSkeleton({ className = '' }: { className?: string }) {
  return (
    <LayerCard className={cn('flex flex-col', className)}>
      <div className="px-4 pt-4 sm:px-5 sm:pt-5">
        <Skeleton height={16} width={140} />
      </div>
      <div className="h-64 px-4 pb-4 pt-4 sm:h-80 sm:px-5 sm:pb-5">
        <Skeleton height="100%" width="100%" borderRadius={6} />
      </div>
    </LayerCard>
  );
}

function GraphBarCardSkeleton({ className = '' }: { className?: string }) {
  return (
    <LayerCard className={cn('flex flex-col', className)}>
      <div className="px-4 pt-4 sm:px-5 sm:pt-5">
        <Skeleton height={16} width={140} />
      </div>
      <div className="space-y-4 px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-4">
              <Skeleton height={10} width={`${45 + (i % 3) * 12}%`} />
              <Skeleton height={12} width={28} />
            </div>
            <Skeleton height={8} width="100%" borderRadius={999} />
          </div>
        ))}
      </div>
    </LayerCard>
  );
}

function MetricsGridSkeleton() {
  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        <GraphCardSkeleton />
        <GraphCardSkeleton />
      </div>
      <div className="grid gap-4 sm:gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <GraphBarCardSkeleton />
        <GraphBarCardSkeleton />
        <GraphBarCardSkeleton />
      </div>
    </div>
  );
}

export function StatsPage() {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const isDark = useIsDarkMode();

  const load = async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const res = await api.getStats(days);
      setStats(res.stats);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load stats.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  usePolling(load, 30_000, [days]);

  return (
    <section className="page-enter flex flex-col gap-6">
      <PageHeader
        category="Reports"
        title="Review metrics"
        description="Daily review and comment activity for the selected range."
        actions={
          <PageHeaderActions
            days={days}
            onDaysChange={setDays}
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
