import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { webhook } from '../../db/schema';
import { randomToken, sha256Hex } from '../../lib/crypto';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors';
import { newId } from '../../lib/id';
import { jsonBody } from '../../lib/validate';
import { requireActor, type AppEnv } from '../../middleware/context';
import { isAdmin } from '../access/access';
import { postableConversation, roomFor, unwrap } from '../conversations/service';

const PER_MINUTE = 30;

/** Admin management, mounted under /api/conversations. */
export const conversationWebhookRoutes = new Hono<AppEnv>()
  .use('/*', requireActor)

  /** Creates a webhook for a channel. The secret URL is shown only in this response. */
  .post('/:id/webhooks', jsonBody(z.object({ name: z.string().trim().min(1).max(50) })), async (c) => {
    const { db, actor, config } = c.var;
    if (!isAdmin(actor)) throw forbidden('Only owners and admins can create webhooks.');
    const conv = await postableConversation(db, actor, c.req.param('id'));
    if (conv.kind !== 'public' && conv.kind !== 'private') {
      throw badRequest('not_a_channel', 'Webhooks can only post to channels.');
    }
    const id = newId();
    const token = randomToken();
    const { name } = c.req.valid('json');
    // Only a hash of the token is stored: a database leak does not leak working webhook URLs.
    await db.insert(webhook).values({
      id,
      conversationId: conv.id,
      name,
      tokenHash: await sha256Hex(token),
      createdBy: actor.userId,
    });
    return c.json(
      { webhook: { id, name, conversationId: conv.id }, url: `${config.appUrl}/api/hooks/${id}/${token}` },
      201,
    );
  })

  .get('/:id/webhooks', async (c) => {
    const { db, actor } = c.var;
    if (!isAdmin(actor)) throw forbidden('Only owners and admins can see webhooks.');
    const conv = await postableConversation(db, actor, c.req.param('id'));
    const rows = await db
      .select({
        id: webhook.id,
        name: webhook.name,
        createdAt: webhook.createdAt,
        createdBy: webhook.createdBy,
      })
      .from(webhook)
      .where(and(eq(webhook.conversationId, conv.id), isNull(webhook.revokedAt)))
      .orderBy(desc(webhook.createdAt));
    return c.json({ webhooks: rows });
  });

/** Revoking, mounted under /api/webhooks. */
export const webhookRoutes = new Hono<AppEnv>().use('/*', requireActor).delete('/:id', async (c) => {
  const { db, actor } = c.var;
  if (!isAdmin(actor)) throw forbidden('Only owners and admins can revoke webhooks.');
  const updated = await db
    .update(webhook)
    .set({ revokedAt: new Date() })
    .where(and(eq(webhook.id, c.req.param('id')), isNull(webhook.revokedAt)))
    .returning({ id: webhook.id });
  if (!updated.length) throw notFound('That webhook');
  return c.body(null, 204);
});

/**
 * The URL other tools call: POST /api/hooks/:id/:token with {"text": "…"}. No session or Origin, so
 * it is mounted before the same-origin guard; the secret token in the URL is the credential. Any
 * failure to match is a plain 404, so the endpoint reveals nothing about which webhooks exist.
 */
export const incomingHookRoutes = new Hono<AppEnv>().post(
  '/:id/:token',
  jsonBody(z.object({ text: z.string().trim().min(1).max(4000) })),
  async (c) => {
    const { db } = c.var;
    const hook = await db.query.webhook.findFirst({ where: eq(webhook.id, c.req.param('id')) });
    // Comparing hashes (fixed length) rather than raw tokens avoids timing differences by content.
    if (!hook || hook.revokedAt || hook.tokenHash !== (await sha256Hex(c.req.param('token')))) {
      throw notFound('That webhook');
    }
    const conv = await db.query.conversation.findFirst({
      where: (t, { eq: e }) => e(t.id, hook.conversationId),
    });
    if (!conv) throw notFound('That webhook');
    if (conv.archivedAt) throw new AppError(409, 'archived', 'This channel is archived.');

    // A misbehaving tool cannot flood the channel.
    const recent = await db.get<{ n: number }>(sql`
      SELECT count(*) AS n FROM message
      WHERE webhook_id = ${hook.id} AND created_at > ${Date.now() - 60_000}`);
    if ((recent?.n ?? 0) >= PER_MINUTE) {
      c.header('retry-after', '60');
      throw new AppError(429, 'rate_limited', `A webhook can post at most ${PER_MINUTE} messages a minute.`);
    }

    // Optional Idempotency-Key from the sender: its retries become the same message.
    const key = c.req.header('idempotency-key');
    if (key !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(key)) {
      throw badRequest('invalid_idempotency_key', 'Idempotency-Key must be 8–64 letters, digits, - or _.');
    }
    const result = unwrap(
      await roomFor(c.env, conv.id).post({
        conversationId: conv.id,
        authorId: null,
        webhookId: hook.id,
        webhookName: hook.name,
        body: c.req.valid('json').text,
        clientMsgId: key ?? newId(),
      }),
    );
    return c.json({ id: result.message.id, seq: result.message.seq }, result.created ? 201 : 200);
  },
);
