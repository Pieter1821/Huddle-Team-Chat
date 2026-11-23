import { DurableObject } from 'cloudflare:workers';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { ConversationEvent, MessageDto } from '../../shared/events';
import { getDb, type Db } from '../db/client';
import {
  conversation,
  conversationEvent,
  conversationMember,
  file,
  message,
  messageMention,
  notification,
  reaction,
} from '../db/schema';
import { parseMentions } from '../../shared/mentions';
import { toFileDto } from '../modules/files/dto';
import { AppError, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/id';
import { hubFor } from './workspace-hub';

const TYPING_THROTTLE_MS = 3000;
const MAX_CLIENT_FRAME = 1024;
const REPLAY_LIMIT = 500;
const MAX_DISTINCT_REACTIONS = 50;
/** Keeps one import batch well inside the per-request query limits. */
export const MAX_IMPORT_REACTIONS = 20;

/** Ephemeral frames that are never stored and carry no seq. */
export type RoomSignal =
  | { type: 'ready'; conversationId: string; lastSeq: number }
  | { type: 'resync'; conversationId: string; lastSeq: number }
  | { type: 'typing'; conversationId: string; userId: string };

type MessageRow = typeof message.$inferSelect;
type BatchItem = Parameters<Db['batch']>[0][number];

/** An event before the room has numbered it. */
type NewEvent = ConversationEvent extends infer E
  ? E extends { type: infer T; data: infer D }
    ? { type: T; data: D }
    : never
  : never;

export const toMessageDto = (m: MessageRow): MessageDto => ({
  id: m.id,
  conversationId: m.conversationId,
  seq: m.seq,
  authorId: m.authorId,
  body: m.body,
  parentId: m.parentId,
  alsoInChannel: m.alsoInChannel,
  replyCount: m.replyCount,
  lastReplyAt: m.lastReplyAt?.toISOString() ?? null,
  editedAt: m.editedAt?.toISOString() ?? null,
  deletedAt: m.deletedAt?.toISOString() ?? null,
  createdAt: m.createdAt.toISOString(),
  clientMsgId: m.clientMsgId,
  webhookId: m.webhookId,
});

/**
 * Refusals cross the Durable Object RPC boundary as data: thrown errors lose their status and code on
 * the way back to the Worker, which would turn a clean 403/404 into a 500.
 */
export type RoomResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { status: AppError['status']; code: string; message: string } };

async function attempt<T>(work: () => Promise<T>): Promise<RoomResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (err) {
    if (err instanceof AppError)
      return { ok: false, error: { status: err.status, code: err.code, message: err.message } };
    throw err;
  }
}

/** A historical message from an import, in Huddle format (already converted from Slack). */
export type ImportedMessage = {
  /** Stable per source message (e.g. slack-<channel>-<ts>), so re-running an import skips it. */
  clientMsgId: string;
  authorId: string | null;
  body: string;
  /** Epoch milliseconds of the original message. */
  createdAt: number;
  parentClientMsgId?: string | null | undefined;
  reactions?: { emoji: string; userIds: string[] }[] | undefined;
};

export type ImportResult = { imported: number; skipped: number };

export type PostInput = {
  conversationId: string;
  /** null for messages from an incoming webhook (then webhookId is set). */
  authorId: string | null;
  webhookId?: string | null | undefined;
  webhookName?: string | null | undefined;
  body: string;
  clientMsgId: string;
  parentId?: string | null | undefined;
  alsoInChannel?: boolean | undefined;
  fileIds?: string[] | undefined;
};

/**
 * One instance per conversation (named by the conversation id). It is the only writer of that
 * conversation's messages and events, so it hands out seq numbers with no gaps or repeats.
 * D1 stays the source of truth: memory only caches the last seq and is rebuilt after a restart.
 */
export class ConversationRoom extends DurableObject<Env> {
  private readonly db: Db;
  private lastSeq: number | null = null;
  // Writes run one at a time. D1 calls are I/O, during which a Durable Object may start handling the
  // next request; without this queue two messages could be given the same seq.
  private queue: Promise<unknown> = Promise.resolve();

  // Last typing signal per user, to throttle. Losing it on hibernation is harmless.
  private readonly typingAt = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = getDb(env);
    // Keep-alive pings are answered by the runtime without waking a hibernated room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async currentSeq(conversationId: string): Promise<number> {
    if (this.lastSeq === null) {
      const row = await this.db.query.conversation.findFirst({
        where: eq(conversation.id, conversationId),
        columns: { lastSeq: true },
      });
      if (!row) throw notFound('That conversation');
      this.lastSeq = row.lastSeq;
    }
    return this.lastSeq;
  }

  /**
   * Builds the change for the next seq, writes it and its event in ONE atomic D1 batch, then
   * broadcasts. If the batch fails nothing is written and the seq is not used. If the broadcast never
   * happens (the object restarted), the event stays unpublished and `publishPending` sends it later.
   * Must run inside `serialize`.
   */
  private async commit(
    conversationId: string,
    build: (seq: number, at: Date) => { event: NewEvent; changes: BatchItem[] },
  ): Promise<ConversationEvent> {
    const seq = (await this.currentSeq(conversationId)) + 1;
    const at = new Date();
    const { event, changes } = build(seq, at);
    const full = { ...event, conversationId, seq, at: at.toISOString() };
    try {
      // All or nothing: the event row, the new last_seq and the change itself.
      await this.db.batch([
        this.db
          .insert(conversationEvent)
          .values({ conversationId, seq, type: full.type, payload: full, createdAt: at }),
        this.db.update(conversation).set({ lastSeq: seq }).where(eq(conversation.id, conversationId)),
        ...changes,
      ]);
    } catch (err) {
      this.lastSeq = null; // re-read from D1 next time rather than trust a possibly stale cache
      throw err;
    }
    this.lastSeq = seq;
    await this.publish(full);
    return full;
  }

  private async publish(event: ConversationEvent): Promise<void> {
    this.broadcast(JSON.stringify(event));
    await this.notifyHub(event);
    await this.db
      .update(conversationEvent)
      .set({ publishedAt: new Date() })
      .where(
        and(eq(conversationEvent.conversationId, event.conversationId), eq(conversationEvent.seq, event.seq)),
      );
  }

  /**
   * Lets members' other tabs know (sidebar badges, membership changes). Best effort: the event is
   * already saved and broadcast, and clients refresh their sidebar whenever they reconnect.
   */
  private async notifyHub(event: ConversationEvent): Promise<void> {
    try {
      const hub = hubFor(this.env);
      if (event.type === 'message.created') {
        const memberIds = await this.memberIds(event.conversationId);
        const { mentioned } = this.resolveMentions(
          event.data.message.body,
          memberIds,
          event.data.message.authorId,
        );
        await hub.activity({
          conversationId: event.conversationId,
          seq: event.seq,
          authorId: event.data.message.authorId,
          memberIds,
          mentionedIds: [...mentioned],
        });
      } else if (event.type === 'member.joined' || event.type === 'member.left') {
        await hub.conversationChanged(event.conversationId, [event.data.userId]);
      }
    } catch (err) {
      console.error('hub notification failed', err);
    }
  }

  private async memberIds(conversationId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: conversationMember.userId })
      .from(conversationMember)
      .where(eq(conversationMember.conversationId, conversationId));
    return rows.map((r) => r.userId);
  }

  /**
   * Who a message mentions. Only members of this conversation count, so mentioning an outsider in a
   * private channel stores nothing and notifies nobody (and leaks nothing). <@channel> and <@here>
   * reach every member; the author is never notified about their own message.
   */
  private resolveMentions(body: string, memberIds: string[], authorId: string | null) {
    const parsed = parseMentions(body);
    const members = new Set(memberIds);
    const direct = parsed.userIds.filter((id) => members.has(id));
    const targets = [...direct, ...(parsed.channel ? ['channel'] : []), ...(parsed.here ? ['here'] : [])];
    const mentioned = new Set(parsed.channel || parsed.here ? memberIds : direct);
    if (authorId) mentioned.delete(authorId);
    return { targets, mentioned };
  }

  private async conversationKind(conversationId: string) {
    const row = await this.db.query.conversation.findFirst({
      where: eq(conversation.id, conversationId),
      columns: { kind: true },
    });
    if (!row) throw notFound('That conversation');
    return row.kind;
  }

  /**
   * Notification rows (for the Mentions view and email digests): mentions, every other member of a
   * DM, and the people already in a thread when it gets a reply. One row per person per message;
   * the unique key makes a repeat harmless.
   */
  private async notificationsFor(input: {
    conversationId: string;
    authorId: string | null;
    body: string;
    parentId: string | null;
  }) {
    const memberIds = await this.memberIds(input.conversationId);
    const { targets, mentioned } = this.resolveMentions(input.body, memberIds, input.authorId);
    const notify = new Map<string, 'mention' | 'dm' | 'thread_reply'>();
    for (const id of mentioned) notify.set(id, 'mention');

    const kind = await this.conversationKind(input.conversationId);
    if (kind === 'dm' || kind === 'group_dm') {
      for (const id of memberIds) if (id !== input.authorId && !notify.has(id)) notify.set(id, 'dm');
    }
    if (input.parentId) {
      const participants = await this.db.all<{ userId: string }>(sql`
        SELECT author_id AS userId FROM message WHERE id = ${input.parentId} AND author_id IS NOT NULL
        UNION SELECT author_id FROM message WHERE parent_id = ${input.parentId} AND author_id IS NOT NULL`);
      for (const { userId } of participants) {
        if (userId !== input.authorId && !notify.has(userId) && memberIds.includes(userId)) {
          notify.set(userId, 'thread_reply');
        }
      }
    }
    return { targets, notify };
  }

  private mentionAndNotificationRows(
    messageId: string,
    targets: string[],
    notify: Map<string, 'mention' | 'dm' | 'thread_reply'>,
    at: Date,
  ): BatchItem[] {
    return [
      ...targets.map((target) =>
        this.db.insert(messageMention).values({ messageId, target }).onConflictDoNothing(),
      ),
      ...[...notify].map(([userId, kind]) =>
        this.db
          .insert(notification)
          .values({ id: newId(), userId, messageId, kind, createdAt: at })
          .onConflictDoNothing(),
      ),
    ];
  }

  /** Sends to every socket connected to this conversation. */
  protected broadcast(payload: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // A socket that is closing cannot receive; replay covers it when it reconnects.
      }
    }
  }

  /** Outbox recovery: broadcasts events that were saved but never published (e.g. after a crash). */
  async publishPending(conversationId: string): Promise<number> {
    return this.serialize(async () => {
      const pending = await this.db
        .select({ payload: conversationEvent.payload })
        .from(conversationEvent)
        .where(
          and(eq(conversationEvent.conversationId, conversationId), isNull(conversationEvent.publishedAt)),
        )
        .orderBy(asc(conversationEvent.seq));
      for (const row of pending) await this.publish(row.payload as ConversationEvent);
      return pending.length;
    });
  }

  async post(input: PostInput): Promise<RoomResult<{ message: MessageDto; created: boolean }>> {
    return this.serialize(() =>
      attempt(async () => {
        // A retried send (same author or webhook, same clientMsgId) returns the original, not a duplicate.
        const existing = await this.db.query.message.findFirst({
          where: and(
            input.authorId
              ? eq(message.authorId, input.authorId)
              : eq(message.webhookId, input.webhookId ?? ''),
            eq(message.clientMsgId, input.clientMsgId),
          ),
        });
        if (existing) {
          if (existing.conversationId !== input.conversationId) {
            throw new AppError(409, 'client_msg_id_reused', 'That message id was already used elsewhere.');
          }
          return {
            message: { ...toMessageDto(existing), webhookName: input.webhookName ?? null },
            created: false,
          };
        }

        let parentId: string | null = null;
        if (input.parentId) {
          const parent = await this.db.query.message.findFirst({
            where: and(eq(message.id, input.parentId), eq(message.conversationId, input.conversationId)),
            columns: { id: true, parentId: true, deletedAt: true },
          });
          // Threads are one level deep: you reply to a top-level message, never to a reply.
          if (!parent || parent.parentId || parent.deletedAt) throw notFound('That message');
          parentId = parent.id;
        }

        const id = newId();
        const files = await this.claimableFiles(input);
        const { targets, notify } = await this.notificationsFor({
          conversationId: input.conversationId,
          authorId: input.authorId,
          body: input.body,
          parentId,
        });

        let created!: MessageDto;
        await this.commit(input.conversationId, (seq, at) => {
          const row = {
            id,
            conversationId: input.conversationId,
            seq,
            authorId: input.authorId,
            webhookId: input.webhookId ?? null,
            clientMsgId: input.clientMsgId,
            parentId,
            body: input.body,
            alsoInChannel: Boolean(parentId && input.alsoInChannel),
            replyCount: 0,
            lastReplyAt: null,
            editedAt: null,
            deletedAt: null,
            createdAt: at,
          };
          created = {
            ...toMessageDto({ ...row, rowId: 0 }),
            files: files.map(toFileDto),
            webhookName: input.webhookName ?? null,
          };
          return {
            event: { type: 'message.created', data: { message: created } },
            changes: [
              this.db.insert(message).values(row),
              ...(files.length
                ? [
                    this.db
                      .update(file)
                      .set({ messageId: id })
                      .where(
                        inArray(
                          file.id,
                          files.map((f) => f.id),
                        ),
                      ),
                  ]
                : []),
              ...this.mentionAndNotificationRows(id, targets, notify, at),
              ...(parentId
                ? [
                    this.db
                      .update(message)
                      .set({ replyCount: sql`${message.replyCount} + 1`, lastReplyAt: at })
                      .where(eq(message.id, parentId)),
                  ]
                : []),
            ],
          };
        });
        return { message: created, created: true };
      }),
    );
  }

  async edit(input: {
    conversationId: string;
    messageId: string;
    actorId: string;
    body: string;
  }): Promise<RoomResult<MessageDto>> {
    return this.serialize(() =>
      attempt(async () => {
        const target = await this.findLive(input.conversationId, input.messageId);
        if (target.authorId !== input.actorId) throw forbidden('You can only edit your own messages.');
        // Mentions follow the new text: removed ones go, newly added people are notified once.
        const { targets, notify } = await this.notificationsFor({
          conversationId: input.conversationId,
          authorId: input.actorId,
          body: input.body,
          parentId: null,
        });
        for (const [userId, kind] of notify) if (kind !== 'mention') notify.delete(userId);
        let editedAt!: Date;
        await this.commit(input.conversationId, (_seq, at) => {
          editedAt = at;
          return {
            event: {
              type: 'message.edited',
              data: { messageId: target.id, body: input.body, editedAt: at.toISOString() },
            },
            changes: [
              this.db
                .update(message)
                .set({ body: input.body, editedAt: at })
                .where(eq(message.id, target.id)),
              this.db.delete(messageMention).where(eq(messageMention.messageId, target.id)),
              ...this.mentionAndNotificationRows(target.id, targets, notify, at),
            ],
          };
        });
        return toMessageDto({ ...target, body: input.body, editedAt });
      }),
    );
  }

  /** Soft delete: the row stays (threads and seq stay intact) but its text is wiped everywhere. */
  async remove(input: {
    conversationId: string;
    messageId: string;
    actorId: string;
    actorIsAdmin: boolean;
  }): Promise<RoomResult<null>> {
    return this.serialize(() =>
      attempt(async () => {
        const target = await this.findLive(input.conversationId, input.messageId);
        if (target.authorId !== input.actorId && !input.actorIsAdmin) {
          throw forbidden('You can only delete your own messages.');
        }
        await this.commit(input.conversationId, (_seq, at) => ({
          event: {
            type: 'message.deleted',
            data: { messageId: target.id, parentId: target.parentId, deletedAt: at.toISOString() },
          },
          changes: [
            this.db.update(message).set({ body: '', deletedAt: at }).where(eq(message.id, target.id)),
            ...(target.parentId
              ? [
                  this.db
                    .update(message)
                    .set({ replyCount: sql`max(${message.replyCount} - 1, 0)` })
                    .where(eq(message.id, target.parentId)),
                ]
              : []),
          ],
        }));
        return null;
      }),
    );
  }

  /**
   * Adds or removes one person's emoji on a message. Repeating an add (or a remove) changes nothing
   * and records no event, so double-clicks and retries are harmless.
   */
  async react(input: {
    conversationId: string;
    messageId: string;
    userId: string;
    emoji: string;
    add: boolean;
  }): Promise<RoomResult<{ changed: boolean }>> {
    return this.serialize(() =>
      attempt(async () => {
        const target = await this.findLive(input.conversationId, input.messageId);
        const mine = and(
          eq(reaction.messageId, target.id),
          eq(reaction.userId, input.userId),
          eq(reaction.emoji, input.emoji),
        );
        const exists = Boolean(
          await this.db.query.reaction.findFirst({ where: mine, columns: { emoji: true } }),
        );
        if (exists === input.add) return { changed: false };

        if (input.add) {
          const kinds = await this.db.all<{ n: number }>(sql`
            SELECT count(DISTINCT emoji) AS n FROM reaction WHERE message_id = ${target.id}
              AND emoji <> ${input.emoji}`);
          if ((kinds[0]?.n ?? 0) >= MAX_DISTINCT_REACTIONS) {
            throw new AppError(
              409,
              'too_many_reactions',
              'This message has as many different reactions as it can hold.',
            );
          }
        }
        await this.commit(input.conversationId, (_seq, at) => ({
          event: {
            type: input.add ? 'reaction.added' : 'reaction.removed',
            data: { messageId: target.id, userId: input.userId, emoji: input.emoji },
          },
          changes: [
            input.add
              ? this.db
                  .insert(reaction)
                  .values({ messageId: target.id, userId: input.userId, emoji: input.emoji, createdAt: at })
              : this.db.delete(reaction).where(mine),
          ],
        }));
        return { changed: true };
      }),
    );
  }

  /**
   * Imports a batch of historical messages (oldest first) in ONE atomic D1 batch. Each message takes
   * the next seq; instead of an event per message (which would double the database writes against
   * the free plan's daily limit), one 'history.imported' event covering the range is recorded, so a
   * reconnecting client knows why those seqs have no individual events and reloads history.
   * Messages already imported (same clientMsgId in this conversation) are skipped, so an import can
   * be re-run. Imported history creates no notifications.
   */
  async importMessages(
    conversationId: string,
    messages: ImportedMessage[],
  ): Promise<RoomResult<ImportResult>> {
    return this.serialize(() =>
      attempt(async () => {
        const keys = messages.map((m) => m.clientMsgId);
        const existing = await this.db
          .select({ clientMsgId: message.clientMsgId })
          .from(message)
          .where(and(eq(message.conversationId, conversationId), inArray(message.clientMsgId, keys)));
        const done = new Set(existing.map((e) => e.clientMsgId));
        const fresh = messages.filter((m) => !done.has(m.clientMsgId));
        if (!fresh.length) return { imported: 0, skipped: messages.length };

        // Thread parents: earlier in this batch, or imported in an earlier batch.
        const ids = new Map(fresh.map((m) => [m.clientMsgId, newId()] as const));
        const parentKeys = [
          ...new Set(
            fresh.map((m) => m.parentClientMsgId).filter((k): k is string => Boolean(k) && !ids.has(k!)),
          ),
        ];
        const parents = parentKeys.length
          ? await this.db
              .select({ id: message.id, clientMsgId: message.clientMsgId })
              .from(message)
              .where(
                and(eq(message.conversationId, conversationId), inArray(message.clientMsgId, parentKeys)),
              )
          : [];
        const known = new Map([...parents.map((p) => [p.clientMsgId!, p.id] as const), ...ids]);

        const first = (await this.currentSeq(conversationId)) + 1;
        const last = first + fresh.length - 1;
        const eventSeq = last + 1;
        const at = new Date();
        const rows = fresh.map((m, i) => ({
          id: ids.get(m.clientMsgId)!,
          conversationId,
          seq: first + i,
          authorId: m.authorId,
          webhookId: null,
          clientMsgId: m.clientMsgId,
          // A reply whose parent was never imported becomes a normal message rather than an orphan.
          parentId:
            (m.parentClientMsgId &&
              m.parentClientMsgId !== m.clientMsgId &&
              known.get(m.parentClientMsgId)) ||
            null,
          body: m.body,
          alsoInChannel: false,
          replyCount: 0,
          lastReplyAt: null,
          editedAt: null,
          deletedAt: null,
          createdAt: new Date(m.createdAt),
        }));
        const seen = new Set<string>();
        const reactions = fresh.flatMap((m) =>
          (m.reactions ?? []).flatMap((r) =>
            r.userIds
              .map((userId) => ({
                messageId: ids.get(m.clientMsgId)!,
                userId,
                emoji: r.emoji,
                createdAt: new Date(m.createdAt),
              }))
              .filter((row) => {
                const key = `${row.messageId}|${row.userId}|${row.emoji}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              }),
          ),
        );
        if (reactions.length > MAX_IMPORT_REACTIONS) {
          throw new AppError(
            413,
            'batch_too_large',
            `Send at most ${MAX_IMPORT_REACTIONS} reactions per batch.`,
          );
        }

        const event = {
          type: 'history.imported' as const,
          conversationId,
          seq: eventSeq,
          at: at.toISOString(),
          data: { fromSeq: first, toSeq: last, count: fresh.length },
        };
        try {
          await this.db.batch([
            this.db
              .insert(conversationEvent)
              .values({ conversationId, seq: eventSeq, type: event.type, payload: event, createdAt: at }),
            this.db
              .update(conversation)
              .set({ lastSeq: eventSeq })
              .where(eq(conversation.id, conversationId)),
            ...rows.map((row) => this.db.insert(message).values(row)),
            ...(reactions.length ? [this.db.insert(reaction).values(reactions).onConflictDoNothing()] : []),
          ]);
        } catch (err) {
          this.lastSeq = null;
          throw err;
        }
        this.lastSeq = eventSeq;
        await this.publish(event);
        return { imported: fresh.length, skipped: messages.length - fresh.length };
      }),
    );
  }

  /** Records a membership or settings change the API already applied, so connected clients hear of it. */
  async recordEvent(
    conversationId: string,
    event: Extract<NewEvent, { type: 'member.joined' | 'member.left' | 'conversation.updated' }>,
  ): Promise<ConversationEvent> {
    return this.serialize(() => this.commit(conversationId, () => ({ event, changes: [] })));
  }

  /** Events after `afterSeq`, oldest first, for clients catching up after a gap or reconnect. */
  async eventsAfter(conversationId: string, afterSeq: number, limit = 200): Promise<ConversationEvent[]> {
    const rows = await this.db
      .select({ payload: conversationEvent.payload })
      .from(conversationEvent)
      .where(and(eq(conversationEvent.conversationId, conversationId), gt(conversationEvent.seq, afterSeq)))
      .orderBy(asc(conversationEvent.seq))
      .limit(limit);
    return rows.map((r) => r.payload as ConversationEvent);
  }

  /* ------------------------------------------------------------------------- live connections */

  /**
   * WebSocket upgrade forwarded by the Worker, which has already authenticated the user, checked the
   * Origin and checked they may read this conversation. The socket is accepted first, then missed
   * events are replayed, so nothing committed in between can be lost (at worst it arrives twice and
   * the client drops the duplicate seq).
   */
  override async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get('x-huddle-user-id');
    const conversationId = request.headers.get('x-huddle-conversation-id');
    if (!userId || !conversationId || request.headers.get('upgrade') !== 'websocket') {
      return new Response('Expected an authenticated WebSocket upgrade', { status: 400 });
    }
    const after = Math.max(0, Number(new URL(request.url).searchParams.get('after') ?? 0) || 0);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [userId]);
    server.serializeAttachment({ userId, conversationId });

    const missed = await this.eventsAfter(conversationId, after, REPLAY_LIMIT);
    const lastSeq = await this.currentSeq(conversationId);
    if (missed.length === REPLAY_LIMIT) {
      // Too far behind to replay event by event: the client reloads history instead.
      this.signal([server], { type: 'resync', conversationId, lastSeq });
    } else {
      for (const event of missed) server.send(JSON.stringify(event));
      this.signal([server], { type: 'ready', conversationId, lastSeq });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    // Clients only ever send small control frames; anything large or unknown is ignored.
    if (typeof data !== 'string' || data.length > MAX_CLIENT_FRAME) return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if ((frame as { type?: unknown }).type !== 'typing') return;

    const { userId, conversationId } = ws.deserializeAttachment() as {
      userId: string;
      conversationId: string;
    };
    const now = Date.now();
    if (now - (this.typingAt.get(userId) ?? 0) < TYPING_THROTTLE_MS) return;
    this.typingAt.set(userId, now);
    this.signal(
      this.ctx.getWebSockets().filter((s) => s !== ws),
      { type: 'typing', conversationId, userId },
    );
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code === 1005 ? 1000 : code, 'closed');
    } catch {
      // already closed
    }
  }

  /** Closes a user's sockets here, e.g. after they leave, are removed or are deactivated. */
  disconnectUser(userId: string): void {
    for (const ws of this.ctx.getWebSockets(userId)) ws.close(4003, 'access revoked');
  }

  private signal(targets: WebSocket[], message: RoomSignal): void {
    const payload = JSON.stringify(message);
    for (const ws of targets) {
      try {
        ws.send(payload);
      } catch {
        // closing socket
      }
    }
  }

  /**
   * Files a message may attach: uploaded by its author, to this conversation, and not yet on any
   * message. Anyone else's file id (or one already used) makes the whole send fail, so a message can
   * never "borrow" a file from another conversation.
   */
  private async claimableFiles(input: PostInput) {
    const ids = [...new Set(input.fileIds ?? [])];
    if (!ids.length) return [];
    // Webhook messages have no author, so they cannot carry uploads.
    const authorId = input.authorId;
    if (!authorId) throw notFound('One of those files');
    const rows = await this.db
      .select()
      .from(file)
      .where(
        and(
          inArray(file.id, ids),
          eq(file.conversationId, input.conversationId),
          eq(file.uploaderId, authorId),
          isNull(file.messageId),
          eq(file.status, 'ready'),
        ),
      );
    if (rows.length !== ids.length) throw notFound('One of those files');
    return rows;
  }

  private async findLive(conversationId: string, messageId: string): Promise<MessageRow> {
    const row = await this.db.query.message.findFirst({
      where: and(eq(message.id, messageId), eq(message.conversationId, conversationId)),
    });
    if (!row || row.deletedAt) throw notFound('That message');
    return row;
  }
}
