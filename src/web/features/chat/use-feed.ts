import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ConversationEvent, MessageDto } from '../../../shared/events';
import { api } from '@/lib/api';
import { openLiveSocket } from '@/lib/live-socket';
import type { SidebarConversation } from '@/lib/types';
import {
  addPending,
  applyEvents,
  dropPending,
  markPending,
  prependOlder,
  upsertConfirmed,
  type Feed,
  type FeedMessage,
} from './feed-state';

const PAGE = 50;
const TYPING_SHOWN_MS = 5000;
const TYPING_SEND_EVERY_MS = 3000;

export const feedKey = (id: string) => ['feed', id] as const;
type History = { messages: MessageDto[]; lastSeq: number; hasMore: boolean };

async function loadLatest(id: string): Promise<Feed> {
  const page = await api<History>(`/conversations/${id}/messages?limit=${PAGE}`);
  return { messages: page.messages, hasMore: page.hasMore, lastSeq: page.lastSeq };
}

/**
 * One conversation, live: the latest page of history, then every change pushed over its socket.
 * Events are applied strictly in seq order; a gap is filled from /events, and a reconnect replays
 * everything after the last event seen. Also exposes sending, older pages and typing.
 */
export function useFeed(conversationId: string, myId: string) {
  const client = useQueryClient();
  const key = feedKey(conversationId);
  const feed = useQuery({ queryKey: key, queryFn: () => loadLatest(conversationId), staleTime: Infinity });
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [connection, setConnection] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const socketRef = useRef<ReturnType<typeof openLiveSocket> | null>(null);
  const loaded = feed.isSuccess;

  useEffect(() => {
    if (!loaded) return;
    const current = () => client.getQueryData<Feed>(key);

    // Events queue up and are applied one batch at a time, so nothing that arrives while a gap is
    // being filled can be lost or applied out of order.
    let queue: ConversationEvent[] = [];
    let busy = false;
    const reload = async () => client.setQueryData(key, await loadLatest(conversationId));

    const applyBatch = async (events: ConversationEvent[]) => {
      const before = current();
      if (!before) return;
      let { feed: next, stop } = applyEvents(before, events);
      if (stop === 'gap') {
        // Missing events: fetch everything after the last one applied, then apply again.
        const res = await api<{ events: ConversationEvent[]; complete: boolean }>(
          `/conversations/${conversationId}/events?after=${next.lastSeq}&limit=500`,
        );
        ({ feed: next, stop } = applyEvents(next, [...res.events, ...events]));
        if (!res.complete || stop === 'gap') stop = 'reload';
      }
      client.setQueryData(key, next);
      if (events.some((e) => e.type === 'conversation.updated' || e.type.startsWith('member.'))) {
        void client.invalidateQueries({ queryKey: ['conversation', conversationId] });
        void client.invalidateQueries({ queryKey: ['conversations'] });
      }
      if (stop === 'reload') await reload();
    };

    const enqueue = async (event: ConversationEvent) => {
      queue.push(event);
      if (busy) return;
      busy = true;
      try {
        while (queue.length) {
          const batch = queue;
          queue = [];
          await applyBatch(batch).catch(reload);
        }
      } finally {
        busy = false;
      }
    };

    const socket = openLiveSocket({
      url: () => `/api/realtime/conversations/${conversationId}/socket?after=${current()?.lastSeq ?? 0}`,
      onStatus: setConnection,
      onMessage: (frame) => {
        const f = frame as { type: string; userId?: string; seq?: number };
        if (f.type === 'typing' && f.userId && f.userId !== myId) {
          const userId = f.userId;
          setTyping((t) => ({ ...t, [userId]: Date.now() }));
        } else if (f.type === 'resync') {
          void loadLatest(conversationId).then((fresh) => client.setQueryData(key, fresh));
        } else if (typeof f.seq === 'number' && f.type.includes('.')) {
          const event = frame as ConversationEvent;
          if (event.type === 'message.created') {
            const author = event.data.message.authorId;
            setTyping((t) => Object.fromEntries(Object.entries(t).filter(([id]) => id !== author)));
          }
          void enqueue(event);
        }
      },
    });
    socketRef.current = socket;
    return () => {
      socket.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is derived from conversationId
  }, [conversationId, loaded, myId, client]);

  // Typing names fade out after a few seconds without a new signal.
  useEffect(() => {
    if (!Object.keys(typing).length) return;
    const timer = setTimeout(() => {
      const now = Date.now();
      setTyping((t) => Object.fromEntries(Object.entries(t).filter(([, at]) => now - at < TYPING_SHOWN_MS)));
    }, 1000);
    return () => clearTimeout(timer);
  }, [typing]);

  const lastTypingSent = useRef(0);
  const sendTyping = useCallback(() => {
    if (Date.now() - lastTypingSent.current < TYPING_SEND_EVERY_MS) return;
    lastTypingSent.current = Date.now();
    socketRef.current?.send({ type: 'typing' });
  }, []);

  const send = useCallback(
    (body: string, clientMsgId = newClientMsgId()) =>
      sendMessage(client, conversationId, myId, body, clientMsgId),
    [client, conversationId, myId],
  );

  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadOlder = useCallback(async () => {
    const f = client.getQueryData<Feed>(feedKey(conversationId));
    const oldest = f?.messages.find((m) => !m.pending);
    if (!f?.hasMore || !oldest || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api<History>(
        `/conversations/${conversationId}/messages?before=${oldest.seq}&limit=${PAGE}`,
      );
      const latest = client.getQueryData<Feed>(feedKey(conversationId));
      if (latest)
        client.setQueryData(feedKey(conversationId), prependOlder(latest, page.messages, page.hasMore));
    } finally {
      setLoadingOlder(false);
    }
  }, [client, conversationId, loadingOlder]);

  return {
    feed,
    connection,
    typingUserIds: Object.keys(typing),
    sendTyping,
    send,
    loadOlder,
    loadingOlder,
  };
}

export const newClientMsgId = () => crypto.randomUUID().replaceAll('-', '');

/**
 * Shows the message at once as "sending", then swaps in the server's copy. The clientMsgId makes a
 * retry safe: the server returns the original instead of posting twice.
 */
export async function sendMessage(
  client: QueryClient,
  conversationId: string,
  myId: string,
  body: string,
  clientMsgId: string,
): Promise<void> {
  const key = feedKey(conversationId);
  const now = new Date().toISOString();
  const draft: FeedMessage = {
    id: `pending-${clientMsgId}`,
    conversationId,
    seq: Number.MAX_SAFE_INTEGER,
    authorId: myId,
    body,
    parentId: null,
    alsoInChannel: false,
    replyCount: 0,
    lastReplyAt: null,
    editedAt: null,
    deletedAt: null,
    createdAt: now,
    clientMsgId,
    webhookId: null,
    reactions: [],
  };
  client.setQueryData<Feed>(key, (f) => {
    if (!f) return f;
    const existing = f.messages.some((m) => m.pending && m.clientMsgId === clientMsgId);
    return existing ? markPending(f, clientMsgId, 'sending') : addPending(f, draft);
  });
  try {
    const { message } = await api<{ message: MessageDto }>(`/conversations/${conversationId}/messages`, {
      json: { body, clientMsgId },
    });
    client.setQueryData<Feed>(key, (f) => (f ? { ...f, messages: upsertConfirmed(f.messages, message) } : f));
    // Your own message means you've read everything up to it.
    client.setQueryData<SidebarConversation[]>(['conversations'], (list) =>
      list?.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              lastSeq: Math.max(c.lastSeq, message.seq),
              lastReadSeq: message.seq,
              unread: 0,
              mentions: 0,
            }
          : c,
      ),
    );
  } catch (err) {
    client.setQueryData<Feed>(key, (f) => (f ? markPending(f, clientMsgId, 'failed') : f));
    throw err;
  }
}

export function discardFailed(client: QueryClient, conversationId: string, clientMsgId: string) {
  client.setQueryData<Feed>(feedKey(conversationId), (f) => (f ? dropPending(f, clientMsgId) : f));
}
