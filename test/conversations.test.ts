import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { addMember, api, resetDb, setupWorkspace } from './helpers';

let n = 0;
const clientId = () => `client-${Date.now()}-${n++}`;

async function team() {
  const owner = await setupWorkspace();
  const ownerMe = await api('/api/me', { cookie: owner.cookie });
  const jaco = await addMember(owner.cookie, 'jaco@example.com', 'member');
  return { owner: { ...owner, userId: ownerMe.json.user.id as string }, jaco };
}

const createChannel = async (cookie: string, name: string, kind: 'public' | 'private') =>
  (await api('/api/conversations', { body: { name, kind }, cookie })).json.conversation.id as string;

const post = (cookie: string, id: string, body: string, extra: Record<string, unknown> = {}) =>
  api(`/api/conversations/${id}/messages`, { body: { body, clientMsgId: clientId(), ...extra }, cookie });

beforeEach(resetDb);

describe('channels', () => {
  it('creates a channel with a tidy name and refuses a duplicate', async () => {
    const { owner } = await team();
    const res = await api('/api/conversations', {
      body: { name: 'Project Harbour House', kind: 'public' },
      cookie: owner.cookie,
    });
    expect(res.status).toBe(201);
    expect(res.json.conversation.name).toBe('project-harbour-house');
    const again = await api('/api/conversations', {
      body: { name: 'project harbour house', kind: 'private' },
      cookie: owner.cookie,
    });
    expect(again.status).toBe(409);
  });

  it('lists public channels to browse but never private ones', async () => {
    const { owner, jaco } = await team();
    await createChannel(owner.cookie, 'site-visits', 'public');
    await createChannel(owner.cookie, 'admin', 'private');
    const names = (await api('/api/conversations/browse', { cookie: jaco.cookie })).json.channels.map(
      (c: { name: string }) => c.name,
    );
    expect(names).toContain('site-visits');
    expect(names).not.toContain('admin');
  });

  it('hides a private channel from non-members with a 404, everywhere', async () => {
    const { owner, jaco } = await team();
    const secret = await createChannel(owner.cookie, 'admin', 'private');
    await post(owner.cookie, secret, 'Salaries are in the shared drive');
    for (const path of ['', '/messages', '/events?after=0']) {
      expect((await api(`/api/conversations/${secret}${path}`, { cookie: jaco.cookie })).status).toBe(404);
    }
    expect((await post(jaco.cookie, secret, 'let me in')).status).toBe(404);
    expect((await api(`/api/conversations/${secret}/join`, { body: {}, cookie: jaco.cookie })).status).toBe(
      404,
    );
  });

  it('lets members read a public channel, but post only after joining', async () => {
    const { owner, jaco } = await team();
    const ch = await createChannel(owner.cookie, 'site-visits', 'public');
    await post(owner.cookie, ch, 'Tuesday 08:00');
    expect((await api(`/api/conversations/${ch}/messages`, { cookie: jaco.cookie })).status).toBe(200);
    expect((await post(jaco.cookie, ch, 'me too')).status).toBe(403);
    await api(`/api/conversations/${ch}/join`, { body: {}, cookie: jaco.cookie });
    expect((await post(jaco.cookie, ch, 'me too')).status).toBe(201);
  });

  it('makes an archived channel read-only and protects #general', async () => {
    const { owner } = await team();
    const ch = await createChannel(owner.cookie, 'old-project', 'public');
    expect((await api(`/api/conversations/${ch}/archive`, { body: {}, cookie: owner.cookie })).status).toBe(
      200,
    );
    expect((await post(owner.cookie, ch, 'hello?')).status).toBe(409);
    const general = await env.DB.prepare("SELECT id FROM conversation WHERE name='general'").first<{
      id: string;
    }>();
    expect(
      (await api(`/api/conversations/${general!.id}/archive`, { body: {}, cookie: owner.cookie })).status,
    ).toBe(409);
  });

  it('only the creator or an admin renames; any member sets the topic', async () => {
    const { owner, jaco } = await team();
    const ch = await createChannel(owner.cookie, 'drawings', 'public');
    await api(`/api/conversations/${ch}/join`, { body: {}, cookie: jaco.cookie });
    const patch = (cookie: string, body: unknown) =>
      api(`/api/conversations/${ch}`, { method: 'PATCH', body, cookie });
    expect((await patch(jaco.cookie, { name: 'mine-now' })).status).toBe(403);
    expect((await patch(jaco.cookie, { topic: 'Rev C drawings' })).status).toBe(200);
    expect((await patch(owner.cookie, { name: 'drawings-review' })).status).toBe(200);
  });
});

describe('messages', () => {
  it('numbers messages in order and returns history oldest-to-newest', async () => {
    const { owner } = await team();
    const ch = await createChannel(owner.cookie, 'general-2', 'public');
    for (const body of ['one', 'two', 'three']) await post(owner.cookie, ch, body);
    const page = await api(`/api/conversations/${ch}/messages`, { cookie: owner.cookie });
    expect(page.json.messages.map((m: { body: string }) => m.body)).toEqual(['one', 'two', 'three']);
    expect(page.json.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3]);
  });

  it('gives concurrent sends unique, gap-free sequence numbers', async () => {
    const { owner } = await team();
    const ch = await createChannel(owner.cookie, 'busy', 'public');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => post(owner.cookie, ch, `msg ${i}`)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const seqs = results.map((r) => r.json.message.seq as number).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const last = await env.DB.prepare('SELECT last_seq FROM conversation WHERE id = ?')
      .bind(ch)
      .first<{ last_seq: number }>();
    expect(last?.last_seq).toBe(8);
  });

  it('treats a retried send as the same message, not a duplicate', async () => {
    const { owner } = await team();
    const ch = await createChannel(owner.cookie, 'retry', 'public');
    const body = { body: 'Kitchen section is up', clientMsgId: 'retry-test-0001' };
    const first = await api(`/api/conversations/${ch}/messages`, { body, cookie: owner.cookie });
    const second = await api(`/api/conversations/${ch}/messages`, { body, cookie: owner.cookie });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json.message.id).toBe(first.json.message.id);
    const count = await env.DB.prepare('SELECT count(*) AS n FROM message WHERE conversation_id = ?')
      .bind(ch)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('lets authors edit, refuses others, and records both as events', async () => {
    const { owner, jaco } = await team();
    const ch = await createChannel(owner.cookie, 'edits', 'public');
    await api(`/api/conversations/${ch}/join`, { body: {}, cookie: jaco.cookie });
    const msg = (await post(owner.cookie, ch, 'Bench at 900')).json.message;
    const url = `/api/conversations/${ch}/messages/${msg.id}`;
    expect((await api(url, { method: 'PATCH', body: { body: 'Hacked' }, cookie: jaco.cookie })).status).toBe(
      403,
    );
    const edited = await api(url, { method: 'PATCH', body: { body: 'Bench at 920' }, cookie: owner.cookie });
    expect(edited.status).toBe(200);
    expect(edited.json.message.editedAt).not.toBeNull();
    const events = (await api(`/api/conversations/${ch}/events?after=0`, { cookie: owner.cookie })).json
      .events;
    expect(events.map((e: { type: string }) => e.type)).toEqual([
      'member.joined',
      'message.created',
      'message.edited',
    ]);
  });

  it('soft-deletes: the text is gone but the slot stays; admins can delete anyone’s', async () => {
    const { owner, jaco } = await team();
    const ch = await createChannel(owner.cookie, 'deletes', 'public');
    await api(`/api/conversations/${ch}/join`, { body: {}, cookie: jaco.cookie });
    const mine = (await post(jaco.cookie, ch, 'Gate code is 4471')).json.message;
    expect(
      (await api(`/api/conversations/${ch}/messages/${mine.id}`, { method: 'DELETE', cookie: owner.cookie }))
        .status,
    ).toBe(204);
    const row = await env.DB.prepare('SELECT body, deleted_at FROM message WHERE id = ?')
      .bind(mine.id)
      .first<{ body: string; deleted_at: number }>();
    expect(row?.body).toBe('');
    expect(row?.deleted_at).toBeGreaterThan(0);
    // Deleting twice is a 404, not a second event.
    expect(
      (await api(`/api/conversations/${ch}/messages/${mine.id}`, { method: 'DELETE', cookie: owner.cookie }))
        .status,
    ).toBe(404);
  });

  it('threads are one level deep and keep a reply count', async () => {
    const { owner } = await team();
    const ch = await createChannel(owner.cookie, 'threads', 'public');
    const parent = (await post(owner.cookie, ch, 'Boundary wall under 2.1 m?')).json.message;
    const reply = (await post(owner.cookie, ch, '1.8 m on VW-SITE-02', { parentId: parent.id })).json.message;
    expect((await post(owner.cookie, ch, 'nested?', { parentId: reply.id })).status).toBe(404);
    const thread = await api(`/api/conversations/${ch}/messages/${parent.id}/thread`, {
      cookie: owner.cookie,
    });
    expect(thread.json.parent.replyCount).toBe(1);
    expect(thread.json.replies.map((r: { body: string }) => r.body)).toEqual(['1.8 m on VW-SITE-02']);
    // Replies stay out of the channel's main history unless also sent to the channel.
    const history = await api(`/api/conversations/${ch}/messages`, { cookie: owner.cookie });
    expect(history.json.messages.map((m: { id: string }) => m.id)).toEqual([parent.id]);
  });

  it('rejects empty and oversized messages', async () => {
    const { owner } = await team();
    const ch = await createChannel(owner.cookie, 'limits', 'public');
    expect((await post(owner.cookie, ch, '   ')).status).toBe(400);
    expect((await post(owner.cookie, ch, 'x'.repeat(8001))).status).toBe(400);
  });
});

describe('unread state', () => {
  it('counts others’ messages since your read marker, and the marker only moves forward', async () => {
    const { owner, jaco } = await team();
    const ch = await createChannel(owner.cookie, 'unread', 'public');
    await api(`/api/conversations/${ch}/join`, { body: {}, cookie: jaco.cookie });
    for (const b of ['a', 'b', 'c']) await post(owner.cookie, ch, b);
    const unread = async () =>
      (await api('/api/conversations', { cookie: jaco.cookie })).json.conversations.find(
        (c: { id: string }) => c.id === ch,
      ).unread;
    expect(await unread()).toBe(3);
    await api(`/api/conversations/${ch}/read`, { body: { seq: 3 }, cookie: jaco.cookie });
    expect(await unread()).toBe(1); // seq 4 is the third message (seq 1 was Jaco joining)
    await api(`/api/conversations/${ch}/read`, { body: { seq: 4 }, cookie: jaco.cookie });
    expect(await unread()).toBe(0);
    await api(`/api/conversations/${ch}/read`, { body: { seq: 1 }, cookie: jaco.cookie });
    expect(await unread()).toBe(0);
  });
});

describe('direct messages', () => {
  it('reopens the same DM for the same people, in any order', async () => {
    const { owner, jaco } = await team();
    const first = await api('/api/conversations/dm', {
      body: { userIds: [jaco.userId] },
      cookie: owner.cookie,
    });
    const back = await api('/api/conversations/dm', {
      body: { userIds: [owner.userId] },
      cookie: jaco.cookie,
    });
    expect(first.status).toBe(201);
    expect(back.status).toBe(200);
    expect(back.json.conversation.id).toBe(first.json.conversation.id);
    expect(first.json.conversation.kind).toBe('dm');
  });

  it('keeps a DM private to its members', async () => {
    const { owner, jaco } = await team();
    const aisha = await addMember(owner.cookie, 'aisha@example.com', 'member');
    const dm = (
      await api('/api/conversations/dm', { body: { userIds: [jaco.userId] }, cookie: owner.cookie })
    ).json.conversation.id;
    await post(owner.cookie, dm, 'Between us');
    expect((await api(`/api/conversations/${dm}/messages`, { cookie: aisha.cookie })).status).toBe(404);
  });

  it('lets guests message only people they share a channel with', async () => {
    const { owner, jaco } = await team();
    const client = await createChannel(owner.cookie, 'client-van-wyk', 'private');
    const guest = await addMember(owner.cookie, 'henk@example.com', 'guest', [client]);
    expect(
      (await api('/api/conversations/dm', { body: { userIds: [owner.userId] }, cookie: guest.cookie }))
        .status,
    ).toBe(201);
    expect(
      (await api('/api/conversations/dm', { body: { userIds: [jaco.userId] }, cookie: guest.cookie })).status,
    ).toBe(403);
  });
});

describe('guests in conversations', () => {
  it('cannot read public channels or create channels, but can post in their own', async () => {
    const { owner } = await team();
    const client = await createChannel(owner.cookie, 'client-van-wyk', 'private');
    const pub = await createChannel(owner.cookie, 'random', 'public');
    const guest = await addMember(owner.cookie, 'henk@example.com', 'guest', [client]);
    expect((await api(`/api/conversations/${pub}/messages`, { cookie: guest.cookie })).status).toBe(404);
    expect(
      (await api('/api/conversations', { body: { name: 'x', kind: 'public' }, cookie: guest.cookie })).status,
    ).toBe(403);
    expect((await post(guest.cookie, client, 'Hello from the client')).status).toBe(201);
  });

  it('only admins may add a guest to another channel', async () => {
    const { owner, jaco } = await team();
    const client = await createChannel(owner.cookie, 'client-van-wyk', 'private');
    const other = await createChannel(jaco.cookie, 'jacos-channel', 'private');
    const guest = await addMember(owner.cookie, 'henk@example.com', 'guest', [client]);
    expect(
      (
        await api(`/api/conversations/${other}/members`, {
          body: { userIds: [guest.userId] },
          cookie: jaco.cookie,
        })
      ).status,
    ).toBe(403);
  });
});

describe('outbox recovery', () => {
  it('publishes events that were saved but never broadcast', async () => {
    const { owner } = await team();
    const ch = await createChannel(owner.cookie, 'outbox', 'public');
    await post(owner.cookie, ch, 'saved but the room crashed before broadcasting');
    await env.DB.prepare('UPDATE conversation_event SET published_at = NULL WHERE conversation_id = ?')
      .bind(ch)
      .run();
    const room = env.CONVERSATION_ROOM.get(env.CONVERSATION_ROOM.idFromName(ch));
    expect(await room.publishPending(ch)).toBe(1);
    const pending = await env.DB.prepare(
      'SELECT count(*) AS n FROM conversation_event WHERE conversation_id = ? AND published_at IS NULL',
    )
      .bind(ch)
      .first<{ n: number }>();
    expect(pending?.n).toBe(0);
  });
});
