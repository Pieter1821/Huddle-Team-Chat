// The open conversation's messages, and how each live event changes them. Pure functions, so the
// ordering rules (strict seq order, duplicates ignored, "sending" copies replaced by the server's)
// are unit-tested without a browser. No path aliases here: the tests import this file directly.

import type { ConversationEvent, MessageDto, ReactionSummary } from '../../../shared/events';

export type FeedMessage = MessageDto & { pending?: 'sending' | 'failed' };

export type Feed = {
  /** Confirmed messages in seq order, then any of yours still sending. */
  messages: FeedMessage[];
  hasMore: boolean;
  /** The last event applied. Events at or below it are duplicates. */
  lastSeq: number;
};

export type ApplyResult =
  | { kind: 'applied'; feed: Feed }
  | { kind: 'duplicate' }
  /** An event is missing before this one: fetch events after feed.lastSeq first. */
  | { kind: 'gap' }
  /** History changed in bulk (an import): reload. */
  | { kind: 'reload' };

export function applyEvent(feed: Feed, event: ConversationEvent): ApplyResult {
  if (event.seq <= feed.lastSeq) return { kind: 'duplicate' };
  if (event.seq > feed.lastSeq + 1) return { kind: 'gap' };
  if (event.type === 'history.imported') return { kind: 'reload' };
  return {
    kind: 'applied',
    feed: { ...feed, messages: applyToMessages(feed.messages, event), lastSeq: event.seq },
  };
}

/** Applies several events in seq order, stopping at the first one that needs a fetch or reload. */
export function applyEvents(
  feed: Feed,
  events: ConversationEvent[],
): { feed: Feed; stop?: 'gap' | 'reload' } {
  let current = feed;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const result = applyEvent(current, event);
    if (result.kind === 'applied') current = result.feed;
    else if (result.kind !== 'duplicate') return { feed: current, stop: result.kind };
  }
  return { feed: current };
}

function applyToMessages(messages: FeedMessage[], event: ConversationEvent): FeedMessage[] {
  switch (event.type) {
    case 'message.created': {
      const m = event.data.message;
      if (m.parentId && !m.alsoInChannel) {
        return update(messages, m.parentId, (p) => ({
          replyCount: p.replyCount + 1,
          lastReplyAt: m.createdAt,
        }));
      }
      return upsertConfirmed(messages, m);
    }
    case 'message.edited':
      return update(messages, event.data.messageId, () => ({
        body: event.data.body,
        editedAt: event.data.editedAt,
      }));
    case 'message.deleted': {
      const { messageId, parentId, deletedAt } = event.data;
      const next = update(messages, messageId, () => ({ body: '', deletedAt, files: [], reactions: [] }));
      return parentId ? update(next, parentId, (p) => ({ replyCount: Math.max(0, p.replyCount - 1) })) : next;
    }
    case 'reaction.added':
    case 'reaction.removed': {
      const { messageId, userId, emoji } = event.data;
      return update(messages, messageId, (m) => ({
        reactions: toggleReaction(m.reactions ?? [], emoji, userId, event.type === 'reaction.added'),
      }));
    }
    default:
      return messages;
  }
}

/**
 * Puts a confirmed message in its place by seq, replacing your "sending" copy (same clientMsgId)
 * and any earlier copy of itself. Used for live events and for the response to your own send.
 */
export function upsertConfirmed(messages: FeedMessage[], m: MessageDto): FeedMessage[] {
  const rest = messages.filter((x) => x.id !== m.id && !(m.clientMsgId && x.clientMsgId === m.clientMsgId));
  const confirmed = rest.filter((x) => !x.pending);
  const pending = rest.filter((x) => x.pending);
  const at = confirmed.findIndex((x) => x.seq > m.seq);
  if (at < 0) confirmed.push(m);
  else confirmed.splice(at, 0, m);
  return [...confirmed, ...pending];
}

export function addPending(feed: Feed, m: FeedMessage): Feed {
  return { ...feed, messages: [...feed.messages, { ...m, pending: 'sending' }] };
}

export function markPending(feed: Feed, clientMsgId: string, state: 'sending' | 'failed'): Feed {
  return {
    ...feed,
    messages: feed.messages.map((m) =>
      m.pending && m.clientMsgId === clientMsgId ? { ...m, pending: state } : m,
    ),
  };
}

export function dropPending(feed: Feed, clientMsgId: string): Feed {
  return { ...feed, messages: feed.messages.filter((m) => !(m.pending && m.clientMsgId === clientMsgId)) };
}

/** Older history goes in front; anything already present (from a live event) is not repeated. */
export function prependOlder(feed: Feed, older: MessageDto[], hasMore: boolean): Feed {
  const known = new Set(feed.messages.map((m) => m.id));
  return { ...feed, messages: [...older.filter((m) => !known.has(m.id)), ...feed.messages], hasMore };
}

export function toggleReaction(
  list: ReactionSummary[],
  emoji: string,
  userId: string,
  on: boolean,
): ReactionSummary[] {
  const existing = list.find((r) => r.emoji === emoji);
  if (on) {
    if (existing?.userIds.includes(userId)) return list;
    if (!existing) return [...list, { emoji, count: 1, userIds: [userId] }];
    return list.map((r) =>
      r === existing ? { ...r, count: r.count + 1, userIds: [...r.userIds, userId] } : r,
    );
  }
  if (!existing?.userIds.includes(userId)) return list;
  return list
    .map((r) =>
      r === existing ? { ...r, count: r.count - 1, userIds: r.userIds.filter((u) => u !== userId) } : r,
    )
    .filter((r) => r.count > 0);
}

function update(
  messages: FeedMessage[],
  id: string,
  patch: (m: FeedMessage) => Partial<FeedMessage>,
): FeedMessage[] {
  return messages.map((m) => (m.id === id ? { ...m, ...patch(m) } : m));
}

/* ------------------------------------------------------------------------------- threads */

export type Thread = { parent: FeedMessage; replies: FeedMessage[] };

/**
 * An open thread, updated by the same events as the conversation (which arrive in order through
 * the conversation's queue). Every change is idempotent, so seeing an event twice changes nothing.
 */
export function applyToThread(thread: Thread, event: ConversationEvent): Thread {
  const { parent } = thread;
  switch (event.type) {
    case 'message.created': {
      const m = event.data.message;
      if (m.parentId !== parent.id) return thread;
      return { ...thread, replies: upsertConfirmed(thread.replies, m) };
    }
    case 'message.edited':
    case 'message.deleted':
    case 'reaction.added':
    case 'reaction.removed': {
      const id = event.data.messageId;
      // Deleted replies leave the thread; a deleted parent keeps its place so replies still read.
      if (event.type === 'message.deleted' && id !== parent.id) {
        return { ...thread, replies: thread.replies.filter((r) => r.id !== id) };
      }
      const [p] = applyToMessages([parent], event);
      return { parent: p ?? parent, replies: applyToMessages(thread.replies, event) };
    }
    default:
      return thread;
  }
}
