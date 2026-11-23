import { expect, test, type Page } from '@playwright/test';
import { addMember, signInOwner } from './helpers';

// A valid 2x2 PNG, so the server's type sniffing recognises it as an image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);

const log = (page: Page) => page.getByRole('log', { name: 'Messages' });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Conversations' });

test('channels, threads with mentions, files, search and direct messages', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  const lee = await (await browser.newContext()).newPage();
  await signInOwner(owner);
  await addMember(owner, lee, 'lee@e2e.test', 'Lee Member');

  // The owner creates a channel from the sidebar.
  await owner.goto('/');
  await nav(owner).getByRole('button', { name: 'Add a channel' }).click();
  await owner
    .getByRole('dialog', { name: 'Browse channels' })
    .getByRole('button', { name: 'Create a channel' })
    .click();
  await owner.getByLabel('Name').fill('Launch Plans');
  await expect(owner.getByText('Will be created as #launch-plans')).toBeVisible();
  await owner.getByRole('button', { name: 'Create channel' }).click();
  await expect(owner.getByRole('heading', { level: 1, name: 'launch-plans' })).toBeVisible();

  // Lee finds it by browsing and joins.
  await lee.goto('/');
  await nav(lee).getByRole('button', { name: 'Add a channel' }).click();
  await lee.getByRole('button', { name: 'Join #launch-plans' }).click();
  await expect(lee.getByRole('heading', { level: 1, name: 'launch-plans' })).toBeVisible();
  const leeBox = lee.getByRole('textbox', { name: 'Message #launch-plans' });
  await expect(leeBox).toBeVisible();

  // The owner posts; Lee replies in a thread, mentioning the owner from the @ list.
  const ownerBox = owner.getByRole('textbox', { name: 'Message #launch-plans' });
  await ownerBox.click();
  await owner.keyboard.type('Kickoff is Monday');
  await owner.keyboard.press('Enter');
  const kickoff = log(lee).getByRole('article').filter({ hasText: 'Kickoff is Monday' });
  await kickoff.hover();
  await kickoff.getByRole('button', { name: 'Reply in thread' }).click();
  const thread = lee.getByRole('complementary', { name: 'Thread' });
  await expect(thread.getByText('Kickoff is Monday')).toBeVisible();
  const reply = thread.getByRole('textbox', { name: 'Reply…' });
  await reply.click();
  await lee.keyboard.type('@Oli');
  await expect(lee.getByRole('option', { name: 'Olive Owner' })).toHaveAttribute('aria-selected', 'true');
  await lee.keyboard.press('Enter');
  await lee.keyboard.type(' sounds good');
  await lee.keyboard.press('Enter');
  await expect(thread.getByRole('log', { name: 'Replies' }).getByText('sounds good')).toBeVisible();

  // The owner sees the reply count live and reads the thread, mention shown by name.
  await log(owner).getByRole('button', { name: '1 reply' }).click();
  const ownerThread = owner.getByRole('complementary', { name: 'Thread' });
  await expect(ownerThread.getByText('@Olive Owner')).toBeVisible();

  // A reply can also go to the channel.
  await thread.getByLabel('Also send to #launch-plans').check();
  await reply.click();
  await lee.keyboard.type('Booked the room');
  await lee.keyboard.press('Enter');
  await expect(log(owner).getByText('Booked the room')).toBeVisible();
  await expect(ownerThread.getByText('Booked the room')).toBeVisible();

  // The owner shares an image; it uploads, sends and shows inline for Lee.
  await owner
    .locator('input[type=file]')
    .first()
    .setInputFiles({ name: 'floorplan.png', mimeType: 'image/png', buffer: PNG });
  await expect(owner.getByText('Ready')).toBeVisible();
  await ownerBox.click();
  await owner.keyboard.type('Floor plan attached');
  await owner.keyboard.press('Enter');
  await expect(log(lee).getByRole('img', { name: 'floorplan.png' })).toBeVisible();
  const src = await log(lee).getByRole('img', { name: 'floorplan.png' }).getAttribute('src');
  const image = await lee.request.get(src!);
  expect(image.headers()['content-type']).toBe('image/png');

  // Ctrl+K search finds the message, highlights the match and opens the conversation.
  await lee.goto('/');
  await expect(nav(lee)).toBeVisible();
  await lee.keyboard.press('Control+k');
  const search = lee.getByRole('dialog', { name: 'Search' });
  await search.getByRole('searchbox').fill('kickoff');
  await expect(search.locator('mark', { hasText: 'Kickoff' })).toBeVisible();
  await search.getByRole('button', { name: /Kickoff is Monday/ }).click();
  await expect(lee.getByRole('heading', { level: 1, name: 'launch-plans' })).toBeVisible();

  // A direct message from the sidebar.
  await nav(owner).getByRole('button', { name: 'New message' }).click();
  const picker = owner.getByRole('dialog', { name: 'New message' });
  await picker.getByRole('checkbox', { name: /Lee Member/ }).click();
  await picker.getByRole('button', { name: 'Message' }).click();
  await expect(owner.getByRole('heading', { level: 1, name: 'Lee Member' })).toBeVisible();
  await expect(owner.getByRole('textbox', { name: 'Message Lee Member' })).toBeVisible();
});
