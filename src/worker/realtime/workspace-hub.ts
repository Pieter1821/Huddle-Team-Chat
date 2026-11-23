import { DurableObject } from 'cloudflare:workers';

/** Messages the hub pushes to every signed-in browser tab. Ephemeral: never stored. */
export type HubMessage =
  | { type: 'presence.snapshot'; online: string[] }
  | { type: 'presence'; userId: string; online: boolean }
  | { type: 'activity'; conversationId: string; seq: number; authorId: string | null; mentioned: boolean }
  | { type: 'conversation.changed'; conversationId: string };

/** Messages one person may send: a burst of this many, then one more per second (60 a minute). */
export const SEND_BURST = 60;
const SEND_REFILL_PER_MS = 1 / 1000;

export type SendBucket = { tokens: number; at: number };

/**
 * One step of a token bucket: whether a send is allowed now, the bucket after it, and if not, how
 * many seconds until it would be. Pure, so the rule is tested on its own.
 */
export function takeSend(bucket: SendBucket | undefined, now: number) {
  const tokens = Math.min(
    SEND_BURST,
    (bucket?.tokens ?? SEND_BURST) + (now - (bucket?.at ?? now)) * SEND_REFILL_PER_MS,
  );
  if (tokens >= 1) return { allowed: true as const, bucket: { tokens: tokens - 1, at: now } };
  return {
    allowed: false as const,
    bucket: { tokens, at: now },
    retryAfter: Math.ceil((1 - tokens) / SEND_REFILL_PER_MS / 1000),
  };
}

/**
 * One per workspace. Holds a socket per open tab and answers two questions without anyone polling:
 * who is online, and which of my other conversations just got something new (for sidebar badges).
 * Presence is derived from the sockets themselves, so it survives hibernation with no stored state.
 */
export class WorkspaceHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings are answered by the runtime without waking a hibernated object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private online(): string[] {
    return [...new Set(this.ctx.getWebSockets().flatMap((ws) => this.ctx.getTags(ws)))];
  }

  private send(targets: Iterable<WebSocket>, message: HubMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of targets) {
      try {
        ws.send(payload);
      } catch {
        // Closing socket; the client refreshes its state when it reconnects.
      }
    }
  }

  /** Upgrade from the Worker, which has already authenticated the user and checked the Origin. */
  override fetch(request: Request): Response {
    const userId = request.headers.get('x-huddle-user-id');
    if (!userId || request.headers.get('upgrade') !== 'websocket') {
      return new Response('Expected an authenticated WebSocket upgrade', { status: 400 });
    }
    const wasOnline = this.ctx.getWebSockets(userId).length > 0;
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [userId]);
    this.send([server], { type: 'presence.snapshot', online: this.online() });
    if (!wasOnline) {
      this.send(
        this.ctx.getWebSockets().filter((ws) => ws !== server),
        { type: 'presence', userId, online: true },
      );
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // The hub takes no commands from clients; anything other than the auto-answered ping is ignored.
  override webSocketMessage(): void {}

  override webSocketClose(ws: WebSocket, code: number): void {
    const [userId] = this.ctx.getTags(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, 'closed');
    } catch {
      // already closed
    }
    if (userId && this.ctx.getWebSockets(userId).every((s) => s === ws)) {
      this.send(this.ctx.getWebSockets(), { type: 'presence', userId, online: false });
    }
  }

  /** Called by a conversation room after a new message: badge updates for its members' other tabs. */
  activity(input: {
    conversationId: string;
    seq: number;
    authorId: string | null;
    memberIds: string[];
    mentionedIds: string[];
  }): void {
    const mentioned = new Set(input.mentionedIds);
    for (const userId of input.memberIds) {
      if (userId === input.authorId) continue;
      this.send(this.ctx.getWebSockets(userId), {
        type: 'activity',
        conversationId: input.conversationId,
        seq: input.seq,
        authorId: input.authorId,
        mentioned: mentioned.has(userId),
      });
    }
  }

  /** Tells these users to refresh one conversation in their sidebar (joined, removed, renamed). */
  conversationChanged(conversationId: string, userIds: string[]): void {
    for (const userId of userIds) {
      this.send(this.ctx.getWebSockets(userId), { type: 'conversation.changed', conversationId });
    }
  }

  // Kept in memory only: counting in the database would double the writes of every message, the
  // very budget this protects. If the object restarts, everyone simply starts with a full bucket.
  private sendBuckets = new Map<string, SendBucket>();

  /**
   * Whether this person may send a message now. Stops a runaway script or a misused account from
   * spending the whole workspace's daily database allowance; people typing never come near it.
   */
  allowSend(userId: string): { allowed: true } | { allowed: false; retryAfter: number } {
    const now = Date.now();
    const result = takeSend(this.sendBuckets.get(userId), now);
    this.sendBuckets.set(userId, result.bucket);
    if (this.sendBuckets.size > 5000) {
      // Forget full buckets (people who haven't sent for a minute) so the map can't grow without end.
      for (const [id, b] of this.sendBuckets) {
        if (takeSend(b, now).bucket.tokens >= SEND_BURST - 1) this.sendBuckets.delete(id);
      }
    }
    return result.allowed ? { allowed: true } : { allowed: false, retryAfter: result.retryAfter };
  }

  /** Ends every live connection of a user (deactivation). */
  disconnectUser(userId: string): void {
    for (const ws of this.ctx.getWebSockets(userId)) ws.close(4003, 'access revoked');
  }
}

export const hubFor = (env: Env) => env.WORKSPACE_HUB.get(env.WORKSPACE_HUB.idFromName('workspace'));
