import { useState, useMemo, useEffect } from 'react';
import { cn } from '@client/lib/utils';
import { Select } from '@client/components/ui/select';
import { Button } from '@client/components/ui/button';
import { Trash2, ListPlus } from 'lucide-react';

export type ProviderOption = {
  value: string;
  label: string;
};

export type ModelOption = {
  value: string;
  label: string;
  providerId: string;
};

export type ModelDensity = 'compact' | 'comfortable';

export type ModelRouteTier = {
  max_lines: number;
  model: string;
  fallbacks?: string[];
};

export type ModelRouteConfig = {
  main: string | null;
  fallbacks: string[];
  size_overrides: ModelRouteTier[];
};

export const EMPTY_MODEL_ROUTE: ModelRouteConfig = {
  main: null,
  fallbacks: [],
  size_overrides: [],
};

/**
 * Route normalization and comparison, owned here because this module owns `ModelRouteConfig`.
 *
 * `repos.tsx` and `settings.tsx` each carried their own copies and they had drifted in opposite
 * directions — the repo page guarded `tier` in the tier comparison and the settings page did not,
 * while the settings page handled null routes and the repo page did not. These keep the safer half
 * of each.
 */
/**
 * Deliberately wider than `Partial<ModelRouteConfig>`: the stored `RepoConfig['model']` types every
 * field as nullable, and the API returns it raw. The `Array.isArray` guards below are what make
 * those nulls safe, so the input type has to admit them rather than force a cast at each call site.
 */
type ModelRouteInput =
  | { [K in keyof ModelRouteConfig]?: ModelRouteConfig[K] | null }
  | null
  | undefined;

export function normalizeModelRoute(config: ModelRouteInput): ModelRouteConfig {
  return {
    main: typeof config?.main === 'string' && config.main.trim() ? config.main : null,
    fallbacks: Array.isArray(config?.fallbacks) ? config.fallbacks : EMPTY_MODEL_ROUTE.fallbacks,
    size_overrides: Array.isArray(config?.size_overrides)
      ? config.size_overrides
      : EMPTY_MODEL_ROUTE.size_overrides,
  };
}

export function stringArraysEqual(a: string[] = [], b: string[] = []) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function tiersEqual(
  a: ModelRouteConfig['size_overrides'] = [],
  b: ModelRouteConfig['size_overrides'] = [],
) {
  return a.length === b.length && a.every((tier, index) => {
    const other = b[index];
    return Boolean(
      tier && other &&
      tier.max_lines === other.max_lines &&
      tier.model === other.model &&
      stringArraysEqual(tier.fallbacks ?? [], other.fallbacks ?? []),
    );
  });
}

export function routesEqual(a: ModelRouteConfig | null, b: ModelRouteConfig | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.main === b.main &&
    stringArraysEqual(a.fallbacks ?? [], b.fallbacks ?? []) &&
    tiersEqual(a.size_overrides ?? [], b.size_overrides ?? [])
  );
}

export function getModelLabel(model: string, models: ModelOption[] = []) {
  return models.find(m => m.value === model)?.label ?? model;
}

export function describeModelRoute(config: ModelRouteConfig, models: ModelOption[] = []) {
  if (!config.main && (config.fallbacks?.length ?? 0) === 0 && (config.size_overrides?.length ?? 0) === 0) {
    return 'No model strategy configured';
  }

  const fallbacks = config.fallbacks?.length ?? 0;
  const tiers = config.size_overrides?.length ?? 0;
  return [
    config.main ? getModelLabel(config.main, models) : 'No baseline model',
    fallbacks > 0 ? `${fallbacks} fallback${fallbacks === 1 ? '' : 's'}` : 'no fallbacks',
    tiers > 0 ? `${tiers} tier${tiers === 1 ? '' : 's'}` : 'baseline only',
  ].join(' · ');
}

interface ModelSelectorProps {
  value: string | null;
  onValueChange: (value: string) => void;
  models: ModelOption[];
  providers: ProviderOption[];
  hideLabels?: boolean;
  density?: ModelDensity;
  className?: string;
}

export function ModelSelector({
  value,
  onValueChange,
  models,
  providers,
  hideLabels,
  density = 'comfortable',
  className,
}: ModelSelectorProps) {
  const currentModel = models.find(m => m.value === value);
  const [provider, setProvider] = useState(currentModel?.providerId ?? providers[0]?.value ?? '');

  useEffect(() => {
    const model = models.find(m => m.value === value);
    if (model && model.providerId !== provider) {
      setProvider(model.providerId);
    }
  }, [models, provider, value]);

  const filteredModels = useMemo(
    () => models.filter(m => m.providerId === provider).map(m => ({ value: m.value, label: m.label })),
    [models, provider],
  );

  if (models.length === 0 || providers.length === 0) {
    return (
      <div className={cn('rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground', className)}>
        No configured models
      </div>
    );
  }

  return (
    <div
      className={cn(
        'grid min-w-0 grid-cols-1 gap-2',
        density === 'compact'
          ? 'sm:grid-cols-[112px_minmax(0,1fr)]'
          : 'sm:grid-cols-[minmax(120px,160px)_minmax(0,1fr)] sm:items-end',
        className,
      )}
    >
      <Select
        label={hideLabels ? undefined : 'Provider'}
        value={provider}
        onValueChange={(nextProvider) => {
          setProvider(nextProvider);
          const first = models.find(m => m.providerId === nextProvider);
          if (first) onValueChange(first.value);
        }}
        options={providers}
        triggerClassName={cn(density === 'compact' && 'h-8 text-xs')}
      />
      <Select
        label={hideLabels ? undefined : 'Model'}
        value={value ?? ''}
        onValueChange={onValueChange}
        options={filteredModels}
        placeholder="Select model..."
        triggerClassName={cn(density === 'compact' && 'h-8 text-xs')}
      />
    </div>
  );
}

interface ModelChainProps {
  primary: string | null;
  fallbacks: string[];
  onChange: (primary: string | null, fallbacks: string[]) => void;
  models: ModelOption[];
  providers: ProviderOption[];
  density?: ModelDensity;
}

export function ModelChain({
  primary,
  fallbacks,
  onChange,
  models,
  providers,
  density = 'comfortable',
}: ModelChainProps) {
  const addFallback = () => {
    const first = models[0]?.value;
    if (first) onChange(primary, [...fallbacks, first]);
  };
  const removeFallback = (idx: number) => onChange(primary, fallbacks.filter((_, i) => i !== idx));
  const updateFallback = (idx: number, val: string) => {
    const next = [...fallbacks];
    next[idx] = val;
    onChange(primary, next);
  };

  return (
    <div className={cn('min-w-0', density === 'compact' ? 'space-y-2' : 'space-y-4')}>
      <div className={cn(
        'relative min-w-0 border-l border-border/60',
        density === 'compact' ? 'space-y-2 pl-3' : 'space-y-3 pl-4',
      )}>
        <div className="relative min-w-0">
          <div className={cn(
            'absolute top-4 h-0.5 bg-primary/20',
            density === 'compact' ? '-left-[0.85rem] w-2' : '-left-[1.35rem] w-3',
          )} />
          <ModelSelector
            value={primary}
            models={models}
            providers={providers}
            density={density}
            hideLabels={density === 'compact'}
            onValueChange={(val) => onChange(val, fallbacks)}
          />
        </div>

        {fallbacks.map((fb, i) => (
          <div key={`${fb}-${i}`} className="relative flex min-w-0 items-end gap-2 animate-in slide-in-from-left-2 fade-in">
            <div className={cn(
              'absolute top-4 h-0.5 bg-warning/25',
              density === 'compact' ? '-left-[0.85rem] w-2' : '-left-[1.35rem] w-3',
            )} />
            <div className="min-w-0 flex-1">
              <ModelSelector
                value={fb}
                models={models}
                providers={providers}
                hideLabels
                density={density}
                onValueChange={(val) => updateFallback(i, val)}
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              type="button"
              aria-label="Remove fallback model"
              className={cn(
                'shrink-0 text-muted-foreground/45 hover:bg-danger/5 hover:text-danger',
                density === 'compact' ? 'h-8 w-8' : 'h-9 w-9',
              )}
              onClick={(e) => { e.stopPropagation(); removeFallback(i); }}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        ))}

        <button
          type="button"
          className={cn(
            'ml-1 flex items-center gap-1.5 py-1 font-bold text-primary/70 transition-colors hover:text-primary',
            density === 'compact' ? 'text-[10px]' : 'text-xs',
          )}
          onClick={addFallback}
        >
          <ListPlus size={12} /> Add fallback
        </button>
      </div>
    </div>
  );
}

interface ModelRouteEditorProps {
  value: ModelRouteConfig;
  onChange: (value: ModelRouteConfig) => void;
  models: ModelOption[];
  providers: ProviderOption[];
  density?: ModelDensity;
  className?: string;
}

export function ModelRouteEditor({
  value,
  onChange,
  models,
  providers,
  density = 'comfortable',
  className,
}: ModelRouteEditorProps) {
  const tiers = value.size_overrides ?? [];

  const updateTier = (index: number, updates: Partial<ModelRouteTier>) => {
    const next = [...tiers];
    next[index] = { ...next[index], ...updates };
    onChange({ ...value, size_overrides: next });
  };

  const addTier = () => {
    const first = models[0]?.value;
    if (!first) return;
    onChange({
      ...value,
      size_overrides: [
        ...tiers,
        { max_lines: 300, model: first, fallbacks: [] },
      ],
    });
  };

  const removeTier = (index: number) => {
    onChange({
      ...value,
      size_overrides: tiers.filter((_, i) => i !== index),
    });
  };

  const largestTier = tiers.length > 0
    ? Math.max(...tiers.map(tier => Number(tier.max_lines) || 0))
    : null;

  return (
    <div className={cn('min-w-0 space-y-5', className)}>

      {/* Toolbar row */}
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          Baseline route plus file-size tiers for smaller changes.
        </p>
        <button
          type="button"
          onClick={addTier}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <ListPlus size={13} />
          Add tier
        </button>
      </div>

      {/* Baseline route card */}
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/[0.04] px-4 py-2.5">
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Baseline route</span>
          {largestTier !== null && (
            <span className="text-xs text-muted-foreground">· files over {largestTier} lines</span>
          )}
        </div>
        <div className="p-4">
          <ModelChain
            primary={value.main}
            fallbacks={value.fallbacks ?? []}
            models={models}
            providers={providers}
            density={density}
            onChange={(main, fallbacks) => onChange({ ...value, main, fallbacks })}
          />
        </div>
      </div>

      {/* Size tier cards */}
      {tiers.length > 0 && (
        <div className="space-y-3">
          {tiers.map((tier, index) => (
            <div key={index} className="overflow-hidden rounded-lg border border-border">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/[0.04] px-4 py-2.5">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Size tier {tiers.length > 1 ? index + 1 : ''}
                </span>
                <button
                  type="button"
                  aria-label="Remove size tier"
                  onClick={() => removeTier(index)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:bg-danger/5 hover:text-danger"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="grid min-w-0 grid-cols-1 gap-4 p-4 lg:grid-cols-[160px_minmax(0,1fr)]">
                <div className="min-w-0 space-y-1.5">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    Max lines
                  </label>
                  <div className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-border bg-background px-3 focus-within:ring-1 focus-within:ring-ring">
                    <input
                      type="number"
                      min={1}
                      value={tier.max_lines}
                      onChange={e => updateTier(index, { max_lines: Number(e.target.value) || 1 })}
                      className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none"
                    />
                    <span className="shrink-0 text-xs text-muted-foreground">lines</span>
                  </div>
                </div>
                <ModelChain
                  primary={tier.model}
                  fallbacks={tier.fallbacks || []}
                  models={models}
                  providers={providers}
                  density={density}
                  onChange={(model, fallbacks) => {
                    if (model) updateTier(index, { model, fallbacks });
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
