import { DurableObject } from 'cloudflare:workers';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { ConversationEvent, MessageDto } from '../../shared/events';
import { getDb, type Db } from '../db/client';
import { conversation, conversationEvent, conversationMember, message } from '../db/schema';
import { AppError, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/id';
import { hubFor } from './workspace-hub';

const TYPING_THROTTLE_MS = 3000;
const MAX_CLIENT_FRAME = 1024;
const REPLAY_LIMIT = 500;

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

export type PostInput = {
  conversationId: string;
  authorId: string;
  body: string;
  clientMsgId: string;
  parentId?: string | null | undefined;
  alsoInChannel?: boolean | undefined;
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
        const members = await this.db
          .select({ userId: conversationMember.userId })
          .from(conversationMember)
          .where(eq(conversationMember.conversationId, event.conversationId));
        await hub.activity({
          conversationId: event.conversationId,
          seq: event.seq,
          authorId: event.data.message.authorId,
          memberIds: members.map((m) => m.userId),
          mentionedIds: [],
        });
      } else if (event.type === 'member.joined' || event.type === 'member.left') {
        await hub.conversationChanged(event.conversationId, [event.data.userId]);
      }
    } catch (err) {
      console.error('hub notification failed', err);
    }
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
        // A retried send (same author, same clientMsgId) returns the original instead of a duplicate.
        const existing = await this.db.query.message.findFirst({
          where: and(eq(message.authorId, input.authorId), eq(message.clientMsgId, input.clientMsgId)),
        });
        if (existing) {
          if (existing.conversationId !== input.conversationId) {
            throw new AppError(409, 'client_msg_id_reused', 'That message id was already used elsewhere.');
          }
          return { message: toMessageDto(existing), created: false };
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

        let created!: MessageDto;
        await this.commit(input.conversationId, (seq, at) => {
          const row = {
            id: newId(),
            conversationId: input.conversationId,
            seq,
            authorId: input.authorId,
            webhookId: null,
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
          created = toMessageDto({ ...row, rowId: 0 });
          return {
            event: { type: 'message.created', data: { message: created } },
            changes: [
              this.db.insert(message).values(row),
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

  private async findLive(conversationId: string, messageId: string): Promise<MessageRow> {
    const row = await this.db.query.message.findFirst({
      where: and(eq(message.id, messageId), eq(message.conversationId, conversationId)),
    });
    if (!row || row.deletedAt) throw notFound('That message');
    return row;
  }
}
