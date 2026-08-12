// Asserts the @codra/core purity criterion: the review engine must not depend on hono, postgres,
// wrangler types, or any git-provider SDK, and must not reach back into the legacy src/ tree.
//
// This exists alongside eslint's import-x/no-restricted-paths because that rule only sees file
// paths. It cannot see an npm dependency added to packages/core/package.json, and -- the case that
// actually matters -- it does not object to `import type { AppBindings } from '...'`, which leaves
// no runtime trace and would silently reintroduce the platform coupling this extraction removes.
// So this script checks the manifest AND bans the identifiers by name.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PKG = join(ROOT, 'packages/core');

const BANNED_DEPS = ['hono', 'postgres', 'wrangler', '@cloudflare/workers-types', '@octokit/rest', '@octokit/core'];

// Import specifiers no file in the package may name.
const BANNED_SPECIFIERS = [
  "from 'hono'",
  "from 'postgres'",
  "from 'cloudflare:workers'",
  "from 'node:async_hooks'",
  "from '@server/",
  "from '@client/",
  "from '@codra/worker",
  '../../src/',
  '../../../src/',
];

// Types and classes whose presence means a port was bypassed. Type-only imports of these are the
// exact regression this half of the check is for.
const BANNED_IDENTIFIERS = [
  'AppBindings',
  'KVNamespace',
  'HyperdriveBinding',
  'GitHubService',
  'GitHubClient',
  'ModelService',
  'FormatterService',
  'queryRows',
  'runWithDb',
];

const failures = [];

const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
  for (const name of Object.keys(manifest[field] ?? {})) {
    if (BANNED_DEPS.includes(name)) {
      failures.push(`packages/core/package.json: ${field} must not include "${name}"`);
    }
  }
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // test/ may not exist yet
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else if (path.endsWith('.ts') || path.endsWith('.tsx')) {
      yield path;
    }
  }
}

for (const dir of ['src', 'test']) {
  for (const file of walk(join(PKG, dir))) {
    const source = readFileSync(file, 'utf8');
    const where = relative(ROOT, file).replaceAll('\\', '/');

    for (const specifier of BANNED_SPECIFIERS) {
      if (source.includes(specifier)) {
        failures.push(`${where}: must not import ${specifier.replace("from '", '').replace(/'$/, '')}`);
      }
    }

    for (const identifier of BANNED_IDENTIFIERS) {
      // Word-boundary match so `ModelServiceOptions` or a comment mentioning the old name in prose
      // does not trip it; an actual usage always appears as a bare identifier.
      if (new RegExp(`\\b${identifier}\\b`).test(stripComments(source))) {
        failures.push(`${where}: must not reference "${identifier}" -- take a port instead`);
      }
    }
  }
}

// Comments in core legitimately explain what a port replaced ("was env.BOT_USERNAME", "mirrors the
// GitHubService surface"), so the identifier scan runs over code only.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

if (failures.length > 0) {
  console.error('@codra/core boundary check failed:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`\n${failures.length} violation(s). The engine must depend on ports only; implementations live in src/server/adapters.`);
  process.exit(1);
}

console.log('@codra/core boundary check passed: no hono/postgres/wrangler/git-provider dependency, no reach back into src/.');
