// The model-route value type and its pure helpers: normalize, compare, describe.
//
// Separate from model-chain.tsx so repos.tsx and settings.tsx can read and compare routes
// without pulling in the editor UI. model-chain.tsx re-exports all of it, because those pages
// have always imported these names from there.

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
 * `repos.tsx` and `settings.tsx` each had copies that drifted in opposite directions; these keep the
 * safer half of each.
 */
/**
 * Deliberately wider than `Partial<ModelRouteConfig>`: the stored config types every field as
 * nullable and the API returns it raw, so the input type must admit nulls rather than force a cast
 * at each call site.
 */
export type ModelRouteInput =
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
