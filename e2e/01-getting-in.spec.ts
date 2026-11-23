import { expect, test, type Page } from '@playwright/test';

import { ADMIN_EMAIL, codeFor, logSize } from './helpers';

const MEMBER_EMAIL = 'sam@e2e.test';

async function signInWithCode(page: Page, email: string) {
  const before = logSize();
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('Sign-in code').fill(await codeFor(email, before));
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe.configure({ mode: 'serial' });

test('the admin signs in, sets up the workspace and lands in the app', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole('heading', { name: 'Sign in to Huddle' })).toBeVisible();

  await page.getByLabel('Work email').fill(ADMIN_EMAIL);
  await signInWithCode(page, ADMIN_EMAIL);

  await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible();
  await page.getByLabel('Workspace name').fill('Acme Studio');
  await page.getByLabel('Your name').fill('Olive Owner');
  await page.getByRole('button', { name: 'Create workspace' }).click();

  const nav = page.getByRole('navigation', { name: 'Conversations' });
  await expect(nav.getByText('Acme Studio')).toBeVisible();
  await nav.getByRole('link', { name: 'general' }).click();
  await expect(page).toHaveURL(/\/c\//);
  await expect(page.getByRole('heading', { level: 1, name: 'general' })).toBeVisible();
});

test('a wrong code is refused and can be retried', async ({ page }) => {
  await page.goto('/signin');
  await page.getByLabel('Work email').fill(ADMIN_EMAIL);
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('Sign-in code').fill('000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('That code didn’t work');
  await expect(page.getByLabel('Sign-in code')).toBeFocused();
});

test('an invited teammate joins from the link and picks a name', async ({ browser, page }) => {
  // The owner signs in and creates the invitation.
  await page.goto('/signin');
  await page.getByLabel('Work email').fill(ADMIN_EMAIL);
  await signInWithCode(page, ADMIN_EMAIL);
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
  const res = await page.request.post('/api/invitations', {
    data: { email: MEMBER_EMAIL, role: 'member' },
    headers: { origin: 'http://localhost:8787' },
  });
  expect(res.status()).toBe(201);
  const { link } = (await res.json()) as { link: string };

  // The teammate opens it in a separate browser profile.
  const teammate = await (await browser.newContext()).newPage();
  await teammate.goto(new URL(link).pathname);
  await expect(teammate.getByRole('heading', { name: 'Join Acme Studio' })).toBeVisible();
  await expect(teammate.getByText('Olive Owner invited you')).toBeVisible();
  await expect(teammate.getByLabel('Work email')).toHaveValue(MEMBER_EMAIL);
  await signInWithCode(teammate, MEMBER_EMAIL);

  await expect(teammate.getByRole('heading', { name: 'What should people call you?' })).toBeVisible();
  await teammate.getByLabel('Your name').fill('Sam Member');
  await teammate.getByRole('button', { name: 'Continue' }).click();
  const nav = teammate.getByRole('navigation', { name: 'Conversations' });
  await expect(nav.getByText('Sam Member')).toBeVisible();
  await expect(nav.getByRole('link', { name: 'general' })).toBeVisible();

  // Signing out returns to the sign-in page, and the app is closed again.
  await teammate.getByRole('button', { name: 'Sign out' }).click();
  await expect(teammate).toHaveURL(/\/signin$/);
  await teammate.goto('/');
  await expect(teammate).toHaveURL(/\/signin$/);
});

test('a used or unknown invitation explains itself', async ({ page }) => {
  await page.goto('/invite/not-a-real-token');
  await expect(page.getByRole('heading', { name: 'This invitation can’t be used' })).toBeVisible();
});
