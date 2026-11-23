import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { convertSlackText, emojiFromShortcode } from '../src/worker/modules/import/slack-text';
import { addMember, api, resetDb, setupWorkspace, signIn } from './helpers';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe('Slack text conversion', () => {
  const ids = new Map([['U1', '01HUDDLEUSER0000000000000A']]);
  it('rewrites people, channels, everyone-mentions, links and formatting', () => {
    const out = convertSlackText(
      '<@U1> see <#C9|drawings>, <!here> and <!channel>: *rev C* is ~old~ <https://x.example/p|the plan> &amp; <https://y.example>',
      ids,
      new Map(),
    );
    expect(out).toBe(
      '<@01HUDDLEUSER0000000000000A> see #drawings, <@here> and <@channel>: **rev C** is ~~old~~ [the plan](https://x.example/p) & https://y.example',
    );
  });
  it('names people who were not imported instead of leaving a broken token', () => {
    expect(convertSlackText('thanks <@U404>', ids, new Map())).toBe('thanks @someone');
  });
  it('maps common reaction names to emoji, with skin tones, and skips custom ones', () => {
    expect(emojiFromShortcode('+1')).toBe('👍');
    expect(emojiFromShortcode('thumbsup::skin-tone-4')).toBe('👍🏽');
    expect(emojiFromShortcode('our-custom-logo')).toBeNull();
  });
});

async function startImport() {
  const owner = await setupWorkspace();
  const jaco = await addMember(owner.cookie, 'jaco@example.com', 'member');
  const sid = (await api('/api/import', { body: {}, cookie: owner.cookie })).json.sessionId as string;
  const call = (path: string, body: unknown) =>
    api(`/api/import/${sid}/${path}`, { body, cookie: owner.cookie });
  await call('users', {
    users: [
      { slackId: 'U1', name: 'jaco', realName: 'Jaco S', email: 'jaco@example.com' },
      { slackId: 'U2', name: 'marlize', realName: 'Marlize van Wyk', email: 'marlize@old.example' },
      { slackId: 'U3', name: 'bot-person' },
    ],
  });
  return { owner, jaco, sid, call };
}

describe('importing a Slack export', () => {
  it('is for the owner only', async () => {
    const owner = await setupWorkspace();
    const member = await addMember(owner.cookie, 'aisha@example.com', 'admin');
    expect((await api('/api/import', { body: {}, cookie: member.cookie })).status).toBe(403);
  });

  it('matches people by email and makes deactivated placeholders for the rest', async () => {
    const { jaco, sid } = await startImport();
    const map = await env.DB.prepare(
      'SELECT slack_id AS s, user_id AS u FROM import_user_map WHERE session_id = ? ORDER BY s',
    )
      .bind(sid)
      .all<{ s: string; u: string }>();
    expect(map.results[0]?.u).toBe(jaco.userId);
    const placeholders = await env.DB.prepare(
      "SELECT u.email, wm.status FROM user u JOIN workspace_member wm ON wm.user_id = u.id WHERE u.email <> 'jaco@example.com' AND u.email <> 'owner@example.com' ORDER BY u.email",
    ).all();
    expect(placeholders.results).toEqual([
      { email: 'marlize@old.example', status: 'deactivated' },
      { email: 'u3@slack-import.invalid', status: 'deactivated' },
    ]);
    // A placeholder with a real address still cannot sign in until an admin reactivates them.
    expect((await signIn('marlize@old.example')).cookie).toBe('');
  });

  it('imports channels, messages, threads, reactions and mentions', async () => {
    const { owner, jaco, sid, call } = await startImport();
    const channels = await call('channels', {
      channels: [
        { slackId: 'C1', kind: 'public', name: 'general', topic: 'Everything', memberSlackIds: ['U1', 'U2'] },
        { slackId: 'G1', kind: 'private', name: 'client-van-wyk', memberSlackIds: ['U1', 'U2'] },
      ],
    });
    const general = channels.json.channels[0];
    // Nobody has written in Huddle's #general yet, so Slack's #general becomes it.
    const huddleGeneral = (await api('/api/conversations', { cookie: owner.cookie })).json.conversations.find(
      (c: { name: string }) => c.name === 'general',
    );
    expect(general).toMatchObject({ name: 'general', conversationId: huddleGeneral.id });

    const res = await call('messages', {
      channelSlackId: 'C1',
      messages: [
        { ts: '1700000000.000100', user: 'U2', text: 'Boundary wall under 2.1 m? <@U1>' },
        { ts: '1700000005.000100', subtype: 'channel_join', user: 'U1', text: '<@U1> has joined' },
        {
          ts: '1700000060.000200',
          user: 'U1',
          text: '*1.8 m* on <https://x.example/site|the site plan>',
          threadTs: '1700000000.000100',
          reactions: [{ name: '+1', users: ['U2'] }],
        },
      ],
    });
    expect(res.json).toEqual({ imported: 2, skipped: 1 });

    const history = await api(`/api/conversations/${general.conversationId}/messages`, {
      cookie: owner.cookie,
    });
    const [parent] = history.json.messages;
    expect(parent.body).toBe(`Boundary wall under 2.1 m? <@${jaco.userId}>`);
    expect(parent.createdAt).toBe(new Date(1700000000000).toISOString());

    const thread = await api(`/api/conversations/${general.conversationId}/messages/${parent.id}/thread`, {
      cookie: owner.cookie,
    });
    expect(thread.json.replies[0].body).toBe('**1.8 m** on [the site plan](https://x.example/site)');
    expect(thread.json.replies[0].reactions[0].emoji).toBe('👍');

    await call('finish', {});
    const after = await api(`/api/conversations/${general.conversationId}/messages/${parent.id}/thread`, {
      cookie: owner.cookie,
    });
    expect(after.json.parent.replyCount).toBe(1);
    expect((await api(`/api/import/${sid}`, { cookie: owner.cookie })).json.counts).toEqual({
      users: 3,
      conversations: 2,
      messages: 2,
    });
  });

  it('keeps Slack’s #general separate once people are talking in Huddle’s #general', async () => {
    const { owner, call } = await startImport();
    const huddleGeneral = (await api('/api/conversations', { cookie: owner.cookie })).json.conversations.find(
      (c: { name: string }) => c.name === 'general',
    );
    await api(`/api/conversations/${huddleGeneral.id}/messages`, {
      body: { body: 'Already chatting here', clientMsgId: 'before-import-1' },
      cookie: owner.cookie,
    });
    const channels = await call('channels', {
      channels: [{ slackId: 'C1', kind: 'public', name: 'general', memberSlackIds: ['U1'] }],
    });
    expect(channels.json.channels[0].name).toBe('general-imported');
    expect(channels.json.channels[0].conversationId).not.toBe(huddleGeneral.id);
  });

  it('records one history.imported event per batch, and re-running a batch imports nothing twice', async () => {
    const { owner, call } = await startImport();
    const ch = (
      await call('channels', {
        channels: [{ slackId: 'C2', kind: 'public', name: 'site', memberSlackIds: ['U1'] }],
      })
    ).json.channels[0].conversationId as string;
    const batch = {
      channelSlackId: 'C2',
      messages: [
        { ts: '1700000000.000001', user: 'U1', text: 'one' },
        { ts: '1700000001.000001', user: 'U1', text: 'two' },
      ],
    };
    expect((await call('messages', batch)).json.imported).toBe(2);
    expect((await call('messages', batch)).json.imported).toBe(0);
    const events = (await api(`/api/conversations/${ch}/events?after=0`, { cookie: owner.cookie })).json
      .events;
    const imported = events.filter((e: any) => e.type === 'history.imported');
    expect(imported).toHaveLength(1);
    expect(imported[0].data).toMatchObject({ count: 2, toSeq: imported[0].data.fromSeq + 1 });
  });

  it('importing the same export again (a new session) reuses its channels and adds only new messages', async () => {
    const { owner, call, sid } = await startImport();
    const channel = { slackId: 'C9', kind: 'public', name: 'roadmap', memberSlackIds: ['U1'] };
    const first = (await call('channels', { channels: [channel] })).json.channels[0].conversationId as string;
    const older = { ts: '1700000000.000001', user: 'U1', text: 'old news' };
    expect((await call('messages', { channelSlackId: 'C9', messages: [older] })).json.imported).toBe(1);
    await call('finish', {});

    // A newer export: same channel, one more person, the old message plus a new one.
    const sid2 = (await api('/api/import', { body: {}, cookie: owner.cookie })).json.sessionId as string;
    expect(sid2).not.toBe(sid);
    const again = (path: string, body: unknown) =>
      api(`/api/import/${sid2}/${path}`, { body, cookie: owner.cookie });
    await again('users', {
      users: [
        { slackId: 'U1', name: 'jaco', email: 'jaco@example.com' },
        { slackId: 'U2', name: 'marlize', email: 'marlize@old.example' },
      ],
    });
    const second = await again('channels', { channels: [{ ...channel, memberSlackIds: ['U1', 'U2'] }] });
    expect(second.json.channels[0].conversationId).toBe(first);
    const res = await again('messages', {
      channelSlackId: 'C9',
      messages: [older, { ts: '1700000500.000001', user: 'U2', text: 'new news' }],
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ imported: 1 });

    const names = await env.DB.prepare("SELECT name FROM conversation WHERE name LIKE 'roadmap%'").all<{
      name: string;
    }>();
    expect(names.results.map((r) => r.name)).toEqual(['roadmap']);
    const members = await env.DB.prepare(
      'SELECT count(*) AS n FROM conversation_member WHERE conversation_id = ?',
    )
      .bind(first)
      .first<{ n: number }>();
    expect(members?.n).toBe(3); // the owner, jaco and marlize
  });

  it('keeps messages apart when one person posted in two channels at the same instant', async () => {
    const { call } = await startImport();
    await call('channels', {
      channels: [
        { slackId: 'C21', kind: 'public', name: 'one', memberSlackIds: ['U1'] },
        { slackId: 'C22', kind: 'public', name: 'two', memberSlackIds: ['U1'] },
      ],
    });
    const same = { ts: '1700000000.000001', user: 'U1', text: 'cross-posted' };
    expect((await call('messages', { channelSlackId: 'C21', messages: [same] })).json.imported).toBe(1);
    const second = await call('messages', { channelSlackId: 'C22', messages: [same] });
    expect(second.status).toBe(200);
    expect(second.json.imported).toBe(1);
  });

  it('requires channels before their messages, and stops at the daily import allowance', async () => {
    const { call } = await startImport();
    expect(
      (await call('messages', { channelSlackId: 'C404', messages: [{ ts: '1700000000.1', text: 'x' }] }))
        .status,
    ).toBe(400);
    await call('channels', {
      channels: [{ slackId: 'C3', kind: 'public', name: 'busy', memberSlackIds: [] }],
    });
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO daily_counter (day, kind, count) VALUES (?, 'import_messages', 19999)")
      .bind(day)
      .run();
    const res = await call('messages', {
      channelSlackId: 'C3',
      messages: [
        { ts: '1700000000.000001', text: 'a' },
        { ts: '1700000001.000001', text: 'b' },
      ],
    });
    expect(res.status).toBe(429);
    expect(res.json.error.code).toBe('import_daily_limit');
  });

  it('imports DMs between imported people', async () => {
    const { call } = await startImport();
    const res = await call('channels', {
      channels: [{ slackId: 'D1', kind: 'dm', memberSlackIds: ['U1', 'U2'] }],
    });
    const dm = await env.DB.prepare('SELECT kind, name FROM conversation WHERE id = ?')
      .bind(res.json.channels[0].conversationId)
      .first();
    expect(dm).toEqual({ kind: 'dm', name: null });
  });

  it('fetches files only from Slack’s file servers, including after redirects', async () => {
    const { call } = await startImport();
    await call('channels', {
      channels: [{ slackId: 'C4', kind: 'public', name: 'files', memberSlackIds: ['U1'] }],
    });
    await call('messages', {
      channelSlackId: 'C4',
      messages: [{ ts: '1700000000.000001', user: 'U1', text: 'plan attached' }],
    });
    const file = (url: string) =>
      call('files', { channelSlackId: 'C4', ts: '1700000000.000001', name: 'plan.png', url });

    expect((await file('https://evil.example/plan.png')).status).toBe(400);
    expect((await file('http://files.slack.com/plan.png')).status).toBe(400);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }),
    );
    expect((await file('https://files.slack.com/files-pri/T1-F1/plan.png')).status).toBe(400);

    fetchSpy.mockImplementationOnce(() => Promise.resolve(new Response(PNG, { status: 200 })));
    const ok = await file('https://files.slack.com/files-pri/T1-F1/plan.png');
    expect(ok.status).toBe(201);
    expect(ok.json.file.mime).toBe('image/png');
  });
});

describe('export', () => {
  async function workspaceWithDm() {
    const owner = await setupWorkspace();
    const jaco = await addMember(owner.cookie, 'jaco@example.com', 'member');
    const dm = (
      await api('/api/conversations/dm', { body: { userIds: [jaco.userId] }, cookie: owner.cookie })
    ).json.conversation.id as string;
    await api(`/api/conversations/${dm}/messages`, {
      body: { body: 'between us', clientMsgId: 'export-dm-0001' },
      cookie: owner.cookie,
    });
    return { owner, jaco, dm };
  }

  it('is for the owner only and leaves DMs out unless asked, recording every export', async () => {
    const { owner, jaco, dm } = await workspaceWithDm();
    expect((await api('/api/export', { cookie: jaco.cookie })).status).toBe(403);

    const manifest = await api('/api/export', { cookie: owner.cookie });
    expect(manifest.json.format).toBe('huddle-export');
    expect(manifest.json.conversations.map((c: any) => c.kind)).toEqual(['public']);
    expect((await api(`/api/export/conversations/${dm}/messages`, { cookie: owner.cookie })).status).toBe(
      404,
    );

    const withDms = await api('/api/export?includeDms=1', { cookie: owner.cookie });
    expect(withDms.json.conversations.map((c: any) => c.kind).sort()).toEqual(['dm', 'public']);
    const messages = await api(`/api/export/conversations/${dm}/messages?includeDms=1`, {
      cookie: owner.cookie,
    });
    expect(messages.json.messages.map((m: any) => m.body)).toEqual(['between us']);

    const audit = await env.DB.prepare(
      "SELECT meta FROM audit_log WHERE action = 'export.started' ORDER BY id",
    ).all<{ meta: string }>();
    expect(audit.results.map((r) => JSON.parse(r.meta).includeDms)).toEqual([false, true]);
  });

  it('pages through a conversation in order', async () => {
    const owner = await setupWorkspace();
    const general = await env.DB.prepare("SELECT id FROM conversation WHERE name = 'general'").first<{
      id: string;
    }>();
    for (let i = 0; i < 5; i++) {
      await api(`/api/conversations/${general!.id}/messages`, {
        body: { body: `m${i}`, clientMsgId: `export-page-${i}000` },
        cookie: owner.cookie,
      });
    }
    const page1 = await api(`/api/export/conversations/${general!.id}/messages?limit=3`, {
      cookie: owner.cookie,
    });
    expect(page1.json.messages.map((m: any) => m.body)).toEqual(['m0', 'm1', 'm2']);
    const page2 = await api(
      `/api/export/conversations/${general!.id}/messages?limit=3&after=${page1.json.nextAfter}`,
      {
        cookie: owner.cookie,
      },
    );
    expect(page2.json.messages.map((m: any) => m.body)).toEqual(['m3', 'm4']);
    expect(page2.json.nextAfter).toBeNull();
  });
});

describe('usage', () => {
  it('shows admins how close the installation is to its free limits', async () => {
    const owner = await setupWorkspace();
    const member = await addMember(owner.cookie, 'jaco@example.com', 'member');
    expect((await api('/api/admin/usage', { cookie: member.cookie })).status).toBe(403);
    const res = await api('/api/admin/usage', { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(res.json.usage.database.limit).toBe(500 * 1024 * 1024);
    expect(res.json.usage.database.used).toBeGreaterThan(0);
    expect(res.json.counts.activeMembers).toBe(2);
    expect(res.json.warnings).toEqual([]);
  });

  it('warns when today’s email budget is nearly used', async () => {
    const owner = await setupWorkspace();
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      'INSERT INTO email_usage (day, sent) VALUES (?, 70) ON CONFLICT(day) DO UPDATE SET sent = 70',
    )
      .bind(day)
      .run();
    const res = await api('/api/admin/usage', { cookie: owner.cookie });
    expect(res.json.warnings).toHaveLength(1);
  });
});
