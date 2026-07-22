import { useState, useCallback } from 'react';
import { api } from '@client/lib/api';
import { JobsTable } from '@client/components/shared/jobs-table';
import { EmptyState } from '@client/components/shared/empty-state';
import { Button } from '@client/components/ui/button';
import { Input } from '@client/components/ui/input';
import { Select } from '@client/components/ui/select';
import { LoadError } from '@client/components/shared/load-error';
import { PageHeader } from '@client/components/layout/page-header';
import { usePolling } from '@client/hooks/use-polling';
import { Activity, ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react';
import type { JobSummary } from '@shared/schema';

export function JobsPage() {
  const [jobs, setJobs]   = useState<JobSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [filters, setFilters] = useState({
    status: '', verdict: '', search: '', page: 1,
  });

  const [itemsPerPage, setItemsPerPage] = useState(10);

  const load = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const jobsRes = await api.getJobs({
        status:  filters.status  || undefined,
        verdict: filters.verdict || undefined,
        search:  filters.search  || undefined,
        limit:   itemsPerPage,
        offset:  (filters.page - 1) * itemsPerPage,
      });

      setJobs(jobsRes.jobs);
      setTotal(jobsRes.total);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load jobs.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filters, itemsPerPage]);

  usePolling(load, 15_000, [filters, itemsPerPage]);

  const totalPages = Math.ceil(total / itemsPerPage);
  const rangeStart = total === 0 ? 0 : (filters.page - 1) * itemsPerPage + 1;
  const rangeEnd = Math.min(filters.page * itemsPerPage, total);

  return (
    <section className="page-enter flex min-h-0 flex-1 flex-col gap-5">

      {/* ── Header ─────────────────────────────────── */}
      <PageHeader
        title="Jobs"
        description="Every review job across all pull requests."
        actions={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => load(true)}
              disabled={refreshing}
              icon={<RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />}
            >
              Refresh
            </Button>
          </div>
        }
      />

      {error && (
        <LoadError
          title="Couldn't load jobs"
          detail={error}
          onRetry={() => load(true)}
          retrying={refreshing}
        />
      )}

      {/* ── Table card: toolbar + table + pagination in one panel. Fills the
          available height so the table body scrolls internally and the page /
          content card never needs a scrollbar. ─── */}
      <div className="ui-panel flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Filter toolbar */}
        <div className="flex shrink-0 flex-col gap-2 border-b border-ui-line px-4 py-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ui-subtle"
            />
            <Input
              type="text"
              id="job-search"
              size="sm"
              placeholder="Title or #number..."
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
              className="pl-8"
              aria-label="Search jobs by title or number"
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="w-full sm:w-40">
              <Select
                value={filters.status}
                onValueChange={(v) => setFilters((f) => ({ ...f, status: v, page: 1 }))}
                placeholder="All statuses"
                options={[
                  { value: '', label: 'All statuses' },
                  { value: 'queued', label: 'Queued' },
                  { value: 'running', label: 'Running' },
                  { value: 'done', label: 'Done' },
                  { value: 'failed', label: 'Failed' },
                  { value: 'superseded', label: 'Superseded' },
                  { value: 'cancelled', label: 'Cancelled' }
                ]}
                triggerClassName="h-8 text-xs"
              />
            </div>
            <div className="w-full sm:w-40">
              <Select
                value={filters.verdict}
                onValueChange={(v) => setFilters((f) => ({ ...f, verdict: v, page: 1 }))}
                placeholder="All verdicts"
                options={[
                  { value: '', label: 'All verdicts' },
                  { value: 'approve', label: 'Approve' },
                  { value: 'comment', label: 'Comment' }
                ]}
                triggerClassName="h-8 text-xs"
              />
            </div>
          </div>
        </div>

        <JobsTable jobs={jobs} loading={loading} fill columns={['repo', 'pr', 'status', 'verdict', 'created', 'action']} />

        {!loading && jobs.length === 0 && (
          <EmptyState
            icon={<Activity />}
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

        {/* ── Pagination footer ─── */}
        {total > 0 && (
          <div className="flex shrink-0 flex-col gap-2.5 border-t border-ui-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-ui-subtle">
              Showing <span className="text-ui-default">{rangeStart}–{rangeEnd}</span> of{' '}
              <span className="text-ui-default">{total.toLocaleString()}</span> jobs
            </p>

            <div className="flex items-center justify-between gap-4 sm:justify-end">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-ui-subtle">Rows per page</span>
                <Select
                  value={String(itemsPerPage)}
                  onValueChange={(v) => {
                    setItemsPerPage(Number(v));
                    setFilters(f => ({ ...f, page: 1 }));
                  }}
                  options={[10, 20, 50, 100].map(n => ({ value: String(n), label: String(n) }))}
                  variant="card"
                  triggerClassName="h-7 w-[4.5rem] px-2 py-1 text-xs"
                />
              </div>

              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={filters.page === 1}
                  onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
                  className="h-7 w-7 p-0"
                  aria-label="Previous page"
                >
                  <ChevronLeft size={14} />
                </Button>
                <span className="min-w-[3.5rem] text-center text-xs tabular-nums text-ui-subtle">
                  {filters.page} / {Math.max(totalPages, 1)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={filters.page >= totalPages}
                  onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
                  className="h-7 w-7 p-0"
                  aria-label="Next page"
                >
                  <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
