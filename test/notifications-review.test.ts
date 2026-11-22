// One test per point from the PR #1 review; each fails against the code before the fixes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { getConfig } from '../src/worker/config';
import { getDb } from '../src/worker/db/client';
import { cleanup } from '../src/worker/jobs';
import { sign, verify } from '../src/worker/lib/crypto';
import { reserveEmailSlot, sendEmail } from '../src/worker/lib/email';
import {
  UNSUBSCRIBE_PURPOSE,
  buildDigest,
  dueUsers,
  scheduleDigests,
  sendDigest,
  unsubscribeUrl,
} from '../src/worker/modules/notifications/digest';
import { addMember, api, captureEmails, resetDb, setupWorkspace } from './helpers';

const db = getDb(env);
const config = getConfig(env);
const HOUR = 3_600_000;

let n = 0;
const post = (cookie: string, id: string, body: string) =>
  api(`/api/conversations/${id}/messages`, {
    body: { body, clientMsgId: `rv-${Date.now()}-${n++}` },
    cookie,
  });
const age = (hours: number) =>
  env.DB.prepare('UPDATE notification SET created_at = created_at - ?')
    .bind(hours * HOUR)
    .run();
const today = () => new Date().toISOString().slice(0, 10);
const setUsage = (sent: number) =>
  env.DB.prepare(
    'INSERT INTO email_usage (day, sent) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET sent = excluded.sent',
  )
    .bind(today(), sent)
    .run();
const usage = async () =>
  (await env.DB.prepare('SELECT sent FROM email_usage WHERE day = ?').bind(today()).first<{ sent: number }>())
    ?.sent ?? 0;
const pendingCount = async () =>
  (
    await env.DB.prepare('SELECT count(*) AS n FROM notification WHERE emailed_at IS NULL').first<{
      n: number;
    }>()
  )?.n;

async function team() {
  const owner = await setupWorkspace();
  const jaco = await addMember(owner.cookie, 'jaco@example.com', 'member');
  const ch = (
    await api('/api/conversations', { body: { name: 'project', kind: 'public' }, cookie: owner.cookie })
  ).json.conversation.id as string;
  await api(`/api/conversations/${ch}/join`, { body: {}, cookie: jaco.cookie });
  const mention = (text: string) => post(owner.cookie, ch, `<@${jaco.userId}> ${text}`);
  return { owner, jaco, ch, mention };
}

beforeEach(resetDb);

describe('1 and 6: the email budget', () => {
  it('gives the last slot to exactly one of two racing senders', async () => {
    await setUsage(79);
    const [a, b] = await Promise.all([reserveEmailSlot(db, 80), reserveEmailSlot(db, 80)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await usage()).toBe(80);
  });

  it('counts before sending and gives the slot back when the send fails', async () => {
    await setUsage(10);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('mail server down');
    });
    await expect(
      sendEmail(config, { to: 'a@b.c', subject: 's', text: 't', html: 'h' }, db, 80),
    ).rejects.toThrow();
    warn.mockRestore();
    expect(await usage()).toBe(10);
  });
});

describe('2: only emailed notifications are marked', () => {
  it('leaves muted ones pending, and includes them once unmuted', async () => {
    const t = await team();
    const other = (
      await api('/api/conversations', { body: { name: 'other', kind: 'public' }, cookie: t.owner.cookie })
    ).json.conversation.id as string;
    await api(`/api/conversations/${other}/join`, { body: {}, cookie: t.jaco.cookie });
    const level = (id: string, value: string) =>
      api(`/api/conversations/${id}/notifications`, {
        method: 'PATCH',
        body: { level: value },
        cookie: t.jaco.cookie,
      });
    await level(other, 'muted');
    await post(t.owner.cookie, other, `<@${t.jaco.userId}> in the muted channel`);
    await t.mention('in the normal channel');
    await age(3);

    const mail = captureEmails();
    expect(await sendDigest(db, config, t.jaco.userId)).toBe('sent');
    mail.restore();
    expect(await pendingCount()).toBe(1); // the muted one, untouched

    await level(other, 'all');
    const { email } = await buildDigest(db, config, t.jaco.userId, new Date());
    expect(email?.text).toContain('in the muted channel');
  });

  it('never schedules someone whose only notifications are muted (no empty jobs)', async () => {
    const t = await team();
    await api(`/api/conversations/${t.ch}/notifications`, {
      method: 'PATCH',
      body: { level: 'muted' },
      cookie: t.jaco.cookie,
    });
    await t.mention('muted');
    await age(3);
    expect(await dueUsers(db, new Date())).toEqual([]);
  });

  it('never reaches back more than 7 days', async () => {
    const t = await team();
    await t.mention('ancient');
    await age(8 * 24);
    expect(await dueUsers(db, new Date())).toEqual([]);
  });
});

describe('3: over budget', () => {
  it('leaves notifications pending, and the next day schedules them again', async () => {
    const t = await team();
    await t.mention('ping');
    await age(3);
    await setUsage(80);
    expect(await sendDigest(db, config, t.jaco.userId)).toBe('over_budget');
    expect(await pendingCount()).toBe(1);

    const enqueue = vi.fn(async () => {});
    expect(await scheduleDigests(db, enqueue, new Date(Date.now() + 24 * HOUR))).toBe(1);
    expect(enqueue).toHaveBeenCalledWith([{ userId: t.jaco.userId }]);
  });
});

describe('4: unsubscribe links', () => {
  it('expire, and the expiry cannot be edited', async () => {
    const t = await team();
    const old = new URL(await unsubscribeUrl(config, t.jaco.userId, new Date(Date.now() - 100 * 24 * HOUR)));
    expect((await api(`${old.pathname}${old.search}`, {})).status).toBe(410);

    const fresh = new URL(await unsubscribeUrl(config, t.jaco.userId));
    fresh.searchParams.set('e', String(Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600));
    expect((await api(`${fresh.pathname}${fresh.search}`, {})).status).toBe(404);
  });

  it('are signed with a purpose-only key: a signature for another purpose does not work', async () => {
    const sig = await sign(config.authSecret, 'some-other-purpose', 'u.1');
    expect(await verify(config.authSecret, UNSUBSCRIBE_PURPOSE, 'u.1', sig)).toBe(false);
    expect(await verify(config.authSecret, 'some-other-purpose', 'u.1', sig)).toBe(true);
  });
});

describe('5: cleanup order', () => {
  it('removes the rows even if deleting the stored objects fails (worst case: a leaked object)', async () => {
    const t = await team();
    await env.DB.prepare(
      `INSERT INTO file (id, workspace_id, conversation_id, uploader_id, r2_key, name, mime, size, status, created_at)
       SELECT 'old', workspace_id, id, created_by, 'files/x/old', 'f.png', 'image/png', 1, 'ready', ?
       FROM conversation WHERE id = ?`,
    )
      .bind(Date.now() - 30 * HOUR, t.ch)
      .run();
    const failingEnv = {
      ...env,
      FILES: { delete: () => Promise.reject(new Error('R2 down')) },
    } as unknown as Env;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await cleanup(failingEnv, db)).orphanFiles).toBe(1);
    error.mockRestore();
    expect(await env.DB.prepare("SELECT id FROM file WHERE id = 'old'").first()).toBeNull();
  });
});

describe('7: daily digests', () => {
  it('catch up at 09:00 when 08:00 was missed, and go out once per local day', async () => {
    const t = await team();
    await api('/api/me/preferences', {
      method: 'PATCH',
      body: { digest: 'daily', timezone: 'Africa/Johannesburg' },
      cookie: t.jaco.cookie,
    });
    // Johannesburg is UTC+2, so 07:00 UTC is 09:00 local: the 08:00 run was missed.
    const at = (day: number, utcHour: number) => new Date(Date.UTC(2030, 0, day, utcHour));
    await t.mention('first');
    await env.DB.prepare('UPDATE notification SET created_at = ?').bind(at(15, 3).getTime()).run();

    expect(await dueUsers(db, at(15, 7))).toEqual([t.jaco.userId]);
    const mail = captureEmails();
    expect(await sendDigest(db, config, t.jaco.userId, at(15, 7))).toBe('sent');
    mail.restore();

    await t.mention('later that day');
    await env.DB.prepare('UPDATE notification SET created_at = ? WHERE emailed_at IS NULL')
      .bind(at(15, 5).getTime())
      .run();
    expect(await dueUsers(db, at(15, 9))).toEqual([]); // same local day: no second digest
    expect(await dueUsers(db, at(16, 6))).toEqual([t.jaco.userId]); // next day, 08:00 local
  });
});
