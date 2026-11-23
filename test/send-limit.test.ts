import { beforeEach, describe, expect, it } from 'vitest';
import { SEND_BURST, takeSend } from '../src/worker/realtime/workspace-hub';
import { addMember, api, resetDb, setupWorkspace } from './helpers';

describe('the send limit rule', () => {
  it('allows a burst of 60, then one a second', () => {
    let bucket;
    for (let i = 0; i < SEND_BURST; i++) {
      const r = takeSend(bucket, 1_000);
      expect(r.allowed).toBe(true);
      bucket = r.bucket;
    }
    const blocked = takeSend(bucket, 1_000);
    expect(blocked).toMatchObject({ allowed: false, retryAfter: 1 });
    expect(takeSend(blocked.bucket, 1_500).allowed).toBe(false);
    const later = takeSend(blocked.bucket, 2_000);
    expect(later.allowed).toBe(true);
    expect(takeSend(later.bucket, 2_000).allowed).toBe(false);
  });

  it('refills to a full burst after a quiet minute, never beyond', () => {
    let bucket = { tokens: 0, at: 0 };
    bucket = takeSend(bucket, 60_000).bucket;
    expect(bucket.tokens).toBe(SEND_BURST - 1);
    expect(takeSend({ tokens: 0, at: 0 }, 10 * 60_000).bucket.tokens).toBe(SEND_BURST - 1);
  });
});

describe('sending too fast', () => {
  beforeEach(() => resetDb());

  it('refuses messages beyond the burst with 429 and Retry-After, per person', async () => {
    const owner = await setupWorkspace();
    const jaco = await addMember(owner.cookie, 'jaco@example.com', 'member');
    const general = (await api('/api/conversations', { cookie: owner.cookie })).json.conversations[0].id;
    const post = (cookie: string, i: number) =>
      api(`/api/conversations/${general}/messages`, {
        body: { body: `message ${i}`, clientMsgId: `limit-${cookie.length}-${i}-${Date.now()}` },
        cookie,
      });
    // A runaway script: 70 at once. About 60 get through (plus the odd one refilled meanwhile).
    const results = await Promise.all(Array.from({ length: 70 }, (_, i) => post(owner.cookie, i)));
    const sent = results.filter((r) => r.status === 201).length;
    expect(sent).toBeGreaterThanOrEqual(SEND_BURST);
    expect(sent).toBeLessThan(66);
    const refused = results.find((r) => r.status === 429)!;
    expect(refused.json.error.code).toBe('rate_limited');
    expect(Number(refused.res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    // Someone else is not affected.
    expect((await post(jaco.cookie, 1)).status).toBe(201);
  }, 30_000); // 70 sends at once take a while when the whole suite is running
});
