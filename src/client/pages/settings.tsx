import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, type ProviderPayload } from '@client/lib/api';
import { PageHeader } from '@client/components/layout/page-header';
import { Button } from '@client/components/ui/button';
import { Alert } from '@client/components/ui/alert';
import { Skeleton } from '@client/components/shared/skeleton';
import { LoadError } from '@client/components/shared/load-error';
import { Input } from '@client/components/ui/input';
import { Select } from '@client/components/ui/select';
import { RefreshCw, Plus, X } from 'lucide-react';
import type { LlmProvider, ModelConfig } from '@shared/schema';
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
import {
  FieldLabel,
  PROVIDER_PRESETS,
  apiKeyFieldLabel,
  providerDraftDirty,
  providerHasCredential,
  providerIsReady,
  providerKeyPlaceholder,
  providerToDraft,
  type NewProviderDraft,
  type ProviderDraft,
  type SyncError,
} from '@client/components/features/settings/settings-support';
import { AboutSection } from '@client/components/features/settings/about-section';
import { ProviderRow } from '@client/components/features/settings/provider-row';
import { ReviewSection } from '@client/components/features/settings/review-section';
import { useReviewSettings } from '@client/hooks/use-review-settings';

/** Named export kept here because `test/settings.spec.ts` imports it from this module. */
export const normalizeGlobalConfig = normalizeModelRoute;


export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderDraft[]>([]);
  const [savedProviders, setSavedProviders] = useState<LlmProvider[]>([]);
  const [configs, setConfigs] = useState<ModelConfig[]>([]);
  const [globalConfig, setGlobalConfig] = useState<ModelRouteConfig | null>(null);
  const [savedGlobalConfig, setSavedGlobalConfig] = useState<ModelRouteConfig | null>(null);

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

  // Review-settings half of the page. Hydrated below from the same combined load as the providers.
  const {
    reviewSettings,
    maxFilesDraft,
    setMaxFilesDraft,
    pendingConfirm,
    setPendingConfirm,
    hydrate: hydrateReviewSettings,
    handleConcurrencyChange,
    handleCommentsChange,
    commitMaxFiles,
    applyPendingConfirm,
  } = useReviewSettings({ setSaving, setError });
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
    // A save on one provider triggers a catalog refresh that can land here mid-edit on other rows; only overwrite rows without an unsaved draft.
    setProviders(current => modelsRes.providers.map(fresh => {
      const draft = current.find(item => item.id === fresh.id);
      const lastKnownSaved = savedProviders.find(item => item.id === fresh.id);
      if (draft && providerDraftDirty(draft, lastKnownSaved)) {
        return draft;
      }
      return providerToDraft(fresh);
    }));
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
      hydrateReviewSettings(reviewSettingsRes.settings);
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
    // Mount-only: both callbacks close over 15+ state setters and are recreated every render, so listing deps would re-fetch on every keystroke.
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
    // Build from the last saved state, not the draft, so clearing the key doesn't persist unrelated unsaved edits; a provider without a key can't stay enabled.
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

      <ReviewSection
        loading={loading}
        reviewSettings={reviewSettings}
        maxFilesDraft={maxFilesDraft}
        setMaxFilesDraft={setMaxFilesDraft}
        pendingConfirm={pendingConfirm}
        setPendingConfirm={setPendingConfirm}
        handleConcurrencyChange={handleConcurrencyChange}
        handleCommentsChange={handleCommentsChange}
        commitMaxFiles={commitMaxFiles}
        applyPendingConfirm={applyPendingConfirm}
      />


      <section className="ui-panel min-w-0 overflow-hidden">

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
            {providers.map(provider => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                savedProviders={savedProviders}
                providerModelCounts={providerModelCounts}
                expandedProviderId={expandedProviderId}
                setExpandedProviderId={setExpandedProviderId}
                updateProviderDraft={updateProviderDraft}
                saveProvider={saveProvider}
                removeProvider={removeProvider}
                clearProviderKey={clearProviderKey}
                saving={saving}
                toast={toast}
              />
            ))}
          </div>
      )}

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

      <AboutSection />
    </section>
  );
}
