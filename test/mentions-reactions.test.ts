import { beforeEach, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { APP_URL, addMember, api, resetDb, setupWorkspace } from './helpers';

let n = 0;
const post = (cookie: string, id: string, body: string, extra: Record<string, unknown> = {}) =>
  api(`/api/conversations/${id}/messages`, {
    body: { body, clientMsgId: `mr-${Date.now()}-${n++}`, ...extra },
    cookie,
  });
const at = (userId: string) => `<@${userId}>`;

async function team() {
  const owner = await setupWorkspace();
  const ownerId = (await api('/api/me', { cookie: owner.cookie })).json.user.id as string;
  const jaco = await addMember(owner.cookie, 'jaco@example.com', 'member');
  const aisha = await addMember(owner.cookie, 'aisha@example.com', 'member');
  const ch = (
    await api('/api/conversations', { body: { name: 'project', kind: 'public' }, cookie: owner.cookie })
  ).json.conversation.id as string;
  await api(`/api/conversations/${ch}/join`, { body: {}, cookie: jaco.cookie });
  return { owner: { ...owner, userId: ownerId }, jaco, aisha, ch };
}

const sidebar = async (cookie: string, id: string) =>
  (await api('/api/conversations', { cookie })).json.conversations.find((c: { id: string }) => c.id === id);
const mentionsOf = async (cookie: string) => (await api('/api/activity/mentions', { cookie })).json.mentions;

beforeEach(resetDb);

describe('mentions', () => {
  it('counts a mention in the sidebar and lists it in the Mentions view', async () => {
    const { owner, jaco, ch } = await team();
    await post(owner.cookie, ch, `${at(jaco.userId)} can you check the section?`);
    expect((await sidebar(jaco.cookie, ch)).mentions).toBe(1);
    const list = await mentionsOf(jaco.cookie);
    expect(list).toHaveLength(1);
    expect(list[0].conversation.name).toBe('project');
    expect(list[0].read).toBe(false);
  });

  it('ignores mentions of people outside the conversation, so nothing leaks', async () => {
    const { owner, aisha, ch } = await team();
    const secret = (
      await api('/api/conversations', { body: { name: 'secret', kind: 'private' }, cookie: owner.cookie })
    ).json.conversation.id as string;
    await post(owner.cookie, secret, `${at(aisha.userId)} the salaries are…`);
    await post(owner.cookie, ch, `${at(aisha.userId)} not in this public channel either`);
    expect(await mentionsOf(aisha.cookie)).toEqual([]);
    const stored = await env.DB.prepare('SELECT count(*) AS n FROM message_mention').first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });

  it('reaches every member with <@channel>, but never the author', async () => {
    const { owner, jaco, ch } = await team();
    await post(owner.cookie, ch, '<@channel> site visit moves to Tuesday');
    expect((await mentionsOf(jaco.cookie)).length).toBe(1);
    expect(await mentionsOf(owner.cookie)).toEqual([]);
  });

  it('notifies people newly mentioned by an edit, once', async () => {
    const { owner, jaco, ch } = await team();
    const msg = (await post(owner.cookie, ch, 'who can check this?')).json.message;
    const edit = (body: string) =>
      api(`/api/conversations/${ch}/messages/${msg.id}`, {
        method: 'PATCH',
        body: { body },
        cookie: owner.cookie,
      });
    await edit(`${at(jaco.userId)} can you check this?`);
    await edit(`${at(jaco.userId)} can you check this please?`);
    expect((await mentionsOf(jaco.cookie)).length).toBe(1);
  });

  it('drops mentions from the view when you leave the conversation', async () => {
    const { owner, jaco, ch } = await team();
    await post(owner.cookie, ch, `${at(jaco.userId)} hello`);
    await api(`/api/conversations/${ch}/leave`, { body: {}, cookie: jaco.cookie });
    expect(await mentionsOf(jaco.cookie)).toEqual([]);
  });

  it('marks mention notifications read when the conversation is read', async () => {
    const { owner, jaco, ch } = await team();
    const msg = (await post(owner.cookie, ch, `${at(jaco.userId)} ping`)).json.message;
    await api(`/api/conversations/${ch}/read`, { body: { seq: msg.seq }, cookie: jaco.cookie });
    expect((await mentionsOf(jaco.cookie))[0].read).toBe(true);
    expect((await sidebar(jaco.cookie, ch)).mentions).toBe(0);
  });

  it('flags the hub ping as a mention for the person mentioned only', async () => {
    const { owner, jaco, aisha, ch } = await team();
    await api(`/api/conversations/${ch}/join`, { body: {}, cookie: aisha.cookie });
    const open = async (cookie: string) => {
      const res = await exports.default.fetch(`${APP_URL}/api/realtime/socket`, {
        headers: { upgrade: 'websocket', cookie, origin: APP_URL },
      });
      const frames: any[] = [];
      res.webSocket!.accept();
      res.webSocket!.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data))));
      return frames;
    };
    const jacoFrames = await open(jaco.cookie);
    const aishaFrames = await open(aisha.cookie);
    await post(owner.cookie, ch, `${at(jaco.userId)} over to you`);
    await new Promise((r) => setTimeout(r, 200));
    expect(jacoFrames.find((f) => f.type === 'activity')?.mentioned).toBe(true);
    expect(aishaFrames.find((f) => f.type === 'activity')?.mentioned).toBe(false);
  });
});

describe('DM and thread notifications', () => {
  it('records a DM for the other person', async () => {
    const { owner, jaco } = await team();
    const dm = (
      await api('/api/conversations/dm', { body: { userIds: [jaco.userId] }, cookie: owner.cookie })
    ).json.conversation.id as string;
    await post(owner.cookie, dm, 'quick question');
    const row = await env.DB.prepare('SELECT kind FROM notification WHERE user_id = ?')
      .bind(jaco.userId)
      .first();
    expect(row).toEqual({ kind: 'dm' });
  });

  it('notifies the thread starter and earlier repliers, and lists the thread for them', async () => {
    const { owner, jaco, ch } = await team();
    const parent = (await post(owner.cookie, ch, 'Boundary wall height?')).json.message;
    await post(jaco.cookie, ch, '1.8 m', { parentId: parent.id });
    const kinds = await env.DB.prepare(
      'SELECT user_id AS userId, kind FROM notification ORDER BY created_at',
    ).all();
    expect(kinds.results).toEqual([{ userId: owner.userId, kind: 'thread_reply' }]);

    await post(owner.cookie, ch, 'Thanks!', { parentId: parent.id });
    const forJaco = await env.DB.prepare('SELECT kind FROM notification WHERE user_id = ?')
      .bind(jaco.userId)
      .first();
    expect(forJaco).toEqual({ kind: 'thread_reply' });

    const threads = (await api('/api/activity/threads', { cookie: jaco.cookie })).json.threads;
    expect(threads.map((t: any) => t.parent.id)).toEqual([parent.id]);
    expect(threads[0].parent.replyCount).toBe(2);
  });
});

describe('reactions', () => {
  it('adds once, removes once, and shows counts in history', async () => {
    const { owner, jaco, ch } = await team();
    const msg = (await post(owner.cookie, ch, 'Kitchen section is up')).json.message;
    const url = `/api/conversations/${ch}/messages/${msg.id}/reactions`;
    expect((await api(url, { body: { emoji: '👍' }, cookie: jaco.cookie })).json).toEqual({ changed: true });
    expect((await api(url, { body: { emoji: '👍' }, cookie: jaco.cookie })).json).toEqual({ changed: false });
    await api(url, { body: { emoji: '👍' }, cookie: owner.cookie });

    const history = await api(`/api/conversations/${ch}/messages`, { cookie: owner.cookie });
    const reactions = history.json.messages.find((m: { id: string }) => m.id === msg.id).reactions;
    expect(reactions).toEqual([{ emoji: '👍', count: 2, userIds: [jaco.userId, owner.userId] }]);

    const del = await api(`${url}?emoji=${encodeURIComponent('👍')}`, {
      method: 'DELETE',
      cookie: jaco.cookie,
    });
    expect(del.json).toEqual({ changed: true });
    const again = await api(`${url}?emoji=${encodeURIComponent('👍')}`, {
      method: 'DELETE',
      cookie: jaco.cookie,
    });
    expect(again.json).toEqual({ changed: false });
  });

  it('records each real change as a numbered event (and no-ops as nothing)', async () => {
    const { owner, ch } = await team();
    const msg = (await post(owner.cookie, ch, 'hi')).json.message;
    const url = `/api/conversations/${ch}/messages/${msg.id}/reactions`;
    await api(url, { body: { emoji: '✅' }, cookie: owner.cookie });
    await api(url, { body: { emoji: '✅' }, cookie: owner.cookie });
    const events = (await api(`/api/conversations/${ch}/events?after=${msg.seq}`, { cookie: owner.cookie }))
      .json.events;
    expect(events.map((e: any) => e.type)).toEqual(['reaction.added']);
  });

  it('accepts real emoji including skin tones and joined sequences, and refuses text', async () => {
    const { owner, ch } = await team();
    const msg = (await post(owner.cookie, ch, 'hi')).json.message;
    const url = `/api/conversations/${ch}/messages/${msg.id}/reactions`;
    for (const emoji of ['👍🏽', '🧑‍💻', '❤️']) {
      expect((await api(url, { body: { emoji }, cookie: owner.cookie })).status).toBe(200);
    }
    for (const emoji of ['lol', '<script>', '👍 then text']) {
      expect((await api(url, { body: { emoji }, cookie: owner.cookie })).status).toBe(400);
    }
  });

  it('requires being able to post: outsiders get 404 on private, 403 on public until they join', async () => {
    const { owner, aisha, ch } = await team();
    const secret = (
      await api('/api/conversations', { body: { name: 'secret', kind: 'private' }, cookie: owner.cookie })
    ).json.conversation.id as string;
    const hidden = (await post(owner.cookie, secret, 'x')).json.message;
    const visible = (await post(owner.cookie, ch, 'y')).json.message;
    expect(
      (
        await api(`/api/conversations/${secret}/messages/${hidden.id}/reactions`, {
          body: { emoji: '👍' },
          cookie: aisha.cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(`/api/conversations/${ch}/messages/${visible.id}/reactions`, {
          body: { emoji: '👍' },
          cookie: aisha.cookie,
        })
      ).status,
    ).toBe(403);
  });

  it('cannot react to a deleted message', async () => {
    const { owner, ch } = await team();
    const msg = (await post(owner.cookie, ch, 'oops')).json.message;
    await api(`/api/conversations/${ch}/messages/${msg.id}`, { method: 'DELETE', cookie: owner.cookie });
    expect(
      (
        await api(`/api/conversations/${ch}/messages/${msg.id}/reactions`, {
          body: { emoji: '👍' },
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(404);
  });
});
