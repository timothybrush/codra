import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    // Deliberately NO setupFiles: the root test/setup.ts hard-fails when TEST_DATABASE_URL is
    // unset, and this suite exists to prove the engine runs on in-memory ports with no Postgres.
    // Borrowing that setup would defeat the point of it.
    // globals: false to match the package tsconfig, which does not pull in vitest/globals -- specs
    // here import describe/it/expect from 'vitest' explicitly.
    globals: false,
  },
});
