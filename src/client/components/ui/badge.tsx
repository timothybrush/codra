import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@client/lib/utils';
import type { JobSummary } from '@shared/schema';
import { LiveReviewStepper } from '@client/components/features/reviews/live-review-stepper';

// Borderless tinted pills (Cloudflare-dashboard style): translucent fill + saturated text of the same hue.
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
  {
    variants: {
      variant: {
        default:   'bg-primary/15 text-primary',
        secondary: 'bg-ui-fill/45 text-ui-default',
        neutral:   'bg-ui-fill/45 text-ui-default',
        info:      'bg-info/15 text-info',
        success:   'bg-success/15 text-success',
        warning:   'bg-warning/15 text-warning',
        danger:    'bg-danger/15 text-danger',
        outline:   'text-ui-default ring-1 ring-inset ring-ui-line bg-transparent',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

type BadgeVariant = NonNullable<BadgeProps['variant']>;

function getTone(value: string): BadgeVariant {
  switch (value) {
    case 'done':
    case 'approve':
      return 'success';
    case 'running':
      return 'info';
    case 'comment':
      return 'warning';
    case 'failed':
    case 'request_changes':
      return 'danger';
    case 'queued':
    case 'superseded':
    case 'cancelled':
      return 'neutral';
    default:
      return 'neutral';
  }
}

function StatusBadge({ label, job }: { label: string; job?: JobSummary }) {
  if (job && (label === 'running' || label === 'queued')) {
    return <LiveReviewStepper job={job} />;
  }

  if (job && label === 'done' && job.errorMessage) {
    return (
      <Badge variant="warning" className="capitalize">
        partial
      </Badge>
    );
  }

  return (
    <Badge variant={getTone(label)} className="capitalize">
      {label.replace(/_/g, ' ')}
    </Badge>
  );
}

export { Badge, StatusBadge, badgeVariants };
