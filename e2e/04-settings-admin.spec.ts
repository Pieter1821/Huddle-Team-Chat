import { expect, test } from '@playwright/test';
import { ORIGIN, addMember, conversationId, signInOwner } from './helpers';

test('your settings, admin tools and conversation details', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  const nina = await (await browser.newContext()).newPage();
  await signInOwner(owner);
  const ninaId = await addMember(owner, nina, 'nina@e2e.test', 'Nina Member');

  // Your settings: email summaries and a pause, each saved as you change it.
  await owner.goto('/settings');
  await owner.getByLabel('Email summary').selectOption('daily');
  await expect(owner.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await owner.getByRole('button', { name: '1 hour' }).click();
  await expect(owner.getByText(/Paused until/)).toBeVisible();
  await owner.reload();
  await expect(owner.getByLabel('Email summary')).toHaveValue('daily');
  await owner.getByRole('button', { name: 'Resume now' }).click();
  await expect(owner.getByRole('button', { name: '1 hour' })).toBeVisible();

  // Admin › People: invite by link (no email service locally), then withdraw it.
  await owner.goto('/admin');
  await expect(owner).toHaveURL(/\/admin\/people$/);
  await owner.getByLabel('Email').fill('ria@e2e.test');
  await owner.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.getByLabel('Invitation link')).toHaveValue(/\/invite\//);
  await owner.getByRole('button', { name: 'Withdraw the invitation for ria@e2e.test' }).click();
  await expect(owner.getByText('ria@e2e.test')).toBeHidden();

  // Change a role, then deactivate (with confirmation) and reactivate.
  await owner.getByLabel('Role for Nina Member').selectOption('admin');
  await expect(owner.getByText('Nina Member is now admin.')).toBeVisible();
  const ninaRow = owner.getByRole('listitem').filter({ hasText: 'nina@e2e.test' });
  await ninaRow.getByRole('button', { name: 'Deactivate' }).click();
  await owner.getByRole('alertdialog').getByRole('button', { name: 'Deactivate' }).click();
  await expect(ninaRow.getByText('Deactivated')).toBeVisible();
  expect((await nina.request.get('/api/me')).status()).toBe(401); // signed out everywhere
  await ninaRow.getByRole('button', { name: 'Reactivate' }).click();
  await expect(owner.getByText('Nina Member can sign in again.')).toBeVisible();

  // Admin › Workspace: a too-dark colour is caught before saving; a readable one applies at once.
  await owner.getByRole('link', { name: 'Workspace' }).click();
  const hex = owner.getByLabel('Colour code');
  await hex.fill('#333333');
  await expect(owner.getByText(/Too dark/)).toBeVisible();
  await expect(owner.getByRole('button', { name: 'Save colour' })).toBeDisabled();
  await hex.fill('#ffb020');
  await owner.getByRole('button', { name: 'Save colour' }).click();
  await expect
    .poll(() => owner.evaluate<string>("document.documentElement.style.getPropertyValue('--huddle-accent')"))
    .toBe('#ffb020');
  await owner.getByRole('button', { name: 'Use Huddle’s default' }).click();
  await expect(hex).toHaveValue('#00b18c');

  // Admin › Email: not connected on this test server (it prints emails), with the setup steps and
  // the exact redirect address to paste into Google.
  await owner.getByRole('link', { name: 'Email' }).click();
  await expect(owner.getByText('Not connected. On this computer')).toBeVisible();
  await expect(owner.getByRole('link', { name: 'Connect Gmail' })).toBeHidden(); // no Gmail client set here
  await expect(owner.getByText('http://localhost:8790/api/email/google/callback')).toBeVisible();

  // Admin › Webhooks: the URL is shown once and really posts into the channel.
  await owner.getByRole('link', { name: 'Webhooks' }).click();
  await owner.getByLabel('Channel', { exact: true }).selectOption({ label: '#general' });
  await owner.getByLabel('Name shown on its messages').fill('Deploy bot');
  await owner.getByRole('button', { name: 'Create webhook' }).click();
  const url = await owner.getByLabel('Webhook URL').inputValue();
  const posted = await owner.request.post(new URL(url).pathname, { data: { text: 'Build 512 passed' } });
  expect(posted.ok()).toBe(true);
  await owner.getByRole('button', { name: 'Revoke Deploy bot' }).click();
  await owner.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(owner.getByText('None yet.')).toBeVisible();
  expect((await owner.request.post(new URL(url).pathname, { data: { text: 'again' } })).ok()).toBe(false);

  // Security log and usage.
  await owner.getByRole('link', { name: 'Security log' }).click();
  await expect(owner.getByRole('cell', { name: 'Deactivated someone' })).toBeVisible();
  await expect(owner.getByRole('cell', { name: 'Revoked a webhook' })).toBeVisible();
  await expect(owner.getByRole('cell', { name: 'colour: #ffb020 → default' })).toBeVisible();
  await owner.getByRole('link', { name: 'Usage' }).click();
  await expect(owner.getByRole('meter', { name: 'Database' })).toBeVisible();

  // The webhook's message shows in #general as an app.
  const general = await conversationId(owner, 'general');
  await owner.goto(`/c/${general}`);
  const botMessage = owner.getByRole('article').filter({ hasText: 'Build 512 passed' });
  await expect(botMessage.getByText('Deploy bot')).toBeVisible();
  await expect(botMessage.getByText('App', { exact: true })).toBeVisible();

  // Conversation details: topic, notifications, members, leave.
  const created = await owner.request.post('/api/conversations', {
    data: { name: 'ops', kind: 'public' },
    headers: { origin: ORIGIN },
  });
  const ops = ((await created.json()) as { conversation: { id: string } }).conversation.id;
  await owner.request.post(`/api/conversations/${ops}/members`, {
    data: { userIds: [ninaId] },
    headers: { origin: ORIGIN },
  });
  await owner.goto(`/c/${ops}`);
  await owner.getByRole('button', { name: 'Details: 2 members' }).click();
  const details = owner.getByRole('dialog', { name: '#ops' });
  await details.getByLabel('Topic').fill('Incidents and on-call');
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(details.getByText('Saved')).toBeVisible();
  await details.getByText('Muted').click();
  await expect(details.getByRole('radio', { name: /Muted/ })).toBeChecked();
  await expect(details.getByText('Nina Member')).toBeVisible();
  await details.getByRole('button', { name: 'Leave channel' }).click();
  await owner.getByRole('alertdialog').getByRole('button', { name: 'Leave' }).click();
  await expect(owner).toHaveURL(/\/$/);
  await expect(
    owner.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /^ops/ }),
  ).toBeHidden();
});
