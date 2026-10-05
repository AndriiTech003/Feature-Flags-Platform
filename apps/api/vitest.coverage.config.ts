import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 120000,
    fileParallelism: false,
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/seed.ts', 'src/outbox-main.ts', 'src/db/migrate-cli.ts', 'src/index.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      thresholds: { statements: 70, branches: 60, functions: 72, lines: 75 },
    },
  },
});
