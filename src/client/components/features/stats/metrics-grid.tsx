import React, { Suspense } from 'react';
import type { StatsPayload } from '@codra/schema';
import { MetricsGridSkeleton } from './chart-primitives';

// Recharts is only needed once stats have loaded, so it stays out of the initial bundle and the
// same skeleton covers both the fetch and the chunk download.
// Kept warm by `prefetchMetricsCharts` in ./metrics-grid-prefetch: the charts only render once
// `stats` arrives, so `lazy` on its own would not start the download until after the fetch resolved.
const MetricsGridCharts = React.lazy(() => import('./metrics-grid-charts').then(m => ({ default: m.MetricsGridCharts })));

export function MetricsGrid({
  stats,
  isDark,
}: {
  stats: StatsPayload;
  isDark: boolean;
}) {
  return (
    <Suspense fallback={<MetricsGridSkeleton />}>
      <MetricsGridCharts stats={stats} isDark={isDark} />
    </Suspense>
  );
}
