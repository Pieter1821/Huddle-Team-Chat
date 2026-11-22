// The duplicate-delivery guarantees from the second PR #1 review: a digest is claimed before it is
// sent, concurrent jobs cannot both send it, and retries resend the identical email with the same
// idempotency key.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { getConfig } from '../src/worker/config';
import { getDb } from '../src/worker/db/client';
import { useEmailTransport, type Email } from '../src/worker/lib/email';
import { sendDigest } from '../src/worker/modules/notifications/digest';
import { addMember, api, resetDb, setupWorkspace } from './helpers';

const db = getDb(env);
const config = getConfig(env);
const HOUR = 3_600_000;
const MIN = 60_000;

type Sent = { email: Email & { from: string }; key: string | undefined };
let sent: Sent[] = [];
let failNext = false;

/** A fake provider: records every delivery and the idempotency key it was given. */
const installFakeTransport = () =>
  useEmailTransport((email, { idempotencyKey }) => {
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error('provider timed out'));
    }
    sent.push({ email, key: idempotencyKey });
    return Promise.resolve();
  });

beforeEach(async () => {
  await resetDb();
  sent = [];
  failNext = false;
});
afterEach(() => useEmailTransport(null));

let n = 0;
async function jacoWithPendingMention() {
  const owner = await setupWorkspace();
  const jaco = await addMember(owner.cookie, 'jaco@example.com', 'member');
  const ch = (
    await api('/api/conversations', { body: { name: 'project', kind: 'public' }, cookie: owner.cookie })
  ).json.conversation.id as string;
  await api(`/api/conversations/${ch}/join`, { body: {}, cookie: jaco.cookie });
  await api(`/api/conversations/${ch}/messages`, {
    body: { body: `<@${jaco.userId}> please check`, clientMsgId: `dc-${Date.now()}-${n++}` },
    cookie: owner.cookie,
  });
  await env.DB.prepare('UPDATE notification SET created_at = created_at - ?')
    .bind(3 * HOUR)
    .run();
  // Sign-in codes are read from the terminal during setup; the fake provider only takes over now.
  installFakeTransport();
  return jaco;
}
const digests = () => sent.filter((s) => s.email.to === 'jaco@example.com');
const pending = async () =>
  (
    await env.DB.prepare('SELECT count(*) AS n FROM notification WHERE emailed_at IS NULL').first<{
      n: number;
    }>()
  )?.n;

describe('claiming a digest before sending it', () => {
  it('two jobs for the same person at the same moment send exactly one email', async () => {
    const jaco = await jacoWithPendingMention();
    const results = await Promise.all([
      sendDigest(db, config, jaco.userId),
      sendDigest(db, config, jaco.userId),
    ]);
    expect(results.sort()).toEqual(['nothing', 'sent']);
    expect(digests()).toHaveLength(1);
  });

  it('sends with an idempotency key tied to the claim', async () => {
    const jaco = await jacoWithPendingMention();
    await sendDigest(db, config, jaco.userId);
    expect(digests()[0]?.key).toMatch(/^huddle-digest-[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('retries', () => {
  it('after a crash between sending and marking, resends the identical email with the same key', async () => {
    const jaco = await jacoWithPendingMention();
    const now = new Date();
    expect(await sendDigest(db, config, jaco.userId, now)).toBe('sent');
    // Simulate the database write after a successful send never happening.
    await env.DB.prepare('UPDATE notification SET emailed_at = NULL').run();
    await env.DB.prepare('DELETE FROM user_preference').run();

    // A job straight away leaves the in-flight claim alone and sends nothing.
    expect(await sendDigest(db, config, jaco.userId, new Date(now.getTime() + MIN))).toBe('nothing');
    // The retry, later, sends the same content with the same key, so a provider that honours
    // idempotency keys delivers it only once.
    expect(await sendDigest(db, config, jaco.userId, new Date(now.getTime() + 20 * MIN))).toBe('sent');
    const [first, retry] = digests();
    expect(retry?.key).toBe(first?.key);
    expect(retry?.email).toEqual(first?.email);
    expect(await pending()).toBe(0);
  });

  it('a failed send keeps the claim, and the retry reuses it', async () => {
    const jaco = await jacoWithPendingMention();
    const now = new Date();
    failNext = true;
    await expect(sendDigest(db, config, jaco.userId, now)).rejects.toThrow('provider timed out');
    const claimed = await env.DB.prepare('SELECT digest_id AS d FROM notification').first<{
      d: string | null;
    }>();
    expect(claimed?.d).toBeTruthy();

    expect(await sendDigest(db, config, jaco.userId, new Date(now.getTime() + 20 * MIN))).toBe('sent');
    expect(digests()[0]?.key).toBe(`huddle-digest-${claimed?.d}`);
  });

  it('a claim stuck for nearly a day is released and claimed afresh with a new key', async () => {
    const jaco = await jacoWithPendingMention();
    const now = new Date();
    failNext = true;
    await expect(sendDigest(db, config, jaco.userId, now)).rejects.toThrow();
    const old = await env.DB.prepare('SELECT digest_id AS d FROM notification').first<{ d: string }>();

    // A day later the old claim (and its key) is too old to trust: it is released, claimed afresh and
    // sent with a new key, rather than leaving the notification stuck forever.
    expect(await sendDigest(db, config, jaco.userId, new Date(now.getTime() + 24 * HOUR))).toBe('sent');
    expect(digests()[0]?.key).not.toBe(`huddle-digest-${old?.d}`);
    expect(await pending()).toBe(0);
  });
});

describe('budget and claims', () => {
  it('over budget releases a fresh claim so the notifications return the next day', async () => {
    const jaco = await jacoWithPendingMention();
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      'INSERT INTO email_usage (day, sent) VALUES (?, 80) ON CONFLICT(day) DO UPDATE SET sent = 80',
    )
      .bind(today)
      .run();
    expect(await sendDigest(db, config, jaco.userId)).toBe('over_budget');
    const row = await env.DB.prepare('SELECT digest_id AS d FROM notification').first<{ d: string | null }>();
    expect(row?.d).toBeNull();
    expect(digests()).toHaveLength(0);
  });
});
