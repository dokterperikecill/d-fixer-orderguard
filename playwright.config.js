const { defineConfig } = require('@playwright/test');

const port = 4174;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL wajib diatur untuk E2E.');
const users = [
  { id: 'admin', username: 'admin', password: 'admin123', name: 'Platform Admin', role: 'super-admin', tenantId: 'dfixer-store' },
  { id: 'rani', username: 'rani', password: 'rani123', name: 'Rani Admin', role: 'store-admin', tenantId: 'dfixer-store' },
  { id: 'handover', username: 'handover', password: 'handover123', name: 'Budi Handover', role: 'handover-staff', tenantId: 'dfixer-store' },
  { id: 'maya', username: 'maya', password: 'maya123', name: 'Maya Admin', role: 'store-admin', tenantId: 'maya-commerce' },
];

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    serviceWorkers: 'allow',
  },
  webServer: {
    command: 'node scripts/e2e-server.js',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: testDatabaseUrl,
      DATABASE_SCHEMA: 'orderguard_e2e',
      NODE_ENV: 'test',
      ORDERGUARD_TEST_USERS: JSON.stringify(users),
      ORDERGUARD_TEST_SEED_DEMO: '1',
      TIKTOK_APP_KEY: '',
      TIKTOK_APP_SECRET: '',
      TIKTOK_REDIRECT_URI: '',
      ORDERGUARD_TOKEN_ENCRYPTION_KEY: '',
    },
  },
});
