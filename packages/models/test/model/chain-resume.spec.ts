import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextChainIndexOf, ModelRunner } from '@codraoss/models';
import { defaultRepoConfig } from '@codraoss/schema';
import { TokenTracker } from '@codraoss/core/token-tracker';
import { createTestEnv, saveTestProviderApiKey, createTestModelRunner } from '../../../../test/helpers';

// One invocation only affords ~55s of model calls, so a chain whose head is slow never reaches its
// tail. These pin that a deferral records where it got to and the next attempt resumes there --
// without which entries past the first two are unreachable no matter how often a job retries.
describe('model chain resume', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const file = {
    path: 'src/app.ts',
    lineCount: 1,
    hunks: [],
    isDeleted: false,
    isBinary: false,
    isNew: false,
    previousPath: null,
  };

  const chainConfig = {
    ...defaultRepoConfig,
    model: {
      main: 'gemini-3.1-pro-preview',
      // Three entries, all configured in the test env: the memo only records progress while the
      // chain still has somewhere to go, so a two-entry chain would never write one.
      fallbacks: ['gemini-2.5-pro', 'gemini-3.1-flash-lite'],
      size_overrides: [],
    },
  };

  const gemini = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const ok = () => gemini(200, {
    candidates: [{ content: { parts: [{ text: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9}' }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  });
  // 503, not 500: a transient failure is what produces a deferral rather than a hard failure.
  const unavailable = () => gemini(503, { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } });
  const rateLimited = () => gemini(429, { error: { code: 429, message: 'Resource exhausted. limit: 16000, model: gemini. Please retry in 30s.', status: 'RESOURCE_EXHAUSTED' } });

  async function review(service: ModelRunner) {
    return service.reviewFile({
      file,
      prTitle: 'Test',
      prDescription: null,
      config: chainConfig,
      totalLineCount: 1,
      // Every model gets one shot, so the deferral arrives without a long inline retry ladder.
    } as Parameters<ModelRunner['reviewFile']>[0]);
  }

  it('resumes at the model after the ones that already failed, instead of replaying them', async () => {
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    // Same jobId across both services: the memo is job-scoped KV, exactly as across invocations.
    // Near the subrequest cap, so the chain stops after the primary -- the real shape of the
    // problem, where a breaker ends the walk with models still untried.
    const tracker = new TokenTracker();
    tracker.incrementSubrequests(40);
    const first = createTestModelRunner(env, tracker, { jobId: 'job-chain-resume' });

    const firstFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => unavailable());
    await expect(review(first)).rejects.toThrow(/retrying later/);
    const walked = firstFetch.mock.calls.map((call) => String(call[0]));
    expect(walked.every((url) => url.includes('gemini-3.1-pro-preview'))).toBe(true);
    vi.restoreAllMocks();

    // A fresh service stands in for the next invocation; it reads the memo back out of KV.
    const second = createTestModelRunner(env, undefined, { jobId: 'job-chain-resume' });
    const secondFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok());
    await review(second);

    // The head of the chain is not retried: it was already ruled out for this file.
    const retried = secondFetch.mock.calls.map((call) => String(call[0]));
    expect(retried.every((url) => !url.includes('gemini-3.1-pro-preview'))).toBe(true);
    expect(retried.length).toBeGreaterThan(0);
  });

  it('does not record progress past a model that was only rate-limited', async () => {
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = createTestModelRunner(env, undefined, { jobId: 'job-chain-429' });

    // A 429 means "same model, later" -- advancing past it would skip a healthy model for good.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => rateLimited());
    const failure = await review(service).catch((error) => error);

    expect(nextChainIndexOf(failure)).toBeNull();
  });

  // Observed in production: pro timed out, the invocation ran out of subrequests, and the chain then
  // walked all 8 remaining entries for 2 files -- 16 refusals -- before failing the chunk outright.
  it('stops the chain the moment the invocation runs out of subrequests', async () => {
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = createTestModelRunner(env, undefined, { jobId: 'job-subrequests' });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Too many subrequests by single Worker invocation.'),
    );
    const failure = await review(service).catch((error) => error);

    // One attempt, not one per configured model: the runtime refused the call, so nothing about the
    // next model could make it succeed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(failure?.message)).toMatch(/retrying later/);
    // And no progress recorded: those models never ran, so marking them tried would make the resume
    // memo skip healthy models for the rest of the job.
    expect(nextChainIndexOf(failure)).toBeNull();
  });

  it('reads nothing off an error that never walked a chain', () => {
    expect(nextChainIndexOf(new Error('boom'))).toBeNull();
    expect(nextChainIndexOf(undefined)).toBeNull();
    // 0 is "no progress", and must not be mistaken for a recorded index.
    expect(nextChainIndexOf(Object.assign(new Error('x'), { nextChainIndex: 0 }))).toBeNull();
    expect(nextChainIndexOf(Object.assign(new Error('x'), { nextChainIndex: 2 }))).toBe(2);
  });
});
