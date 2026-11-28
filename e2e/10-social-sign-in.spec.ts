import { expect, test, type Browser, type Page } from '@playwright/test';

// Google and GitHub themselves can't be driven from a test, so these cover everything on our side:
// each button appears only when the server says its provider is set up, it asks the server to start
// the sign-in, and a refused sign-in comes back with a clear message.
const ORIGIN = 'http://localhost:8790';

async function signedOut(browser: Browser) {
  const context = await browser.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
  return { context, page: await context.newPage() };
}

const withProviders = (page: Page, providers: { google: boolean; github: boolean }) =>
  page.route('**/api/email/status', (route) =>
    route.fulfill({ json: { ready: true, needsSetup: false, ...providers } }),
  );

test('no provider buttons until Google or GitHub is set up', async ({ browser }) => {
  const { context, page } = await signedOut(browser);
  await page.goto('/signin');
  await expect(page.getByLabel('Work email')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toHaveCount(0);
  await context.close();
});

test('the buttons show on the authenticator screen when email is not set up', async ({ browser }) => {
  const { context, page } = await signedOut(browser);
  // Like a Huddle without Gmail: the page opens on the authenticator app, not the emailed code.
  await page.route('**/api/email/status', (route) =>
    route.fulfill({ json: { ready: false, needsSetup: false, google: true, github: true } }),
  );
  await page.goto('/signin');
  await expect(page.getByLabel('Code from your authenticator app')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
  await context.close();
});

test('each button shows only for its own provider', async ({ browser }) => {
  const { context, page } = await signedOut(browser);
  await withProviders(page, { google: false, github: true });
  await page.goto('/signin');
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
  await context.close();
});

for (const [provider, label] of [
  ['google', 'Continue with Google'],
  ['github', 'Continue with GitHub'],
] as const) {
  test(`the ${provider} button starts sign-in and follows the address the server returns`, async ({
    browser,
  }) => {
    const { context, page } = await signedOut(browser);
    await withProviders(page, { google: true, github: true });
    let body: unknown = null;
    await page.route('**/api/auth/sign-in/social', (route) => {
      body = route.request().postDataJSON();
      return route.fulfill({ json: { url: '/signin?error=access_denied', redirect: true } });
    });
    await page.goto('/signin?next=/c/abc');
    await page.getByRole('button', { name: label }).click();
    await expect(page).toHaveURL(/error=access_denied/);
    expect(body).toEqual({
      provider,
      callbackURL: '/c/abc',
      errorCallbackURL: '/signin?next=%2Fc%2Fabc',
    });
    // Cancelling at the provider is not an error worth shouting about.
    await expect(page.getByRole('alert')).toHaveCount(0);
    await context.close();
  });
}

test('an email that was not invited gets a clear message, never text from the address bar', async ({
  browser,
}) => {
  const { context, page } = await signedOut(browser);
  await withProviders(page, { google: true, github: false });
  await page.goto('/signin?error=NOT_INVITED&error_description=Send%20money%20to%20me');
  await expect(page.getByText('hasn’t been invited to this workspace')).toBeVisible();
  await expect(page.getByText('Send money')).toHaveCount(0);
  await context.close();
});

test('a deactivated account, a missing email and an unknown failure each say so', async ({ browser }) => {
  const { context, page } = await signedOut(browser);
  await withProviders(page, { google: false, github: true });
  await page.goto('/signin?error=ACCOUNT_DEACTIVATED');
  await expect(page.getByText('This account has been deactivated')).toBeVisible();
  await page.goto('/signin?error=email_not_found');
  await expect(page.getByText('didn’t share a verified email address')).toBeVisible();
  await page.goto('/signin?error=something_else');
  await expect(page.getByText('That sign-in didn’t work')).toBeVisible();
  await context.close();
});
