import { describe, it, expect, vi, beforeEach } from 'vitest';

// The review Workflow must run the next phase in a BRAND-NEW instance whenever runReviewJob sets
// `freshInstance` (a subrequest-limit deferral, or entering finalize), because a long-lived instance
// stops hibernating and can no longer get a clean subrequest budget. These tests pin that decision.

const { runReviewJobMock, maintenanceMock, setInstanceMock } = vi.hoisted(() => ({
  runReviewJobMock: vi.fn(),
  maintenanceMock: vi.fn().mockResolvedValue(undefined),
  setInstanceMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/core/review', () => ({ runReviewJob: runReviewJobMock }));
vi.mock('@server/core/job-recovery', () => ({ runBestEffortJobMaintenance: maintenanceMock }));
vi.mock('@server/db/jobs', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  setJobWorkflowInstance: setInstanceMock,
}));
vi.mock('@server/db/client', () => ({ runWithDb: (_env: any, fn: any) => fn() }));

import { ReviewWorkflow } from '@server/workflows/review';

// step.do(name, optsOrFn, maybeFn) runs the callback; step.sleep is a no-op.
function makeStep() {
  return {
    do: vi.fn(async (_name: string, optsOrFn: any, maybeFn?: any) => {
      const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
      return fn();
    }),
    sleep: vi.fn(async () => {}),
  };
}

function runWorkflow(env: any, payload: any) {
  // The cloudflare:workers mock has an empty constructor; pass ctx/env to satisfy the real type,
  // then set env explicitly since the mock ignores constructor args.
  const wf = new ReviewWorkflow({} as any, env) as any;
  wf.env = env;
  return wf.run({ payload, instanceId: 'inst-test' }, makeStep());
}

describe('ReviewWorkflow: fresh instance on freshInstance flag', () => {
  beforeEach(() => vi.clearAllMocks());

  it('re-enqueues the next phase as a fresh instance (carrying the resolved jobId) when freshInstance is set', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = { REVIEW_QUEUE: { send } };
    // Entering finalize -> freshInstance true, with the resolved jobId.
    runReviewJobMock.mockResolvedValueOnce({ action: 'next_phase', phase: 'finalize', delaySeconds: 60, jobId: 'real-job-id', freshInstance: true });

    await runWorkflow(env, { jobId: 'real-job-id', phase: 'review' });

    // The next phase was NOT executed in this instance (only the one run happened)...
    expect(runReviewJobMock).toHaveBeenCalledTimes(1);
    // ...it was handed to a fresh instance keyed on a new deliveryId, carrying the resolved jobId.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'real-job-id',
      phase: 'finalize',
      forceFreshInstance: true,
    }));
  });

  it('re-enqueues a fresh instance for a subrequest-limit review deferral (same phase)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = { REVIEW_QUEUE: { send } };
    // A saturated instance hit the subrequest limit mid-review -> freshInstance true, phase stays review.
    runReviewJobMock.mockResolvedValueOnce({ action: 'next_phase', phase: 'review', delaySeconds: 60, jobId: 'real-job-id', freshInstance: true });

    await runWorkflow(env, { jobId: 'real-job-id', phase: 'review' });

    expect(runReviewJobMock).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'real-job-id', phase: 'review', forceFreshInstance: true }));
  });

  it('does NOT re-enqueue when freshInstance is not set (normal in-instance continuation)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = { REVIEW_QUEUE: { send } };
    // Healthy per-chunk yield (hibernation resets the budget) -> stays in-instance, then completes.
    runReviewJobMock
      .mockResolvedValueOnce({ action: 'next_phase', phase: 'review', delaySeconds: 60, jobId: 'real-job-id', freshInstance: false })
      .mockResolvedValueOnce({ action: 'ack' });

    await runWorkflow(env, { jobId: 'real-job-id', phase: 'review' });

    // Both runs happened in THIS instance; no new instance spawned.
    expect(runReviewJobMock).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });

  it('uses the payload jobId to re-enqueue when the result omits it (auto jobs)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = { REVIEW_QUEUE: { send } };
    runReviewJobMock.mockResolvedValueOnce({ action: 'next_phase', phase: 'finalize', delaySeconds: 60, freshInstance: true });

    await runWorkflow(env, { jobId: 'payload-job-id', phase: 'review' });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'payload-job-id', phase: 'finalize', forceFreshInstance: true }));
  });
});
