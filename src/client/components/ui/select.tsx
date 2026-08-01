import { Check, ChevronDown } from 'lucide-react';
import { motion, type Transition, useReducedMotion, type Variants } from 'motion/react';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@client/lib/utils';
import { EASE_OUT } from '@client/lib/ease';

// Spring with bounce powers the unfold/separation; per-property timings in the
// content choreograph it. See the `animate`/`transition` props on the panel below.
const CHEVRON_TRANSITION: Transition = { type: 'spring', duration: 0.4, bounce: 0.3 };

// The stagger compounds per option, so it dominates on long lists (the LLM model
// selects run to dozens of entries). 0.02 sits between the original 0.035 — which
// left the last item appearing ~0.9s after opening — and a near-instant cascade.
const LIST_VARIANTS: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.02, delayChildren: 0.03 } },
};
const ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, y: -5, filter: 'blur(2px)' },
  show: { opacity: 1, y: 0, filter: 'blur(0px)' },
};

type Placement = 'bottom' | 'top';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  label?: string;
  className?: string;
  triggerClassName?: string;
  triggerStyle?: CSSProperties;
  leadingIcon?: ReactNode;
  /**
   * 'page'  — trigger sits on the gray page background (e.g. "Last 30 days").
   *            Dropdown gets card bg so it lifts off the page.
   * 'card'  — trigger sits inside a card.
   *            Dropdown gets muted bg so it's distinguishable from the card.
   * Defaults to 'page'.
   */
  variant?: 'page' | 'card';
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = 'Select...',
  label,
  className,
  triggerClassName,
  triggerStyle,
  leadingIcon,
  variant = 'page',
}: SelectProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const listId = `${baseId}-list`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement>('bottom');
  const [height, setHeight] = useState(0);
  const [rect, setRect] = useState<{ left: number; width: number; top: number; bottom: number } | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** What last moved the highlight — only keyboard moves should auto-scroll. */
  const highlightSource = useRef<'keyboard' | 'pointer'>('keyboard');

  const selectedOption = options.find((opt) => opt.value === value);

  // Move the active-descendant highlight onto the current selection (or the first option)
  // each time the listbox opens, so arrow-key navigation always starts from a sane position.
  // Only depends on `open`: keying off `options`/`value` re-ran this whenever a
  // caller passed a freshly-built options array, yanking the highlight back to the
  // selection mid-interaction.
  useEffect(() => {
    if (!open) return;
    highlightSource.current = 'keyboard';
    const idx = options.findIndex((opt) => opt.value === value);
    setHighlightedIndex(idx >= 0 ? idx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Only keyboard navigation scrolls the highlighted option into view. Doing it for
  // pointer hover too created a feedback loop on long lists: hover → scrollIntoView →
  // the scroll listener repositions the panel → the option moves under the cursor →
  // another mouseenter, which read as the menu jittering.
  useEffect(() => {
    if (!open || highlightSource.current !== 'keyboard') return;
    optionRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [open, highlightedIndex]);

  // close on outside pointer / escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  useLayoutEffect(() => {
    const node = innerRef.current;
    if (!node) return;
    const measure = () => setHeight(node.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Track the trigger's viewport position so the portaled panel can follow it,
  // and flip upward when there isn't room below and there's more above. Scroll/resize
  // fire far more often than the display repaints, so batch updates to at most once per
  // animation frame instead of re-rendering on every raw event.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const r = trigger.getBoundingClientRect();
      setRect({ left: r.left, width: r.width, top: r.top, bottom: r.bottom });
      const h = innerRef.current?.offsetHeight ?? 0;
      const below = window.innerHeight - r.bottom;
      const above = r.top;
      setPlacement(below < h + 16 && above > below ? 'top' : 'bottom');
    };
    const scheduleUpdate = (e?: Event) => {
      // Scrolling the option list itself doesn't move the trigger, so recomputing
      // (and re-rendering) on it only causes flicker on long lists.
      if (e && e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      if (frame !== null) return;
      frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', scheduleUpdate, true);
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', scheduleUpdate, true);
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [open]);

  const moveHighlight = (next: number) => {
    highlightSource.current = 'keyboard';
    setHighlightedIndex(Math.min(Math.max(next, 0), options.length - 1));
  };

  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (options.length === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveHighlight(highlightedIndex + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveHighlight(highlightedIndex - 1);
        break;
      case 'Home':
        e.preventDefault();
        moveHighlight(0);
        break;
      case 'End':
        e.preventDefault();
        moveHighlight(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        onValueChange(options[highlightedIndex].value);
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const isTop = placement === 'top';

  // Gooey: the edge facing the panel snaps flat (panel attached) then rounds
  // back once the panel pulls away — the two pinch apart.
  const kf = open ? [0, 0, 7] : [7, 0, 7];
  const kfT: Transition = reduce
    ? { duration: 0 }
    : open
      ? { duration: 0.46, times: [0, 0.4, 1], ease: EASE_OUT }
      : { duration: 0.34, times: [0, 0.5, 1], ease: EASE_OUT };
  const flatT: Transition = { duration: 0 };

  const nearGap = open ? 8 : 0;
  const nearRadius = open ? 7 : 0;
  const gapT: Transition = open
    ? { type: 'spring', duration: 0.44, bounce: 0.45, delay: 0.09 }
    : { type: 'spring', duration: 0.26, bounce: 0.1 };
  const radiusT: Transition = open
    ? { duration: 0.26, ease: EASE_OUT, delay: 0.1 }
    : { duration: 0.15, ease: EASE_OUT };
  const instant: Transition = { duration: 0 };

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label className="text-[10px] font-bold uppercase tracking-wider text-ui-subtle">
          {label}
        </label>
      )}
      <div className="relative">
        <motion.button
          ref={triggerRef}
          type="button"
          id={triggerId}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && options[highlightedIndex] ? `${listId}-option-${highlightedIndex}` : undefined}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={onTriggerKeyDown}
          initial={false}
          animate={{
            borderTopLeftRadius: isTop ? kf : 7,
            borderTopRightRadius: isTop ? kf : 7,
            borderBottomLeftRadius: isTop ? 7 : kf,
            borderBottomRightRadius: isTop ? 7 : kf,
          }}
          transition={{
            borderTopLeftRadius: isTop ? kfT : flatT,
            borderTopRightRadius: isTop ? kfT : flatT,
            borderBottomLeftRadius: isTop ? flatT : kfT,
            borderBottomRightRadius: isTop ? flatT : kfT,
          }}
          style={triggerStyle}
          className={cn(
            'relative z-10 flex h-9 w-full items-center justify-between gap-2 border border-ui-line px-3 py-2 text-sm font-normal text-ui-default outline-none transition-colors',
            variant === 'page' ? 'bg-ui-base' : 'bg-ui-fill/50',
            'hover:bg-ui-fill/70 focus-visible:ring-2 focus-visible:ring-ui-brand/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
            !selectedOption && 'text-ui-subtle',
            triggerClassName,
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {leadingIcon && <span className="shrink-0 text-primary/70">{leadingIcon}</span>}
            <span className="min-w-0 truncate">
              {selectedOption ? selectedOption.label : placeholder}
            </span>
          </span>
          <motion.span
            aria-hidden
            animate={{ rotate: open ? 180 : 0 }}
            transition={reduce ? { duration: 0 } : CHEVRON_TRANSITION}
            className="shrink-0 text-ui-subtle"
          >
            <ChevronDown className="h-4 w-4" />
          </motion.span>
        </motion.button>

      </div>

      {/* Portaled to <body> so the panel always renders above cards, tables, and
          other stacking contexts — it can't be clipped/hidden by an ancestor. */}
      {createPortal(
        <motion.div
          ref={panelRef}
          id={listId}
          role="listbox"
          aria-labelledby={triggerId}
          aria-hidden={!open}
          initial={false}
          animate={
            reduce
              ? { opacity: open ? 1 : 0, height: open ? height : 0 }
              : {
                  opacity: open ? 1 : 0,
                  height: open ? height : 0,
                  // gap opens on the side facing the trigger
                  marginTop: isTop ? 0 : nearGap,
                  marginBottom: isTop ? nearGap : 0,
                  // near corners go flat->round; far corners stay rounded
                  borderTopLeftRadius: isTop ? 7 : nearRadius,
                  borderTopRightRadius: isTop ? 7 : nearRadius,
                  borderBottomLeftRadius: isTop ? nearRadius : 7,
                  borderBottomRightRadius: isTop ? nearRadius : 7,
                }
          }
          transition={
            reduce
              ? { duration: 0.12 }
              : {
                  opacity: open ? { duration: 0.18 } : { duration: 0.16, delay: 0.1 },
                  height: open
                    ? { type: 'spring', duration: 0.4, bounce: 0.14 }
                    : { duration: 0.24, ease: EASE_OUT, delay: 0.1 },
                  marginTop: isTop ? instant : gapT,
                  marginBottom: isTop ? gapT : instant,
                  borderTopLeftRadius: isTop ? instant : radiusT,
                  borderTopRightRadius: isTop ? instant : radiusT,
                  borderBottomLeftRadius: isTop ? radiusT : instant,
                  borderBottomRightRadius: isTop ? radiusT : instant,
                }
          }
          style={{
            position: 'fixed',
            left: rect?.left ?? 0,
            width: rect?.width ?? 0,
            top: isTop ? undefined : (rect?.bottom ?? 0),
            bottom: isTop ? window.innerHeight - (rect?.top ?? 0) : undefined,
            transformOrigin: isTop ? 'bottom' : 'top',
            overflow: 'hidden',
            pointerEvents: open ? 'auto' : 'none',
          }}
          // flush against the trigger, then separates into its own rounded pill;
          // sits above or below depending on available space
          className="z-50 border border-ui-line bg-ui-base shadow-lg shadow-black/[0.04] dark:shadow-black/40"
        >
          <motion.ul
            ref={innerRef}
            variants={reduce ? undefined : LIST_VARIANTS}
            initial={false}
            animate={open ? 'show' : 'hidden'}
            className="max-h-[min(28rem,60vh)] overflow-y-auto p-1"
          >
            {options.map((option, index) => {
              const selected = option.value === value;
              const highlighted = index === highlightedIndex;
              return (
                <motion.li key={option.value} variants={reduce ? undefined : ITEM_VARIANTS}>
                  <button
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    id={`${listId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    onMouseEnter={() => {
                      highlightSource.current = 'pointer';
                      setHighlightedIndex(index);
                    }}
                    onClick={() => {
                      onValueChange(option.value);
                      setOpen(false);
                    }}
                    className={cn(
                      // `whitespace-nowrap`: a narrow trigger (e.g. the 72px "rows per
                      // page" select) used to break mid-word — "10" rendered as "1"/"0"
                      // stacked — because the check icon ate the remaining width.
                      'flex w-full items-center justify-between gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-left text-sm outline-none transition-colors',
                      selected
                        ? 'bg-ui-brand/10 font-medium text-ui-brand'
                        : 'text-ui-default hover:bg-ui-fill hover:text-ui-strong focus-visible:bg-ui-fill',
                      highlighted && !selected && 'bg-ui-fill text-ui-strong',
                    )}
                  >
                    <span className="min-w-0 truncate">{option.label}</span>
                    {selected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                  </button>
                </motion.li>
              );
            })}
          </motion.ul>
        </motion.div>,
        document.body,
      )}
    </div>
  );
}
