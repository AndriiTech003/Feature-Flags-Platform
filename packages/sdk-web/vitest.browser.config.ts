import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    include: ['test/**/*.browser.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: (process.env.VITEST_BROWSERS ?? 'chromium')
        .split(',')
        .map((browser) => ({ browser: browser.trim() as 'chromium' | 'firefox' | 'webkit' })),
    },
  },
});
