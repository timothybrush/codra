import fs from 'fs';
import path from 'path';

const dir = path.join(process.cwd(), 'packages', 'db', 'src', 'repositories');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));

for (const file of files) {
  const filePath = path.join(dir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Replace AppBindings imports
  content = content.replace(/import type \{ AppBindings \} from '@server\/env';/g, "import type { DbEnv } from '../env';");
  content = content.replace(/env: AppBindings/g, "env: DbEnv");
  content = content.replace(/import type \{ DbEnv \} from '@server\/env';/g, "import type { DbEnv } from '../env';");

  // Fix DB imports
  content = content.replace(/@server\/db\//g, '../');

  fs.writeFileSync(filePath, content);
}
console.log('Done');
