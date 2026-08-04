import { useEffect, useMemo, useState } from 'react';
import pkg from '../../../package.json';
import { toast } from 'sonner';
import { api, type ProviderPayload } from '@client/lib/api';
import { PageHeader } from '@client/components/layout/page-header';
import { Button } from '@client/components/ui/button';
import { Alert } from '@client/components/ui/alert';
import { Skeleton } from '@client/components/shared/skeleton';
import { LoadError } from '@client/components/shared/load-error';
import { Input } from '@client/components/ui/input';
import { Select } from '@client/components/ui/select';
import { Switch } from '@client/components/ui/switch';
import { SteppedSlider } from '@client/components/motion/stepped-slider';
import { ConfirmDialog } from '@client/components/ui/confirm-dialog';
import {
  Save,
  RefreshCw,
  Plus,
  Trash2,
  ChevronRight,
  X,
  ExternalLink,
} from 'lucide-react';
import { LayerCard } from '@client/components/ui/layer-card';
import { Text } from '@client/components/ui/text';
import { Badge } from '@client/components/ui/badge';
import {
  REVIEW_CONCURRENCY_LIMITS,
  reviewMaxCommentsOptions,
  reviewMaxFilesRange,
  type LlmApiFormat,
  type LlmProvider,
  type ModelConfig,
  type ReviewConcurrencyLevel,
  type ReviewSettings,
} from '@shared/schema';
import type { ModelConfigsResponse } from '@shared/api';
import {
  ModelRouteEditor,
  normalizeModelRoute,
  routesEqual,
  type ModelOption,
  type ModelRouteConfig,
  type ProviderOption,
} from '@client/components/features/models/model-chain';
import { cn } from '@client/lib/utils';

const API_FORMAT_OPTIONS: Array<{ value: LlmApiFormat; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Google' },
  { value: 'vertex', label: 'Google Vertex AI' },
  { value: 'cloudflare-workers-ai', label: 'Cloudflare' },
];

const PROVIDER_PRESETS = [
  { value: 'custom-openai', label: 'Custom OpenAI-style API', apiFormat: 'openai' as const, baseUrl: '', name: 'Custom OpenAI', exampleUrl: 'https://api.example.com/v1' },
  { value: 'custom-anthropic', label: 'Custom Anthropic-style API', apiFormat: 'anthropic' as const, baseUrl: '', name: 'Custom Anthropic', exampleUrl: 'https://api.example.com/v1' },
  { value: 'custom-google', label: 'Custom Google-style API', apiFormat: 'gemini' as const, baseUrl: '', name: 'Custom Google', exampleUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { value: 'custom-vertex', label: 'Google Vertex AI', apiFormat: 'vertex' as const, baseUrl: '', name: 'Vertex AI', exampleUrl: 'https://us-central1-aiplatform.googleapis.com/v1/projects/YOUR_PROJECT_ID/locations/us-central1' },
];

const FIXED_PROVIDER_NAMES = new Set(['OpenAI', 'OpenRouter', 'Anthropic', 'Google', 'Cloudflare', 'xAI']);

function providerKeyPlaceholder(providerName: string, apiFormat: LlmApiFormat) {
  if (apiFormat === 'vertex') return '{ "type": "service_account", … }';
  if (providerName === 'xAI') return 'xai-…';
  return 'sk-…';
}

function apiKeyFieldLabel(apiFormat: LlmApiFormat) {
  return apiFormat === 'vertex' ? 'Service account JSON key' : 'API key';
}

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

/**
 * Kept as a named export from this module because `test/settings.spec.ts` imports it from here.
 * The implementation lives with the ModelRouteConfig type it operates on.
 */
export const normalizeGlobalConfig = normalizeModelRoute;

function providerToDraft(provider: LlmProvider): ProviderDraft {
  return { ...provider, apiKey: '' };
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
    <section className="ui-panel min-w-0 overflow-hidden">
      <div className="flex items-center justify-between gap-4 border-b border-ui-line px-5 py-4">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon && <span className="shrink-0 text-ui-subtle">{icon}</span>}
          <div className="min-w-0">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ui-default">{title}</h2>
            <p className="mt-0.5 truncate text-xs text-ui-subtle">{description}</p>
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
    <label htmlFor={htmlFor} id={id} className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-ui-subtle">
      {children}
    </label>
  );
}


export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderDraft[]>([]);
  const [savedProviders, setSavedProviders] = useState<LlmProvider[]>([]);
  const [configs, setConfigs] = useState<ModelConfig[]>([]);
  const [globalConfig, setGlobalConfig] = useState<ModelRouteConfig | null>(null);
  const [savedGlobalConfig, setSavedGlobalConfig] = useState<ModelRouteConfig | null>(null);
  const [reviewSettings, setReviewSettings] = useState<ReviewSettings | null>(null);
  const [savedReviewSettings, setSavedReviewSettings] = useState<ReviewSettings | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{ field: 'concurrency' | 'comments'; value: number } | null>(null);
  // Held as a string so the field can be mid-edit (empty, "2" on the way to "200") without the
  // saved value flickering underneath the cursor.
  const [maxFilesDraft, setMaxFilesDraft] = useState('');
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
    () => !routesEqual(globalConfig, savedGlobalConfig),
    [globalConfig, savedGlobalConfig],
  );

  const applyModelConfigResponse = (modelsRes: ModelConfigsResponse) => {
    setProviders(modelsRes.providers.map(providerToDraft));
    setSavedProviders(modelsRes.providers);
    setConfigs(modelsRes.configs);
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
      setMaxFilesDraft(String(reviewSettingsRes.settings.maxFiles));
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
    // Mount-only bootstrap. Both callbacks close over the page's 15+ state setters and are recreated
    // every render, so listing them would re-fetch the whole model catalog on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const commitMaxFiles = () => {
    if (!reviewSettings) return;
    const parsed = Number.parseInt(maxFilesDraft, 10);

    // Snap junk or out-of-range input back to something valid rather than rejecting it, so the
    // field can never be left showing a number that isn't what the server will use.
    const next = Number.isFinite(parsed)
      ? Math.min(reviewMaxFilesRange.max, Math.max(reviewMaxFilesRange.min, parsed))
      : reviewSettings.maxFiles;

    setMaxFilesDraft(String(next));
    if (next === reviewSettings.maxFiles) return;
    void persistReviewSettings({ ...reviewSettings, maxFiles: next }, `File limit set to ${next}`);
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
    { quiet = false, clearApiKey = false, successMessage }: { quiet?: boolean; clearApiKey?: boolean; successMessage?: string } = {},
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
      if (!quiet) toast.success(successMessage ?? 'Provider saved', { id: tid ?? undefined });
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
    // Build the payload from the last SAVED state, not the draft — "remove key"
    // must not silently persist unrelated unsaved edits (name/URL/protocol).
    // A provider can't stay enabled without a key, so drop it to disabled while
    // clearing (the server rejects an enabled provider with no credential).
    const saved = savedProviders.find(item => item.id === provider.id);
    const base = saved ? providerToDraft(saved) : provider;
    await persistProvider(
      { ...base, apiKey: '', enabled: false },
      { clearApiKey: true, successMessage: 'API key removed' },
    );
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
        title="Settings"
        description="Manage LLM providers, model routing, and usage limits."
      />

      {error && (
        <LoadError
          title="Something went wrong"
          hint="The last request didn't go through. Retry the action, or reload the page."
          detail={error}
        />
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
        description="Concurrency, comment and file limits for automated reviews, changes save automatically"
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

              <div>
                <FieldLabel htmlFor="max-files-input">Files per review</FieldLabel>
                <Input
                  id="max-files-input"
                  type="number"
                  inputMode="numeric"
                  min={reviewMaxFilesRange.min}
                  max={reviewMaxFilesRange.max}
                  step={1}
                  value={maxFilesDraft}
                  onChange={(event) => setMaxFilesDraft(event.target.value)}
                  // Committed on blur/Enter rather than on every keystroke: this is a free text
                  // field, and saving mid-typing would persist "2" on the way to "200".
                  onBlur={commitMaxFiles}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                    if (event.key === 'Escape') setMaxFilesDraft(String(reviewSettings.maxFiles));
                  }}
                  aria-describedby="max-files-help"
                />
                <p id="max-files-help" className="mt-2 text-xs text-muted-foreground">
                  How many changed files a single review covers, {reviewMaxFilesRange.min}–{reviewMaxFilesRange.max}.
                  Anything beyond this is left unreviewed and called out in the review summary.
                </p>
              </div>
            </>
          ) : (
            <>
              <Skeleton height={44} />
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
      <section className="ui-panel min-w-0 overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between gap-4 border-b border-ui-line px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ui-default">LLM Providers</h2>
            <p className="mt-0.5 text-xs text-ui-subtle">
              {loading ? 'Loading…' : `${configuredProviderCount} of ${providers.length} configured`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refreshModelCatalog()}
              disabled={loading || catalogRefreshing || saving !== null}
              icon={<RefreshCw size={13} className={cn(catalogRefreshing && 'animate-spin')} />}
              className="text-ui-subtle hover:text-ui-default"
            >
              {catalogRefreshing ? 'Syncing…' : 'Sync'}
            </Button>
            <Button
              variant={addingProvider ? 'ghost' : 'primary'}
              size="sm"
              onClick={() => setAddingProvider(v => !v)}
              icon={addingProvider ? <X size={13} /> : <Plus size={13} />}
            >
              {addingProvider ? 'Cancel' : 'Add'}
            </Button>
          </div>
        </div>

        {/* Add provider form */}
        {addingProvider && (
          <div className="animate-slide-down border-b border-ui-line bg-ui-fill/20 px-4 py-5 sm:px-5 sm:py-6">
            <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-ui-subtle">
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
                <FieldLabel htmlFor="new-provider-api-key">{apiKeyFieldLabel(newProvider.apiFormat)}</FieldLabel>
                <Input
                  id="new-provider-api-key"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={providerKeyPlaceholder(newProvider.name, newProvider.apiFormat)}
                  value={newProvider.apiKey}
                  onChange={e => setNewProvider(current => ({ ...current, apiKey: e.target.value }))}
                />
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAddingProvider(false)}
                className="text-ui-subtle hover:text-ui-default"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={createProvider}
                disabled={saving !== null || !newProviderReady}
                loading={saving === 'provider:new'}
                icon={<Plus size={13} />}
              >
                Create
              </Button>
            </div>
          </div>
        )}

        {/* Provider list */}
        {loading ? (
          <div className="divide-y divide-ui-line/60">
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
            <p className="text-sm font-medium text-ui-default">No providers yet</p>
            <p className="mt-1 text-xs text-ui-subtle">Add one to start routing models.</p>
          </div>
        ) : (
          <div className="divide-y divide-ui-line/60">
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
                  {/* Row — the whole left side toggles the config panel */}
                  <div className="flex min-w-0 items-center gap-3 px-3 py-3 sm:gap-4 sm:px-4">
                    <button
                      type="button"
                      onClick={() => setExpandedProviderId(configOpen ? null : provider.id)}
                      aria-expanded={configOpen}
                      aria-label={`${configOpen ? 'Collapse' : 'Configure'} ${provider.name}`}
                      className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-ui-fill/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-brand/40"
                    >
                      <ChevronRight
                        size={14}
                        className={cn(
                          'shrink-0 text-ui-subtle transition-transform duration-200',
                          configOpen && 'rotate-90 text-ui-default',
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-semibold text-ui-default">{provider.name}</span>
                          <Badge
                            variant={!provider.enabled ? 'neutral' : providerIsReady(provider) ? 'success' : 'warning'}
                            className="shrink-0"
                          >
                            {providerStatusLabel(provider)}
                          </Badge>
                        </span>
                        <span className="mt-0.5 block text-xs text-ui-subtle">
                          <span className="font-mono">{provider.apiFormat}</span>
                          {modelCount > 0 && (
                            <span className="ml-2 opacity-70">· {modelCount} model{modelCount !== 1 ? 's' : ''}</span>
                          )}
                          {nativeCloudflare && <span className="ml-2 opacity-70">· Worker binding</span>}
                        </span>
                      </span>
                    </button>

                    {/* Controls */}
                    <div className="flex shrink-0 items-center gap-1.5">
                      {/* Save — only visible when dirty */}
                      {dirty && (
                        <Button
                          variant="primary"
                          size="xs"
                          onClick={() => saveProvider(provider)}
                          disabled={saving !== null}
                          loading={saving === `provider:${provider.id}`}
                          icon={<Save size={11} />}
                          className="animate-fade-in h-7 px-2.5"
                        >
                          Save
                        </Button>
                      )}

                      <Switch
                        checked={provider.enabled && canEnableProvider}
                        aria-label={`${provider.enabled && canEnableProvider ? 'Disable' : 'Enable'} ${provider.name}`}
                        onCheckedChange={enabled => {
                          if (enabled && !canEnableProvider) {
                            setExpandedProviderId(provider.id);
                            toast.error('Add an API key before enabling this provider.');
                            return;
                          }
                          updateProviderDraft(provider.id, { enabled });
                        }}
                      />

                      {customProvider && (
                        <button
                          type="button"
                          aria-label="Delete provider"
                          onClick={() => removeProvider(provider.id)}
                          disabled={saving !== null}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ui-subtle/50 transition-colors hover:text-danger disabled:pointer-events-none group-hover:text-ui-subtle"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded edit panel */}
                  {configOpen && (
                    <div className="animate-slide-down border-t border-ui-line/60 bg-ui-fill/20 px-4 py-5 sm:px-5">
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
                                placeholder={provider.apiFormat === 'vertex' ? 'https://us-central1-aiplatform.googleapis.com/v1/projects/YOUR_PROJECT_ID/locations/us-central1' : 'https://llm.example.com/v1'}
                                value={provider.baseUrl ?? ''}
                                onChange={e => updateProviderDraft(provider.id, { baseUrl: e.target.value || null })}
                              />
                              {provider.apiFormat === 'vertex' && (
                                <p className="mt-1.5 text-xs text-ui-subtle">Must include your GCP project ID and region.</p>
                              )}
                            </div>
                          </>
                        )}
                        {nativeCloudflare ? (
                          <p className="col-span-full text-xs text-ui-subtle">
                            Uses the Worker AI binding defined in your Wrangler configuration.
                          </p>
                        ) : (
                          <div className="col-span-full">
                            <FieldLabel htmlFor={providerApiKeyId}>{apiKeyFieldLabel(provider.apiFormat)}</FieldLabel>
                            <div className="flex flex-wrap items-center gap-2">
                              <Input
                                id={providerApiKeyId}
                                type="password"
                                autoComplete="new-password"
                                spellCheck={false}
                                placeholder={provider.hasApiKey ? 'Enter a new key to replace the saved one' : providerKeyPlaceholder(provider.name, provider.apiFormat)}
                                value={provider.apiKey}
                                onChange={e => {
                                  const apiKey = e.target.value;
                                  // Losing the only credential must also drop `enabled`,
                                  // otherwise the switch (which renders enabled && has
                                  // credential) desyncs from the draft and Save would be
                                  // rejected by the server.
                                  const losesCredential = !apiKey.trim() && !provider.hasApiKey;
                                  updateProviderDraft(provider.id, {
                                    apiKey,
                                    ...(losesCredential ? { enabled: false } : {}),
                                  });
                                }}
                                className="min-w-0 max-w-sm flex-1 basis-64"
                              />
                              {provider.hasApiKey && (
                                <Button
                                  variant="destructive-outline"
                                  size="xs"
                                  onClick={() => void clearProviderKey(provider)}
                                  disabled={saving !== null}
                                  loading={saving === `provider:${provider.id}`}
                                  icon={<Trash2 size={12} />}
                                  className="h-8 px-2.5"
                                >
                                  Remove key
                                </Button>
                              )}
                            </div>
                            {provider.hasApiKey && (
                              <p className="mt-1.5 text-xs text-ui-subtle">
                                Removing the saved key also turns the provider off.
                              </p>
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
        <div className="border-t border-ui-line">
          <div className="px-4 py-4 sm:px-5">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ui-default">Default models</h3>
            <p className="mt-0.5 text-xs text-ui-subtle">Used by repos that don't set their own model</p>
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
          <div className="border-t border-ui-line/50 px-4 py-2.5 sm:px-5">
            <p className="text-xs text-ui-subtle/70">
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
                  className="group flex flex-col gap-2.5 px-4 py-4 transition-colors hover:bg-ui-fill/40"
                >
                  <span>
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-ui-default group-hover:text-ui-brand">
                      {label}
                      <ExternalLink size={11} className="text-ui-subtle opacity-0 transition-opacity group-hover:opacity-100 group-hover:text-ui-brand" />
                    </span>
                    <span className="mt-0.5 block text-xs text-ui-subtle">{sub}</span>
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
