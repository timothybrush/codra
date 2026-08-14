import fs from 'fs';
import path from 'path';

const dir = path.join(process.cwd(), 'packages', 'db', 'src');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));

for (const file of files) {
  if (file === 'env.ts') continue;
  const filePath = path.join(dir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Remove old definitions
  content = content.replace(/type DbEnv = \{ HYPERDRIVE: \{ connectionString: string \} \};\n?/g, '');
  content = content.replace(/\{ APP_KV: \{ put\(key: string, value: string, options\?: \{ expirationTtl\?: number \} \| undefined\): Promise<void>; \} \}/g, 'DbEnv');
  content = content.replace(/\{ APP_KV: \{ put\(key: string, value: string, options\?: \{ expirationTtl\?: number \} \): Promise<void>; get\(key: string\): Promise<string \| null>; delete\(key: string\): Promise<void> \} \}/g, 'DbEnv');

  // Add import if needed
  if (content.includes('DbEnv')) {
    const importStr = `import type { DbEnv } from './env';\n`;
    if (!content.includes(importStr)) {
      content = importStr + content;
    }
  }

  // Also fix APP_KV inline in jobs-activity.ts
  if (file === 'jobs-activity.ts') {
      content = content.replace(/env: \{ APP_KV: \{[^}]+\}[^}]+\}/, 'env: DbEnv');
      content = content.replace(/env: DbEnv \{/, 'env: DbEnv'); // Just in case
  }
  
  fs.writeFileSync(filePath, content);
}
console.log('Done');
