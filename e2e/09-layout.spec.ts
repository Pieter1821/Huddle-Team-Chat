import { expect, test, type Page } from '@playwright/test';
import { conversationId, signInOwner } from './helpers';

// The app fills the window and only its panels scroll. If anything made the page itself taller
// (e.g. hidden screen-reader text placed below a panel), the message box or the bottom of a panel
// would be pushed out of view.
const pageFits = (page: Page) =>
  page.evaluate(
    'document.documentElement.scrollHeight <= innerHeight && document.body.scrollHeight <= innerHeight',
  );

test('the page never grows taller than the window', async ({ page }) => {
  await signInOwner(page);
  const id = await conversationId(page, 'general');
  for (const [w, h] of [
    [1523, 700],
    [390, 700],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });

    await page.goto(`/c/${id}`);
    await page.getByRole('textbox', { name: 'Message #general' }).waitFor();
    expect(await pageFits(page), `chat ${w}x${h}`).toBe(true);

    await page.goto('/settings');
    await page.getByRole('button', { name: /^(Set up|Move to a new phone)$/ }).click();
    await page.getByRole('img', { name: /QR code/ }).waitFor();
    expect(await pageFits(page), `settings with authenticator setup ${w}x${h}`).toBe(true);

    await page.goto('/admin/people');
    await page.getByRole('navigation', { name: 'Admin sections' }).waitFor();
    expect(await pageFits(page), `admin ${w}x${h}`).toBe(true);
  }
});
