import { beforeEach, describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { APP_URL, addMember, api, resetDb, setupWorkspace } from './helpers';

type Frame = {
  type: string;
  seq?: number;
  userId?: string;
  online?: boolean;
  data?: any;
  [k: string]: unknown;
};

/** Opens a WebSocket through the Worker and records every frame and the close event. */
async function connect(path: string, cookie: string, origin: string | null = APP_URL) {
  const headers: Record<string, string> = { upgrade: 'websocket', cookie, 'cf-connecting-ip': '203.0.113.9' };
  if (origin) headers.origin = origin;
  const res = await exports.default.fetch(`${APP_URL}${path}`, { headers });
  const ws = res.webSocket;
  const frames: Frame[] = [];
  let closed: { code: number } | null = null;
  if (ws) {
    ws.accept();
    ws.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data)) as Frame));
    ws.addEventListener('close', (e) => (closed = { code: e.code }));
  }
  const waitFor = async (match: (f: Frame) => boolean, timeoutMs = 2000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = frames.find(match);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no matching frame; got ${JSON.stringify(frames.map((f) => f.type))}`);
  };
  const waitClosed = async (timeoutMs = 2000) => {
    const start = Date.now();
    while (!closed && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 10));
    return closed;
  };
  return {
    status: res.status,
    ws,
    frames,
    waitFor,
    waitClosed,
    send: (v: unknown) => ws?.send(JSON.stringify(v)),
  };
}

let n = 0;
const post = (cookie: string, id: string, body: string) =>
  api(`/api/conversations/${id}/messages`, {
    body: { body, clientMsgId: `rt-${Date.now()}-${n++}` },
    cookie,
  });

async function team() {
  const owner = await setupWorkspace();
  const ownerId = (await api('/api/me', { cookie: owner.cookie })).json.user.id as string;
  const jaco = await addMember(owner.cookie, 'jaco@example.com', 'member');
  const ch = (
    await api('/api/conversations', { body: { name: 'live', kind: 'public' }, cookie: owner.cookie })
  ).json.conversation.id as string;
  await api(`/api/conversations/${ch}/join`, { body: {}, cookie: jaco.cookie });
  return { owner: { ...owner, userId: ownerId }, jaco, ch };
}

beforeEach(resetDb);

describe('conversation sockets: who may connect', () => {
  it('refuses plain HTTP, other origins, strangers and non-members', async () => {
    const { owner, jaco } = await team();
    const secret = (
      await api('/api/conversations', { body: { name: 'secret', kind: 'private' }, cookie: owner.cookie })
    ).json.conversation.id as string;

    const plain = await api(`/api/realtime/conversations/${secret}/socket`, { cookie: owner.cookie });
    expect(plain.status).toBe(426);
    expect(
      (await connect(`/api/realtime/conversations/${secret}/socket`, owner.cookie, 'https://evil.example'))
        .status,
    ).toBe(403);
    expect((await connect(`/api/realtime/conversations/${secret}/socket`, owner.cookie, null)).status).toBe(
      403,
    );
    expect((await connect(`/api/realtime/conversations/${secret}/socket`, '')).status).toBe(401);
    expect((await connect(`/api/realtime/conversations/${secret}/socket`, jaco.cookie)).status).toBe(404);
  });
});

describe('conversation sockets: delivery', () => {
  it('delivers a new message live, after it is saved', async () => {
    const { owner, jaco, ch } = await team();
    const sock = await connect(`/api/realtime/conversations/${ch}/socket?after=999`, jaco.cookie);
    expect(sock.status).toBe(101);
    await sock.waitFor((f) => f.type === 'ready');
    const sent = await post(owner.cookie, ch, 'Kitchen section is up');
    const event = await sock.waitFor((f) => f.type === 'message.created');
    expect(event.seq).toBe(sent.json.message.seq);
    expect(event.data.message.body).toBe('Kitchen section is up');
  });

  it('replays exactly what was missed, in order, then goes live', async () => {
    const { owner, jaco, ch } = await team();
    const first = (await post(owner.cookie, ch, 'one')).json.message.seq as number;
    await post(owner.cookie, ch, 'two');
    await post(owner.cookie, ch, 'three');

    const sock = await connect(`/api/realtime/conversations/${ch}/socket?after=${first}`, jaco.cookie);
    const ready = await sock.waitFor((f) => f.type === 'ready');
    const replayed = sock.frames.filter((f) => f.type === 'message.created').map((f) => f.data.message.body);
    expect(replayed).toEqual(['two', 'three']);
    expect(sock.frames.at(-1)?.type).toBe('ready');
    expect(ready.lastSeq).toBe(first + 2);

    const upToDate = await connect(
      `/api/realtime/conversations/${ch}/socket?after=${first + 2}`,
      jaco.cookie,
    );
    await upToDate.waitFor((f) => f.type === 'ready');
    expect(upToDate.frames.map((f) => f.type)).toEqual(['ready']);
  });

  it('relays typing to others, not back to the typist, at most every 3 seconds', async () => {
    const { owner, jaco, ch } = await team();
    const ownerSock = await connect(`/api/realtime/conversations/${ch}/socket?after=999`, owner.cookie);
    const jacoSock = await connect(`/api/realtime/conversations/${ch}/socket?after=999`, jaco.cookie);
    await ownerSock.waitFor((f) => f.type === 'ready');
    await jacoSock.waitFor((f) => f.type === 'ready');

    jacoSock.send({ type: 'typing' });
    jacoSock.send({ type: 'typing' });
    const typing = await ownerSock.waitFor((f) => f.type === 'typing');
    expect(typing.userId).toBe(jaco.userId);
    await new Promise((r) => setTimeout(r, 100));
    expect(ownerSock.frames.filter((f) => f.type === 'typing')).toHaveLength(1);
    expect(jacoSock.frames.some((f) => f.type === 'typing')).toBe(false);
  });

  it('ignores oversized or unknown frames from clients', async () => {
    const { owner, jaco, ch } = await team();
    const ownerSock = await connect(`/api/realtime/conversations/${ch}/socket?after=999`, owner.cookie);
    const jacoSock = await connect(`/api/realtime/conversations/${ch}/socket?after=999`, jaco.cookie);
    await ownerSock.waitFor((f) => f.type === 'ready');
    await jacoSock.waitFor((f) => f.type === 'ready');
    jacoSock.ws?.send('x'.repeat(5000));
    jacoSock.send({ type: 'message.created', data: { message: { body: 'forged' } } });
    await new Promise((r) => setTimeout(r, 150));
    expect(ownerSock.frames.map((f) => f.type)).toEqual(['ready']);
  });

  it('closes a member’s socket the moment they are removed from the channel', async () => {
    const { owner, jaco, ch } = await team();
    const sock = await connect(`/api/realtime/conversations/${ch}/socket?after=999`, jaco.cookie);
    await sock.waitFor((f) => f.type === 'ready');
    await api(`/api/conversations/${ch}/members/${jaco.userId}`, { method: 'DELETE', cookie: owner.cookie });
    expect((await sock.waitClosed())?.code).toBe(4003);
  });
});

describe('workspace hub', () => {
  it('shares who is online and announces arrivals', async () => {
    const { owner, jaco } = await team();
    const jacoHub = await connect('/api/realtime/socket', jaco.cookie);
    const snapshot = await jacoHub.waitFor((f) => f.type === 'presence.snapshot');
    expect(snapshot.online).toEqual([jaco.userId]);
    await connect('/api/realtime/socket', owner.cookie);
    const arrival = await jacoHub.waitFor((f) => f.type === 'presence' && f.userId === owner.userId);
    expect(arrival.online).toBe(true);
  });

  it('pings members (not the author) when a conversation gets a new message', async () => {
    const { owner, jaco, ch } = await team();
    const jacoHub = await connect('/api/realtime/socket', jaco.cookie);
    const ownerHub = await connect('/api/realtime/socket', owner.cookie);
    await jacoHub.waitFor((f) => f.type === 'presence.snapshot');
    await ownerHub.waitFor((f) => f.type === 'presence.snapshot');
    await post(owner.cookie, ch, 'badge please');
    const ping = await jacoHub.waitFor((f) => f.type === 'activity');
    expect(ping.conversationId).toBe(ch);
    await new Promise((r) => setTimeout(r, 100));
    expect(ownerHub.frames.some((f) => f.type === 'activity')).toBe(false);
  });

  it('does not ping people who are not in the conversation', async () => {
    const { owner, jaco } = await team();
    const secret = (
      await api('/api/conversations', { body: { name: 'secret', kind: 'private' }, cookie: owner.cookie })
    ).json.conversation.id as string;
    const jacoHub = await connect('/api/realtime/socket', jaco.cookie);
    await jacoHub.waitFor((f) => f.type === 'presence.snapshot');
    await post(owner.cookie, secret, 'not for Jaco');
    await new Promise((r) => setTimeout(r, 150));
    expect(jacoHub.frames.some((f) => f.type === 'activity')).toBe(false);
  });

  it('cuts every live connection when a member is deactivated', async () => {
    const { owner, jaco, ch } = await team();
    const hub = await connect('/api/realtime/socket', jaco.cookie);
    const room = await connect(`/api/realtime/conversations/${ch}/socket?after=999`, jaco.cookie);
    await hub.waitFor((f) => f.type === 'presence.snapshot');
    await room.waitFor((f) => f.type === 'ready');
    await api(`/api/members/${jaco.userId}/deactivate`, { body: {}, cookie: owner.cookie });
    expect((await hub.waitClosed())?.code).toBe(4003);
    expect((await room.waitClosed())?.code).toBe(4003);
  });
});
