import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'vitest.config.ts',
  'packages/*/vitest.config.ts',
  'apps/*/vitest.config.ts',
]);
