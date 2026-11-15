import { defineConfig } from 'vitest/config';

// `pnpm test:e2e`: run `pnpm build` first. A successful boot needs a migrated
// database, so the suite also needs the compose Postgres from `make db-up`; it
// works only in throwaway `trader_test_*` databases. Files run one at a time
// because they share one server.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
