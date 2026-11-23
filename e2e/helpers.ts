import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, type Cookie, type Page } from '@playwright/test';

export const LOG_FILE = '.wrangler/e2e/server.log';
// Its own port, so the tests can run while `npm run dev` is using 8787.
export const ORIGIN = 'http://localhost:8790';
export const ADMIN_EMAIL = 'owner@e2e.test';

export const logSize = () => readFileSync(LOG_FILE, 'utf8').length;

/** The newest sign-in code emailed to this address (printed to the server log in local dev). */
export async function codeFor(email: string, after: number): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(
      () => {
        const log = readFileSync(LOG_FILE, 'utf8').slice(after);
        const blocks = log.split('[email] to: ').filter((b) => b.startsWith(email));
        // The subject names the workspace once it exists ("… is your Acme Studio sign-in code").
        code = /(\d{6}) is your .+ sign-in code/.exec(blocks.at(-1) ?? '')?.[1];
        return code;
      },
      { message: `a sign-in code for ${email}` },
    )
    .toBeTruthy();
  return code!;
}

/** Signs this page's browser context in through the API (faster than the screens, same cookies). */
export async function signInViaApi(page: Page, email: string) {
  const before = logSize();
  // Each simulated person gets their own address, as real people would: sign-in limits count per IP.
  // (Cloudflare always overwrites this header in production, so it can't be faked there.)
  const headers = { origin: ORIGIN, 'cf-connecting-ip': fakeIp(email) };
  const sent = await page.request.post('/api/auth/email-otp/send-verification-otp', {
    data: { email, type: 'sign-in' },
    headers,
  });
  expect(sent.ok(), await sent.text()).toBe(true);
  const res = await page.request.post('/api/auth/sign-in/email-otp', {
    data: { email, otp: await codeFor(email, before) },
    headers,
  });
  expect(res.ok(), await res.text()).toBe(true);
}

const OWNER_COOKIES = '.wrangler/e2e/owner-cookies.json';

/**
 * The owner, signed in, with the workspace set up (by an earlier test file or right now). The owner
 * signs in once per run and later tests reuse that session: sign-in codes are limited to a few an
 * hour per address, and every test file needs the owner.
 */
export async function signInOwner(page: Page) {
  if (existsSync(OWNER_COOKIES)) {
    await page.context().addCookies(JSON.parse(readFileSync(OWNER_COOKIES, 'utf8')) as Cookie[]);
    if ((await page.request.get('/api/me')).ok()) return;
    await page.context().clearCookies();
  }
  await signInViaApi(page, ADMIN_EMAIL);
  writeFileSync(OWNER_COOKIES, JSON.stringify(await page.context().cookies()));
  const status = (await (await page.request.get('/api/setup')).json()) as { needsSetup: boolean };
  if (status.needsSetup) {
    const res = await page.request.post('/api/setup', {
      data: { workspaceName: 'Acme Studio', yourName: 'Olive Owner' },
      headers: { origin: ORIGIN },
    });
    expect(res.ok()).toBe(true);
  }
}

/** Invites someone as a member and signs them in, in their own browser context. */
export async function addMember(owner: Page, member: Page, email: string, name: string) {
  const inv = await owner.request.post('/api/invitations', {
    data: { email, role: 'member' },
    headers: { origin: ORIGIN },
  });
  expect(inv.status()).toBe(201);
  await signInViaApi(member, email);
  const named = await member.request.patch('/api/me', { data: { name }, headers: { origin: ORIGIN } });
  expect(named.ok()).toBe(true);
  return ((await (await member.request.get('/api/me')).json()) as { user: { id: string } }).user.id;
}

export async function conversationId(page: Page, name: string): Promise<string> {
  const { conversations } = (await (await page.request.get('/api/conversations')).json()) as {
    conversations: { id: string; name: string | null }[];
  };
  const c = conversations.find((x) => x.name === name);
  if (!c) throw new Error(`No conversation named ${name}`);
  return c.id;
}

function fakeIp(email: string): string {
  let h = 0;
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) % 250;
  return `10.0.0.${h + 1}`;
}
