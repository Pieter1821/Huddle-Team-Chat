import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { message } from '../../db/schema';
import { queryParams } from '../../lib/validate';
import { requireActor, type AppEnv } from '../../middleware/context';
import { withReactions } from '../conversations/reactions';

type MessageRow = typeof message.$inferSelect;
type Joined = { notificationId: string; readAt: number | null; convKind: string; convName: string | null };

// Raw SQL returns snake_case columns; map them back to the Drizzle row shape the DTO builder expects.
const rowFrom = (r: Record<string, unknown>): MessageRow => ({
  rowId: Number(r.row_id),
  id: String(r.id),
  conversationId: String(r.conversation_id),
  seq: Number(r.seq),
  authorId: (r.author_id as string | null) ?? null,
  webhookId: (r.webhook_id as string | null) ?? null,
  clientMsgId: (r.client_msg_id as string | null) ?? null,
  parentId: (r.parent_id as string | null) ?? null,
  body: String(r.body),
  alsoInChannel: Boolean(r.also_in_channel),
  replyCount: Number(r.reply_count),
  lastReplyAt: r.last_reply_at ? new Date(Number(r.last_reply_at)) : null,
  editedAt: r.edited_at ? new Date(Number(r.edited_at)) : null,
  deletedAt: r.deleted_at ? new Date(Number(r.deleted_at)) : null,
  createdAt: new Date(Number(r.created_at)),
});

const page = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

export const activityRoutes = new Hono<AppEnv>()
  .use('/*', requireActor)

  /**
   * Messages that mention you, newest first. The join on your CURRENT membership is the permission
   * check: leave a private channel and its mentions disappear from this view.
   */
  .get('/mentions', queryParams(page), async (c) => {
    const { db, actor } = c.var;
    const { before, limit } = c.req.valid('query');
    const rows = await db.all<Record<string, unknown> & Joined>(sql`
      SELECT m.*, n.id AS notificationId, n.read_at AS readAt, c.kind AS convKind, c.name AS convName
      FROM notification n
      JOIN message m ON m.id = n.message_id AND m.deleted_at IS NULL
      JOIN conversation c ON c.id = m.conversation_id
      JOIN conversation_member cm ON cm.conversation_id = c.id AND cm.user_id = ${actor.userId}
      WHERE n.user_id = ${actor.userId} AND n.kind = 'mention'
        ${before ? sql`AND n.id < ${before}` : sql``}
      ORDER BY n.id DESC
      LIMIT ${limit}
    `);
    const messages = await withReactions(db, rows.map(rowFrom));
    return c.json({
      mentions: rows.map((r, i) => ({
        message: messages[i],
        conversation: { id: messages[i]!.conversationId, kind: r.convKind, name: r.convName },
        read: r.readAt !== null,
      })),
      nextBefore: rows.length === limit ? rows.at(-1)?.notificationId : null,
    });
  })

  /** Threads you started or replied to, most recent reply first, in conversations you are still in. */
  .get('/threads', queryParams(page.omit({ before: true })), async (c) => {
    const { db, actor } = c.var;
    const { limit } = c.req.valid('query');
    const rows = await db.all<Record<string, unknown> & Joined>(sql`
      SELECT p.*, c.kind AS convKind, c.name AS convName
      FROM message p
      JOIN conversation c ON c.id = p.conversation_id
      JOIN conversation_member cm ON cm.conversation_id = c.id AND cm.user_id = ${actor.userId}
      WHERE p.parent_id IS NULL AND p.reply_count > 0
        AND (p.author_id = ${actor.userId}
             OR EXISTS (SELECT 1 FROM message r WHERE r.parent_id = p.id AND r.author_id = ${actor.userId}))
      ORDER BY p.last_reply_at DESC
      LIMIT ${limit}
    `);
    const parents = await withReactions(db, rows.map(rowFrom));
    return c.json({
      threads: rows.map((r, i) => ({
        parent: parents[i],
        conversation: { id: parents[i]!.conversationId, kind: r.convKind, name: r.convName },
      })),
    });
  });
