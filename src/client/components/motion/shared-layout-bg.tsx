// beui.dev/components/motion/shared-layout-bg
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Variants,
} from "motion/react";
import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@client/lib/utils";

const SPRING_LAYOUT = {
  type: "spring" as const,
  stiffness: 400,
  damping: 40,
  mass: 0.6,
};

export interface SharedLayoutBgProps {
  children: ReactNode;
  className?: string;
  pillClassName?: string;
  /** Horizontal inset of the pill relative to each row (px). */
  inset?: number;
}

const variants: Variants = {
  initial: { opacity: 0, filter: "blur(6px)" },
  animate: { opacity: 1, filter: "blur(0px)" },
  exit: (isActive: boolean) =>
    !isActive ? { opacity: 0, filter: "blur(6px)" } : {},
};

const reducedVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: (isActive: boolean) => (!isActive ? { opacity: 0 } : {}),
};

export function SharedLayoutBg({
  children,
  className,
  pillClassName,
  inset = 0,
}: SharedLayoutBgProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const uid = useId();
  const reduce = useReducedMotion();

  return (
    <motion.div
      layoutRoot
      onMouseLeave={() => setActiveId(null)}
      className={cn("flex w-full flex-col", className)}
    >
      {Children.toArray(children)
        .filter(isValidElement)
        .map((child, index) => {
          const el = child as ReactElement<{
            className?: string;
            onMouseEnter?: (e?: any) => void;
            children?: ReactNode;
          }>;
          const childKey = el.key ? String(el.key) : `item-${index}`;
          return cloneElement(
            el,
            {
              key: childKey,
              className: cn("relative z-10", el.props.className),
              onMouseEnter: (e: any) => {
                el.props.onMouseEnter?.(e);
                setActiveId(childKey);
              },
            },
            <>
              <div className="pointer-events-none absolute inset-0 z-0">
                <AnimatePresence custom={activeId !== null}>
                  {activeId !== null ? (
                    <motion.div
                      variants={reduce ? reducedVariants : variants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      custom={activeId !== null}
                      className="absolute inset-0"
                      style={{ left: -inset, right: -inset, top: 0, bottom: 0 }}
                    >
                      {activeId === childKey ? (
                        <motion.div
                          layoutId={`shared-bg-${uid}`}
                          transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
                          className={cn(
                            "pointer-events-none h-full w-full rounded-lg",
                            pillClassName,
                          )}
                        />
                      ) : null}
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
              {el}
            </>
          );
        })}
    </motion.div>
  );
}
