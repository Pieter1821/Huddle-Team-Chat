import { defineConfig } from '@playwright/test';

// End-to-end tests drive a real browser against the real app (Worker, D1, Durable Objects) started
// by e2e/server.mjs on a fresh database. Locally they use your installed Chrome; CI installs one.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:8790',
    channel: process.env.CI ? undefined : 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node e2e/server.mjs',
    url: 'http://localhost:8790/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
