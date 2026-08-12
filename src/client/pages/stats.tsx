import { useEffect, useState } from 'react';
import { PageHeaderActions } from '@client/components/shared/page-header-actions';
import { PageHeader } from '@client/components/layout/page-header';
import { LoadError } from '@client/components/shared/load-error';
import { useIsDarkMode } from '@client/hooks/use-is-dark-mode';
import { usePolling } from '@client/hooks/use-polling';
import { useStatsRange } from '@client/hooks/use-stats-range';
import { api } from '@client/lib/api';
import type { StatsPayload } from '@shared/schema';


import { MetricsGridSkeleton } from '@client/components/features/stats/chart-primitives';
import { MetricsGrid } from '@client/components/features/stats/metrics-grid';
import { prefetchMetricsCharts } from '@client/components/features/stats/metrics-grid-prefetch';
// Skeletons reuse GraphShell so the card chrome (border, title, icon) stays put; only the chart body is skeletoned.


export function StatsPage() {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useStatsRange();
  const isDark = useIsDarkMode();

  // Downloads the lazy chart chunk in parallel with the first stats fetch rather than after it.
  useEffect(prefetchMetricsCharts, []);

  // Switching the range reloads every metric; clear current data first so skeletons show while it loads.
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
