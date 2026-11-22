import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { message } from '../../db/schema';
import { badRequest } from '../../lib/errors';
import { queryParams } from '../../lib/validate';
import { requireActor, type AppEnv } from '../../middleware/context';
import { withReactions } from '../conversations/reactions';

/** Highlight markers in snippets: invisible control characters, so no markup ever travels in them. */
export const HIGHLIGHT_START = '\u0002';
export const HIGHLIGHT_END = '\u0003';

/**
 * Turns what someone typed into a safe FTS5 query. FTS5 has its own syntax (OR, NEAR, quotes, *), so
 * raw input could error or match oddly. Only plain words survive, each as a quoted prefix search, all
 * required: "kitch sect" finds "kitchen section".
 */
export function toFtsQuery(input: string): string | null {
  const words = (input.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
  if (!words.length) return null;
  return words.map((w) => `"${w}"*`).join(' ');
}

/** For LIKE: escape the wildcards so "100%" means the literal text. */
const likePattern = (input: string) => `%${input.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

type MessageRow = typeof message.$inferSelect;

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

const dateParam = z.iso.date().optional();

export const searchRoutes = new Hono<AppEnv>().use('/*', requireActor).get(
  '/',
  queryParams(
    z.object({
      q: z.string().trim().min(1).max(200),
      in: z.string().min(1).optional(),
      from: z.string().min(1).optional(),
      has: z.enum(['file']).optional(),
      after: dateParam,
      before: dateParam,
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
  ),
  async (c) => {
    const { db, actor } = c.var;
    const p = c.req.valid('query');
    const fts = toFtsQuery(p.q);
    if (!fts) throw badRequest('invalid_query', 'Search for at least one word or number.');
    const isGuest = actor.role === 'guest' ? 1 : 0;

    // The permission rule lives inside the SQL: only conversations you belong to, plus public ones
    // when you are not a guest. Private messages are never read on your behalf, not even to count.
    const readable = sql`c.workspace_id = ${actor.workspaceId} AND (
      EXISTS (SELECT 1 FROM conversation_member cm WHERE cm.conversation_id = c.id AND cm.user_id = ${actor.userId})
      OR (c.kind = 'public' AND ${isGuest} = 0))`;

    const messages = await db.all<
      Record<string, unknown> & { snippet: string; convKind: string; convName: string | null }
    >(sql`
      SELECT m.*, c.kind AS convKind, c.name AS convName,
             snippet(message_fts, 0, ${HIGHLIGHT_START}, ${HIGHLIGHT_END}, '…', 16) AS snippet
      FROM message_fts
      JOIN message m ON m.row_id = message_fts.rowid
      JOIN conversation c ON c.id = m.conversation_id
      WHERE message_fts MATCH ${fts}
        AND m.deleted_at IS NULL
        AND ${readable}
        ${p.in ? sql`AND c.id = ${p.in}` : sql``}
        ${p.from ? sql`AND m.author_id = ${p.from}` : sql``}
        ${p.has === 'file' ? sql`AND EXISTS (SELECT 1 FROM file f WHERE f.message_id = m.id)` : sql``}
        ${p.after ? sql`AND m.created_at >= ${Date.parse(p.after)}` : sql``}
        ${p.before ? sql`AND m.created_at < ${Date.parse(p.before) + 86_400_000}` : sql``}
      ORDER BY m.created_at DESC, bm25(message_fts)
      LIMIT ${p.limit}
    `);
    const dtos = await withReactions(db, messages.map(rowFrom));

    const files = await db.all<{
      id: string;
      name: string;
      mime: string;
      size: number;
      messageId: string;
      conversationId: string;
    }>(sql`
      SELECT f.id, f.name, f.mime, f.size, f.message_id AS messageId, f.conversation_id AS conversationId
      FROM file f
      JOIN message m ON m.id = f.message_id AND m.deleted_at IS NULL
      JOIN conversation c ON c.id = f.conversation_id
      WHERE f.name LIKE ${likePattern(p.q)} ESCAPE '\\' AND ${readable}
        ${p.in ? sql`AND c.id = ${p.in}` : sql``}
        ${p.from ? sql`AND f.uploader_id = ${p.from}` : sql``}
      ORDER BY f.created_at DESC
      LIMIT 10
    `);

    const channels = await db.all<{ id: string; name: string; kind: string; topic: string | null }>(sql`
      SELECT c.id, c.name, c.kind, c.topic FROM conversation c
      WHERE c.kind IN ('public', 'private') AND c.archived_at IS NULL
        AND c.name LIKE ${likePattern(p.q)} ESCAPE '\\' AND ${readable}
      ORDER BY c.name LIMIT 5
    `);

    // Guests only find the people they share a channel with (the same rule as the member list).
    const people = await db.all<{ userId: string; name: string; image: string | null }>(sql`
      SELECT u.id AS userId, u.name, u.image FROM workspace_member wm
      JOIN user u ON u.id = wm.user_id
      WHERE wm.workspace_id = ${actor.workspaceId} AND wm.status = 'active'
        AND u.name LIKE ${likePattern(p.q)} ESCAPE '\\'
        ${
          isGuest
            ? sql`AND u.id IN (SELECT other.user_id FROM conversation_member mine
                    JOIN conversation_member other ON other.conversation_id = mine.conversation_id
                    WHERE mine.user_id = ${actor.userId})`
            : sql``
        }
      ORDER BY lower(u.name) LIMIT 5
    `);

    return c.json({
      messages: messages.map((r, i) => ({
        message: dtos[i],
        conversation: { id: dtos[i]!.conversationId, kind: r.convKind, name: r.convName },
        snippet: r.snippet,
      })),
      files,
      channels,
      people,
    });
  },
);
