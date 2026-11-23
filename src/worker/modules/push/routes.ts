import { and, asc, eq, notInArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { pushSubscription } from '../../db/schema';
import { newId } from '../../lib/id';
import { badRequest, notFound } from '../../lib/errors';
import { jsonBody } from '../../lib/validate';
import { b64url, isPushEndpoint } from '../../lib/web-push';
import { requireActor, type AppEnv } from '../../middleware/context';
import { vapidKeys } from './keys';
import { deliver } from './send';

/** Enough for a phone, a laptop, a work machine and a few browsers; the oldest beyond it are dropped. */
const MAX_DEVICES = 10;

const b64 = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+=*$/, 'must be base64url');

const subscriptionBody = z.object({
  endpoint: z.string().max(1024).refine(isPushEndpoint, 'is not a supported push service'),
  // An uncompressed P-256 public key (65 bytes) and a 16-byte secret, base64url encoded.
  keys: z.object({ p256dh: b64(86, 90), auth: b64(22, 24) }),
});

/** Mounted at /api/push. */
export const pushRoutes = new Hono<AppEnv>()
  .use('/*', requireActor)
  // The public half of the server's signing key, which the browser needs to subscribe.
  .get('/key', async (c) => {
    const { db, config } = c.var;
    const { publicKey } = await vapidKeys(db, config.authSecret);
    return c.json({ publicKey });
  })
  // Turns pushes on for this browser. Saving the same subscription again just refreshes it.
  .post('/subscriptions', jsonBody(subscriptionBody), async (c) => {
    const { db, actor, session } = c.var;
    const { endpoint, keys } = c.req.valid('json');
    // Keys that aren't a real point on the curve would only fail later, at every send.
    const p256dh = b64url.decode(keys.p256dh);
    const valid =
      p256dh.byteLength === 65 &&
      b64url.decode(keys.auth).byteLength === 16 &&
      (await crypto.subtle
        .importKey('raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
        .then(() => true)
        .catch(() => false));
    if (!valid) throw badRequest('invalid_request', 'keys: are not a valid push subscription.');
    const values = {
      userId: actor.userId,
      sessionId: session.session.id,
      p256dh: keys.p256dh,
      auth: keys.auth,
    };
    await db
      .insert(pushSubscription)
      .values({ id: newId(), endpoint, ...values })
      .onConflictDoUpdate({ target: pushSubscription.endpoint, set: values });

    const mine = await db
      .select({ id: pushSubscription.id })
      .from(pushSubscription)
      .where(eq(pushSubscription.userId, actor.userId))
      .orderBy(asc(pushSubscription.createdAt));
    if (mine.length > MAX_DEVICES) {
      const keep = mine.slice(-MAX_DEVICES).map((s) => s.id);
      await db
        .delete(pushSubscription)
        .where(and(eq(pushSubscription.userId, actor.userId), notInArray(pushSubscription.id, keep)));
    }
    return c.json({ subscribed: true }, 201);
  })
  // Turns pushes off for this browser.
  .post('/subscriptions/remove', jsonBody(z.object({ endpoint: z.string().max(1024) })), async (c) => {
    const { db, actor } = c.var;
    await db
      .delete(pushSubscription)
      .where(
        and(
          eq(pushSubscription.userId, actor.userId),
          eq(pushSubscription.endpoint, c.req.valid('json').endpoint),
        ),
      );
    return c.body(null, 204);
  })
  // A sample notification to this browser, so people can check it works.
  .post('/test', jsonBody(z.object({ endpoint: z.string().max(1024) })), async (c) => {
    const { db, actor, config } = c.var;
    const sub = await db.query.pushSubscription.findFirst({
      where: and(
        eq(pushSubscription.userId, actor.userId),
        eq(pushSubscription.endpoint, c.req.valid('json').endpoint),
      ),
    });
    if (!sub) throw notFound('Notifications on this device');
    const outcome = await deliver(
      sub,
      {
        title: 'Huddle',
        body: 'Notifications are working on this device.',
        url: '/settings',
        tag: 'huddle-test',
      },
      await vapidKeys(db, config.authSecret),
      config.appUrl,
      (url, init) => fetch(url, init),
    );
    if (outcome === 'gone') {
      await db.delete(pushSubscription).where(eq(pushSubscription.id, sub.id));
      throw badRequest('push_gone', 'This browser turned notifications off. Turn them on again.');
    }
    if (outcome === 'failed')
      throw badRequest('push_failed', 'The browser’s push service didn’t accept it. Try again later.');
    return c.json({ sent: true });
  });
