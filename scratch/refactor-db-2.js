import fs from 'fs';
import path from 'path';

const dir = path.join(process.cwd(), 'packages', 'db', 'src');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));

for (const file of files) {
  const filePath = path.join(dir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Fix AppBindings
  content = content.replace(/AppBindings/g, 'DbEnv');

  // Fix APP_KV get and delete
  if (file === 'jobs-activity.ts') {
    content = content.replace(
      /\{ APP_KV: \{ put\(key: string, value: string, options\?: \{ expirationTtl\?: number \} \| undefined\): Promise<void> \} \}/g,
      `{ APP_KV: { put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>; get(key: string): Promise<string | null>; delete(key: string): Promise<void> } }`
    );
  }

  // Fix @server/core/logger in app-settings.ts
  if (file === 'app-settings.ts') {
    content = content.replace(/import \{ logger \} from '@server\/core\/logger';\n?/g, '');
    content = content.replace(/logger\.warn/g, 'console.warn');
    content = content.replace(/logger\.error/g, 'console.error');
  }

  // Check for any other @server/env imports
  content = content.replace(/import type \{ [^}]*DbEnv[^}]* \} from '@server\/env';\n?/g, '');
  content = content.replace(/import \{ [^}]* \} from '@server\/env';\n?/g, '');
  
  fs.writeFileSync(filePath, content);
}
console.log('Done');
