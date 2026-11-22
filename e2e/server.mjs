// Starts Huddle for the end-to-end tests with its own empty database and its own settings, so a
// run never touches your local data or your .dev.vars. Server output is copied to a log file the
// tests read sign-in codes from (locally, emails are printed instead of sent).
import { spawn, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';

export const STATE_DIR = '.wrangler/e2e';
export const LOG_FILE = `${STATE_DIR}/server.log`;
export const ADMIN_EMAIL = 'owner@e2e.test';

rmSync(STATE_DIR, { recursive: true, force: true });
mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(
  '.dev.vars.e2e',
  [
    'APP_URL=http://localhost:8787',
    `ADMIN_EMAIL=${ADMIN_EMAIL}`,
    `BETTER_AUTH_SECRET=${randomBytes(32).toString('hex')}`,
    '',
  ].join('\n'),
);

const env = { ...process.env, CLOUDFLARE_ENV: 'e2e', HUDDLE_STATE_DIR: STATE_DIR };
execSync(`npx wrangler d1 migrations apply DB --local --persist-to ${STATE_DIR}`, { stdio: 'inherit', env });

const log = createWriteStream(LOG_FILE);
const server = spawn('npx', ['vite', '--port', '8787', '--strictPort'], { env, shell: true });
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (chunk) => {
    log.write(chunk);
    process.stdout.write(chunk);
  });
}
const stop = () => server.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => process.exit(code ?? 0));
