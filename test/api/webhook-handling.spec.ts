import { createApp } from '@server/app';
import { createMockPRWebhook, createTestEnv, uniqueName } from '../helpers';

import { signPayload } from '../mocks/fixtures';

describe('Webhook Handling Suite', () => {
  const env = createTestEnv();
  const app = createApp();

  // This file used to mock '@server/core/github' to "avoid real JWT signing and network calls".
  // That mock was dead: the webhook handler never constructs a GitHubClient. It verifies the
  // signature, records the delivery, reads config from KV/Postgres and enqueues -- `loadRepoConfig`
  // takes only `env`, and `new GitHubClient` appears solely in core/review.ts, routes/api/repos.ts
  // and services/github.ts, none of which this path touches. Proven by giving the stub class a
  // throwing constructor: the suite still passed 6/6, so the stub was never instantiated.
  //
  // Replaced with the invariant the mock was gesturing at, which is real and worth holding: handling
  // a webhook must not call GitHub. That is what keeps the handler inside GitHub's 10s delivery
  // timeout -- the review work happens later, in the Workflow. A spy rather than a stub, so if
  // someone adds a GitHub call here the assertion names the URL instead of hanging on a real fetch.
  const githubRequests: string[] = [];
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    // Records and passes through: the DB driver is free to use fetch, only github.com is the concern.
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('github.com')) githubRequests.push(url);
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    expect(githubRequests).toEqual([]);
  });

  beforeEach(() => {
    (env.REVIEW_QUEUE as any).sent.length = 0;
  });

  it('rejects webhooks with invalid signatures', async () => {
    const payload = JSON.stringify(createMockPRWebhook());
    const response = await app.request(
      'http://codra.test/webhook',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': 'delivery-inv',
          'x-hub-signature-256': 'sha256=invalid',
        },
        body: payload,
      },
      env,
    );

    expect(response.status).toBe(401);
  });

  it('rejects signed malformed webhook JSON with a 400', async () => {
    const body = '{"not": "valid"';
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

    const response = await app.request(
      'http://codra.test/webhook',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': uniqueName('malformed'),
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        body,
      },
      env,
    );

    expect(response.status).toBe(400);
  });

  it('accepts valid pull_request.opened and queues a job', async () => {
    const repoName = uniqueName('repo');
    const rawPayload = createMockPRWebhook({
        action: 'opened',
        repository: { name: repoName, owner: { login: 'test-owner' } }
    });
    rawPayload.pull_request.head.sha = 'a'.repeat(40);
    rawPayload.pull_request.base.sha = 'b'.repeat(40);
    const body = JSON.stringify(rawPayload);
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

    const response = await app.request(
      'http://codra.test/webhook',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': uniqueName('delivery'),
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        body,
      },
      env,
    );

    const json = await response.json() as any;
    expect(response.status).toBe(202);
    expect(json.ok).toBe(true);
    expect(json.message).toBe('queued');
    expect(json.job.status).toBe('queued');

    const queue = env.REVIEW_QUEUE as any;
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0].jobId).toBe(json.job.id);
    expect(queue.sent[0].deliveryId).toBeDefined();
    expect(queue.sent[0].phase).toBe('prepare');
    expect(queue.sent[0].eventName).toBeUndefined();
    expect(queue.sent[0].payload).toBeUndefined();
  });

  it('rejects GitHub webhooks posted to the site root', async () => {
    const repoName = uniqueName('root-repo');
    const rawPayload = createMockPRWebhook({
      action: 'opened',
      repository: { name: repoName, owner: { login: 'test-owner' } }
    });
    rawPayload.pull_request.head.sha = 'c'.repeat(40);
    rawPayload.pull_request.base.sha = 'd'.repeat(40);
    const body = JSON.stringify(rawPayload);
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

    const response = await app.request(
      'http://codra.test/',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': uniqueName('root-delivery'),
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        body,
      },
      env,
    );

    expect(response.status).toBe(404);

    const queue = env.REVIEW_QUEUE as any;
    expect(queue.sent).toHaveLength(0);
  });

  it('acknowledges unsupported GitHub events without queueing review work', async () => {
    const rawPayload = createMockPRWebhook({
      action: 'opened',
      repository: { name: uniqueName('repo-check-suite'), owner: { login: 'test-owner' } },
    });
    const body = JSON.stringify(rawPayload);
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

    const response = await app.request(
      'http://codra.test/webhook',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'check_suite',
          'x-github-delivery': uniqueName('check-suite'),
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        body,
      },
      env,
    );

    const json = await response.json() as any;
    expect(response.status).toBe(202);
    expect(json.ok).toBe(true);
    expect(json.ignored).toBe(true);
    expect(json.eventName).toBe('check_suite');

    const queue = env.REVIEW_QUEUE as any;
    expect(queue.sent).toHaveLength(0);
  });

  it('ignores webhooks for draft PRs', async () => {
      const draftPayload = createMockPRWebhook({ 
          action: 'opened',
          pull_request: { draft: true, number: 99, head: { sha: 'abc' }, base: { sha: 'def' }, user: { login: 'a' } }
      });
      const body = JSON.stringify(draftPayload);
      const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

      const response = await app.request(
        'http://codra.test/webhook',
        {
          method: 'POST',
          headers: {
            'x-github-event': 'pull_request',
            'x-github-delivery': uniqueName('draft'),
            'x-hub-signature-256': signature,
          },
          body,
        },
        env,
      );

      const json = await response.json() as any;
      expect(response.status).toBe(202);
      expect(json.message).toBe('queued');

      const queue = env.REVIEW_QUEUE as any;
      expect(queue.sent).toHaveLength(1);
      expect(queue.sent[0].payload).toBeUndefined();
      expect(queue.sent[0].eventName).toBe('pull_request');
  });
});
