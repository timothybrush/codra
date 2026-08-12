import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '@server/env';
import { getRepoConfigRecord, listRepoConfigs, upsertRepoConfig, syncRepoConfig, updateRepoConfigEnabled, deleteStaleRepoConfigs } from '@server/db/repo-configs';
import { jsonError } from '@server/core/http';
import { GitHubClient, type GitHubRepository } from '@server/core/github';
import { invalidateRepoConfigCache } from '@server/core/config';
import { repoConfigSchema } from '@shared/schema';

const repoConfigPatchSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    review: repoConfigSchema.shape.review.optional(),
    model: repoConfigSchema.shape.model.optional(),
  })
  .refine(
    (patch) => patch.enabled !== undefined || patch.review !== undefined || patch.model !== undefined,
    'Repository config patch cannot be empty.',
  );

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createReposRouter() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const repos = await listRepoConfigs(c.env);
    return c.json({ repos });
  });

  app.get('/install', async (c) => {
    try {
      return c.redirect(await GitHubClient.getAppInstallationUrl(c.env), 302);
    } catch (error) {
      console.error('Failed to resolve GitHub App installation URL:', error);
      return jsonError(`Failed to resolve GitHub App installation URL: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  });

  app.post('/sync', async (c) => {
    try {
      const installations = await GitHubClient.listInstallations(c.env);
      const synced: string[] = [];

      for (const inst of installations) {
        const github = new GitHubClient(c.env, String(inst.id));
        const repos: GitHubRepository[] = await github.listRepositories();

        const results = await mapWithConcurrency(
          repos,
          5,
          async (repo: GitHubRepository) => {
            const owner = repo.owner.login;
            const name = repo.name;
            const fullName = `${owner}/${name}`;
            try {
              await syncRepoConfig(c.env, {
                installationId: String(inst.id),
                owner,
                repo: name,
              });
              return fullName;
            } catch (repoError) {
              console.error('Failed to sync repo:', fullName, repoError);
              return null;
            }
          },
        );

        const installationSynced: string[] = [];
        for (const res of results) {
          if (res) {
            synced.push(res);
            installationSynced.push(res);
          }
        }
        
        await deleteStaleRepoConfigs(c.env, String(inst.id), installationSynced);
      }

      return c.json({ ok: true, synced });
    } catch (error) {
      console.error('Manual sync failed:', error);
      return jsonError(`Sync failed: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  });

  app.get('/:owner/:repo/config', async (c) => {
    const repo = await getRepoConfigRecord(c.env, c.req.param('owner'), c.req.param('repo'));
    if (!repo) {
      return jsonError('Repository config not found.', 404);
    }

    return c.json({ repo });
  });
  
  app.patch('/:owner/:repo/config', async (c) => {
    const { owner, repo } = c.req.param();
    const body = await c.req.json();
    const parsedPatch = repoConfigPatchSchema.safeParse(body);
    if (!parsedPatch.success) {
      return jsonError('Invalid repository config patch.', 400);
    }

    const existing = await getRepoConfigRecord(c.env, owner, repo);
    
    if (!existing) {
      return jsonError('Repository config not found.', 404);
    }

    const patch = parsedPatch.data;
    const hasConfigPatch = patch.review !== undefined || patch.model !== undefined;

    if (!hasConfigPatch && patch.enabled !== undefined) {
      await updateRepoConfigEnabled(c.env, {
        owner,
        repo,
        enabled: patch.enabled,
      });
      await invalidateRepoConfigCache(c.env, owner, repo);
      return c.json({ ok: true });
    }

    const configPatch: Partial<z.infer<typeof repoConfigSchema>> = {};
    if (patch.review !== undefined) {
      configPatch.review = patch.review;
    }
    if (patch.model !== undefined) {
      configPatch.model = patch.model;
    }
    
    const updatedParsedJson = {
      ...existing.parsedJson,
      ...configPatch,
    };
    const parsedConfig = repoConfigSchema.safeParse(updatedParsedJson);

    if (!parsedConfig.success) {
      return jsonError('Invalid repository config.', 400);
    }
    
    await upsertRepoConfig(c.env, {
      installationId: existing.installationId,
      owner,
      repo,
      parsedJson: parsedConfig.data,
      enabled: patch.enabled,
    });
    await invalidateRepoConfigCache(c.env, owner, repo);
    
    return c.json({ ok: true });
  });

  return app;
}
