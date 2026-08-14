import fs from 'fs';
import path from 'path';

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(function(file) {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) { 
      results = results.concat(walk(file));
    } else { 
      if (file.endsWith('.ts')) results.push(file);
    }
  });
  return results;
}

const files = walk(path.join(process.cwd(), 'test'));

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  let changed = false;

  if (content.includes('@server/db/')) {
    content = content.replace(/@server\/db\//g, '@codra/db/');
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(file, content);
  }
}
console.log('Done');
