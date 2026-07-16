import { useMemo } from 'react';
import { cn } from '@client/lib/utils';

interface BarSparklineProps {
  /** Raw daily series; aggregated into `bars` buckets for the mini chart. */
  data: number[];
  /** Bar color (hex). A vertical gradient is derived from it. */
  color: string;
  /** Target number of bars to render. */
  bars?: number;
  className?: string;
}

/**
 * Resample `data` into exactly `bars` values so the chart always renders the
 * same number of bars, for any range or data density:
 *  - empty            → all zeros (rendered as baseline bars)
 *  - more points      → summed down into `bars` buckets
 *  - fewer points     → nearest-neighbour stretched up to `bars`
 * The trend query omits inactive days, so a quiet range can yield far fewer
 * points than the selected day count — this keeps the bar count stable anyway.
 */
function bucketize(data: number[], bars: number): number[] {
  const out = Array<number>(bars).fill(0);
  if (data.length === 0) return out;

  if (data.length >= bars) {
    const size = data.length / bars;
    for (let i = 0; i < bars; i++) {
      const start = Math.floor(i * size);
      const end = Math.floor((i + 1) * size);
      out[i] = data.slice(start, end).reduce((sum, v) => sum + v, 0);
    }
  } else {
    for (let i = 0; i < bars; i++) {
      out[i] = data[Math.floor((i * data.length) / bars)];
    }
  }
  return out;
}

/**
 * Compact bar-chart sparkline for the stat cards: a handful of chunky,
 * gradient bars — lightweight divs rather than a charting lib.
 */
// Every bar gets at least this share of the height, so even zero/quiet periods
// render as a clearly visible small bar rather than an invisible nub. Real
// values scale linearly above the baseline, preserving the trend shape.
const BASELINE_PCT = 32;

export function BarSparkline({ data, color, bars = 8, className }: BarSparklineProps) {
  const buckets = useMemo(() => bucketize(data, bars), [data, bars]);
  const max = Math.max(...buckets, 1);

  return (
    <div className={cn('flex h-12 items-end justify-end gap-[3px]', className)} aria-hidden="true">
      {buckets.map((value, i) => (
        <div
          key={i}
          className="w-[5px] rounded-[2px] transition-[height] duration-500"
          style={{
            height: `${BASELINE_PCT + (value / max) * (100 - BASELINE_PCT)}%`,
            background: `linear-gradient(to top, ${color}99, ${color})`,
          }}
        />
      ))}
    </div>
  );
}
