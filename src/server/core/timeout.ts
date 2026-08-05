// Wraps a promise factory with a timeout.
// If the operation doesn't complete within `ms` milliseconds, an
// AbortError is thrown with `label` in the message.
//
// Works with both fetch (via the signal option) and arbitrary promises.
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(label: string, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    return await fn(controller.signal);
  } catch (err: any) {
    if (controller.signal.aborted || err?.name === 'AbortError') {
      throw new TimeoutError(label, ms);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
