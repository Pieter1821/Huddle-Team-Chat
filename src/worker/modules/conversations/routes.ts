import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  conversation,
  conversationMember,
  message,
  notification,
  user,
  workspaceMember,
} from '../../db/schema';
import { hubFor } from '../../realtime/workspace-hub';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { newId } from '../../lib/id';
import { jsonBody, queryParams } from '../../lib/validate';
import { requireActor, type AppEnv } from '../../middleware/context';
import { EMOJI_PATTERN, withReactions } from './reactions';
import { isAdmin } from '../access/access';
import {
  activeMembers,
  isMember,
  normalizeChannelName,
  postableConversation,
  readableConversation,
  roomFor,
  sidebarFor,
  unwrap,
} from './service';

const messageBody = z.string().trim().min(1, 'A message cannot be empty.').max(8000);
const clientMsgId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const conversationRoutes = new Hono<AppEnv>()
  .use('/*', requireActor)

  /* ---------------------------------------------------------------- sidebar and browsing */

  .get('/', async (c) => {
    const { db, actor } = c.var;
    const rows = await sidebarFor(db, actor.userId);
    const dmIds = rows.filter((r) => r.kind === 'dm' || r.kind === 'group_dm').map((r) => r.id);
    const dmMembers = dmIds.length
      ? await db
          .select({ conversationId: conversationMember.conversationId, userId: user.id, name: user.name })
          .from(conversationMember)
          .innerJoin(user, eq(user.id, conversationMember.userId))
          .where(inArray(conversationMember.conversationId, dmIds))
      : [];
    return c.json({
      conversations: rows.map((r) => ({
        ...r,
        ...(r.kind === 'dm' || r.kind === 'group_dm'
          ? {
              members: dmMembers
                .filter((m) => m.conversationId === r.id)
                .map(({ userId, name }) => ({ userId, name })),
            }
          : {}),
      })),
    });
  })

  // Public channels anyone (except guests) may join.
  .get('/browse', async (c) => {
    const { db, actor } = c.var;
    if (actor.role === 'guest') return c.json({ channels: [] });
    const channels = await db.all<{
      id: string;
      name: string;
      topic: string | null;
      members: number;
      joined: number;
    }>(sql`
      SELECT c.id, c.name, c.topic,
             (SELECT count(*) FROM conversation_member x WHERE x.conversation_id = c.id) AS members,
             EXISTS (SELECT 1 FROM conversation_member y WHERE y.conversation_id = c.id AND y.user_id = ${actor.userId}) AS joined
      FROM conversation c
      WHERE c.workspace_id = ${actor.workspaceId} AND c.kind = 'public' AND c.archived_at IS NULL
      ORDER BY c.name
    `);
    return c.json({ channels: channels.map((ch) => ({ ...ch, joined: Boolean(ch.joined) })) });
  })

  /* ---------------------------------------------------------------- creating */

  .post(
    '/',
    jsonBody(
      z.object({
        name: z.string().min(1).max(100),
        kind: z.enum(['public', 'private']),
        topic: z.string().trim().max(250).optional(),
      }),
    ),
    async (c) => {
      const { db, actor } = c.var;
      if (actor.role === 'guest') throw forbidden('Guests cannot create channels.');
      const body = c.req.valid('json');
      const name = normalizeChannelName(body.name);
      const id = newId();
      try {
        await db.batch([
          db.insert(conversation).values({
            id,
            workspaceId: actor.workspaceId,
            kind: body.kind,
            name,
            topic: body.topic || null,
            createdBy: actor.userId,
          }),
          db.insert(conversationMember).values({ conversationId: id, userId: actor.userId }),
        ]);
      } catch (err) {
        if (String(err).includes('UNIQUE')) throw conflict('name_taken', `#${name} already exists.`);
        throw err;
      }
      return c.json({ conversation: { id, kind: body.kind, name, topic: body.topic || null } }, 201);
    },
  )

  // Opens the DM with these people, creating it the first time. The same people always get the
  // same conversation (dm_key is the sorted member ids).
  .post('/dm', jsonBody(z.object({ userIds: z.array(z.string().min(1)).min(1).max(8) })), async (c) => {
    const { db, actor } = c.var;
    const others = [...new Set(c.req.valid('json').userIds)].filter((id) => id !== actor.userId);
    const everyone = [actor.userId, ...others].sort();

    const found = await activeMembers(db, actor.workspaceId, others);
    if (found.length !== others.length)
      throw badRequest('invalid_members', 'Everyone in a DM must be an active member.');

    // Guests may only message people they share a channel with.
    if (actor.role === 'guest' && others.length) {
      const shared = await db.all<{ userId: string }>(sql`
        SELECT DISTINCT other.user_id AS userId FROM conversation_member mine
        JOIN conversation c ON c.id = mine.conversation_id AND c.kind IN ('public', 'private')
        JOIN conversation_member other ON other.conversation_id = mine.conversation_id
        WHERE mine.user_id = ${actor.userId}
      `);
      const allowed = new Set(shared.map((s) => s.userId));
      if (!others.every((id) => allowed.has(id)))
        throw forbidden('Guests can only message people in their channels.');
    }

    const dmKey = everyone.join(':');
    const existing = await db.query.conversation.findFirst({
      where: and(eq(conversation.workspaceId, actor.workspaceId), eq(conversation.dmKey, dmKey)),
    });
    if (existing) return c.json({ conversation: existing }, 200);

    const id = newId();
    const kind = everyone.length > 2 ? 'group_dm' : 'dm';
    try {
      await db.batch([
        db
          .insert(conversation)
          .values({ id, workspaceId: actor.workspaceId, kind, dmKey, createdBy: actor.userId }),
        ...everyone.map((userId) => db.insert(conversationMember).values({ conversationId: id, userId })),
      ]);
    } catch (err) {
      // Two people opening the same DM at once: the unique dm_key lets only one create it.
      if (!String(err).includes('UNIQUE')) throw err;
      const raced = await db.query.conversation.findFirst({ where: eq(conversation.dmKey, dmKey) });
      return c.json({ conversation: raced }, 200);
    }
    const created = await db.query.conversation.findFirst({ where: eq(conversation.id, id) });
    return c.json({ conversation: created }, 201);
  })

  /* ---------------------------------------------------------------- one conversation */

  .get('/:id', async (c) => {
    const { db, actor } = c.var;
    const conv = await readableConversation(db, actor, c.req.param('id'));
    const members = await db
      .select({ userId: user.id, name: user.name, image: user.image, role: workspaceMember.role })
      .from(conversationMember)
      .innerJoin(user, eq(user.id, conversationMember.userId))
      .innerJoin(
        workspaceMember,
        and(eq(workspaceMember.userId, user.id), eq(workspaceMember.workspaceId, conv.workspaceId)),
      )
      .where(eq(conversationMember.conversationId, conv.id))
      .orderBy(sql`lower(${user.name})`);
    return c.json({
      conversation: conv,
      members,
      isMember: members.some((m) => m.userId === actor.userId),
      // Lets the app show that people from outside the team can read this conversation.
      guestCount: members.filter((m) => m.role === 'guest').length,
    });
  })

  .patch(
    '/:id',
    jsonBody(
      z
        .object({
          name: z.string().min(1).max(100).optional(),
          topic: z.string().trim().max(250).nullable().optional(),
        })
        .refine((v) => v.name !== undefined || v.topic !== undefined, 'Nothing to update.'),
    ),
    async (c) => {
      const { db, actor, env } = { ...c.var, env: c.env };
      const conv = await postableConversation(db, actor, c.req.param('id'));
      if (conv.kind === 'dm' || conv.kind === 'group_dm')
        throw badRequest('not_a_channel', 'DMs have no name or topic.');
      if (!(await isMember(db, conv.id, actor.userId))) throw forbidden('Join the channel first.');
      const body = c.req.valid('json');
      // Anyone in the channel may set its topic; renaming is for its creator and admins.
      const name = body.name !== undefined ? normalizeChannelName(body.name) : undefined;
      if (name !== undefined && conv.createdBy !== actor.userId && !isAdmin(actor)) {
        throw forbidden('Only the channel’s creator or an admin can rename it.');
      }
      try {
        await db
          .update(conversation)
          .set({
            ...(name !== undefined ? { name } : {}),
            ...(body.topic !== undefined ? { topic: body.topic || null } : {}),
          })
          .where(eq(conversation.id, conv.id));
      } catch (err) {
        if (String(err).includes('UNIQUE')) throw conflict('name_taken', `#${name} already exists.`);
        throw err;
      }
      await roomFor(env, conv.id).recordEvent(conv.id, {
        type: 'conversation.updated',
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(body.topic !== undefined ? { topic: body.topic || null } : {}),
        },
      });
      return c.json({
        conversation: { id: conv.id, name: name ?? conv.name, topic: body.topic ?? conv.topic },
      });
    },
  )

  .post('/:id/archive', async (c) => setArchived(c, true))
  .post('/:id/unarchive', async (c) => setArchived(c, false))

  .post('/:id/join', async (c) => {
    const { db, actor } = c.var;
    const conv = await postableConversation(db, actor, c.req.param('id'));
    if (conv.kind !== 'public') throw forbidden('Only public channels can be joined freely.');
    if (await isMember(db, conv.id, actor.userId)) return c.json({ joined: true });
    await db
      .insert(conversationMember)
      .values({ conversationId: conv.id, userId: actor.userId })
      .onConflictDoNothing();
    await roomFor(c.env, conv.id).recordEvent(conv.id, {
      type: 'member.joined',
      data: { userId: actor.userId, addedBy: actor.userId },
    });
    return c.json({ joined: true });
  })

  .post('/:id/leave', async (c) => {
    const { db, actor } = c.var;
    const conv = await readableConversation(db, actor, c.req.param('id'));
    if (conv.kind === 'dm' || conv.kind === 'group_dm')
      throw badRequest('not_a_channel', 'You cannot leave a DM.');
    if (!(await isMember(db, conv.id, actor.userId))) return c.json({ left: true });
    await db
      .delete(conversationMember)
      .where(
        and(eq(conversationMember.conversationId, conv.id), eq(conversationMember.userId, actor.userId)),
      );
    await roomFor(c.env, conv.id).recordEvent(conv.id, {
      type: 'member.left',
      data: { userId: actor.userId, removedBy: actor.userId },
    });
    await roomFor(c.env, conv.id).disconnectUser(actor.userId);
    return c.json({ left: true });
  })

  .post(
    '/:id/members',
    jsonBody(z.object({ userIds: z.array(z.string().min(1)).min(1).max(50) })),
    async (c) => {
      const { db, actor } = c.var;
      const conv = await postableConversation(db, actor, c.req.param('id'));
      if (conv.kind === 'dm' || conv.kind === 'group_dm')
        throw badRequest('not_a_channel', 'Start a new DM instead.');
      if (actor.role === 'guest') throw forbidden('Guests cannot add people to channels.');
      if (!(await isMember(db, conv.id, actor.userId))) throw forbidden('Join the channel first.');

      const ids = [...new Set(c.req.valid('json').userIds)];
      const found = await activeMembers(db, actor.workspaceId, ids);
      if (found.length !== ids.length)
        throw badRequest('invalid_members', 'Only active members can be added.');
      // Bringing an outsider into a channel is an admin decision.
      if (found.some((m) => m.role === 'guest') && !isAdmin(actor)) {
        throw forbidden('Only owners and admins can add guests to a channel.');
      }

      const added: string[] = [];
      for (const userId of ids) {
        if (await isMember(db, conv.id, userId)) continue;
        await db.insert(conversationMember).values({ conversationId: conv.id, userId }).onConflictDoNothing();
        await roomFor(c.env, conv.id).recordEvent(conv.id, {
          type: 'member.joined',
          data: { userId, addedBy: actor.userId },
        });
        added.push(userId);
      }
      return c.json({ added });
    },
  )

  .delete('/:id/members/:userId', async (c) => {
    const { db, actor } = c.var;
    const conv = await readableConversation(db, actor, c.req.param('id'));
    const userId = c.req.param('userId');
    if (conv.kind === 'dm' || conv.kind === 'group_dm')
      throw badRequest('not_a_channel', 'People cannot be removed from a DM.');
    if (!isAdmin(actor)) throw forbidden('Only owners and admins can remove people from a channel.');
    if (!(await isMember(db, conv.id, userId))) throw notFound('That member');
    await db
      .delete(conversationMember)
      .where(and(eq(conversationMember.conversationId, conv.id), eq(conversationMember.userId, userId)));
    await roomFor(c.env, conv.id).recordEvent(conv.id, {
      type: 'member.left',
      data: { userId, removedBy: actor.userId },
    });
    // Their open sockets close at once: no more live events after removal.
    await roomFor(c.env, conv.id).disconnectUser(userId);
    return c.body(null, 204);
  })

  // Moves the read marker forward (never back), so unread counts stay right across devices.
  .post('/:id/read', jsonBody(z.object({ seq: z.number().int().min(0) })), async (c) => {
    const { db, actor } = c.var;
    const conv = await readableConversation(db, actor, c.req.param('id'));
    const seq = Math.min(c.req.valid('json').seq, conv.lastSeq);
    await db
      .update(conversationMember)
      .set({ lastReadSeq: sql`max(${conversationMember.lastReadSeq}, ${seq})` })
      .where(
        and(eq(conversationMember.conversationId, conv.id), eq(conversationMember.userId, actor.userId)),
      );
    // What you have read no longer needs an email digest.
    await db
      .update(notification)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notification.userId, actor.userId),
          isNull(notification.readAt),
          inArray(
            notification.messageId,
            db
              .select({ id: message.id })
              .from(message)
              .where(and(eq(message.conversationId, conv.id), lte(message.seq, seq))),
          ),
        ),
      );
    return c.json({ lastReadSeq: seq });
  })

  /* ---------------------------------------------------------------- messages */

  // History, newest page first: `before` is a seq; pages come back oldest-to-newest.
  .get(
    '/:id/messages',
    queryParams(
      z.object({
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    ),
    async (c) => {
      const { db, actor } = c.var;
      const conv = await readableConversation(db, actor, c.req.param('id'));
      const { before, limit } = c.req.valid('query');
      const rows = await db
        .select()
        .from(message)
        .where(
          and(
            eq(message.conversationId, conv.id),
            or(isNull(message.parentId), eq(message.alsoInChannel, true)),
            before ? lt(message.seq, before) : undefined,
          ),
        )
        .orderBy(desc(message.seq))
        .limit(limit);
      return c.json({
        messages: await withReactions(db, rows.reverse()),
        lastSeq: conv.lastSeq,
        hasMore: rows.length === limit,
      });
    },
  )

  .get('/:id/messages/:messageId/thread', async (c) => {
    const { db, actor } = c.var;
    const conv = await readableConversation(db, actor, c.req.param('id'));
    const parent = await db.query.message.findFirst({
      where: and(
        eq(message.id, c.req.param('messageId')),
        eq(message.conversationId, conv.id),
        isNull(message.parentId),
      ),
    });
    if (!parent) throw notFound('That message');
    const replies = await db
      .select()
      .from(message)
      .where(eq(message.parentId, parent.id))
      .orderBy(asc(message.seq));
    const [withCounts, ...rest] = await withReactions(db, [parent, ...replies]);
    return c.json({ parent: withCounts, replies: rest });
  })

  .post(
    '/:id/messages',
    jsonBody(
      z
        .object({
          // Text may be empty when the message carries files.
          body: z.string().trim().max(8000).default(''),
          clientMsgId,
          parentId: z.string().min(1).optional(),
          alsoInChannel: z.boolean().optional(),
          fileIds: z.array(z.string().min(1)).max(10).optional(),
        })
        .refine((v) => v.body.length > 0 || (v.fileIds?.length ?? 0) > 0, {
          message: 'A message cannot be empty.',
          path: ['body'],
        }),
    ),
    async (c) => {
      const { db, actor } = c.var;
      const conv = await postableConversation(db, actor, c.req.param('id'));
      // Reading a public channel is open to members of the workspace; posting needs membership.
      // The send limit is checked at the same time, so it adds no waiting of its own.
      const [member, limit] = await Promise.all([
        isMember(db, conv.id, actor.userId),
        hubFor(c.env).allowSend(actor.userId),
      ]);
      if (!member) throw forbidden('Join the channel to post.');
      if (!limit.allowed) {
        c.header('Retry-After', String(limit.retryAfter));
        throw new AppError(
          429,
          'rate_limited',
          'You’re sending messages very quickly. Wait a moment, then send again.',
        );
      }
      const body = c.req.valid('json');
      const result = unwrap(
        await roomFor(c.env, conv.id).post({
          conversationId: conv.id,
          authorId: actor.userId,
          body: body.body,
          clientMsgId: body.clientMsgId,
          parentId: body.parentId,
          alsoInChannel: body.alsoInChannel,
          fileIds: body.fileIds,
        }),
      );
      return c.json({ message: result.message }, result.created ? 201 : 200);
    },
  )

  .patch('/:id/messages/:messageId', jsonBody(z.object({ body: messageBody })), async (c) => {
    const { db, actor } = c.var;
    const conv = await postableConversation(db, actor, c.req.param('id'));
    const edited = unwrap(
      await roomFor(c.env, conv.id).edit({
        conversationId: conv.id,
        messageId: c.req.param('messageId'),
        actorId: actor.userId,
        body: c.req.valid('json').body,
      }),
    );
    return c.json({ message: edited });
  })

  .post(
    '/:id/messages/:messageId/reactions',
    jsonBody(z.object({ emoji: z.string().min(1).max(32).regex(EMOJI_PATTERN, 'Reactions must be emoji.') })),
    async (c) => react(c, c.req.valid('json').emoji, true),
  )
  .delete(
    '/:id/messages/:messageId/reactions',
    queryParams(
      z.object({ emoji: z.string().min(1).max(32).regex(EMOJI_PATTERN, 'Reactions must be emoji.') }),
    ),
    async (c) => react(c, c.req.valid('query').emoji, false),
  )

  .delete('/:id/messages/:messageId', async (c) => {
    const { db, actor } = c.var;
    const conv = await postableConversation(db, actor, c.req.param('id'));
    unwrap(
      await roomFor(c.env, conv.id).remove({
        conversationId: conv.id,
        messageId: c.req.param('messageId'),
        actorId: actor.userId,
        actorIsAdmin: isAdmin(actor),
      }),
    );
    return c.body(null, 204);
  })

  // Catch-up for clients that missed events (the WebSocket replays these too).
  .get(
    '/:id/events',
    queryParams(
      z.object({
        after: z.coerce.number().int().min(0),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
    ),
    async (c) => {
      const { db, actor } = c.var;
      const conv = await readableConversation(db, actor, c.req.param('id'));
      const { after, limit } = c.req.valid('query');
      const events = await roomFor(c.env, conv.id).eventsAfter(conv.id, after, limit);
      return c.json({ events, lastSeq: conv.lastSeq, complete: events.length < limit });
    },
  );

async function setArchived(c: Context<AppEnv, '/:id'>, archived: boolean) {
  const { db, actor } = c.var;
  const conv = await readableConversation(db, actor, c.req.param('id'));
  if (conv.kind === 'dm' || conv.kind === 'group_dm')
    throw badRequest('not_a_channel', 'DMs cannot be archived.');
  if (conv.createdBy !== actor.userId && !isAdmin(actor))
    throw forbidden('Only the channel’s creator or an admin can do that.');
  if (archived && conv.name === 'general')
    throw new AppError(409, 'protected', '#general cannot be archived.');
  if (Boolean(conv.archivedAt) === archived) return c.json({ archived });
  await db
    .update(conversation)
    .set({ archivedAt: archived ? new Date() : null })
    .where(eq(conversation.id, conv.id));
  await roomFor(c.env, conv.id).recordEvent(conv.id, { type: 'conversation.updated', data: { archived } });
  return c.json({ archived });
}

/** Reacting follows the posting rules: you must be able to post in the conversation. */
async function react(c: Context<AppEnv, '/:id/messages/:messageId/reactions'>, emoji: string, add: boolean) {
  const { db, actor } = c.var;
  const conv = await postableConversation(db, actor, c.req.param('id'));
  if (!(await isMember(db, conv.id, actor.userId))) throw forbidden('Join the channel to react.');
  const result = unwrap(
    await roomFor(c.env, conv.id).react({
      conversationId: conv.id,
      messageId: c.req.param('messageId'),
      userId: actor.userId,
      emoji,
      add,
    }),
  );
  return c.json(result);
}
