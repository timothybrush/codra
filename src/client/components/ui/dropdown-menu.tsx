import { useRender } from '@base-ui/react/use-render';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'motion/react';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefCallback,
  isValidElement,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@client/lib/utils';

type Side = 'top' | 'bottom' | 'left' | 'right';
type Align = 'start' | 'end';

interface MenuCtx {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLElement | null>;
  panelRef: React.RefObject<HTMLDivElement | null>;
  contentId: string;
}

const DropdownMenuContext = createContext<MenuCtx | null>(null);

function useMenuCtx(component: string) {
  const ctx = useContext(DropdownMenuContext);
  if (!ctx) throw new Error(`${component} must be used within <DropdownMenu>`);
  return ctx;
}

export function DropdownMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const contentId = `${useId()}-menu`;

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

  return (
    <DropdownMenuContext.Provider value={{ open, setOpen, triggerRef, panelRef, contentId }}>
      {children}
    </DropdownMenuContext.Provider>
  );
}

export function DropdownMenuTrigger({
  asChild,
  children,
}: {
  asChild?: boolean;
  children: ReactNode;
}) {
  const ctx = useMenuCtx('DropdownMenuTrigger');
  const setRef: RefCallback<HTMLElement> = (node) => {
    ctx.triggerRef.current = node;
  };

  // Base UI composition: `asChild` merges the trigger props onto the child
  // element itself (former Radix Slot behaviour).
  return useRender({
    render: asChild && isValidElement(children) ? (children as ReactElement) : undefined,
    defaultTagName: 'button',
    ref: setRef,
    props: {
      ...(!asChild && { type: 'button' as const, children }),
      'aria-haspopup': 'menu',
      'aria-expanded': ctx.open,
      'aria-controls': ctx.contentId,
      onClick: () => ctx.setOpen(!ctx.open),
    },
  });
}

export interface DropdownMenuContentProps {
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  className?: string;
  children: ReactNode;
}

const VIEWPORT_PADDING = 8;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function DropdownMenuContent({
  side = 'bottom',
  align = 'start',
  sideOffset = 4,
  alignOffset = 0,
  className,
  children,
}: DropdownMenuContentProps) {
  const ctx = useMenuCtx('DropdownMenuContent');
  const reduce = useReducedMotion() ?? false;
  const [style, setStyle] = useState<React.CSSProperties>({ position: 'fixed', visibility: 'hidden' });

  const setRefs: RefCallback<HTMLDivElement> = (node) => {
    ctx.panelRef.current = node;
  };

  const getItems = () =>
    Array.from(
      ctx.panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]):not([disabled])') ?? [],
    );

  // Move focus into the menu on open and restore it to the trigger on close, so
  // keyboard users land on the first item and return to where they were.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (ctx.open) {
      wasOpen.current = true;
      const id = requestAnimationFrame(() => getItems()[0]?.focus());
      return () => cancelAnimationFrame(id);
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      // Only pull focus back to the trigger if it isn't already somewhere
      // deliberate (e.g. an outside click that landed on another control).
      const active = document.activeElement;
      if (!active || active === document.body || ctx.panelRef.current?.contains(active)) {
        ctx.triggerRef.current?.focus();
      }
    }
  }, [ctx.open]);

  useLayoutEffect(() => {
    if (!ctx.open) return;
    const trigger = ctx.triggerRef.current;
    if (!trigger) return;
    const update = () => {
      const r = trigger.getBoundingClientRect();
      const panel = ctx.panelRef.current;
      const menuW = panel?.offsetWidth ?? 0;
      const menuH = panel?.offsetHeight ?? 0;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let top: number;
      let left: number;

      if (side === 'top' || side === 'bottom') {
        top = side === 'bottom' ? r.bottom + sideOffset : r.top - sideOffset - menuH;
        left = align === 'start' ? r.left + alignOffset : r.right - menuW - alignOffset;
        // Flip to the other side if the preferred one overflows and the opposite fits.
        if (side === 'bottom' && top + menuH > vh - VIEWPORT_PADDING && r.top - sideOffset - menuH >= VIEWPORT_PADDING) {
          top = r.top - sideOffset - menuH;
        } else if (side === 'top' && top < VIEWPORT_PADDING && r.bottom + sideOffset + menuH <= vh - VIEWPORT_PADDING) {
          top = r.bottom + sideOffset;
        }
      } else {
        left = side === 'right' ? r.right + sideOffset : r.left - sideOffset - menuW;
        top = align === 'start' ? r.top + alignOffset : r.bottom - menuH - alignOffset;
        if (side === 'right' && left + menuW > vw - VIEWPORT_PADDING && r.left - sideOffset - menuW >= VIEWPORT_PADDING) {
          left = r.left - sideOffset - menuW;
        } else if (side === 'left' && left < VIEWPORT_PADDING && r.right + sideOffset + menuW <= vw - VIEWPORT_PADDING) {
          left = r.right + sideOffset;
        }
      }

      // Keep the panel within the viewport regardless of side/align.
      top = clamp(top, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, vh - menuH - VIEWPORT_PADDING));
      left = clamp(left, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, vw - menuW - VIEWPORT_PADDING));

      setStyle({ position: 'fixed', top, left, visibility: 'visible' });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [ctx.open, ctx.triggerRef, side, align, sideOffset, alignOffset]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      ctx.setOpen(false);
      return;
    }
    const items = getItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(current + 1 + items.length) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(current - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1].focus();
    }
  };

  const originX = side === 'top' || side === 'bottom' ? (align === 'start' ? 'left' : 'right') : side === 'right' ? 'left' : 'right';
  const originY = side === 'bottom' ? 'top' : side === 'top' ? 'bottom' : align === 'start' ? 'top' : 'bottom';
  const slideDistance = 6;
  const hiddenOffset =
    side === 'bottom'
      ? { y: -slideDistance }
      : side === 'top'
        ? { y: slideDistance }
        : side === 'right'
          ? { x: -slideDistance }
          : { x: slideDistance };

  const transition: Transition = reduce
    ? { duration: 0.1 }
    : { type: 'spring', duration: 0.35, bounce: 0.15 };

  return createPortal(
    // AnimatePresence unmounts the menu after its exit animation, so the closed
    // menu leaves no invisible, focusable items in the tab order.
    <AnimatePresence>
      {ctx.open && (
        <motion.div
          ref={setRefs}
          id={ctx.contentId}
          role="menu"
          onKeyDown={onKeyDown}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, ...hiddenOffset }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, x: 0, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, ...hiddenOffset }}
          transition={transition}
          style={{ ...style, transformOrigin: `${originX} ${originY}` }}
          className={cn(
            'z-50 min-w-[8rem] overflow-hidden rounded-lg border border-ui-line bg-ui-base p-1 text-ui-default shadow-lg shadow-black/[0.04] dark:shadow-black/50',
            className,
          )}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export interface DropdownMenuItemProps {
  asChild?: boolean;
  className?: string;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  children: ReactNode;
}

export function DropdownMenuItem({ asChild, className, onClick, children }: DropdownMenuItemProps) {
  const ctx = useMenuCtx('DropdownMenuItem');

  return useRender({
    render: asChild ? (children as ReactElement) : undefined,
    defaultTagName: 'button',
    props: {
      ...(!asChild && { type: 'button' as const, children }),
      role: 'menuitem',
      onClick: (e: MouseEvent<HTMLElement>) => {
        onClick?.(e);
        ctx.setOpen(false);
      },
      className: cn(
        'relative flex w-full cursor-default select-none items-center rounded-md px-2 py-1.5 text-sm text-ui-default outline-none transition-colors',
        'hover:bg-ui-fill hover:text-ui-strong focus:bg-ui-fill focus:text-ui-strong',
        className,
      ),
    },
  });
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <div className={cn('-mx-1 my-1 h-px bg-muted', className)} />;
}
