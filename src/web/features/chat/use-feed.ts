import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ConversationEvent, FileDto, MessageDto } from '../../../shared/events';
import { api } from '@/lib/api';
import { openLiveSocket } from '@/lib/live-socket';
import type { SidebarConversation } from '@/lib/types';
import {
  addPending,
  applyEvents,
  applyToThread,
  dropPending,
  markPending,
  prependOlder,
  upsertConfirmed,
  type Feed,
  type FeedMessage,
  type Thread,
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
      let all = events;
      let { feed: next, stop } = applyEvents(before, events);
      if (stop === 'gap') {
        // Missing events: fetch everything after the last one applied, then apply again.
        const res = await api<{ events: ConversationEvent[]; complete: boolean }>(
          `/conversations/${conversationId}/events?after=${next.lastSeq}&limit=500`,
        );
        all = [...res.events, ...events];
        ({ feed: next, stop } = applyEvents(next, all));
        if (!res.complete || stop === 'gap') stop = 'reload';
      }
      client.setQueryData(key, next);
      // Open threads in this conversation follow the same events (each change is idempotent).
      const ordered = [...all].sort((a, b) => a.seq - b.seq);
      client.setQueriesData<Thread>({ queryKey: ['thread', conversationId] }, (t) =>
        t ? ordered.reduce(applyToThread, t) : t,
      );
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
    (draft: Omit<OutgoingMessage, 'conversationId' | 'myId' | 'clientMsgId'>) =>
      sendMessage(client, { ...draft, conversationId, myId, clientMsgId: newClientMsgId() }),
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

export const threadKey = (conversationId: string, parentId: string) =>
  ['thread', conversationId, parentId] as const;

export type OutgoingMessage = {
  conversationId: string;
  myId: string;
  clientMsgId: string;
  body: string;
  files?: FileDto[];
  parentId?: string | null;
  alsoInChannel?: boolean;
};

/**
 * Shows the message at once as "sending" (in the conversation, its thread, or both), then swaps in
 * the server's copy. The clientMsgId makes a retry safe: the server returns the original instead of
 * posting twice.
 */
export async function sendMessage(client: QueryClient, out: OutgoingMessage): Promise<void> {
  const { conversationId, clientMsgId, parentId = null, alsoInChannel = false, files = [] } = out;
  const inChannel = !parentId || alsoInChannel;
  const draft: FeedMessage = {
    id: `pending-${clientMsgId}`,
    conversationId,
    seq: Number.MAX_SAFE_INTEGER,
    authorId: out.myId,
    body: out.body,
    parentId,
    alsoInChannel,
    replyCount: 0,
    lastReplyAt: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    clientMsgId,
    webhookId: null,
    reactions: [],
    files,
  };
  const feed = feedKey(conversationId);
  const thread = parentId ? threadKey(conversationId, parentId) : null;
  const setState = (state: 'sending' | 'failed') => {
    if (inChannel) {
      client.setQueryData<Feed>(feed, (f) => {
        if (!f) return f;
        const known = f.messages.some((m) => m.pending && m.clientMsgId === clientMsgId);
        return known ? markPending(f, clientMsgId, state) : addPending(f, { ...draft, pending: state });
      });
    }
    if (thread) {
      client.setQueryData<Thread>(thread, (t) => {
        if (!t) return t;
        const known = t.replies.some((m) => m.pending && m.clientMsgId === clientMsgId);
        return {
          ...t,
          replies: known
            ? t.replies.map((m) =>
                m.pending && m.clientMsgId === clientMsgId ? { ...m, pending: state } : m,
              )
            : [...t.replies, { ...draft, pending: state }],
        };
      });
    }
  };

  setState('sending');
  try {
    const { message } = await api<{ message: MessageDto }>(`/conversations/${conversationId}/messages`, {
      json: {
        body: out.body,
        clientMsgId,
        ...(parentId ? { parentId, alsoInChannel } : {}),
        ...(files.length ? { fileIds: files.map((f) => f.id) } : {}),
      },
    });
    if (inChannel) {
      client.setQueryData<Feed>(feed, (f) =>
        f ? { ...f, messages: upsertConfirmed(f.messages, message) } : f,
      );
    }
    if (thread) {
      client.setQueryData<Thread>(thread, (t) =>
        t ? { ...t, replies: upsertConfirmed(t.replies, message) } : t,
      );
    }
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
    setState('failed');
    throw err;
  }
}

/** Sends a failed message again with the same clientMsgId (so it can never post twice). */
export function retryMessage(client: QueryClient, m: FeedMessage, myId: string) {
  if (!m.clientMsgId) return;
  void sendMessage(client, {
    conversationId: m.conversationId,
    myId,
    clientMsgId: m.clientMsgId,
    body: m.body,
    files: m.files ?? [],
    parentId: m.parentId,
    alsoInChannel: m.alsoInChannel,
  }).catch(() => undefined);
}

export function discardFailed(client: QueryClient, m: FeedMessage) {
  const id = m.clientMsgId;
  if (!id) return;
  client.setQueryData<Feed>(feedKey(m.conversationId), (f) => (f ? dropPending(f, id) : f));
  if (m.parentId) {
    client.setQueryData<Thread>(threadKey(m.conversationId, m.parentId), (t) =>
      t ? { ...t, replies: t.replies.filter((r) => !(r.pending && r.clientMsgId === id)) } : t,
    );
  }
}
