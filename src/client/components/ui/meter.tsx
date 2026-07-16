import { cn } from '@client/lib/utils';

interface MeterProps {
  /** Row label (e.g. a repo or model name). */
  label: string;
  value: number;
  max: number;
  /** Formatted value shown on the right; falls back to `value.toLocaleString()`. */
  customValue?: string;
  /** Override the indicator fill (e.g. `meter-indicator-info` for the blue bars). */
  indicatorClassName?: string;
  className?: string;
}

/**
 * Labelled progress bar, defaulting the indicator fill to the brand lime.
 */
export function Meter({ label, value, max, customValue, indicatorClassName, className }: MeterProps) {
  const pct = max > 0 ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : 0;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-4">
        <span className="truncate text-sm font-medium text-ui-default">{label}</span>
        <span className="shrink-0 text-xs font-semibold tabular-nums text-ui-subtle">
          {customValue ?? value.toLocaleString()}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-ui-fill">
        <div
          className={cn(
            'h-full rounded-full bg-ui-brand transition-[width] duration-500',
            indicatorClassName,
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
