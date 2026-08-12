import * as React from 'react';
import { type VariantProps } from 'class-variance-authority';
import { cn } from '@client/lib/utils';
import type { JobSummary } from '@codra/schema';
import { LiveReviewStepper } from '@client/components/features/reviews/live-review-stepper';
import { badgeVariants } from '@client/components/ui/badge-variants';

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

export { Badge, StatusBadge };
