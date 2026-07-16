import { useEffect, useMemo, useState } from 'react';
import pkg from '../../../package.json';
import { toast } from 'sonner';
import { api, type ProviderPayload } from '@client/lib/api';
import { PageHeader } from '@client/components/layout/page-header';
import { Button } from '@client/components/ui/button';
import { Alert } from '@client/components/ui/alert';
import { Skeleton } from '@client/components/shared/skeleton';
import { Input } from '@client/components/ui/input';
import { Select } from '@client/components/ui/select';
import { Switch } from '@client/components/ui/switch';
import { SteppedSlider } from '@client/components/motion/stepped-slider';
import { ConfirmDialog } from '@client/components/ui/confirm-dialog';
import {
  Save,
  ShieldAlert,
  Layers,
  RefreshCw,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  X,
  ExternalLink,
} from 'lucide-react';
import { LayerCard } from '@client/components/ui/layer-card';
import { Text } from '@client/components/ui/text';
import { Badge } from '@client/components/ui/badge';
import type { LlmApiFormat, LlmProvider, ModelConfig, RepoConfig, ReviewSettings } from '@shared/schema';
import { REVIEW_CONCURRENCY_LIMITS, reviewMaxCommentsOptions, type ReviewConcurrencyLevel } from '@shared/schema';
import type { ModelConfigsResponse } from '@shared/api';
import {
  ModelRouteEditor,
  type ModelOption,
  type ModelRouteConfig,
  type ProviderOption,
} from '@client/components/features/models/model-chain';
import { cn } from '@client/lib/utils';

const EMPTY_GLOBAL_CONFIG: ModelRouteConfig = {
  main: null,
  fallbacks: [],
  size_overrides: [],
};

const API_FORMAT_OPTIONS: Array<{ value: LlmApiFormat; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Google' },
  { value: 'cloudflare-workers-ai', label: 'Cloudflare' },
];

const PROVIDER_PRESETS = [
  { value: 'custom-openai', label: 'Custom OpenAI-style API', apiFormat: 'openai' as const, baseUrl: '', name: 'Custom OpenAI', exampleUrl: 'https://api.example.com/v1' },
  { value: 'custom-anthropic', label: 'Custom Anthropic-style API', apiFormat: 'anthropic' as const, baseUrl: '', name: 'Custom Anthropic', exampleUrl: 'https://api.example.com/v1' },
  { value: 'custom-google', label: 'Custom Google-style API', apiFormat: 'gemini' as const, baseUrl: '', name: 'Custom Google', exampleUrl: 'https://generativelanguage.googleapis.com/v1beta' },
];

const FIXED_PROVIDER_NAMES = new Set(['OpenAI', 'OpenRouter', 'Anthropic', 'Google', 'Cloudflare']);

const CONCURRENCY_LEVEL_ORDER: ReviewConcurrencyLevel[] = ['low', 'medium', 'high', 'max'];
const CONCURRENCY_LEVEL_LABEL: Record<ReviewConcurrencyLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
};
const CONCURRENCY_STEPS = CONCURRENCY_LEVEL_ORDER.map(level => ({
  value: REVIEW_CONCURRENCY_LIMITS[level],
  label: CONCURRENCY_LEVEL_LABEL[level],
}));
const CONCURRENCY_VALUE_TO_LEVEL: Record<number, ReviewConcurrencyLevel> = Object.fromEntries(
  CONCURRENCY_LEVEL_ORDER.map(level => [REVIEW_CONCURRENCY_LIMITS[level], level]),
) as Record<number, ReviewConcurrencyLevel>;
const CONCURRENCY_MAX_VALUE = REVIEW_CONCURRENCY_LIMITS.max;
const MAX_COMMENTS_STEPS = reviewMaxCommentsOptions.map(n => ({ value: n, label: String(n) }));
const MAX_COMMENTS_CEILING = reviewMaxCommentsOptions[reviewMaxCommentsOptions.length - 1];

type ProviderDraft = LlmProvider & { apiKey: string };
type NewProviderDraft = {
  preset: string;
  name: string;
  apiFormat: LlmApiFormat;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
};
type SyncError = { providerId: string; providerName: string; error: string };

type GlobalConfigInput = RepoConfig['model'] | Partial<ModelRouteConfig> | null | undefined;

export function normalizeGlobalConfig(config: GlobalConfigInput): ModelRouteConfig {
  return {
    main: typeof config?.main === 'string' && config.main.trim() ? config.main : null,
    fallbacks: Array.isArray(config?.fallbacks) ? config.fallbacks : EMPTY_GLOBAL_CONFIG.fallbacks,
    size_overrides: Array.isArray(config?.size_overrides) ? config.size_overrides : EMPTY_GLOBAL_CONFIG.size_overrides,
  };
}

function stringArraysEqual(a: string[] = [], b: string[] = []) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function tiersEqual(a: ModelRouteConfig['size_overrides'] = [], b: ModelRouteConfig['size_overrides'] = []) {
  return a.length === b.length && a.every((tier, index) => {
    const other = b[index];
    return Boolean(
      other &&
      tier.max_lines === other.max_lines &&
      tier.model === other.model &&
      stringArraysEqual(tier.fallbacks ?? [], other.fallbacks ?? []),
    );
  });
}

function routeEqual(a: ModelRouteConfig | null, b: ModelRouteConfig | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.main === b.main &&
    stringArraysEqual(a.fallbacks ?? [], b.fallbacks ?? []) &&
    tiersEqual(a.size_overrides ?? [], b.size_overrides ?? [])
  );
}

function providerToDraft(provider: LlmProvider): ProviderDraft {
  return { ...provider, apiKey: '' };
}

function formatLabel(format: LlmApiFormat) {
  return API_FORMAT_OPTIONS.find(option => option.value === format)?.label ?? format;
}

function domId(prefix: string, value: string) {
  return `${prefix}-${value.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

function isCustomProvider(provider: Pick<LlmProvider, 'name' | 'apiFormat'>) {
  return provider.apiFormat !== 'cloudflare-workers-ai' && !FIXED_PROVIDER_NAMES.has(provider.name);
}

function providerIsReady(provider: Pick<LlmProvider, 'enabled' | 'hasApiKey' | 'apiFormat'>) {
  return provider.enabled && (provider.hasApiKey || provider.apiFormat === 'cloudflare-workers-ai');
}

function providerHasCredential(provider: Pick<ProviderDraft, 'hasApiKey' | 'apiFormat' | 'apiKey'>) {
  return provider.apiFormat === 'cloudflare-workers-ai' || provider.hasApiKey || provider.apiKey.trim().length > 0;
}

function providerStatusLabel(provider: Pick<LlmProvider, 'enabled' | 'hasApiKey' | 'apiFormat'>) {
  if (!provider.enabled) return 'Off';
  return providerIsReady(provider) ? 'Ready' : 'Needs key';
}

function providerDraftDirty(provider: ProviderDraft, saved?: LlmProvider) {
  if (!saved) return true;
  return (
    provider.name !== saved.name ||
    provider.apiFormat !== saved.apiFormat ||
    (provider.baseUrl ?? '') !== (saved.baseUrl ?? '') ||
    provider.enabled !== saved.enabled ||
    provider.apiKey.trim().length > 0
  );
}

/* ─── Section wrapper ─────────────────────────────────────────────────────── */
function SectionCard({
  icon,
  title,
  description,
  action,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="surface min-w-0 overflow-hidden">
      <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          {icon && (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15">
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            <p className="truncate text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/* ─── Field label ─────────────────────────────────────────────────────────── */
function FieldLabel({ htmlFor, id, children }: { htmlFor: string; id?: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} id={id} className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
      {children}
    </label>
  );
}

/* ─── Stat pill ───────────────────────────────────────────────────────────── */
function StatPill({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-border bg-muted/30 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
      {label}
    </span>
  );
}

export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderDraft[]>([]);
  const [savedProviders, setSavedProviders] = useState<LlmProvider[]>([]);
  const [configs, setConfigs] = useState<ModelConfig[]>([]);
  const [savedConfigs, setSavedConfigs] = useState<ModelConfig[]>([]);
  const [globalConfig, setGlobalConfig] = useState<ModelRouteConfig | null>(null);
  const [savedGlobalConfig, setSavedGlobalConfig] = useState<ModelRouteConfig | null>(null);
  const [reviewSettings, setReviewSettings] = useState<ReviewSettings | null>(null);
  const [savedReviewSettings, setSavedReviewSettings] = useState<ReviewSettings | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{ field: 'concurrency' | 'comments'; value: number } | null>(null);
  const [newProvider, setNewProvider] = useState<NewProviderDraft>({
    preset: 'custom-openai',
    name: 'Custom OpenAI',
    apiFormat: 'openai',
    baseUrl: '',
    apiKey: '',
    enabled: true,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncErrors, setSyncErrors] = useState<SyncError[]>([]);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [catalogRefreshedOnce, setCatalogRefreshedOnce] = useState(false);
  const [addingProvider, setAddingProvider] = useState(false);
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);

  const providerOptions: ProviderOption[] = useMemo(
    () => providers.map(provider => ({ value: provider.id, label: provider.name })),
    [providers],
  );

  const modelOptions: ModelOption[] = useMemo(
    () => configs.map(config => ({
      value: config.modelId,
      label: `${config.providerName} / ${config.modelName}`,
      providerId: config.providerId,
    })),
    [configs],
  );

  const existingProviderNames = useMemo(
    () => new Set(providers.map(provider => provider.name.toLowerCase())),
    [providers],
  );

  const selectedPreset = PROVIDER_PRESETS.find(preset => preset.value === newProvider.preset) ?? PROVIDER_PRESETS[0];
  const selectedProviderNameExists = existingProviderNames.has(newProvider.name.trim().toLowerCase());

  const providerModelCounts = useMemo(
    () => configs.reduce((counts, config) => {
      counts.set(config.providerId, (counts.get(config.providerId) ?? 0) + 1);
      return counts;
    }, new Map<string, number>()),
    [configs],
  );

  const globalDirty = useMemo(
    () => !routeEqual(globalConfig, savedGlobalConfig),
    [globalConfig, savedGlobalConfig],
  );

  const applyModelConfigResponse = (modelsRes: ModelConfigsResponse) => {
    setProviders(modelsRes.providers.map(providerToDraft));
    setSavedProviders(modelsRes.providers);
    setConfigs(modelsRes.configs);
    setSavedConfigs(modelsRes.configs);
    setSyncErrors(modelsRes.syncErrors ?? []);
  };

  const refreshModelCatalog = async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (catalogRefreshing) return;
    setCatalogRefreshing(true);
    setSyncErrors([]);
    const tid = quiet ? null : toast.loading('Syncing providers and models...');
    try {
      let savedProviderCount = 0;
      let failedProviderCount = 0;
      if (!quiet) {
        const dirtyProviders = providers.filter(
          provider => providerDraftDirty(provider, savedProviders.find(saved => saved.id === provider.id)),
        );
        if (dirtyProviders.length > 0) {
          const results = await Promise.all(dirtyProviders.map(provider => persistProvider(provider, { quiet: true })));
          savedProviderCount = results.filter(Boolean).length;
          failedProviderCount = results.length - savedProviderCount;
        }
      }

      const modelsRes = await api.refreshModelCatalog();
      applyModelConfigResponse(modelsRes);
      setCatalogRefreshedOnce(true);

      if (!quiet) {
        const failedCatalogs = modelsRes.syncErrors?.length ?? 0;
        const parts: string[] = [];
        if (savedProviderCount > 0) parts.push(`${savedProviderCount} provider${savedProviderCount === 1 ? '' : 's'} saved`);
        if (failedProviderCount > 0) parts.push(`${failedProviderCount} provider${failedProviderCount === 1 ? '' : 's'} failed to save`);
        if (failedCatalogs > 0) parts.push(`${failedCatalogs} provider${failedCatalogs === 1 ? '' : 's'} reported a catalog error`);

        const description = parts.length > 0 ? parts.join(' · ') : 'Providers and model lists are up to date.';
        if (failedProviderCount > 0 || failedCatalogs > 0) {
          toast.error('Sync finished with issues', { id: tid ?? undefined, description });
        } else {
          toast.success('Sync complete', { id: tid ?? undefined, description });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Catalog refresh failed';
      setSyncErrors([{ providerId: 'catalog-refresh', providerName: 'Model catalog', error: msg }]);
      if (!quiet) toast.error('Could not refresh catalog', { id: tid ?? undefined, description: msg });
    } finally {
      setCatalogRefreshing(false);
    }
  };

  const loadConfigs = async () => {
    try {
      const [modelsRes, globalRes, reviewSettingsRes] = await Promise.all([
        api.getModelConfigs(),
        api.getGlobalConfig(),
        api.getReviewSettings(),
      ]);
      const nextGlobalConfig = normalizeGlobalConfig(globalRes.config);
      applyModelConfigResponse(modelsRes);
      setGlobalConfig(nextGlobalConfig);
      setSavedGlobalConfig(nextGlobalConfig);
      setReviewSettings(reviewSettingsRes.settings);
      setSavedReviewSettings(reviewSettingsRes.settings);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load settings';
      setError(msg);
      toast.error('Could not load settings', { description: 'Something went wrong fetching your configuration.' });
      return false;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    loadConfigs().then((loaded) => {
      if (mounted && loaded) void refreshModelCatalog({ quiet: true });
    });
    return () => { mounted = false; };
  }, []);

  const persistGlobalConfig = async (next: ModelRouteConfig) => {
    setSaving('global');
    setError(null);
    const tid = toast.loading('Saving model strategy...');
    try {
      await api.updateGlobalConfig(next);
      setSavedGlobalConfig(next);
      toast.success('Global strategy saved', {
        id: tid,
        description: 'Repositories without a custom strategy will use these settings.',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Update failed';
      setError(msg);
      toast.error('Could not save strategy', { id: tid, description: 'Your changes were not applied.' });
    } finally {
      setSaving(null);
    }
  };

  useEffect(() => {
    if (!globalConfig || !globalDirty) return;
    const handle = setTimeout(() => void persistGlobalConfig(globalConfig), 600);
    return () => clearTimeout(handle);
  }, [globalConfig, globalDirty]);

  const persistReviewSettings = async (next: ReviewSettings, summary: string) => {
    setReviewSettings(next);
    setSaving('review-settings');
    setError(null);
    const tid = toast.loading('Saving…');
    try {
      await api.updateReviewSettings(next);
      setSavedReviewSettings(next);
      toast.success(summary, { id: tid });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Update failed';
      setReviewSettings(savedReviewSettings);
      setError(msg);
      toast.error('Could not save settings', { id: tid, description: msg });
    } finally {
      setSaving(null);
    }
  };

  const handleConcurrencyChange = (value: number) => {
    if (!reviewSettings) return;
    if (value === CONCURRENCY_MAX_VALUE && reviewSettings.concurrencyLevel !== 'max') {
      setPendingConfirm({ field: 'concurrency', value });
      return;
    }
    const level = CONCURRENCY_VALUE_TO_LEVEL[value];
    void persistReviewSettings(
      { ...reviewSettings, concurrencyLevel: level },
      `Concurrency set to ${CONCURRENCY_LEVEL_LABEL[level]}`,
    );
  };

  const handleCommentsChange = (value: number) => {
    if (!reviewSettings) return;
    if (value === MAX_COMMENTS_CEILING && reviewSettings.maxComments !== MAX_COMMENTS_CEILING) {
      setPendingConfirm({ field: 'comments', value });
      return;
    }
    void persistReviewSettings(
      { ...reviewSettings, maxComments: value as ReviewSettings['maxComments'] },
      `Comment limit set to ${value}`,
    );
  };

  const applyPendingConfirm = () => {
    if (!pendingConfirm || !reviewSettings) return;
    if (pendingConfirm.field === 'concurrency') {
      const level = CONCURRENCY_VALUE_TO_LEVEL[pendingConfirm.value];
      void persistReviewSettings(
        { ...reviewSettings, concurrencyLevel: level },
        `Concurrency set to ${CONCURRENCY_LEVEL_LABEL[level]}`,
      );
    } else {
      void persistReviewSettings(
        { ...reviewSettings, maxComments: pendingConfirm.value as ReviewSettings['maxComments'] },
        `Comment limit set to ${pendingConfirm.value}`,
      );
    }
  };

  const updateProviderDraft = (id: string, updates: Partial<ProviderDraft>) => {
    setProviders(current => current.map(provider => provider.id === id ? { ...provider, ...updates } : provider));
  };

  const persistProvider = async (
    provider: ProviderDraft,
    { quiet = false, clearApiKey = false }: { quiet?: boolean; clearApiKey?: boolean } = {},
  ) => {
    if (provider.enabled && !clearApiKey && !providerHasCredential(provider)) {
      if (!quiet) {
        setExpandedProviderId(provider.id);
        toast.error('Add an API key before enabling this provider.');
      }
      return null;
    }

    setSaving(`provider:${provider.id}`);
    setError(null);
    const tid = quiet ? null : toast.loading('Saving provider...');
    try {
      const payload: ProviderPayload = {
        name: provider.name,
        apiFormat: provider.apiFormat,
        baseUrl: provider.baseUrl || null,
        enabled: provider.enabled,
      };
      if (clearApiKey) {
        payload.clearApiKey = true;
      } else if (provider.apiKey.trim()) {
        payload.apiKey = provider.apiKey.trim();
      }
      const { provider: saved } = await api.updateProvider(provider.id, payload);
      setProviders(current => current.map(item => item.id === saved.id ? providerToDraft(saved) : item));
      setSavedProviders(current => current.map(item => item.id === saved.id ? saved : item));
      if (!quiet) toast.success('Provider saved', { id: tid ?? undefined });
      return saved;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Provider update failed';
      setError(msg);
      toast.error('Could not save provider', { id: tid ?? undefined, description: msg });
      return null;
    } finally {
      setSaving(null);
    }
  };

  const saveProvider = async (provider: ProviderDraft) => {
    const saved = await persistProvider(provider);
    if (saved && saved.enabled && (saved.hasApiKey || saved.apiFormat === 'cloudflare-workers-ai')) {
      void refreshModelCatalog({ quiet: true });
    }
  };

  const clearProviderKey = async (provider: ProviderDraft) => {
    // A provider can't stay enabled without a key, so drop it to disabled while
    // clearing (the server rejects an enabled provider with no credential).
    await persistProvider({ ...provider, apiKey: '', enabled: false }, { clearApiKey: true });
  };

  const createProvider = async () => {
    if (!newProvider.name.trim() || selectedProviderNameExists) return;
    setSaving('provider:new');
    setError(null);
    const tid = toast.loading('Creating provider...');
    try {
      const { provider } = await api.createProvider({
        name: newProvider.name.trim(),
        apiFormat: newProvider.apiFormat,
        baseUrl: newProvider.baseUrl.trim() || null,
        apiKey: newProvider.apiKey.trim() || undefined,
        enabled: newProvider.enabled,
      });
      setProviders(current => [...current, providerToDraft(provider)]);
      setSavedProviders(current => [...current, provider]);
      setNewProvider({
        preset: 'custom-openai',
        name: 'Custom OpenAI',
        apiFormat: 'openai',
        baseUrl: '',
        apiKey: '',
        enabled: true,
      });
      setAddingProvider(false);
      toast.success('Provider created', { id: tid });
      if (provider.enabled && (provider.hasApiKey || provider.apiFormat === 'cloudflare-workers-ai')) {
        void refreshModelCatalog({ quiet: true });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Provider creation failed';
      setError(msg);
      toast.error('Could not create provider', { id: tid, description: msg });
    } finally {
      setSaving(null);
    }
  };

  const removeProvider = async (id: string) => {
    setSaving(`provider:${id}`);
    setError(null);
    const tid = toast.loading('Deleting provider...');
    try {
      await api.deleteProvider(id);
      setProviders(current => current.filter(provider => provider.id !== id));
      setSavedProviders(current => current.filter(provider => provider.id !== id));
      toast.success('Provider deleted', { id: tid });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Provider delete failed';
      setError(msg);
      toast.error('Could not delete provider', { id: tid, description: msg });
    } finally {
      setSaving(null);
    }
  };

  const newProviderReady = newProvider.name.trim().length > 0 &&
    newProvider.baseUrl.trim().length > 0 &&
    newProvider.apiKey.trim().length > 0 &&
    !selectedProviderNameExists;

  const configuredProviderCount = providers.filter(providerIsReady).length;

  return (
    <section className="page-enter flex flex-col gap-5 pb-20">
      <PageHeader
        category="Defaults"
        title="Settings"
        description="Manage LLM providers, model routing, and usage limits."
      />

      {error && (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <span className="ml-2 text-sm font-medium">{error}</span>
        </Alert>
      )}

      {syncErrors.length > 0 && (
        <Alert variant="warning">
          <div className="space-y-0.5">
            <p className="font-semibold text-sm">Some provider catalogs could not refresh</p>
            <p className="text-xs opacity-75">
              {syncErrors.map(item => `${item.providerName}: ${item.error}`).join(' · ')}
            </p>
          </div>
        </Alert>
      )}

      {/* ── Review performance ──────────────────────────────────────────────── */}
      <SectionCard
        title="Review performance"
        description="Concurrency and comment limits for automated reviews, changes save automatically"
      >
        <div className="grid grid-cols-1 gap-6 p-5 sm:grid-cols-2">
          {!loading && reviewSettings ? (
            <>
              <div>
                <FieldLabel htmlFor="concurrency-slider" id="concurrency-slider-label">Concurrent jobs & files</FieldLabel>
                <SteppedSlider
                  id="concurrency-slider"
                  value={REVIEW_CONCURRENCY_LIMITS[reviewSettings.concurrencyLevel]}
                  onValueChange={handleConcurrencyChange}
                  min={1}
                  max={CONCURRENCY_MAX_VALUE}
                  step={1}
                  steps={CONCURRENCY_STEPS}
                  aria-labelledby="concurrency-slider-label"
                  formatValue={(v) => `${CONCURRENCY_LEVEL_LABEL[CONCURRENCY_VALUE_TO_LEVEL[v]]} · ${v} job${v === 1 ? '' : 's'} · ${v} file${v === 1 ? '' : 's'} at a time`}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  How many pull requests are reviewed at once, and how many files within each PR are reviewed at once.
                </p>
              </div>

              <div>
                <FieldLabel htmlFor="max-comments-slider" id="max-comments-slider-label">Comments per review</FieldLabel>
                <SteppedSlider
                  id="max-comments-slider"
                  value={reviewSettings.maxComments}
                  onValueChange={handleCommentsChange}
                  min={5}
                  max={MAX_COMMENTS_CEILING}
                  step={5}
                  steps={MAX_COMMENTS_STEPS}
                  aria-labelledby="max-comments-slider-label"
                  formatValue={(v) => `${v} comments`}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  A hard ceiling on the number of comments posted per review, applied on top of any repo-specific limit.
                </p>
              </div>
            </>
          ) : (
            <>
              <Skeleton height={44} />
              <Skeleton height={44} />
            </>
          )}
        </div>
      </SectionCard>

      <ConfirmDialog
        open={pendingConfirm !== null}
        onOpenChange={(open) => { if (!open) setPendingConfirm(null); }}
        title="This could exceed your rate limit"
        description={
          pendingConfirm?.field === 'concurrency'
            ? 'Running the maximum number of concurrent jobs and files can exceed your model provider\'s rate limits. Continue anyway?'
            : 'Posting the maximum number of comments per review can increase the chance of hitting your model provider\'s rate limits. Continue anyway?'
        }
        confirmLabel="Continue"
        cancelLabel="Cancel"
        onConfirm={applyPendingConfirm}
      />

      {/* ── LLM Providers ──────────────────────────────────────────────────── */}
      <section className="surface min-w-0 overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">LLM Providers</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {loading ? 'Loading…' : `${configuredProviderCount} of ${providers.length} configured`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => refreshModelCatalog()}
              disabled={loading || catalogRefreshing || saving !== null}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <RefreshCw size={13} className={cn(catalogRefreshing && 'animate-spin')} />
              {catalogRefreshing ? 'Syncing…' : 'Sync'}
            </button>
            <button
              type="button"
              onClick={() => setAddingProvider(v => !v)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors',
                addingProvider
                  ? 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'
                  : 'bg-primary text-primary-foreground hover:opacity-90',
              )}
            >
              {addingProvider ? <X size={13} /> : <Plus size={13} />}
              {addingProvider ? 'Cancel' : 'Add'}
            </button>
          </div>
        </div>

        {/* Add provider form */}
        {addingProvider && (
          <div className="animate-slide-down border-b border-border bg-muted/[0.04] px-4 py-5 sm:px-5 sm:py-6">
            <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              New provider
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <FieldLabel htmlFor="new-provider-type">Protocol</FieldLabel>
                <Select
                  value={newProvider.preset}
                  onValueChange={value => {
                    const preset = PROVIDER_PRESETS.find(item => item.value === value) ?? PROVIDER_PRESETS[0];
                    setNewProvider(current => ({
                      ...current,
                      preset: preset.value,
                      name: preset.name,
                      apiFormat: preset.apiFormat,
                      baseUrl: preset.baseUrl,
                    }));
                  }}
                  options={PROVIDER_PRESETS.map(preset => ({ value: preset.value, label: preset.label }))}
                />
              </div>
              <div>
                <FieldLabel htmlFor="new-provider-name">Display name</FieldLabel>
                <Input
                  id="new-provider-name"
                  placeholder="My provider"
                  value={newProvider.name}
                  onChange={e => setNewProvider(current => ({ ...current, name: e.target.value }))}
                />
                {selectedProviderNameExists && (
                  <p className="mt-1.5 text-xs text-warning">{newProvider.name.trim()} already exists</p>
                )}
              </div>
              <div>
                <FieldLabel htmlFor="new-provider-base-url">Base URL</FieldLabel>
                <Input
                  id="new-provider-base-url"
                  placeholder={selectedPreset.exampleUrl}
                  value={newProvider.baseUrl}
                  onChange={e => setNewProvider(current => ({ ...current, baseUrl: e.target.value }))}
                />
              </div>
              <div>
                <FieldLabel htmlFor="new-provider-api-key">API key</FieldLabel>
                <Input
                  id="new-provider-api-key"
                  type="password"
                  placeholder="sk-…"
                  value={newProvider.apiKey}
                  onChange={e => setNewProvider(current => ({ ...current, apiKey: e.target.value }))}
                />
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setAddingProvider(false)}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={createProvider}
                disabled={saving !== null || !newProviderReady}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
              >
                {saving === 'provider:new' ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />}
                Create
              </button>
            </div>
          </div>
        )}

        {/* Provider list */}
        {loading ? (
          <div className="divide-y divide-border/40">
            {[148, 148, 148].map((h, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-4 sm:px-5">
                <div className="flex-1 space-y-2">
                  <Skeleton height={13} width="40%" />
                  <Skeleton height={11} width="25%" />
                </div>
                <Skeleton height={20} width={36} />
              </div>
            ))}
          </div>
        ) : providers.length === 0 && !addingProvider ? (
          <div className="px-5 py-14 text-center">
            <p className="text-sm font-medium text-foreground">No providers yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Add one to start routing models.</p>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {providers.map(provider => {
              const nativeCloudflare = provider.apiFormat === 'cloudflare-workers-ai';
              const customProvider = isCustomProvider(provider);
              const savedProvider = savedProviders.find(saved => saved.id === provider.id);
              const dirty = providerDraftDirty(provider, savedProvider);
              const modelCount = providerModelCounts.get(provider.id) ?? 0;
              const configOpen = expandedProviderId === provider.id;
              const canEnableProvider = providerHasCredential(provider);
              const providerNameId = domId('provider-name', provider.id);
              const providerBaseUrlId = domId('provider-base-url', provider.id);
              const providerApiKeyId = domId('provider-api-key', provider.id);

              return (
                <article
                  key={provider.id}
                  className={cn(
                    'group min-w-0 transition-colors duration-150',
                    dirty && 'bg-primary/[0.018]',
                  )}
                >
                  {/* Row */}
                  <div className="flex min-w-0 items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5">

                    {/* Name + meta */}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">{provider.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <span className="font-mono">{provider.apiFormat}</span>
                        {modelCount > 0 && (
                          <span className="ml-2 opacity-70">· {modelCount} model{modelCount !== 1 ? 's' : ''}</span>
                        )}
                      </p>
                    </div>

                    {/* Credential — hidden on smallest screens */}
                    <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                      {nativeCloudflare
                        ? 'Worker binding'
                        : provider.hasApiKey
                          ? 'Key saved'
                          : <span className="text-warning">No key</span>
                      }
                    </span>

                    {/* Controls */}
                    <div className="flex shrink-0 items-center gap-1">
                      {/* Save — only visible when dirty */}
                      {dirty && (
                        <button
                          type="button"
                          onClick={() => saveProvider(provider)}
                          disabled={saving !== null}
                          className="animate-fade-in mr-1 inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {saving === `provider:${provider.id}` ? <RefreshCw size={10} className="animate-spin" /> : <Save size={10} />}
                          Save
                        </button>
                      )}

                      <Switch
                        checked={provider.enabled && canEnableProvider}
                        onCheckedChange={enabled => {
                          if (enabled && !canEnableProvider) {
                            setExpandedProviderId(provider.id);
                            toast.error('Add an API key before enabling this provider.');
                            return;
                          }
                          updateProviderDraft(provider.id, { enabled });
                        }}
                      />

                      <button
                        type="button"
                        onClick={() => setExpandedProviderId(configOpen ? null : provider.id)}
                        aria-label={configOpen ? 'Collapse' : 'Configure'}
                        className={cn(
                          'ml-0.5 inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                          configOpen
                            ? 'text-foreground'
                            : 'text-muted-foreground/60 hover:text-muted-foreground',
                        )}
                      >
                        {configOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </button>

                      {customProvider && (
                        <button
                          type="button"
                          aria-label="Delete provider"
                          onClick={() => removeProvider(provider.id)}
                          disabled={saving !== null}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/40 transition-colors hover:text-danger disabled:pointer-events-none group-hover:text-muted-foreground/70"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded edit panel */}
                  {configOpen && (
                    <div className="animate-slide-down border-t border-border/40 bg-muted/[0.04] px-4 py-5 sm:px-5">
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {customProvider && (
                          <>
                            <div>
                              <FieldLabel htmlFor={providerNameId}>Display name</FieldLabel>
                              <Input
                                id={providerNameId}
                                value={provider.name}
                                onChange={e => updateProviderDraft(provider.id, { name: e.target.value })}
                              />
                            </div>
                            <Select
                              label="Protocol"
                              value={provider.apiFormat}
                              onValueChange={value => updateProviderDraft(provider.id, { apiFormat: value as LlmApiFormat })}
                              options={API_FORMAT_OPTIONS.filter(option => option.value !== 'cloudflare-workers-ai')}
                            />
                            <div>
                              <FieldLabel htmlFor={providerBaseUrlId}>Base URL</FieldLabel>
                              <Input
                                id={providerBaseUrlId}
                                placeholder="https://llm.example.com/v1"
                                value={provider.baseUrl ?? ''}
                                onChange={e => updateProviderDraft(provider.id, { baseUrl: e.target.value || null })}
                              />
                            </div>
                          </>
                        )}
                        {nativeCloudflare ? (
                          <p className="col-span-full text-xs text-muted-foreground">
                            Uses the Worker AI binding defined in your Wrangler configuration.
                          </p>
                        ) : (
                          <div className="col-span-full">
                            <FieldLabel htmlFor={providerApiKeyId}>API key</FieldLabel>
                            <Input
                              id={providerApiKeyId}
                              type="password"
                              placeholder={provider.hasApiKey ? 'Enter a new key to replace the saved one' : 'sk-…'}
                              value={provider.apiKey}
                              onChange={e => updateProviderDraft(provider.id, { apiKey: e.target.value })}
                              className="max-w-sm"
                            />
                            {provider.hasApiKey && (
                              <button
                                type="button"
                                onClick={() => void clearProviderKey(provider)}
                                disabled={saving === `provider:${provider.id}`}
                                className="mt-2 text-xs font-medium text-destructive underline-offset-2 hover:underline disabled:opacity-50"
                              >
                                Remove saved key
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}

        {/* Global model strategy */}
        <div className="border-t border-border/60">
          <div className="px-4 py-4 sm:px-5">
            <h3 className="text-sm font-semibold text-foreground">Default models</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Used by repos that don't set their own model</p>
          </div>
          <div className="p-5 pt-0">
            {!loading && globalConfig ? (
              <ModelRouteEditor
                value={globalConfig}
                onChange={setGlobalConfig}
                models={modelOptions}
                providers={providerOptions}
                density="comfortable"
              />
            ) : (
              <div className="space-y-3">
                <Skeleton height={20} />
                <Skeleton height={20} width="70%" />
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        {!loading && (
          <div className="border-t border-border/30 px-4 py-2.5 sm:px-5">
            <p className="text-xs text-muted-foreground/60">
              {catalogRefreshing
                ? 'Syncing model lists…'
                : catalogRefreshedOnce
                  ? 'Synced this session'
                  : 'Loaded from database'}
            </p>
          </div>
        )}
      </section>

      {/* ── About ──────────────────────────────────────────────────────────── */}
      <SectionCard
        title="About"
        description="Version, license, and links for this Codra instance"
      >
        {/* LayerCards: Version/License in one, the links grid in its own. */}
        <div className="space-y-3 p-5">

          {/* Version + License */}
          <LayerCard className="divide-y divide-ui-line rounded-lg">
            <div className="flex items-center justify-between gap-4 px-4 py-3.5">
              <Text variant="body" size="sm" bold as="span">Version</Text>
              <Badge
                variant="outline"
                className="border-ui-brand/30 bg-ui-brand/10 font-mono text-ui-brand"
              >
                v{pkg.version}
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3.5">
              <Text variant="body" size="sm" bold as="span">License</Text>
              <Badge variant="outline">{pkg.license}</Badge>
            </div>
          </LayerCard>

          {/* Links — original 3-column grid, in its own card */}
          <LayerCard className="rounded-lg">
            <div className="grid grid-cols-1 divide-y divide-ui-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              {[
                { href: `${pkg.repository.url.replace(/\.git$/, '')}/releases/`, label: 'Releases', sub: 'Version history & notes' },
                { href: pkg.homepage, label: 'Homepage', sub: 'codra.run' },
                { href: pkg.bugs.url, label: 'Report an issue', sub: 'GitHub issue tracker' },
              ].map(({ href, label, sub }) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex flex-col gap-2.5 px-4 py-4 transition-colors hover:bg-primary/[0.04]"
                >
                  <span>
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground group-hover:text-primary">
                      {label}
                      <ExternalLink size={11} className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-hover:text-primary" />
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{sub}</span>
                  </span>
                </a>
              ))}
            </div>
          </LayerCard>

        </div>
      </SectionCard>
    </section>
  );
}
