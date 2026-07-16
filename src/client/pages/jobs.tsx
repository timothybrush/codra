import { useState, useCallback } from 'react';
import { api } from '@client/lib/api';
import { JobsTable } from '@client/components/shared/jobs-table';
import { EmptyState } from '@client/components/shared/empty-state';
import { Button } from '@client/components/ui/button';
import { Select } from '@client/components/ui/select';
import { Alert } from '@client/components/ui/alert';
import { PageHeader } from '@client/components/layout/page-header';
import { usePolling } from '@client/hooks/use-polling';
import { GitPullRequest, ChevronLeft, ChevronRight, RefreshCw, AlertTriangle, RotateCcw, Trash2, Info, Search } from 'lucide-react';
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

  return (
    <section className="page-enter flex flex-col gap-5">

      {/* ── Header ─────────────────────────────────── */}
      <PageHeader
        title="Jobs"
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

      {/* ── Search bar ─── */}
      <div className="surface p-4 flex flex-col sm:flex-row gap-4">
        {/* Search Input */}
        <div className="flex flex-col gap-1.5 flex-1">
          <label htmlFor="pr-search" className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
            Search
          </label>
          <input
            type="text"
            id="pr-search"
            placeholder="Title or #number..."
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
            className="h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* Status Dropdown */}
        <div className="w-full sm:w-48">
          <Select
            label="Status"
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
            triggerClassName="bg-transparent"
          />
        </div>

        {/* Verdict Dropdown */}
        <div className="w-full sm:w-48">
          <Select
            label="Verdict"
            value={filters.verdict}
            onValueChange={(v) => setFilters((f) => ({ ...f, verdict: v, page: 1 }))}
            placeholder="All verdicts"
            options={[
              { value: '', label: 'All verdicts' },
              { value: 'approve', label: 'Approve' },
              { value: 'comment', label: 'Comment' }
            ]}
            triggerClassName="bg-transparent"
          />
        </div>
      </div>


      {error && (
        <Alert variant="destructive">{error}</Alert>
      )}

      {/* ── Table ─────────────────────────────────── */}
      <div className="surface min-w-0 overflow-hidden">
        <JobsTable jobs={jobs} loading={loading} />

        {!loading && jobs.length === 0 && (
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

        {/* ── Pagination footer (Beetle-style) ─── */}
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          {/* Items per page */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Items per page:</span>
            <Select
              value={String(itemsPerPage)}
              onValueChange={(v) => {
                setItemsPerPage(Number(v));
                setFilters(f => ({ ...f, page: 1 }));
              }}
              options={[10, 20, 50, 100].map(n => ({ value: String(n), label: String(n) }))}
              variant="card"
              triggerClassName="h-8 w-20 px-2 py-1 text-xs"
            />
          </div>

          {/* Page navigation */}
          <div className="flex items-center gap-2">
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
            <span className="text-xs text-muted-foreground">
              Page {filters.page} of {Math.max(totalPages, 1)}
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
    </section>
  );
}
