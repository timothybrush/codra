// Workflow.create()/.get() resolve to an RPC stub, not a plain object. An undisposed stub holds its
// end of the connection until the GC happens to collect it, which the runtime warns about as "An RPC
// result was not disposed properly" -- and because that warning is raised whenever the finalizer
// notices, it is attributed to whatever invocation is running at the time rather than to the leak.
//
// `WorkflowInstance` does not declare `Symbol.dispose` in @cloudflare/workers-types even though the
// stub carries it, so this reaches for it defensively: a plain object simply no-ops.
export function disposeRpc(stub: unknown): void {
  const disposable = stub as { [Symbol.dispose]?: () => void } | null;
  try {
    disposable?.[Symbol.dispose]?.();
  } catch {
    // Disposal is bookkeeping; never fail the caller's work over it.
  }
}
