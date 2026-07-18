import { Skeleton } from '@client/components/shared/skeleton';
import { LoadError } from '@client/components/shared/load-error';

interface JobDetailSkeletonProps {
  error: string | null;
}

export function JobDetailSkeleton({ error }: JobDetailSkeletonProps) {
  return (
    <section className="ui-font-sans flex flex-col gap-6">
      {error && <LoadError title="Something went wrong" detail={error} />}
      <header className="flex items-start justify-between">
        <div className="space-y-2">
          <Skeleton width={120} height="0.75rem" />
          <Skeleton width={280} height="2rem" />
          <Skeleton width={200} height="0.9rem" />
        </div>
        <Skeleton width={100} height="2.25rem" borderRadius={7} />
      </header>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="ui-panel overflow-hidden">
          <div className="border-b border-ui-line px-4 py-3 sm:px-5">
            <Skeleton width="40%" height="1rem" />
          </div>
          <div className="space-y-3 px-4 py-4 sm:px-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1">
                <Skeleton width={60} height="0.65rem" />
                <Skeleton width={100} height="1rem" />
              </div>
            ))}
          </div>
        </div>
        <div className="ui-panel overflow-hidden">
          <div className="border-b border-ui-line px-4 py-3 sm:px-5">
            <Skeleton width="40%" height="1rem" />
          </div>
          <div className="space-y-3 px-4 py-4 sm:px-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="ui-well flex items-center justify-between rounded-md px-4 py-3">
                <div className="flex items-center gap-3">
                  <Skeleton width={12} height={12} borderRadius="50%" />
                  <Skeleton width={120} height="0.9rem" />
                </div>
                <Skeleton width={40} height="0.75rem" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
