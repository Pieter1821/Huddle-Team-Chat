import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ORIGIN, signInOwner } from './helpers';

/** What a phone's authenticator app computes (RFC 6238), from the key shown under "Can't scan?". */
function totp(key: string, step = Math.floor(Date.now() / 30_000)) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of key.replace(/\s+/g, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', bytes).update(counter).digest();
  const o = mac[19]! & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Scans (reads the key) and confirms with the current code. Returns the key. */
async function scanAndConfirm(page: Page) {
  await page.getByText('Can’t scan? Enter this key instead').click();
  const key = (await page.locator('p.font-mono').innerText()).trim();
  await page.getByLabel('6-digit code').fill(totp(key));
  await page.getByRole('button', { name: 'Confirm' }).click();
  return key;
}

const SESSION = '.wrangler/e2e/totp-session.json';
test.beforeAll(async ({ browser }) => {
  if (existsSync(SESSION)) return;
  const context = await browser.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
  await signInOwner(await context.newPage());
  await context.storageState({ path: SESSION });
  await context.close();
});

test('set up the app in Settings, then sign in with it on another device', async ({ browser }) => {
  const owner = await browser.newContext({ baseURL: ORIGIN, storageState: SESSION });
  const page = await owner.newPage();
  await page.goto('/settings');
  const card = page
    .locator('section, div')
    .filter({ has: page.getByRole('heading', { name: 'Authenticator app' }) })
    .last();
  await card.getByRole('button', { name: 'Set up' }).click();
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  const key = await scanAndConfirm(page);
  await expect(page.getByText('Your authenticator app is set up.')).toBeVisible();
  await owner.close();

  // A new device: the app's next code signs in (the current one was used to confirm).
  const fresh = await browser.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
  const p2 = await fresh.newPage();
  await p2.goto('/signin');
  await p2.getByRole('button', { name: 'Use an authenticator app instead' }).click();
  await p2.getByLabel('Work email').fill('owner@e2e.test');
  await p2
    .getByLabel('Code from your authenticator app')
    .fill(totp(key, Math.floor(Date.now() / 30_000) + 1));
  await p2.getByRole('button', { name: 'Sign in' }).click();
  await expect(p2.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
  await fresh.close();
});

test('join from an invitation with only an authenticator app', async ({ browser }) => {
  const owner = await browser.newContext({ baseURL: ORIGIN, storageState: SESSION });
  const inv = await owner.request.post('/api/invitations', {
    data: { email: 'app.only@e2e.test', role: 'member' },
    headers: { origin: ORIGIN },
  });
  const { link } = (await inv.json()) as { link: string };
  await owner.close();

  const guest = await browser.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
  const page = await guest.newPage();
  await page.goto(new URL(link).pathname);
  await page.getByRole('button', { name: 'Use an authenticator app instead' }).click();
  await scanAndConfirm(page);
  // Signed in: a new member is asked for their name first.
  await expect(page.getByRole('heading', { name: 'What should people call you?' })).toBeVisible();
  await guest.close();
});

test('owner recovery is not offered on the sign-in page, only at its private address', async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/signin');
  await page.getByRole('button', { name: 'Use an authenticator app instead' }).click();
  await expect(page.getByLabel('Code from your authenticator app')).toBeVisible();
  await expect(page.getByText(/setup key/i)).toHaveCount(0);
  await page.goto('/signin?owner=recover');
  await expect(page.getByLabel('Setup key')).toBeVisible();
  await context.close();
});
