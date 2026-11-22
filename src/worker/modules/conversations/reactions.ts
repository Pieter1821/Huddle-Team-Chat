import { asc, inArray } from 'drizzle-orm';
import type { MessageDto, ReactionSummary } from '../../../shared/events';
import type { Db } from '../../db/client';
import type { message } from '../../db/schema';
import { reaction } from '../../db/schema';
import { toMessageDto } from '../../realtime/conversation-room';

type MessageRow = typeof message.$inferSelect;

/** Attaches reaction counts (in first-reacted order) to a page of messages with one query. */
export async function withReactions(db: Db, rows: MessageRow[]): Promise<MessageDto[]> {
  const ids = rows.map((r) => r.id);
  const all = ids.length
    ? await db
        .select()
        .from(reaction)
        .where(inArray(reaction.messageId, ids))
        .orderBy(asc(reaction.createdAt))
    : [];
  const byMessage = new Map<string, Map<string, string[]>>();
  for (const r of all) {
    const emojis = byMessage.get(r.messageId) ?? new Map<string, string[]>();
    emojis.set(r.emoji, [...(emojis.get(r.emoji) ?? []), r.userId]);
    byMessage.set(r.messageId, emojis);
  }
  return rows.map((row) => {
    const emojis = byMessage.get(row.id);
    const reactions: ReactionSummary[] = emojis
      ? [...emojis].map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }))
      : [];
    return { ...toMessageDto(row), reactions };
  });
}

/**
 * A reaction must be a real emoji (with optional skin tone, variation selector or joiner sequence),
 * not arbitrary text, and short.
 */
export const EMOJI_PATTERN = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️)+$/u;
