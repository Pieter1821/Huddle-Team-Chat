/* eslint-disable no-console -- a command-line tool that reports progress */
// Deploys Huddle to Cloudflare: `npm run deploy`, and what the "Deploy to Cloudflare" button runs.
//
// 1. Database changes first, when the database already exists, so new code never meets old tables.
//    On the very first deploy the database doesn't exist yet (deploying creates it), so a failure
//    here is expected and skipped.
// 2. Build the web app and the Worker, and deploy (this creates the database, storage and queues
//    on a first deploy).
// 3. Database changes again: on a first deploy this creates the tables; otherwise it does nothing.
import { spawnSync } from 'node:child_process';

const run = (cmd, { optional = false } = {}) => {
  console.log(`\n> ${cmd}`);
  const result = spawnSync(cmd, { stdio: 'inherit', shell: true });
  if (result.status !== 0 && !optional) process.exit(result.status ?? 1);
  return result.status === 0;
};

// The source config is named explicitly: after a build, Wrangler would otherwise read the generated
// one, which doesn't carry the migrations folder.
const migrate = 'npx wrangler d1 migrations apply DB --remote --config wrangler.jsonc';

if (!run(migrate, { optional: true })) {
  console.log('\nNo database yet (first deploy?): it will be created and set up after deploying.');
}
run('npx vite build');
run('npx wrangler deploy');
run(migrate);
console.log('\nHuddle is deployed. Open its address and follow the sign-in page.');
