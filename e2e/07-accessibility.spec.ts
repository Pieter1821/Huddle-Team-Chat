import { existsSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ORIGIN, addMember, conversationId, signInOwner } from './helpers';

// Every screen and dialog is checked against WCAG 2.2 A and AA with axe. Automated checks catch
// only part of what matters (keyboard flow and screen-reader wording are tested separately), but
// they stop the measurable problems from ever coming back.
const SESSION = '.wrangler/e2e/a11y-session.json';
let n = 0;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

test.beforeAll(async ({ browser }) => {
  if (existsSync(SESSION)) return;
  const context = await browser.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
  await signInOwner(await context.newPage());
  await context.storageState({ path: SESSION });
  await context.close();
});

/** Runs axe on the page as it is now; returns readable lines for any violation. */
async function audit(page: Page, screen: string): Promise<string[]> {
  // Wait for transitions to settle so colours are measured at their final values.
  await page.waitForTimeout(250);
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return violations.flatMap((v) =>
    v.nodes.map(
      (n) =>
        `[${screen}] ${v.id} (${v.impact}): ${v.help} → ${n.target.join(' ')} ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`,
    ),
  );
}

test('signed out: the sign-in screen', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/signin');
  await expect(page.getByRole('heading').first()).toBeVisible();
  const problems = await audit(page, 'sign-in');
  await page.getByLabel(/email/i).fill('nobody@e2e.test');
  await page.getByRole('button', { name: /code/i }).click();
  await expect(page.getByLabel(/code/i).first()).toBeVisible();
  problems.push(...(await audit(page, 'sign-in code')));
  await context.close();
  expect(problems, problems.join('\n')).toEqual([]);
});

test('fresh install: the owner sets up with the setup key and an authenticator app', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  // A real server with no email set up (this test server prints emails, so it reports ready).
  await page.route('**/api/email/status', (route) =>
    route.fulfill({ json: { ready: false, needsSetup: true } }),
  );
  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Set up Huddle' })).toBeVisible();
  await expect(page.getByLabel('Setup key')).toBeVisible();
  const problems = await audit(page, 'owner setup');
  await context.close();
  expect(problems, problems.join('\n')).toEqual([]);
});

test('privacy policy and terms are public, linked from sign-in, and accessible', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/signin');
  const legal = page.getByRole('navigation', { name: 'Legal' });
  await legal.getByRole('link', { name: 'Privacy policy' }).click();
  await expect(page.getByRole('heading', { name: 'Privacy policy', level: 1 })).toBeVisible();
  await expect(page.getByText('It never reads, stores or deletes mail', { exact: false })).toBeVisible();
  const problems = await audit(page, 'privacy policy');
  await page.getByRole('link', { name: 'Terms of use' }).click();
  await expect(page.getByRole('heading', { name: 'Terms of use', level: 1 })).toBeVisible();
  problems.push(...(await audit(page, 'terms')));
  await context.close();
  expect(problems, problems.join('\n')).toEqual([]);
});

test.describe('signed in', () => {
  test.use({ storageState: SESSION });

  test('chat, thread, dialogs and details', async ({ page }) => {
    const problems: string[] = [];
    const id = await conversationId(page, 'general');
    const post = async (body: string, extra: Record<string, unknown> = {}) => {
      const res = await page.request.post(`/api/conversations/${id}/messages`, {
        data: { body, clientMsgId: `a11y-${Date.now()}-${n++}`, ...extra },
        headers: { origin: ORIGIN },
      });
      expect(res.ok(), await res.text()).toBe(true);
      return res;
    };
    const release = `Release notes ${Date.now()}`;
    const parent = (await (
      await post(`**${release}** for _Friday_, see \`v2.1\`
> quoted line`)
    ).json()) as {
      message: { id: string };
    };
    await post('Thread reply with a link https://example.com', { parentId: parent.message.id });

    await page.goto(`/c/${id}`);
    await expect(page.getByRole('article').filter({ hasText: release })).toBeVisible();
    problems.push(...(await audit(page, 'conversation')));

    await page.getByRole('article').filter({ hasText: release }).hover();
    problems.push(...(await audit(page, 'message toolbar')));

    await page.goto(`/c/${id}/t/${parent.message.id}`);
    await expect(page.getByRole('complementary', { name: 'Thread' })).toBeVisible();
    problems.push(...(await audit(page, 'thread')));

    await page.goto(`/c/${id}`);
    await page.getByRole('button', { name: /^Details/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    problems.push(...(await audit(page, 'details dialog')));
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.type('release');
    await page.waitForTimeout(600);
    problems.push(...(await audit(page, 'search dialog')));
    await page.keyboard.press('Escape');

    for (const [button, screen] of [
      ['Add a channel', 'browse channels dialog'],
      ['New message', 'new message dialog'],
    ] as const) {
      await page.getByRole('button', { name: button }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      problems.push(...(await audit(page, screen)));
      await page.keyboard.press('Escape');
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    problems.push(...(await audit(page, 'phone: conversation list')));
    await page.goto(`/c/${id}`);
    problems.push(...(await audit(page, 'phone: conversation')));

    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('settings and every admin section', async ({ page }) => {
    const problems: string[] = [];
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
    problems.push(...(await audit(page, 'settings')));
    for (const section of [
      'people',
      'workspace',
      'email',
      'webhooks',
      'security',
      'usage',
      'import',
      'export',
    ]) {
      await page.goto(`/admin/${section}`);
      await expect(page.getByRole('navigation', { name: 'Admin sections' })).toBeVisible();
      await page.waitForLoadState('networkidle');
      problems.push(...(await audit(page, `admin ${section}`)));
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('keyboard and screen reader: one tab stop for the history, arrows inside, arrivals announced', async ({
    page,
    browser,
  }) => {
    const id = await conversationId(page, 'general');
    for (let i = 1; i <= 30; i++) {
      await page.request.post(`/api/conversations/${id}/messages`, {
        data: { body: `History line ${i}`, clientMsgId: `kb-${Date.now()}-${n++}` },
        headers: { origin: ORIGIN },
      });
    }
    await page.goto(`/c/${id}`);
    const box = page.getByRole('textbox', { name: 'Message #general' });
    await expect(box).toBeVisible();
    await expect(page).toHaveTitle(/^#general · /);

    // The skip link is the first thing Tab reaches on the page, shows itself, and lands past the sidebar.
    const firstStop = await page.evaluate(
      `[...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]')]
        .find((el) => el.tabIndex >= 0 && !el.disabled)?.textContent`,
    );
    expect(firstStop).toBe('Skip to conversation');
    const skip = page.getByRole('link', { name: 'Skip to conversation' });
    await skip.focus();
    await expect(skip).toBeInViewport();
    await skip.press('Enter');
    await expect(page.locator('#main')).toBeFocused();

    // Thirty messages are ONE tab stop: Tab reaches the newest, arrows move, Escape returns.
    const messages = page.getByRole('region', { name: 'Messages' }).getByRole('article');
    expect(await page.locator('section[aria-label="Messages"] article[tabindex="0"]').count()).toBe(1);
    await box.focus();
    await page.keyboard.press('Shift+Tab');
    const newest = messages.last();
    await expect(newest).toBeFocused();
    await expect(newest).toContainText('History line 30');
    await page.keyboard.press('ArrowUp');
    await expect(messages.filter({ hasText: 'History line 29' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(messages.first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(newest).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Escape');
    await expect(box).toBeFocused();
    // Coming back with Shift+Tab returns to the message you were on, not the newest.
    await page.keyboard.press('Shift+Tab');
    await expect(messages.filter({ hasText: 'History line 29' })).toBeFocused();

    // Someone else's message is announced; the browser tab counts a new direct message.
    const context = await browser.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
    const kai = await context.newPage();
    const kaiId = await addMember(page, kai, 'kai.a11y@e2e.test', 'Kai Keys');
    await kai.request.post(`/api/conversations/${id}/join`, { data: {}, headers: { origin: ORIGIN } });
    await kai.request.post(`/api/conversations/${id}/messages`, {
      data: { body: 'Hello from **Kai**', clientMsgId: `kb-kai-${n++}` },
      headers: { origin: ORIGIN },
    });
    await expect(page.locator('[aria-live="polite"].sr-only')).toHaveText('Kai Keys: Hello from Kai');
    const ownerId = ((await (await page.request.get('/api/me')).json()) as { user: { id: string } }).user.id;
    const dm = (await (
      await kai.request.post('/api/conversations/dm', {
        data: { userIds: [ownerId] },
        headers: { origin: ORIGIN },
      })
    ).json()) as { conversation: { id: string } };
    await kai.request.post(`/api/conversations/${dm.conversation.id}/messages`, {
      data: { body: 'Quick question', clientMsgId: `kb-dm-${n++}` },
      headers: { origin: ORIGIN },
    });
    await expect(page).toHaveTitle(/^\(1\) #general · /);
    expect(kaiId).toBeTruthy();
    await context.close();
  });
});
