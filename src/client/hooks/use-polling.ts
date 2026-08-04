import { useEffect, useRef } from 'react';

export function usePolling(callback: () => Promise<void> | void, delay = 10_000, deps: any[] = []) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    // Initial load
    savedCallback.current();

    if (delay === null) return;

    const id = setInterval(() => {
      savedCallback.current();
    }, delay);

    return () => clearInterval(id);
    // The caller owns `deps` — that is this hook's entire contract — so the array is a spread the
    // rule cannot statically verify. The callback itself is read through a ref, so nothing here can
    // go stale; only the RESTART trigger is delegated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delay, ...deps]);
}
