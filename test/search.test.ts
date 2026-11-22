import { beforeEach, describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { toFtsQuery } from '../src/worker/modules/search/routes';
import { APP_URL, addMember, api, resetDb, setupWorkspace } from './helpers';

let n = 0;
const post = (cookie: string, id: string, body: string, fileIds?: string[]) =>
  api(`/api/conversations/${id}/messages`, {
    body: { body, clientMsgId: `s-${Date.now()}-${n++}`, ...(fileIds ? { fileIds } : {}) },
    cookie,
  });
const search = async (cookie: string, query: string) =>
  api(`/api/search?${new URLSearchParams({ q: query }).toString()}`, { cookie });
const bodies = (res: { json: any }) => res.json.messages.map((m: any) => m.message.body as string);
const channel = async (cookie: string, name: string, kind: 'public' | 'private') =>
  (await api('/api/conversations', { body: { name, kind }, cookie })).json.conversation.id as string;

async function team() {
  const owner = await setupWorkspace();
  const ownerId = (await api('/api/me', { cookie: owner.cookie })).json.user.id as string;
  const jaco = await addMember(owner.cookie, 'jaco@example.com', 'member');
  return { owner: { ...owner, userId: ownerId }, jaco };
}

beforeEach(resetDb);

describe('query building', () => {
  it('keeps only plain words, as required prefix searches', () => {
    expect(toFtsQuery('kitch sect')).toBe('"kitch"* "sect"*');
    expect(toFtsQuery('"foo" OR bar* NEAR(')).toBe('"foo"* "OR"* "bar"* "NEAR"*');
    expect(toFtsQuery('  !!! ')).toBeNull();
  });
});

describe('message search', () => {
  it('finds messages by word prefix, ignoring case and accents, newest first with a highlight', async () => {
    const { owner } = await team();
    const ch = await channel(owner.cookie, 'project', 'public');
    await post(owner.cookie, ch, 'The Café meeting is on Tuesday');
    await post(owner.cookie, ch, 'Kitchen section is up');
    await post(owner.cookie, ch, 'kitchen window goes full width');
    const res = await search(owner.cookie, 'KITCH');
    expect(bodies(res)).toEqual(['kitchen window goes full width', 'Kitchen section is up']);
    expect(res.json.messages[0].snippet).toContain('\u0002kitchen\u0003');
    expect(bodies(await search(owner.cookie, 'cafe'))).toEqual(['The Café meeting is on Tuesday']);
  });

  it('never returns private messages to non-members, and guests never see public channels', async () => {
    const { owner, jaco } = await team();
    const secret = await channel(owner.cookie, 'secret', 'private');
    const pub = await channel(owner.cookie, 'general-chat', 'public');
    const client = await channel(owner.cookie, 'client', 'private');
    await post(owner.cookie, secret, 'confidential boundary details');
    await post(owner.cookie, pub, 'public boundary details');
    await post(owner.cookie, client, 'client boundary details');
    const guest = await addMember(owner.cookie, 'henk@example.com', 'guest', [client]);

    expect(bodies(await search(owner.cookie, 'boundary')).sort()).toEqual([
      'client boundary details',
      'confidential boundary details',
      'public boundary details',
    ]);
    expect(bodies(await search(jaco.cookie, 'boundary'))).toEqual(['public boundary details']);
    expect(bodies(await search(guest.cookie, 'boundary'))).toEqual(['client boundary details']);
  });

  it('stops finding a private channel’s messages after you leave it', async () => {
    const { owner, jaco } = await team();
    const team2 = await channel(owner.cookie, 'team', 'private');
    await api(`/api/conversations/${team2}/members`, {
      body: { userIds: [jaco.userId] },
      cookie: owner.cookie,
    });
    await post(owner.cookie, team2, 'roadmap draft');
    expect(bodies(await search(jaco.cookie, 'roadmap'))).toEqual(['roadmap draft']);
    await api(`/api/conversations/${team2}/leave`, { body: {}, cookie: jaco.cookie });
    expect(bodies(await search(jaco.cookie, 'roadmap'))).toEqual([]);
  });

  it('reflects edits and deletes straight away', async () => {
    const { owner } = await team();
    const ch = await channel(owner.cookie, 'edits', 'public');
    const msg = (await post(owner.cookie, ch, 'gate code is 4471')).json.message;
    await api(`/api/conversations/${ch}/messages/${msg.id}`, {
      method: 'PATCH',
      body: { body: 'gate code changed' },
      cookie: owner.cookie,
    });
    expect(bodies(await search(owner.cookie, '4471'))).toEqual([]);
    expect(bodies(await search(owner.cookie, 'changed'))).toEqual(['gate code changed']);
    await api(`/api/conversations/${ch}/messages/${msg.id}`, { method: 'DELETE', cookie: owner.cookie });
    expect(bodies(await search(owner.cookie, 'gate'))).toEqual([]);
  });

  it('filters by conversation, author, files and date', async () => {
    const { owner, jaco } = await team();
    const a = await channel(owner.cookie, 'alpha', 'public');
    const b = await channel(owner.cookie, 'beta', 'public');
    await api(`/api/conversations/${a}/join`, { body: {}, cookie: jaco.cookie });
    await post(owner.cookie, a, 'plan from owner');
    await post(jaco.cookie, a, 'plan from jaco');
    await post(owner.cookie, b, 'plan in beta');

    const q = (params: Record<string, string>) =>
      api(`/api/search?${new URLSearchParams({ q: 'plan', ...params }).toString()}`, {
        cookie: owner.cookie,
      });
    expect(bodies(await q({ in: b }))).toEqual(['plan in beta']);
    expect(bodies(await q({ from: jaco.userId }))).toEqual(['plan from jaco']);
    expect(bodies(await q({ before: '2000-01-01' }))).toEqual([]);
    expect(bodies(await q({ has: 'file' }))).toEqual([]);
  });

  it('survives hostile input without errors', async () => {
    const { owner } = await team();
    for (const q of ['"', "' OR 1=1 --", 'NEAR(a b)', '*', 'a" OR "b']) {
      const res = await search(owner.cookie, q);
      expect([200, 400]).toContain(res.status);
    }
    expect((await search(owner.cookie, '!!!')).status).toBe(400);
  });
});

describe('files, channels and people', () => {
  it('finds files by name only where you may see them', async () => {
    const { owner, jaco } = await team();
    const secret = await channel(owner.cookie, 'secret', 'private');
    const res = await exports.default.fetch(`${APP_URL}/api/conversations/${secret}/files`, {
      method: 'POST',
      body: new TextEncoder().encode('a,b\n1,2\n'),
      headers: {
        cookie: owner.cookie,
        origin: APP_URL,
        'content-length': '8',
        'x-file-name': 'salaries-2026.csv',
      },
    });
    const f = (await res.json<{ file: { id: string } }>()).file;
    await post(owner.cookie, secret, '', [f.id]);
    expect((await search(owner.cookie, 'salaries')).json.files.map((x: any) => x.name)).toEqual([
      'salaries-2026.csv',
    ]);
    expect((await search(jaco.cookie, 'salaries')).json.files).toEqual([]);
  });

  it('matches channel and people names literally, hiding private channels', async () => {
    const { owner, jaco } = await team();
    await channel(owner.cookie, 'harbour-house', 'public');
    await channel(owner.cookie, 'harbour-budget', 'private');
    const forJaco = await search(jaco.cookie, 'harbour');
    expect(forJaco.json.channels.map((c: any) => c.name)).toEqual(['harbour-house']);
    await api('/api/me', { method: 'PATCH', body: { name: 'Jaco Steyn' }, cookie: jaco.cookie });
    expect((await search(owner.cookie, 'steyn')).json.people.map((p: any) => p.name)).toEqual(['Jaco Steyn']);
  });

  it('treats % as a literal character in name search, not a wildcard', async () => {
    const { owner, jaco } = await team();
    await api('/api/me', { method: 'PATCH', body: { name: 'Room 500' }, cookie: owner.cookie });
    await api('/api/me', { method: 'PATCH', body: { name: '50% Partner' }, cookie: jaco.cookie });
    // Unescaped, '%50%%' would also match "Room 500".
    expect((await search(owner.cookie, '50%')).json.people.map((p: any) => p.name)).toEqual(['50% Partner']);
  });
});
