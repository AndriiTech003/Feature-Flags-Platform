import { defineConfig, devices } from '@playwright/test';

if (!process.env.E2E_ID) process.env.E2E_ID = `${Date.now().toString(36)}${process.pid}`;
const id = process.env.E2E_ID;
const database = `ffp_test_e2e_${id}`;
const pg = process.env.E2E_PG_URL ?? 'postgres://127.0.0.1:5432';
export const ports = { api: 4250, relay: 4251, dashboard: 4252, shop: 4253 };
const shared = {
  DATABASE_URL: `${pg}/${database}`,
  REDIS_URL: process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/2',
  REDIS_PREFIX: `ffp_e2e_${id}`,
  E2E_DATABASE: database,
};

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.e2e\.ts/,
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]],
  outputDir: '../test-results',
  globalTeardown: './teardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${ports.dashboard}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'node ../apps/api/dist/seed.js --reset && node ../apps/api/dist/main.js',
      url: `http://127.0.0.1:${ports.api}/health`,
      env: {
        ...shared,
        API_PORT: String(ports.api),
        WORKER_INTERVAL_MS: '500',
        DASHBOARD_URL: `http://127.0.0.1:${ports.dashboard}`,
      },
      timeout: 60000,
      reuseExistingServer: false,
    },
    {
      command: 'node ../apps/relay/dist/main.js',
      url: `http://127.0.0.1:${ports.relay}/health`,
      env: { ...shared, RELAY_PORT: String(ports.relay) },
      timeout: 60000,
      reuseExistingServer: false,
    },
    {
      command: `pnpm --dir ../apps/dashboard exec vite build --outDir dist-e2e --emptyOutDir && pnpm --dir ../apps/dashboard exec vite preview --outDir dist-e2e --port ${ports.dashboard} --host 127.0.0.1 --strictPort`,
      url: `http://127.0.0.1:${ports.dashboard}`,
      env: { VITE_API_URL: `http://127.0.0.1:${ports.api}` },
      timeout: 120000,
      reuseExistingServer: false,
    },
    {
      command: 'node ../apps/demo-shop/dist/server.js',
      url: `http://127.0.0.1:${ports.shop}/health`,
      env: {
        SHOP_PORT: String(ports.shop),
        RELAY_URL: `http://127.0.0.1:${ports.relay}`,
        FLAGS_SERVER_KEY: 'srv-demo-production',
        FLAGS_CLIENT_KEY: 'cli-demo-production',
      },
      timeout: 60000,
      reuseExistingServer: false,
    },
  ],
});
