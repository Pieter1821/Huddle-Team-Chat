import { expect, test } from '@playwright/test';
import { addMember, signInOwner } from './helpers';

test('an owner lets members invite people, and a member invites a colleague', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  const maya = await (await browser.newContext()).newPage();
  await signInOwner(owner);
  await addMember(owner, maya, 'maya@e2e.test', 'Maya Member');

  // By default only owners and admins invite: a member has no link, and the page says why.
  await maya.goto('/');
  await expect(maya.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
  await expect(maya.getByRole('link', { name: 'Invite people' })).toHaveCount(0);
  await maya.goto('/invite');
  await expect(maya.getByText('Inviting people isn’t turned on for your role')).toBeVisible();

  // The owner turns it on in Admin › Workspace.
  await owner.goto('/admin/workspace');
  const setting = owner.getByLabel('Members can invite people');
  await setting.check();
  await expect(owner.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible();

  try {
    // The member now sees Invite people in the sidebar and can invite members and guests, not admins.
    await maya.goto('/');
    await maya.getByRole('link', { name: 'Invite people' }).click();
    await expect(maya).toHaveURL(/\/invite$/);
    await expect(maya.getByRole('heading', { name: 'Invite people' }).first()).toBeVisible();
    const role = maya.getByLabel('Role');
    await expect(role.locator('option')).toHaveText(['Member', 'Guest']);
    await maya.getByLabel('Email').fill('colleague@e2e.test');
    await maya.getByRole('button', { name: 'Send invitation' }).click();
    await expect(maya.getByLabel('Invitation link')).toHaveValue(/\/invite\//);
  } finally {
    // Leave the shared test server as it was found.
    await owner.reload();
    await owner.getByLabel('Members can invite people').uncheck();
    await expect(owner.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible();
  }

  // Turned off again, the link goes away.
  await maya.goto('/');
  await expect(maya.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
  await expect(maya.getByRole('link', { name: 'Invite people' })).toHaveCount(0);
});
