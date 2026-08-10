import { useEffect, useRef } from 'react';

export function usePolling(callback: () => Promise<void> | void, delay = 10_000, deps: any[] = []) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    savedCallback.current();

    if (delay === null) return;

    const id = setInterval(() => {
      savedCallback.current();
    }, delay);

    return () => clearInterval(id);
    // The caller owns `deps`, so the array is a spread the lint rule can't statically verify; the
    // callback itself is read through a ref, so nothing here can go stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delay, ...deps]);
}
