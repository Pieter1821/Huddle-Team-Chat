import { asc, inArray } from 'drizzle-orm';
import type { MessageDto, ReactionSummary } from '../../../shared/events';
import type { Db } from '../../db/client';
import type { message } from '../../db/schema';
import { file, reaction } from '../../db/schema';
import { toMessageDto } from '../../realtime/conversation-room';
import { toFileDto } from '../files/dto';

type MessageRow = typeof message.$inferSelect;

/**
 * Turns a page of message rows into DTOs with their reaction counts (in first-reacted order) and
 * attached files: two queries for the whole page, never one per message.
 */
export async function withReactions(db: Db, rows: MessageRow[]): Promise<MessageDto[]> {
  const ids = rows.map((r) => r.id);
  const [all, attached] = ids.length
    ? await Promise.all([
        db.select().from(reaction).where(inArray(reaction.messageId, ids)).orderBy(asc(reaction.createdAt)),
        db.select().from(file).where(inArray(file.messageId, ids)).orderBy(asc(file.createdAt)),
      ])
    : [[], []];

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
    // A deleted message shows no files (and they can no longer be downloaded).
    const files = row.deletedAt ? [] : attached.filter((f) => f.messageId === row.id).map(toFileDto);
    return { ...toMessageDto(row), reactions, files };
  });
}

/**
 * A reaction must be a real emoji (with optional skin tone, variation selector or joiner sequence),
 * not arbitrary text, and short.
 */
export const EMOJI_PATTERN = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️)+$/u;
