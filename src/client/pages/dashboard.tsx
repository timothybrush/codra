import { useState } from 'react';
import { api } from '@client/lib/api';
import type { StatsPayload } from '@shared/schema';
import type { JobSummary } from '@shared/schema';
import { ArrowRight, GitPullRequest } from 'lucide-react';
import { JobsTable } from '@client/components/shared/jobs-table';
import { EmptyState } from '@client/components/shared/empty-state';
import { PageHeaderActions } from '@client/components/shared/page-header-actions';
import { Link } from 'react-router-dom';

import { Button } from '@client/components/ui/button';
import { PageHeader } from '@client/components/layout/page-header';
import { OverviewStats } from '@client/components/features/stats/overview-stats';
import { usePolling } from '@client/hooks/use-polling';
import { LoadError } from '@client/components/shared/load-error';

export function DashboardPage() {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [recentJobs, setRecentJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [days, setDays] = useState(14);

  const load = async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const [statsRes, jobsRes] = await Promise.all([
        api.getStats(days),
        api.getJobs({ limit: 10 }),
      ]);
      setStats(statsRes.stats);
      setRecentJobs(jobsRes.jobs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to refresh dashboard.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  usePolling(load, 15_000, [days]);


  return (
    <section className="page-enter flex flex-col gap-6">

      <PageHeader
        title="Dashboard"
        description="Totals and recent review jobs for the selected time range."
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
          title="Couldn't load dashboard data"
          detail={error}
          onRetry={() => load(true)}
          retrying={refreshing}
        />
      )}

      <OverviewStats stats={stats} />

      {/* ── Activity Stream: header + table + footer in one panel ── */}
      <div className="ui-panel min-w-0 overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-ui-line px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <GitPullRequest size={15} strokeWidth={2} className="shrink-0 text-ui-default" />
            <h2 className="truncate text-[13px] font-medium text-ui-default">Recent reviews</h2>
          </div>
          <Link to="/jobs">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-ui-subtle hover:text-ui-default"
            >
              View all <ArrowRight size={13} />
            </Button>
          </Link>
        </div>

        <div className="min-w-0">
          {(loading || recentJobs.length > 0) && (
            <JobsTable jobs={recentJobs} loading={loading} />
          )}

          {!loading && recentJobs.length === 0 && (
            <EmptyState
              icon={<GitPullRequest />}
              title="No jobs yet"
              description="Your pull request analysis logs will appear here"
              hints={[
                'Once you open a PR in any of the connected repos, analysis triggers automatically',
                'To trigger manually, comment @codra on any PR',
              ]}
              linkAction={{
                label: 'See how to interact with Codra',
                href: 'https://github.com/devarshishimpi/codra#readme',
              }}
              className="rounded-none border-0"
            />
          )}

          {!loading && recentJobs.length > 0 && (
            <div className="ui-well border-t border-ui-line px-4 py-2.5">
              <p className="ui-font-mono text-[11px] text-ui-subtle">
                {recentJobs.length} review jobs · refreshes every 15s
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

