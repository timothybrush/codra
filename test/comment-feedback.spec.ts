import { describe, expect, it, vi } from 'vitest';
import { createApp } from '@server/app';
import { createTestEnv } from './helpers';
import { FormatterService, formatFindingMarker, parseFindingMarker } from '@server/services/formatter';
import type { ParsedReviewComment } from '@shared/schema';

vi.mock('@server/core/github', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    GitHubClient: class {
      getInstallationToken = vi.fn().mockResolvedValue('fake-token');
      getRepoFileOrNull = vi.fn().mockResolvedValue(null);
    },
  };
});

async function signPayload(secret: string, payload: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `sha256=${Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const comment = (over: Partial<ParsedReviewComment> = {}): ParsedReviewComment => ({
  path: 'a.ts',
  line: 1,
  position: 1,
  severity: 'P1',
  category: 'quality',
  title: 'Unvalidated input',
  body: 'The value is never checked.',
  fingerprint: 'deadbeef',
  anchorHash: 'cafe1234',
  ...over,
});

describe('finding marker', () => {
  it('round-trips through a rendered comment body', () => {
    const body = new FormatterService('https://codra.test').formatInlineComment(comment());
    expect(parseFindingMarker(body)).toEqual({ fingerprint: 'deadbeef', anchorHash: 'cafe1234' });
  });

  it('emits nothing when the finding has no fingerprint', () => {
    expect(formatFindingMarker({ fingerprint: undefined, anchorHash: undefined })).toBe('');
  });

  it('returns null for a body written by a human', () => {
    expect(parseFindingMarker('Looks good to me!')).toBeNull();
  });
});

describe('feedback webhooks', () => {
  const env = createTestEnv();
  const app = createApp();

  async function post(eventName: string, payload: unknown) {
    const body = JSON.stringify(payload);
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);
    (env.REVIEW_QUEUE as any).sent.length = 0;
    const response = await app.request('http://codra.test/webhook', {
      method: 'POST',
      headers: {
        'x-github-event': eventName,
        'x-github-delivery': `${eventName}-${Date.now()}-${Math.random()}`,
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      body,
    }, env);
    return { response, json: await response.json() as any };
  }

  const basePayload = (over: Record<string, unknown>) => ({
    installation: { id: 123 },
    repository: { name: 'feedback-repo', owner: { login: 'test-owner' } },
    pull_request: { number: 7 },
    ...over,
  });

  const botComment = (over: Record<string, unknown> = {}) => ({
    id: 900001,
    user: { login: `${env.BOT_USERNAME}[bot]` },
    path: 'a.ts',
    // Null on purpose: GitHub nulls `line` once a comment goes outdated, which is exactly when we
    // most want the feedback. The marker is what makes the match possible.
    line: null,
    body: `Something<!-- codra-fp:deadbeef:cafe1234 -->`,
    ...over,
  });

  it('records a deleted bot comment without queueing any review work', async () => {
    const { response, json } = await post('pull_request_review_comment', basePayload({
      action: 'deleted',
      comment: botComment(),
    }));

    expect(response.status).toBe(202);
    expect(json.feedback).toBe(true);
    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(0);
  });

  // Humans delete each other's comments constantly. Recording those would let one developer's
  // cleanup suppress a finding for the whole repository.
  it('ignores feedback on comments the bot did not write', async () => {
    const { response, json } = await post('pull_request_review_comment', basePayload({
      action: 'deleted',
      comment: botComment({ user: { login: 'some-human' }, id: 900002 }),
    }));

    expect(response.status).toBe(202);
    expect(json.recorded).toBe(0);
  });

  it('ignores bot comments with no finding marker', async () => {
    const { json } = await post('pull_request_review_comment', basePayload({
      action: 'deleted',
      comment: botComment({ body: 'no marker here', id: 900003 }),
    }));

    expect(json.recorded).toBe(0);
  });

  it('accepts resolved review threads without queueing review work', async () => {
    const { response, json } = await post('pull_request_review_thread', basePayload({
      action: 'resolved',
      thread: { node_id: 'PRT_x', comments: [botComment({ id: 900004 })] },
    }));

    expect(response.status).toBe(202);
    expect(json.feedback).toBe(true);
    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(0);
  });
});
