import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@client/components/ui/button';
import { cn } from '@client/lib/utils';

interface LoadErrorProps {
  /** Friendly headline, e.g. "Couldn't load dashboard data". */
  title?: string;
  /** Raw error detail (e.g. "Failed to fetch"), shown as a mono chip. */
  detail?: string | null;
  /** Guidance line under the title; defaults to connection-check copy. */
  hint?: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}

/**
 * Load-failure banner: friendly copy up front, the raw error as a small mono
 * detail chip, and a Retry action — instead of a bare toast/alert echoing
 * "Failed to fetch".
 */
export function LoadError({
  title = "Couldn't load data",
  detail,
  hint = 'Check your connection, then try again. If this keeps happening, the server may be unreachable.',
  onRetry,
  retrying,
  className,
}: LoadErrorProps) {
  return (
    <section
      role="alert"
      className={cn(
        'ui-font-sans rounded-lg border border-ui-line bg-white p-3.5 dark:border-[oklch(0.27_0_0)] dark:bg-black sm:p-4',
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-red-500/10 text-red-600 dark:text-red-400">
            <AlertTriangle size={15} strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <h2 className="text-[13px] font-medium text-ui-default">{title}</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-ui-subtle">
              {hint}
            </p>
            {detail && (
              <code className="ui-font-mono mt-2 inline-block max-w-full truncate rounded-[5px] bg-[oklch(96.5%_0_0)] px-2 py-1 text-[11px] text-ui-subtle dark:bg-[oklch(19%_0_0)]">
                {detail}
              </code>
            )}
          </div>
        </div>

        {onRetry && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onRetry}
            disabled={retrying}
            icon={<RefreshCw size={13} className={retrying ? 'animate-spin' : ''} />}
            className="w-full shrink-0 sm:w-auto"
          >
            Retry
          </Button>
        )}
      </div>
    </section>
  );
}
