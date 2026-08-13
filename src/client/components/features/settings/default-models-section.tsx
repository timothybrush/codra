import { useMemo } from 'react';
import type { ModelConfig } from '@codra/schema';
import { Skeleton } from '@client/components/shared/skeleton';
import { ModelRouteEditor } from '@client/components/features/models/model-chain';
import type {
  ModelOption,
  ModelRouteConfig,
  ProviderOption,
} from '@client/components/features/models/model-route';
import type { ProviderDraft } from './settings-support';

export function DefaultModelsSection({
  loading,
  providers,
  configs,
  globalConfig,
  setGlobalConfig,
}: {
  loading: boolean;
  providers: ProviderDraft[];
  configs: ModelConfig[];
  globalConfig: ModelRouteConfig | null;
  setGlobalConfig: (value: ModelRouteConfig) => void;
}) {
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

  return (
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
  );
}
