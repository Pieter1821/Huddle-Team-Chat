import { defineConfig } from 'drizzle-kit';

// drizzle-kit only generates SQL here; Wrangler applies it (locally, in tests and on deploy).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/worker/db/schema.ts',
  out: './migrations',
});
