import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

// Tests run inside workerd with the real bindings from wrangler.jsonc. The migration files are read
// here (in Node) and handed to the runtime, where test/setup.ts applies them to each test's D1.
// Settings are fixed here (not read from .dev.vars) so tests behave the same on every machine and in CI.
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // An empty database for checking that Huddle sets up its own tables from nothing.
          d1Databases: ['FRESH_DB'],
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_URL: 'http://localhost:8787',
            ADMIN_EMAIL: 'owner@example.com',
            BETTER_AUTH_SECRET: 'test-secret-that-is-long-enough-for-better-auth',
            EMAIL_FROM: '',
            GOOGLE_CLIENT_ID: '',
            GOOGLE_CLIENT_SECRET: '',
            GITHUB_CLIENT_ID: '',
            GITHUB_CLIENT_SECRET: '',
            GMAIL_ADDRESS: '',
            GMAIL_APP_PASSWORD: '',
          },
        },
      }),
    ],
    test: { include: ['test/**/*.test.ts'], setupFiles: ['./test/setup.ts'] },
  };
});
