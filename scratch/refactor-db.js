import fs from 'fs';
import path from 'path';

const dir = path.join(process.cwd(), 'packages', 'db', 'src');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));

for (const file of files) {
  const filePath = path.join(dir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Replace AppBindings import
  content = content.replace(
    /import type \{ AppBindings \} from '@server\/env';/g,
    `type DbEnv = { HYPERDRIVE: { connectionString: string } };`
  );

  // Replace Pick<AppBindings, 'HYPERDRIVE'> with DbEnv
  content = content.replace(/Pick<AppBindings, 'HYPERDRIVE'>/g, 'DbEnv');
  
  // Replace AppBindings with DbEnv in function parameters
  content = content.replace(/env: AppBindings/g, 'env: DbEnv');

  // jobs-activity.ts has APP_KV. Let's fix it specifically
  if (file === 'jobs-activity.ts') {
    content = content.replace(
      /Pick<AppBindings, 'APP_KV'>/g,
      `{ APP_KV: { put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> } }`
    );
  }
  
  // model-configs.ts has ResolvedModelConfig which we moved to schema
  if (file === 'model-configs.ts') {
    // we already modified the source model-configs.ts to export it, but this is the copied version, wait, we copied the modified version!
  }

  // Replace any remaining '@server/' imports to relative paths if necessary, but actually in packages/db they should still refer to '@codra/schema' or we need to fix local references.
  // Wait, src/server/db doesn't have many '@server/' imports, mostly just '@server/env' and '@codra/schema'.
  // Let's check for any other '@server/' imports.
  
  fs.writeFileSync(filePath, content);
}
console.log('Done');
