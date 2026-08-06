import * as React from 'react';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@client/lib/utils';

/**
 * Button surface for the app's design system. `primary`/`secondary` use the
 * bordered-panel look; the remaining variants are retained for existing screens
 * still on the older palette. Also powers <LinkButton> (anchor) below.
 */
const buttonVariants = cva(
  'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'border border-[var(--btn-primary-border)] bg-[var(--btn-primary-surface)] text-[var(--btn-primary-fg)] hover:bg-[var(--btn-primary-hover)]',
        secondary: 'border border-ui-line bg-ui-base text-ui-default hover:bg-ui-fill/60',
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 active:scale-[.98]',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        'destructive-outline':
          'border border-danger-border bg-danger-bg/40 text-danger shadow-sm hover:bg-destructive hover:text-destructive-foreground hover:border-destructive',
        'warning-outline':
          'border border-warning-border bg-warning-bg/40 text-warning shadow-sm hover:bg-warning-bg hover:border-warning',
        outline:
          'border border-zinc-200 bg-white shadow-sm hover:bg-zinc-50 hover:text-zinc-900 dark:border-white/10 dark:bg-white/[0.06] dark:hover:bg-white/[0.1] dark:hover:text-foreground',
        ghost: 'hover:bg-secondary hover:text-secondary-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        accent: 'bg-accent text-accent-foreground shadow-sm hover:bg-accent/90 active:scale-[.98]',
      },
      size: {
        default: 'h-9 rounded-md px-4 py-2 text-sm',
        sm: 'h-8 rounded-md px-3 text-xs',
        base: 'h-9 rounded-md px-3 text-sm',
        lg: 'h-11 rounded-md px-6 text-sm',
        xs: 'h-6 rounded-md px-1.5 text-xs',
        icon: 'h-9 w-9 rounded-md',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

type Shape = 'base' | 'square' | 'circle';

// Icon-only shapes: collapse padding and match width to the height of each size.
const SQUARE_WIDTH: Record<string, string> = {
  xs: 'w-6 p-0',
  sm: 'w-8 p-0',
  base: 'w-9 p-0',
  default: 'w-9 p-0',
  lg: 'w-11 p-0',
  icon: 'p-0',
};

function shapeClass(shape: Shape, size: VariantProps<typeof buttonVariants>['size']) {
  if (shape === 'base') return '';
  return cn(SQUARE_WIDTH[size ?? 'default'], shape === 'circle' && 'rounded-full');
}

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  shape?: Shape;
  /** Element rendered before children (skipped while `loading`). */
  icon?: React.ReactNode;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, shape = 'base', asChild = false, icon, loading, children, ...props }, ref) => {
    const classes = cn(buttonVariants({ variant, size }), shapeClass(shape, size), className);

    // Base UI composition: `asChild` renders the child element itself (props
    // merged onto it), mirroring the former Radix Slot behaviour.
    return useRender({
      render: asChild && React.isValidElement(children) ? children : undefined,
      defaultTagName: 'button',
      ref,
      props: {
        className: classes,
        ...props,
        ...(asChild
          ? {}
          : {
              disabled: props.disabled || loading,
              children: (
                <>
                  {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
                  {children}
                </>
              ),
            }),
      },
    });
  },
);
Button.displayName = 'Button';

export interface LinkButtonProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement>,
    VariantProps<typeof buttonVariants> {
  shape?: Shape;
  icon?: React.ReactNode;
  /** Open in a new tab with safe rel attributes. */
  external?: boolean;
}

const LinkButton = React.forwardRef<HTMLAnchorElement, LinkButtonProps>(
  ({ className, variant, size, shape = 'base', icon, external, children, ...props }, ref) => (
    <a
      ref={ref}
      className={cn(buttonVariants({ variant, size }), shapeClass(shape, size), className)}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...props}
    >
      {icon}
      {children}
    </a>
  ),
);
LinkButton.displayName = 'LinkButton';

export { Button, LinkButton, buttonVariants };
