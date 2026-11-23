import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { getConfig } from '../src/worker/config';
import { getDb } from '../src/worker/db/client';
import { vapidKeys } from '../src/worker/modules/push/keys';
import { previewText, sendPushJob, type PushPayload } from '../src/worker/modules/push/send';
import { b64url, encryptPayload, isPushEndpoint, vapidAuthorization } from '../src/worker/lib/web-push';
import { addMember, api, resetDb, setupWorkspace } from './helpers';

const db = getDb(env);
const config = getConfig(env);
const enc = new TextEncoder();

/** A browser's side of push: its key pair and secret, and the ability to read what it receives. */
async function fakeBrowser(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`) {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer);
  const secret = crypto.getRandomValues(new Uint8Array(16));
  const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info },
        await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']),
        len * 8,
      ),
    );
  return {
    subscription: { endpoint, keys: { p256dh: b64url.encode(publicRaw), auth: b64url.encode(secret) } },
    /** Decrypts an aes128gcm body the way a browser does (RFC 8291), independently of the sender code. */
    async read(body: Uint8Array): Promise<string> {
      const salt = body.slice(0, 16);
      const idLen = body[20]!;
      const senderPublic = body.slice(21, 21 + idLen);
      const sender = await crypto.subtle.importKey(
        'raw',
        senderPublic,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      );
      const shared = new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: 'ECDH', public: sender } as unknown as SubtleCryptoDeriveKeyAlgorithm,
          keys.privateKey,
          256,
        ),
      );
      const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...publicRaw, ...senderPublic]);
      const ikm = await hkdf(secret, shared, info, 32);
      const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: nonce },
          await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']),
          body.slice(21 + idLen),
        ),
      );
      expect(plain.at(-1)).toBe(2); // the "last record" delimiter
      return new TextDecoder().decode(plain.slice(0, -1));
    },
  };
}

type Sent = { url: string; init: RequestInit };
/** Stands in for the push services, answering every request with `status`. */
function pushService(status = 201) {
  const sent: Sent[] = [];
  const send = vi.fn((url: string, init: RequestInit) => {
    sent.push({ url, init });
    return Promise.resolve(new Response(null, { status }));
  });
  return { sent, send };
}

let n = 0;
const post = (cookie: string, id: string, body: string, extra: Record<string, unknown> = {}) =>
  api(`/api/conversations/${id}/messages`, {
    body: { body, clientMsgId: `p-${Date.now()}-${n++}`, ...extra },
    cookie,
  });

async function team() {
  const owner = await setupWorkspace();
  const jaco = await addMember(owner.cookie, 'jaco@example.com', 'member');
  await api('/api/me', { method: 'PATCH', body: { name: 'Jaco Steyn' }, cookie: jaco.cookie });
  const ch = (
    await api('/api/conversations', { body: { name: 'project', kind: 'public' }, cookie: owner.cookie })
  ).json.conversation.id as string;
  await api(`/api/conversations/${ch}/join`, { body: {}, cookie: jaco.cookie });
  const phone = await fakeBrowser();
  const res = await api('/api/push/subscriptions', { body: phone.subscription, cookie: jaco.cookie });
  expect(res.status).toBe(201);
  return { owner, jaco, ch, phone };
}

/** Posts as the owner and runs the push job directly, returning what Jaco's phone would show. */
async function mentionJaco(t: Awaited<ReturnType<typeof team>>, text = 'can you check this?') {
  const msg = (await post(t.owner.cookie, t.ch, `<@${t.jaco.userId}> ${text}`)).json.message;
  const service = pushService();
  const result = await sendPushJob(
    db,
    config,
    { type: 'push', messageId: msg.id, userIds: [t.jaco.userId] },
    service.send,
  );
  return { msg, result, service };
}

beforeEach(async () => {
  await resetDb();
  // The real queue consumer also runs during these tests; keep its requests off the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(null, { status: 201 }))),
  );
  return () => vi.unstubAllGlobals();
});

describe('web push encryption and signing', () => {
  it('encrypts so that only the browser can read it (RFC 8291)', async () => {
    const browser = await fakeBrowser();
    const body = await encryptPayload(
      enc.encode('{"title":"hi"}'),
      browser.subscription.keys.p256dh,
      browser.subscription.keys.auth,
    );
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096); // record size
    expect(body[20]).toBe(65); // the one-off public key follows
    expect(await browser.read(body)).toBe('{"title":"hi"}');

    // Every message uses a fresh key and salt, so the same text never encrypts the same way twice.
    const again = await encryptPayload(
      enc.encode('{"title":"hi"}'),
      browser.subscription.keys.p256dh,
      browser.subscription.keys.auth,
    );
    expect(b64url.encode(again)).not.toBe(b64url.encode(body));
  });

  it('signs a VAPID token the push service can verify', async () => {
    const keys = await vapidKeys(db, config.authSecret);
    const header = await vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/abc',
      keys,
      'https://chat.example.com',
      Date.UTC(2030, 0, 1),
    );
    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(keys.publicKey);
    const [h, c, s] = token!.split('.');
    const claims = JSON.parse(new TextDecoder().decode(b64url.decode(c!)));
    expect(claims).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: Date.UTC(2030, 0, 1) / 1000 + 12 * 3600,
      sub: 'https://chat.example.com',
    });
    const publicKey = await crypto.subtle.importKey(
      'raw',
      b64url.decode(keys.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        b64url.decode(s!),
        enc.encode(`${h}.${c}`),
      ),
    ).toBe(true);
  });

  it('keeps one signing key, stored sealed, and replaces it if the server secret changes', async () => {
    const first = await vapidKeys(db, config.authSecret);
    expect((await vapidKeys(db, config.authSecret)).publicKey).toBe(first.publicKey);
    const row = await env.DB.prepare('SELECT private_key AS k FROM push_key').first<{ k: string }>();
    expect(row?.k).not.toContain('"d"'); // the private JWK is not readable in the database

    const replaced = await vapidKeys(db, 'a-different-secret-that-is-also-long-enough');
    expect(replaced.publicKey).not.toBe(first.publicKey);
  });

  it('only talks to known push services', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/QGx')).toBe(true);
    expect(isPushEndpoint('https://wns2-db5p.notify.windows.com/w/?token=abc')).toBe(true);
    expect(isPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(isPushEndpoint('https://fcm.googleapis.com.evil.test/x')).toBe(false);
    expect(isPushEndpoint('https://evilpush.apple.com.attacker.test/x')).toBe(false);
    expect(isPushEndpoint('https://user:pw@fcm.googleapis.com/x')).toBe(false);
    expect(isPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(isPushEndpoint('https://169.254.169.254/latest')).toBe(false);
    expect(isPushEndpoint('not a url')).toBe(false);
  });

  it('turns mention tokens into names in the preview and keeps it short', () => {
    const names = new Map([['01HZY2X3V4W5Q6R7S8T9V0W1X2', 'Jaco Steyn']]);
    expect(previewText('hey <@01HZY2X3V4W5Q6R7S8T9V0W1X2> and <@here>', names)).toBe(
      'hey @Jaco Steyn and @here',
    );
    expect(previewText('x'.repeat(500), names)).toHaveLength(180);
    expect(previewText('', names)).toBe('Shared a file');
  });
});

describe('device subscriptions', () => {
  it('needs a signed-in member and hands out the public key', async () => {
    expect((await api('/api/push/key')).status).toBe(401);
    const owner = await setupWorkspace();
    const res = await api('/api/push/key', { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(b64url.decode(res.json.publicKey).byteLength).toBe(65);
  });

  it('refuses endpoints that are not push services, and bad keys', async () => {
    const owner = await setupWorkspace();
    const browser = await fakeBrowser();
    for (const endpoint of ['https://attacker.test/collect', 'http://fcm.googleapis.com/fcm/send/x']) {
      const res = await api('/api/push/subscriptions', {
        body: { ...browser.subscription, endpoint },
        cookie: owner.cookie,
      });
      expect(res.status).toBe(400);
    }
    const res = await api('/api/push/subscriptions', {
      body: { ...browser.subscription, keys: { p256dh: 'short', auth: 'x' } },
      cookie: owner.cookie,
    });
    expect(res.status).toBe(400);
    // The right length, but not a point on the curve.
    const notAPoint = await api('/api/push/subscriptions', {
      body: { ...browser.subscription, keys: { ...browser.subscription.keys, p256dh: `B${'A'.repeat(86)}` } },
      cookie: owner.cookie,
    });
    expect(notAPoint.status).toBe(400);
  });

  it('saves a device once, moves it to whoever subscribes it, and removes it', async () => {
    const t = await team();
    // The same browser subscribing again (or for another person who signs in there) is one row.
    await api('/api/push/subscriptions', { body: t.phone.subscription, cookie: t.owner.cookie });
    const rows = await env.DB.prepare('SELECT user_id AS u FROM push_subscription').all<{ u: string }>();
    expect(rows.results).toHaveLength(1);
    const ownerId = (await api('/api/me', { cookie: t.owner.cookie })).json.user.id;
    expect(rows.results[0]!.u).toBe(ownerId);

    const removed = await api('/api/push/subscriptions/remove', {
      body: { endpoint: t.phone.subscription.endpoint },
      cookie: t.owner.cookie,
    });
    expect(removed.status).toBe(204);
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS c FROM push_subscription').first<{ c: number }>())?.c,
    ).toBe(0);
  });

  it('keeps at most ten devices per person', async () => {
    const owner = await setupWorkspace();
    for (let i = 0; i < 12; i++) {
      const b = await fakeBrowser();
      await api('/api/push/subscriptions', { body: b.subscription, cookie: owner.cookie });
    }
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS c FROM push_subscription').first<{ c: number }>())?.c,
    ).toBe(10);
  });

  it('only sends a test to a device of your own', async () => {
    const t = await team();
    const res = await api('/api/push/test', {
      body: { endpoint: t.phone.subscription.endpoint },
      cookie: t.owner.cookie,
    });
    expect(res.status).toBe(404);
  });
});

describe('sending pushes for new messages', () => {
  it('pushes a mention, readable only by the device, with a link to the message', async () => {
    const t = await team();
    const { msg, result, service } = await mentionJaco(t);
    expect(result).toEqual({ sent: 1, gone: 0, failed: 0 });
    const [req] = service.sent;
    expect(req!.url).toBe(t.phone.subscription.endpoint);
    const headers = new Headers(req!.init.headers);
    expect(headers.get('content-encoding')).toBe('aes128gcm');
    expect(headers.get('authorization')).toMatch(/^vapid t=/);
    expect(headers.get('ttl')).toBe('86400');
    const payload = JSON.parse(await t.phone.read(req!.init.body as Uint8Array)) as PushPayload;
    expect(payload).toEqual({
      title: 'Thandi Nkosi in #project',
      body: '@Jaco Steyn can you check this?',
      url: `/c/${t.ch}/m/${msg.id}`,
      tag: t.ch,
    });
  });

  it('links thread replies to the thread', async () => {
    const t = await team();
    const parent = (await post(t.jaco.cookie, t.ch, 'plan for Friday')).json.message;
    const reply = (await post(t.owner.cookie, t.ch, 'looks good', { parentId: parent.id })).json.message;
    const service = pushService();
    await sendPushJob(
      db,
      config,
      { type: 'push', messageId: reply.id, userIds: [t.jaco.userId] },
      service.send,
    );
    const payload = JSON.parse(await t.phone.read(service.sent[0]!.init.body as Uint8Array)) as PushPayload;
    expect(payload.title).toBe('Thandi Nkosi replied in a thread in #project');
    expect(payload.url).toBe(`/c/${t.ch}/t/${parent.id}`);
  });

  it('sends nothing when muted, on Do Not Disturb, already read, or signed out', async () => {
    const t = await team();
    await api(`/api/conversations/${t.ch}/notifications`, {
      method: 'PATCH',
      body: { level: 'muted' },
      cookie: t.jaco.cookie,
    });
    expect((await mentionJaco(t)).result.sent).toBe(0);
    await api(`/api/conversations/${t.ch}/notifications`, {
      method: 'PATCH',
      body: { level: 'all' },
      cookie: t.jaco.cookie,
    });

    await api('/api/me/preferences', {
      method: 'PATCH',
      body: { pausedUntil: new Date(Date.now() + 3_600_000).toISOString() },
      cookie: t.jaco.cookie,
    });
    expect((await mentionJaco(t)).result.sent).toBe(0);
    await api('/api/me/preferences', { method: 'PATCH', body: { pausedUntil: null }, cookie: t.jaco.cookie });

    const read = (await post(t.owner.cookie, t.ch, `<@${t.jaco.userId}> seen it?`)).json.message;
    await api(`/api/conversations/${t.ch}/read`, { body: { seq: read.seq }, cookie: t.jaco.cookie });
    const service = pushService();
    expect(
      (
        await sendPushJob(
          db,
          config,
          { type: 'push', messageId: read.id, userIds: [t.jaco.userId] },
          service.send,
        )
      ).sent,
    ).toBe(0);

    expect((await mentionJaco(t)).result.sent).toBe(1);
    // Signing out ends the session, and the device subscription goes with it.
    await api('/api/auth/sign-out', { body: {}, cookie: t.jaco.cookie });
    expect((await mentionJaco(t)).result.sent).toBe(0);
  });

  it('forgets a device the push service says is gone', async () => {
    const t = await team();
    const msg = (await post(t.owner.cookie, t.ch, `<@${t.jaco.userId}> hello`)).json.message;
    const gone = pushService(410);
    const result = await sendPushJob(
      db,
      config,
      { type: 'push', messageId: msg.id, userIds: [t.jaco.userId] },
      gone.send,
    );
    expect(result).toEqual({ sent: 0, gone: 1, failed: 0 });
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS c FROM push_subscription').first<{ c: number }>())?.c,
    ).toBe(0);
  });

  it('queues the push when the message is sent, and the queue delivers it', async () => {
    const t = await team();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    await post(t.owner.cookie, t.ch, `<@${t.jaco.userId}> are you there?`);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 5000 });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(t.phone.subscription.endpoint);
    const payload = JSON.parse(await t.phone.read(init.body as Uint8Array)) as PushPayload;
    expect(payload.body).toBe('@Jaco Steyn are you there?');
  });
});
