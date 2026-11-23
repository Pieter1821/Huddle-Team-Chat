import { expect, test, type Page } from '@playwright/test';
import { ORIGIN, addMember, conversationId, signInOwner } from './helpers';

test.describe.configure({ mode: 'serial' });

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message #general' });
const log = (page: Page) => page.getByRole('region', { name: 'Messages' });

test('two people chat live: messages, typing, reactions, edits, deletes and badges', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  const kai = await (await browser.newContext()).newPage();
  await signInOwner(owner);
  const kaiId = await addMember(owner, kai, 'kai@e2e.test', 'Kai Member');
  const general = await conversationId(owner, 'general');

  await owner.goto(`/c/${general}`);
  await kai.goto(`/c/${general}`);
  await expect(composer(owner)).toBeVisible();
  await expect(composer(kai)).toBeVisible();

  // A formatted message appears for the sender at once and for the other person live.
  await composer(owner).click();
  await owner.keyboard.type('**Ship** it today');
  await owner.keyboard.press('Enter');
  await expect(log(owner).getByText('it today')).toBeVisible();
  await expect(log(kai).getByText('it today')).toBeVisible();
  await expect(log(kai).locator('strong', { hasText: 'Ship' })).toBeVisible();
  await expect(composer(owner)).toHaveText('');

  // Typing shows on the other side.
  await composer(kai).click();
  await kai.keyboard.type('On it');
  await expect(owner.getByText('Kai Member is typing…')).toBeVisible();
  await kai.keyboard.press('Enter');
  await expect(log(owner).getByText('On it')).toBeVisible();
  await expect(owner.getByText('Kai Member is typing…')).toBeHidden();

  // A reaction from Kai reaches the owner.
  const shipped = log(kai).getByRole('article').filter({ hasText: 'it today' });
  await shipped.hover();
  await shipped.getByRole('button', { name: 'Add reaction' }).click();
  await shipped.getByRole('button', { name: 'React with 🎉' }).click();
  await expect(log(owner).getByRole('button', { name: /🎉 1, from Kai Member/ })).toBeVisible();

  // Up arrow edits your last message; the edit shows for everyone.
  await composer(kai).click();
  await kai.keyboard.press('ArrowUp');
  const edit = kai.getByRole('textbox', { name: 'Edit message' });
  await expect(edit).toBeFocused();
  await edit.fill('On it, done by 3');
  await edit.press('Enter');
  await expect(log(owner).getByText('On it, done by 3')).toBeVisible();
  await expect(log(owner).getByText('(edited)')).toBeVisible();

  // Deleting removes it for everyone.
  const own = log(kai).getByRole('article').filter({ hasText: 'On it, done by 3' });
  await own.hover();
  await own.getByRole('button', { name: 'Delete message' }).click();
  await kai.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(log(owner).getByText('On it, done by 3')).toBeHidden();

  // Away from the channel, a mention lights up Kai's sidebar live.
  await kai.goto('/');
  const res = await owner.request.post(`/api/conversations/${general}/messages`, {
    data: { body: `<@${kaiId}> can you check the build?`, clientMsgId: 'e2e-mention-0001' },
    headers: { origin: ORIGIN },
  });
  expect(res.status()).toBe(201);
  const link = kai.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /general/ });
  await expect(link).toHaveAccessibleName('general (1 mention)');

  // Opening it shows the "New" marker, the mention by name, and clears the badge; the server
  // remembers, so it stays cleared after a reload.
  await link.click();
  await expect(kai.getByRole('separator', { name: 'New' })).toBeVisible();
  await expect(log(kai).getByText('@Kai Member')).toBeVisible();
  await expect(link).toHaveAccessibleName('general');
  await kai.goto('/');
  await expect(link).toHaveAccessibleName('general');
});
