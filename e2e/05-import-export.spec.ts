import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { signInOwner } from './helpers';

const json = (v: unknown) => strToU8(JSON.stringify(v));

/** A small Slack export in Slack's documented layout, inside a top-level folder like real ones. */
function slackZip() {
  const root = 'Acme Slack export Mar 1 2024 - Mar 3 2024/';
  return Buffer.from(
    zipSync({
      [`${root}users.json`]: json([
        { id: 'U01ALEX', name: 'alex', real_name: 'Alex Archer', profile: { email: 'alex@old-team.test' } },
        { id: 'U02BEA', name: 'bea', real_name: 'Bea Brand', profile: { email: 'bea@old-team.test' } },
      ]),
      [`${root}channels.json`]: json([
        {
          id: 'C01ROAD',
          name: 'roadmap',
          members: ['U01ALEX', 'U02BEA'],
          topic: { value: 'What we ship next' },
        },
      ]),
      [`${root}dms.json`]: json([{ id: 'D01AB', members: ['U01ALEX', 'U02BEA'] }]),
      [`${root}roadmap/2024-03-01.json`]: json([
        {
          ts: '1709287200.000100',
          user: 'U01ALEX',
          text: 'Q2 plan is *ready* for review <@U02BEA>',
          thread_ts: '1709287200.000100',
          reactions: [{ name: 'tada', users: ['U02BEA'], count: 1 }],
        },
        { ts: '1709287260.000200', user: 'U02BEA', text: 'Reading it now', thread_ts: '1709287200.000100' },
        { ts: '1709287300.000300', user: 'U02BEA', subtype: 'channel_join', text: 'has joined' },
      ]),
      [`${root}D01AB/2024-03-02.json`]: json([
        { ts: '1709373600.000100', user: 'U01ALEX', text: 'Private hello' },
      ]),
    }),
  );
}

test('import a Slack export, then export the workspace', async ({ page }) => {
  await signInOwner(page);
  await page.goto('/admin/import');
  await page
    .getByLabel('Slack export zip')
    .setInputFiles({ name: 'slack-export.zip', mimeType: 'application/zip', buffer: slackZip() });

  // The preview counts what's inside before anything is sent.
  await expect(page.getByRole('heading', { name: 'Ready to import' })).toBeVisible();
  await expect(page.getByText('Messages', { exact: true }).locator('..')).toContainText('4');
  await page.getByLabel('Copy files from Slack').uncheck();
  await page.getByRole('button', { name: 'Start import' }).click();
  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible();
  await expect(page.getByText(/1 skipped/)).toBeVisible(); // the channel_join housekeeping message

  // The channel arrives with its topic, the formatted message, the mention by name, reaction and thread.
  await page
    .getByRole('navigation', { name: 'Conversations' })
    .getByRole('link', { name: /roadmap/ })
    .click();
  await expect(page.getByText('What we ship next').first()).toBeVisible();
  const plan = page.getByRole('article').filter({ hasText: 'Q2 plan is' });
  await expect(plan.getByText('Alex Archer')).toBeVisible();
  await expect(plan.locator('strong', { hasText: 'ready' })).toBeVisible();
  await expect(plan.getByText('@Bea Brand')).toBeVisible();
  await expect(plan.getByRole('button', { name: /🎉 1/ })).toBeVisible();
  await plan.getByRole('button', { name: '1 reply' }).click();
  await expect(page.getByRole('complementary', { name: 'Thread' }).getByText('Reading it now')).toBeVisible();

  // Running the same import again adds nothing (everything is recognised as already imported).
  await page.goto('/admin/import');
  await page
    .getByLabel('Slack export zip')
    .setInputFiles({ name: 'slack-export.zip', mimeType: 'application/zip', buffer: slackZip() });
  await page.getByLabel('Copy files from Slack').uncheck();
  await page
    .getByRole('button', { name: /import/i })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible();
  await expect(page.getByText(/4 skipped/)).toBeVisible();

  // Export: the owner downloads a zip holding the workspace and the imported channel's messages.
  await page.goto('/admin/export');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download export' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^huddle-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const entries = unzipSync(new Uint8Array(readFileSync(await file.path())));
  const manifest = JSON.parse(new TextDecoder().decode(entries['huddle-export.json'])) as {
    format: string;
    includesDirectMessages: boolean;
  };
  expect(manifest).toMatchObject({ format: 'huddle-export', includesDirectMessages: false });
  const roadmap = JSON.parse(new TextDecoder().decode(entries['conversations/roadmap.json'])) as {
    messages: { body: string }[];
  };
  expect(roadmap.messages.map((m) => m.body)).toEqual(
    expect.arrayContaining(['Reading it now', expect.stringContaining('Q2 plan')]),
  );
  expect(Object.keys(entries).some((k) => k.startsWith('conversations/dm-'))).toBe(false); // no DMs by default

  await page.getByRole('link', { name: 'Security log' }).click();
  await expect(page.getByRole('cell', { name: 'Exported data' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Finished a Slack import' }).first()).toBeVisible();
});
