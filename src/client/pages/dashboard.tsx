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

      {/* ── Activity Stream ── */}
      <div className="flex flex-col gap-0">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <h2 className="text-sm font-semibold text-foreground">Recent reviews</h2>
          </div>
          <Link to="/jobs">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              View all <ArrowRight size={13} />
            </Button>
          </Link>
        </div>

        <div className="surface min-w-0 overflow-hidden">
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
            <div className="px-5 py-2.5 bg-muted/20 border-t border-border/50">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/40 text-center">
                {recentJobs.length} review jobs · refreshes every 15s
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

