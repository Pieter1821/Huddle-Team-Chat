import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { conversation, conversationMember, workspaceMember } from '../../db/schema';
import { AppError, badRequest, notFound } from '../../lib/errors';
import type { RoomResult } from '../../realtime/conversation-room';
import { canReadConversation, type Actor } from '../access/access';

export type Conversation = typeof conversation.$inferSelect;

export const roomFor = (env: Env, conversationId: string) =>
  env.CONVERSATION_ROOM.get(env.CONVERSATION_ROOM.idFromName(conversationId));

/** Turns a room's refusal back into the same AppError the client would get from any other route. */
export function unwrap<T>(result: RoomResult<T>): T {
  if (result.ok) return result.value;
  throw new AppError(result.error.status, result.error.code, result.error.message);
}

/** "Project Harbour House" → "project-harbour-house". Lowercase letters, digits, dashes, underscores. */
export function normalizeChannelName(input: string): string {
  const name = input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!name || name.length > 80) {
    throw badRequest('invalid_name', 'Channel names need 1–80 letters, numbers, dashes or underscores.');
  }
  return name;
}

/** Loads a conversation the actor may read, or answers 404 (never 403, so existence isn't leaked). */
export async function readableConversation(
  db: Db,
  actor: Actor,
  conversationId: string,
): Promise<Conversation> {
  if (!(await canReadConversation(db, actor, conversationId))) throw notFound('That conversation');
  const conv = await db.query.conversation.findFirst({ where: eq(conversation.id, conversationId) });
  if (!conv) throw notFound('That conversation');
  return conv;
}

/** Readable and open for posting: archived conversations are read-only. */
export async function postableConversation(
  db: Db,
  actor: Actor,
  conversationId: string,
): Promise<Conversation> {
  const conv = await readableConversation(db, actor, conversationId);
  if (conv.archivedAt) throw new AppError(409, 'archived', 'This conversation is archived and read-only.');
  return conv;
}

export async function isMember(db: Db, conversationId: string, userId: string): Promise<boolean> {
  const row = await db.query.conversationMember.findFirst({
    where: and(eq(conversationMember.conversationId, conversationId), eq(conversationMember.userId, userId)),
    columns: { userId: true },
  });
  return Boolean(row);
}

/** Active members of the workspace among `userIds`, with their roles. */
export async function activeMembers(db: Db, workspaceId: string, userIds: string[]) {
  if (!userIds.length) return [];
  return db
    .select({ userId: workspaceMember.userId, role: workspaceMember.role })
    .from(workspaceMember)
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        eq(workspaceMember.status, 'active'),
        inArray(workspaceMember.userId, userIds),
      ),
    );
}

export type SidebarRow = {
  id: string;
  kind: Conversation['kind'];
  name: string | null;
  topic: string | null;
  lastSeq: number;
  lastReadSeq: number;
  notifyLevel: 'all' | 'mentions' | 'muted';
  unread: number;
  mentions: number;
};

/**
 * Every open conversation the user belongs to, with unread and mention counts computed in SQL.
 * Unread counts only top-level messages (and replies also sent to the channel) from other people.
 */
export async function sidebarFor(db: Db, userId: string): Promise<SidebarRow[]> {
  return db.all<SidebarRow>(sql`
    SELECT c.id, c.kind, c.name, c.topic, c.last_seq AS lastSeq,
           cm.last_read_seq AS lastReadSeq, cm.notify_level AS notifyLevel,
           (SELECT count(*) FROM message m
             WHERE m.conversation_id = c.id AND m.seq > cm.last_read_seq AND m.deleted_at IS NULL
               AND (m.parent_id IS NULL OR m.also_in_channel = 1)
               AND (m.author_id IS NULL OR m.author_id <> ${userId})) AS unread,
           (SELECT count(*) FROM message_mention mm JOIN message m ON m.id = mm.message_id
             WHERE m.conversation_id = c.id AND m.seq > cm.last_read_seq AND m.deleted_at IS NULL
               AND mm.target IN (${userId}, 'channel', 'here')
               AND (m.author_id IS NULL OR m.author_id <> ${userId})) AS mentions
    FROM conversation_member cm
    JOIN conversation c ON c.id = cm.conversation_id
    WHERE cm.user_id = ${userId} AND c.archived_at IS NULL
    ORDER BY c.kind IN ('dm', 'group_dm'), c.name
  `);
}
