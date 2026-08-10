import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@client/lib/api';
import { Skeleton } from '@client/components/shared/skeleton';
import { EmptyState } from '@client/components/shared/empty-state';
import { Button, LinkButton } from '@client/components/ui/button';
import { LoadError } from '@client/components/shared/load-error';
import { PageHeader } from '@client/components/layout/page-header';
import { Input } from '@client/components/ui/input';
import { Select } from '@client/components/ui/select';
import { GitBranch, RefreshCw, ArrowUpRight, Search } from 'lucide-react';
import { cn } from '@client/lib/utils';
import type { RepoConfigRecord } from '@shared/schema';
import {
  EMPTY_MODEL_ROUTE,
  normalizeModelRoute,
  type ModelOption,
  type ModelRouteConfig,
  type ProviderOption,
} from '@client/components/features/models/model-chain';

import { RepoRow } from '@client/components/features/repos/repo-row';
import { RepoModelModal } from '@client/components/features/repos/repo-model-modal';


import { repoId, hasMeaningfulCustomStrategy } from '@client/components/features/repos/repo-route';
export function ReposPage() {
  const [repos, setRepos] = useState<RepoConfigRecord[]>([]);
  const [globalConfig, setGlobalConfig] = useState<ModelRouteConfig>(EMPTY_MODEL_ROUTE);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingRepoId, setEditingRepoId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [strategyFilter, setStrategyFilter] = useState('');
  const [pendingToggles, setPendingToggles] = useState<Set<string>>(() => new Set());

  const editingRepo = repos.find(repo => repoId(repo) === editingRepoId) ?? null;

  const filteredRepos = useMemo(() => {
    const q = search.trim().toLowerCase();
    return repos.filter(repo => {
      if (q && !`${repo.owner}/${repo.repo}`.toLowerCase().includes(q)) return false;
      if (statusFilter === 'enabled' && !repo.enabled) return false;
      if (statusFilter === 'paused' && repo.enabled) return false;
      if (strategyFilter) {
        const custom = hasMeaningfulCustomStrategy(repo, globalConfig);
        if (strategyFilter === 'custom' && !custom) return false;
        if (strategyFilter === 'global' && custom) return false;
      }
      return true;
    });
  }, [repos, search, statusFilter, strategyFilter, globalConfig]);
  const enabledCount = repos.filter(repo => repo.enabled).length;

  const loadRepos = () => {
    setLoading(true);
    Promise.all([
      api.getRepos(),
      api.getGlobalConfig(),
      api.getModelConfigs(),
    ])
      .then(([reposRes, globalRes, modelsRes]) => {
        const nextRepos = Array.isArray(reposRes?.repos) ? reposRes.repos : [];
        const providers = Array.isArray(modelsRes?.providers) ? modelsRes.providers : [];
        const configs = Array.isArray(modelsRes?.configs) ? modelsRes.configs : [];

        setRepos(nextRepos);
        setGlobalConfig(normalizeModelRoute(globalRes?.config));
        setProviderOptions(providers.map(provider => ({ value: provider.id, label: provider.name })));
        setModelOptions(configs.map(config => ({
          value: config.modelId,
          label: `${config.providerName} / ${config.modelName}`,
          providerId: config.providerId,
        })));
        setLoading(false);
      })
      .catch(e => {
        setError(e instanceof Error ? e.message : 'Failed to load repositories.');
        setLoading(false);
      });
  };

  useEffect(() => { loadRepos(); }, []);

  const mergeRepo = (targetId: string, updates: Partial<RepoConfigRecord>) => {
    setRepos(current =>
      current.map(repo =>
        repoId(repo) === targetId ? { ...repo, ...updates } : repo,
      ),
    );
  };

  const handleToggleEnabled = async (repo: RepoConfigRecord, nextEnabled: boolean) => {
    const targetId = repoId(repo);
    setPendingToggles(current => new Set(current).add(targetId));
    const tid = toast.loading(nextEnabled ? 'Enabling code reviews…' : 'Pausing code reviews…');
    try {
      await api.updateRepoConfig(repo.owner, repo.repo, { enabled: nextEnabled });
      mergeRepo(targetId, { enabled: nextEnabled });
      toast.success(
        nextEnabled ? 'Reviews active' : 'Reviews paused',
        { id: tid, description: nextEnabled
          ? `${targetId} will receive automated review comments.`
          : `${targetId} is now quiet - no new reviews will be posted.`
        },
      );
    } catch (err) {
      toast.error('Could not update repository', { id: tid, description: 'The change did not go through. Please try again.' });
    } finally {
      setPendingToggles(current => {
        const next = new Set(current);
        next.delete(targetId);
        return next;
      });
    }
  };

  const handleModelApplied = (repo: RepoConfigRecord, route: ModelRouteConfig) => {
    mergeRepo(repoId(repo), {
      mainModel: route.main,
      fallbackModels: route.fallbacks,
      sizeOverrides: route.size_overrides,
    });
  };

  const handleModelReset = (repo: RepoConfigRecord) => {
    mergeRepo(repoId(repo), {
      mainModel: null,
      fallbackModels: null,
      sizeOverrides: null,
    });
  };

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setError(null);
    const tid = toast.loading('Syncing with GitHub…');
    try {
      const result = await api.syncRepos();
      const syncedCount = result?.synced?.length ?? 0;
      toast.success('Repositories up to date', {
        id: tid,
        description: syncedCount > 0
          ? `${syncedCount} ${syncedCount === 1 ? 'repository' : 'repositories'} refreshed from GitHub.`
          : 'Everything is already in sync.',
      });
      loadRepos();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Sync failed.';
      setError(msg);
      toast.error('Sync failed', { id: tid, description: 'Could not reach GitHub. Check your connection and try again.' });
    } finally {
      setSyncing(false);
    }
  };

  if (loading && repos.length === 0) {
    return (
      <section className="page-enter flex flex-col gap-5">
        <PageHeader title="Repositories" />
        <div className="ui-panel overflow-hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="px-5 py-4 border-b border-ui-line/60 last:border-0">
              <Skeleton height={20} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="page-enter flex flex-col gap-5">
      <PageHeader
        title="Repositories"
        description={
          repos.length > 0 &&
          (filteredRepos.length === repos.length
            ? `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'} · ${enabledCount} enabled`
            : `${filteredRepos.length} of ${repos.length} repositories · ${enabledCount} enabled`)
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSync}
              disabled={syncing}
              icon={<RefreshCw size={13} className={cn(syncing && 'animate-spin')} />}
            >
              Sync Repositories
            </Button>
            <LinkButton
              variant="primary"
              size="sm"
              href="/api/repos/install"
              external
              icon={<ArrowUpRight size={13} />}
            >
              Add Repositories
            </LinkButton>
          </div>
        }
      />

      {error && (
        <LoadError
          title="Couldn't load repositories"
          detail={error}
          onRetry={() => loadRepos()}
          retrying={loading}
        />
      )}

      {repos.length === 0 ? (
        <EmptyState
          icon={<GitBranch />}
          title="No Repositories Added"
          description="Add your repositories to get started with Codra"
          hints={[
            'Add repositories here to automatically enable PR analysis',
            'You can enable/disable PR analysis for each repo from its settings',
          ]}
          linkAction={{
            label: 'See how to interact with Codra',
            href: 'https://github.com/devarshishimpi/codra#readme',
          }}
        />
      ) : (
        <div className="ui-panel min-w-0 overflow-hidden">
          <div className="flex flex-col gap-2 border-b border-ui-line px-4 py-3 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ui-subtle"
              />
              <Input
                type="text"
                size="sm"
                placeholder="owner/repo..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
                aria-label="Search repositories"
              />
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="w-full sm:w-40">
                <Select
                  value={statusFilter}
                  onValueChange={setStatusFilter}
                  placeholder="All statuses"
                  options={[
                    { value: '', label: 'All statuses' },
                    { value: 'enabled', label: 'Enabled' },
                    { value: 'paused', label: 'Paused' },
                  ]}
                  triggerClassName="h-8 text-xs"
                />
              </div>
              <div className="w-full sm:w-40">
                <Select
                  value={strategyFilter}
                  onValueChange={setStrategyFilter}
                  placeholder="All strategies"
                  options={[
                    { value: '', label: 'All strategies' },
                    { value: 'custom', label: 'Custom strategy' },
                    { value: 'global', label: 'Global strategy' },
                  ]}
                  triggerClassName="h-8 text-xs"
                />
              </div>
            </div>
          </div>

          <div className="divide-y divide-ui-line/60">
            {filteredRepos.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-ui-subtle">
                No repositories match your filters.
              </p>
            ) : (
              filteredRepos.map(repo => {
                const id = repoId(repo);
                return (
                  <RepoRow
                    key={id}
                    repo={repo}
                    globalConfig={globalConfig}
                    modelOptions={modelOptions}
                    togglePending={pendingToggles.has(id)}
                    onToggleEnabled={handleToggleEnabled}
                    onEdit={(nextRepo) => setEditingRepoId(repoId(nextRepo))}
                  />
                );
              })
            )}
          </div>
        </div>
      )}

      <RepoModelModal
        repo={editingRepo}
        globalConfig={globalConfig}
        modelOptions={modelOptions}
        providerOptions={providerOptions}
        open={editingRepo !== null}
        onOpenChange={(open) => {
          if (!open) setEditingRepoId(null);
        }}
        onModelApplied={handleModelApplied}
        onModelReset={handleModelReset}
      />
    </section>
  );
}
