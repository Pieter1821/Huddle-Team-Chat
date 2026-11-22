import { beforeEach, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { CHARCOAL, contrastRatio } from '../src/shared/color';
import { APP_URL, addMember, api, resetDb, setupWorkspace } from './helpers';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

const putLogo = (cookie: string, bytes: Uint8Array, length?: number) =>
  exports.default.fetch(`${APP_URL}/api/workspace/logo`, {
    method: 'PUT',
    body: bytes,
    headers: { cookie, origin: APP_URL, 'content-length': String(length ?? bytes.byteLength) },
  });

/** Calls an incoming webhook the way another tool would: no cookie, no Origin. */
const hook = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  exports.default.fetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });

beforeEach(resetDb);

describe('colour contrast', () => {
  it('matches the WCAG formula', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#00b18c', '#00b18c')).toBe(1);
    expect(contrastRatio('#00b18c', CHARCOAL)).toBeGreaterThan(4.5);
  });
});

describe('branding', () => {
  it('is public, so the sign-in page can show it before anyone signs in', async () => {
    const before = await api('/api/branding');
    expect(before.json).toEqual({ name: 'Huddle', accent: '#00b18c', logoUrl: null });
    await setupWorkspace('Brightwater Studio');
    expect((await api('/api/branding')).json.name).toBe('Brightwater Studio');
  });

  it('accepts accents that keep button text readable and refuses ones that do not', async () => {
    const { cookie } = await setupWorkspace();
    const set = (accent: unknown) => api('/api/workspace', { method: 'PATCH', body: { accent }, cookie });
    expect((await set('#FFB020')).status).toBe(200);
    expect((await api('/api/branding')).json.accent).toBe('#ffb020');
    expect((await set('#1a3a6b')).status).toBe(400); // dark navy: unreadable dark text on it
    expect((await set('teal')).status).toBe(400);
    expect((await set(null)).status).toBe(200);
    expect((await api('/api/branding')).json.accent).toBe('#00b18c');
  });

  it('lets only owners and admins change it', async () => {
    const owner = await setupWorkspace();
    const member = await addMember(owner.cookie, 'jaco@example.com', 'member');
    expect(
      (await api('/api/workspace', { method: 'PATCH', body: { accent: '#ffb020' }, cookie: member.cookie }))
        .status,
    ).toBe(403);
    expect((await putLogo(member.cookie, PNG)).status).toBe(403);
  });
});

describe('logo', () => {
  it('uploads a PNG and serves it publicly with a cache-busting URL', async () => {
    const { cookie } = await setupWorkspace();
    const res = await putLogo(cookie, PNG);
    expect(res.status).toBe(200);
    const { logoUrl } = await res.json<{ logoUrl: string }>();
    expect((await api('/api/branding')).json.logoUrl).toBe(logoUrl);

    const logo = await exports.default.fetch(`${APP_URL}${logoUrl}`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(PNG);
  });

  it('refuses SVG (it can carry scripts) and anything over 1 MB', async () => {
    const { cookie } = await setupWorkspace();
    expect((await putLogo(cookie, SVG)).status).toBe(415);
    expect((await putLogo(cookie, PNG, 2 * 1024 * 1024)).status).toBe(413);
  });

  it('removes the old image when replaced, and can be removed', async () => {
    const { cookie } = await setupWorkspace();
    await putLogo(cookie, PNG);
    const first = (await env.DB.prepare('SELECT logo_file_id AS k FROM workspace').first<{ k: string }>())!.k;
    await putLogo(cookie, PNG);
    expect(await env.FILES.get(first)).toBeNull();
    expect((await api('/api/workspace/logo', { method: 'DELETE', cookie })).status).toBe(204);
    expect((await api('/api/branding')).json.logoUrl).toBeNull();
  });
});

describe('incoming webhooks', () => {
  async function setupHook(kind: 'public' | 'private' = 'public') {
    const owner = await setupWorkspace();
    const ch = (await api('/api/conversations', { body: { name: 'alerts', kind }, cookie: owner.cookie }))
      .json.conversation.id as string;
    const created = await api(`/api/conversations/${ch}/webhooks`, {
      body: { name: 'Uptime monitor' },
      cookie: owner.cookie,
    });
    return { owner, ch, created, url: created.json.url as string };
  }

  it('posts a message from a named bot, with no session needed', async () => {
    const { owner, ch, created, url } = await setupHook();
    expect(created.status).toBe(201);
    expect(url).toMatch(/^http:\/\/localhost:8787\/api\/hooks\/[0-9A-Z]{26}\/[A-Za-z0-9_-]{43}$/);
    const res = await hook(url, { text: 'Site is down: example.com (502)' });
    expect(res.status).toBe(201);

    const history = await api(`/api/conversations/${ch}/messages`, { cookie: owner.cookie });
    const msg = history.json.messages.at(-1);
    expect(msg.body).toBe('Site is down: example.com (502)');
    expect(msg.authorId).toBeNull();
    expect(msg.webhookName).toBe('Uptime monitor');
  });

  it('refuses wrong tokens, unknown ids and revoked webhooks with the same 404', async () => {
    const { owner, url, created } = await setupHook();
    const tokenless = url.replace(/\/[^/]+$/, '/not-the-token-at-all-0000000000000000000000');
    expect((await hook(tokenless, { text: 'x' })).status).toBe(404);
    expect(
      (await hook(`${APP_URL}/api/hooks/01NOPE00000000000000000000/${url.split('/').pop()}`, { text: 'x' }))
        .status,
    ).toBe(404);
    await api(`/api/webhooks/${created.json.webhook.id}`, { method: 'DELETE', cookie: owner.cookie });
    expect((await hook(url, { text: 'x' })).status).toBe(404);
  });

  it('stores only a hash of the token', async () => {
    const { url } = await setupHook();
    const row = await env.DB.prepare('SELECT token_hash FROM webhook').first<{ token_hash: string }>();
    expect(url.endsWith(row!.token_hash)).toBe(false);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('turns retries with the same Idempotency-Key into one message', async () => {
    const { owner, ch, url } = await setupHook();
    const headers = { 'idempotency-key': 'deploy-4711-done' };
    const first = await hook(url, { text: 'Deploy 4711 finished' }, headers);
    const again = await hook(url, { text: 'Deploy 4711 finished' }, headers);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect((await again.json<{ id: string }>()).id).toBe((await first.json<{ id: string }>()).id);
    const history = await api(`/api/conversations/${ch}/messages`, { cookie: owner.cookie });
    expect(history.json.messages.filter((m: any) => m.webhookId)).toHaveLength(1);
  });

  it('limits each webhook to 30 messages a minute', async () => {
    const { url } = await setupHook();
    for (let i = 0; i < 30; i++) expect((await hook(url, { text: `alert ${i}` })).status).toBe(201);
    const limited = await hook(url, { text: 'one too many' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });

  it('refuses posts to an archived channel, and empty text', async () => {
    const { owner, ch, url } = await setupHook();
    expect((await hook(url, { text: '   ' })).status).toBe(400);
    await api(`/api/conversations/${ch}/archive`, { body: {}, cookie: owner.cookie });
    expect((await hook(url, { text: 'hello?' })).status).toBe(409);
  });

  it('is managed by admins only, for channels only', async () => {
    const { owner, ch } = await setupHook();
    const member = await addMember(owner.cookie, 'jaco@example.com', 'member');
    await api(`/api/conversations/${ch}/join`, { body: {}, cookie: member.cookie });
    expect(
      (await api(`/api/conversations/${ch}/webhooks`, { body: { name: 'x' }, cookie: member.cookie })).status,
    ).toBe(403);
    expect((await api(`/api/conversations/${ch}/webhooks`, { cookie: member.cookie })).status).toBe(403);
    const list = await api(`/api/conversations/${ch}/webhooks`, { cookie: owner.cookie });
    expect(list.json.webhooks.map((w: any) => w.name)).toEqual(['Uptime monitor']);

    const dm = (
      await api('/api/conversations/dm', { body: { userIds: [member.userId] }, cookie: owner.cookie })
    ).json.conversation.id as string;
    expect(
      (await api(`/api/conversations/${dm}/webhooks`, { body: { name: 'x' }, cookie: owner.cookie })).status,
    ).toBe(400);
  });
});

describe('guests in a conversation', () => {
  it('are counted in the conversation details, for the "outsiders present" banner', async () => {
    const owner = await setupWorkspace();
    const ch = (
      await api('/api/conversations', { body: { name: 'client', kind: 'private' }, cookie: owner.cookie })
    ).json.conversation.id as string;
    expect((await api(`/api/conversations/${ch}`, { cookie: owner.cookie })).json.guestCount).toBe(0);
    await addMember(owner.cookie, 'henk@example.com', 'guest', [ch]);
    const details = await api(`/api/conversations/${ch}`, { cookie: owner.cookie });
    expect(details.json.guestCount).toBe(1);
    expect(details.json.members.map((m: any) => m.role).sort()).toEqual(['guest', 'owner']);
  });
});
