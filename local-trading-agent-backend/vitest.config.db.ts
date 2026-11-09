import { defineConfig } from 'vitest/config';

// `pnpm test:db`: needs the compose Postgres from `make db-up`. Neither
// `pnpm test` nor `pnpm test:e2e` collects these files, so the gate needs no
// database. Files run one at a time because they share one server.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.db-spec.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
