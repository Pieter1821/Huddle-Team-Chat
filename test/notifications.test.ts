import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { getConfig } from '../src/worker/config';
import { getDb } from '../src/worker/db/client';
import { cleanup, queue } from '../src/worker/jobs';
import {
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
const post = (cookie: string, id: string, body: string, extra: Record<string, unknown> = {}) =>
  api(`/api/conversations/${id}/messages`, {
    body: { body, clientMsgId: `n-${Date.now()}-${n++}`, ...extra },
    cookie,
  });

/** Pretends every notification was created `hours` ago. */
const age = (hours: number) =>
  env.DB.prepare('UPDATE notification SET created_at = created_at - ?')
    .bind(hours * HOUR)
    .run();

async function team() {
  const owner = await setupWorkspace();
  const jaco = await addMember(owner.cookie, 'jaco@example.com', 'member');
  await api('/api/me', { method: 'PATCH', body: { name: 'Jaco Steyn' }, cookie: jaco.cookie });
  const ch = (
    await api('/api/conversations', { body: { name: 'project', kind: 'public' }, cookie: owner.cookie })
  ).json.conversation.id as string;
  await api(`/api/conversations/${ch}/join`, { body: {}, cookie: jaco.cookie });
  return { owner, jaco, ch };
}

const mentionJaco = async (t: Awaited<ReturnType<typeof team>>, text = 'can you check the section?') =>
  (await post(t.owner.cookie, t.ch, `<@${t.jaco.userId}> ${text}`)).json.message;

beforeEach(resetDb);

describe('when a digest is due', () => {
  it('waits for the delay (2 hours by default) before including someone', async () => {
    const t = await team();
    await mentionJaco(t);
    expect(await dueUsers(db, new Date())).toEqual([]);
    await age(3);
    expect(await dueUsers(db, new Date())).toEqual([t.jaco.userId]);
  });

  it('respects digest off and Do Not Disturb', async () => {
    const t = await team();
    await mentionJaco(t);
    await age(3);
    const later = new Date(Date.now() + 8 * HOUR).toISOString();
    await api('/api/me/preferences', {
      method: 'PATCH',
      body: { pausedUntil: later },
      cookie: t.jaco.cookie,
    });
    expect(await dueUsers(db, new Date())).toEqual([]);
    await api('/api/me/preferences', {
      method: 'PATCH',
      body: { pausedUntil: null, digest: 'off' },
      cookie: t.jaco.cookie,
    });
    expect(await dueUsers(db, new Date())).toEqual([]);
  });

  it('sends daily digests only at 08:00 in the person’s time zone', async () => {
    const t = await team();
    await api('/api/me/preferences', {
      method: 'PATCH',
      body: { digest: 'daily', timezone: 'Africa/Johannesburg' },
      cookie: t.jaco.cookie,
    });
    await mentionJaco(t);
    await age(30);
    const at = (utcHour: number) => new Date(Date.UTC(2030, 0, 15, utcHour, 0, 0));
    expect(await dueUsers(db, at(5))).toEqual([]); // 07:00 in Johannesburg
    expect(await dueUsers(db, at(6))).toEqual([t.jaco.userId]); // 08:00
  });
});

describe('building and sending a digest', () => {
  it('lists the message with readable names, a link and an unsubscribe header', async () => {
    const t = await team();
    const msg = await mentionJaco(t, 'what about <@channel> too?');
    await age(3);
    const { email } = await buildDigest(db, config, t.jaco.userId, new Date());
    expect(email?.to).toBe('jaco@example.com');
    expect(email?.subject).toBe('1 message is waiting for you in Brightwater Studio');
    expect(email?.text).toContain('Thandi Nkosi in #project: @Jaco Steyn what about @channel too?');
    expect(email?.text).toContain(`/c/${t.ch}/m/${msg.id}`);
    expect(email?.headers?.['List-Unsubscribe']).toMatch(/^<http:\/\/localhost:8787\/api\/unsubscribe\?u=/);
    expect(email?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(email?.html).not.toContain('<@');
  });

  it('sends once: a repeated job or the next hour sends nothing twice', async () => {
    const t = await team();
    await mentionJaco(t);
    await age(3);
    const mail = captureEmails();
    expect(await sendDigest(db, config, t.jaco.userId)).toBe('sent');
    expect(await sendDigest(db, config, t.jaco.userId)).toBe('nothing');
    expect(mail.all().filter((m) => m.to === 'jaco@example.com')).toHaveLength(1);
    mail.restore();
    expect(await dueUsers(db, new Date(Date.now() + HOUR))).toEqual([]);
  });

  it('leaves out what was read, deleted, muted or in a conversation you left', async () => {
    const t = await team();
    const read = await mentionJaco(t, 'read this');
    await api(`/api/conversations/${t.ch}/read`, { body: { seq: read.seq }, cookie: t.jaco.cookie });
    const gone = await mentionJaco(t, 'deleted');
    await api(`/api/conversations/${t.ch}/messages/${gone.id}`, { method: 'DELETE', cookie: t.owner.cookie });
    await age(3);
    expect((await buildDigest(db, config, t.jaco.userId, new Date())).email).toBeNull();

    await mentionJaco(t, 'muted channel');
    await age(3);
    await api(`/api/conversations/${t.ch}/notifications`, {
      method: 'PATCH',
      body: { level: 'muted' },
      cookie: t.jaco.cookie,
    });
    expect((await buildDigest(db, config, t.jaco.userId, new Date())).email).toBeNull();

    await api(`/api/conversations/${t.ch}/notifications`, {
      method: 'PATCH',
      body: { level: 'all' },
      cookie: t.jaco.cookie,
    });
    await api(`/api/conversations/${t.ch}/leave`, { body: {}, cookie: t.jaco.cookie });
    expect((await buildDigest(db, config, t.jaco.userId, new Date())).email).toBeNull();
  });

  it('“mentions only” keeps mentions but drops thread replies', async () => {
    const t = await team();
    const parent = (await post(t.jaco.cookie, t.ch, 'my question')).json.message;
    await post(t.owner.cookie, t.ch, 'an answer', { parentId: parent.id }); // thread_reply for Jaco
    await age(3);
    await api(`/api/conversations/${t.ch}/notifications`, {
      method: 'PATCH',
      body: { level: 'mentions' },
      cookie: t.jaco.cookie,
    });
    expect((await buildDigest(db, config, t.jaco.userId, new Date())).email).toBeNull();
  });
});

describe('email budget', () => {
  it('stops digests at 80 emails a day so sign-in codes always have room', async () => {
    const t = await team();
    await mentionJaco(t);
    await age(3);
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      'INSERT INTO email_usage (day, sent) VALUES (?, 80) ON CONFLICT(day) DO UPDATE SET sent = 80',
    )
      .bind(today)
      .run();
    const enqueue = vi.fn(async () => {});
    expect(await scheduleDigests(db, enqueue)).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await sendDigest(db, config, t.jaco.userId)).toBe('over_budget');
  });

  it('counts every email sent, sign-in codes included', async () => {
    await setupWorkspace(); // one sign-in code
    const usage = await env.DB.prepare('SELECT sent FROM email_usage').first<{ sent: number }>();
    expect(usage?.sent).toBeGreaterThanOrEqual(1);
  });

  it('queues one job per due person', async () => {
    const t = await team();
    await mentionJaco(t);
    await age(3);
    const enqueue = vi.fn(async () => {});
    expect(await scheduleDigests(db, enqueue)).toBe(1);
    expect(enqueue).toHaveBeenCalledWith([{ userId: t.jaco.userId }]);
  });
});

describe('the queue consumer', () => {
  const fakeMessage = (userId: string) => ({ body: { userId }, ack: vi.fn(), retry: vi.fn() });

  it('acknowledges a sent digest', async () => {
    const t = await team();
    await mentionJaco(t);
    await age(3);
    const mail = captureEmails();
    const msg = fakeMessage(t.jaco.userId);
    await queue({ messages: [msg] } as never, env);
    mail.restore();
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('retries when the email provider fails, leaving the notifications pending', async () => {
    const t = await team();
    await mentionJaco(t);
    await age(3);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('mail server down');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const msg = fakeMessage(t.jaco.userId);
    await queue({ messages: [msg] } as never, env);
    warn.mockRestore();
    expect(msg.retry).toHaveBeenCalled();
    const pending = await env.DB.prepare(
      'SELECT count(*) AS n FROM notification WHERE emailed_at IS NULL',
    ).first<{ n: number }>();
    expect(pending?.n).toBe(1);
  });
});

describe('unsubscribe', () => {
  it('turns digests off from the signed link, without signing in', async () => {
    const t = await team();
    const url = new URL(await unsubscribeUrl(config, t.jaco.userId));
    const res = await api(`${url.pathname}${url.search}`, {});
    expect(res.status).toBe(200);
    const prefs = await api('/api/me/preferences', { cookie: t.jaco.cookie });
    expect(prefs.json.preferences.digest).toBe('off');
  });

  it('accepts the mail app’s one-click POST, which has no Origin', async () => {
    const t = await team();
    const url = new URL(await unsubscribeUrl(config, t.jaco.userId));
    const res = await api(`${url.pathname}${url.search}`, { method: 'POST', origin: null });
    expect(res.status).toBe(204);
  });

  it('rejects a forged or tampered link', async () => {
    const t = await team();
    const url = new URL(await unsubscribeUrl(config, t.jaco.userId));
    const ownerId = (await api('/api/me', { cookie: t.owner.cookie })).json.user.id as string;
    url.searchParams.set('u', ownerId); // someone else's id with Jaco's signature
    expect((await api(`${url.pathname}${url.search}`, {})).status).toBe(404);
    expect((await api('/api/unsubscribe?u=x&t=y', {})).status).toBe(404);
  });
});

describe('preferences and per-conversation levels', () => {
  it('starts from sensible defaults and validates changes', async () => {
    const t = await team();
    const prefs = await api('/api/me/preferences', { cookie: t.jaco.cookie });
    expect(prefs.json.preferences).toEqual({
      digest: 'hourly',
      digestDelayMin: 120,
      timezone: 'UTC',
      pausedUntil: null,
    });
    const patch = (body: unknown) =>
      api('/api/me/preferences', { method: 'PATCH', body, cookie: t.jaco.cookie });
    expect((await patch({ timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await patch({ digestDelayMin: 5 })).status).toBe(400);
    expect((await patch({ timezone: 'Africa/Johannesburg', digestDelayMin: 60 })).status).toBe(200);
  });

  it('only members can set a conversation’s notification level', async () => {
    const t = await team();
    const aisha = await addMember(t.owner.cookie, 'aisha@example.com', 'member');
    const secret = (
      await api('/api/conversations', { body: { name: 'secret', kind: 'private' }, cookie: t.owner.cookie })
    ).json.conversation.id as string;
    const set = (cookie: string, id: string) =>
      api(`/api/conversations/${id}/notifications`, { method: 'PATCH', body: { level: 'muted' }, cookie });
    expect((await set(aisha.cookie, t.ch)).status).toBe(403);
    expect((await set(aisha.cookie, secret)).status).toBe(404);
    expect((await set(t.jaco.cookie, t.ch)).status).toBe(200);
  });
});

describe('hourly cleanup', () => {
  it('removes day-old unsent uploads from storage, keeping recent and attached ones', async () => {
    const t = await team();
    const insert = (id: string, ageHours: number, messageId: string | null) =>
      env.DB.prepare(
        `INSERT INTO file (id, workspace_id, conversation_id, message_id, uploader_id, r2_key, name, mime, size, status, created_at)
         SELECT ?, workspace_id, id, ?, created_by, ?, 'f.png', 'image/png', 1, 'ready', ? FROM conversation WHERE id = ?`,
      )
        .bind(id, messageId, `files/${t.ch}/${id}`, Date.now() - ageHours * HOUR, t.ch)
        .run();
    const msg = (await post(t.owner.cookie, t.ch, 'with a file')).json.message;
    for (const id of ['old', 'fresh', 'sent']) await env.FILES.put(`files/${t.ch}/${id}`, 'x');
    await insert('old', 30, null);
    await insert('fresh', 1, null);
    await insert('sent', 30, msg.id);

    const result = await cleanup(env, db);
    expect(result.orphanFiles).toBe(1);
    const left = (await env.DB.prepare('SELECT id FROM file ORDER BY id').all<{ id: string }>()).results.map(
      (r) => r.id,
    );
    expect(left).toEqual(['fresh', 'sent']);
    expect(await env.FILES.get(`files/${t.ch}/old`)).toBeNull();
    expect(await env.FILES.get(`files/${t.ch}/sent`)).not.toBeNull();
  });

  it('republishes events a crashed room left unpublished', async () => {
    const t = await team();
    await post(t.owner.cookie, t.ch, 'saved, never broadcast');
    await env.DB.prepare(
      'UPDATE conversation_event SET published_at = NULL, created_at = created_at - 120000',
    ).run();
    expect((await cleanup(env, db)).republished).toBe(1);
  });
});
