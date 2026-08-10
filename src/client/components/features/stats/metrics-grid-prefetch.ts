// The chart chunk is only *rendered* once stats have loaded, so React.lazy alone would delay its
// download until after the fetch resolved -- a waterfall the eager import it replaced never had.
// Calling this on mount puts the ~68 kB gzip request alongside the stats fetch instead of behind it.
// Separate from metrics-grid.tsx so that file keeps exporting components only (Fast Refresh).
export function prefetchMetricsCharts() {
  void import('./metrics-grid-charts');
}
