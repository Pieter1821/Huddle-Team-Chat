import { expect, test } from '@playwright/test';
import { ORIGIN, conversationId, signInOwner } from './helpers';

// One sign-in for the whole file (sign-in codes are rate limited per address), shared by every test.
const SESSION = '.wrangler/e2e/owner-session.json';
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await signInOwner(page);
  await context.storageState({ path: SESSION });
  await context.close();
});
test.use({ storageState: SESSION });

test('installable app: manifest, service worker and the offline page', async ({ page, context }) => {
  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  expect(await manifest.json()).toMatchObject({ name: 'Huddle', display: 'standalone', start_url: '/' });

  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
  const worker = await page.evaluate(
    'navigator.serviceWorker.ready.then((r) => r.active && r.active.scriptURL)',
  );
  expect(worker).toBe(`${ORIGIN}/sw.js`);

  // No network: a page load shows Huddle's own offline page instead of the browser's error.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'You’re offline' })).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('link', { name: 'Try again' }).click();
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
});

test('turn notifications on and off for this device', async ({ page, context }) => {
  await context.grantPermissions(['notifications'], { origin: ORIGIN });
  // Test browsers can't reach a real push service, so the browser's subscribe step is stood in for
  // with a real key pair; everything from there on (the API, validation, storage) is the real thing.
  await page.addInitScript({
    content: `
      let current = null;
      const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      PushManager.prototype.getSubscription = () => Promise.resolve(current);
      PushManager.prototype.subscribe = async (options) => {
        const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const p256dh = b64(await crypto.subtle.exportKey('raw', keys.publicKey));
        const auth = b64(crypto.getRandomValues(new Uint8Array(16)).buffer);
        const endpoint = 'https://fcm.googleapis.com/fcm/send/e2e-device';
        current = {
          endpoint,
          options: { applicationServerKey: options.applicationServerKey, userVisibleOnly: true },
          toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
          unsubscribe: () => { current = null; return Promise.resolve(true); },
        };
        return current;
      };`,
  });

  await page.goto('/settings');
  const toggle = page.getByRole('switch', { name: /Notifications on this device/ });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await toggle.click(); // the switch flips once the server has saved it
  await expect(toggle).toBeChecked();
  await expect(page.getByRole('button', { name: 'Send a test notification' })).toBeVisible();

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Send a test notification' })).toBeHidden();
});

test('a link to one message (from an email or a notification) opens its conversation', async ({ page }) => {
  const id = await conversationId(page, 'general');
  const sent = await page.request.post(`/api/conversations/${id}/messages`, {
    data: { body: 'Linked from a notification', clientMsgId: `e2e-link-${Date.now()}` },
    headers: { origin: ORIGIN },
  });
  const { message } = (await sent.json()) as { message: { id: string } };
  await page.goto(`/c/${id}/m/${message.id}`);
  await expect(page.getByRole('article').filter({ hasText: 'Linked from a notification' })).toBeVisible();
});
