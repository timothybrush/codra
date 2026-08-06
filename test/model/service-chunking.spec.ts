import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelService } from '@server/services/model';




import { createTestEnv, saveTestProviderApiKey } from '../helpers';
import { defaultRepoConfig } from '@shared/schema';
import { TokenTracker } from '@server/core/token-tracker';

describe('ModelService: diff chunking', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('splits an oversized diff into capped chunks and reviews each in its own call', async () => {
    const requestBodies: any[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9}' }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = new ModelService(env);
    const largeFile = {
      path: 'src/large.ts',
      previousPath: null,
      isNew: false,
      isDeleted: false,
      isBinary: false,
      lineCount: 900,
      hunks: [
        {
          header: '@@ -1,900 +1,900 @@',
          lines: Array.from({ length: 900 }, (_, index) => ({
            kind: 'add' as const,
            content: `const value${index} = ${index};`,
            newLineNumber: index + 1,
            position: index + 1,
          })),
        },
      ],
    };

    const response = await service.reviewFile({
      file: largeFile,
      prTitle: 'Test',
      prDescription: null,
      config: {
        ...defaultRepoConfig,
        model: {
          main: 'gemini-3.1-pro-preview',
          fallbacks: [],
          size_overrides: [],
        },
      },
      totalLineCount: 500,
    });

    // A 900-line file with the configured 800-line cap is split into two chunks (800 + 100)
    // and each chunk is reviewed in its own model call instead of the tail being truncated away.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const body of requestBodies) {
      expect(body.generationConfig.maxOutputTokens).toBe(8192);
    }
    const firstPrompt = requestBodies[0].contents[0].parts[0].text as string;
    expect(firstPrompt).toContain('const value799 = 799;');
    expect(firstPrompt).not.toContain('const value800 = 800;');
    const secondPrompt = requestBodies[1].contents[0].parts[0].text as string;
    expect(secondPrompt).toContain('const value800 = 800;');
    expect(secondPrompt).toContain('const value899 = 899;');
    // The whole file is covered across the chunks, so nothing is dropped as truncated.
    expect(response.reviewedLineCount).toBe(900);
    expect(response.wasPromptTruncated).toBe(false);
  });

  // The chunk cap was a flat 4, so at the default 800 lines/chunk no file was ever reviewed past line
  // 3,200 and nothing said so. src/server/core/review.ts changed 3,749 lines in PR #55.
  //
  // The raise to 8 is opportunistic on purpose: chunks past the 4th are only taken while the invocation
  // still has budget to spare, because one runaway file starving its concurrent peers is a failure mode
  // this codebase has already been bitten by.

  describe('the opportunistic chunk tail', () => {
    const okResponse = () => new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9}' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    const hugeFile = (lines: number) => ({
      path: 'src/server/core/review.ts',
      previousPath: null,
      isNew: false,
      isDeleted: false,
      isBinary: false,
      lineCount: lines,
      hunks: [{
        header: `@@ -1,${lines} +1,${lines} @@`,
        lines: Array.from({ length: lines }, (_, index) => ({
          kind: 'add' as const,
          content: `const value${index} = ${index};`,
          newLineNumber: index + 1,
          position: index + 1,
        })),
      }],
    });

    const reviewHugeFile = async (service: ModelService, lines: number) => service.reviewFile({
      file: hugeFile(lines),
      prTitle: 'Test',
      prDescription: null,
      config: {
        ...defaultRepoConfig,
        model: { main: 'gemini-3.1-pro-preview', fallbacks: [], size_overrides: [] },
      },
      totalLineCount: lines,
    });

    it('reviews past the old four-chunk ceiling when the budget is healthy', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okResponse());
      const env = createTestEnv();
      await saveTestProviderApiKey(env);
      // A fresh tracker has the full safe budget, so the tail is affordable.
      const service = new ModelService(env, new TokenTracker());

      // 3,749 lines at the 800-line cap is 5 chunks -- the fifth is exactly what the old cap dropped.
      const response = await reviewHugeFile(service, 3_749);

      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(response.reviewedLineCount).toBe(3_749);
      expect(response.wasPromptTruncated).toBe(false);
    });

    it('stops at the base chunks and reports truncation when the budget is committed elsewhere', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okResponse());
      const env = createTestEnv();
      await saveTestProviderApiKey(env);
      const tracker = new TokenTracker();
      // Below isNearLimit (25) but not enough spare for the tail once the base chunks have run.
      tracker.incrementSubrequests(18);
      const service = new ModelService(env, tracker);

      const response = await reviewHugeFile(service, 3_749);

      // Four chunks reviewed, the fifth yielded -- and reported as truncated rather than as clean.
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(response.reviewedLineCount).toBe(3_200);
      expect(response.wasPromptTruncated).toBe(true);
    });

    it('still refuses to review a file in more than MAX_CHUNKS calls', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okResponse());
      const env = createTestEnv();
      await saveTestProviderApiKey(env);
      const service = new ModelService(env, new TokenTracker());

      // 20,000 lines is 25 chunks; the hard cap must bind, and the result must admit it was truncated.
      const response = await reviewHugeFile(service, 20_000);

      expect(fetchMock).toHaveBeenCalledTimes(8);
      expect(response.wasPromptTruncated).toBe(true);
    });
  });

  it('applies the compact prompt cap by producing smaller chunks after a prior transient failure', async () => {
    const requestBodies: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9}' }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const env = createTestEnv();
    await saveTestProviderApiKey(env);
    const service = new ModelService(env);
    const largeFile = {
      path: 'src/large.ts',
      previousPath: null,
      isNew: false,
      isDeleted: false,
      isBinary: false,
      lineCount: 900,
      hunks: [
        {
          header: '@@ -1,900 +1,900 @@',
          lines: Array.from({ length: 900 }, (_, index) => ({
            kind: 'add' as const,
            content: `const value${index} = ${index};`,
            newLineNumber: index + 1,
            position: index + 1,
          })),
        },
      ],
    };

    const response = await service.reviewFile({
      file: largeFile,
      prTitle: 'Test',
      prDescription: null,
      config: {
        ...defaultRepoConfig,
        model: {
          main: 'gemini-3.1-pro-preview',
          fallbacks: [],
          size_overrides: [],
        },
      },
      totalLineCount: 900,
      compactPrompt: true,
    });

    // compactPrompt lowers the per-call cap to COMPACT_REVIEW_PROMPT_LINE_CAP (400), so the
    // 900-line file is split into three chunks (400 + 400 + 100) rather than the two chunks
    // the full 800-line cap would produce -- the first chunk stops exactly at the compact cap.
    expect(requestBodies.length).toBe(3);
    const firstPrompt = requestBodies[0].contents[0].parts[0].text as string;
    expect(firstPrompt).toContain('const value399 = 399;');
    expect(firstPrompt).not.toContain('const value400 = 400;');
    expect(response.reviewedLineCount).toBe(900);
    expect(response.wasPromptTruncated).toBe(false);
  });
});
