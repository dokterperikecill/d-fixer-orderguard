const { defineConfig } = require('@playwright/test');

const baseURL = process.env.STAGING_BASE_URL;
if (!baseURL) throw new Error('STAGING_BASE_URL wajib diatur untuk E2E staging.');

module.exports = defineConfig({
  testDir: './e2e-staging',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report/staging', open: 'never' }],
  ],
  use: {
    baseURL,
    ignoreHTTPSErrors: process.env.STAGING_INSECURE_TLS === '1',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    serviceWorkers: 'allow',
  },
});
