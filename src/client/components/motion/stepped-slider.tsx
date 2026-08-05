// Discrete-step slider with a spring-smoothed thumb and a live value readout
// that sits statically above the track (no floating/portal-positioned
// tooltip involved). Adapted from a min/max/step numeric range slider so
// labeled steps (e.g. Low/Medium/High/Max) line up exactly on evenly spaced
// stops.
import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from 'motion/react';
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cn } from '@client/lib/utils';
import { useIsDarkMode } from '@client/hooks/use-is-dark-mode';

const SPRING_GLIDE = { stiffness: 700, damping: 50, mass: 0.5 } as const;
const SPRING_BOUNCY = { type: 'spring', stiffness: 500, damping: 14, mass: 0.7 } as const;

// Deterministic 0..1 seed derived from the slider's id, so two sliders maxed
// out at the same time get slightly different hues and animation timing
// instead of pulsing in perfect, obviously-copy-pasted unison.
function seedFromId(id: string | undefined) {
  if (!id) return 0;
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return (hash % 997) / 997;
}

export interface SteppedSliderStep {
  value: number;
  label: string;
}

export interface SteppedSliderProps {
  id?: string;
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Tick dots + labels rendered at each defined step. */
  steps?: SteppedSliderStep[];
  /** Live value readout shown above the track, and used as the accessible aria-valuetext. Defaults to the raw value. */
  formatValue?: (value: number) => string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function SteppedSlider({
  id,
  value,
  defaultValue = 0,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  steps = [],
  formatValue,
  disabled = false,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: SteppedSliderProps) {
  const reduce = useReducedMotion();
  const isDark = useIsDarkMode();
  const seed = useMemo(() => seedFromId(id), [id]);
  const trackRef = useRef<HTMLDivElement>(null);
  const [internal, setInternal] = useState(defaultValue);
  const [active, setActive] = useState(false);
  // Live position while dragging, decoupled from the committed value so that
  // onValueChange fires exactly once per gesture (on release) instead of on
  // every pointer-move tick - callers may react to a commit by opening a
  // confirmation dialog, which must not re-fire while the pointer is still down.
  const [dragValue, setDragValue] = useState<number | null>(null);
  const controlled = value !== undefined;
  const committedValue = clamp(controlled ? (value as number) : internal, min, max);
  const current = active && dragValue !== null ? clamp(dragValue, min, max) : committedValue;
  const percent = ((current - min) / (max - min)) * 100;
  const isMaxed = current === max;

  // Teal accent for the "maxed out" state, hue-shifted slightly per instance
  // and timed with a per-instance offset so simultaneous max sliders read as
  // one cohesive design rather than a mirrored duplicate.
  const hue = 185 + (seed - 0.5) * 16;
  const glowColor = isDark ? `oklch(68% 0.14 ${hue})` : `oklch(52% 0.13 ${hue})`;
  const fillGradient = isDark
    ? `linear-gradient(90deg, oklch(28% 0.08 ${hue}), oklch(62% 0.12 ${hue}))`
    : `linear-gradient(90deg, oklch(93% 0.03 ${hue}), oklch(56% 0.13 ${hue}))`;
  const dotDriftDuration = 1.4 + seed * 0.5;
  const glowDuration = 1.6 + seed * 0.6;

  const target = useMotionValue(percent);
  useEffect(() => {
    target.set(percent);
  }, [percent, target]);
  const smooth = useSpring(target, SPRING_GLIDE);
  const pos = reduce ? target : smooth;
  const left = useMotionTemplate`${pos}%`;
  const thumbX = useTransform(pos, (p) => `${-p}%`);

  const snapValue = useCallback(
    (next: number) => clamp(Math.round((next - min) / step) * step + min, min, max),
    [min, max, step],
  );

  const commit = useCallback(
    (next: number) => {
      const snapped = snapValue(next);
      if (!controlled) setInternal(snapped);
      onValueChange?.(snapped);
    },
    [controlled, onValueChange, snapValue],
  );

  const valueFromX = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return committedValue;
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return min + ratio * (max - min);
    },
    [committedValue, min, max],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setActive(true);
      setDragValue(snapValue(valueFromX(event.clientX)));
    },
    [disabled, valueFromX, snapValue],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!active || disabled) return;
      setDragValue(snapValue(valueFromX(event.clientX)));
    },
    [active, disabled, valueFromX, snapValue],
  );

  const endDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      setActive(false);
      setDragValue((pending) => {
        if (pending !== null) commit(pending);
        return null;
      });
    },
    [commit],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      const map: Record<string, number> = {
        ArrowRight: committedValue + step,
        ArrowUp: committedValue + step,
        ArrowLeft: committedValue - step,
        ArrowDown: committedValue - step,
        Home: min,
        End: max,
      };
      if (event.key in map) {
        event.preventDefault();
        commit(map[event.key]);
      }
    },
    [disabled, committedValue, step, min, max, commit],
  );

  const valueLabel = formatValue ? formatValue(current) : String(current);

  return (
    <div className={cn('w-full', className)}>
      {/* live value readout - sits in normal flow above the track, always visible */}
      <div className="mb-1.5 flex justify-end">
        <span className="text-xs font-medium text-foreground tabular-nums">{valueLabel}</span>
      </div>

      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={cn(
          'relative flex h-10 w-full touch-none select-none items-center overflow-hidden rounded-lg bg-muted',
          disabled ? 'pointer-events-none opacity-50' : 'cursor-grab active:cursor-grabbing',
        )}
      >
        {/* fill - runs from the left edge to the thumb; static teal gradient with a dot texture
            steadily drifting left-to-right at the top step. Every dot has the same fixed
            brightness - only position moves - so it reads as one smooth, consistent motion
            instead of some dots being brighter than others. The pattern repeats every 10px and
            shifts by exactly one period, so the loop point is never visible. */}
        <motion.div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: left }}>
          {isMaxed ? (
            <div
              className="absolute inset-0"
              style={{ backgroundImage: fillGradient }}
            >
              <motion.div
                className="absolute inset-0"
                style={{
                  backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.85) 1.3px, transparent 1.3px)',
                  backgroundSize: '10px 10px',
                }}
                animate={reduce ? undefined : { backgroundPositionX: ['0px', '10px'] }}
                transition={{ duration: dotDriftDuration, repeat: Infinity, ease: 'linear' }}
              />
            </div>
          ) : (
            <div className="absolute inset-0 bg-foreground/15" />
          )}
        </motion.div>

        {/* ticks - slight inset so the end dots don't clip; sized/ringed up at the top step so they
            read as distinct markers instead of blending into the dot texture behind them */}
        <div className="pointer-events-none absolute inset-x-2 inset-y-0">
          {steps.map((tick) => {
            const tp = ((tick.value - min) / (max - min)) * 100;
            return (
              <span
                key={tick.value}
                className={cn(
                  'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full',
                  isMaxed ? 'size-1.5 bg-white shadow-[0_0_0_1.5px_rgba(0,0,0,0.35)]' : 'size-1 bg-foreground/25',
                )}
                style={{ left: `${tp}%` }}
              />
            );
          })}
        </div>

        {/* pulsing glow halo behind the thumb at the top step - kept as its own layer so only
            opacity (a plain number) is animated, since Motion's box-shadow interpolator can't
            parse CSS custom properties inside the color stops */}
        {isMaxed && !reduce && (
          <motion.div
            aria-hidden
            className="pointer-events-none absolute top-1/2 h-5 w-1.5 rounded-sm"
            style={{ left, x: thumbX, y: '-50%', boxShadow: `0 0 9px 3px ${glowColor}` }}
            animate={{ opacity: [0.25, 0.9, 0.25], scale: [1, 1.15, 1] }}
            transition={{ duration: glowDuration, repeat: Infinity, ease: 'easeInOut', delay: seed * 0.5 }}
          />
        )}

        {/* vertical bar thumb - contained at both ends via thumbX */}
        <motion.div
          id={id}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={Math.round(current)}
          aria-valuetext={valueLabel}
          aria-disabled={disabled || undefined}
          onKeyDown={onKeyDown}
          animate={reduce ? undefined : { scaleY: active ? 1.35 : 1 }}
          transition={SPRING_BOUNCY}
          className={cn(
            'absolute top-1/2 h-5 w-1.5 rounded-sm bg-foreground shadow-sm outline-none ring-foreground/30 focus-visible:ring-4',
            // a background-colored ring keeps the thumb legible against the accent
            // fill at any position, instead of tinting it the same hue as its glow
            isMaxed && 'ring-2 ring-background',
          )}
          style={{ left, x: thumbX, y: '-50%' }}
        />
      </div>

      {steps.length > 0 && (
        <div className="relative mt-1.5 h-4">
          <div className="absolute inset-x-2 inset-y-0">
            {steps.map((tick, index) => {
              const isFirst = index === 0;
              const isLast = index === steps.length - 1;
              const tp = ((tick.value - min) / (max - min)) * 100;
              return (
                <span
                  key={tick.value}
                  className={cn(
                    'absolute text-[10px] font-medium text-muted-foreground',
                    isFirst && 'left-0',
                    isLast && 'right-0',
                    !isFirst && !isLast && '-translate-x-1/2',
                  )}
                  style={!isFirst && !isLast ? { left: `${tp}%` } : undefined}
                >
                  {tick.label}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
