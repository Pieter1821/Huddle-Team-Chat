import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { conversation, file, message } from '../../db/schema';
import { forbidden, notFound } from '../../lib/errors';
import { queryParams } from '../../lib/validate';
import { requireActor, type AppEnv } from '../../middleware/context';
import type { Actor } from '../access/access';
import { recordAudit, requestMeta } from '../audit/audit';
import { withReactions } from '../conversations/reactions';

/**
 * The owner's full export, served as JSON pages (and raw files) that the browser assembles into a ZIP:
 * building a ZIP inside the Worker would blow the free plan's CPU limit. Direct messages are left out
 * unless the owner explicitly asks for them, and every export is written to the security log.
 */
export const EXPORT_FORMAT = { format: 'huddle-export', version: 1 } as const;

const scope = z.object({ includeDms: z.enum(['0', '1']).default('0') });

const ownerOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.actor.role !== 'owner') throw forbidden('Only the workspace owner can export.');
  await next();
});

/** A conversation inside the export's scope, or 404. */
async function exportable(db: Db, actor: Actor, conversationId: string, includeDms: boolean) {
  const conv = await db.query.conversation.findFirst({
    where: and(eq(conversation.id, conversationId), eq(conversation.workspaceId, actor.workspaceId)),
  });
  if (!conv || (!includeDms && (conv.kind === 'dm' || conv.kind === 'group_dm')))
    throw notFound('That conversation');
  return conv;
}

export const exportRoutes = new Hono<AppEnv>()
  .use('/*', requireActor, ownerOnly)

  .get('/', queryParams(scope), async (c) => {
    const { db, actor } = c.var;
    const includeDms = c.req.valid('query').includeDms === '1';
    const ws = await db.query.workspace.findFirst();
    const users = await db.all<{ id: string; name: string; email: string; role: string; status: string }>(sql`
      SELECT u.id, u.name, u.email, wm.role, wm.status FROM workspace_member wm JOIN user u ON u.id = wm.user_id
      WHERE wm.workspace_id = ${actor.workspaceId} ORDER BY lower(u.name)`);
    const conversations = await db.all<{
      id: string;
      kind: string;
      name: string | null;
      topic: string | null;
      archivedAt: number | null;
      createdAt: number;
      members: string;
      messages: number;
    }>(sql`
      SELECT c.id, c.kind, c.name, c.topic, c.archived_at AS archivedAt, c.created_at AS createdAt,
             (SELECT group_concat(user_id) FROM conversation_member WHERE conversation_id = c.id) AS members,
             (SELECT count(*) FROM message WHERE conversation_id = c.id AND deleted_at IS NULL) AS messages
      FROM conversation c
      WHERE c.workspace_id = ${actor.workspaceId}
        ${includeDms ? sql`` : sql`AND c.kind IN ('public', 'private')`}
      ORDER BY c.created_at`);
    await recordAudit(db, {
      ...requestMeta(c),
      action: 'export.started',
      actorId: actor.userId,
      meta: { includeDms },
    });
    return c.json({
      ...EXPORT_FORMAT,
      exportedAt: new Date().toISOString(),
      includesDirectMessages: includeDms,
      workspace: ws ? { id: ws.id, name: ws.name, accent: ws.accent } : null,
      users,
      conversations: conversations.map((conv) => ({
        ...conv,
        archivedAt: conv.archivedAt ? new Date(conv.archivedAt).toISOString() : null,
        createdAt: new Date(conv.createdAt).toISOString(),
        members: conv.members ? conv.members.split(',') : [],
      })),
    });
  })

  /** Every message of one conversation in seq order, including replies, 500 per page. */
  .get(
    '/conversations/:id/messages',
    queryParams(
      scope.extend({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(500),
      }),
    ),
    async (c) => {
      const { db, actor } = c.var;
      const q = c.req.valid('query');
      const conv = await exportable(db, actor, c.req.param('id'), q.includeDms === '1');
      const rows = await db
        .select()
        .from(message)
        .where(and(eq(message.conversationId, conv.id), gt(message.seq, q.after)))
        .orderBy(asc(message.seq))
        .limit(q.limit);
      const messages = await withReactions(db, rows);
      return c.json({ messages, nextAfter: rows.length === q.limit ? rows.at(-1)!.seq : null });
    },
  )

  /** The raw bytes of one file in the export's scope. */
  .get('/files/:id', queryParams(scope), async (c) => {
    const { db, actor } = c.var;
    const f = await db.query.file.findFirst({ where: eq(file.id, c.req.param('id')) });
    if (!f || f.workspaceId !== actor.workspaceId || !f.messageId) throw notFound('That file');
    await exportable(db, actor, f.conversationId, c.req.valid('query').includeDms === '1');
    const object = await c.env.FILES.get(f.r2Key);
    if (!object) throw notFound('That file');
    return new Response(object.body, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    });
  });
