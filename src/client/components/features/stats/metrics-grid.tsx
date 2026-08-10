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
import { Activity, Boxes, Coins, FolderGit2, ShieldCheck } from 'lucide-react';
import type { StatsPayload } from '@shared/schema';
import {
  CHART,
  ChartDefs,
  ChartTooltip,
  GraphShell,
  LegendChip,
  MONO_STACK,
  TICK_COLORS_DARK,
  TICK_COLORS_LIGHT,
  TickMeter,
  formatCompact,
  formatDay,
  modelName,
} from './chart-primitives';

export function MetricsGrid({
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

  // CSS variables don't reliably resolve inside Recharts SVG text, so colors are keyed off the active theme explicitly.
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
  // minTickGap thins labels by available space, not a fixed stride, since the trend array can have far fewer points than `days`.
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
